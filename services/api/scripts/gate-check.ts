#!/usr/bin/env tsx
/**
 * AutoTest AI — Infrastructure Gate Check
 *
 * Validates readiness of the Node.js Fastify backend for production cut-over:
 *   1. Health endpoint validation (db + redis + queues)
 *   2. API parity verification (key routes return expected status codes)
 *   3. BullMQ queue health (no stuck/stalled jobs)
 *   4. Response time benchmarking against legacy Python baseline
 *   5. Log file inspection for 5xx errors
 *
 * Usage:
 *   cd services/api
 *   npx tsx scripts/gate-check.ts [--node <url>] [--py <url>] [--verbose]
 *
 * Flags:
 *   --node     Node.js backend base URL (default: http://localhost:4000)
 *   --py       Python backend base URL  (default: http://localhost:8000)
 *   --verbose  Show detailed output on failures
 *
 * Exit code: 0 = all gates passed, 1 = one or more failures
 */

import { parseArgs } from 'node:util'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─── CLI args ──────────────────────────────────────────────────────

let parsedArgs: ReturnType<typeof parseArgs>['values']
try {
  parsedArgs = parseArgs({
    allowPositionals: true,
    options: {
      node:    { type: 'string', default: 'http://localhost:4000' },
      py:      { type: 'string', default: 'http://localhost:8000' },
      verbose: { type: 'boolean', default: false },
    },
  }).values
} catch {
  parsedArgs = { node: 'http://localhost:4000', py: 'http://localhost:8000', verbose: false }
}

const NODE_BASE = (parsedArgs.node as string).replace(/\/$/, '')
const PY_BASE   = (parsedArgs.py   as string).replace(/\/$/, '')
const VERBOSE   = parsedArgs.verbose as boolean

// ─── ANSI colours ──────────────────────────────────────────────────

const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  cyan:    '\x1b[36m',
  dim:     '\x1b[2m',
  magenta: '\x1b[35m',
}

// ─── Result tracking ──────────────────────────────────────────────

type Severity = 'PASS' | 'WARN' | 'FAIL' | 'SKIP'

interface GateResult {
  gate:     string
  check:    string
  severity: Severity
  reason:   string
  detail?:  string
}

const results: GateResult[] = []

function badge(s: Severity): string {
  switch (s) {
    case 'PASS': return `${c.green}${c.bold} ✓ PASS ${c.reset}`
    case 'WARN': return `${c.yellow}${c.bold} ⚠ WARN ${c.reset}`
    case 'FAIL': return `${c.red}${c.bold} ✗ FAIL ${c.reset}`
    case 'SKIP': return `${c.dim}${c.bold} ○ SKIP ${c.reset}`
  }
}

// ─── HTTP helpers ──────────────────────────────────────────────────

interface Resp {
  status: number
  body:   unknown
  ok:     boolean
  timeMs: number
}

async function get(url: string, timeoutMs = 8_000): Promise<Resp> {
  const start = Date.now()
  try {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    let body: unknown
    try { body = await res.json() } catch { body = null }
    return { status: res.status, body, ok: res.ok, timeMs: Date.now() - start }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { status: 0, body: { error: msg }, ok: false, timeMs: Date.now() - start }
  }
}

// ─── GATE 1: Health endpoint validation ────────────────────────────

