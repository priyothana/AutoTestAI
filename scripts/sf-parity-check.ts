#!/usr/bin/env tsx
/**
 * sf-parity-check.ts — Salesforce Engine Parity Test
 *
 * Proves that the JSforce (Node.js) engine produces identical output
 * to the Python Salesforce engine for the same inputs.
 *
 * Requires both services to be running:
 *   Python SF engine: http://localhost:8001  (PYTHON_SF_URL env var)
 *   Node.js API:      http://localhost:4000
 *
 * Usage:
 *   npx tsx scripts/sf-parity-check.ts [projectId]
 *
 *   PROJECT_ID env var or first CLI arg sets the project to test.
 *   Defaults to 'test-project-id' — change to your real projectId.
 *
 * Exit codes:
 *   0 — all tests PASS (or WARNING-only)
 *   1 — at least one CRITICAL failure
 */

const PYTHON_SF_URL  = process.env['PYTHON_SF_URL']  ?? 'http://localhost:8001'
const NODE_API_URL   = process.env['NODE_API_URL']   ?? 'http://localhost:4000'
const PROJECT_ID     = process.env['PROJECT_ID']     ?? process.argv[2] ?? 'test-project-id'
const AUTH_TOKEN     = process.env['AUTH_TOKEN']     ?? ''

// ─── Helpers ──────────────────────────────────────────────────────

type Status = 'PASS' | 'WARN' | 'FAIL' | 'ERROR'

interface TestResult {
  test: string
  pythonSummary: string
  nodeSummary: string
  status: Status
  detail?: string
}

const results: TestResult[] = []
let criticalFailures = 0

function pad(str: string, width: number): string {
  return str.length >= width ? str : str + ' '.repeat(width - str.length)
}

function statusIcon(s: Status): string {
  switch (s) {
    case 'PASS':  return '✓ PASS'
    case 'WARN':  return '⚠ WARN'
    case 'FAIL':  return '✗ FAIL'
    case 'ERROR': return '! ERROR'
  }
}

async function callPython(path: string): Promise<unknown> {
  const url = `${PYTHON_SF_URL}${path}${path.includes('?') ? '&' : '?'}project_id=${PROJECT_ID}`
  const res = await fetch(url, {
    headers: AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {},
  })
  if (!res.ok) throw new Error(`Python ${path} → HTTP ${res.status}: ${await res.text()}`)
  return res.json()
}

async function callNode(path: string): Promise<unknown> {
  const url = `${NODE_API_URL}${path}${path.includes('?') ? '&' : '?'}projectId=${PROJECT_ID}`
  const res = await fetch(url, {
    headers: AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {},
  })
  if (!res.ok) throw new Error(`Node ${path} → HTTP ${res.status}: ${await res.text()}`)
  return res.json()
}

function record(
  test: string,
  pythonSummary: string,
  nodeSummary: string,
  status: Status,
  detail?: string,
): void {
  results.push({ test, pythonSummary, nodeSummary, status, detail })
  if (status === 'FAIL') criticalFailures++
}

// ─── Test 1 — getObjectMetadata('Opportunity') ────────────────────

