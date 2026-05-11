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
// Cross-module: generation pipeline now lives in test-generation module
import { generateTest, humanizeSteps as humanizeStepsInternal } from '../test-generation/generation.service.js'

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
    where: {
      status: { not: 'review' }
    },
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
// Delegates to the test-generation module (generation.service.ts)
// SKILL.md cross-module rule: service.ts is the public interface.

export async function generateTestSteps(data: GenerateTestSteps) {
  log.info(`[TEST-GEN] Delegating to generation.service for prompt: "${data.prompt.substring(0, 80)}..."`)
  return generateTest({
    prompt:     data.prompt,
    provider:   data.provider ?? 'claude',
    model:      data.model       ?? undefined,
    project_id: data.project_id  ?? undefined,
  })
}

export async function humanizeSteps(steps: StepModel[]): Promise<any> {
  return humanizeStepsInternal(
    steps as unknown as Record<string, unknown>[],
    'claude'
  )
}
