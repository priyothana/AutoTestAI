/**
 * Notification Worker — BullMQ Consumer (Stub)
 *
 * Consumes jobs from `notification-queue`.
 * TODO: Implement Jira/Slack/Email dispatch.
 */
import 'dotenv/config'
import { Worker, Job } from 'bullmq'
import { QUEUES } from '../shared/queue/queues.js'
import { getRedisOptions } from '../shared/queue/connection.js'
import { createModuleLogger } from '../shared/logger/index.js'
import type { NotificationJob } from '../shared/queue/job-types.js'

const log = createModuleLogger('notification-worker')

async function processNotification(job: Job<NotificationJob>) {
  const { projectId, event, executionId } = job.data
  log.info(`[NOTIFY] Event '${event}' for project ${projectId}, execution ${executionId}`)

  // TODO: Implement notification dispatch
  // - Jira: create/update issue
  // - Slack: send webhook
  // - Email: send via SMTP
}

const worker = new Worker<NotificationJob>(
  QUEUES.NOTIFICATION,
  processNotification,
  {
    ...getRedisOptions(),
    concurrency: 5,
  },
)

worker.on('completed', (job) => log.info(`[NOTIFY] Job ${job.id} completed`))
worker.on('failed', (job, err) => log.error({ err }, `[NOTIFY] Job ${job?.id} failed`))

log.info('🔔 Notification worker started')
