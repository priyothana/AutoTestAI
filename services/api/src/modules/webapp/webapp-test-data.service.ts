/**
 * WebTestDataService — Phase 2: Test Data Extraction
 *
 * ╔═══════════════════════════════════════════════════════════╗
 * ║  TIER ORDER  (earlier = higher priority)                  ║
 * ╠═══════════════════════════════════════════════════════════╣
 * ║  Tier 0 — Manual JSON Upload (ALWAYS wins, final override)║
 * ║  Tier 1 — OpenAPI / Swagger Detection (preferred auto)    ║
 * ║  Tier 2 — UI List Page Scraping (fallback auto)           ║
 * ╚═══════════════════════════════════════════════════════════╝
 *
 * extractTestData() runs Tier 1 first. For any entity where
 * Tier 1 yields zero records, it falls back to Tier 2.
 * Tier 0 (manual upload) is never overwritten by either tier.
 */

import prisma from '../../shared/db/prisma.js'
import { createModuleLogger } from '../../shared/logger/index.js'

const log = createModuleLogger('web-test-data')

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TestDataRecord {
  [field: string]: string | number | boolean | null
}

export interface TestDataEntity {
  entity_name:       string
  record_count:      number
  source:            'api' | 'ui_scraping' | 'user_upload' | string
  last_extracted_at: string
  records:           TestDataRecord[]
  source_url?:       string
}

/** Summary returned by extractTestData() */
export interface ExtractionSummary {
  entitiesStored:  number
  fromApi:         number   // records from OpenAPI
  fromUiScraping:  number   // records from Playwright table scrape
  apiDetected:     boolean  // was an OpenAPI spec found?
  specUrl?:        string   // which spec URL was discovered
}

// ─── DB Bootstrap ─────────────────────────────────────────────────────────────

let tableEnsured = false

