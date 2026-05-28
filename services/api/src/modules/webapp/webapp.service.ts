/**
 * Web App Metadata Sync Service
 *
 * Implements the 4-stage metadata pipeline for Web App projects.
 * Mirrors the Salesforce pipeline in salesforce.service.ts / salesforce.normalizer.ts
 * / salesforce.domain-builder.ts / salesforce.embeddings.ts.
 *
 * Architecture (same tables, different extraction mechanism):
 *
 *   Stage 1 — crawlAndStoreRaw()        → metadata_raw_store  (metadata_type='webpage')
 *   Stage 2 — normalizeWebappMetadata() → metadata_normalized (entity_type='webapp_crawl')
 *   Stage 3 — buildWebappDomainModels() → domain_models
 *   Stage 4 — generateEmbeddings()      → vector_embeddings   ← REUSED from salesforce.embeddings.ts
 *
 * Entry point for the API route:
 *   syncWebappMetadata(projectId) → enqueues MetadataSyncJob{category:'web_app'}
 *
 * This module is the ONLY place that should be imported for Web App metadata ops.
 * The metadata-sync.worker.ts imports each stage individually and calls them after
 * detecting category='web_app'.
 */

import prisma from '../../shared/db/prisma.js'
import { fernetDecrypt } from '../../shared/encryption/fernet.js'
import { createModuleLogger } from '../../shared/logger/index.js'
import { WebMetadataService } from './webapp-crawler.js'
import type { PageMetadata, ElementInfo } from './webapp-crawler.js'
import type { CrawlState } from '../../shared/queue/job-types.js'

const log = createModuleLogger('webapp-service')

// ─── Field-type test mapping (mirrors salesforce.domain-builder.ts) ───────────

const INPUT_TYPE_TEST_MAPPING: Record<string, string> = {
  text:     'text_input_test',
  email:    'email_validation_test',
  password: 'password_input_test',
  tel:      'phone_format_test',
  url:      'url_validation_test',
  number:   'numeric_input_test',
  date:     'date_picker_test',
  checkbox: 'checkbox_test',
  radio:    'radio_button_test',
  textarea: 'text_area_test',
  textbox:  'text_input_test',
}

// ─── Dynamic Route Discovery Helpers ──────────────────────────────────────────

/**
 * Extract candidate route paths from BRD text by identifying module names.
 * Looks for patterns like:
 *   - "4.5 Enquiries Module" → /enquiries
 *   - "FR-ENQ-01: Create Enquiry" → /enquiries
 *   - "Quotations Module" → /quotations
 *   - "Bookings Module" → /bookings
 *
 * Returns deduplicated paths with list + create + new variants.
 */
function extractRoutesFromBrd(brdText: string): string[] {
  const routes: string[] = []

  // Pattern 1: "X.Y ModuleName Module" section headings
  const moduleRegex = /\d+\.\d+\s+(\w[\w\s]*?)\s+Module/gi
  let match: RegExpExecArray | null
  while ((match = moduleRegex.exec(brdText)) !== null) {
    const moduleName = match[1].trim().toLowerCase().replace(/\s+/g, '-')
    if (moduleName.length >= 3 && moduleName.length <= 30) {
      routes.push(`/${moduleName}`)
      routes.push(`/${moduleName}/create`)
      routes.push(`/${moduleName}/new`)
    }
  }

  // Pattern 2: "FR-XXX-NN: Action EntityName" functional requirements
  const frRegex = /FR-([A-Z]{2,5})-\d+:\s*(?:Create|Update|List|View|Manage|Search)\s+(\w[\w\s]*?)(?:\s|$)/gi
  while ((match = frRegex.exec(brdText)) !== null) {
    const entityName = match[2].trim().toLowerCase().replace(/\s+/g, '-')
    if (entityName.length >= 3 && entityName.length <= 30) {
      // Pluralize if not already plural
      const pluralized = entityName.endsWith('y')
        ? entityName.slice(0, -1) + 'ies'  // Enquiry → enquiries
        : entityName.endsWith('s')
          ? entityName
          : entityName + 's'
      routes.push(`/${pluralized}`)
      routes.push(`/${pluralized}/create`)
      routes.push(`/${pluralized}/new`)
    }
  }

  // Pattern 3: Explicit section headers like "Enquiries", "Quotations", "Bookings"
  const headerRegex = /(?:^|\n)\s*(?:\d+\.?\d*\s+)?(\w+(?:\s\w+)?)\s*(?:Module|Section|Management)\b/gi
  while ((match = headerRegex.exec(brdText)) !== null) {
    const name = match[1].trim().toLowerCase().replace(/\s+/g, '-')
    if (name.length >= 3 && name.length <= 30) {
      routes.push(`/${name}`)
      routes.push(`/${name}/create`)
    }
  }

  return [...new Set(routes)]
}

