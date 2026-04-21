/**
 * Metadata Sync Worker — BullMQ Consumer
 *
 * Port of Python: backend/app/services/metadata_sync_worker.py
 *
 * Consumes jobs from `metadata-sync-queue` and runs the correct metadata
 * pipeline based on the project's integration category:
 *
 *   Salesforce pipeline (existing — unchanged):
 *     Stage 1 — Extract raw metadata via JSforce  (salesforce.service.ts)
 *     Stage 2 — Normalize                         (salesforce.normalizer.ts)
 *     Stage 3 — Build domain models               (salesforce.domain-builder.ts)
 *     Stage 4 — Generate OpenAI embeddings        (salesforce.embeddings.ts)
 *
 *   Web App pipeline (new):
 *     Stage 1 — Playwright DOM crawl              (webapp.service.ts → webapp-crawler.ts)
 *     Stage 2 — Normalize                         (webapp.service.ts)
 *     Stage 3 — Build domain models               (webapp.service.ts)
 *     Stage 4 — Generate OpenAI embeddings        (salesforce.embeddings.ts) ← shared
 *
 * On completion: updates `project_integrations.last_synced_at` and clears
 * any previous `sync_error`.
 *
 * On failure: writes the error message to `project_integrations.sync_error`.
 *
 * This worker is auto-started inside index.ts so it runs with the API server.
 * Alternatively run standalone: npm run worker:metadata-sync
 */
import 'dotenv/config'
import { Worker, Job, Queue } from 'bullmq'
import { QUEUES }             from '../shared/queue/queues.js'
import { getRedisOptions }    from '../shared/queue/connection.js'
import type { MetadataSyncJob } from '../shared/queue/job-types.js'
import prisma                  from '../shared/db/prisma.js'
import { createModuleLogger }  from '../shared/logger/index.js'

// ── Salesforce pipeline stages ────────────────────────────────────────────────
import { normalizeMetadata } from '../modules/salesforce/salesforce.normalizer.js'
import { buildDomainModels } from '../modules/salesforce/salesforce.domain-builder.js'
import { generateEmbeddings } from '../modules/salesforce/salesforce.embeddings.js'
import { syncMetadataRaw } from '../modules/salesforce/salesforce.service.js'

// ── Web App pipeline stages (new) ─────────────────────────────────────────────
import { crawlAndStoreRaw, normalizeWebappMetadata, buildWebappDomainModels } from '../modules/webapp/webapp.service.js'
import { extractTestData } from '../modules/webapp/webapp-test-data.service.js'

const log = createModuleLogger('metadata-sync-worker')

// ─── Helper: resolve category from DB when not in job payload ────────────────

async function resolveCategory(projectId: string, jobCategory?: string): Promise<'salesforce' | 'web_app'> {
  if (jobCategory === 'web_app') return 'web_app'
  if (jobCategory === 'salesforce') return 'salesforce'

  // Fallback: detect from project_integrations table
  const integration = await prisma.project_integrations.findFirst({
    where: { project_id: projectId },
    select: { category: true },
  })

  const cat = (integration?.category ?? 'salesforce').toLowerCase()
  if (cat === 'web_app' || cat === 'webapp') return 'web_app'
  return 'salesforce'
}

// ─── Pipeline processor ───────────────────────────────────────────────────────

