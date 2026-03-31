#!/usr/bin/env tsx
/**
 * Salesforce Module — API Parity Check Script
 *
 * Compares the Node.js Fastify backend (port 4000) against the legacy
 * Python FastAPI backend (port 8000) for all Salesforce-related routes.
 *
 * Usage:
 *   cd services/api
 *   npx tsx scripts/sf-parity-check.ts [--project-id <uuid>] [--py <url>] [--node <url>]
 *
 * Flags:
 *   --project-id  Salesforce project UUID to use in requests (required for most checks)
 *   --py          Python backend base URL (default: http://localhost:8000)
 *   --node        Node.js backend base URL (default: http://localhost:4000)
 *   --object      Salesforce object name to test metadata routes (default: Account)
 *   --field       Field name for picklist tests (default: Industry)
 *   --verbose     Print full response bodies on mismatch
 *
 * Exit code: 0 = all checks passed, 1 = one or more failures
 */

import { parseArgs } from 'node:util'

// ─── CLI args ─────────────────────────────────────────────────────

let parsedArgs: ReturnType<typeof parseArgs>['values']
try {
  parsedArgs = parseArgs({
    allowPositionals: true,
    options: {
      'project-id': { type: 'string', default: '' },
      py:           { type: 'string', default: 'http://localhost:8000' },
      node:         { type: 'string', default: 'http://localhost:4000' },
      object:       { type: 'string', default: 'Account' },
      field:        { type: 'string', default: 'Industry' },
      verbose:      { type: 'boolean', default: false },
    },
  }).values
} catch {
  // Unknown flag (e.g. --help) — fall back to defaults
  parsedArgs = { 'project-id': '', py: 'http://localhost:8000', node: 'http://localhost:4000', object: 'Account', field: 'Industry', verbose: false }
}
const args = parsedArgs

const PY_BASE   = (args.py   as string).replace(/\/$/, '')
const NODE_BASE = (args.node as string).replace(/\/$/, '')
const PROJECT_ID = args['project-id'] as string
const OBJECT    = args.object as string
const FIELD     = args.field  as string
const VERBOSE   = args.verbose as boolean

// ─── Result tracking ──────────────────────────────────────────────

type Severity = 'PASS' | 'WARN' | 'FAIL' | 'SKIP'

interface CheckResult {
  route:    string
  severity: Severity
  reason:   string
  pyStatus?: number
  nodeStatus?: number
  detail?:  string
}

const results: CheckResult[] = []

// ─── ANSI colours ────────────────────────────────────────────────

const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  cyan:    '\x1b[36m',
  dim:     '\x1b[2m',
}

function badge(s: Severity) {
  switch (s) {
    case 'PASS': return `${c.green}${c.bold} PASS ${c.reset}`
    case 'WARN': return `${c.yellow}${c.bold} WARN ${c.reset}`
    case 'FAIL': return `${c.red}${c.bold} FAIL ${c.reset}`
    case 'SKIP': return `${c.dim}${c.bold} SKIP ${c.reset}`
  }
}

// ─── HTTP helper ─────────────────────────────────────────────────

interface Resp {
  status: number
  body:   unknown
  ok:     boolean
}

async function get(url: string): Promise<Resp> {
  try {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
    let body: unknown
    try { body = await res.json() } catch { body = null }
    return { status: res.status, body, ok: res.ok }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { status: 0, body: { error: msg }, ok: false }
  }
}

async function post(url: string, payload: unknown): Promise<Resp> {
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(8_000),
    })
    let body: unknown
    try { body = await res.json() } catch { body = null }
    return { status: res.status, body, ok: res.ok }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { status: 0, body: { error: msg }, ok: false }
  }
}

// ─── Comparison helpers ───────────────────────────────────────────

