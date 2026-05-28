/**
 * Locator History Service — Self-Healing Foundation
 *
 * Persists and retrieves successful locator strategies per field/button,
 * enabling the execution engine to learn from past runs.
 *
 * Uses the existing `execution_learnings` table (no migration needed):
 *   learning_type = 'locator_success' — records which locator strategy worked
 *   learning_type = 'field_mapping'   — records AI label → actual label corrections
 *
 * Key functions:
 *   saveLocatorSuccess()  — called after a step passes to record the working locator
 *   getBestLocator()      — retrieves the most recent successful locator for a field
 *   loadLocatorHistory()  — bulk-loads all locator hints for a project (used at exec start)
 *   saveFieldMapping()    — records "Contact Name" → "Full Name" corrections
 *   getFieldMapping()     — retrieves a known label mapping
 *   loadFieldMappings()   — bulk-loads all field mappings for a project
 *
 * Retention: entries are kept indefinitely; queries order by created_at DESC
 * and take the most recent entry, so stale entries are naturally deprioritized.
 *
 * Cross-module boundary: only .service.ts files are importable externally.
 */
import prisma from '../../shared/db/prisma.js'
import { createModuleLogger } from '../../shared/logger/index.js'

const log = createModuleLogger('locator-history')

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LocatorHint {
  /** The locator expression that worked (e.g. "getByLabel('Full Name')") */
  locatorStrategy: string
  /** Which numbered strategy in the cascade resolved it (for metrics) */
  strategyIndex: number
  /** The page URL where this locator was used */
  pageUrl: string
  /** The detected DOM field type (text, select, autocomplete, etc.) */
  detectedType: string | null
  /** The actual label found on the page (after correction) */
  actualLabel: string
  /** When this locator was last used successfully */
  lastUsedAt: Date

  // ── Layer 4: Selector Registry extensions (optional — all default to safe values) ──

  /**
   * Current health state from the SelectorRegistry state machine.
   * HEALTHY (default) | DEGRADED | BROKEN | QUARANTINE
   * When QUARANTINE the orchestrator skips this hint and uses fallback.
   */
  selectorHealth?: 'HEALTHY' | 'DEGRADED' | 'BROKEN' | 'QUARANTINE'

  /**
   * How many consecutive failures this selector has had without a success.
   * Populated from selector_registry.consecutive_failures.
   */
  consecutiveFailures?: number

  /**
   * Semantic intent description for the Intent-Cache-Heal pattern.
   * e.g. "Account Name required text input field on contact create form"
   * Used to re-resolve the selector via LLM when it becomes BROKEN.
   */
  intentDescription?: string
}

export interface FieldMapping {
  /** The AI-generated label that was corrected */
  aiLabel: string
  /** The actual label found on the page */
  actualLabel: string
  /** The page URL where this mapping was discovered */
  pageUrl: string
  /** When this mapping was last confirmed */
  lastConfirmedAt: Date
}

// ─── Save Operations ──────────────────────────────────────────────────────────

/**
 * Record a successful locator strategy after a step passes.
 * Called by the execution worker after each successful interaction.
 */
export async function saveLocatorSuccess(
  projectId: string,
  fieldName: string,
  locatorStrategy: string,
  metadata: {
    pageUrl: string
    strategyIndex: number
    detectedType?: string | null
    actualLabel?: string
    executionId?: string
  },
): Promise<void> {
  try {
    await prisma.execution_learnings.create({
      data: {
        project_id:      projectId,
        learning_type:   'locator_success',
        field_name:      fieldName,
        correct_action:  locatorStrategy,
        extra_metadata: {
          pageUrl:       metadata.pageUrl,
          strategyIndex: metadata.strategyIndex,
          detectedType:  metadata.detectedType ?? null,
          actualLabel:   metadata.actualLabel ?? fieldName,
          executionId:   metadata.executionId ?? null,
        } as object,
      },
    })
    log.info(
      `[LOCATOR-HISTORY] Saved success: "${fieldName}" → strategy #${metadata.strategyIndex} ` +
      `("${locatorStrategy.substring(0, 60)}")`,
    )
  } catch (err) {
    // Non-fatal — don't break execution for history persistence
    log.warn({ err }, `[LOCATOR-HISTORY] Failed to save locator success for "${fieldName}"`)
  }
}

/**
 * Record a field label mapping (AI label → actual label).
 * Called when `correctWebAppLabel()` finds a different label on the page.
 */
export async function saveFieldMapping(
  projectId: string,
  aiLabel: string,
  actualLabel: string,
  pageUrl: string,
): Promise<void> {
  try {
    // Upsert: check if mapping already exists
    const existing = await prisma.execution_learnings.findFirst({
      where: {
        project_id:    projectId,
        learning_type: 'field_mapping',
        field_name:    aiLabel,
      },
      orderBy: { created_at: 'desc' },
    })

    if (existing) {
      const meta = (existing.extra_metadata ?? {}) as Record<string, unknown>
      if (meta.actualLabel === actualLabel) {
        // Same mapping — skip duplicate
        return
      }
    }

    await prisma.execution_learnings.create({
      data: {
        project_id:     projectId,
        learning_type:  'field_mapping',
        field_name:     aiLabel,
        correct_action: actualLabel,
        extra_metadata: {
          aiLabel,
          actualLabel,
          pageUrl,
        } as object,
      },
    })
    log.info(`[LOCATOR-HISTORY] Saved field mapping: "${aiLabel}" → "${actualLabel}"`)
  } catch (err) {
    log.warn({ err }, `[LOCATOR-HISTORY] Failed to save field mapping "${aiLabel}" → "${actualLabel}"`)
  }
}