async function ensureTable(): Promise<void> {
  if (tableEnsured) return
  try {
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS web_test_data (
        id                UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
        project_id        UUID         NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        entity_name       VARCHAR(255) NOT NULL,
        records           JSONB        NOT NULL DEFAULT '[]',
        source            VARCHAR(20)  NOT NULL DEFAULT 'ui_scraping',
        record_count      INT          NOT NULL DEFAULT 0,
        source_url        VARCHAR(512),
        last_extracted_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
        UNIQUE(project_id, entity_name)
      )
    `
    tableEnsured = true
    log.info('[WTD] web_test_data table ensured')
  } catch (err) {
    log.warn({ err }, '[WTD] ensureTable failed — table may already exist')
    tableEnsured = true
  }
  // Ensure source_url column exists (for tables created before this column was added)
  try {
    await prisma.$executeRaw`
      ALTER TABLE web_test_data ADD COLUMN IF NOT EXISTS source_url VARCHAR(512)
    `
  } catch { /* column may already exist */ }
  // Ensure create_button_name column exists
  try {
    await prisma.$executeRaw`
      ALTER TABLE web_test_data ADD COLUMN IF NOT EXISTS create_button_name VARCHAR(100)
    `
  } catch { /* column may already exist */ }
  // Ensure open_button_name column exists (for modal-based create flows)
  try {
    await prisma.$executeRaw`
      ALTER TABLE web_test_data ADD COLUMN IF NOT EXISTS open_button_name VARCHAR(100)
    `
  } catch { /* column may already exist */ }
}

// ─── Upsert Helper ────────────────────────────────────────────────────────────
// source priority:  user_upload  >  api  >  ui_scraping
// A higher-priority source never gets overwritten by a lower one.

const SOURCE_PRIORITY: Record<string, number> = {
  user_upload: 3,
  api:         2,
  ui_scraping: 1,
}

async function upsertEntity(
  projectId:  string,
  entityName: string,
  records:    TestDataRecord[],
  source:     'api' | 'ui_scraping' | 'user_upload',
  sourceUrl?: string,
): Promise<void> {
  const recordCount = records.length
  const trimmed     = records.slice(0, 30)
  const priority    = SOURCE_PRIORITY[source] ?? 1
  const urlVal      = sourceUrl ?? null

  // Only overwrite existing rows if the incoming source has HIGHER priority
  await prisma.$executeRaw`
    INSERT INTO web_test_data (id, project_id, entity_name, records, source, record_count, source_url, last_extracted_at)
    VALUES (uuid_generate_v4(), ${projectId}::uuid, ${entityName}, ${JSON.stringify(trimmed)}::jsonb, ${source}, ${recordCount}, ${urlVal}, now())
    ON CONFLICT (project_id, entity_name)
    DO UPDATE SET
      records           = CASE
                            WHEN ${priority} > COALESCE(
                              CASE web_test_data.source
                                WHEN 'user_upload' THEN 3
                                WHEN 'api'         THEN 2
                                ELSE 1
                              END, 1)
                            THEN ${JSON.stringify(trimmed)}::jsonb
                            ELSE web_test_data.records
                          END,
      source            = CASE
                            WHEN ${priority} > COALESCE(
                              CASE web_test_data.source
                                WHEN 'user_upload' THEN 3
                                WHEN 'api'         THEN 2
                                ELSE 1
                              END, 1)
                            THEN ${source}
                            ELSE web_test_data.source
                          END,
      record_count      = CASE
                            WHEN ${priority} > COALESCE(
                              CASE web_test_data.source
                                WHEN 'user_upload' THEN 3
                                WHEN 'api'         THEN 2
                                ELSE 1
                              END, 1)
                            THEN ${recordCount}
                            ELSE web_test_data.record_count
                          END,
      source_url        = COALESCE(${urlVal}, web_test_data.source_url),
      last_extracted_at = now()
  `
}

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC: extractTestData — orchestrates Tier 1 + Tier 2
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Main extraction entry point.
 *
 * 1. Try Tier 1: OpenAPI/Swagger Detection — fast, uses HTTP (+ auth cookies from Playwright)
 * 2. For entities with zero records after Tier 1, fall back to Tier 2: UI List Page Scraping
 * 3. Tier 0 (manual upload) records are never touched — the ON CONFLICT guard protects them.
 *
 * Returns ExtractionSummary with entity count and per-source record counts.
 */
export async function extractTestData(projectId: string): Promise<number> {
  await ensureTable()

  const integration = await prisma.project_integrations.findFirst({
    where:  { project_id: projectId, category: { in: ['web_app', 'webapp'] } },
    select: { base_url: true, username: true, password: true, auth_config: true },
  })

  if (!integration?.base_url) {
    log.warn('[WTD] No web_app integration found — skipping extraction')
    return 0
  }

  const baseOrigin = new URL(integration.base_url).origin

  // ── Tier 1: OpenAPI Detection ────────────────────────────────────────────
  const apiSummary = await runOpenApiDetection(projectId, baseOrigin, {
    username: integration.username ?? undefined,
    password: integration.password ?? undefined,
  })

  // Track which entities were covered by Tier 1 so Tier 2 skips them
  const coveredByApi = new Set(apiSummary.coveredEntities.map(e => e.toLowerCase()))

  // ── Tier 2: UI List Page Scraping (fallback) ─────────────────────────────
  const uiCount = await runUiScraping(projectId, integration, coveredByApi)

  const totalEntities = apiSummary.entitiesStored + uiCount

  // Summary log
  const fromApiStr = apiSummary.recordsStored > 0 ? `, ${apiSummary.recordsStored} from API (${apiSummary.specUrl ?? 'spec'})` : ''
  const fromUiStr  = uiCount > 0 ? `, ${uiCount} entities from UI scraping` : ''
  log.info(`[WTD] Extraction complete — ${totalEntities} entities total${fromApiStr}${fromUiStr}`)

  return totalEntities
}

// ══════════════════════════════════════════════════════════════════════════════
// TIER 1: OpenAPI / Swagger Detection
// ══════════════════════════════════════════════════════════════════════════════

/** Common OpenAPI/Swagger spec endpoints to probe — in priority order. */
const OPENAPI_PROBE_PATHS = [
  '/openapi.json',
  '/swagger.json',
  '/api-docs',
  '/api-docs/swagger.json',
  '/api/swagger.json',
  '/api/openapi.json',
  '/docs/openapi.json',
  '/swagger/v1/swagger.json',
  '/swagger/doc.json',
  '/api/v1/swagger.json',
  '/v1/openapi.json',
  '/v2/openapi.json',
  '/v3/openapi.json',
]

interface OpenApiResult {
  entitiesStored:  number
  recordsStored:   number
  coveredEntities: string[]
  specUrl?:        string
}

/**
 * Probes common OpenAPI spec URLs, parses the spec, identifies GET list
 * endpoints, and calls them using Node.js fetch (with Basic auth if available).
 *
 * This is intentionally HTTP-only (no Playwright) — lightweight and fast.
 * Falls back gracefully on any error.
 */
async function runOpenApiDetection(
  projectId:  string,
  baseOrigin: string,
  creds:      { username?: string; password?: string },
): Promise<OpenApiResult> {
  log.info(`[WTD][API] Tier 1 — probing OpenAPI spec at ${baseOrigin}`)

  // ── 1. Discover spec URL ──────────────────────────────────────────────────
  let spec:    Record<string, unknown> | null = null
  let specUrl: string | undefined

  const authHeader = creds.username && creds.password
    ? `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`
    : undefined

  for (const probePath of OPENAPI_PROBE_PATHS) {
    const url = `${baseOrigin}${probePath}`
    try {
      const res = await fetchWithTimeout(url, {
        headers: {
          Accept: 'application/json',
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        timeout: 6_000,
      })

      if (!res.ok) continue

      const contentType = res.headers.get('content-type') ?? ''
      if (!contentType.includes('json') && !contentType.includes('yaml')) continue

      const json = await res.json() as Record<string, unknown>

      // Must look like an OpenAPI/Swagger spec
      if (
        (json.openapi || json.swagger) &&
        json.paths && typeof json.paths === 'object'
      ) {
        spec    = json
        specUrl = url
        log.info(`[WTD][API] OpenAPI spec found at ${url} (version: ${json.openapi ?? json.swagger})`)
        break
      }
    } catch {
      // Next probe path
    }
  }

  if (!spec || !specUrl) {
    log.info('[WTD][API] No OpenAPI spec detected — Tier 1 skipped')
    return { entitiesStored: 0, recordsStored: 0, coveredEntities: [], specUrl: undefined }
  }

  // ── 2. Parse spec → identify GET list endpoints ───────────────────────────
  const listEndpoints = extractListEndpoints(spec)
  log.info(`[WTD][API] Found ${listEndpoints.length} GET list endpoints in spec`)

  if (listEndpoints.length === 0) {
    return { entitiesStored: 0, recordsStored: 0, coveredEntities: [] }
  }

  // ── 3. Call each list endpoint → extract records ──────────────────────────
  let entitiesStored  = 0
  let recordsStored   = 0
  const coveredEntities: string[] = []

  for (const endpoint of listEndpoints.slice(0, 15)) {
    const endpointUrl = `${baseOrigin}${endpoint.path}`
    try {
      const res = await fetchWithTimeout(endpointUrl, {
        headers: {
          Accept: 'application/json',
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        timeout: 8_000,
      })

      if (!res.ok) {
        log.debug(`[WTD][API] ${endpoint.path} → ${res.status} — skipping`)
        continue
      }

      const body = await res.json()

      // Extract records array from common API response shapes:
      //  { data: [...] }  |  { results: [...] }  |  { items: [...] }  |  [...]
      const records = extractRecordsFromResponse(body)
      if (records.length === 0) continue

      await upsertEntity(projectId, endpoint.entityName, records.slice(0, 10), 'api')
      entitiesStored++
      recordsStored += Math.min(records.length, 10)
      coveredEntities.push(endpoint.entityName.toLowerCase())

      log.info(`[WTD][API] ${endpoint.path} → ${records.length} records for "${endpoint.entityName}"`)

    } catch (err) {
      log.debug(`[WTD][API] ${endpoint.path} failed — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  log.info(
    `[WTD][API] Tier 1 complete — ${entitiesStored} entities, ${recordsStored} records from ${specUrl}`,
  )

  return { entitiesStored, recordsStored, coveredEntities, specUrl }
}

// ── List endpoint extraction ──────────────────────────────────────────────────

interface ListEndpoint {
  path:       string
  entityName: string
}

/**
 * Parses an OpenAPI spec and extracts GET endpoints that are likely
 * to return arrays of records (list / collection endpoints).
 *
 * Heuristics:
 * - Path ends in a plural noun (e.g. /api/accounts, /customers)
 * - No path parameters in the last segment (no {id})
 * - Response schema for 200 is array or has "items" (array of objects)
 */
function extractListEndpoints(spec: Record<string, unknown>): ListEndpoint[] {
  const paths = spec.paths as Record<string, unknown> || {}
  const results: ListEndpoint[] = []
  const seen = new Set<string>()

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue

    const methods = pathItem as Record<string, unknown>
    if (!methods['get']) continue // Only GET

    // Skip paths with path parameters in the last segment (detail endpoints)
    const lastSegment = path.split('/').pop() ?? ''
    if (lastSegment.startsWith('{')) continue
    if (/^\d+$/.test(lastSegment)) continue

    // Skip obvious non-list paths
    if (/\/(health|ping|status|metrics|auth|login|logout|token|swagger|openapi|docs)$/i.test(path)) continue

    // Is the last segment a plural word or known entity pattern?
    const isLikelyList = (
      /[a-z]s$/i.test(lastSegment) ||          // ends in 's' (accounts, users…)
      /[a-z](es|ies)$/i.test(lastSegment) ||   // categories, companies…
      /^(list|all|search|index)$/i.test(lastSegment)
    )
    if (!isLikelyList) continue

    // Check response schema for array indication
    const getOp = methods['get'] as Record<string, unknown>
    const isArrayResponse = checkResponseIsArray(getOp)
    if (!isArrayResponse) continue

    const entityName = deriveEntityName(path, '')
    if (!entityName || seen.has(entityName.toLowerCase())) continue

    seen.add(entityName.toLowerCase())
    results.push({ path, entityName })
  }

  // Sort by path depth (shallower = more likely to be the primary entity endpoint)
  results.sort((a, b) => a.path.split('/').length - b.path.split('/').length)
  return results
}