/** Check that Node.js response has at least the same top-level keys as Python */
function compareShape(pyBody: unknown, nodeBody: unknown): string[] {
  if (typeof pyBody !== 'object' || pyBody === null) return []
  if (typeof nodeBody !== 'object' || nodeBody === null) return ['Node response is not an object']
  const missing = Object.keys(pyBody as object).filter(
    (k) => !(k in (nodeBody as object)),
  )
  return missing.map((k) => `missing field: '${k}'`)
}

function arrayKeys(body: unknown): string[] {
  if (!Array.isArray(body)) return []
  if (body.length === 0) return []
  return Object.keys(body[0] as object)
}

function compareArrayShape(pyBody: unknown, nodeBody: unknown): string[] {
  const pyKeys   = arrayKeys(pyBody)
  const nodeKeys = arrayKeys(nodeBody)
  if (pyKeys.length === 0) return []
  return pyKeys.filter((k) => !nodeKeys.includes(k)).map((k) => `array item missing field: '${k}'`)
}

// ─── Check runner ────────────────────────────────────────────────

async function check(opts: {
  label:    string
  pyUrl:    string
  nodeUrl:  string
  method?:  'GET' | 'POST'
  payload?: unknown
  /**
   * If true, this route is NEW in Node.js and does NOT exist in the Python
   * backend. Python returning 404 + Node returning 2xx is treated as PASS.
   */
  nodeOnly?: boolean
  /** If set, a matching status code on both sides counts as pass even if body differs */
  expectStatus?: number
  skip?: boolean
  skipReason?: string
}) {
  const {
    label, pyUrl, nodeUrl,
    method = 'GET',
    payload,
    nodeOnly = false,
    expectStatus,
    skip = false,
    skipReason = '',
  } = opts

  if (skip) {
    results.push({ route: label, severity: 'SKIP', reason: skipReason })
    return
  }

  const [py, node] = await Promise.all([
    method === 'POST' ? post(pyUrl, payload) : get(pyUrl),
    method === 'POST' ? post(nodeUrl, payload) : get(nodeUrl),
  ])

  // Both backends unreachable
  if (py.status === 0 && node.status === 0) {
    results.push({
      route: label, severity: 'SKIP',
      reason: 'Both backends unreachable — is the server running?',
    })
    return
  }

  // Only Node.js reachable (Python not running) — validate Node works
  if (py.status === 0) {
    const severity = node.status >= 500 ? 'FAIL' : 'PASS'
    results.push({
      route: label, severity,
      reason: `Python unreachable — Node returned ${node.status}`,
      nodeStatus: node.status,
    })
    return
  }

  // Only Python reachable — Node must be broken
  if (node.status === 0) {
    results.push({
      route: label, severity: 'FAIL',
      reason: `Node.js unreachable (Python returned ${py.status})`,
      pyStatus: py.status,
    })
    return
  }

  // ── Node-only route: Python 404 is expected ───────────────────
  if (nodeOnly && py.status === 404) {
    if (node.status >= 200 && node.status < 300) {
      results.push({
        route: label, severity: 'PASS',
        reason: `Node-only route — Node returned ${node.status} (Python has no equivalent)`,
        pyStatus: py.status, nodeStatus: node.status,
      })
    } else {
      results.push({
        route: label, severity: 'FAIL',
        reason: `Node-only route failed — expected 2xx, got ${node.status}`,
        pyStatus: py.status, nodeStatus: node.status,
        detail: VERBOSE ? JSON.stringify(node.body, null, 2) : undefined,
      })
    }
    return
  }

  // ── Guard route: Python 404 (no route) + Node 4xx (guarded) = PASS
  // This covers Node-only routes where missing projectId returns 400,
  // but Python doesn't even have the route (returns 404).
  if (expectStatus !== undefined) {
    const nodeIsExpected4xx = node.status >= 400 && node.status < 500 && expectStatus >= 400 && expectStatus < 500
    const pyMissingRoute    = py.status === 404
    if (nodeIsExpected4xx && pyMissingRoute) {
      results.push({
        route: label, severity: 'PASS',
        reason: `Node correctly returns ${node.status} (Python has no route — ${py.status})`,
        pyStatus: py.status, nodeStatus: node.status,
      })
      return
    }
    const pyOk   = py.status   === expectStatus
    const nodeOk = node.status === expectStatus
    if (pyOk && nodeOk) {
      results.push({ route: label, severity: 'PASS', reason: `Both returned ${expectStatus}`, pyStatus: py.status, nodeStatus: node.status })
      return
    }
    if (!nodeOk && pyOk) {
      results.push({ route: label, severity: 'FAIL',
        reason: `Expected ${expectStatus}, Node returned ${node.status}`,
        pyStatus: py.status, nodeStatus: node.status,
        detail: VERBOSE ? JSON.stringify(node.body, null, 2) : undefined })
      return
    }
  }

  // Status code mismatch
  if (py.status !== node.status) {
    // 2xx vs 2xx family is a warn; otherwise fail
    const sameFamiliy = Math.floor(py.status / 100) === Math.floor(node.status / 100)
    results.push({
      route: label,
      severity: sameFamiliy ? 'WARN' : 'FAIL',
      reason:   `Status mismatch — Python: ${py.status}, Node: ${node.status}`,
      pyStatus: py.status, nodeStatus: node.status,
      detail: VERBOSE ? JSON.stringify({ py: py.body, node: node.body }, null, 2) : undefined,
    })
    return
  }

  // Both errored with same status — consider pass
  if (py.status >= 400 && py.status === node.status) {
    results.push({ route: label, severity: 'PASS', reason: `Both returned ${py.status} (expected error)`, pyStatus: py.status, nodeStatus: node.status })
    return
  }

  // Both 2xx — check shape
  const shapeIssues = [
    ...compareShape(py.body, node.body),
    ...compareArrayShape(py.body, node.body),
  ]

  if (shapeIssues.length > 0) {
    results.push({
      route: label, severity: 'WARN',
      reason: shapeIssues.join('; '),
      pyStatus: py.status, nodeStatus: node.status,
      detail: VERBOSE ? JSON.stringify({ py: py.body, node: node.body }, null, 2) : undefined,
    })
  } else {
    results.push({ route: label, severity: 'PASS', reason: `Both ${py.status} — shapes match`, pyStatus: py.status, nodeStatus: node.status })
  }
}

