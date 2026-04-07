/**
 * Self-Healing Module — Service Layer
 *
 * Public interface for other modules (healing.worker.ts reads from here):
 *   - getHealingSuggestionsForExecution()  — fetch all suggestions for an execution
 *   - saveHealingSuggestion()              — write a suggestion to DB
 *   - applyHealingSuggestion()             — update test case steps with the fixed locator
 *
 * This module persists healing data into `execution_learnings` table using:
 *   learning_type = 'healing_suggestion'
 *   extra_metadata = { failedLocator, suggestedLocator, confidence, reasoning, autoApplied }
 *
 * Port of Python: test_healing_service.py (59K)
 * The Prisma schema has no dedicated HealingSuggestion table; we reuse
 * execution_learnings (which already has project_id, test_case_id, test_run_id).
 *
 * Cross-module boundary (SKILL.md): only .service.ts files are importable externally.
 */
import prisma                  from '../../shared/db/prisma.js'
import { createModuleLogger }  from '../../shared/logger/index.js'
import type {
  HealOutput,
  HealingSuggestion,
  HealingSuggestionsResponse,
} from './healing.schema.js'

const log = createModuleLogger('self-healing')

// ─── Internal DB helpers ──────────────────────────────────────────────────────

interface HealingMeta {
  failedLocator:    string
  suggestedLocator: string
  confidence:       number
  reasoning:        string
  autoApplied:      boolean
  executionId:      string
}

/**
 * Deserialise an execution_learnings row (learning_type='healing_suggestion')
 * into the HealingSuggestion API shape.
 */
function rowToSuggestion(row: {
  id:            string
  test_case_id:  string | null
  test_run_id:   string | null
  extra_metadata: unknown
  created_at:    Date
}): HealingSuggestion {
  const meta    = (row.extra_metadata ?? {}) as Partial<HealingMeta>
  const conf    = typeof meta.confidence === 'number' ? meta.confidence : null
  const applied = typeof meta.autoApplied === 'boolean' ? meta.autoApplied : false

  return {
    id:               row.id,
    executionId:      meta.executionId ?? row.test_run_id ?? '',
    testScriptId:     row.test_case_id ?? null,
    failedLocator:    meta.failedLocator ?? null,
    suggestedLocator: meta.suggestedLocator ?? null,
    confidence:       conf,
    reasoning:        meta.reasoning ?? null,
    autoApplied:      applied,
    createdAt:        row.created_at.toISOString(),
  }
}

// ─── Public service functions ─────────────────────────────────────────────────

/**
 * Fetch all healing suggestions for a given execution ID.
 * Called by GET /api/v1/heal/:executionId.
 */
export async function getHealingSuggestionsForExecution(
  executionId: string,
): Promise<HealingSuggestionsResponse> {
  const rows = await prisma.execution_learnings.findMany({
    where: {
      learning_type: 'healing_suggestion',
      test_run_id:   executionId,
    },
    orderBy: { created_at: 'desc' },
  })

  const suggestions = rows.map(rowToSuggestion)
  return { suggestions, total: suggestions.length }
}

/**
 * Persist a healing suggestion to the DB.
 * Called by the healing worker after successful LLM chain invocation.
 *
 * @returns The saved HealingSuggestion (id + timestamps filled)
 */
export async function saveHealingSuggestion(params: {
  executionId:      string
  testScriptId:     string
  projectId:        string
  failedLocator:    string
  suggestedLocator: string
  confidence:       number
  reasoning:        string
  autoApplied:      boolean
}): Promise<HealingSuggestion> {
  const meta: HealingMeta = {
    executionId:      params.executionId,
    failedLocator:    params.failedLocator,
    suggestedLocator: params.suggestedLocator,
    confidence:       params.confidence,
    reasoning:        params.reasoning,
    autoApplied:      params.autoApplied,
  }

  const row = await prisma.execution_learnings.create({
    data: {
      project_id:     params.projectId,
      test_case_id:   params.testScriptId,
      test_run_id:    params.executionId,
      learning_type:  'healing_suggestion',
      failure_reason: params.failedLocator,
      correct_action: params.suggestedLocator,
      extra_metadata: meta as object,
    },
  })

  log.info(
    `[HEAL] Saved suggestion for execution=${params.executionId} ` +
    `confidence=${params.confidence} autoApplied=${params.autoApplied}`,
  )

  return rowToSuggestion(row)
}

/**
 * Auto-apply a healing suggestion: update the matching test step's locator
 * in the test_cases.steps JSON array.
 *
 * The test_cases table stores steps as JSON. We scan for any step whose
 * target equals the failedLocator and replace it with suggestedLocator.
 */
export async function applyHealingSuggestion(
  testScriptId:     string,
  failedLocator:    string,
  suggestedLocator: string,
): Promise<{ applied: boolean; updatedStepCount: number }> {

  // ── Safeguard: reject suggestions that replace core form actions with modal actions ──
  // The healer sometimes sees an open modal (e.g. Advanced Search) in the failure
  // screenshot and "fixes" the Save button to point to the modal's Select button.
  // This corruption creates a vicious cycle (corrupted step → fail → re-apply).
  const CORE_ACTIONS   = /\b(save|submit|next|cancel|delete|confirm)\b/i
  const MODAL_ACTIONS  = /\b(select|search|close|advanced)\b/i
  const failedIsCore   = CORE_ACTIONS.test(failedLocator)
  const suggestedIsModal = MODAL_ACTIONS.test(suggestedLocator) && !CORE_ACTIONS.test(suggestedLocator)
  if (failedIsCore && suggestedIsModal) {
    log.warn(
      `[HEAL] BLOCKED: refusing to replace core action '${failedLocator}' ` +
      `with modal-specific action '${suggestedLocator}' — likely a misdiagnosis from a blocking modal`,
    )
    return { applied: false, updatedStepCount: 0 }
  }

  const testCase = await prisma.test_cases.findUnique({
    where:  { id: testScriptId },
    select: { id: true, steps: true },
  })

  if (!testCase) {
    log.warn(`[HEAL] testScriptId=${testScriptId} not found — cannot apply`)
    return { applied: false, updatedStepCount: 0 }
  }

  const steps = (testCase.steps as unknown[]) ?? []
  let updatedCount = 0

  const updatedSteps = steps.map((s: unknown) => {
    const step = s as Record<string, unknown>
    if (step['target'] === failedLocator || step['locator'] === failedLocator) {
      updatedCount++
      return {
        ...step,
        target:  suggestedLocator,
        locator: suggestedLocator,
      }
    }
    return step
  })

  if (updatedCount > 0) {
    await prisma.test_cases.update({
      where: { id: testScriptId },
      data:  { steps: updatedSteps as object[] },
    })

    log.info(
      `[HEAL] Auto-applied fix for testScript=${testScriptId} ` +
      `updated ${updatedCount} step(s): '${failedLocator}' → '${suggestedLocator}'`,
    )
  } else {
    log.warn(
      `[HEAL] No matching step found for failedLocator='${failedLocator}' ` +
      `in testScript=${testScriptId}`,
    )
  }

  return { applied: updatedCount > 0, updatedStepCount: updatedCount }
}

/**
 * Fetch a single execution_learnings row by ID (for internal use).
 */
export async function getHealingSuggestionById(
  id: string,
): Promise<HealingSuggestion | null> {
  const row = await prisma.execution_learnings.findUnique({ where: { id } })
  if (!row || row.learning_type !== 'healing_suggestion') return null
  return rowToSuggestion(row)
}

// Re-export HealOutput type for worker convenience
export type { HealOutput }