/**
 * Extract candidate route paths from button labels on previously crawled pages.
 * STRICT mode: only accepts buttons that look like SPA sidebar navigation items.
 * A nav item must have a two-line format: "Label\nDescription" where the description
 * contains a navigation verb (manage, view, create, track etc.).
 *
 * Example match: "Enquiries\n\nManage freight enquiries" → /enquiries
 * Example reject: "Add Item", "Create Opportunity", "AGS2", "ENQ-0002", "Back to List"
 */
function extractRoutesFromCrawledButtons(
  pages: Array<{ buttons?: Array<{ name?: string }> }>,
): string[] {
  const NAV_DESCRIPTION_KEYWORDS = [
    'manage', 'view', 'create', 'track', 'handle', 'monitor',
    'browse', 'list', 'access', 'process', 'submit',
  ]

  const routes: string[] = []

  for (const page of pages) {
    for (const btn of (page.buttons ?? [])) {
      const rawName = (btn.name ?? '').trim()
      if (!rawName) continue

      const lines = rawName.split('\n').map(l => l.trim()).filter(Boolean)

      // STRICT: require at least 2 lines — nav items always have label + description
      if (lines.length < 2) continue

      const firstLine = lines[0]
      const description = lines.slice(1).join(' ').toLowerCase()

      // Description must contain a navigation verb
      const hasNavDescription = NAV_DESCRIPTION_KEYWORDS.some(k => description.includes(k))
      if (!hasNavDescription) continue

      // Module name constraints: 3-25 chars, no digits, max 3 words
      if (firstLine.length < 3 || firstLine.length > 25) continue
      if (/\d/.test(firstLine)) continue // reject AGS2, DTA1, ENQ-0002 etc.
      if (/^[A-Z]{2,5}[-\s]?\d/.test(firstLine)) continue
      if (firstLine.split(/\s+/).length > 3) continue

      const slug = firstLine
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')

      if (slug && slug.length >= 3 && slug.length <= 25) {
        routes.push(`/${slug}`)
      }
    }
  }

  return [...new Set(routes)]
}

// ═══════════════════════════════════════════════════════════════════
// Stage 1 — Playwright Crawl → metadata_raw_store
// ═══════════════════════════════════════════════════════════════════

/**
 * Result returned by crawlAndStoreRaw() — consumed by the BullMQ worker
 * to decide whether to re-enqueue a continuation job.
 */
export interface CrawlRunResult {
  /** Pages crawled in THIS run only */
  pagesCrawledThisRun: number
  /** Cumulative visited URL count (all runs so far) */
  totalCrawledSoFar: number
  /** Total unique pages discovered (visited + pending) */
  totalDiscoveredPages: number
  /** True if pendingUrls is still non-empty after this run */
  hasMorePages: boolean
  /** How many URLs remain in the pending queue */
  pendingCount: number
  /** Human-readable message for the UI */
  progressMessage: string
}

/**
 * Incremental Playwright crawl — stores raw DOM metadata.
 * Fetches base_url + credentials + crawl state from project_integrations.
 *
 * On first call: seeds the URL queue from sitemap + base URL.
 * On continuation calls: restores visitedUrls / pendingUrls from auth_config.crawl_state.
 * Returns CrawlRunResult so the worker knows whether to re-enqueue.
 */
