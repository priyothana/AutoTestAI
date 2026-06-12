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

  // Extract key_routes from auth_config — user-configured known-good entity paths
  // These are injected directly into Tier 2 so they're always scraped regardless of BFS discovery
  const authCfg    = (integration.auth_config ?? {}) as Record<string, unknown>
  const keyRoutes  = Array.isArray(authCfg.key_routes)
    ? (authCfg.key_routes as string[]).filter(r => typeof r === 'string')
    : []

  log.info(`[WTD] key_routes from auth_config: [${keyRoutes.join(', ')}]`)

  // ── Tier 1: OpenAPI Detection ────────────────────────────────────────────
  const apiSummary = await runOpenApiDetection(projectId, baseOrigin, {
    username: integration.username ?? undefined,
    password: integration.password ?? undefined,
  })

  // Track which entities were covered by Tier 1 so Tier 2 skips them
  const coveredByApi = new Set(apiSummary.coveredEntities.map(e => e.toLowerCase()))

  // ── Tier 2: UI List Page Scraping (fallback) ─────────────────────────────
  const uiCount = await runUiScraping(projectId, integration, coveredByApi, keyRoutes)

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

  for (const endpoint of listEndpoints.slice(0, 30)) {
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
  projectId:    string,
  integration:  { base_url: string | null; username: string | null; password: string | null },
  coveredByApi: Set<string>,
  keyRoutes:    string[] = [],
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
        () => {
          const sels = ['nav', 'aside', '[role="navigation"]', '[class*="sidebar"]', '[class*="menu"]']
          return sels.some(s => { const el = document.querySelector(s); return el && (el.textContent || '').trim().length > 10 })
        },
        { timeout: 8_000 }
      ).catch(() => {
        log.info('[WTD][UI] Nav/sidebar did not render within 8s — continuing anyway')
      })

      await page.waitForTimeout(1_000)

      // Step 2: Scroll the sidebar to ensure all items are rendered (lazy-rendered nav lists)
      try {
        await page.evaluate(() => {
          const sidebarSels = ['aside', '[class*="sidebar"]', '[class*="side-bar"]', 'nav', '[role="navigation"]']
          for (const sel of sidebarSels) {
            const el = document.querySelector(sel)
            if (el && el.scrollHeight > el.clientHeight) {
              el.scrollTop = el.scrollHeight
              break
            }
          }
        })
        await page.waitForTimeout(500)
      } catch { /* non-critical */ }

      // Step 3: Expand collapsed sidebar groups (e.g. "Endpoint Management ▸" → reveals Patches, Scripts)
      // Click any sidebar parent item that has a chevron/arrow/toggle indicator.
      try {
        const collapsedGroups = await page.$$eval(
          '[class*="sidebar"] [class*="arrow"], [class*="sidebar"] [class*="chevron"], [class*="sidebar"] [class*="toggle"], [class*="sidebar"] [class*="expand"], [class*="sidebar"] [class*="collapse"], [class*="menu"] [class*="arrow"], nav [class*="chevron"], aside [class*="arrow"]',
          (els) => els.map(el => (el.closest('li, div, a, button') as HTMLElement | null)?.textContent?.trim().slice(0, 40) ?? '').filter(Boolean)
        ).catch(() => [] as string[])

        for (const groupLabel of collapsedGroups.slice(0, 8)) {
          if (!groupLabel) continue
          try {
            const parent = page.locator(`[class*="sidebar"] :text-is("${groupLabel}"), nav :text-is("${groupLabel}"), aside :text-is("${groupLabel}")`).first()
            if (await parent.isVisible({ timeout: 1_000 }).catch(() => false)) {
              await parent.click({ timeout: 2_000 })
              await page.waitForTimeout(800)
              log.info(`[WTD][UI] Expanded collapsed group: "${groupLabel}"`)
            }
          } catch { /* non-critical — move on */ }
        }
      } catch { /* non-critical */ }

      const currentPageUrl  = page.url()
      const urlOrigin       = new URL(baseUrl).origin

      // ── Collect raw link data via $$eval with minimal anonymous fns ──────
      // Use a single $$eval that returns simple primitives (no named fns, no classes)

      // Pass 1: href-based links from nav containers
      // Wide selector set to catch sidebar patterns across React/Vue/Angular apps
      const rawHrefLinks: Array<{ raw: string; label: string }> = await page.$$eval(
        [
          'nav a[href]', 'aside a[href]', '[role="navigation"] a[href]',
          '[class*="sidebar"] a[href]', '[class*="side-bar"] a[href]',
          '[class*="menu"] a[href]', '[class*="nav"] a[href]',
          '[class*="link"] a[href]', '[class*="item"] a[href]',
          'a[class*="nav"]', 'a[class*="menu"]', 'a[class*="link"]',
          '[to]', 'router-link', 'nuxt-link',
        ].join(', '),
        (els) => els.map((el) => ({
          raw:   el.getAttribute('href') || el.getAttribute('to') || '',
          label: (el.textContent || '').trim().slice(0, 60),
        })).filter((l) => l.raw && l.label)
      ).catch(() => [] as Array<{ raw: string; label: string }>)

      // Pass 2: Text labels from ALL clickable nav-like elements (button/span/li/div)
      // Widened to catch dashboards that use div-based or custom sidebar components.
      // Collected AFTER group expansion above so newly-revealed items are included.
      const rawTextItems: Array<{ text: string }> = await page.$$eval(
        [
          '[class*="sidebar"] button', '[class*="sidebar"] li', '[class*="sidebar"] span',
          '[class*="sidebar"] div[class*="item"]', '[class*="sidebar"] [role="menuitem"]',
          '[class*="side-bar"] button', '[class*="side-bar"] li',
          '[class*="menu"] button', '[class*="menu"] li', '[class*="menu"] div[class*="item"]',
          'nav button', 'nav li', 'nav span',
          'aside li', 'aside button',
          '[class*="nav-item"]', '[class*="navitem"]', '[class*="nav_item"]',
        ].join(', '),
        (els) => els.map((el) => ({
          text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
        })).filter((l) => l.text.length > 1 && l.text.length < 40 && /^[a-zA-Z]/.test(l.text))
      ).catch(() => [] as Array<{ text: string }>)

      // ── Resolve and deduplicate discovered links ──────────────────────────
      const seen    = new Set<string>()
      // fromNavDiscovery: URLs captured by clicking a real nav item — trusted as
      // valid list pages even if they don't have a plural name in the path.
      const navDiscoveredUrls = new Set<string>()
      const discoveredLinks: Array<{ url: string; label: string }> = []

      // Only skip truly non-entity items. Module group labels (e.g. "Warehouse", "Logistics")
      // must NOT be skipped — clicking them expands the group to reveal sub-entities.
      const skipLabels = /^(home|dashboard|logout|sign out|sign-out|profile|settings|help|support|notifications?|\d+|back|close|toggle|search|overview|summary report|report)$/i

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

      // ── Inject key_routes from auth_config as trusted entity URLs ────────
      // These are user-configured paths (e.g. /warehouse, /inventory, /skus).
      // We mark them as navDiscoveredUrls so they BYPASS all URL-shape filters
      // and are always scraped, even if BFS never discovers them.
      //
      // Skip paths that end with action suffixes (/create, /new, /edit, /add, /update)
      // — these are form pages, not list pages. Match on the last path segment only.
      const keyRouteActionSuffix = /\/(create|new|edit|add|update|delete)(\?.*)?$/i
      for (const route of keyRoutes) {
        const raw = route.startsWith('/') ? route : `/${route}`
        if (keyRouteActionSuffix.test(raw)) continue   // skip form/action pages
        const url = resolveUrl(raw)
        if (url && !seen.has(url)) {
          seen.add(url)
          navDiscoveredUrls.add(url)  // mark as trusted — skips URL-shape filter
          // Derive label from the last path segment
          const lastSeg = raw.split('/').filter(Boolean).pop() ?? raw
          const label   = lastSeg.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
          discoveredLinks.push({ url, label })
          log.info(`[WTD][UI] key_route injected: "${label}" → ${url}`)
        }
      }
      log.info(`[WTD][UI] Discovered ${discoveredLinks.length} nav links (${rawHrefLinks.length} href + ${rawTextItems.length} text labels, ${keyRoutes.length} key_routes)`)

      // ── Dynamic BFS nav discovery ─────────────────────────────────────────
      // After each successful navigation the sidebar may reveal NEW sub-items
      // (collapsible groups, context-sensitive menus). We re-scan after every
      // navigation and add newly-discovered labels to the pending queue.
      const synthSeen      = new Set<string>()
      const beforeClickUrl = page.url()

      // Helper: collect current sidebar text labels
      const collectSidebarLabels = async (): Promise<string[]> => {
        try {
          return await page.$$eval(
            [
              '[class*="sidebar"] button', '[class*="sidebar"] li', '[class*="sidebar"] span',
              '[class*="sidebar"] div[class*="item"]', '[class*="sidebar"] [role="menuitem"]',
              '[class*="side-bar"] button', '[class*="side-bar"] li',
              '[class*="menu"] button', '[class*="menu"] li',
              'nav button', 'nav li', 'nav span',
              'aside li', 'aside button',
              '[class*="nav-item"]', '[class*="navitem"]', '[class*="nav_item"]',
            ].join(', '),
            (els) => els
              .map(el => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40))
              .filter(t => t.length > 1 && t.length < 40 && /^[a-zA-Z]/.test(t))
          )
        } catch { return [] }
      }

      // Seed queue with the initial set of visible text labels
      const pendingLabels: string[] = rawTextItems.map(t => t.text)

      let queueIdx = 0
      const MAX_NAV_CLICKS = 80  // safety cap — must be large enough for multi-module apps

      while (queueIdx < pendingLabels.length && queueIdx < MAX_NAV_CLICKS) {
        const text = pendingLabels[queueIdx++]
        if (!text || skipLabels.test(text)) continue
        if (synthSeen.has(text.toLowerCase())) continue
        synthSeen.add(text.toLowerCase())

        try {
          let sidebarItem = page.locator(
            `[class*="sidebar"] :text-is("${text}"), ` +
            `[class*="side-bar"] :text-is("${text}"), ` +
            `[class*="menu"] :text-is("${text}"), ` +
            `nav :text-is("${text}"), ` +
            `aside :text-is("${text}")`
          ).first()

          if (!(await sidebarItem.isVisible({ timeout: 800 }).catch(() => false))) {
            sidebarItem = page.getByRole('link', { name: text, exact: true }).or(
              page.getByRole('button', { name: text, exact: true })
            ).first()
          }

          if (!(await sidebarItem.isVisible({ timeout: 800 }).catch(() => false))) continue

          const urlBefore = page.url()
          await sidebarItem.click({ timeout: 2_500 })
          await page.waitForTimeout(1_200)
          await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => {})

          const urlAfter = page.url()

          if (urlAfter !== urlBefore) {
            // URL changed → real navigation → record it
            if (!seen.has(urlAfter)) {
              seen.add(urlAfter)
              navDiscoveredUrls.add(urlAfter)
              discoveredLinks.push({ url: urlAfter, label: text })
              log.info(`[WTD][UI] Click-captured: "${text}" \u2192 ${urlAfter}`)
            }
            // Re-scan sidebar for NEW labels revealed by this navigation (BFS)
            const freshLabels = await collectSidebarLabels()
            for (const fl of freshLabels) {
              if (fl && !synthSeen.has(fl.toLowerCase()) && !skipLabels.test(fl)) {
                pendingLabels.push(fl)
              }
            }
          } else {
            // URL unchanged → may be a toggle/expand that revealed sub-items
            const freshLabels = await collectSidebarLabels()
            let newCount = 0
            for (const fl of freshLabels) {
              if (fl && !synthSeen.has(fl.toLowerCase()) && !skipLabels.test(fl)) {
                pendingLabels.push(fl)
                newCount++
              }
            }
            if (newCount > 0) {
              log.info(`[WTD][UI] Toggle "${text}" revealed ${newCount} new sidebar items`)
            } else {
              // Synthesize URL as last resort
              const slug = text.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+$/, '')
              if (slug && !seen.has(`${urlOrigin}/${slug}`)) {
                const synthUrl = isHashRouter ? `${hashBase}#/${slug}` : `${urlOrigin}/${slug}`
                seen.add(synthUrl)
                discoveredLinks.push({ url: synthUrl, label: text })
              }
            }
          }
        } catch {
          const slug = text.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+$/, '')
          if (slug) {
            const synthUrl = isHashRouter ? `${hashBase}#/${slug}` : `${urlOrigin}/${slug}`
            if (!seen.has(synthUrl)) { seen.add(synthUrl); discoveredLinks.push({ url: synthUrl, label: text }) }
          }
        }
      }

      // Navigate back to the starting page so scraping starts clean
      try {
        await page.goto(beforeClickUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 })
        await page.waitForTimeout(1_000)
      } catch { /* non-critical */ }

      log.info(`[WTD][UI] BFS discovery complete — ${discoveredLinks.length} links (${queueIdx} labels processed)`)







      // ── C. Merge with Phase 1 crawl pages (if any) ──────────────────────
      const crawlPages: Array<{ url: string; title: string }> = []
      try {
        // Source C1: metadata_raw_store (raw crawler blobs)
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

        // Source C2: metadata_normalized webapp_crawl (structured crawl data — richer)
        const normRows = await prisma.metadata_normalized.findMany({
          where:  { project_id: projectId, entity_type: 'webapp_crawl' },
          select: { structured_json: true },
          take:   3,
        })
        const baseOriginForMerge = new URL(baseUrl).origin
        for (const row of normRows) {
          const nd = (row.structured_json ?? {}) as { pages?: Array<{ path?: string; title?: string }> }
          if (Array.isArray(nd.pages)) {
            for (const p of nd.pages) {
              if (p.path && p.path !== '/' && p.path !== '') {
                // Reconstruct absolute URL from relative path
                const absUrl = p.path.startsWith('http') ? p.path : `${baseOriginForMerge}${p.path.startsWith('/') ? p.path : '/' + p.path}`
                crawlPages.push({ url: absUrl, title: p.title ?? '' })
              }
            }
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
          // URLs captured by clicking a nav item are trusted unconditionally
          // (they proved the app navigated there — they ARE real pages)
          if (navDiscoveredUrls.has(candidate.url)) return true

          let checkPath: string
          if (candidate.url.includes('#')) {
            checkPath = candidate.url.split('#')[1] ?? ''
          } else {
            checkPath = new URL(candidate.url).pathname
          }
          checkPath = checkPath.toLowerCase()

          // Exclude obvious non-list pages
          const isNonList = /\/(dashboard|home|settings|profile|login|logout|register|new|create|edit|add|update|\d+|[0-9a-f-]{36})(\/|$|#)/.test(checkPath)
            || checkPath === '/' || checkPath === '' || checkPath === '#/'
          if (isNonList) return false

          // Accept plural path segments: /accounts, /vulnerabilities, /categories
          const hasListShape = (
            /\/[a-z]+s(\/|$|#)/.test(checkPath) ||
            /\/list(\/|$)/.test(checkPath)       ||
            /\/(index|all)(\/|$)/.test(checkPath) ||
            /\/[a-z]+(es|ies)(\/|$)/.test(checkPath)
          )
          // Accept any single-segment or two-segment path that isn't a known noise word.
          // Two-segment paths handle module-scoped entities e.g. /warehouse/inventory,
          // /warehouse/sku, /logistics/shipments — the entity is the LAST clean segment.
          const segments = checkPath.split('/').filter(Boolean)
          const NOISE_SEGMENTS = /^(api|v\d+|app|main|panel|system|public|static|assets)$/
          const isSingleCleanSegment = segments.length === 1
            && segments[0].length >= 3
            && !NOISE_SEGMENTS.test(segments[0])
          // Two-segment paths: /module/entity — accept if entity segment is clean
          const isTwoSegmentEntity = segments.length === 2
            && segments[1].length >= 3
            && !NOISE_SEGMENTS.test(segments[1])
            && !/^(\d+|[0-9a-f-]{36}|new|create|edit|add|update)$/.test(segments[1])

          // Accept if label looks like an entity (titlecase word/s)
          const labelHintsList = /^([A-Z][a-z]+)(\s+[A-Z][a-z]+)*s?$/.test(candidate.label.trim())

          return hasListShape || isSingleCleanSegment || isTwoSegmentEntity || labelHintsList
        } catch { return false }
      }).slice(0, 60) // raised cap: up to 60 list pages — needed for multi-module apps

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
            await page.waitForTimeout(3_000)
            const records2 = await scrapeTableRows(page)
            if (records2.length === 0) {
              log.info(`[WTD][UI] No rows found on ${listPage.url} — storing entity with 0 records so it appears in the list`)
              // Still register the entity so it shows up in the metadata table.
              // Its existence tells the system the page is a valid entity page,
              // even if we could not extract table data (custom renderer, empty data, etc.)
              await upsertEntity(projectId, entityName, [], 'ui_scraping', listPage.url)
              entitiesStored++
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

/**
 * Delete ALL test-data entities for a project.
 * Used to clear stale/wrong entities (e.g. CRM entities from a different app context).
 */
export async function clearTestData(projectId: string): Promise<number> {
  await ensureTable()
  const result = await prisma.$executeRaw`
    DELETE FROM web_test_data WHERE project_id = ${projectId}::uuid
  `
  log.info(`[WTD] Cleared all test data for project ${projectId} (${result} rows deleted)`)
  return result
}

/**
 * Delete a single test-data entity by name for a project.
 * Used to remove individual stale entities from the UI.
 */
export async function deleteTestDataEntity(projectId: string, entityName: string): Promise<boolean> {
  await ensureTable()
  const result = await prisma.$executeRaw`
    DELETE FROM web_test_data
    WHERE project_id = ${projectId}::uuid
      AND entity_name = ${entityName}
  `
  return (result as number) > 0
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
 * Handles: HTML tables, ARIA grids, div-based lists, card grids, list-items.
 */
async function scrapeTableRows(
  page: import('playwright').Page,
): Promise<TestDataRecord[]> {
  return page.evaluate(() => {
    // NOTE: This function uses ONLY anonymous arrow functions (no named functions).
    // esbuild transforms named functions with __name() which is not available in the browser context.
    // DO NOT add `const foo = ...` named helpers — inline the regex replace at every call site.

    const records: Record<string, string>[] = []

    // ── Strategy 1: Standard HTML <table> ────────────────────────────────────
    const tables = Array.from(document.querySelectorAll('table')).filter(
      t => t.offsetParent !== null && t.querySelectorAll('tbody tr').length > 0,
    )

    if (tables.length > 0) {
      const table   = tables[0]
      const headers = Array.from(table.querySelectorAll('thead th, thead td'))
        .map(th => (th.textContent ?? '').replace(/[\u2600-\u27FF\u2900-\u2BFF\u2630\u25bc\u25b2\u00d7\u2713\u2717\u2261\u22ee\u205d\u22ef]/g, '').trim())

      if (headers.length === 0 || headers.every(h => h.length === 0)) {
        const firstRow = table.querySelector('tr')
        if (firstRow) {
          headers.length = 0
          headers.push(
            ...Array.from(firstRow.querySelectorAll('th, td'))
              .map(c => (c.textContent ?? '').replace(/[\u2600-\u27FF\u2900-\u2BFF\u2630\u25bc\u25b2\u00d7\u2713\u2717\u2261\u22ee\u205d\u22ef]/g, '').trim())
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
            if (h && h.length > 0 && h.length < 60 && cells[i]) {
              record[h] = (cells[i].textContent ?? '').replace(/[\u2600-\u27FF\u2900-\u2BFF\u2630\u25bc\u25b2\u00d7\u2713\u2717\u2261\u22ee\u205d\u22ef]/g, '').trim()
            }
          })
          if (Object.keys(record).length > 0) records.push(record)
        }
      }
    }

    if (records.length > 0) return records

    // ── Strategy 2: ARIA grid ([role="grid"] / [role="table"]) ────────────────
    const grid = document.querySelector('[role="grid"], [role="table"]')
    if (grid) {
      const headerCells = Array.from(grid.querySelectorAll('[role="columnheader"]'))
        .map(c => (c.textContent ?? '').replace(/[\u2600-\u27FF\u2900-\u2BFF\u2630\u25bc\u25b2\u00d7\u2713\u2717\u2261\u22ee\u205d\u22ef]/g, '').trim())

      const dataRows = Array.from(grid.querySelectorAll('[role="row"]')).filter(
        r => r.querySelector('[role="gridcell"], [role="cell"]') !== null,
      )

      for (const row of dataRows.slice(0, 10)) {
        const cells = Array.from(row.querySelectorAll('[role="gridcell"], [role="cell"]'))
        if (cells.length === 0) continue
        const record: Record<string, string> = {}
        headerCells.forEach((h, i) => {
          if (h && h.length > 0 && h.length < 60 && cells[i]) {
            record[h] = (cells[i].textContent ?? '').replace(/[\u2600-\u27FF\u2900-\u2BFF\u2630\u25bc\u25b2\u00d7\u2713\u2717\u2261\u22ee\u205d\u22ef]/g, '').trim()
          }
        })
        if (Object.keys(record).length > 0) records.push(record)
      }
    }

    if (records.length > 0) return records

    // ── Strategy 3: Div-based list rows (common in React/Next.js data grids) ─
    // Looks for repeating div containers that share a common class pattern.
    // Heuristic: find a parent with 3+ direct children that look like data rows.
    const gridSelectors = [
      '[class*="ag-row"]',          // ag-Grid
      '[class*="grid-row"]',
      '[class*="data-row"]',
      '[class*="list-row"]',
      '[class*="table-row"]',
      '[class*="row-item"]',
      '[class*="list-item"]:not(li)',  // custom list items
      'tr[class*="row"]',
    ]
    for (const sel of gridSelectors) {
      const rows = Array.from(document.querySelectorAll(sel) as NodeListOf<HTMLElement>)
        .filter(r => r.offsetParent !== null)
      if (rows.length < 2) continue

      // Extract text from each child cell of the row
      for (const row of rows.slice(0, 10)) {
        const cells = Array.from(row.children) as HTMLElement[]
        const record: Record<string, string> = {}
        let col = 0
        for (const cell of cells) {
          const text = (cell.textContent ?? '').replace(/[\u2600-\u27FF\u2900-\u2BFF\u2630\u25bc\u25b2\u00d7\u2713\u2717\u2261\u22ee\u205d\u22ef]/g, '').trim()
          if (text && text.length < 200) {
            record[`col${col + 1}`] = text
            col++
          }
        }
        if (col >= 2) records.push(record)
      }
      if (records.length > 0) break
    }

    if (records.length > 0) return records

    // ── Strategy 4: Card-based list (each entity rendered as a card/panel) ───
    const cardSelectors = [
      '[class*="card"]:not([class*="card-header"]):not([class*="card-body"])',
      '[class*="item-card"]',
      '[class*="list-card"]',
      '[class*="entity-card"]',
      '[class*="record-card"]',
    ]
    for (const sel of cardSelectors) {
      const cards = Array.from(document.querySelectorAll(sel) as NodeListOf<HTMLElement>)
        .filter(c => c.offsetParent !== null && (c.textContent || '').trim().length > 5)
      if (cards.length < 2) continue

      for (const card of cards.slice(0, 10)) {
        const text = ((card.textContent ?? '').replace(/[\u2600-\u27FF\u2900-\u2BFF\u2630\u25bc\u25b2\u00d7\u2713\u2717\u2261\u22ee\u205d\u22ef]/g, '').trim()).slice(0, 300)
        if (text.length > 5) records.push({ value: text })
      }
      if (records.length > 0) break
    }

    if (records.length > 0) return records

    // ── Strategy 5: Standard <ul>/<ol> list items ────────────────────────────
    const lists = Array.from(document.querySelectorAll('ul, ol')).filter(
      l => (l as HTMLElement).offsetParent !== null && l.querySelectorAll('li').length >= 2
    )
    if (lists.length > 0) {
      const items = Array.from(lists[0].querySelectorAll('li'))
        .filter(li => (li as HTMLElement).offsetParent !== null)
        .slice(0, 10)
      for (const li of items) {
        const text = ((li.textContent ?? '').replace(/[\u2600-\u27FF\u2900-\u2BFF\u2630\u25bc\u25b2\u00d7\u2713\u2717\u2261\u22ee\u205d\u22ef]/g, '').trim()).slice(0, 200)
        if (text.length > 3) records.push({ value: text })
      }
    }

    return records
  })
}