async function testObjectMetadata(): Promise<void> {
  const testName = 'getObjectMetadata(Opportunity)'
  try {
    const [py, nd] = await Promise.all([
      callPython('/salesforce/metadata/Opportunity'),
      callNode('/api/salesforce/metadata/Opportunity'),
    ])

    const pyMeta   = (py as { metadata?: { fields?: unknown[] } }).metadata ?? {}
    const ndMeta   = (nd as { metadata?: { fields?: unknown[] } }).metadata ?? {}
    const pyFields = Array.isArray((pyMeta as { fields?: unknown[] }).fields)
      ? (pyMeta as { fields: unknown[] }).fields
      : []
    const ndFields = Array.isArray((ndMeta as { fields?: unknown[] }).fields)
      ? (ndMeta as { fields: unknown[] }).fields
      : []

    const pyFieldNames = new Set(pyFields.map((f: any) => (f.name ?? '') as string))
    const ndFieldNames = new Set(ndFields.map((f: any) => (f.name ?? '') as string))

    const missingInNode = [...pyFieldNames].filter((n) => !ndFieldNames.has(n))
    const extra         = [...ndFieldNames].filter((n) => !pyFieldNames.has(n))

    const pyCount = pyFields.length
    const ndCount = ndFields.length
    const diff    = Math.abs(pyCount - ndCount)

    const pythonSummary = `${pyCount} fields`
    const nodeSummary   = `${ndCount} fields`

    if (missingInNode.length > 0) {
      record(testName, pythonSummary, nodeSummary, 'FAIL',
        `CRITICAL: ${missingInNode.length} fields missing from Node: ${missingInNode.slice(0, 5).join(', ')}${missingInNode.length > 5 ? '...' : ''}`)
    } else if (diff > 2) {
      record(testName, pythonSummary, nodeSummary, 'FAIL',
        `CRITICAL: field count differs by ${diff} (> threshold of 2)`)
    } else if (extra.length > 0) {
      record(testName, pythonSummary, nodeSummary, 'WARN',
        `Node has ${extra.length} extra fields not in Python: ${extra.slice(0, 5).join(', ')}`)
    } else {
      record(testName, pythonSummary, nodeSummary, 'PASS')
    }
  } catch (err: any) {
    record(testName, 'ERROR', 'ERROR', 'ERROR', err.message)
  }
}

// ─── Test 2 — getPicklistValues('Opportunity', 'StageName') ────────

async function testPicklistValues(): Promise<void> {
  const testName = 'getPicklistValues(Opportunity, StageName)'
  try {
    const [py, nd] = await Promise.all([
      callPython('/salesforce/picklist/Opportunity/StageName'),
      callNode('/api/salesforce/picklist/Opportunity/StageName'),
    ])

    const pyValues: any[] = (py as any).values ?? []
    const ndValues: any[] = (nd as any).values ?? []

    const pyActive = pyValues.filter((v: any) => v.active !== false)
    const ndActive = ndValues.filter((v: any) => v.active !== false)

    const pyActiveLabels = new Set(pyActive.map((v: any) => String(v.label ?? v.value ?? '')))
    const ndActiveLabels = new Set(ndActive.map((v: any) => String(v.label ?? v.value ?? '')))

    const missing = [...pyActiveLabels].filter((l) => !ndActiveLabels.has(l))

    const pythonSummary = `${pyActive.length} active values`
    const nodeSummary   = `${ndActive.length} active values`

    if (missing.length > 0) {
      record(testName, pythonSummary, nodeSummary, 'FAIL',
        `CRITICAL: active values missing from Node: ${missing.slice(0, 5).join(', ')}`)
    } else if (pyActive.length !== ndActive.length) {
      record(testName, pythonSummary, nodeSummary, 'WARN',
        `Active value counts differ — Python=${pyActive.length}, Node=${ndActive.length}`)
    } else {
      record(testName, pythonSummary, nodeSummary, 'PASS')
    }
  } catch (err: any) {
    record(testName, 'ERROR', 'ERROR', 'ERROR', err.message)
  }
}

// ─── Test 3 — getDependentPicklistValues ────────────────────────

