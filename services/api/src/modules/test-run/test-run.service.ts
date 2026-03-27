/**
 * Test-Run Module — Service Layer
 *
 * Handles creating test runs, building ExecutionContext,
 * enqueuing to BullMQ, and querying run status.
 *
 * Port of Python: test_runs.py
 */
import { Queue } from 'bullmq'
import prisma from '../../shared/db/prisma.js'
import { getRedisOptions } from '../../shared/queue/connection.js'
import { QUEUES } from '../../shared/queue/queues.js'
import { createModuleLogger } from '../../shared/logger/index.js'
import { fernetDecrypt } from '../../shared/encryption/fernet.js'
import type { ExecutionJob, ExecutionContext, StepData } from '../../shared/queue/job-types.js'
import type { TestRunCreate } from './test-run.schema.js'

const log = createModuleLogger('test-run')
const executionQueue = new Queue<ExecutionJob>(QUEUES.EXECUTION, getRedisOptions())

/**
 * Create a new test run and enqueue for execution.
 */
export async function createTestRun(data: TestRunCreate) {
  // Fetch test case + project
  const testCase = await prisma.test_cases.findUnique({
    where: { id: data.test_case_id },
    include: {
      project: true,
    },
  })

  if (!testCase) throw { statusCode: 404, message: 'Test case not found' }
  if (!testCase.project) throw { statusCode: 404, message: 'Project not found for test case' }

  // Create test run record
  const testRun = await prisma.test_runs.create({
    data: {
      test_case_id: data.test_case_id,
      status: 'pending',
      logs: [],
    },
  })

  // Build execution context
  const steps = (testCase.steps as any[]).map((s: any) => ({
    id: s.id ?? '',
    action: s.action ?? '',
    target: s.target ?? '',
    value: s.value ?? '',
  })) as StepData[]

  const integration = await prisma.project_integrations.findFirst({
    where: { project_id: testCase.project_id! },
  })

  // Detect login test
  const isLoginTest = detectLoginTest(testCase.name, steps)

  // Get settings
  const settings = await prisma.app_settings.findFirst()
  const useSessionReuse = settings?.use_session_reuse ?? true

  // Build context
  const context: ExecutionContext = {
    baseUrl: testCase.project.base_url ?? '',
    steps,
    projectCategory: (testCase.project.category as any) ?? 'webapp',
    integrationStatus: (integration?.status as any) ?? 'disconnected',
    useSessionReuse,
    isLoginTest,
  }

  // Resolve credentials from integration (if present)
  if (integration) {
    try {
      if (integration.category === 'salesforce') {
        if (integration.access_token) context.sfAccessToken = fernetDecrypt(integration.access_token)
        if (integration.instance_url) context.sfInstanceUrl = integration.instance_url
        if (integration.username) context.sfUsername = fernetDecrypt(integration.username)
        if (integration.password) context.sfPassword = fernetDecrypt(integration.password)
        if (integration.security_token) context.sfSecurityToken = fernetDecrypt(integration.security_token)
        context.sfLoginUrl = integration.salesforce_login_url ?? 'https://login.salesforce.com'
        context.mcpConnected = integration.mcp_connected
      } else if (integration.category === 'web_app') {
        if (integration.username) context.webUsername = fernetDecrypt(integration.username)
        if (integration.password) context.webPassword = fernetDecrypt(integration.password)
        context.webLoginUrl = integration.base_url ?? undefined
        context.webLoginStrategy = (integration.login_strategy as any) ?? 'form'
      }
    } catch (err) {
      log.warn({ err }, 'Failed to decrypt integration credentials')
    }
  }

  // Enqueue to BullMQ
  const job: ExecutionJob = {
    testRunId: testRun.id,
    testCaseId: data.test_case_id,
    projectId: testCase.project_id!,
    triggeredBy: 'manual',
    context,
  }

  await executionQueue.add('execute', job, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  })

  log.info(`[TEST-RUN] Enqueued execution for test run ${testRun.id}`)

  return testRun
}

/**
 * Get a single test run by ID (with test case name).
 */
export async function getTestRun(id: string) {
  const testRun = await prisma.test_runs.findUnique({
    where: { id },
    include: {
      test_case: { select: { name: true } },
    },
  })

  if (!testRun) throw { statusCode: 404, message: 'Test run not found' }

  return {
    ...testRun,
    test_case_name: testRun.test_case?.name ?? null,
  }
}

/**
 * List test runs with optional limit.
 */
export async function listTestRuns(limit?: number) {
  const testRuns = await prisma.test_runs.findMany({
    include: {
      test_case: { select: { name: true } },
    },
    orderBy: { created_at: 'desc' },
    take: limit ?? 50,
  })

  return testRuns.map((tr) => ({
    ...tr,
    test_case_name: tr.test_case?.name ?? null,
  }))
}

/**
 * Delete a test run.
 */
export async function deleteTestRun(id: string) {
  const existing = await prisma.test_runs.findUnique({ where: { id } })
  if (!existing) throw { statusCode: 404, message: 'Test run not found' }

  await prisma.test_runs.delete({ where: { id } })
}

/**
 * Detect if a test case is a login test.
 */
function detectLoginTest(name: string, steps: StepData[]): boolean {
  if (name.toLowerCase().includes('login')) return true

  for (const step of steps) {
    const action = step.action.toLowerCase()
    const target = (step.target ?? '').toLowerCase()
    if (
      action === 'type' &&
      (target.includes('email') || target.includes('username') || target.includes('password'))
    ) {
      return true
    }
  }

  return false
}
