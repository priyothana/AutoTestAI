/**
 * Learning Registry Service — Permanent Learning Loop
 *
 * Centralized store for all generation + execution learnings.
 * Uses the EXISTING `execution_learnings` table with new learning_type values —
 * no Prisma migration needed.
 *
 * Learning Types:
 *   button_mapping      — entity → correct button name (open vs submit)
 *   required_fields     — entity → list of required field labels
 *   generation_outcome  — test case generation pass/fail with failure reasons
 *   label_correction    — AI label → actual label corrections discovered at runtime
 *
 * Integration Points:
 *   - Test Step Generator Agent (reads past failures, button mappings, label corrections)
 *   - Orchestrator Agent (reads button mappings for pre-generation validation)
 *   - Execution Orchestrator (writes learnings after each execution)
 *   - Selector Registry (delegates button/field memory here)
 *   - Metadata Reader Tool (reads button mappings for autoCorrectButtonNames)
 *
 * @module learning-registry
 */
import prisma                 from '../../shared/db/prisma.js'
import { createModuleLogger } from '../../shared/logger/index.js'

const log = createModuleLogger('learning-registry')

// ─── Button Mapping ───────────────────────────────────────────────────────────

export interface ButtonMapping {
  openButton:   string | null
  submitButton: string | null
}

/**
 * Save a correct button name discovered during execution.
 * @param buttonType - 'open' for +New/Add buttons, 'submit' for Save/Create buttons
 */
export async function saveButtonMapping(
  projectId:  string,
  entityName: string,
  buttonName: string,
  buttonType: 'open' | 'submit',
): Promise<void> {
  try {
    const normalizedEntity = entityName.toLowerCase().trim()

    // Check if same mapping already exists (avoid duplicates)
    const existing = await prisma.execution_learnings.findFirst({
      where: {
        project_id:    projectId,
        learning_type: 'button_mapping',
        object_name:   normalizedEntity,
        field_type:    buttonType,
      },
      orderBy: { created_at: 'desc' },
    })

    if (existing?.correct_action === buttonName) {
      return  // Same mapping already stored
    }

    await prisma.execution_learnings.create({
      data: {
        project_id:       projectId,
        learning_type:    'button_mapping',
        object_name:      normalizedEntity,
        field_name:       `${normalizedEntity}_${buttonType}_button`,
        field_type:       buttonType,
        correct_action:   buttonName,
        action_attempted: existing?.correct_action ?? null,  // previous value (for history)
        extra_metadata: {
          entityName:  normalizedEntity,
          buttonType,
          buttonName,
          discoveredAt: new Date().toISOString(),
        } as object,
      },
    })

    log.info(
      `[LEARN-REG] ✅ Button mapping saved: ${normalizedEntity} → ${buttonType}="${buttonName}"`,
    )
  } catch (err) {
    log.warn({ err }, `[LEARN-REG] Failed to save button mapping (non-fatal)`)
  }
}

/**
 * Retrieve known correct button names for an entity.
 * Returns null values for unknown buttons.
 */
export async function getButtonMapping(
  projectId:  string,
  entityName: string,
): Promise<ButtonMapping> {
  const result: ButtonMapping = { openButton: null, submitButton: null }

  try {
    const normalizedEntity = entityName.toLowerCase().trim()

    const rows = await prisma.execution_learnings.findMany({
      where: {
        project_id:    projectId,
        learning_type: 'button_mapping',
        object_name:   normalizedEntity,
      },
      orderBy: { created_at: 'desc' },
      take:    10,
    })

    for (const row of rows) {
      const btnType = row.field_type
      const btnName = row.correct_action
      if (!btnName) continue

      if (btnType === 'open' && !result.openButton) {
        result.openButton = btnName
      } else if (btnType === 'submit' && !result.submitButton) {
        result.submitButton = btnName
      }

      if (result.openButton && result.submitButton) break
    }

    if (result.openButton || result.submitButton) {
      log.info(
        `[LEARN-REG] Button mapping loaded for "${normalizedEntity}": ` +
        `open="${result.openButton}", submit="${result.submitButton}"`,
      )
    }
  } catch (err) {
    log.warn({ err }, `[LEARN-REG] Failed to load button mapping (non-fatal)`)
  }

  return result
}

// ─── Required Fields ──────────────────────────────────────────────────────────

/**
 * Cache the list of required field labels for an entity after successful execution.
 */
export async function saveRequiredFields(
  projectId:  string,
  entityName: string,
  fields:     string[],
): Promise<void> {
  try {
    const normalizedEntity = entityName.toLowerCase().trim()

    await prisma.execution_learnings.create({
      data: {
        project_id:    projectId,
        learning_type: 'required_fields',
        object_name:   normalizedEntity,
        field_name:    `${normalizedEntity}_required_fields`,
        extra_metadata: {
          entityName: normalizedEntity,
          fields,
          fieldCount: fields.length,
          savedAt:    new Date().toISOString(),
        } as object,
      },
    })

    log.info(
      `[LEARN-REG] ✅ Required fields cached for "${normalizedEntity}": ${fields.length} fields`,
    )
  } catch (err) {
    log.warn({ err }, `[LEARN-REG] Failed to save required fields (non-fatal)`)
  }
}

