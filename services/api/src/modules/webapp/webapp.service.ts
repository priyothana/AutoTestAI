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

  // ── Inject default CRM key routes when none configured ────────────────────
  // Most CRM SPAs won't expose create/edit pages via nav links (they use "New" buttons).
  // Without key routes, the crawler only captures the list pages and misses form metadata.
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
    keyRoutes = DEFAULT_CRM_KEY_ROUTES
    log.info('[WEB-SYNC] No key routes configured — injecting default CRM form routes')
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
    const normalizedPages = pages.map((pm: PageMetadata) => ({
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
        label:           `${baseUrl} — ${pages.length} page(s) crawled`,
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

    // Build per-page domain models
    for (const page of pages) {
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
 * Enqueue a Web App metadata sync job on the metadata-sync-queue.
 * Returns immediately with status='queued'.
 * Falls back to inline synchronous run if Redis / BullMQ is unavailable.
 */
export async function syncWebappMetadata(projectId: string): Promise<WebAppSyncResult> {
  log.info(`[WEB-SYNC] Sync queued for project ${projectId}`)

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