async function processMetadataSync(job: Job<MetadataSyncJob>): Promise<void> {
  const { projectId, triggeredBy, category: jobCategory, isContinuation } = job.data
  log.info(`[SYNC] Starting metadata sync pipeline for project=${projectId} trigger=${triggeredBy} jobCategory=${jobCategory ?? 'auto-detect'} continuation=${!!isContinuation}`)

  // ── Verify integration exists ─────────────────────────────────────────────
  const integration = await prisma.project_integrations.findFirst({
    where: { project_id: projectId },
  })

  if (!integration) {
    throw new Error(`No integration found for project ${projectId}`)
  }

  if (integration.status !== 'connected') {
    throw new Error(`Integration is in '${integration.status}' state — reconnect first`)
  }

  // Determine which pipeline to run
  const category = await resolveCategory(projectId, jobCategory)
  log.info(`[SYNC] Resolved category=${category} for project ${projectId}`)

  // Mark syncing status
  await prisma.project_integrations.update({
    where: { id: integration.id },
    data:  { sync_error: null },
  })

  let rawCount        = 0
  let normalizedCount = 0
  let domainCount     = 0
  let embeddingCount  = 0

  try {
    if (category === 'web_app') {
      // ════════════════════════════════════════════════════════════
      // Web App Pipeline — Incremental Playwright Crawler
      // Stage 1 always runs. Stages 2-4 only run when crawl is complete.
      // ════════════════════════════════════════════════════════════

      // ── Stage 1: Incremental Playwright crawl ──────────────────
      log.info(`[SYNC] Stage 1/4 — Playwright crawl (Web App) [continuation=${!!isContinuation}]`)
      await job.updateProgress(10)

      const crawlRunResult = await crawlAndStoreRaw(projectId, !!isContinuation)
      rawCount = crawlRunResult.totalCrawledSoFar

      log.info(
        `[SYNC] Stage 1 done — ${crawlRunResult.pagesCrawledThisRun} pages this run, ` +
        `${crawlRunResult.totalCrawledSoFar} total, ` +
        `${crawlRunResult.pendingCount} pending. ${crawlRunResult.progressMessage}`
      )

      if (crawlRunResult.hasMorePages) {
        // More pages remain — auto-enqueue a continuation job
        // Stages 2-4 are deferred until the crawl is fully complete.
        log.info(`[SYNC] 🔄 ${crawlRunResult.progressMessage} — auto-enqueueing continuation job`)

        await metadataSyncQueue.add(
          'sync-continuation',
          {
            projectId,
            triggeredBy: 'auto',
            category:    'web_app',
            isContinuation: true,
          },
          {
            attempts:         3,
            backoff:          { type: 'fixed', delay: 3000 },
            removeOnComplete: { count: 10 },
            removeOnFail:     { count: 20 },
          },
        )

        await job.updateProgress(20)
        // Clear sync error; do NOT set last_synced_at yet (crawl not done)
        await prisma.project_integrations.update({
          where: { id: integration.id },
          data:  { sync_error: null },
        })

        log.info(`[SYNC] Continuation job enqueued — returning early (stages 2-4 deferred)`)
        return  // ← exit: stages 2-4 run in the final continuation job
      }

      // Crawl fully complete — run stages 2-4 now
      log.info(`[SYNC] Crawl complete (${rawCount} pages total) — proceeding to stages 2-4`)

      // ── Stage 2: Normalization ─────────────────────────────────
      log.info('[SYNC] Stage 2/4 — Normalization (webapp_crawl)')
      await job.updateProgress(40)
      normalizedCount = await normalizeWebappMetadata(projectId)
      log.info(`[SYNC] Stage 2 done — ${normalizedCount} normalized records`)

      // ── Stage 3: Domain model build ────────────────────────────
      log.info('[SYNC] Stage 3/4 — Domain model build (Web App pages)')
      await job.updateProgress(60)
      domainCount = await buildWebappDomainModels(projectId)
      log.info(`[SYNC] Stage 3 done — ${domainCount} domain models`)

      // ── Stage 4: Embeddings ────────────────────────────────────
      log.info('[SYNC] Stage 4/5 — OpenAI embeddings')
      await job.updateProgress(80)
      embeddingCount = await generateEmbeddings(projectId)
      log.info(`[SYNC] Stage 4 done — ${embeddingCount} embeddings`)

      // ── Stage 5: Test data extraction (Tier 1 — non-fatal) ─────
      log.info('[SYNC] Stage 5/5 — Test data extraction (UI list-page scraping)')
      await job.updateProgress(93)
      try {
        const testDataEntities = await extractTestData(projectId)
        log.info(`[SYNC] Stage 5 done — ${testDataEntities} entities extracted`)
      } catch (tdErr) {
        log.warn({ err: tdErr }, '[SYNC] Stage 5 failed (non-critical) — test data extraction skipped')
      }

    } else {
      // ════════════════════════════════════════════════════════════
      // Salesforce Pipeline (JSforce → normalize → domain → embed) — UNCHANGED
      // ════════════════════════════════════════════════════════════

      // ── Stage 1: Raw extraction ──────────────────────────────────────────────
      log.info('[SYNC] Stage 1/4 — Raw extraction via JSforce')
      await job.updateProgress(10)
      rawCount = await syncMetadataRaw(projectId)
      log.info(`[SYNC] Stage 1 done — ${rawCount} raw records`)

      // ── Stage 2: Normalization ───────────────────────────────────────────────
      log.info('[SYNC] Stage 2/4 — Normalization')
      await job.updateProgress(30)
      normalizedCount = await normalizeMetadata(projectId)
      log.info(`[SYNC] Stage 2 done — ${normalizedCount} normalized records`)

      // ── Stage 3: Domain model build ──────────────────────────────────────────
      log.info('[SYNC] Stage 3/4 — Domain model build')
      await job.updateProgress(55)
      domainCount = await buildDomainModels(projectId)
      log.info(`[SYNC] Stage 3 done — ${domainCount} domain models`)

      // ── Stage 4: Embeddings ──────────────────────────────────────────────────
      log.info('[SYNC] Stage 4/4 — OpenAI embeddings')
      await job.updateProgress(75)
      embeddingCount = await generateEmbeddings(projectId)
      log.info(`[SYNC] Stage 4 done — ${embeddingCount} embeddings`)
    }

    // ── Mark success ─────────────────────────────────────────────────────────
    await job.updateProgress(100)
    await prisma.project_integrations.update({
      where: { id: integration.id },
      data:  {
        last_synced_at: new Date(),
        sync_error:     null,
      },
    })

    log.info(
      `[SYNC] Pipeline complete for project ${projectId} (${category}): ` +
      `raw=${rawCount} normalized=${normalizedCount} domain=${domainCount} embeddings=${embeddingCount}`,
    )

  } catch (pipelineErr: unknown) {
    const msg = pipelineErr instanceof Error ? pipelineErr.message : String(pipelineErr)
    log.error({ err: pipelineErr }, `[SYNC] Pipeline failed for project ${projectId}: ${msg}`)

    // Write error to integration record so the UI can surface it
    await prisma.project_integrations.update({
      where: { id: integration.id },
      data:  { sync_error: msg.slice(0, 500) },
    }).catch(() => { /* non-critical */ })

    throw pipelineErr  // re-throw so BullMQ marks the job as failed + retries
  }
}

// ─── Worker boot ──────────────────────────────────────────────────────────────

const metadataSyncWorker = new Worker<MetadataSyncJob>(
  QUEUES.METADATA_SYNC,
  processMetadataSync,
  {
    ...getRedisOptions(),
    concurrency: 2,    // allow up to 2 projects syncing simultaneously
  },
)

metadataSyncWorker.on('completed', (job) => {
  log.info(`[SYNC] Job ${job.id} completed`)
})

metadataSyncWorker.on('failed', (job, err) => {
  log.error({ err }, `[SYNC] Job ${job?.id} failed: ${err.message}`)
})

metadataSyncWorker.on('error', (err) => {
  log.error({ err }, '[SYNC] Worker error')
})

log.info('🔄 Metadata-sync worker started — 4-stage pipeline active (Salesforce + Web App)')

export default metadataSyncWorker

// ─── Metadata-sync queue (producer side — used by salesforce.service.ts) ─────
// Exported so salesforce.service.ts can enqueue without importing bullmq directly

export const metadataSyncQueue = new Queue<MetadataSyncJob>(
  QUEUES.METADATA_SYNC,
  getRedisOptions(),
)
