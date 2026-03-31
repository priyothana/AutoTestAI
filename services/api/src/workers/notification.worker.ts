/**
 * Notification Worker — BullMQ Consumer
 *
 * Consumes jobs from `notification-queue`.
 * Each job represents a test-lifecycle event (failed, healed, passed).
 *
 * Dispatch chain:
 *   healing.worker.ts → notification-queue → THIS WORKER
 *
 * Channel dispatch (parallel):
 *   - Slack   — if SLACK_WEBHOOK_URL is set
 *   - Jira    — if project has Jira integration configured
 *   - Email   — if SMTP_HOST is set (stub; extend with nodemailer)
 *
 * Cross-module boundary (SKILL.md):
 *   Imports notification.service.ts only — never routes or schema.
 *
 * Start with: npm run worker:notification
 */
import 'dotenv/config'
import { Worker, Job } from 'bullmq'
import { QUEUES }          from '../shared/queue/queues.js'
import { getRedisOptions } from '../shared/queue/connection.js'
import { createModuleLogger } from '../shared/logger/index.js'
import type { NotificationJob } from '../shared/queue/job-types.js'
import { dispatchNotification } from '../modules/notification/notification.service.js'

const log = createModuleLogger('notification-worker')

// ─── Job processor ────────────────────────────────────────────────

async function processNotification(job: Job<NotificationJob>): Promise<void> {
  const { projectId, event, executionId, testRunId } = job.data
  log.info(
    `[NOTIFY] Processing event='${event}' project=${projectId} ` +
    `execution=${executionId} testRun=${testRunId}`,
  )

  const results = await dispatchNotification(job.data)

  for (const r of results) {
    if (r.success) {
      log.info(`[NOTIFY] ✅ ${r.channel} sent successfully`)
    } else {
      // Non-fatal — log and continue. The worker does NOT retry for channel errors
      // because the same retry would re-attempt ALL channels, not just the failed one.
      log.warn(`[NOTIFY] ⚠️  ${r.channel} failed: ${r.error ?? 'unknown error'}`)
    }
  }

  const allFailed = results.every((r) => !r.success)
  if (allFailed && results.length > 0) {
    // Only throw (which triggers BullMQ retry) if ALL channels failed,
    // and at least one channel was attempted.
    throw new Error(`All notification channels failed for execution=${executionId}`)
  }
}

// ─── Worker setup ─────────────────────────────────────────────────

const worker = new Worker<NotificationJob>(
  QUEUES.NOTIFICATION,
  processNotification,
  {
    ...getRedisOptions(),
    concurrency: 5,
    // Retry up to 3×  with exponential backoff (5s, 15s, 45s)
    // Configured on the Queue side, not here — worker honours producer settings.
  },
)

worker.on('completed', (job) =>
  log.info(`[NOTIFY] Job ${job.id} completed (event=${job.data.event})`),
)

worker.on('failed', (job, err) =>
  log.error({ err }, `[NOTIFY] Job ${job?.id} failed (event=${job?.data?.event})`),
)

worker.on('error', (err) => log.error({ err }, '[NOTIFY] Worker error'))

// ─── Graceful shutdown ────────────────────────────────────────────

async function shutdown(signal: string) {
  log.info(`[NOTIFY] Received ${signal} — closing worker...`)
  await worker.close()
  log.info('[NOTIFY] Worker closed')
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

log.info('🔔 Notification worker started — listening on notification-queue')