export async function crawlAndStoreRaw(projectId: string, isContinuation = false): Promise<CrawlRunResult> {
  log.info(`[WEB-SYNC] Stage 1: Playwright crawl started for project ${projectId} (continuation=${isContinuation})`)

  // ── Fetch integration config ───────────────────────────────────────────────
  const integration = await prisma.project_integrations.findFirst({
    where: { project_id: projectId, category: 'web_app' },
  })

  if (!integration) {
    throw new Error(`No web_app integration found for project ${projectId}`)
  }
  if (!integration.base_url) {
    throw new Error(`web_app integration for project ${projectId} has no base_url configured`)
  }

  // ── Decrypt credentials if available ──────────────────────────────────────
  let credentials: { username: string; password: string } | undefined
  if (integration.username && integration.password) {
    try {
      credentials = {
        username: fernetDecrypt(integration.username),
        password: fernetDecrypt(integration.password),
      }
    } catch (err) {
      log.warn({ err }, '[WEB-SYNC] Failed to decrypt credentials — crawling without auth')
    }
  }

  // ── Parse Auth Config Options ───────────────────────────────────────────
  let sitemapUrl: string | undefined
  let perRunLimit: number | undefined
  let keyRoutes: string[] | undefined
  let enableDeepCrawl: boolean | undefined
  let initialState: CrawlState | undefined

  if (integration.auth_config && typeof integration.auth_config === 'object') {
    const conf = integration.auth_config as Record<string, any>
    sitemapUrl    = conf.sitemap_url
    perRunLimit   = conf.max_crawl_pages ?? 50
    keyRoutes     = conf.key_routes
    enableDeepCrawl = conf.enable_deep_crawl

    // Restore persisted crawl state for continuation runs
    if (isContinuation && conf.crawl_state) {
      initialState = conf.crawl_state as CrawlState
      log.info(
        `[WEB-SYNC] Restoring crawl state: ` +
        `${initialState.visitedUrls.length} visited, ` +
        `${initialState.pendingUrls.length} pending, ` +
        `run #${initialState.runCount}`
      )
    }
  }

  // ── Inject default key routes + dynamic BRD / button-derived routes ────────
  // Base set: generic CRM form routes (good default for most web apps).
  // We augment these with routes derived from the project's BRD content and
  // any navigation buttons discovered on previously crawled pages.
  const DEFAULT_CRM_KEY_ROUTES = [
    '/accounts/create', '/accounts/new',
    '/contacts/create', '/contacts/new',
    '/leads/create',    '/leads/new',
    '/opportunities/create', '/opportunities/new',
    '/campaigns/create',
    '/contracts/create',
    '/orders/create',
    '/invoices/create',
    '/quotes/create',
    '/products/create',
    '/accounts', '/contacts', '/leads', '/opportunities',
  ]
  if (!keyRoutes || keyRoutes.length === 0) {
    keyRoutes = [...DEFAULT_CRM_KEY_ROUTES]
    log.info('[WEB-SYNC] No key routes configured — injecting default CRM form routes')
  }

  // ── BRD-aware route extraction ─────────────────────────────────────────────
  // Parse the project's BRD for module names and derive candidate routes.
  // E.g., "4.5 Enquiries Module" → /enquiries, /enquiries/create, /enquiries/new
  try {
    const projectRow = await prisma.projects.findUnique({
      where: { id: projectId },
      select: { brd_content: true },
    })
    const brdText = projectRow?.brd_content ?? ''
    if (brdText.length > 50) {
      const brdRoutes = extractRoutesFromBrd(brdText)
      if (brdRoutes.length > 0) {
        const before = keyRoutes.length
        for (const r of brdRoutes) {
          if (!keyRoutes.includes(r)) keyRoutes.push(r)
        }
        log.info(`[WEB-SYNC] BRD-derived routes: added ${keyRoutes.length - before} new routes from BRD content`)
      }
    }
  } catch (brdErr) {
    log.warn({ err: brdErr }, '[WEB-SYNC] BRD route extraction failed — continuing without')
  }

  // ── Button-derived route extraction from previously crawled pages ──────────
  // On continuation or re-sync runs, inspect buttons from already-crawled pages
  // to discover navigation targets the default routes might miss.
  try {
    const existingRaw = await prisma.metadata_raw_store.findFirst({
      where: { project_id: projectId, metadata_type: 'webpage' },
      select: { raw_json: true },
    })
    const existingPages = ((existingRaw?.raw_json as any)?.pages ?? []) as Array<{
      buttons?: Array<{ name?: string }>
    }>
    if (existingPages.length > 0) {
      const buttonRoutes = extractRoutesFromCrawledButtons(existingPages)
      if (buttonRoutes.length > 0) {
        const before = keyRoutes.length
        for (const r of buttonRoutes) {
          if (!keyRoutes.includes(r)) keyRoutes.push(r)
        }
        log.info(`[WEB-SYNC] Button-derived routes: added ${keyRoutes.length - before} new routes from crawled page buttons`)
      }
    }
  } catch (btnErr) {
    log.warn({ err: btnErr }, '[WEB-SYNC] Button route extraction failed — continuing without')
  }

  // ── Run the incremental WebMetadataService crawler ─────────────────────────
  const crawlResult = await WebMetadataService.crawl(integration.base_url, {
    perRunLimit: perRunLimit ?? 50,
    credentials,
    sitemapUrl,
    keyRoutes,
    enableDeepCrawl,
    initialState, // undefined on first run
  })

  // ── Persist updated crawl state back to auth_config ────────────────────────
  const existingConf = (integration.auth_config as Record<string, any>) ?? {}
  const updatedConf = {
    ...existingConf,
    crawl_state: crawlResult.hasMorePages ? crawlResult.crawlState : null, // clear when done
  }

  await prisma.project_integrations.update({
    where: { id: integration.id },
    data:  { auth_config: updatedConf as object },
  })

  log.info(
    `[WEB-SYNC] Saved crawl state: ` +
    `visited=${crawlResult.crawlState.visitedUrls.length}, ` +
    `pending=${crawlResult.crawlState.pendingUrls.length}, ` +
    `hasMore=${crawlResult.hasMorePages}`
  )

  // ── Upsert raw result into metadata_raw_store ───────────────────────────────
  const existing = await prisma.metadata_raw_store.findFirst({
    where: { project_id: projectId, metadata_type: 'webpage' },
  })

  if (existing && isContinuation) {
    // Append-mode: merge new pages with previously crawled pages
    const previousData = (existing.raw_json ?? {}) as { base_url?: string; pages?: PageMetadata[] }
    const previousPages = previousData.pages ?? []
    const newPages = crawlResult.pages

    // De-duplicate by URL
    const existingUrls = new Set(previousPages.map((p: PageMetadata) => p.url))
    const dedupedNew = newPages.filter((p) => !existingUrls.has(p.url))

    const mergedData = {
      base_url: crawlResult.base_url,
      pages:    [...previousPages, ...dedupedNew],
      stats:    crawlResult.stats,
    }

    await prisma.metadata_raw_store.update({
      where: { id: existing.id },
      data:  { raw_json: mergedData as object },
    })

    log.info(
      `[WEB-SYNC] Appended ${dedupedNew.length} new pages ` +
      `(total: ${mergedData.pages.length}) for project ${projectId}`
    )
  } else if (existing) {
    // First run — full replace
    await prisma.metadata_raw_store.update({
      where: { id: existing.id },
      data:  { raw_json: {
        base_url: crawlResult.base_url,
        pages:    crawlResult.pages,
        stats:    crawlResult.stats,
      } as object },
    })
  } else {
    await prisma.metadata_raw_store.create({
      data: {
        project_id:    projectId,
        metadata_type: 'webpage',
        api_name:      integration.base_url,
        raw_json:      {
          base_url: crawlResult.base_url,
          pages:    crawlResult.pages,
          stats:    crawlResult.stats,
        } as object,
      },
    })
  }

  const totalCrawledSoFar = crawlResult.crawlState.visitedUrls.length

  log.info(
    `[WEB-SYNC] Stage 1 done — ` +
    `${crawlResult.pages.length} pages this run, ` +
    `${totalCrawledSoFar} total visited, ` +
    `${crawlResult.crawlState.pendingUrls.length} pending. ` +
    `${crawlResult.progressMessage}`
  )

  return {
    pagesCrawledThisRun:   crawlResult.pages.length,
    totalCrawledSoFar,
    totalDiscoveredPages:  crawlResult.crawlState.totalDiscoveredPages,
    hasMorePages:          crawlResult.hasMorePages,
    pendingCount:          crawlResult.crawlState.pendingUrls.length,
    progressMessage:       crawlResult.progressMessage,
  }
}

