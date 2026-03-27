/**
 * Test-Case Module — Zod Schemas
 *
 * Maps from Python Pydantic: TestCaseCreate, TestCaseResponse, StepModel
 */
import { z } from 'zod'

export const StepModelSchema = z.object({
  id: z.string(),
  action: z.string(),
  target: z.string().default('').optional(),
  value: z.string().default('').optional(),
})

export const TestCaseCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  steps: z.array(StepModelSchema).default([]),
  priority: z.string().default('medium'),
  status: z.string().default('draft').optional(),
  project_id: z.string().uuid(),
})

export const TestCaseUpdateSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional().nullable(),
  steps: z.array(StepModelSchema).optional(),
  priority: z.string().optional(),
  status: z.string().optional(),
})

export const StepsUpdateSchema = z.object({
  steps: z.array(StepModelSchema),
})

export const GenerateTestStepsSchema = z.object({
  prompt: z.string().min(1),
  provider: z.string().default('claude').optional(),
  model: z.string().optional().nullable(),
  project_id: z.string().optional().nullable(),
})

export const HumanizeStepsSchema = z.object({
  steps: z.array(StepModelSchema),
})

export type StepModel = z.infer<typeof StepModelSchema>
export type TestCaseCreate = z.infer<typeof TestCaseCreateSchema>
export type TestCaseUpdate = z.infer<typeof TestCaseUpdateSchema>
export type GenerateTestSteps = z.infer<typeof GenerateTestStepsSchema>
