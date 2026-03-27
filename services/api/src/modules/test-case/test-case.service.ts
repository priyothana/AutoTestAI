/**
 * Test-Case Module — Service Layer
 *
 * Handles test case CRUD and AI test generation orchestration.
 * Port of Python: tests.py business logic (1286 lines).
 *
 * NOTE: The AI generation functions are placeholders that will be
 * implemented in Phase 4 when the AI service is migrated.
 */
import prisma from '../../shared/db/prisma.js'
import { createModuleLogger } from '../../shared/logger/index.js'
import type {
  TestCaseCreate,
  TestCaseUpdate,
  StepModel,
  GenerateTestSteps,
} from './test-case.schema.js'

const log = createModuleLogger('test-case')

// ─── CRUD ────────────────────────────────────────────────────────

export async function createTestCase(data: TestCaseCreate) {
  const testCase = await prisma.test_cases.create({
    data: {
      name: data.name,
      description: data.description ?? null,
      steps: data.steps as any,
      priority: data.priority,
      status: data.status ?? 'draft',
      project_id: data.project_id,
    },
  })
  return testCase
}

export async function listTestCases() {
  const testCases = await prisma.test_cases.findMany({
    include: {
      project: { select: { name: true } },
    },
    orderBy: { created_at: 'desc' },
  })

  return testCases.map((tc) => ({
    ...tc,
    project_name: tc.project?.name ?? null,
  }))
}

export async function getTestCase(id: string) {
  const testCase = await prisma.test_cases.findUnique({
    where: { id },
    include: {
      project: { select: { name: true } },
    },
  })
  if (!testCase) throw { statusCode: 404, message: 'Test case not found' }

  return {
    ...testCase,
    project_name: testCase.project?.name ?? null,
  }
}

export async function updateTestCase(id: string, data: TestCaseUpdate) {
  const existing = await prisma.test_cases.findUnique({ where: { id } })
  if (!existing) throw { statusCode: 404, message: 'Test case not found' }

  const updateData: any = {}
  if (data.name !== undefined) updateData.name = data.name
  if (data.description !== undefined) updateData.description = data.description
  if (data.steps !== undefined) updateData.steps = data.steps as any
  if (data.priority !== undefined) updateData.priority = data.priority
  if (data.status !== undefined) updateData.status = data.status

  return prisma.test_cases.update({
    where: { id },
    data: updateData,
  })
}

export async function deleteTestCase(id: string) {
  const existing = await prisma.test_cases.findUnique({ where: { id } })
  if (!existing) throw { statusCode: 404, message: 'Test case not found' }

  await prisma.test_cases.delete({ where: { id } })
}

export async function updateTestSteps(id: string, steps: StepModel[]) {
  const existing = await prisma.test_cases.findUnique({ where: { id } })
  if (!existing) throw { statusCode: 404, message: 'Test case not found' }

  return prisma.test_cases.update({
    where: { id },
    data: { steps: steps as any },
  })
}

// ─── AI Generation ──────────────────────────────────────────────
// TODO: Port from Python ai_service.py (50K) in Phase 4.
// These stubs match the Python response shape so the frontend works.

export async function generateTestSteps(data: GenerateTestSteps) {
  log.info(`[TEST-GEN] Generating steps for prompt: "${data.prompt.substring(0, 80)}..."`)
  log.info(`[TEST-GEN] Provider: ${data.provider ?? 'claude'}, Model: ${data.model ?? 'default'}`)

  // TODO: Implement AI generation pipeline:
  // 1. Detect project type (webapp, salesforce, api)
  // 2. If webapp + crawler → crawl DOM metadata → ground AI prompt
  // 3. If MCP + metadata → RAG retrieval → strict metadata generation
  // 4. Otherwise → generic LLM generation
  //
  // For now, return a placeholder that matches the Python response shape.
  return {
    name: `Test: ${data.prompt.substring(0, 50)}`,
    description: data.prompt,
    steps: [
      { id: '1', action: 'Navigate', target: 'https://example.com', value: '' },
      { id: '2', action: 'Click', target: 'Login Button', value: '' },
    ],
    priority: 'medium',
    preconditions: [],
    expected_outcome: 'Test should complete successfully',
    model_provider: data.provider ?? 'claude',
  }
}

export async function humanizeSteps(steps: StepModel[]) {
  // TODO: Port from Python ai_service.py — uses LLM to convert technical steps to readable descriptions
  return {
    steps: steps.map((s) => ({
      ...s,
      description: `${s.action} on "${s.target ?? ''}" with value "${s.value ?? ''}"`,
    })),
  }
}
