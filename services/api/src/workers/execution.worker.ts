/**
 * Execution Worker — BullMQ Consumer
 *
 * Consumes jobs from `execution-queue`.
 * This is the ONLY place where Playwright runs.
 *
 * Start with: npm run worker:execution
 *
 * TODO: Phase 7 — Port Playwright runner + Salesforce engine
 */
import 'dotenv/config'
import { Worker, Job } from 'bullmq'
import { QUEUES } from '../shared/queue/queues.js'
import { getRedisOptions } from '../shared/queue/connection.js'
import prisma from '../shared/db/prisma.js'
import { createModuleLogger } from '../shared/logger/index.js'
import type { ExecutionJob } from '../shared/queue/job-types.js'

const log = createModuleLogger('execution-worker')

async function processExecution(job: Job<ExecutionJob>) {
  const { testRunId, testCaseId, projectId, context } = job.data
  log.info(`[EXEC] Processing test run ${testRunId} (testCase=${testCaseId}, project=${projectId})`)

  // Update status to running
  await prisma.test_runs.update({
    where: { id: testRunId },
    data: { status: 'running' },
  })

  try {
    // TODO: Implement Playwright execution here
    // 1. Launch browser (chromium.launch)
    // 2. Load session state if useSessionReuse
    // 3. Execute steps sequentially
    // 4. Capture screenshots, logs, video
    // 5. On failure: enqueue healing job

    const startTime = Date.now()

    // Placeholder result — will be replaced with actual Playwright execution
    log.info(`[EXEC] Steps to execute: ${context.steps.length}`)
    log.info(`[EXEC] Base URL: ${context.baseUrl}`)
    log.info(`[EXEC] Category: ${context.projectCategory}`)

    // Simulate execution
    const duration = (Date.now() - startTime) / 1000
    const logs = context.steps.map((step, i) => ({
      step: i + 1,
      action: step.action,
      target: step.target,
      status: 'pending',
      message: `Step ${i + 1}: ${step.action} "${step.target}" — awaiting Playwright implementation`,
    }))

    // Update test run with results
    await prisma.test_runs.update({
      where: { id: testRunId },
      data: {
        status: 'pending',
        result: 'pending',
        duration,
        logs: logs as any,
      },
    })

    log.info(`[EXEC] Test run ${testRunId} completed in ${duration}s — awaiting Playwright implementation`)
  } catch (err) {
    log.error({ err }, `[EXEC] Test run ${testRunId} failed`)

    await prisma.test_runs.update({
      where: { id: testRunId },
      data: {
        status: 'error',
        result: 'error',
        logs: [{ error: String(err) }] as any,
      },
    })

    throw err // Re-throw for BullMQ retry
  }
}

// Start worker
const worker = new Worker<ExecutionJob>(
  QUEUES.EXECUTION,
  processExecution,
  {
    ...getRedisOptions(),
    concurrency: 3,
    limiter: {
      max: 5,
      duration: 60_000, // Max 5 jobs per minute
    },
  },
)

worker.on('completed', (job) => {
  log.info(`[EXEC] Job ${job.id} completed`)
})

worker.on('failed', (job, err) => {
  log.error({ err }, `[EXEC] Job ${job?.id} failed`)
})

worker.on('error', (err) => {
  log.error({ err }, '[EXEC] Worker error')
})

log.info('🔧 Execution worker started')