// ═══════════════════════════════════════════════════════════════════
// Stage 2 — Normalize → metadata_normalized (entity_type='webapp_crawl')
// ═══════════════════════════════════════════════════════════════════

/**
 * Normalize raw web app crawl data into the metadata_normalized table.
 * The structured_json shape matches what salesforce.embeddings.ts expects
 * for entity_type='webapp_crawl': { base_url, pages: [...] }
 *
 * Returns count of normalized records created.
 */
export async function normalizeWebappMetadata(projectId: string): Promise<number> {
  log.info(`[WEB-SYNC] Stage 2: Normalization started for project ${projectId}`)

  // Clear existing webapp normalized rows (full rebuild)
  await prisma.metadata_normalized.deleteMany({
    where: { project_id: projectId, entity_type: 'webapp_crawl' },
  })

  const rawRecords = await prisma.metadata_raw_store.findMany({
    where: { project_id: projectId, metadata_type: 'webpage' },
  })

  let count = 0

  for (const raw of rawRecords) {
    const data = (raw.raw_json ?? {}) as { base_url?: string; pages?: PageMetadata[] }
    const baseUrl = data.base_url ?? raw.api_name
    const pages   = data.pages ?? []

    // Normalize page elements to compact, consistent shape
    // Skip 404/error pages — these are bad key routes that don't exist in the app
    const validPages = pages.filter((pm: PageMetadata) => {
      const title = (pm.title ?? '').toLowerCase()
      return !title.includes('404') &&
             !title.includes('not found') &&
             !title.includes('could not be found') &&
             !title.includes('page not found') &&
             !title.includes('error')
    })

    const normalizedPages = validPages.map((pm: PageMetadata) => ({
      url:      pm.url,
      path:     pm.path,
      title:    pm.title,
      headings: pm.headings,
      buttons:  pm.buttons.map((b: ElementInfo) => ({
        name:         b.name,
        locator_type: b.locator_type,
        locator:      b.locator,
      })),
      links: pm.links.map((l: ElementInfo) => ({
        name:         l.name,
        locator_type: l.locator_type,
        locator:      l.locator,
      })),
      inputs: pm.inputs.map((i: ElementInfo) => ({
        name:         i.name,
        tag:          i.tag,
        locator_type: i.locator_type,
        locator:      i.locator,
        required:     i.required,
      })),
      selects: pm.selects.map((s: ElementInfo) => ({
        name:         s.name,
        locator_type: s.locator_type,
        locator:      s.locator,
        required:     s.required,
        // Persist valid option labels so the LLM can see real pick values during test generation
        options:      s.options ?? [],
      })),
      testids: pm.testids,
    }))

    const structured = { base_url: baseUrl, pages: normalizedPages }

    await prisma.metadata_normalized.create({
      data: {
        project_id:      projectId,
        object_name:     baseUrl,
        entity_type:     'webapp_crawl',
        label:           `${baseUrl} — ${validPages.length} page(s) crawled`,
        structured_json: structured as object,
      },
    })
    count++
  }

  log.info(`[WEB-SYNC] Stage 2 done — ${count} normalized records for project ${projectId}`)
  return count
}