/**
 * Retrieve cached required field labels for an entity.
 */
export async function getRequiredFields(
  projectId:  string,
  entityName: string,
): Promise<string[]> {
  try {
    const normalizedEntity = entityName.toLowerCase().trim()

    const row = await prisma.execution_learnings.findFirst({
      where: {
        project_id:    projectId,
        learning_type: 'required_fields',
        object_name:   normalizedEntity,
      },
      orderBy: { created_at: 'desc' },
    })

    if (!row) return []

    const meta = (row.extra_metadata ?? {}) as Record<string, unknown>
    const fields = meta.fields as string[] | undefined
    return fields ?? []
  } catch (err) {
    log.warn({ err }, `[LEARN-REG] Failed to load required fields (non-fatal)`)
    return []
  }
}

// ─── Generation Outcome ───────────────────────────────────────────────────────

export interface GenerationOutcome {
  testCaseId:   string
  testName:     string
  entityName:   string
  passed:       boolean
  failureReasons: string[]
  stepCount:    number
  timestamp:    string
}

/**
 * Record the outcome of a test step generation + execution cycle.
 */
export async function saveGenerationOutcome(
  projectId:  string,
  testCaseId: string,
  outcome: {
    testName:       string
    entityName:     string
    passed:         boolean
    failureReasons: string[]
    stepCount:      number
  },
): Promise<void> {
  try {
    const normalizedEntity = outcome.entityName.toLowerCase().trim()

    await prisma.execution_learnings.create({
      data: {
        project_id:       projectId,
        test_case_id:     testCaseId,
        learning_type:    'generation_outcome',
        object_name:      normalizedEntity,
        field_name:       outcome.testName.slice(0, 255),
        action_attempted: outcome.passed ? 'PASSED' : 'FAILED',
        failure_reason:   outcome.failureReasons.join('; ').slice(0, 2000) || null,
        extra_metadata: {
          testName:       outcome.testName,
          entityName:     normalizedEntity,
          passed:         outcome.passed,
          failureReasons: outcome.failureReasons,
          stepCount:      outcome.stepCount,
          recordedAt:     new Date().toISOString(),
        } as object,
      },
    })

    log.info(
      `[LEARN-REG] ${outcome.passed ? '✅' : '❌'} Generation outcome recorded: ` +
      `"${outcome.testName}" (${normalizedEntity}) — ${outcome.passed ? 'PASSED' : 'FAILED'}`,
    )
  } catch (err) {
    log.warn({ err }, `[LEARN-REG] Failed to save generation outcome (non-fatal)`)
  }
}

/**
 * Retrieve past failure patterns for an entity to inject into the LLM prompt.
 * Returns human-readable failure descriptions sorted by recency.
 */
export async function getPastFailures(
  projectId:  string,
  entityName: string,
  limit = 5,
): Promise<string[]> {
  try {
    const normalizedEntity = entityName.toLowerCase().trim()

    const rows = await prisma.execution_learnings.findMany({
      where: {
        project_id:       projectId,
        learning_type:    'generation_outcome',
        object_name:      normalizedEntity,
        action_attempted: 'FAILED',
      },
      orderBy: { created_at: 'desc' },
      take:    limit,
    })

    const failures: string[] = []
    for (const row of rows) {
      const meta = (row.extra_metadata ?? {}) as Record<string, unknown>
      const reasons = meta.failureReasons as string[] | undefined
      if (reasons && reasons.length > 0) {
        failures.push(
          `Test "${row.field_name}": ${reasons.slice(0, 3).join('; ')}`,
        )
      } else if (row.failure_reason) {
        failures.push(`Test "${row.field_name}": ${row.failure_reason.slice(0, 200)}`)
      }
    }

    if (failures.length > 0) {
      log.info(
        `[LEARN-REG] Loaded ${failures.length} past failures for "${normalizedEntity}"`,
      )
    }
    return failures
  } catch (err) {
    log.warn({ err }, `[LEARN-REG] Failed to load past failures (non-fatal)`)
    return []
  }
}

// ─── Label Correction ─────────────────────────────────────────────────────────

/**
 * Save a field label correction discovered during execution.
 * e.g., AI generated "Parent Company" but the real label is "Parent Account".
 */