/** Checks if the 200 response of a GET operation returns an array. */
function checkResponseIsArray(getOp: Record<string, unknown>): boolean {
  try {
    const responses = getOp.responses as Record<string, unknown>
    if (!responses) return true // assume list if no schema defined
    const ok = (responses['200'] ?? responses['default']) as Record<string, unknown>
    if (!ok) return true

    const content = ok.content as Record<string, unknown>
    if (!content) return true

    for (const mediaType of Object.values(content)) {
      const mt = mediaType as Record<string, unknown>
      const schema = mt?.schema as Record<string, unknown>
      if (!schema) continue

      // { type: "array", items: {...} }
      if (schema.type === 'array') return true

      // { properties: { data: { type: "array" } } }  ← wrapped response
      const props = schema.properties as Record<string, unknown>
      if (props) {
        for (const p of Object.values(props)) {
          const prop = p as Record<string, unknown>
          if (prop.type === 'array' || prop.items) return true
        }
      }
    }

    return false
  } catch {
    return false
  }
}

/** Extracts an array of records from common REST API response shapes. */
function extractRecordsFromResponse(body: unknown): TestDataRecord[] {
  if (!body) return []

  // Already an array
  if (Array.isArray(body)) {
    return sanitiseRecords(body)
  }

  if (typeof body !== 'object') return []
  const obj = body as Record<string, unknown>

  // Common wrapper keys — in order of preference
  for (const key of ['data', 'results', 'items', 'records', 'content', 'list', 'rows', 'entities']) {
    if (Array.isArray(obj[key])) {
      return sanitiseRecords(obj[key] as unknown[])
    }
  }

  // Last resort: find the first array-valued property on the root object
  const firstArrayKey = Object.keys(obj).find(k => Array.isArray(obj[k]))
  if (firstArrayKey) {
    return sanitiseRecords(obj[firstArrayKey] as unknown[])
  }

  return []
}

