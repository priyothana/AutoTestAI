#!/usr/bin/env tsx
/**
 * ============================================================================
 * API Contract Parity Check
 * ============================================================================
 *
 * Calls every primary endpoint on both servers with identical payloads,
 * then compares:
 *   • HTTP status codes
 *   • Response shapes (field names — NOT values)
 *
 * CRITICAL – field present in Python but missing from Node (frontend reads it)
 * WARNING  – field present in Node but not in Python (additive change — safe)
 *
 * Usage:
 *   npx tsx scripts/parity-check.ts
 *   # or
 *   npx tsx scripts/parity-check.ts --json   ← outputs raw JSON
 *
 * Servers must both be running before you execute this script.
 * ============================================================================
 */

// ─── Config ──────────────────────────────────────────────────────────────────

const PYTHON_BASE = 'http://localhost:8000/api/v1'
const NODE_BASE   = 'http://localhost:4000/api/v1'

const TIMEOUT_MS = 10_000   // per-request timeout

// ─── Types ───────────────────────────────────────────────────────────────────

type Severity = 'CRITICAL' | 'WARNING' | 'OK' | 'SKIP'

interface CheckResult {
  /** Human-readable endpoint label, e.g. "GET /api/v1/projects/" */
  label: string
  module: string
  method: string
  path: string

  pythonStatus: number | 'ERR'
  nodeStatus:   number | 'ERR'
  statusMatch:  boolean

  /** Top-level keys from each server's response (null = no JSON body / error) */
  pythonShape: string[] | null
  nodeShape:   string[] | null

  /** Fields in Python but NOT in Node — CRITICAL */
  missingInNode: string[]
  /** Fields in Node but NOT in Python — WARNING */
  extraInNode: string[]

  severity: Severity
  notes: string[]
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/** Extract sorted, unique top-level keys from any JSON value */
function shapeOf(data: unknown): string[] | null {
  if (data === null || data === undefined) return null
  if (Array.isArray(data)) {
    if (data.length === 0) return []
    // Use the first element as representative
    return shapeOf(data[0])
  }
  if (typeof data === 'object') {
    return Object.keys(data as Record<string, unknown>).sort()
  }
  // Primitive — no shape
  return []
}

/** Timed fetch wrapper — returns { status, body } or { status: 'ERR', body: null } */
async function timedFetch(
  url: string,
  options: RequestInit = {},
): Promise<{ status: number | 'ERR'; body: unknown }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    clearTimeout(timer)

    let body: unknown = null
    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('application/json')) {
      try { body = await res.json() } catch { body = null }
    } else {
      body = null // redirect or non-JSON (204, etc.)
    }

    return { status: res.status, body }
  } catch {
    clearTimeout(timer)
    return { status: 'ERR', body: null }
  }
}

/** Make a parity comparison between two fetch results */
function compare(
  label: string,
  module: string,
  method: string,
  path: string,
  py: { status: number | 'ERR'; body: unknown },
  nd: { status: number | 'ERR'; body: unknown },
  notes: string[] = [],
): CheckResult {
  const pythonShape = shapeOf(py.body)
  const nodeShape   = shapeOf(nd.body)

  const statusMatch = py.status === nd.status

  const pSet = new Set(pythonShape ?? [])
  const nSet = new Set(nodeShape   ?? [])

  const missingInNode = [...pSet].filter(k => !nSet.has(k))
  const extraInNode   = [...nSet].filter(k => !pSet.has(k))

  let severity: Severity = 'OK'

  if (py.status === 'ERR' && nd.status === 'ERR') {
    severity = 'SKIP'
    notes.push('Both servers unreachable — skipped')
  } else if (!statusMatch || missingInNode.length > 0) {
    severity = 'CRITICAL'
  } else if (extraInNode.length > 0) {
    severity = 'WARNING'
  }

  return {
    label, module, method, path,
    pythonStatus: py.status,
    nodeStatus:   nd.status,
    statusMatch,
    pythonShape,
    nodeShape,
    missingInNode,
    extraInNode,
    severity,
    notes,
  }
}

// ─── Endpoint Definitions ────────────────────────────────────────────────────

/**
 * Each probe hits the SAME path on both servers with the SAME payload.
 * For parameterised paths (/:id) we use a sentinel value that will probably
 * return 404 on both servers — 404 == 404 is still a status-code match.
 *
 * Probes that need a real ID (e.g. list before get) are noted below.
 */

const SENTINEL_UUID = '00000000-0000-0000-0000-000000000001'

interface Probe {
  module: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  path: string  // relative, no /api/v1 prefix
  body?: Record<string, unknown>
  notes?: string[]
}