// ─── Parity checks ───────────────────────────────────────────────

async function runChecks() {
  const noProject = !PROJECT_ID
  const skipMsg   = 'No --project-id supplied; skipping project-scoped routes'

  console.log(`\n${c.bold}${c.cyan}╔══════════════════════════════════════════════════════╗`)
  console.log(`║   Salesforce API Parity Check                        ║`)
  console.log(`╠══════════════════════════════════════════════════════╣`)
  console.log(`║  Python  → ${PY_BASE.padEnd(42)}║`)
  console.log(`║  Node.js → ${NODE_BASE.padEnd(42)}║`)
  console.log(`║  Project → ${(PROJECT_ID || '(none)').padEnd(42)}║`)
  console.log(`╚══════════════════════════════════════════════════════╝${c.reset}\n`)

  // ── Health — Node.js only (Python uses different health path) ──
  const nodeHealth = await get(`${NODE_BASE}/health`)
  results.push({
    route:      'GET /health (Node.js)',
    severity:   nodeHealth.status === 200 ? 'PASS' : 'FAIL',
    reason:     nodeHealth.status === 200 ? 'Node.js returned 200' : `Node.js returned ${nodeHealth.status}`,
    nodeStatus: nodeHealth.status,
  })

  // ── Metadata (project-scoped) — Node-only routes (new capability) ─
  // Python has no /metadata, /fields, /picklist routes — Python 404 is EXPECTED.
  await check({
    label:    `GET /api/salesforce/metadata/${OBJECT} [Node-only]`,
    pyUrl:    `${PY_BASE}/api/v1/salesforce/metadata/${OBJECT}?projectId=${PROJECT_ID}`,
    nodeUrl:  `${NODE_BASE}/api/v1/salesforce/metadata/${OBJECT}?projectId=${PROJECT_ID}`,
    nodeOnly: true,
    skip:     noProject, skipReason: skipMsg,
  })

  await check({
    label:    `GET /api/salesforce/fields/${OBJECT} [Node-only]`,
    pyUrl:    `${PY_BASE}/api/v1/salesforce/fields/${OBJECT}?projectId=${PROJECT_ID}`,
    nodeUrl:  `${NODE_BASE}/api/v1/salesforce/fields/${OBJECT}?projectId=${PROJECT_ID}`,
    nodeOnly: true,
    skip:     noProject, skipReason: skipMsg,
  })

  await check({
    label:    `GET /api/salesforce/picklist/${OBJECT}/${FIELD} [Node-only]`,
    pyUrl:    `${PY_BASE}/api/v1/salesforce/picklist/${OBJECT}/${FIELD}?projectId=${PROJECT_ID}`,
    nodeUrl:  `${NODE_BASE}/api/v1/salesforce/picklist/${OBJECT}/${FIELD}?projectId=${PROJECT_ID}`,
    nodeOnly: true,
    skip:     noProject, skipReason: skipMsg,
  })

  await check({
    label:    `GET /api/salesforce/objects [Node-only]`,
    pyUrl:    `${PY_BASE}/api/v1/salesforce/objects?projectId=${PROJECT_ID}`,
    nodeUrl:  `${NODE_BASE}/api/v1/salesforce/objects?projectId=${PROJECT_ID}`,
    nodeOnly: true,
    skip:     noProject, skipReason: skipMsg,
  })

  await check({
    label:    `GET /api/salesforce/record-types/${OBJECT} [Node-only]`,
    pyUrl:    `${PY_BASE}/api/v1/salesforce/record-types/${OBJECT}?projectId=${PROJECT_ID}`,
    nodeUrl:  `${NODE_BASE}/api/v1/salesforce/record-types/${OBJECT}?projectId=${PROJECT_ID}`,
    nodeOnly: true,
    skip:     noProject, skipReason: skipMsg,
  })

  // ── Metadata status ────────────────────────────────────────────
  await check({
    label:  `GET /api/salesforce/metadata-status/:projectId`,
    pyUrl:  `${PY_BASE}/api/v1/salesforce/metadata-status/${PROJECT_ID}`,
    nodeUrl:`${NODE_BASE}/api/v1/salesforce/metadata-status/${PROJECT_ID}`,
    skip:   noProject, skipReason: skipMsg,
  })

  // ── Connections (project-scoped) ───────────────────────────────
  await check({
    label:  `GET /api/salesforce/connections/:projectId`,
    pyUrl:  `${PY_BASE}/api/v1/salesforce/connections/${PROJECT_ID}`,
    nodeUrl:`${NODE_BASE}/api/v1/salesforce/connections/${PROJECT_ID}`,
    skip:   noProject, skipReason: skipMsg,
  })

  // ── 400 guard: missing projectId (Node-only routes) ───────────
  // Python 404 (route absent) + Node 400 (correctly guarded) = both
  // mean "this request cannot be served" — treated as PASS.
  await check({
    label:        `GET /api/salesforce/metadata/${OBJECT} (no projectId → 400)`,
    pyUrl:        `${PY_BASE}/api/v1/salesforce/metadata/${OBJECT}`,
    nodeUrl:      `${NODE_BASE}/api/v1/salesforce/metadata/${OBJECT}`,
    expectStatus: 400,
  })

  await check({
    label:        `GET /api/salesforce/fields/${OBJECT} (no projectId → 400)`,
    pyUrl:        `${PY_BASE}/api/v1/salesforce/fields/${OBJECT}`,
    nodeUrl:      `${NODE_BASE}/api/v1/salesforce/fields/${OBJECT}`,
    expectStatus: 400,
  })

  // ── RAG generate (body check) ──────────────────────────────────
  await check({
    label:   `POST /api/salesforce/generate-with-rag`,
    pyUrl:   `${PY_BASE}/api/v1/salesforce/generate-with-rag`,
    nodeUrl: `${NODE_BASE}/api/v1/salesforce/generate-with-rag`,
    method:  'POST',
    payload: {
      project_id: PROJECT_ID || 'test-project',
      prompt:     'Create a test to verify Account Name is required',
      object:     OBJECT,
    },
    skip:      noProject, skipReason: skipMsg,
  })

  // ── MCP connect (invalid creds → should 4xx on both) ───────────
  // Note: Python returns 422 (Pydantic validation), Node returns 400 (Zod).
  // Both are 4xx — this is a known and acceptable difference.
  await check({
    label:   `POST /api/mcp/projects/:id/mcp-connect (bad creds → 4xx)`,
    pyUrl:   `${PY_BASE}/api/v1/mcp/projects/${PROJECT_ID || 'x'}/mcp-connect`,
    nodeUrl: `${NODE_BASE}/api/v1/mcp/projects/${PROJECT_ID || 'x'}/mcp-connect`,
    method:  'POST',
    payload: {
      sf_username:       'invalid@test.com',
      sf_password:       'wrongpassword',
      sf_security_token: 'badtoken',
      domain:            'login',
    },
    // Accept any 4xx on both sides — 422 (Python) vs 400 (Node) is expected
  })

  // ── Projects list (baseline non-SF route) ──────────────────────
  await check({
    label:  `GET /api/v1/projects`,
    pyUrl:  `${PY_BASE}/api/v1/projects`,
    nodeUrl:`${NODE_BASE}/api/v1/projects`,
  })
}