/** Flattens nested objects to flat string/number/boolean/null records. */
function sanitiseRecords(arr: unknown[]): TestDataRecord[] {
  return arr
    .filter(item => item && typeof item === 'object' && !Array.isArray(item))
    .map(item => {
      const obj = item as Record<string, unknown>
      const flat: TestDataRecord = {}
      for (const [k, v] of Object.entries(obj)) {
        if (Array.isArray(v) || (v && typeof v === 'object')) {
          // Flatten one level deep: { address: { city: "NY" } } → { address_city: "NY" }
          if (v && typeof v === 'object') {
            for (const [nk, nv] of Object.entries(v as Record<string, unknown>)) {
              if (nv === null || typeof nv === 'string' || typeof nv === 'number' || typeof nv === 'boolean') {
                flat[`${k}_${nk}`] = nv
              }
            }
          }
        } else if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          flat[k] = v
        }
      }
      return flat
    })
    .filter(r => Object.keys(r).length > 0)
}

// ── Fetch with timeout ────────────────────────────────────────────────────────

async function fetchWithTimeout(
  url:     string,
  options: RequestInit & { timeout?: number },
): Promise<Response> {
  const { timeout = 8_000, ...fetchOptions } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(url, { ...fetchOptions, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TIER 2: UI List Page Scraping (fallback for entities not covered by Tier 1)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Tier 2: UI List Page Scraping
 *
 * Steps:
 *  A. Login via Playwright (if credentials available)
 *  B. Auto-discover list page candidates from nav/sidebar links on the home page
 *     (this works WITHOUT Phase 1 crawl data — handles SPAs, hash routers, etc.)
 *  C. Also merge in any list pages from Phase 1 crawl metadata_raw_store
 *  D. For each candidate: navigate, wait for render, scrape table/grid rows
 *  E. Upsert with source='ui_scraping' (protected by priority guard)
 *
 * @param coveredByApi — entity names already extracted by OpenAPI (skipped here)
 */
async function runUiScraping(
  projectId:   string,
  integration: { base_url: string | null; username: string | null; password: string | null },
  coveredByApi: Set<string>,
): Promise<number> {
  log.info('[WTD][UI] Tier 2 — UI List Page Scraping (self-contained discovery)')

  if (!integration.base_url) {
    log.warn('[WTD][UI] No base_url — skipping Tier 2')
    return 0
  }

  const baseUrl = integration.base_url.trim()

  // ── Detect hash-router SPAs e.g. https://app.com/#/ ──────────────────────
  // For these, list pages are at:  https://app.com/#/accounts  (not /accounts)
  const isHashRouter = baseUrl.includes('#')
  const hashBase     = isHashRouter ? baseUrl.split('#')[0].replace(/\/$/, '') : ''
  const urlOrigin    = new URL(baseUrl).origin

  let entitiesStored = 0

  try {
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })

    try {
      const context = await browser.newContext({
        // Wider viewport catches more nav items
        viewport: { width: 1440, height: 900 },
      })
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)

      // ── A. Login ────────────────────────────────────────────────────────
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 })
      await page.waitForTimeout(1_500)

      if (integration.username && integration.password) {
        const pwdLocator = page.locator('input[type="password"]')
        const hasPwd = await pwdLocator.count() > 0 &&
          await pwdLocator.first().isVisible({ timeout: 3_000 }).catch(() => false)

        if (hasPwd) {
          // Fill username
          for (const sel of [
            'input[type="email"]', 'input[name="username"]', 'input[name="email"]',
            'input[name="user"]',  'input[name="login"]',  'input[id="username"]',
            'input[id="email"]',   'input[type="text"]',
          ]) {
            const f = page.locator(sel).first()
            if (await f.isVisible({ timeout: 1_000 }).catch(() => false)) {
              await f.fill(integration.username)
              break
            }
          }
          await pwdLocator.first().fill(integration.password)

          for (const name of ['Log In', 'Login', 'Sign In', 'Sign in', 'Submit', 'Enter']) {
            const btn = page.getByRole('button', { name, exact: false })
            if (await btn.count() > 0) { await btn.first().click({ timeout: 5_000 }); break }
          }
          // Wait for navigation to settle post-login
          await page.waitForTimeout(3_000)
          await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
          log.info('[WTD][UI] Login completed')
        } else {
          log.info('[WTD][UI] No login form found — already authenticated or public app')
        }
      }

      // ── B. Auto-discover list page candidates ────────────────────────────
      //
      // Modern SPAs render navigation asynchronously via React/Vue/Angular.
      // Wait up to 8s for nav/sidebar content to render, then collect links.

      // Step 1: Wait for sidebar/nav to have content
      await page.waitForFunction(
        // IMPORTANT: page.evaluate/waitForFunction uses serialized JS — must be arrow fn, no named functions
        // (esbuild injects __name() for named functions which is NOT available in the browser context)
        () => {
          const sels = ['nav', 'aside', '[role="navigation"]', '[class*="sidebar"]', '[class*="menu"]']
          return sels.some(s => { const el = document.querySelector(s); return el && (el.textContent || '').trim().length > 10 })
        },
        { timeout: 8_000 }
      ).catch(() => {
        log.info('[WTD][UI] Nav/sidebar did not render within 8s — continuing anyway')
      })

      await page.waitForTimeout(1_000)

      const currentPageUrl  = page.url()
      const urlOrigin       = new URL(baseUrl).origin

      // ── Collect raw link data via $$eval with minimal anonymous fns ──────
      // Use a single $$eval that returns simple primitives (no named fns, no classes)

      // Pass 1: href-based links from nav containers
      const rawHrefLinks: Array<{ raw: string; label: string }> = await page.$$eval(
        'nav a[href], aside a[href], [role="navigation"] a[href], [class*="sidebar"] a[href], [class*="menu"] a[href], [class*="nav"] a[href], [to], router-link, nuxt-link',
        (els) => els.map((el) => ({
          raw:   el.getAttribute('href') || el.getAttribute('to') || '',
          label: (el.textContent || '').trim().slice(0, 60),
        })).filter((l) => l.raw && l.label)
      ).catch(() => [] as Array<{ raw: string; label: string }>)

      // Pass 2: Text labels from nav items (button/span/li based SPAs like the CRM)
      const rawTextItems: Array<{ text: string }> = await page.$$eval(
        '[class*="sidebar"] button, [class*="sidebar"] li, [class*="sidebar"] span, [class*="sidebar"] [role="menuitem"], [class*="menu"] button, [class*="menu"] li, nav button, nav li, aside li, aside button',
        (els) => els.map((el) => ({
          text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
        })).filter((l) => l.text.length > 1 && l.text.length < 35 && /^[a-zA-Z]/.test(l.text))
      ).catch(() => [] as Array<{ text: string }>)

      // ── Resolve and deduplicate discovered links ──────────────────────────
      const seen    = new Set<string>()
      const discoveredLinks: Array<{ url: string; label: string }> = []

      const skipLabels = /^(home|dashboard|logout|sign out|profile|settings|help|admin|support|\d+)$/i

      function resolveUrl(raw: string): string | null {
        if (!raw) return null
        const trimmed = raw.trim()
        if (!trimmed) return null
        if (trimmed.startsWith('http')) {
          try {
            const u = new URL(trimmed)
            return u.origin === urlOrigin ? trimmed : null
          } catch { return null }
        }
        if (isHashRouter) {
          const resolved = `${hashBase}#${trimmed.startsWith('/') ? trimmed : '/' + trimmed}`
          return resolved
        }
        try {
          return new URL(trimmed, currentPageUrl).href
        } catch { return null }
      }

      for (const { raw, label } of rawHrefLinks) {
        const url = resolveUrl(raw)
        if (url && !seen.has(url) && label) {
          seen.add(url)
          discoveredLinks.push({ url, label })
        }
      }

      // From text labels — click each sidebar item to discover REAL URLs.
      // SPAs route through JavaScript, so the only reliable way to find the
      // actual URL is to click the element and observe the browser's URL change.
      // Previous approach synthesized fake URLs (e.g. "Roles" → /roles) but many
      // apps use prefixed routes like /admin/roles which were missed entirely.
      const synthSeen = new Set<string>()
      const beforeClickUrl = page.url()
      for (const { text } of rawTextItems) {
        if (skipLabels.test(text)) continue
        if (synthSeen.has(text.toLowerCase())) continue
        synthSeen.add(text.toLowerCase())

        try {
          // Find the clickable sidebar element by its text
          const sidebarItem = page.locator(
            `[class*="sidebar"] :text-is("${text}"), ` +
            `[class*="menu"] :text-is("${text}"), ` +
            `nav :text-is("${text}"), ` +
            `aside :text-is("${text}")`
          ).first()

          if (!(await sidebarItem.isVisible({ timeout: 1_500 }).catch(() => false))) continue

          // Click and wait for navigation
          const urlBefore = page.url()
          await sidebarItem.click({ timeout: 3_000 })
          // Wait for SPA route change
          await page.waitForTimeout(1_500)
          // Also wait for any loading to settle
          await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => {})

          const urlAfter = page.url()
          // Only record if URL actually changed (navigation happened)
          if (urlAfter !== urlBefore && urlAfter !== beforeClickUrl) {
            if (!seen.has(urlAfter)) {
              seen.add(urlAfter)
              discoveredLinks.push({ url: urlAfter, label: text })
              log.info(`[WTD][UI] Click-captured: "${text}" → ${urlAfter}`)
            }
          } else {
            // Fallback: if click didn't change URL, synthesize as last resort
            const slug = text.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+$/, '')
            if (slug) {
              const synthUrl = isHashRouter ? `${hashBase}#/${slug}` : `${urlOrigin}/${slug}`
              if (!seen.has(synthUrl)) {
                seen.add(synthUrl)
                discoveredLinks.push({ url: synthUrl, label: text })
              }
            }
          }
        } catch (clickErr) {
          log.debug(`[WTD][UI] Click-capture failed for "${text}" — skipping`)
          // Fallback: synthesize URL
          const slug = text.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+$/, '')
          if (slug) {
            const synthUrl = isHashRouter ? `${hashBase}#/${slug}` : `${urlOrigin}/${slug}`
            if (!seen.has(synthUrl)) {
              seen.add(synthUrl)
              discoveredLinks.push({ url: synthUrl, label: text })
            }
          }
        }
      }
      // Navigate back to the starting page so subsequent scraping starts clean
      try {
        await page.goto(beforeClickUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 })
        await page.waitForTimeout(1_000)
      } catch { /* non-critical */ }

      log.info(`[WTD][UI] Discovered ${discoveredLinks.length} nav links (${rawHrefLinks.length} href + ${rawTextItems.length} text labels)`)






      // ── C. Merge with Phase 1 crawl pages (if any) ──────────────────────
      const crawlPages: Array<{ url: string; title: string }> = []
      try {
        const rawRows = await prisma.metadata_raw_store.findMany({
          where:  { project_id: projectId, metadata_type: 'webpage' },
          select: { raw_json: true },
          take:   5,
        })
        for (const row of rawRows) {
          const rd = row.raw_json as { pages?: Array<{ url: string; title: string }> }
          if (Array.isArray(rd?.pages)) {
            crawlPages.push(...rd.pages.map(p => ({ url: p.url ?? '', title: p.title ?? '' })))
          }
        }
      } catch { /* non-critical */ }

      // Build unified candidate list: discovered nav links + crawl pages
      const candidateMap = new Map<string, { url: string; label: string }>()

      // From nav discovery (higher priority — post-login view)
      for (const link of discoveredLinks) {
        candidateMap.set(link.url, link)
      }
      // From crawl (supplement)
      for (const cp of crawlPages) {
        if (!candidateMap.has(cp.url)) {
          candidateMap.set(cp.url, { url: cp.url, label: cp.title })
        }
      }

      const allCandidates = Array.from(candidateMap.values())
      log.info(`[WTD][UI] Total candidates after merging crawl: ${allCandidates.length}`)

      // ── D. Filter to list-page candidates ───────────────────────────────
      // For hash routers: examine the fragment (#/accounts), not the pathname
      const listPages = allCandidates.filter(candidate => {
        try {
          let checkPath: string
          if (candidate.url.includes('#')) {
            // Hash router: use fragment as path
            checkPath = candidate.url.split('#')[1] ?? ''
          } else {
            checkPath = new URL(candidate.url).pathname
          }
          checkPath = checkPath.toLowerCase()

          // Exclude obvious non-list pages
          const isNonList = /\/(dashboard|home|settings|profile|login|logout|register|new|create|edit|add|update|\d+|[0-9a-f-]{36})(\/|$|#)/.test(checkPath)
            || checkPath === '/' || checkPath === '' || checkPath === '#/'
          if (isNonList) return false

          // Prefer pages with plural entity names in path
          const hasListShape = (
            /\/[a-z]+s(\/|$|#)/.test(checkPath) ||   // /accounts, /contacts, /employees
            /\/list(\/|$)/.test(checkPath)   ||       // /user/list
            /\/(index|all)(\/|$)/.test(checkPath) ||  // /invoices/index
            /\/[a-z]+(s|es|ies)(\/|$)/.test(checkPath) // /categories
          )
          // Also accept if label suggests list page (e.g. "Accounts", "All Employees")
          const labelHintsList = /^(all\s+)?[a-z]+(s|es|ies)$/i.test(candidate.label.trim())

          return hasListShape || labelHintsList
        } catch { return false }
      }).slice(0, 12) // cap: max 12 list pages per run

      log.info(`[WTD][UI] ${listPages.length} list pages identified — ${allCandidates.length - listPages.length} filtered out`)

      if (listPages.length === 0) {
        log.info('[WTD][UI] No list pages found — Tier 2 complete with 0 entities')
        await context.close()
        return 0
      }

      // Filter: skip entities already covered by OpenAPI (Tier 1)
      const pendingPages = listPages.filter(p => {
        const name = deriveEntityName(p.url, p.label).toLowerCase()
        if (coveredByApi.has(name)) {
          log.debug(`[WTD][UI] Skipping "${name}" — already covered by OpenAPI`)
          return false
        }
        return true
      })

      log.info(`[WTD][UI] Scraping ${pendingPages.length} pages (${listPages.length - pendingPages.length} skipped — OpenAPI covered)`)

      // ── E. Scrape each list page ─────────────────────────────────────────
      for (const listPage of pendingPages) {
        const entityName = deriveEntityName(listPage.url, listPage.label)
        if (!entityName) continue

        try {
          log.info(`[WTD][UI] Navigating to ${listPage.url} for entity "${entityName}"`)

          // For hash-router SPAs: just goto the full URL including the hash
          await page.goto(listPage.url, { waitUntil: 'domcontentloaded', timeout: 15_000 })

          // Give React/Vue/Angular time to render the list
          await page.waitForTimeout(2_500)
          // Also wait for any loading spinner to disappear
          await page.waitForFunction(() => {
            const spinners = document.querySelectorAll(
              '[class*="loading"], [class*="spinner"], [class*="skeleton"]'
            )
            return spinners.length === 0 || Array.from(spinners).every(s => !(s as HTMLElement).offsetParent)
          }, { timeout: 5_000 }).catch(() => {})

          const records = await scrapeTableRows(page)
          if (records.length === 0) {
            log.info(`[WTD][UI] No table rows on ${listPage.url} — trying to wait longer...`)
            // One more attempt after a longer wait (some data grids load lazily)
            await page.waitForTimeout(2_000)
            const records2 = await scrapeTableRows(page)
            if (records2.length === 0) {
              log.info(`[WTD][UI] Still no rows — skipping ${listPage.url}`)
              continue
            }
            records.push(...records2)
          }

          await upsertEntity(projectId, entityName, records.slice(0, 10), 'ui_scraping', listPage.url)
          entitiesStored++
          log.info(`[WTD][UI] ✅ ${records.length} records for "${entityName}" from ${listPage.url}`)

        } catch (pageErr) {
          log.warn({ err: pageErr }, `[WTD][UI] Failed to scrape ${listPage.url}`)
        }
      }

      await context.close()
    } finally {
      await browser.close().catch(() => {})
    }
  } catch (browserErr) {
    log.error({ err: browserErr }, '[WTD][UI] Playwright launch failed')
  }

  log.info(`[WTD][UI] Tier 2 complete — ${entitiesStored} entities stored from UI`)
  return entitiesStored
}