// ═══════════════════════════════════════════════════════════════════
// Stage 3 — Domain Model Build → domain_models
// ═══════════════════════════════════════════════════════════════════

interface TestingRule { [key: string]: unknown }

/**
 * Build testing-oriented domain models from normalized web app metadata.
 * Each page produces actions + testing_rules derived from:
 *   - Required inputs  → mandatory_field_test
 *   - Optional inputs  → text_input_test (and type-specific variants)
 *   - Buttons          → click_button_test + navigation assertions
 *   - Selects          → dropdown_selection_test
 *
 * Returns count of domain models created.
 */
export async function buildWebappDomainModels(projectId: string): Promise<number> {
  log.info(`[WEB-SYNC] Stage 3: Domain model build started for project ${projectId}`)

  // Clear existing webapp domain models (full rebuild)
  const existingDomainIds = await prisma.metadata_normalized
    .findMany({ where: { project_id: projectId, entity_type: 'webapp_crawl' }, select: { object_name: true } })
    .then((rows) => rows.map((r) => r.object_name))

  if (existingDomainIds.length > 0) {
    await prisma.domain_models.deleteMany({
      where: {
        project_id:  projectId,
        entity_name: { in: existingDomainIds },
      },
    })
  }

  const normalizedRows = await prisma.metadata_normalized.findMany({
    where: { project_id: projectId, entity_type: 'webapp_crawl' },
  })

  let count = 0

  for (const record of normalizedRows) {
    const data    = (record.structured_json ?? {}) as { base_url?: string; pages?: Record<string, unknown>[] }
    const pages   = (Array.isArray(data.pages) ? data.pages : []) as Record<string, unknown>[]
    const baseUrl = String(data.base_url ?? record.object_name)

    // Build per-page domain models — deduplicate by path first
    // The crawler may have multiple entries for the same path (e.g., 23 /leads)
    // due to incremental crawl merges. Keep only the entry with the most
    // interactive elements (inputs + buttons + selects) per unique path.
    const pagesByPath = new Map<string, Record<string, unknown>>()
    for (const page of pages) {
      const path = String(page['path'] ?? '/')

      // Skip /login pages — session is pre-managed, not a testable flow
      if (path === '/login' || path.endsWith('/login')) continue

      const existing = pagesByPath.get(path)
      if (!existing) {
        pagesByPath.set(path, page)
      } else {
        // Keep the page with more interactive elements
        const existingCount =
          (Array.isArray(existing['inputs']) ? existing['inputs'].length : 0) +
          (Array.isArray(existing['buttons']) ? existing['buttons'].length : 0) +
          (Array.isArray(existing['selects']) ? existing['selects'].length : 0)
        const newCount =
          (Array.isArray(page['inputs']) ? (page['inputs'] as unknown[]).length : 0) +
          (Array.isArray(page['buttons']) ? (page['buttons'] as unknown[]).length : 0) +
          (Array.isArray(page['selects']) ? (page['selects'] as unknown[]).length : 0)
        if (newCount > existingCount) {
          pagesByPath.set(path, page)
        }
      }
    }

    log.info(
      `[WEB-SYNC] Domain build: ${pages.length} raw pages → ${pagesByPath.size} unique paths (deduplicated)`
    )

    for (const [, page] of pagesByPath) {
      const path    = String(page['path'] ?? '/')
      const inputs  = (Array.isArray(page['inputs'])  ? page['inputs']  : []) as Record<string, unknown>[]
      const buttons = (Array.isArray(page['buttons']) ? page['buttons'] : []) as Record<string, unknown>[]
      const selects = (Array.isArray(page['selects']) ? page['selects'] : []) as Record<string, unknown>[]

      const actions: string[] = ['navigate', 'verify_page_loaded']
      const testingRules: TestingRule[] = [
        {
          type:        'page_load_test',
          path,
          description: `Verify page '${path}' loads successfully`,
        },
      ]

      // Required fields → mandatory_field_test
      for (const inp of inputs) {
        if (inp['required']) {
          actions.push('fill_required_field')
          testingRules.push({
            type:        'mandatory_field_test',
            field:       String(inp['name'] ?? inp['locator'] ?? ''),
            locator:     String(inp['locator'] ?? ''),
            locator_type: String(inp['locator_type'] ?? 'label'),
            description: `Verify '${String(inp['name'] ?? '')}' is required and cannot be left empty`,
          })
        }

        // Type-specific test rule
        const tag = String(inp['tag'] ?? 'input').toLowerCase()
        const testType = INPUT_TYPE_TEST_MAPPING[tag] ?? INPUT_TYPE_TEST_MAPPING['text']
        testingRules.push({
          type:        testType,
          field:       String(inp['name'] ?? inp['locator'] ?? ''),
          locator:     String(inp['locator'] ?? ''),
          locator_type: String(inp['locator_type'] ?? 'label'),
          required:    Boolean(inp['required']),
          description: `Verify '${String(inp['name'] ?? '')}' accepts valid ${tag} input`,
        })
      }

      // Selects → dropdown_selection_test
      for (const sel of selects) {
        actions.push('select_dropdown_option')
        testingRules.push({
          type:        'dropdown_selection_test',
          field:       String(sel['name'] ?? sel['locator'] ?? ''),
          locator:     String(sel['locator'] ?? ''),
          locator_type: String(sel['locator_type'] ?? 'label'),
          required:    Boolean(sel['required']),
          description: `Verify '${String(sel['name'] ?? '')}' dropdown accepts a valid selection`,
        })
      }

      // Buttons → click_button_test
      for (const btn of buttons.slice(0, 10)) {
        const btnName = String(btn['name'] ?? btn['locator'] ?? '')
        if (!btnName) continue
        const btnNameLower = btnName.toLowerCase()
        if (btnNameLower.includes('submit') || btnNameLower.includes('save') || btnNameLower.includes('create')) {
          actions.push('submit_form')
          testingRules.push({
            type:        'form_submission_test',
            button:      btnName,
            locator:     String(btn['locator'] ?? ''),
            description: `Verify form submits correctly via '${btnName}'`,
          })
        } else {
          actions.push('click_button')
          testingRules.push({
            type:        'button_click_test',
            button:      btnName,
            locator:     String(btn['locator'] ?? ''),
            description: `Verify button '${btnName}' responds to click interaction`,
          })
        }
      }

      // If any form inputs exist, add a full form fill + submit test rule
      if (inputs.length > 0) {
        actions.push('fill_form')
        testingRules.push({
          type:           'form_fill_test',
          path,
          required_count: inputs.filter((i) => i['required']).length,
          total_inputs:   inputs.length,
          description:    `Fill all required fields on '${path}' and submit the form`,
        })
      }

      const entityName = `${baseUrl}${path}`

      await prisma.domain_models.create({
        data: {
          project_id:    projectId,
          entity_name:   entityName,
          actions:       [...new Set(actions)] as object,  // deduplicate
          testing_rules: testingRules as object,
        },
      })
      count++
    }

    // If no per-page models were created, create a top-level model
    if (pages.length === 0) {
      await prisma.domain_models.create({
        data: {
          project_id:    projectId,
          entity_name:   baseUrl,
          actions:       ['navigate', 'verify_page_loaded'] as object,
          testing_rules: [{ type: 'page_load_test', description: `Verify ${baseUrl} loads` }] as object,
        },
      })
      count++
    }
  }

  log.info(`[WEB-SYNC] Stage 3 done — ${count} domain models for project ${projectId}`)
  return count
}