const probes: Probe[] = [
  // ─── Root ────────────────────────────────────────────────────────────────
  {
    module: 'root',
    method: 'GET',
    path:   '/',  // NOTE: root is /  not /api/v1
    notes:  ['Root health check. Python: {"message":...}, Node: {"status":"ok",...}'],
  },

  // ─── Projects ────────────────────────────────────────────────────────────
  {
    module: 'project',
    method: 'GET',
    path:   '/projects/',
  },
  {
    module: 'project',
    method: 'POST',
    path:   '/projects/',
    body:   {
      name:        'parity-test-project',
      description: 'Created by parity-check.ts — safe to delete',
      type:        'web',
      status:      'Active',
    },
    notes: ['201 expected on both sides'],
  },
  {
    module: 'project',
    method: 'GET',
    path:   `/projects/${SENTINEL_UUID}`,
    notes:  ['404 expected on both sides'],
  },
  {
    module: 'project',
    method: 'GET',
    path:   `/projects/${SENTINEL_UUID}/integration-status`,
    notes:  ['Non-404 from Python (returns disconnected shape)'],
  },

  // ─── Integrations (legacy) ───────────────────────────────────────────────
  {
    module: 'project',
    method: 'POST',
    path:   `/projects/${SENTINEL_UUID}/connect`,
    body:   { category: 'web_app', base_url: 'https://example.com' },
    notes:  ['404 or integration shape'],
  },
  {
    module: 'project',
    method: 'POST',
    path:   `/projects/${SENTINEL_UUID}/save-sf-credentials`,
    body:   {
      client_id:     'FAKE_CLIENT_ID',
      client_secret: 'FAKE_SECRET',
      redirect_uri:  'https://example.com/callback',
      login_url:     'https://login.salesforce.com',
    },
    notes: ['404 expected on both — no project exists'],
  },
  {
    module: 'project',
    method: 'GET',
    path:   '/integrations/salesforce/auth-url',
    notes:  ['Python requires project_id query param; Node returns empty auth_url stub'],
  },

  // ─── Settings ────────────────────────────────────────────────────────────
  {
    module: 'settings',
    method: 'GET',
    path:   '/settings/',
  },
  {
    module: 'settings',
    method: 'POST',
    path:   '/settings/',
    body:   { use_session_reuse: true },
  },

  // ─── Tests (test cases) ───────────────────────────────────────────────────
  {
    module: 'test-case',
    method: 'GET',
    path:   '/tests',
    notes:  ['Python: /tests  Node: /tests — same'],
  },
  {
    module: 'test-case',
    method: 'GET',
    path:   `/tests/${SENTINEL_UUID}`,
    notes:  ['404 expected'],
  },
  {
    module: 'test-case',
    method: 'POST',
    path:   '/tests',
    body:   {
      name:       'Parity Check Test',
      description:'Created by parity-check.ts',
      project_id: SENTINEL_UUID,
      steps:      [],
      priority:   'medium',
    },
    notes: ['May 404 / 422 if project not found'],
  },

  // ─── Test Runs ───────────────────────────────────────────────────────────
  {
    module: 'test-run',
    method: 'GET',
    path:   '/test-runs/',
  },
  {
    module: 'test-run',
    method: 'GET',
    path:   `/test-runs/${SENTINEL_UUID}`,
    notes:  ['404 expected'],
  },

  // ─── Execution (Node module) / Test-Runs (Python) ────────────────────────
  {
    module: 'execution',
    method: 'GET',
    path:   `/executions/${SENTINEL_UUID}`,
    notes:  ['Python: /test-runs/{id}  Node: /executions/{id} — different paths, compare independently'],
  },

  // ─── Analytics ───────────────────────────────────────────────────────────
  {
    module: 'analytics',
    method: 'GET',
    path:   '/analytics/dashboard-stats',
  },
  {
    module: 'analytics',
    method: 'GET',
    path:   '/analytics/execution-distribution',
  },
  {
    module: 'analytics',
    method: 'GET',
    path:   '/analytics/reports/trend',
  },
  {
    module: 'analytics',
    method: 'GET',
    path:   '/analytics/reports/projects',
  },
  {
    module: 'analytics',
    method: 'GET',
    path:   '/analytics/reports/top-failed',
  },

  // ─── AI / Test-Generation ────────────────────────────────────────────────
  {
    module: 'test-generation',
    method: 'GET',
    path:   '/ai/models',
    notes:  ['Python returns model list, Node returns curated model list'],
  },
  {
    module: 'test-generation',
    method: 'POST',
    path:   '/tests/generate-test-steps',
    body:   {
      prompt:     'Navigate to login page and verify title',
      project_id: SENTINEL_UUID,
      provider:   'openai',
    },
    notes: ['May fail if LLM key not configured — compare shape of error response'],
  },

  // ─── Salesforce ──────────────────────────────────────────────────────────
  {
    module: 'salesforce',
    method: 'GET',
    path:   `/salesforce/metadata-status/${SENTINEL_UUID}`,
  },

  // ─── Notifications ───────────────────────────────────────────────────────
  {
    module: 'notification',
    method: 'POST',
    path:   '/notifications/test',
    body:   { project_id: SENTINEL_UUID, channel: 'slack', message: 'parity-check ping' },
    notes:  ['Python: no /notifications/test — will differ'],
  },

  // ─── Self-Healing ────────────────────────────────────────────────────────
  {
    module: 'self-healing',
    method: 'GET',
    path:   `/heal/${SENTINEL_UUID}`,
    notes:  ['Python: test-runs /{id}/heal (POST)  Node: /heal/:executionId (GET)'],
  },

  // ─── Jira ────────────────────────────────────────────────────────────────
  {
    module: 'jira',
    method: 'POST',
    path:   '/jira/connect',
    body:   {
      jira_domain: 'https://fake.atlassian.net',
      jira_email:  'fake@example.com',
      jira_token:  'FAKE_TOKEN',
    },
    notes: ['Connection attempt — error shape comparison'],
  },
  {
    module: 'jira',
    method: 'GET',
    path:   `/jira/projects/${SENTINEL_UUID}/config`,
  },

  // ─── Users / Auth ────────────────────────────────────────────────────────
  {
    module: 'auth',
    method: 'POST',
    path:   '/users/login',
    body:   { email: 'parity@test.dev', password: 'fakepassword' },
    notes:  ['401/422 error shape comparison'],
  },
]

