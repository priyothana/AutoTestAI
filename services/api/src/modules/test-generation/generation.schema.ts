/**
 * Test-Generation Module — Zod Schemas
 *
 * All request/response shapes for the generation pipeline.
 * Matches Python's TestGenerationRequest + TestGenerationResponse exactly
 * so the Next.js frontend requires ZERO changes.
 *
 * Python endpoint: POST /api/v1/tests/generate-test-steps
 * Contract source: backend/app/api/v1/endpoints/tests.py
 */
import { z } from 'zod'

// ── Step shape (matches Python StepModel) ──────────────────────────

export const StepSchema = z.object({
  id:           z.string(),
  action:       z.string(),
  target:       z.string().optional(),
  value:        z.string().optional(),
  locator_type: z.string().optional(),
  /**
   * SF Lightning field type — used by the execution worker to dispatch the
   * correct interaction handler.
   * Values: 'picklist' | 'lookup' | 'lookup_advanced' | 'date' | 'dependent_picklist'
   */
  sf_field_type: z.string().optional(),
})

export type Step = z.infer<typeof StepSchema>

// ── POST /api/v1/tests/generate-test-steps ─────────────────────────

export const GenerateRequestSchema = z.object({
  prompt:     z.string().min(1, 'Prompt is required'),
  provider:   z.string().default('claude'),
  model:      z.string().optional(),
  project_id: z.string().optional(),
})

export type GenerateRequest = z.infer<typeof GenerateRequestSchema>

// ── Response shape (matches Python TestGenerationResponse) ──────────

export const GenerateResponseSchema = z.object({
  name:             z.string(),
  description:      z.string(),
  steps:            z.array(StepSchema),
  priority:         z.string(),
  preconditions:    z.array(z.string()).default([]),
  expected_outcome: z.string(),
  // Optional enrichment metadata (not required by frontend)
  rag_context_used: z.boolean().optional(),
  retrieved_chunks: z.number().optional(),
  model_provider:   z.string().optional(),
})

export type GenerateResponse = z.infer<typeof GenerateResponseSchema>

// ── POST /api/v1/tests/humanize-steps ─────────────────────────────

export const HumanizeRequestSchema = z.object({
  steps:    z.array(z.record(z.unknown())),
  provider: z.string().default('claude'),
})

export type HumanizeRequest = z.infer<typeof HumanizeRequestSchema>

export const ReadableStepSchema = z.object({
  test_step:       z.string(),
  test_data:       z.string(),
  expected_result: z.string(),
  actual_result:   z.string().default('—'),
  status:          z.string().default('—'),
  comments:        z.string().default('—'),
})

export type ReadableStep = z.infer<typeof ReadableStepSchema>

export const HumanizeResponseSchema = z.object({
  readable_steps: z.array(ReadableStepSchema),
})

export type HumanizeResponse = z.infer<typeof HumanizeResponseSchema>
