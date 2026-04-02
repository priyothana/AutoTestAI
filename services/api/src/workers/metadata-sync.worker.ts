/**
 * Metadata Sync Worker — BullMQ Consumer
 *
 * Port of Python: backend/app/services/metadata_sync_worker.py
 *
 * Consumes jobs from `metadata-sync-queue` and runs the full Salesforce
 * metadata pipeline:
 *
 *   Stage 1 — Extract raw metadata via JSforce  (salesforce.service.ts)
 *   Stage 2 — Normalize                         (salesforce.normalizer.ts)
 *   Stage 3 — Build domain models               (salesforce.domain-builder.ts)
 *   Stage 4 — Generate OpenAI embeddings        (salesforce.embeddings.ts)
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

// Stage implementations
import { normalizeMetadata } from '../modules/salesforce/salesforce.normalizer.js'
import { buildDomainModels } from '../modules/salesforce/salesforce.domain-builder.js'
import { generateEmbeddings } from '../modules/salesforce/salesforce.embeddings.js'

// Re-use the JSforce extraction from the existing salesforce service
import { syncMetadataRaw } from '../modules/salesforce/salesforce.service.js'

const log = createModuleLogger('metadata-sync-worker')

// ─── Pipeline processor ───────────────────────────────────────────────────────

async function processMetadataSync(job: Job<MetadataSyncJob>): Promise<void> {
  const { projectId, triggeredBy } = job.data
  log.info(`[SYNC] Starting metadata sync pipeline for project=${projectId} trigger=${triggeredBy}`)

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
      `[SYNC] Pipeline complete for project ${projectId}: ` +
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

log.info('🔄 Metadata-sync worker started — 4-stage pipeline active')

export default metadataSyncWorker

// ─── Metadata-sync queue (producer side — used by salesforce.service.ts) ─────
// Exported so salesforce.service.ts can enqueue without importing bullmq directly

export const metadataSyncQueue = new Queue<MetadataSyncJob>(
  QUEUES.METADATA_SYNC,
  getRedisOptions(),
)