// ─── Root-level probes (not under /api/v1) ───────────────────────────────────

interface RootProbe {
  module: string
  method: 'GET'
  label: string
  pythonUrl: string
  nodeUrl: string
  notes?: string[]
}

const rootProbes: RootProbe[] = [
  {
    module:    'root',
    method:    'GET',
    label:     'GET / (root health)',
    pythonUrl: 'http://localhost:8000/',
    nodeUrl:   'http://localhost:4000/',
  },
  {
    module:    'root',
    method:    'GET',
    label:     'GET /health',
    pythonUrl: 'http://localhost:8000/health',
    nodeUrl:   'http://localhost:4000/health',
    notes:     ['Node exposes /health; Python does not — Node extra is WARNING'],
  },
]

// ─── Runner ──────────────────────────────────────────────────────────────────

async function runProbes(): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  // ── Non /api/v1 root probes ──────────────────────────────────────────────
  for (const rp of rootProbes) {
    const [py, nd] = await Promise.all([
      timedFetch(rp.pythonUrl),
      timedFetch(rp.nodeUrl),
    ])
    results.push(compare(
      rp.label,
      rp.module,
      rp.method,
      rp.label,
      py, nd,
      rp.notes,
    ))
  }

  // ── /api/v1 probes ───────────────────────────────────────────────────────
  for (const p of probes) {
    // Skip the root probe from the probes array (handled above)
    if (p.path === '/') continue

    const opts: RequestInit = {
      method: p.method,
      headers: { 'Content-Type': 'application/json' },
      ...(p.body ? { body: JSON.stringify(p.body) } : {}),
    }

    const pyUrl = `${PYTHON_BASE}${p.path}`
    const ndUrl = `${NODE_BASE}${p.path}`

    const [py, nd] = await Promise.all([
      timedFetch(pyUrl, opts),
      timedFetch(ndUrl, opts),
    ])

    const label = `${p.method} /api/v1${p.path}`
    results.push(compare(label, p.module, p.method, p.path, py, nd, p.notes ?? []))
  }

  return results
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const BOLD  = '\x1b[1m'
const RESET = '\x1b[0m'
const RED   = '\x1b[31m'
const YEL   = '\x1b[33m'
const GRN   = '\x1b[32m'
const CYN   = '\x1b[36m'
const DIM   = '\x1b[2m'

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length)
}

function severityColor(s: Severity): string {
  switch (s) {
    case 'CRITICAL': return `${BOLD}${RED}CRITICAL${RESET}`
    case 'WARNING':  return `${YEL}WARNING ${RESET}`
    case 'OK':       return `${GRN}OK      ${RESET}`
    case 'SKIP':     return `${DIM}SKIP    ${RESET}`
  }
}