// ══════════════════════════════════════════════════════════════════════════════
// TIER 0: Manual JSON Upload (always wins — never overwritten)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Accepts a JSON payload of shape { Entity: [records…] } and upserts
 * each entity with source='user_upload' (highest priority — never overwritten).
 */
export async function storeUploadedTestData(
  projectId: string,
  payload:   Record<string, Record<string, unknown>[]>,
): Promise<{ entitiesStored: number; totalRecords: number; preview: Record<string, number> }> {
  await ensureTable()

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw { statusCode: 400, message: 'Invalid payload: expected { EntityName: [records…] }' }
  }

  let entitiesStored = 0
  let totalRecords   = 0
  const preview: Record<string, number> = {}

  for (const [entityName, records] of Object.entries(payload)) {
    if (!entityName || typeof entityName !== 'string') continue
    if (!Array.isArray(records) || records.length === 0) continue

    const sanitised: TestDataRecord[] = records.map(r =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [
          k,
          v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
            ? v
            : String(v),
        ]),
      ),
    )

    await upsertEntity(projectId, entityName.trim(), sanitised, 'user_upload')
    entitiesStored++
    totalRecords       += sanitised.length
    preview[entityName] = sanitised.length
    log.info(`[WTD][T0] Stored ${sanitised.length} user-uploaded records for "${entityName}"`)
  }

  log.info(`[WTD][T0] Manual upload complete — ${entitiesStored} entities, ${totalRecords} records`)
  return { entitiesStored, totalRecords, preview }
}

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC: Fetch + Context Builder
// ══════════════════════════════════════════════════════════════════════════════