async function gate1_health() {
  const gate = 'GATE 1: Health'

  console.log(`\n${c.bold}${c.cyan}── ${gate} ──${c.reset}`)

  const resp = await get(`${NODE_BASE}/health`)

  // 1a. Reachability
  if (resp.status === 0) {
    results.push({ gate, check: 'Reachability', severity: 'FAIL', reason: `Node.js unreachable at ${NODE_BASE}` })
    return
  }
  results.push({
    gate, check: 'Reachability', severity: 'PASS',
    reason: `Node.js responded with ${resp.status} in ${resp.timeMs}ms`,
  })

  // Parse health body
  const body = resp.body as Record<string, unknown> | null
  if (!body || typeof body !== 'object') {
    results.push({ gate, check: 'Response shape', severity: 'FAIL', reason: 'Health response is not a JSON object' })
    return
  }

  // 1b. Overall status
  results.push({
    gate, check: 'Status',
    severity: body.status === 'ok' ? 'PASS' : 'FAIL',
    reason: `status: ${String(body.status)}`,
  })

  // 1c. Database
  const modules = body.modules as Record<string, unknown> | undefined
  if (modules) {
    const dbStatus = modules.db as string
    results.push({
      gate, check: 'Database',
      severity: dbStatus === 'ok' ? 'PASS' : 'FAIL',
      reason: `db: ${dbStatus}`,
    })

    // 1d. Redis
    const redisStatus = modules.redis as string
    results.push({
      gate, check: 'Redis',
      severity: redisStatus === 'ok' ? 'PASS' : 'FAIL',
      reason: `redis: ${redisStatus}`,
    })

    // 1e. Queue health
    const queues = modules.queues as Record<string, number> | undefined
    if (queues) {
      for (const [name, waiting] of Object.entries(queues)) {
        const severity = waiting < 0 ? 'WARN' : waiting > 100 ? 'WARN' : 'PASS'
        results.push({
          gate, check: `Queue: ${name}`,
          severity,
          reason: `${waiting} waiting jobs${waiting < 0 ? ' (queue unreachable)' : ''}`,
        })
      }
    } else {
      results.push({ gate, check: 'Queues', severity: 'WARN', reason: 'No queue info in health response' })
    }
  } else {
    results.push({ gate, check: 'Modules', severity: 'WARN', reason: 'No modules object in health response' })
  }
}

// ─── GATE 2: API Parity — key routes ──────────────────────────────

async function gate2_apiParity() {
  const gate = 'GATE 2: API Parity'

  console.log(`\n${c.bold}${c.cyan}── ${gate} ──${c.reset}`)

  const routes = [
    { label: 'GET /',                 path: '/' },
    { label: 'GET /health',           path: '/health' },
    { label: 'GET /api/v1/projects',  path: '/api/v1/projects' },
  ]

  // Check Node.js routes
  for (const route of routes) {
    const resp = await get(`${NODE_BASE}${route.path}`)
    if (resp.status === 0) {
      results.push({ gate, check: `Node ${route.label}`, severity: 'FAIL', reason: 'Unreachable' })
    } else if (resp.status >= 500) {
      results.push({
        gate, check: `Node ${route.label}`, severity: 'FAIL',
        reason: `Server error: ${resp.status}`,
        detail: VERBOSE ? JSON.stringify(resp.body, null, 2) : undefined,
      })
    } else {
      results.push({
        gate, check: `Node ${route.label}`, severity: 'PASS',
        reason: `${resp.status} in ${resp.timeMs}ms`,
      })
    }
  }

  // Check if Python backend is available for parity comparison
  const pyHealth = await get(`${PY_BASE}/`, 3_000)
  if (pyHealth.status === 0) {
    results.push({
      gate, check: 'Python baseline', severity: 'SKIP',
      reason: `Python backend not running at ${PY_BASE} — parity comparison skipped`,
    })
    return
  }

  // Compare key route status codes
  const parityRoutes = [
    { label: 'GET /api/v1/projects', path: '/api/v1/projects' },
  ]

  for (const route of parityRoutes) {
    const [nodeResp, pyResp] = await Promise.all([
      get(`${NODE_BASE}${route.path}`),
      get(`${PY_BASE}${route.path}`),
    ])

    const sameFamily = nodeResp.status > 0 && pyResp.status > 0 &&
      Math.floor(nodeResp.status / 100) === Math.floor(pyResp.status / 100)

    if (nodeResp.status === pyResp.status) {
      results.push({
        gate, check: `Parity ${route.label}`, severity: 'PASS',
        reason: `Both returned ${nodeResp.status}`,
      })
    } else if (sameFamily) {
      results.push({
        gate, check: `Parity ${route.label}`, severity: 'WARN',
        reason: `Node: ${nodeResp.status}, Python: ${pyResp.status} (same family)`,
      })
    } else {
      results.push({
        gate, check: `Parity ${route.label}`, severity: 'FAIL',
        reason: `Node: ${nodeResp.status}, Python: ${pyResp.status}`,
        detail: VERBOSE ? JSON.stringify({ node: nodeResp.body, py: pyResp.body }, null, 2) : undefined,
      })
    }
  }
}

// ─── GATE 3: Error-free Node.js logs ──────────────────────────────