// ═══════════════════════════════════════════════════════════════════
// Public entry point — enqueue sync job (mirrors salesforce.service.ts syncMetadata)
// ═══════════════════════════════════════════════════════════════════

export interface WebAppSyncResult {
  status: 'queued' | 'completed'
  message: string
  raw_count: number
  normalized_count: number
  domain_model_count: number
  embedding_count: number
}

/**
 * Force-run Stages 2-4 (Normalize → Domain Models → Embeddings) on already-crawled
 * raw data WITHOUT re-crawling. Use this to unblock a stuck pipeline where raw pages
 * exist but downstream stages never ran (e.g. crawl state stuck with hasMorePages=true).
 *
 * Clears the stale crawl_state from auth_config so the next sync starts fresh.
 */
export async function forceNormalizeWebapp(projectId: string): Promise<WebAppSyncResult> {
  log.info(`[WEB-SYNC] Force-normalize started for project ${projectId} (skipping Stage 1)`)

  // ── Verify raw data exists ────────────────────────────────────────────────
  const rawRow = await prisma.metadata_raw_store.findFirst({
    where: { project_id: projectId, metadata_type: 'webpage' },
    select: { raw_json: true },
  })
  const pagesInDb = (rawRow?.raw_json as { pages?: unknown[] })?.pages?.length ?? 0
  if (pagesInDb === 0) {
    throw { statusCode: 400, message: 'No crawled pages found — run Sync Metadata first to crawl the site.' }
  }

  // ── Clear stale crawl_state so next sync starts fresh ────────────────────
  const integration = await prisma.project_integrations.findFirst({
    where: { project_id: projectId, category: 'web_app' },
  })
  if (integration) {
    const existingCfg = (integration.auth_config as Record<string, any>) ?? {}
    await prisma.project_integrations.update({
      where: { id: integration.id },
      data:  { auth_config: { ...existingCfg, crawl_state: null } as object },
    })
  }

  try {
    const { metadataSyncQueue } = await import('../../workers/metadata-sync.worker.js')
    // Enqueue a special job that runs only stages 2-4
    await metadataSyncQueue.add(
      'force-normalize',
      {
        projectId,
        triggeredBy:     'manual',
        category:        'web_app',
        isContinuation:  false,
        skipCrawl:       true,      // flag handled by worker
        continuationRun: 999,       // large number → triggers force-complete immediately
      } as any,
      {
        attempts:         2,
        backoff:          { type: 'fixed', delay: 3000 },
        removeOnComplete: { count: 10 },
        removeOnFail:     { count: 20 },
      },
    )
  } catch (queueErr: unknown) {
    // Queue unavailable — run stages 2-4 inline
    log.warn({ err: queueErr }, '[WEB-SYNC] Queue unavailable — running stages 2-4 inline')
    try {
      const { generateEmbeddings } = await import('../salesforce/salesforce.embeddings.js')

      const normalizedCount = await normalizeWebappMetadata(projectId)
      const domainCount     = await buildWebappDomainModels(projectId)

      // Stage 3.5: Canonical + Knowledge Graph build (non-critical)
      if (process.env.ENABLE_CANONICAL_METADATA !== 'false') {
        try {
          const { buildCanonicalMetadata } = await import('./canonical-builder.service.js')
          await buildCanonicalMetadata(projectId)
        } catch (canErr) {
          log.warn({ err: canErr }, '[WEB-SYNC] Canonical + KG build failed (non-critical)')
        }
      }

      const embeddingCount  = await generateEmbeddings(projectId)

      await prisma.project_integrations.updateMany({
        where: { project_id: projectId },
        data:  { last_synced_at: new Date(), sync_error: null },
      })

      return {
        status:             'completed',
        message:            `Force-normalize complete — ${pagesInDb} pages processed inline`,
        raw_count:          pagesInDb,
        normalized_count:   normalizedCount,
        domain_model_count: domainCount,
        embedding_count:    embeddingCount,
      }
    } catch (inlineErr: unknown) {
      const msg = inlineErr instanceof Error ? inlineErr.message : String(inlineErr)
      throw { statusCode: 500, message: `Force-normalize failed: ${msg}` }
    }
  }

  const [raw, normalized, domain, embeddings] = await Promise.all([
    prisma.metadata_raw_store.count({ where: { project_id: projectId } }),
    prisma.metadata_normalized.count({ where: { project_id: projectId } }),
    prisma.domain_models.count({ where: { project_id: projectId } }),
    prisma.vector_embeddings.count({ where: { project_id: projectId } }),
  ])

  return {
    status:             'queued',
    message:            `Force-normalize queued — processing ${pagesInDb} already-crawled pages (Stages 2-4)`,
    raw_count:          pagesInDb,
    normalized_count:   normalized,
    domain_model_count: domain,
    embedding_count:    embeddings,
  }
}