// ─── Read Operations ──────────────────────────────────────────────────────────

/**
 * Retrieve the best known locator for a specific field.
 * Returns the most recently successful locator strategy.
 */
export async function getBestLocator(
  projectId: string,
  fieldName: string,
): Promise<LocatorHint | null> {
  try {
    const row = await prisma.execution_learnings.findFirst({
      where: {
        project_id:    projectId,
        learning_type: 'locator_success',
        field_name:    fieldName,
      },
      orderBy: { created_at: 'desc' },
    })

    if (!row || !row.correct_action) return null

    const meta = (row.extra_metadata ?? {}) as Record<string, unknown>
    return {
      locatorStrategy: row.correct_action,
      strategyIndex:   typeof meta.strategyIndex === 'number' ? meta.strategyIndex : 99,
      pageUrl:         typeof meta.pageUrl === 'string' ? meta.pageUrl : '',
      detectedType:    typeof meta.detectedType === 'string' ? meta.detectedType : null,
      actualLabel:     typeof meta.actualLabel === 'string' ? meta.actualLabel : fieldName,
      lastUsedAt:      row.created_at,
    }
  } catch (err) {
    log.warn({ err }, `[LOCATOR-HISTORY] Failed to get best locator for "${fieldName}"`)
    return null
  }
}

/**
 * Retrieve a known field label mapping.
 * Returns the actual label if a mapping exists, null otherwise.
 */
export async function getFieldMapping(
  projectId: string,
  aiLabel: string,
): Promise<string | null> {
  try {
    const row = await prisma.execution_learnings.findFirst({
      where: {
        project_id:    projectId,
        learning_type: 'field_mapping',
        field_name:    aiLabel,
      },
      orderBy: { created_at: 'desc' },
    })

    return row?.correct_action ?? null
  } catch (err) {
    log.warn({ err }, `[LOCATOR-HISTORY] Failed to get field mapping for "${aiLabel}"`)
    return null
  }
}

// ─── Bulk Load Operations (for execution start) ───────────────────────────────

/**
 * Bulk-load all locator hints for a project.
 * Returns a Map<fieldName, LocatorHint> with only the most recent entry per field.
 */
export async function loadLocatorHistory(
  projectId: string,
): Promise<Map<string, LocatorHint>> {
  const hints = new Map<string, LocatorHint>()

  try {
    const rows = await prisma.execution_learnings.findMany({
      where: {
        project_id:    projectId,
        learning_type: 'locator_success',
      },
      orderBy: { created_at: 'desc' },
    })

    // Group by field_name — take the most recent (already sorted DESC)
    for (const row of rows) {
      const fieldName = row.field_name
      if (!fieldName || hints.has(fieldName)) continue

      const meta = (row.extra_metadata ?? {}) as Record<string, unknown>
      hints.set(fieldName, {
        locatorStrategy: row.correct_action ?? '',
        strategyIndex:   typeof meta.strategyIndex === 'number' ? meta.strategyIndex : 99,
        pageUrl:         typeof meta.pageUrl === 'string' ? meta.pageUrl : '',
        detectedType:    typeof meta.detectedType === 'string' ? meta.detectedType : null,
        actualLabel:     typeof meta.actualLabel === 'string' ? meta.actualLabel : fieldName,
        lastUsedAt:      row.created_at,
      })
    }

    log.info(`[LOCATOR-HISTORY] Loaded ${hints.size} locator hints for project ${projectId}`)
  } catch (err) {
    log.warn({ err }, '[LOCATOR-HISTORY] Failed to load locator history — starting fresh')
  }

  return hints
}

/**
 * Bulk-load all field label mappings for a project.
 * Returns a Map<aiLabel, actualLabel>.
 */
export async function loadFieldMappings(
  projectId: string,
): Promise<Map<string, string>> {
  const mappings = new Map<string, string>()

  try {
    const rows = await prisma.execution_learnings.findMany({
      where: {
        project_id:    projectId,
        learning_type: 'field_mapping',
      },
      orderBy: { created_at: 'desc' },
    })

    for (const row of rows) {
      const aiLabel = row.field_name
      if (!aiLabel || mappings.has(aiLabel)) continue
      if (row.correct_action) {
        mappings.set(aiLabel, row.correct_action)
      }
    }

    log.info(`[LOCATOR-HISTORY] Loaded ${mappings.size} field mappings for project ${projectId}`)
  } catch (err) {
    log.warn({ err }, '[LOCATOR-HISTORY] Failed to load field mappings — starting fresh')
  }

  return mappings
}