export async function saveLabelCorrection(
  projectId:   string,
  aiLabel:     string,
  actualLabel: string,
  entityName?: string,
): Promise<void> {
  try {
    // Check for existing identical correction (avoid duplicates)
    const existing = await prisma.execution_learnings.findFirst({
      where: {
        project_id:    projectId,
        learning_type: 'label_correction',
        field_name:    aiLabel,
      },
      orderBy: { created_at: 'desc' },
    })

    if (existing?.correct_action === actualLabel) {
      return  // Same correction already stored
    }

    await prisma.execution_learnings.create({
      data: {
        project_id:     projectId,
        learning_type:  'label_correction',
        field_name:     aiLabel,
        correct_action: actualLabel,
        object_name:    entityName?.toLowerCase().trim() ?? null,
        extra_metadata: {
          aiLabel,
          actualLabel,
          entityName: entityName?.toLowerCase().trim() ?? null,
          correctedAt: new Date().toISOString(),
        } as object,
      },
    })

    log.info(
      `[LEARN-REG] ✅ Label correction saved: "${aiLabel}" → "${actualLabel}"` +
      (entityName ? ` (entity: ${entityName})` : ''),
    )
  } catch (err) {
    log.warn({ err }, `[LEARN-REG] Failed to save label correction (non-fatal)`)
  }
}

/**
 * Retrieve all known label corrections for a project.
 * Returns a Map<aiLabel, actualLabel> for efficient lookup.
 */
export async function getLabelCorrections(
  projectId: string,
): Promise<Map<string, string>> {
  const corrections = new Map<string, string>()

  try {
    const rows = await prisma.execution_learnings.findMany({
      where: {
        project_id:    projectId,
        learning_type: 'label_correction',
      },
      orderBy: { created_at: 'desc' },
      take:    100,
    })

    for (const row of rows) {
      const aiLabel = row.field_name
      if (!aiLabel || corrections.has(aiLabel)) continue
      if (row.correct_action) {
        corrections.set(aiLabel, row.correct_action)
      }
    }

    if (corrections.size > 0) {
      log.info(`[LEARN-REG] Loaded ${corrections.size} label corrections for project ${projectId}`)
    }
  } catch (err) {
    log.warn({ err }, `[LEARN-REG] Failed to load label corrections (non-fatal)`)
  }

  return corrections
}

/**
 * Format all learnings for injection into the LLM prompt.
 * Returns a single string block suitable for embedding in the system/user prompt.
 */
export async function formatLearningsForPrompt(
  projectId:  string,
  entityName: string,
): Promise<string> {
  const lines: string[] = []

  try {
    // 1. Past failures
    const failures = await getPastFailures(projectId, entityName)
    if (failures.length > 0) {
      lines.push('╔══════════════════════════════════════════════════════════════╗')
      lines.push('║  PAST LEARNINGS — MISTAKES TO NEVER REPEAT                  ║')
      lines.push('╚══════════════════════════════════════════════════════════════╝')
      for (const f of failures) {
        lines.push(`  ❌ ${f}`)
      }
      lines.push('')
    }

    // 2. Button mappings
    const buttons = await getButtonMapping(projectId, entityName)
    if (buttons.openButton || buttons.submitButton) {
      lines.push('╔══════════════════════════════════════════════════════════════╗')
      lines.push('║  KNOWN CORRECT BUTTON NAMES (from past executions)          ║')
      lines.push('╚══════════════════════════════════════════════════════════════╝')
      if (buttons.openButton) {
        lines.push(`  ✅ OPEN/NEW button: "${buttons.openButton}" — use this EXACTLY`)
      }
      if (buttons.submitButton) {
        lines.push(`  ✅ SUBMIT/CREATE button: "${buttons.submitButton}" — use this EXACTLY`)
      }
      lines.push('  ⚠️  These button names were confirmed by successful past executions.')
      lines.push('  ⚠️  Do NOT substitute "Save", "Submit", or any other name.')
      lines.push('')
    }

    // 3. Label corrections
    const corrections = await getLabelCorrections(projectId)
    if (corrections.size > 0) {
      lines.push('╔══════════════════════════════════════════════════════════════╗')
      lines.push('║  FIELD NAME CORRECTIONS (from past executions)              ║')
      lines.push('╚══════════════════════════════════════════════════════════════╝')
      let count = 0
      for (const [aiLabel, actualLabel] of corrections) {
        if (count >= 10) break
        lines.push(`  ❌ "${aiLabel}" → ✅ "${actualLabel}"`)
        count++
      }
      lines.push('  Use the ✅ CORRECTED names, not the ❌ wrong ones.')
      lines.push('')
    }

    // 4. Required fields from past successful executions
    const reqFields = await getRequiredFields(projectId, entityName)
    if (reqFields.length > 0) {
      lines.push('╔══════════════════════════════════════════════════════════════╗')
      lines.push('║  CONFIRMED REQUIRED FIELDS (from past executions)           ║')
      lines.push('╚══════════════════════════════════════════════════════════════╝')
      for (const f of reqFields) {
        lines.push(`  ★ "${f}"`)
      }
      lines.push('  These fields were confirmed required by successful past executions.')
      lines.push('')
    }
  } catch (err) {
    log.warn({ err }, `[LEARN-REG] formatLearningsForPrompt failed (non-fatal)`)
  }

  return lines.join('\n')
}
