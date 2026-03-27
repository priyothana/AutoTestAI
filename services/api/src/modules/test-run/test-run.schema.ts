/**
 * Test-Run Module — Zod Schemas
 */
import { z } from 'zod'

export const TestRunCreateSchema = z.object({
  test_case_id: z.string().uuid(),
})

export const TestRunResponseSchema = z.object({
  id: z.string(),
  test_case_id: z.string(),
  status: z.string(),
  result: z.string().nullable().optional(),
  duration: z.number().nullable().optional(),
  logs: z.any().default([]),
  screenshot_path: z.string().nullable().optional(),
  test_case_name: z.string().nullable().optional(),
  ai_suggestions: z.any().nullable().optional(),
  created_at: z.string(),
})

export type TestRunCreate = z.infer<typeof TestRunCreateSchema>
