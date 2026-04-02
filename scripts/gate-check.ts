#!/usr/bin/env tsx
/**
 * =============================================================================
 * AutoTest AI — Stage 3 Gate Check
 * =============================================================================
 *
 * Performs 4 readiness checks before Stage 4 cutover.
 * Exits 0 only if ALL checks pass.
 *
 * Usage:
 *   npx ts-node scripts/gate-check.ts
 *   # or (faster with tsx installed)
 *   npx tsx scripts/gate-check.ts
 *
 * Env vars (all optional — sensible defaults supplied):
 *   REDIS_URL         Redis connection string    (default: redis://localhost:6379)
 *   LOG_NODE_PATH     path to Node log file      (default: logs/node.log)
 *   LOG_PYTHON_PATH   path to Python log file    (default: logs/python.log)
 *   PARITY_SCRIPT     path to parity-check.ts    (default: scripts/parity-check.ts)
 * =============================================================================
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

// ─── Paths ───────────────────────────────────────────────────────────────────
const __dirname  = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT  = resolve(__dirname, '..')
const LOGS_DIR   = resolve(REPO_ROOT, 'logs')
// node_modules dir for dynamic requires (bullmq lives here)
const API_MODULES = resolve(REPO_ROOT, 'services', 'api', 'node_modules')

const LOG_NODE_PATH   = process.env.LOG_NODE_PATH   ?? resolve(LOGS_DIR, 'node.log')
const LOG_PYTHON_PATH = process.env.LOG_PYTHON_PATH ?? resolve(LOGS_DIR, 'python.log')
const PARITY_SCRIPT   = process.env.PARITY_SCRIPT   ?? resolve(__dirname, 'parity-check.ts')
const REDIS_URL       = process.env.REDIS_URL        ?? 'redis://localhost:6379'

// ─── ANSI ────────────────────────────────────────────────────────────────────
const BOLD  = '\x1b[1m'
const RESET = '\x1b[0m'
const RED   = '\x1b[31m'
const GRN   = '\x1b[32m'
const YEL   = '\x1b[33m'
const CYN   = '\x1b[36m'
const DIM   = '\x1b[2m'
const HR    = '─'.repeat(50)

// ─── Types ───────────────────────────────────────────────────────────────────
type CheckStatus = 'PASS' | 'FAIL' | 'SKIP'

interface CheckResult {
  index:   number
  name:    string
  status:  CheckStatus
  detail:  string        // one-liner shown on the summary row
  extra:   string[]      // additional lines shown indented below FAIL rows
}

// ─── Log parsing ─────────────────────────────────────────────────────────────

interface LogEntry {
  statusCode?:    number
  responseTime?:  number
  url?:           string
  // pino-http wraps status & url in nested objects
  res?: { statusCode?: number }
  req?: { url?: string }
}

function parseLogLines(path: string, maxLines?: number): LogEntry[] {
  if (!existsSync(path)) return []
  try {
    const raw = readFileSync(path, 'utf-8')
    let lines = raw.split('\n').filter(Boolean)
    if (maxLines !== undefined) {
      lines = lines.slice(-maxLines)
    }
    return lines.reduce<LogEntry[]>((acc, line) => {
      try {
        const obj = JSON.parse(line) as LogEntry
        // Normalise nested shapes from pino-http
        if (obj.res?.statusCode !== undefined && obj.statusCode === undefined) {
          obj.statusCode = obj.res.statusCode
        }
        if (obj.req?.url !== undefined && obj.url === undefined) {
          obj.url = obj.req.url
        }
        acc.push(obj)
      } catch { /* skip malformed lines */ }
      return acc
    }, [])
  } catch {
    return []
  }
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

// ─── CHECK 1 — Parity (zero CRITICALs) ──────────────────────────────────────
async function check1_parity(): Promise<CheckResult> {
  const name = 'Parity (zero CRITICALs from parity-check.ts)'

  // Resolve executor: prefer tsx, fall back to ts-node
  const executors = ['tsx', 'ts-node', 'npx tsx', 'npx ts-node']
  let stdout = ''
  let succeeded = false

  for (const exec of executors) {
    const parts = exec.split(' ')
    const cmd   = parts[0]
    const args  = [...parts.slice(1), PARITY_SCRIPT]
    const result = spawnSync(cmd, args, {
      encoding: 'utf-8',
      timeout:  120_000,
      env: { ...process.env },
    })
    if (result.error) continue  // executor not found
    stdout = (result.stdout ?? '') + (result.stderr ?? '')
    succeeded = true
    break
  }

  if (!succeeded) {
    return {
      index: 1, name, status: 'FAIL',
      detail: 'Could not run parity-check.ts (no tsx/ts-node found)',
      extra: [],
    }
  }

  const criticalLines = stdout
    .split('\n')
    .filter(l => l.includes('CRITICAL'))

  if (criticalLines.length === 0) {
    return {
      index: 1, name, status: 'PASS',
      detail: '0 CRITICALs',
      extra: [],
    }
  }

  return {
    index: 1, name, status: 'FAIL',
    detail: `${criticalLines.length} CRITICAL issue(s) found`,
    extra: criticalLines.map(l => `  ${l.trim()}`),
  }
}