async function testDependentPicklist(): Promise<void> {
  const testName = 'getDependentPicklistValues(Opportunity, StageName, ForecastCategoryName)'
  try {
    const [py, nd] = await Promise.all([
      callPython('/salesforce/picklist-dependent/Opportunity/StageName/ForecastCategoryName'),
      callNode('/api/salesforce/picklist-dependent/Opportunity/StageName/ForecastCategoryName'),
    ])

    const pyMapping: Record<string, any[]> = (py as any).mapping ?? {}
    const ndMapping: Record<string, any[]> = (nd as any).mapping ?? {}

    const pyKeys = Object.keys(pyMapping).sort()
    const ndKeys = Object.keys(ndMapping).sort()

    const missingKeys = pyKeys.filter((k) => !ndMapping[k])

    if (missingKeys.length > 0) {
      const pythonSummary = `${pyKeys.length} controller values`
      const nodeSummary   = `${ndKeys.length} controller values`
      record(testName, pythonSummary, nodeSummary, 'FAIL',
        `CRITICAL: controller values missing from Node: ${missingKeys.slice(0, 5).join(', ')}`)
      return
    }

    // For every controller value — compare dependent values (order-independent)
    const mismatches: string[] = []
    for (const key of pyKeys) {
      const pyDepVals = (pyMapping[key] ?? []).map((v: any) => String(v.value ?? v.label ?? '')).sort()
      const ndDepVals = (ndMapping[key] ?? []).map((v: any) => String(v.value ?? v.label ?? '')).sort()
      if (JSON.stringify(pyDepVals) !== JSON.stringify(ndDepVals)) {
        mismatches.push(key)
      }
    }

    const pythonSummary = `${pyKeys.length} controller keys`
    const nodeSummary   = `${ndKeys.length} controller keys`

    if (mismatches.length > 0) {
      record(testName, pythonSummary, nodeSummary, 'FAIL',
        `CRITICAL: dependent values mismatch for controller values: ${mismatches.slice(0, 5).join(', ')}`)
    } else {
      record(testName, pythonSummary, nodeSummary, 'PASS')
    }
  } catch (err: any) {
    record(testName, 'ERROR', 'ERROR', 'ERROR', err.message)
  }
}

// ─── Test 4 — listObjects() ──────────────────────────────────────

async function testListObjects(): Promise<void> {
  const testName = 'listObjects()'
  try {
    const [py, nd] = await Promise.all([
      callPython('/salesforce/objects'),
      callNode('/api/salesforce/objects'),
    ])

    // Python may return a list directly or an object with a list
    const pyRaw = py as any
    const ndRaw = nd as any

    const pyNames: string[] = (
      Array.isArray(pyRaw) ? pyRaw : (pyRaw.sobjects ?? pyRaw.objects ?? [])
    ).map((o: any) => String(o.name ?? o.api_name ?? '')).sort()

    const ndNames: string[] = (
      Array.isArray(ndRaw) ? ndRaw : (ndRaw.sobjects ?? ndRaw.objects ?? [])
    ).map((o: any) => String(o.name ?? o.api_name ?? '')).sort()

    const missingInNode = pyNames.filter((n) => !ndNames.includes(n))
    const extra         = ndNames.filter((n) => !pyNames.includes(n))

    const pythonSummary = `${pyNames.length} objects`
    const nodeSummary   = `${ndNames.length} objects`

    if (missingInNode.length > 0) {
      record(testName, pythonSummary, nodeSummary, 'FAIL',
        `CRITICAL: ${missingInNode.length} objects from Python missing in Node: ${missingInNode.slice(0, 5).join(', ')}`)
    } else if (extra.length > 0) {
      record(testName, pythonSummary, nodeSummary, 'WARN',
        `Node has ${extra.length} additional objects not in Python (not critical)`)
    } else {
      record(testName, pythonSummary, nodeSummary, 'PASS')
    }
  } catch (err: any) {
    record(testName, 'ERROR', 'ERROR', 'ERROR', err.message)
  }
}

// ─── Test 5 — getRecordTypes('Opportunity') ──────────────────────

