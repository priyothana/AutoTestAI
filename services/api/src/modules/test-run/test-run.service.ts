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
    id:            s.id            ?? '',
    action:        s.action        ?? '',
    target:        s.target        ?? '',
    value:         s.value         ?? '',
    locator_type:  s.locator_type  ?? '',
    // Preserve SF field type so the execution worker dispatches the correct
    // Salesforce handler (selectSFPicklist / selectSFLookup / fillSFDate)
    ...(s.sf_field_type ? { sf_field_type: s.sf_field_type } : {}),
  })) as StepData[]

  // Determine which integration category to look for based on project category
  const projectCategory = (testCase.project.category as string) ?? 'webapp'
  const integrationCategory =
    projectCategory === 'salesforce' ? 'salesforce' : 'web_app'

  // Fetch the integration matching the project's own category first; fall back to any integration
  const integration = await prisma.project_integrations.findFirst({
    where: { project_id: testCase.project_id!, category: integrationCategory },
  }) ?? await prisma.project_integrations.findFirst({
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
    projectCategory: (projectCategory as any) ?? 'webapp',
    integrationStatus: (integration?.status as any) ?? 'disconnected',
    useSessionReuse,
    isLoginTest,
    interactive: data.interactive ?? false,
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
        // Prefer integration.base_url (the login URL) over project base_url
        context.webLoginUrl = integration.base_url ?? testCase.project.base_url ?? undefined
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

  // Interactive (headed) runs: no retries — re-launching a visible browser
  // after a crash would open duplicate windows and confuse the user.
  // Headless runs: keep 3 attempts with exponential back-off.
  await executionQueue.add('execute', job, {
    attempts: context.interactive ? 1 : 3,
    backoff: context.interactive ? undefined : { type: 'exponential', delay: 2000 },
  })

  log.info(`[TEST-RUN] Enqueued execution for test run ${testRun.id}`)

  return testRun
}

/**
 * Get a single test run by ID (with test case name).
 * Includes a stale-run guard: auto-marks runs stuck in pending/running >5min as error.
 */
export async function getTestRun(id: string) {
  const testRun = await prisma.test_runs.findUnique({
    where: { id },
    include: {
      test_case: { select: { name: true } },
    },
  })

  if (!testRun) throw { statusCode: 404, message: 'Test run not found' }

  // ── Stale-run guard ────────────────────────────────────────────────
  // 'pending'  → 5 min:  job was never picked up by the worker (crash at enqueue)
  // 'running'  → 15 min: accounts for interactive HITL runs with many steps
  //                       (frontend polls up to 15 min = 300 × 3s)
  // NOTE: 'paused' is intentionally excluded — HITL runs can wait indefinitely
  //       for user intervention and must NOT be auto-marked as error.
  const STALE_TIMEOUT_MS: Record<string, number> = {
    pending: 5  * 60 * 1000,  // 5 min — stuck before worker picked it up
    running: 15 * 60 * 1000,  // 15 min — matches interactive HITL budget
  }
  if (testRun.status && STALE_TIMEOUT_MS[testRun.status] && testRun.created_at) {
    const ageMs = Date.now() - testRun.created_at.getTime()
    if (ageMs > STALE_TIMEOUT_MS[testRun.status]) {
      log.warn(`[TEST-RUN] Stale run ${id} in '${testRun.status}' for ${(ageMs / 1000).toFixed(0)}s — auto-marking as error`)
      await prisma.test_runs.update({
        where: { id },
        data: {
          status: 'error',
          result: 'error',
          logs: [{ step_order: 999, action: 'SYSTEM', error: 'Test run timed out: worker did not complete within the allowed time.', status: 'error' }],
        },
      })
      return {
        ...testRun,
        status: 'error',
        result: 'error',
        test_case_name: testRun.test_case?.name ?? null,
      }
    }
  }

  return {
    ...testRun,
    test_case_name: testRun.test_case?.name ?? null,
  }
}

/**
 * List test runs with optional limit and test case filter.
 */
export async function listTestRuns(limit?: number, testCaseId?: string) {
  const testRuns = await prisma.test_runs.findMany({
    where: testCaseId ? { test_case_id: testCaseId } : undefined,
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
 * Detect if a test case IS the login test (i.e. it tests the login flow itself).
 *
 * Conservative: only returns true when the ENTIRE test name is about logging in.
 * A test called "Verify Post-Login Navigation" or "Test Login and Create Account"
 * should NOT be treated as a login test — those still need the pre-login phase.
 *
 * Matches: "Login", "Log In", "Sign In", "Signin", "Login Test", "Sign-In Test", etc.
 */
function detectLoginTest(name: string, _steps: StepData[]): boolean {
  return /^(log[-\s]?in|sign[-\s]?in|signin|login)(\s+test)?[\s.!]*$/i.test(name.trim())
}
