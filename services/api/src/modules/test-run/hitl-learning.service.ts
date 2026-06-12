/**
 * HITL Learning Service
 *
 * Stores every human-in-the-loop decision (accept, reject, custom fix, skip, stop)
 * as an `execution_learnings` record with learning_type = 'hitl_decision'.
 *
 * These learnings are then injected into:
 *   - hitl.service.ts  — smarter first-message suggestions for the same error
 *   - test-step-generator.agent.ts — avoids known-bad steps during generation
 *   - healing-analyzer.agent.ts    — faster RCA with known fixes
 *
 * Schema: uses existing execution_learnings table
 *   learning_type    = 'hitl_decision'
 *   object_name      = step action  (e.g. 'LOOKUP')
 *   field_name       = step target  (e.g. 'ACCOUNT NAME *')
 *   action_attempted = stringified original step JSON
 *   correct_action   = applied fix description
 *   failure_reason   = error message
 *   extra_metadata   = { decision, userInput, updatedStep, outcome, stepNum, aiSuggestion }
 */
import prisma             from '../../shared/db/prisma.js'
import { createModuleLogger } from '../../shared/logger/index.js'

const log = createModuleLogger('hitl-learning')

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HitlDecision {
  projectId:    string
  testCaseId:   string
  testRunId:    string
  stepNum:      number
  errorMessage: string | null
  /** Original failing step JSON */
  originalStep: {
    action:       string
    target?:      string
    value?:       string
    locator_type?: string
  }
  /** AI's suggested action text (if any) */
  aiSuggestion?: string
  /** 'accept' | 'reject' | 'custom' | 'skip' | 'stop' */
  decision:      string
  /** What the user typed in the chat (for custom decisions) */
  userInput?:    string
  /** Updated step if user edited it (for accept/custom) */
  updatedStep?: {
    action:       string
    target?:      string
    value?:       string
    locator_type?: string
  }
  /** 'resume' | 'skip' | 'stop' */
  outcome:       string
}

export interface FormattedLearning {
  stepAction:   string
  stepTarget:   string
  errorMessage: string
  decision:     string
  fix:          string
  when:         string
}

// ── Save ──────────────────────────────────────────────────────────────────────

export async function saveHitlLearning(d: HitlDecision): Promise<void> {
  try {
    const appliedFix = d.updatedStep
      ? `Updated step to: ${d.updatedStep.action} "${d.updatedStep.target ?? ''}" = "${d.updatedStep.value ?? ''}"`
      : d.aiSuggestion
        ? `Accepted AI suggestion: ${d.aiSuggestion}`
        : d.userInput
          ? `User fix: ${d.userInput}`
          : `Decision: ${d.decision}`

    await prisma.execution_learnings.create({
      data: {
        project_id:       d.projectId,
        test_case_id:     d.testCaseId,
        test_run_id:      d.testRunId,
        learning_type:    'hitl_decision',
        object_name:      (d.originalStep.action ?? 'UNKNOWN').toUpperCase(),
        field_name:       d.originalStep.target ?? '',
        action_attempted: JSON.stringify(d.originalStep),
        correct_action:   appliedFix,
        failure_reason:   d.errorMessage ?? '',
        extra_metadata: {
          decision:     d.decision,
          userInput:    d.userInput ?? null,
          updatedStep:  d.updatedStep ?? null,
          outcome:      d.outcome,
          stepNum:      d.stepNum,
          aiSuggestion: d.aiSuggestion ?? null,
        },
      },
    })

    log.info(
      { projectId: d.projectId, testCaseId: d.testCaseId, decision: d.decision, outcome: d.outcome },
      '[HITL-LEARN] Saved learning record',
    )
  } catch (err) {
    log.warn({ err }, '[HITL-LEARN] Failed to save learning (non-fatal)')
  }
}

// ── Load ──────────────────────────────────────────────────────────────────────

/**
 * Load recent HITL learnings for a project (project-level scope).
 * Returns up to `limit` most recent records.
 */