async function gate3_logs() {
  const gate = 'GATE 3: Logs'

  console.log(`\n${c.bold}${c.cyan}── ${gate} ──${c.reset}`)

  const __dir = dirname(fileURLToPath(import.meta.url))
  const logPath = join(__dir, '..', 'logs', 'node.log')

  if (!existsSync(logPath)) {
    results.push({
      gate, check: 'Log file', severity: 'SKIP',
      reason: `Log file not found: ${logPath}`,
    })
    return
  }

  let content: string
  try {
    content = readFileSync(logPath, 'utf-8')
  } catch (err: unknown) {
    results.push({
      gate, check: 'Log file', severity: 'WARN',
      reason: `Cannot read log file: ${err instanceof Error ? err.message : String(err)}`,
    })
    return
  }

  const lines = content.split('\n')
  results.push({
    gate, check: 'Log file exists', severity: 'PASS',
    reason: `${lines.length} lines in node.log`,
  })

  // Scan for 5xx errors in structured logs
  let error5xxCount = 0
  const error5xxRoutes: string[] = []
  const fatalLines: string[] = []

  for (const line of lines) {
    if (!line.trim()) continue

    // Check for 5xx status codes in structured pino logs
    if (/"statusCode"\s*:\s*5\d{2}/.test(line) || /"status"\s*:\s*5\d{2}/.test(line)) {
      error5xxCount++
      // Extract method + url from structured pino JSON for actionable output
      try {
        const parsed = JSON.parse(line)
        const method = parsed?.req?.method ?? '?'
        const url    = parsed?.req?.url ?? '?'
        const status = parsed?.res?.statusCode ?? '5xx'
        error5xxRoutes.push(`${method} ${url} → ${status}`)
      } catch {
        error5xxRoutes.push(line.slice(0, 120))
      }
    }

    // Check for FATAL/uncaughtException/unhandledRejection
    if (/\[FATAL\]|uncaughtException|unhandledRejection/i.test(line)) {
      fatalLines.push(line.slice(0, 200))
    }
  }

  // Deduplicate routes for summary
  const uniqueRoutes = [...new Set(error5xxRoutes)]
  const routeSummary = uniqueRoutes.slice(0, 10).join('\n')

  results.push({
    gate, check: '5xx errors',
    severity: error5xxCount === 0 ? 'PASS' : error5xxCount <= 5 ? 'WARN' : 'FAIL',
    reason: `${error5xxCount} server errors in logs` +
      (error5xxCount > 0 ? ` (${uniqueRoutes.length} unique routes)` : ''),
    detail: error5xxCount > 0
      ? (VERBOSE ? routeSummary : `Affected routes: ${uniqueRoutes.map(r => r.split(' → ')[0]).join(', ')}  (use --verbose for details)`)
      : undefined,
  })

  results.push({
    gate, check: 'Fatal errors',
    severity: fatalLines.length === 0 ? 'PASS' : 'FAIL',
    reason: fatalLines.length === 0 ? 'No fatal errors' : `${fatalLines.length} fatal error(s)`,
    detail: fatalLines.length > 0 ? fatalLines.slice(0, 3).join('\n') : undefined,
  })
}

// ─── GATE 4: Response time benchmarks ─────────────────────────────

async function gate4_responseTime() {
  const gate = 'GATE 4: Performance'

  console.log(`\n${c.bold}${c.cyan}── ${gate} ──${c.reset}`)

  // Benchmark key routes — threshold: < 500ms for health, < 2000ms for API
  const benchmarks = [
    { label: 'GET /health',          path: '/health',          thresholdMs: 500  },
    { label: 'GET /api/v1/projects', path: '/api/v1/projects', thresholdMs: 2000 },
    { label: 'GET /',                path: '/',                thresholdMs: 200  },
  ]

  for (const bench of benchmarks) {
    // Warm-up request
    await get(`${NODE_BASE}${bench.path}`, 3_000)

    // Measure 3 requests and take median
    const times: number[] = []
    for (let i = 0; i < 3; i++) {
      const resp = await get(`${NODE_BASE}${bench.path}`)
      if (resp.status > 0) times.push(resp.timeMs)
    }

    if (times.length === 0) {
      results.push({
        gate, check: bench.label, severity: 'FAIL',
        reason: 'All requests failed — cannot benchmark',
      })
      continue
    }

    times.sort((a, b) => a - b)
    const median = times[Math.floor(times.length / 2)]

    const severity = median <= bench.thresholdMs ? 'PASS'
      : median <= bench.thresholdMs * 2 ? 'WARN'
      : 'FAIL'

    results.push({
      gate, check: bench.label, severity,
      reason: `${median}ms median (threshold: ${bench.thresholdMs}ms)`,
    })
  }

  // Parity benchmark — compare with Python if available
  const pyHealth = await get(`${PY_BASE}/`, 3_000)
  if (pyHealth.status > 0) {
    const [nodeTime, pyTime] = await Promise.all([
      get(`${NODE_BASE}/api/v1/projects`),
      get(`${PY_BASE}/api/v1/projects`),
    ])

    if (nodeTime.status > 0 && pyTime.status > 0) {
      const ratio = nodeTime.timeMs / Math.max(pyTime.timeMs, 1)
      const severity = ratio <= 1.5 ? 'PASS' : ratio <= 3 ? 'WARN' : 'FAIL'
      results.push({
        gate, check: 'Node vs Python latency', severity,
        reason: `Node: ${nodeTime.timeMs}ms, Python: ${pyTime.timeMs}ms (ratio: ${ratio.toFixed(2)}x)`,
      })
    }
  } else {
    results.push({
      gate, check: 'Node vs Python latency', severity: 'SKIP',
      reason: 'Python backend not available for comparison',
    })
  }
}