function renderTable(results: CheckResult[]): void {
  // Column widths
  const W = {
    sev:    8,
    module: 14,
    label:  52,
    pyS:    6,
    ndS:    6,
    pyShape:30,
    ndShape:30,
  }

  const hr = '─'.repeat(
    W.sev + W.module + W.label + W.pyS + W.ndS + W.pyShape + W.ndShape + 14,
  )

  console.log()
  console.log(`${BOLD}${CYN}AutoTest AI — API Contract Parity Report${RESET}`)
  console.log(`Python :8000  vs  Node.js :4000`)
  console.log(hr)
  console.log(
    `${BOLD}` +
    pad('SEV',     W.sev)    + '  ' +
    pad('Module',  W.module) + '  ' +
    pad('Endpoint',W.label)  + '  ' +
    pad(':8000',   W.pyS)    + '  ' +
    pad(':4000',   W.ndS)    + '  ' +
    pad('Python shape',  W.pyShape) + '  ' +
    pad('Node shape',    W.ndShape) +
    RESET,
  )
  console.log(hr)

  for (const r of results) {
    const sev = severityColor(r.severity)

    const pyShape = r.pythonShape === null
      ? 'N/A'
      : r.pythonShape.length === 0
        ? '(empty / primitive)'
        : r.pythonShape.join(', ')

    const ndShape = r.nodeShape === null
      ? 'N/A'
      : r.nodeShape.length === 0
        ? '(empty / primitive)'
        : r.nodeShape.join(', ')

    // Truncate long shapes for table readability
    const pyShortShape = pyShape.length > W.pyShape - 2
      ? pyShape.slice(0, W.pyShape - 5) + '...'
      : pyShape

    const ndShortShape = ndShape.length > W.ndShape - 2
      ? ndShape.slice(0, W.ndShape - 5) + '...'
      : ndShape

    console.log(
      sev                                             + '  ' +
      pad(r.module, W.module)                        + '  ' +
      pad(r.label,  W.label)                         + '  ' +
      pad(String(r.pythonStatus), W.pyS)             + '  ' +
      pad(String(r.nodeStatus),   W.ndS)             + '  ' +
      pad(pyShortShape, W.pyShape)                   + '  ' +
      ndShortShape,
    )

    // Print issue details inline
    if (r.missingInNode.length > 0) {
      console.log(
        `${RED}         ↳ MISSING in Node: ${r.missingInNode.join(', ')}${RESET}`,
      )
    }
    if (r.extraInNode.length > 0) {
      console.log(
        `${YEL}         ↳ EXTRA in Node:   ${r.extraInNode.join(', ')}${RESET}`,
      )
    }
    if (r.notes && r.notes.length > 0) {
      for (const n of r.notes) {
        console.log(`${DIM}         ↳ Note: ${n}${RESET}`)
      }
    }
  }

  console.log(hr)
}

function renderSummary(results: CheckResult[]): void {
  const critical = results.filter(r => r.severity === 'CRITICAL')
  const warnings = results.filter(r => r.severity === 'WARNING')
  const ok       = results.filter(r => r.severity === 'OK')
  const skipped  = results.filter(r => r.severity === 'SKIP')

  console.log()
  console.log(`${BOLD}Summary${RESET}`)
  console.log(`  ${GRN}✓ OK       ${RESET}  ${ok.length}`)
  console.log(`  ${YEL}⚠ WARNING  ${RESET}  ${warnings.length}`)
  console.log(`  ${RED}✗ CRITICAL ${RESET}  ${critical.length}`)
  console.log(`  ${DIM}• SKIPPED  ${RESET}  ${skipped.length}`)
  console.log()

  if (critical.length > 0) {
    console.log(`${BOLD}${RED}CRITICAL Issues (Node missing fields or wrong status):${RESET}`)
    for (const r of critical) {
      console.log(`  ${RED}✗${RESET} ${r.label}`)
      if (r.pythonStatus !== r.nodeStatus) {
        console.log(
          `      Status: Python=${r.pythonStatus}  Node=${r.nodeStatus}`,
        )
      }
      if (r.missingInNode.length > 0) {
        console.log(`      Missing in Node: ${r.missingInNode.join(', ')}`)
      }
    }
    console.log()
  }

  if (warnings.length > 0) {
    console.log(`${BOLD}${YEL}WARNING Issues (Node has extra fields not in Python):${RESET}`)
    for (const r of warnings) {
      console.log(`  ${YEL}⚠${RESET} ${r.label}`)
      if (r.extraInNode.length > 0) {
        console.log(`      Extra in Node: ${r.extraInNode.join(', ')}`)
      }
    }
    console.log()
  }

  // Exit code
  if (critical.length > 0) {
    console.log(`${RED}${BOLD}✗ Parity check FAILED — ${critical.length} critical issues must be fixed.${RESET}`)
    process.exitCode = 1
  } else {
    console.log(`${GRN}${BOLD}✓ No critical parity issues found.${RESET}`)
  }
  console.log()
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const useJson = process.argv.includes('--json')

  console.log(`${DIM}Running parity checks against Python :8000 and Node :4000 …${RESET}`)

  const results = await runProbes()

  if (useJson) {
    console.log(JSON.stringify(results, null, 2))
    return
  }

  renderTable(results)
  renderSummary(results)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