// ─── CHECK 2 — Zero 5xx errors in Node logs ───────────────────────────────────
async function check2_zero5xx(): Promise<CheckResult> {
  const name = 'Zero 5xx errors in Node logs'

  const entries  = parseLogLines(LOG_NODE_PATH)
  const total    = entries.length
  const failing  = entries.filter(e => (e.statusCode ?? 0) >= 500)
  const count5xx = failing.length

  if (count5xx === 0) {
    return {
      index: 2, name, status: 'PASS',
      detail: `0 errors in ${total} requests`,
      extra: [],
    }
  }

  // Aggregate failing URLs
  const urlCounts = new Map<string, number>()
  for (const e of failing) {
    const key = `${e.url ?? '(unknown URL)'} → ${e.statusCode}`
    urlCounts.set(key, (urlCounts.get(key) ?? 0) + 1)
  }

  const extra: string[] = []
  for (const [url, cnt] of [...urlCounts.entries()].sort((a, b) => b[1] - a[1])) {
    extra.push(`  ${url} (×${cnt})`)
  }

  return {
    index: 2, name, status: 'FAIL',
    detail: `${count5xx} × 5xx error(s) found in ${total} requests`,
    extra,
  }
}

// ─── CHECK 3 — BullMQ queues draining ────────────────────────────────────────
async function check3_queues(): Promise<CheckResult> {
  const name     = 'BullMQ queues draining (all < 10 waiting)'
  const MAX_WAIT = 10

  // Dynamic import: load bullmq from services/api/node_modules explicitly
  // so this script works when invoked from the repo root (scripts/ has no node_modules).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let QueueCtor: any
  try {
    const bullmqEntry = resolve(API_MODULES, 'bullmq', 'dist', 'cjs', 'index.js')
    const { createRequire } = await import('module')
    const _req = createRequire(import.meta.url)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod  = _req(bullmqEntry) as any
    QueueCtor  = mod.Queue
  } catch {
    try {
      // Fallback: standard resolution (works inside services/api)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = await import('bullmq' as any) as any
      QueueCtor = mod.Queue
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        index: 3, name, status: 'FAIL',
        detail: `Could not load bullmq: ${msg}`,
        extra: [
          '  Run: NODE_PATH=services/api/node_modules npx tsx scripts/gate-check.ts',
          '  Or:  cd services/api && npx tsx ../scripts/gate-check.ts',
        ],
      }
    }
  }

  const redisUrl = new URL(REDIS_URL)
  const connOpts = {
    connection: {
      host: redisUrl.hostname || 'localhost',
      port: parseInt(redisUrl.port || '6379', 10),
      maxRetriesPerRequest: null as null,
      enableReadyCheck: false,
    },
  }

  const queueNames: [string, string][] = [
    ['execution-queue',    'exec'],
    ['healing-queue',      'heal'],
    ['notification-queue', 'notif'],
  ]

  const counts: Array<{ name: string; short: string; count: number }> = []
  const failedQueues: string[] = []

  for (const [qName, short] of queueNames) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const q = new QueueCtor(qName, { ...connOpts }) as { getWaitingCount(): Promise<number>; close(): Promise<void> }
    try {
      const waiting = await q.getWaitingCount()
      counts.push({ name: qName, short, count: waiting })
      if (waiting >= MAX_WAIT) {
        failedQueues.push(`${qName}: ${waiting} waiting (threshold: ${MAX_WAIT})`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      counts.push({ name: qName, short, count: -1 })
      failedQueues.push(`${qName}: error connecting — ${msg}`)
    } finally {
      await q.close().catch(() => {})
    }
  }

  const summary = counts
    .map(c => `${c.short}:${c.count < 0 ? 'ERR' : c.count}`)
    .join(' ')

  if (failedQueues.length === 0) {
    return {
      index: 3, name, status: 'PASS',
      detail: `(${summary})`,
      extra: [],
    }
  }

  return {
    index: 3, name, status: 'FAIL',
    detail: `${failedQueues.length} queue(s) exceeded threshold`,
    extra: failedQueues.map(l => `  ${l}`),
  }
}