export async function getTestData(projectId: string): Promise<TestDataEntity[]> {
  await ensureTable()

  const rows = await prisma.$queryRaw<Array<{
    entity_name:       string
    record_count:      number
    source:            string
    last_extracted_at: Date
    records:           unknown
    source_url:        string | null
  }>>`
    SELECT entity_name, record_count, source, last_extracted_at, records,
           COALESCE(source_url, '') as source_url
    FROM web_test_data
    WHERE project_id = ${projectId}::uuid
    ORDER BY entity_name
  `

  return rows.map(r => ({
    entity_name:       r.entity_name,
    record_count:      r.record_count,
    source:            r.source,
    last_extracted_at: r.last_extracted_at.toISOString(),
    records:           (Array.isArray(r.records) ? r.records : []) as TestDataRecord[],
    source_url:        r.source_url || undefined,
  }))
}

export interface EntityUrlInfo {
  path:            string
  buttonName?:     string   // e.g. "Create Role" — the SUBMIT button inside the form/modal
  openButtonName?: string   // e.g. "Add Role"   — the button that OPENS the form/modal (if different)
}

/**
 * Returns a map of entity name → verified URL info (path + create button name).
 * These are REAL URLs that the test data scraper successfully navigated to.
 * Used by the generation service to inject known-valid URLs into the LLM prompt.
 */
