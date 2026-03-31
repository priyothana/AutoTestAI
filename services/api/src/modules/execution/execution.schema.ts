/**
 * Execution Module — Zod Schemas
 *
 * Request + response shapes for:
 *   POST /api/v1/execute
 *   GET  /api/v1/executions/:id
 *   GET  /api/v1/projects/:id/executions
 *
 * These shapes must remain 100% identical to the Python FastAPI version.
 * The Next.js dashboard reads ExecutionResult JSON directly.
 */
import { z } from 'zod'

// ─── Request Schemas ────────────────────────────────────────────────────────

/** POST /api/v1/execute — trigger a test run */
export const ExecuteRequestSchema = z.object({
  test_case_id: z.string().uuid(),
  triggered_by: z.enum(['manual', 'auto']).default('manual'),
})

export type ExecuteRequest = z.infer<typeof ExecuteRequestSchema>

// ─── Response Schemas ────────────────────────────────────────────────────────

/** Single step log entry — matches Python ExecutionStepResult exactly */
export const ExecutionStepResultSchema = z.object({
  step: z.number().int(),
  action: z.string(),
  target: z.string().optional().nullable(),
  value: z.string().optional().nullable(),
  status: z.enum(['passed', 'failed', 'skipped', 'pending']),
  message: z.string().optional().nullable(),
  duration_ms: z.number().optional().nullable(),
  screenshot_path: z.string().optional().nullable(),
  error: z.string().optional().nullable(),
})

export type ExecutionStepResult = z.infer<typeof ExecutionStepResultSchema>

/** Full ExecutionResult — identical JSON schema to Python version.
 *  Next.js dashboard reads this directly — do NOT change field names. */
export const ExecutionResultSchema = z.object({
  id: z.string().uuid(),
  test_case_id: z.string().uuid().nullable(),
  status: z.enum(['PENDING', 'RUNNING', 'PASSED', 'FAILED', 'ERROR']),
  triggered_by: z.enum(['manual', 'auto']).nullable().optional(),
  steps: z.array(ExecutionStepResultSchema),
  logs: z.string().nullable().optional(),
  result_metadata: z.record(z.unknown()).nullable().optional(),
  started_at: z.string().datetime(),
  completed_at: z.string().datetime().nullable().optional(),
  duration_ms: z.number().nullable().optional(),
  screenshot_path: z.string().nullable().optional(),
  trace_path: z.string().nullable().optional(),
  error_message: z.string().nullable().optional(),
  test_case_name: z.string().nullable().optional(),
})

export type ExecutionResult = z.infer<typeof ExecutionResultSchema>

/** Response from POST /execute */
export const ExecuteResponseSchema = z.object({
  execution_id: z.string().uuid(),
  status: z.literal('queued'),
  message: z.string(),
})

export type ExecuteResponse = z.infer<typeof ExecuteResponseSchema>

/** List executions response */
export const ExecutionListResponseSchema = z.object({
  executions: z.array(ExecutionResultSchema),
  total: z.number().int(),
})

export type ExecutionListResponse = z.infer<typeof ExecutionListResponseSchema>