/**
 * Enqueue a Web App metadata sync job on the metadata-sync-queue.
 * Smart detection: if pages are already crawled but downstream stages are stuck
 * (normalized=0 and pages>0), automatically redirects to forceNormalizeWebapp().
 * Returns immediately with status='queued'.
 * Falls back to inline synchronous run if Redis / BullMQ is unavailable.
 */
export async function syncWebappMetadata(projectId: string): Promise<WebAppSyncResult> {
  log.info(`[WEB-SYNC] Sync queued for project ${projectId}`)

  // ── Smart detection: stale stuck crawl state ──────────────────────────────
  // If pages are already crawled but Normalize/Domain/Embed stages are at 0,
  // this means the crawl never "completed" (hasMorePages was stuck). Instead
  // of re-crawling from scratch, run forceNormalize to unblock the pipeline.
  try {
    const rawRow = await prisma.metadata_raw_store.findFirst({
      where: { project_id: projectId, metadata_type: 'webpage' },
      select: { raw_json: true },
    })
    const pagesInDb = (rawRow?.raw_json as { pages?: unknown[] })?.pages?.length ?? 0
    const normalizedCount = await prisma.metadata_normalized.count({ where: { project_id: projectId } })

    if (pagesInDb >= 5 && normalizedCount === 0) {
      log.warn(
        `[WEB-SYNC] Detected stuck pipeline for project ${projectId}: ` +
        `${pagesInDb} pages crawled but normalized=0. Redirecting to force-normalize.`
      )
      return forceNormalizeWebapp(projectId)
    }
  } catch (detectErr) {
    log.warn({ err: detectErr }, '[WEB-SYNC] Stuck-crawl detection failed — proceeding with normal sync')
  }

  try {
    const { metadataSyncQueue } = await import('../../workers/metadata-sync.worker.js')

    await metadataSyncQueue.add(
      'sync',
      { projectId, triggeredBy: 'manual', category: 'web_app' },
      {
        attempts: 2,
        backoff: { type: 'fixed', delay: 5000 },
        removeOnComplete: { count: 10 },
        removeOnFail:     { count: 20 },
      },
    )
  } catch (queueErr: unknown) {
    // If Redis / BullMQ unavailable, run inline
    log.warn({ err: queueErr }, '[WEB-SYNC] Queue unavailable — running pipeline inline')
    try {
      const { generateEmbeddings } = await import('../salesforce/salesforce.embeddings.js')

      const crawlResult     = await crawlAndStoreRaw(projectId, false)
      const rawCount        = crawlResult.totalCrawledSoFar
      const normalizedCount = await normalizeWebappMetadata(projectId)
      const domainCount     = await buildWebappDomainModels(projectId)

      // Stage 3.5: Canonical + Knowledge Graph build (non-critical)
      if (process.env.ENABLE_CANONICAL_METADATA !== 'false') {
        try {
          const { buildCanonicalMetadata } = await import('./canonical-builder.service.js')
          await buildCanonicalMetadata(projectId)
        } catch (canErr) {
          log.warn({ err: canErr }, '[WEB-SYNC] Canonical + KG build failed (non-critical)')
        }
      }

      const embeddingCount  = await generateEmbeddings(projectId)

      await prisma.project_integrations.updateMany({
        where: { project_id: projectId },
        data:  { last_synced_at: new Date(), sync_error: null },
      })

      return {
        status:             'completed',
        message:            'Web app metadata sync completed (inline fallback)',
        raw_count:          rawCount,
        normalized_count:   normalizedCount,
        domain_model_count: domainCount,
        embedding_count:    embeddingCount,
      }
    } catch (inlineErr: unknown) {
      const msg = inlineErr instanceof Error ? inlineErr.message : String(inlineErr)
      throw { statusCode: 500, message: `Web app metadata sync failed: ${msg}` }
    }
  }

  // Return current DB counts (worker updates them asynchronously)
  const [raw, normalized, domain, embeddings] = await Promise.all([
    prisma.metadata_raw_store.count({ where: { project_id: projectId } }),
    prisma.metadata_normalized.count({ where: { project_id: projectId } }),
    prisma.domain_models.count({ where: { project_id: projectId } }),
    prisma.vector_embeddings.count({ where: { project_id: projectId } }),
  ])

  return {
    status:             'queued',
    message:            'Web app metadata sync queued — Playwright crawl running in background',
    raw_count:          raw,
    normalized_count:   normalized,
    domain_model_count: domain,
    embedding_count:    embeddings,
  }
}