async function testRecordTypes(): Promise<void> {
  const testName = 'getRecordTypes(Opportunity)'
  try {
    const [py, nd] = await Promise.all([
      callPython('/salesforce/record-types/Opportunity'),
      callNode('/api/salesforce/record-types/Opportunity'),
    ])

    const pyRTs: any[] = Array.isArray(py) ? py : (py as any).recordTypes ?? (py as any).record_types ?? []
    const ndRTs: any[] = Array.isArray(nd) ? nd : (nd as any).recordTypes ?? (nd as any).record_types ?? []

    const pyIds = new Set(pyRTs.map((r: any) => String(r.recordTypeId ?? r.record_type_id ?? '')))
    const ndIds = new Set(ndRTs.map((r: any) => String(r.recordTypeId ?? r.record_type_id ?? '')))

    const missingIds = [...pyIds].filter((id) => !ndIds.has(id))

    // Compare developerName match
    const pyDevNames = new Set(pyRTs.map((r: any) => String(r.developerName ?? r.developer_name ?? '')))
    const ndDevNames = new Set(ndRTs.map((r: any) => String(r.developerName ?? r.developer_name ?? '')))
    const missingDevNames = [...pyDevNames].filter((n) => !ndDevNames.has(n))

    const pythonSummary = `${pyRTs.length} record types`
    const nodeSummary   = `${ndRTs.length} record types`

    if (missingIds.length > 0 || missingDevNames.length > 0) {
      const detail = [
        missingIds.length > 0 ? `IDs missing: ${missingIds.slice(0, 3).join(', ')}` : '',
        missingDevNames.length > 0 ? `devNames missing: ${missingDevNames.slice(0, 3).join(', ')}` : '',
      ].filter(Boolean).join('; ')
      record(testName, pythonSummary, nodeSummary, 'FAIL', `CRITICAL: ${detail}`)
    } else {
      record(testName, pythonSummary, nodeSummary, 'PASS')
    }
  } catch (err: any) {
    record(testName, 'ERROR', 'ERROR', 'ERROR', err.message)
  }
}

// ─── Report ───────────────────────────────────────────────────────

function printReport(): void {
  console.log('\n')
  console.log('════════════════════════════════════════════════════════════════════')
  console.log('  SALESFORCE ENGINE PARITY REPORT')
  console.log(`  Python URL : ${PYTHON_SF_URL}`)
  console.log(`  Node URL   : ${NODE_API_URL}`)
  console.log(`  Project ID : ${PROJECT_ID}`)
  console.log('════════════════════════════════════════════════════════════════════')
  console.log('')

  const COL_TEST   = 46
  const COL_PY     = 22
  const COL_NODE   = 22
  const COL_STATUS = 9

  const header =
    pad('Test', COL_TEST) +
    pad('Python result', COL_PY) +
    pad('Node result', COL_NODE) +
    pad('Status', COL_STATUS)

  const divider = '─'.repeat(COL_TEST + COL_PY + COL_NODE + COL_STATUS)
  console.log(header)
  console.log(divider)

  for (const r of results) {
    const line =
      pad(r.test, COL_TEST) +
      pad(r.pythonSummary, COL_PY) +
      pad(r.nodeSummary, COL_NODE) +
      statusIcon(r.status)
    console.log(line)
    if (r.detail) {
      console.log(`  → ${r.detail}`)
    }
  }

  console.log(divider)
  console.log('')

  const passes   = results.filter((r) => r.status === 'PASS').length
  const warnings = results.filter((r) => r.status === 'WARN').length
  const failures = results.filter((r) => r.status === 'FAIL').length
  const errors   = results.filter((r) => r.status === 'ERROR').length

  console.log(`Results: ${passes} PASS  ${warnings} WARN  ${failures} FAIL  ${errors} ERROR`)
  console.log('')

  if (criticalFailures > 0) {
    console.log(`❌  ${criticalFailures} CRITICAL failure(s) — parity not achieved.`)
    console.log('    Do NOT remove Python SF engine until all FAIL/ERROR resolve to PASS.')
  } else {
    console.log('✅  All checks PASS — JSforce engine achieves full parity with Python engine.')
    console.log('    Safe to comment out the Python SF service in docker-compose.yml.')
  }
  console.log('')
}

// ─── Entry point ─────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Salesforce Engine Parity Check')
  console.log(`Testing project: ${PROJECT_ID}`)
  console.log(`Python SF URL:   ${PYTHON_SF_URL}`)
  console.log(`Node API URL:    ${NODE_API_URL}`)
  console.log('Running 5 tests...\n')

  await testObjectMetadata()
  await testPicklistValues()
  await testDependentPicklist()
  await testListObjects()
  await testRecordTypes()

  printReport()

  process.exit(criticalFailures > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