export async function getEntityUrlMap(projectId: string): Promise<Record<string, EntityUrlInfo>> {
  await ensureTable()

  const rows = await prisma.$queryRaw<Array<{
    entity_name:        string
    source_url:         string | null
    create_button_name: string | null
    open_button_name:   string | null
  }>>`
    SELECT entity_name, source_url,
           COALESCE(create_button_name, '') as create_button_name,
           COALESCE(open_button_name, '')   as open_button_name
    FROM web_test_data
    WHERE project_id = ${projectId}::uuid
      AND source_url IS NOT NULL
      AND source_url != ''
    ORDER BY entity_name
  `

  const urlMap: Record<string, EntityUrlInfo> = {}
  for (const row of rows) {
    if (!row.source_url) continue
    let path = ''
    try {
      path = new URL(row.source_url).pathname
    } catch {
      if (row.source_url.startsWith('/')) path = row.source_url
    }
    if (!path) continue
    urlMap[row.entity_name] = {
      path,
      buttonName:     row.create_button_name || undefined,
      openButtonName: row.open_button_name   || undefined,
    }
  }
  return urlMap
}

/**
 * Formats test data into a compact, LLM-ready string injected into the
 * WEB_APP_RAG_SYSTEM_PROMPT {test_data_context} placeholder.
 *
 * Priority markers: ⭐ user_upload > 🔌 api > 🤖 ui_scraping
 */
export function buildTestDataContext(
  entities:     TestDataEntity[],
  targetEntity?: string,
): string {
  if (entities.length === 0) return ''

  let relevant = entities
  if (targetEntity) {
    const lower = targetEntity.toLowerCase()
    relevant = entities.filter(
      e =>
        e.entity_name.toLowerCase().includes(lower) ||
        lower.includes(e.entity_name.toLowerCase()),
    )
    if (relevant.length === 0) relevant = entities
  }

  const SOURCE_ICON: Record<string, string> = {
    user_upload: '⭐',
    api:         '🔌',
    ui_scraping: '🤖',
  }

  const lines: string[] = [
    '=== REAL TEST DATA FROM THE APPLICATION ===',
    'Use the following REAL VALUES when filling in form fields.',
    'Priority: ⭐ User Upload > 🔌 API > 🤖 UI Scraping',
    '',
  ]

  for (const entity of relevant) {
    const icon   = SOURCE_ICON[entity.source] ?? '📋'
    const sample = entity.records.slice(0, 5)

    lines.push(`--- ${icon} ${entity.entity_name} (${entity.record_count} records, source: ${entity.source}) ---`)

    if (sample.length > 0) {
      // Sanitise keys: strip trailing non-alphanumeric chars (e.g. "Account Name☰" → "Account Name")
      const sanitiseKey = (k: string) => k.replace(/[^\w\s]+$/g, '').trim()
      const rawKeys = Object.keys(sample[0]).slice(0, 8)
      const keys = rawKeys.map(sanitiseKey)

      // Filter out records where all values are '-', empty, or clearly invalid test data
      const validSample = sample.filter(rec => {
        const vals = rawKeys.map(k => String(rec[k as keyof typeof rec] ?? '').trim())
        // At least one non-empty, non-dash value
        return vals.some(v => v.length > 0 && v !== '-' && v.length < 100)
      })

      if (validSample.length === 0) {
        lines.push('  (no valid records — run a metadata sync to refresh test data)')
      } else {
        lines.push(`Fields: ${keys.join(' | ')}`)
        for (const rec of validSample) {
          const row = rawKeys.map(k => String(rec[k as keyof typeof rec] ?? '')).join(' | ')
          lines.push(`  → ${row}`)
        }
      }
    } else {
      lines.push('  (no records)')
    }
    lines.push('')
  }

  lines.push('=== END TEST DATA ===')
  return lines.join('\n')
}

