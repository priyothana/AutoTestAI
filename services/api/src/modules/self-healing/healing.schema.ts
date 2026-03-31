/**
 * Self-Healing Module — Zod Schemas
 *
 * Input/output shapes are IDENTICAL to the Python test_healing_service.py version.
 * The Next.js frontend must require zero changes.
 *
 * Input:  { failedLocator, screenshotBase64, htmlSnippet, testScriptId }
 * Output: { suggestedLocator, confidence, reasoning }
 *
 * Route: GET /api/v1/heal/:executionId
 */
import { z } from 'zod'

// ─── Input Shape ─────────────────────────────────────────────────────────────

/**
 * Body shape expected when triggering a healing analysis directly.
 * Also the shape stored in the healing-queue job (see HealingJob in job-types.ts).
 */
export const HealInputSchema = z.object({
  failedLocator:    z.string().min(1, 'failedLocator is required'),
  screenshotBase64: z.string().min(1, 'screenshotBase64 is required'),
  htmlSnippet:      z.string().min(1, 'htmlSnippet is required'),
  testScriptId:     z.string().uuid('testScriptId must be a valid UUID'),
})

export type HealInput = z.infer<typeof HealInputSchema>

// ─── Output Shape ─────────────────────────────────────────────────────────────

/**
 * Response shape — identical to Python HealingSuggestion response model.
 * The frontend reads these fields directly.
 */
export const HealOutputSchema = z.object({
  suggestedLocator: z.string(),
  confidence:       z.number().min(0).max(1),
  reasoning:        z.string(),
})

export type HealOutput = z.infer<typeof HealOutputSchema>

// ─── GET /api/v1/heal/:executionId response ───────────────────────────────────

/**
 * A single healing suggestion row returned by the GET route.
 * Maps to the execution_learnings table (learning_type = 'healing_suggestion').
 */
export const HealingSuggestionSchema = z.object({
  id:               z.string().uuid(),
  executionId:      z.string().uuid(),
  testScriptId:     z.string().uuid().nullable(),
  failedLocator:    z.string().nullable(),
  suggestedLocator: z.string().nullable(),
  confidence:       z.number().min(0).max(1).nullable(),
  reasoning:        z.string().nullable(),
  autoApplied:      z.boolean(),
  createdAt:        z.string().datetime(),
})

export type HealingSuggestion = z.infer<typeof HealingSuggestionSchema>

/** Response envelope for GET /api/v1/heal/:executionId */
export const HealingSuggestionsResponseSchema = z.object({
  suggestions: z.array(HealingSuggestionSchema),
  total:       z.number().int(),
})

export type HealingSuggestionsResponse = z.infer<typeof HealingSuggestionsResponseSchema>
