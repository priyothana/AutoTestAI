/**
 * Execution Module — Service Layer
 *
 * Public API for other modules:
 *   - enqueueExecution()  — creates an executions row + enqueues to BullMQ
 *   - getExecution()      — fetch single ExecutionResult with steps
 *   - listProjectExecutions() — fetch all results for a project
 *
 * This module owns the `executions` table (Prisma model: executions).
 * Workers write step details via result_metadata (serialised JSON).
 *
 * Port of Python: execution_runner.py + executions endpoint in test_runs.py
 */
import { Queue } from 'bullmq'
import { v4 as uuidv4 } from 'uuid'
import prisma from '../../shared/db/prisma.js'
import { getRedisOptions } from '../../shared/queue/connection.js'
import { QUEUES } from '../../shared/queue/queues.js'
import { createModuleLogger } from '../../shared/logger/index.js'
import { fernetDecrypt } from '../../shared/encryption/fernet.js'
import type { ExecutionJob, ExecutionContext, StepData } from '../../shared/queue/job-types.js'
import type { ExecuteRequest, ExecutionResult, ExecutionStepResult } from './execution.schema.js'

const log = createModuleLogger('execution')

// One queue instance per process — reused across calls
const executionQueue = new Queue<ExecutionJob>(QUEUES.EXECUTION, getRedisOptions())

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Detect if this test touches login fields */
function detectLoginTest(testCaseName: string, steps: StepData[]): boolean {
  if (testCaseName.toLowerCase().includes('login')) return true
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

/** Map raw executions DB row → ExecutionResult shape expected by frontend */
function serializeExecution(
  row: {
    id: string
    test_case_id: string | null
    status: string
    logs: string | null
    result_metadata: unknown
    started_at: Date
    completed_at: Date | null
  },
  testCaseName?: string | null,
): ExecutionResult {
  const meta = (row.result_metadata as Record<string, unknown> | null) ?? {}
  const steps = (meta.steps as ExecutionStepResult[] | undefined) ?? []
  const startedAt = row.started_at instanceof Date ? row.started_at : new Date(row.started_at)
  const completedAt =
    row.completed_at instanceof Date
      ? row.completed_at
      : row.completed_at
      ? new Date(row.completed_at)
      : null

  return {
    id: row.id,
    test_case_id: row.test_case_id ?? null,
    status: (row.status as ExecutionResult['status']) ?? 'PENDING',
    triggered_by: (meta.triggered_by as ExecutionResult['triggered_by']) ?? 'manual',
    steps,
    logs: row.logs ?? null,
    result_metadata: meta,
    started_at: startedAt.toISOString(),
    completed_at: completedAt ? completedAt.toISOString() : null,
    duration_ms: (meta.duration_ms as number | null) ?? null,
    screenshot_path: (meta.screenshot_path as string | null) ?? null,
    trace_path: (meta.trace_path as string | null) ?? null,
    error_message: (meta.error_message as string | null) ?? null,
    test_case_name: testCaseName ?? null,
  }
}

// ─── Public service functions ─────────────────────────────────────────────────

/**
 * Create an execution record in PENDING state and enqueue it.
 * Returns the execution_id immediately — frontend polls for status.
 */
export async function enqueueExecution(data: ExecuteRequest): Promise<{ execution_id: string }> {
  // 1. Resolve test case + project
  const testCase = await prisma.test_cases.findUnique({
    where: { id: data.test_case_id },
    include: { project: true },
  })
  if (!testCase) throw { statusCode: 404, message: 'Test case not found' }
  if (!testCase.project) throw { statusCode: 404, message: 'Project not found for test case' }

  // 2. Build steps array from test case
  const steps = ((testCase.steps as unknown[]) ?? []).map((s: unknown) => {
    const step = s as Record<string, unknown>
    return {
      id: (step.id as string) ?? uuidv4(),
      action: (step.action as string) ?? '',
      target: (step.target as string | undefined) ?? '',
      value: (step.value as string | undefined) ?? '',
    } satisfies StepData
  })

  // 3. Resolve integration credentials
  const integration = await prisma.project_integrations.findFirst({
    where: { project_id: testCase.project_id! },
  })

  const settings = await prisma.app_settings.findFirst()
  const useSessionReuse = settings?.use_session_reuse ?? true
  const isLoginTest = detectLoginTest(testCase.name, steps)

  const context: ExecutionContext = {
    baseUrl: testCase.project.base_url ?? '',
    steps,
    projectCategory: (testCase.project.category as ExecutionContext['projectCategory']) ?? 'webapp',
    integrationStatus: (integration?.status as ExecutionContext['integrationStatus']) ?? 'disconnected',
    useSessionReuse,
    isLoginTest,
  }

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
        context.webLoginStrategy = (integration.login_strategy as ExecutionContext['webLoginStrategy']) ?? 'form'
      }
    } catch (err) {
      log.warn({ err }, 'Failed to decrypt integration credentials — continuing without them')
    }
  }

  // 4. Create execution record (PENDING)
  const execution = await prisma.executions.create({
    data: {
      id: uuidv4(),
      test_case_id: data.test_case_id,
      status: 'PENDING',
      logs: null,
      result_metadata: { triggered_by: data.triggered_by } as object,
      started_at: new Date(),
    },
  })

  // 5. Enqueue BullMQ job — worker picks this up asynchronously
  const job: ExecutionJob = {
    testRunId: execution.id,          // execution.id serves as the run identifier
    testCaseId: data.test_case_id,
    projectId: testCase.project_id!,
    triggeredBy: data.triggered_by,
    context,
  }

  await executionQueue.add('run-test', job, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  })

  log.info(`[EXEC] Enqueued execution ${execution.id} for test case ${data.test_case_id}`)

  return { execution_id: execution.id }
}

/**
 * Fetch a single execution by ID.
 * Includes resolved test_case_name for frontend display.
 */
export async function getExecution(id: string): Promise<ExecutionResult> {
  const row = await prisma.executions.findUnique({
    where: { id },
    include: {
      test_case: { select: { name: true } },
    },
  })

  if (!row) throw { statusCode: 404, message: 'Execution not found' }

  return serializeExecution(row, row.test_case?.name ?? null)
}

/**
 * List all executions for a project, ordered newest-first.
 */
export async function listProjectExecutions(
  projectId: string,
  limit = 50,
): Promise<{ executions: ExecutionResult[]; total: number }> {
  // Project must exist
  const project = await prisma.projects.findUnique({ where: { id: projectId } })
  if (!project) throw { statusCode: 404, message: 'Project not found' }

  // Find test cases that belong to this project, then their executions
  const testCases = await prisma.test_cases.findMany({
    where: { project_id: projectId },
    select: { id: true, name: true },
  })

  const testCaseIds = testCases.map((tc) => tc.id)
  const testCaseNameMap = Object.fromEntries(testCases.map((tc) => [tc.id, tc.name]))

  const [rows, total] = await Promise.all([
    prisma.executions.findMany({
      where: { test_case_id: { in: testCaseIds } },
      orderBy: { started_at: 'desc' },
      take: limit,
    }),
    prisma.executions.count({
      where: { test_case_id: { in: testCaseIds } },
    }),
  ])

  const executions = rows.map((row) =>
    serializeExecution(row, testCaseNameMap[row.test_case_id ?? ''] ?? null),
  )

  return { executions, total }
}
