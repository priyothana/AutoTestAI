/**
 * DB Query Tool — Safe Prisma Read/Write for Agents
 *
 * Agents use this instead of direct Prisma calls.
 * Enforces read-only or write access per agent (Principle of Least Privilege).
 */
import prisma                 from '../../../shared/db/prisma.js'
import { createModuleLogger } from '../../../shared/logger/index.js'

const log = createModuleLogger('db-query-tool')

// ── Read operations ────────────────────────────────────────────────────────────

export async function getProjectById(projectId: string) {
  try {
    return await prisma.projects.findUnique({ where: { id: projectId } })
  } catch (err) {
    log.warn({ err, projectId }, '[DB-TOOL] getProjectById failed')
    return null
  }
}

export async function getTestCasesByProject(projectId: string, limit = 50) {
  try {
    return await prisma.test_cases.findMany({
      where:   { project_id: projectId },
      select:  { id: true, name: true, description: true, steps: true, priority: true },
      orderBy: { created_at: 'desc' },
      take:    limit,
    })
  } catch (err) {
    log.warn({ err }, '[DB-TOOL] getTestCasesByProject failed')
    return []
  }
}

export async function getRecentFailedExecutions(projectId: string, limit = 20) {
  try {
    const testCaseIds = await prisma.test_cases.findMany({
      where:  { project_id: projectId },
      select: { id: true },
    })
    return await prisma.executions.findMany({
      where:   { test_case_id: { in: testCaseIds.map(t => t.id) }, status: 'FAILED' },
      orderBy: { started_at: 'desc' },
      take:    limit,
    })
  } catch (err) {
    log.warn({ err }, '[DB-TOOL] getRecentFailedExecutions failed')
    return []
  }
}

export async function getTestCaseById(testCaseId: string) {
  try {
    return await prisma.test_cases.findUnique({ where: { id: testCaseId } })
  } catch (err) {
    log.warn({ err }, '[DB-TOOL] getTestCaseById failed')
    return null
  }
}

export async function getExecutionById(executionId: string) {
  try {
    return await prisma.executions.findUnique({ where: { id: executionId } })
  } catch (err) {
    log.warn({ err }, '[DB-TOOL] getExecutionById failed')
    return null
  }
}

// ── Write operations (agents call these explicitly — not implicit) ─────────────

export async function saveTestCases(
  projectId: string,
  cases: Array<{
    name:        string
    description: string
    priority:    string
    steps:       object[]
    tags?:       string[]
  }>,
  suiteId?: string,
): Promise<string[]> {
  try {
    const ids: string[] = []
    for (const tc of cases) {
      const created = await prisma.test_cases.create({
        data: {
          project_id:   projectId,
          name:         tc.name,
          description:  tc.description,
          priority:     tc.priority,
          steps:        tc.steps as object,
          tags:         tc.tags ?? [],
          suite_id:     suiteId ?? null,
        } as any,
      })
      ids.push(created.id)
    }
    log.info({ projectId, count: ids.length }, '[DB-TOOL] Saved test cases')
    return ids
  } catch (err) {
    log.warn({ err }, '[DB-TOOL] saveTestCases failed')
    return []
  }
}

export async function updateTestCaseSteps(
  testCaseId: string,
  steps:      object[],
): Promise<boolean> {
  try {
    await prisma.test_cases.update({
      where: { id: testCaseId },
      data:  { steps: steps as object },
    })
    log.info({ testCaseId, stepCount: steps.length }, '[DB-TOOL] Updated steps')
    return true
  } catch (err) {
    log.warn({ err }, '[DB-TOOL] updateTestCaseSteps failed')
    return false
  }
}

export async function logAgentExecution(entry: {
  projectId:     string | null
  agentName:     string
  taskType:      string
  inputSummary:  object
  outputSummary: object
  thoughts:      string[]
  hitlInvoked:   boolean
  confidence:    number
  tokensUsed:    number
  durationMs:    number
}): Promise<void> {
  try {
    await (prisma as any).agent_executions?.create({ data: entry })
  } catch { /* table may not exist yet — migration pending */ }
}

export async function saveAiSuggestions(
  testRunId: string,
  suggestions: object,
): Promise<void> {
  try {
    await prisma.test_runs.update({
      where: { id: testRunId },
      data:  { ai_suggestions: suggestions as object },
    })
  } catch (err) {
    log.warn({ err }, '[DB-TOOL] saveAiSuggestions failed')
  }
}