// ─── Report ────────────────────────────────────────────────────────

function printReport() {
  const gateW = 22
  const checkW = 30

  console.log(`\n${c.bold}${c.magenta}╔══════════════════════════════════════════════════════════════════╗`)
  console.log(`║              AutoTest AI — Infrastructure Gate Check            ║`)
  console.log(`╠══════════════════════════════════════════════════════════════════╣`)
  console.log(`║  Node.js → ${NODE_BASE.padEnd(53)}║`)
  console.log(`║  Python  → ${PY_BASE.padEnd(53)}║`)
  console.log(`║  Time    → ${new Date().toISOString().padEnd(53)}║`)
  console.log(`╚══════════════════════════════════════════════════════════════════╝${c.reset}\n`)

  console.log(`${'Gate'.padEnd(gateW)}  ${'Check'.padEnd(checkW)}  ${'Result'.padEnd(10)}  Reason`)
  console.log('─'.repeat(gateW + checkW + 60))

  let passes = 0, warns = 0, fails = 0, skips = 0
  let lastGate = ''

  for (const r of results) {
    const gateName = r.gate === lastGate ? ''.padEnd(gateW) : r.gate.padEnd(gateW)
    lastGate = r.gate

    const check = r.check.length > checkW
      ? r.check.slice(0, checkW - 1) + '…'
      : r.check.padEnd(checkW)

    console.log(`${gateName}  ${check}  ${badge(r.severity)}  ${r.reason}`)

    if (r.detail) {
      console.log(`${c.dim}    ${r.detail.split('\n').join('\n    ')}${c.reset}`)
    }

    switch (r.severity) {
      case 'PASS': passes++; break
      case 'WARN': warns++;  break
      case 'FAIL': fails++;  break
      case 'SKIP': skips++;  break
    }
  }

  console.log('─'.repeat(gateW + checkW + 60))
  console.log(
    `\n${c.bold}Summary:${c.reset}  ` +
    `${c.green}${passes} passed${c.reset}  ` +
    `${c.yellow}${warns} warnings${c.reset}  ` +
    `${c.red}${fails} failed${c.reset}  ` +
    `${c.dim}${skips} skipped${c.reset}\n`,
  )

  if (fails > 0) {
    console.log(`${c.red}${c.bold}╔══════════════════════════════════════════════════════════╗`)
    console.log(`║  ✗ GATE CHECK FAILED — ${String(fails).padStart(2)} critical issue(s) must be resolved  ║`)
    console.log(`╚══════════════════════════════════════════════════════════╝${c.reset}\n`)
    process.exit(1)
  } else if (warns > 0) {
    console.log(`${c.yellow}${c.bold}⚠ Gate check passed with ${warns} warning(s). Review items above.${c.reset}\n`)
  } else {
    console.log(`${c.green}${c.bold}╔══════════════════════════════════════════════════════════╗`)
    console.log(`║  ✓ ALL GATES PASSED — Ready for production cut-over     ║`)
    console.log(`╚══════════════════════════════════════════════════════════╝${c.reset}\n`)
  }
}

// ─── Entry point ───────────────────────────────────────────────────

await gate1_health()
await gate2_apiParity()
await gate3_logs()
await gate4_responseTime()
printReport()