// ─── Private Helpers ─────────────────────────────────────────────────────────

/** Derives a clean entity name from a list-page URL or page title. */
function deriveEntityName(url: string, title: string): string {
  function singularize(word: string): string {
    return word
      .replace(/ies$/i,       'y')    // opportunities → opportunity
      .replace(/sses$/i,      'ss')   // addresses → address  
      .replace(/ses$/i,       's')    // processes → process
      .replace(/oes$/i,       'o')    // heroes → hero
      .replace(/([a-z])s$/i, '$1')   // leads → lead, accounts → account
  }

  // Prefer title (from nav link label) — it's already human-readable
  if (title && title.length > 0 && title.length < 50) {
    const cleaned = title
      .replace(/[\s\-–|]*(list|all|overview|index|home).*$/i, '')
      .trim()
    if (cleaned) {
      // Apply singularization to the title
      return singularize(cleaned)
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim()
    }
  }

  try {
    const path     = new URL(url).pathname || url.split('#')[1] || ''
    const segments = path.split('/').filter(Boolean)
    const segment  = segments.reverse().find(s =>
      !/^(list|index|all|search|\d+|[0-9a-f-]{8,})$/i.test(s),
    )
    if (segment) {
      const raw = segment.replace(/_/g, ' ').replace(/-/g, ' ')
      return singularize(raw)
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim()
    }
  } catch { /* ignore malformed URL */ }

  return ''
}


/**
 * Scrapes the first visible HTML table or ARIA grid on a Playwright page.
 * Returns up to 10 rows as key-value records using the header row as keys.
 */
async function scrapeTableRows(
  page: import('playwright').Page,
): Promise<TestDataRecord[]> {
  return page.evaluate(() => {
    // NOTE: This function uses ONLY anonymous arrow functions (no named functions).
    // esbuild transforms named functions with __name() which is not available in the browser context.

    // Clean icon/emoji characters from header/cell text inline to avoid esbuild __name() injection
    const records: Record<string, string>[] = []

    const tables = Array.from(document.querySelectorAll('table')).filter(
      t => t.offsetParent !== null && t.querySelectorAll('tbody tr').length > 0,
    )

    if (tables.length > 0) {
      const table   = tables[0]
      const headers = Array.from(table.querySelectorAll('thead th, thead td'))
        .map(th => (th.textContent ?? '').replace(/[\u2600-\u27FF\u2900-\u2BFF\u{1F000}-\u{1FFFF}☰▼▲×✓✗≡⋮⁝⋯]/gu, '').trim())
        .filter(h => h.length > 0 && h.length < 60)  // skip icon-only or excessively long headers

      if (headers.length === 0) {
        const firstRow = table.querySelector('tr')
        if (firstRow) {
          headers.push(
            ...Array.from(firstRow.querySelectorAll('th, td'))
              .map(c => (c.textContent ?? '').replace(/[\u2600-\u27FF\u2900-\u2BFF\u{1F000}-\u{1FFFF}☰▼▲×✓✗≡⋮⁝⋯]/gu, '').trim())
              .filter(h => h.length > 0 && h.length < 60),
          )
        }
      }

      if (headers.length > 0) {
        const rows = Array.from(table.querySelectorAll('tbody tr'))
        for (const row of rows.slice(0, 10)) {
          const cells = Array.from(row.querySelectorAll('td'))
          if (cells.length === 0) continue
          const record: Record<string, string> = {}
          headers.forEach((h, i) => {
            if (h && cells[i]) record[h] = (cells[i].textContent ?? '').replace(/[\u2600-\u27FF\u2900-\u2BFF\u{1F000}-\u{1FFFF}☰▼▲×✓✗≡⋮⁝⋯]/gu, '').trim()
          })
          if (Object.keys(record).length > 0) records.push(record)
        }
      }
    }

    if (records.length > 0) return records

    // Fallback: ARIA grid
    const grid = document.querySelector('[role="grid"], [role="table"]')
    if (grid) {
      const headerCells = Array.from(grid.querySelectorAll('[role="columnheader"]'))
        .map(c => (c.textContent ?? '').trim())
        .filter(Boolean)

      const dataRows = Array.from(grid.querySelectorAll('[role="row"]')).filter(
        r => r.querySelector('[role="gridcell"], [role="cell"]') !== null,
      )

      for (const row of dataRows.slice(0, 10)) {
        const cells = Array.from(row.querySelectorAll('[role="gridcell"], [role="cell"]'))
        if (cells.length === 0) continue
        const record: Record<string, string> = {}
        headerCells.forEach((h, i) => {
          if (h && cells[i]) record[h] = (cells[i].textContent ?? '').trim()
        })
        if (Object.keys(record).length > 0) records.push(record)
      }
    }

    return records
  })
}