export async function loadProjectLearnings(
  projectId:   string,
  limit        = 15,
): Promise<FormattedLearning[]> {
  try {
    const rows = await prisma.execution_learnings.findMany({
      where: {
        project_id:    projectId,
        learning_type: 'hitl_decision',
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    })
    return rows.map(formatRow)
  } catch (err) {
    log.warn({ err }, '[HITL-LEARN] loadProjectLearnings failed (non-fatal)')
    return []
  }
}

/**
 * Load recent HITL learnings for a specific test case (test-case-level scope).
 */
export async function loadTestCaseLearnings(
  testCaseId: string,
  limit       = 10,
): Promise<FormattedLearning[]> {
  try {
    const rows = await prisma.execution_learnings.findMany({
      where: {
        test_case_id:  testCaseId,
        learning_type: 'hitl_decision',
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    })
    return rows.map(formatRow)
  } catch (err) {
    log.warn({ err }, '[HITL-LEARN] loadTestCaseLearnings failed (non-fatal)')
    return []
  }
}

/**
 * Load both project-level and test-case-level learnings, deduplicated.
 */
export async function loadLearnings(
  projectId:  string,
  testCaseId: string,
): Promise<FormattedLearning[]> {
  const [projectLearnings, tcLearnings] = await Promise.all([
    loadProjectLearnings(projectId, 12),
    loadTestCaseLearnings(testCaseId, 8),
  ])
  // Test-case learnings first (most specific), then project learnings
  const seen = new Set<string>()
  const merged: FormattedLearning[] = []
  for (const l of [...tcLearnings, ...projectLearnings]) {
    const key = `${l.stepAction}|${l.stepTarget}|${l.errorMessage}`
    if (!seen.has(key)) { seen.add(key); merged.push(l) }
  }
  return merged.slice(0, 15)
}

// ── Format for LLM prompt ─────────────────────────────────────────────────────

/**
 * Format learnings as a markdown block suitable for injection into LLM prompts.
 */
export function formatLearningsBlock(learnings: FormattedLearning[]): string {
  if (learnings.length === 0) return ''

  const lines = learnings.map((l, i) =>
    `${i + 1}. Step: ${l.stepAction} "${l.stepTarget}"\n` +
    `   Error: ${l.errorMessage || 'unknown'}\n` +
    `   Decision: ${l.decision} → Fix: ${l.fix}`
  )

  return [
    '⚠️  PAST HITL LEARNINGS — apply these to avoid known failures:',
    '─'.repeat(60),
    ...lines,
    '─'.repeat(60),
    'These are REAL fixes that worked in previous test runs. Use them.',
  ].join('\n')
}

// ── Field-type corrections ────────────────────────────────────────────────────

export interface FieldTypeCorrection {
  fieldTarget:   string   // e.g. "ACCOUNT NAME *"
  wrongAction:   string   // e.g. "LOOKUP"
  correctAction: string   // e.g. "TYPE"
  fix:           string   // human-readable description of the confirmed fix
}

/**
 * Queries execution_learnings for HITL decisions where the user changed the
 * step's action type (e.g., LOOKUP → TYPE). These corrections must override
 * the field manifest during test generation to prevent repeated failures.
 */
export async function extractFieldTypeCorrections(
  projectId:  string,
  testCaseId: string,
  limit       = 20,
): Promise<FieldTypeCorrection[]> {
  try {
    const rows = await prisma.execution_learnings.findMany({
      where: {
        project_id:    projectId,
        learning_type: 'hitl_decision',
      },
      orderBy: { created_at: 'desc' },
      take:    limit,
    })

    const corrections: FieldTypeCorrection[] = []
    const seen = new Set<string>()

    for (const row of rows) {
      const meta = (row.extra_metadata ?? {}) as Record<string, unknown>
      const updatedStep  = meta['updatedStep']  as Record<string, string> | null
      const originalStep = JSON.parse(row.action_attempted ?? '{}') as Record<string, string>

      if (!updatedStep) continue

      const wrongAction   = (originalStep['action']  ?? '').toUpperCase()
      const correctAction = (updatedStep['action']    ?? '').toUpperCase()
      const fieldTarget   = (originalStep['target']   ?? row.field_name ?? '').trim()

      // Only capture corrections where the action TYPE changed (e.g. LOOKUP→TYPE)
      if (!wrongAction || !correctAction || wrongAction === correctAction) continue
      if (!fieldTarget) continue

      // Deduplicate by field target + correct action (keep most recent)
      const key = `${fieldTarget.toLowerCase()}|${correctAction}`
      if (seen.has(key)) continue
      seen.add(key)

      corrections.push({
        fieldTarget,
        wrongAction,
        correctAction,
        fix: row.correct_action ?? `Use ${correctAction} instead of ${wrongAction}`,
      })
    }

    // Also include test-case-level corrections if projectId differs
    if (testCaseId) {
      const tcRows = await prisma.execution_learnings.findMany({
        where: {
          test_case_id:  testCaseId,
          learning_type: 'hitl_decision',
        },
        orderBy: { created_at: 'desc' },
        take:    10,
      })

      for (const row of tcRows) {
        const meta = (row.extra_metadata ?? {}) as Record<string, unknown>
        const updatedStep  = meta['updatedStep']  as Record<string, string> | null
        const originalStep = JSON.parse(row.action_attempted ?? '{}') as Record<string, string>

        if (!updatedStep) continue

        const wrongAction   = (originalStep['action']  ?? '').toUpperCase()
        const correctAction = (updatedStep['action']    ?? '').toUpperCase()
        const fieldTarget   = (originalStep['target']   ?? row.field_name ?? '').trim()

        if (!wrongAction || !correctAction || wrongAction === correctAction || !fieldTarget) continue

        const key = `${fieldTarget.toLowerCase()}|${correctAction}`
        if (seen.has(key)) continue
        seen.add(key)

        corrections.push({ fieldTarget, wrongAction, correctAction,
          fix: row.correct_action ?? `Use ${correctAction} instead of ${wrongAction}` })
      }
    }

    return corrections
  } catch (err) {
    log.warn({ err }, '[HITL-LEARN] extractFieldTypeCorrections failed (non-fatal)')
    return []
  }
}

/**
 * Formats field-type corrections as a 🚨 CRITICAL OVERRIDES block.
 * Placed at the TOP of the generation prompt, BEFORE the field manifest,
 * so these hard rules take priority over any manifest-derived field types.
 */
export function formatFieldTypeCorrectionsBlock(corrections: FieldTypeCorrection[]): string {
  if (corrections.length === 0) return ''

  const lines = corrections.map(c =>
    `  ⛔ FIELD "${c.fieldTarget}": A human confirmed this is a ${c.correctAction} field, NOT ${c.wrongAction}.\n` +
    `     → MANDATORY: use action: ${c.correctAction}  |  DO NOT use ${c.wrongAction} for this field.\n` +
    `     → Fix applied: ${c.fix}`
  )

  return [
    '🚨 CRITICAL OVERRIDES FROM PAST HUMAN CORRECTIONS — THESE OVERRIDE THE FIELD MANIFEST:',
    '═'.repeat(70),
    'A human tester identified the following field-type mistakes in a previous run.',
    'These corrections MUST be applied. They OVERRIDE any manifest type or LLM assumption.',
    '',
    ...lines,
    '',
    '═'.repeat(70),
    '🔴 ENFORCE THESE RULES STRICTLY — ignoring them will cause the same test failure again.',
  ].join('\n')
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function formatRow(row: {
  object_name:      string | null
  field_name:       string | null
  failure_reason:   string | null
  correct_action:   string | null
  extra_metadata:   unknown
  created_at:       Date
}): FormattedLearning {
  const meta = (row.extra_metadata ?? {}) as Record<string, unknown>
  return {
    stepAction:   row.object_name   ?? 'UNKNOWN',
    stepTarget:   row.field_name    ?? '',
    errorMessage: row.failure_reason ?? '',
    decision:     String(meta['decision'] ?? 'unknown'),
    fix:          row.correct_action ?? '',
    when:         row.created_at.toISOString(),
  }
}