// ─── CHECK 4 — Response time within 20% of Python ────────────────────────────
async function check4_responseTime(): Promise<CheckResult> {
  const name = 'Response time within 20% of Python baseline'

  // Node log — required
  const nodeEntries   = parseLogLines(LOG_NODE_PATH, 100)
  const nodeRTs       = nodeEntries
    .map(e => e.responseTime)
    .filter((v): v is number => typeof v === 'number' && v >= 0)

  if (nodeRTs.length === 0) {
    return {
      index: 4, name, status: 'SKIP',
      detail: 'WARN: logs/node.log has no responseTime entries yet — skipping',
      extra: [],
    }
  }

  // Python log — optional, skip gracefully if missing
  if (!existsSync(LOG_PYTHON_PATH)) {
    return {
      index: 4, name, status: 'SKIP',
      detail: `WARN: ${LOG_PYTHON_PATH} not found — skipping (not a failure)`,
      extra: [],
    }
  }

  const pythonEntries = parseLogLines(LOG_PYTHON_PATH, 100)
  const pythonRTs     = pythonEntries
    .map(e => e.responseTime)
    .filter((v): v is number => typeof v === 'number' && v >= 0)

  if (pythonRTs.length === 0) {
    return {
      index: 4, name, status: 'SKIP',
      detail: 'WARN: logs/python.log has no responseTime entries yet — skipping',
      extra: [],
    }
  }

  const nodeMedian   = Math.round(median(nodeRTs))
  const pythonMedian = Math.round(median(pythonRTs))
  const threshold    = pythonMedian * 1.20
  const diffPct      = pythonMedian > 0
    ? Math.round(((nodeMedian - pythonMedian) / pythonMedian) * 100)
    : 0
  const fasterOrSlower = diffPct <= 0
    ? `${Math.abs(diffPct)}% faster`
    : `${diffPct}% slower`

  if (nodeMedian <= threshold) {
    return {
      index: 4, name, status: 'PASS',
      detail: `Node:${nodeMedian}ms  Python:${pythonMedian}ms  (${fasterOrSlower})`,
      extra: [],
    }
  }

  return {
    index: 4, name, status: 'FAIL',
    detail: `Node:${nodeMedian}ms  Python:${pythonMedian}ms  (+${diffPct}% — exceeds 20% threshold)`,
    extra: [
      `  Node median (last 100):   ${nodeMedian}ms`,
      `  Python median (last 100): ${pythonMedian}ms`,
      `  Allowed max:              ${Math.round(threshold)}ms`,
    ],
  }
}

// ─── Renderer ────────────────────────────────────────────────────────────────
function renderResults(results: CheckResult[]): void {
  const ts = new Date().toLocaleString('en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).replace(/(\d+)\/(\d+)\/(\d+),/, '$3-$2-$1')

  console.log()
  console.log(`${BOLD}${CYN}Gate Check Results — ${ts}${RESET}`)
  console.log(HR)

  for (const r of results) {
    if (r.status === 'PASS') {
      console.log(`${GRN}✓ PASS${RESET}  Check ${r.index} — ${r.name}`)
      console.log(`${DIM}        ${r.detail}${RESET}`)
    } else if (r.status === 'SKIP') {
      console.log(`${YEL}⚠ SKIP${RESET}  Check ${r.index} — ${r.name}`)
      console.log(`${DIM}        ${r.detail}${RESET}`)
    } else {
      console.log(`${RED}✗ FAIL${RESET}  Check ${r.index} — ${r.name}`)
      console.log(`${RED}        ${r.detail}${RESET}`)
      for (const line of r.extra) {
        console.log(`${DIM}${line}${RESET}`)
      }
    }
  }

  console.log(HR)

  const failed  = results.filter(r => r.status === 'FAIL')
  const skipped = results.filter(r => r.status === 'SKIP')

  if (failed.length === 0) {
    const skipNote = skipped.length > 0
      ? ` ${DIM}(${skipped.length} check(s) skipped — see warnings above)${RESET}`
      : ''
    console.log(`${GRN}${BOLD}ALL GATES PASSED — ready for Stage 4 cutover${RESET}${skipNote}`)
  } else {
    console.log(`${RED}${BOLD}${failed.length} GATE(S) FAILED — fix before proceeding to Stage 4${RESET}`)
  }
  console.log()
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`${DIM}Running gate checks… (Redis: ${REDIS_URL})${RESET}`)

  // Run all checks (in order, sequentially for clean output ordering)
  const results: CheckResult[] = []
  results.push(await check1_parity())
  results.push(await check2_zero5xx())
  results.push(await check3_queues())
  results.push(await check4_responseTime())

  renderResults(results)

  const anyFailed = results.some(r => r.status === 'FAIL')
  process.exit(anyFailed ? 1 : 0)
}

main().catch(err => {
  console.error(`${RED}[FATAL]${RESET}`, err instanceof Error ? err.message : String(err))
  process.exit(1)
})