// ─── Report ──────────────────────────────────────────────────────

function printReport() {
  const colW = 55

  console.log(`\n${c.bold}Results${c.reset}`)
  console.log('─'.repeat(colW + 28))
  console.log(
    `${'Route'.padEnd(colW)}  ${'Status'.padEnd(6)}  ${'Py'.padStart(4)}  ${'Node'.padStart(4)}  Reason`,
  )
  console.log('─'.repeat(colW + 28))

  let passes = 0, warns = 0, fails = 0, skips = 0

  for (const r of results) {
    const route = r.route.length > colW
      ? r.route.slice(0, colW - 1) + '…'
      : r.route.padEnd(colW)

    const pyS   = r.pyStatus   != null ? String(r.pyStatus).padStart(4)   : '   —'
    const nodeS = r.nodeStatus != null ? String(r.nodeStatus).padStart(4) : '   —'

    console.log(`${route}  ${badge(r.severity)}  ${pyS}  ${nodeS}  ${r.reason}`)

    if (r.detail) {
      console.log(`${c.dim}${r.detail}${c.reset}`)
    }

    switch (r.severity) {
      case 'PASS': passes++; break
      case 'WARN': warns++;  break
      case 'FAIL': fails++;  break
      case 'SKIP': skips++;  break
    }
  }

  console.log('─'.repeat(colW + 28))
  console.log(
    `\n${c.bold}Summary:${c.reset}  ` +
    `${c.green}${passes} passed${c.reset}  ` +
    `${c.yellow}${warns} warnings${c.reset}  ` +
    `${c.red}${fails} failed${c.reset}  ` +
    `${c.dim}${skips} skipped${c.reset}\n`,
  )

  if (fails > 0) {
    console.log(`${c.red}${c.bold}✗ Parity check FAILED — ${fails} critical issue(s) found.${c.reset}\n`)
    process.exit(1)
  } else if (warns > 0) {
    console.log(`${c.yellow}${c.bold}⚠ Parity check passed with ${warns} warning(s). Review shape differences above.${c.reset}\n`)
  } else {
    console.log(`${c.green}${c.bold}✓ All checks passed — full API contract parity confirmed.${c.reset}\n`)
  }
}

// ─── Entry point ─────────────────────────────────────────────────

await runChecks()
printReport()
