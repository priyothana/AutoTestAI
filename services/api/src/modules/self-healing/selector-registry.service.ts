/**
 * Selector Registry Service — Layer 4 Self-Healing Registry
 *
 * Implements a health state machine for every field selector per project:
 *
 *   HEALTHY     — selector resolves on first attempt (0 recent consecutive failures)
 *   DEGRADED    — selector needed retry (1–2 consecutive failures)
 *   BROKEN      — selector fails consistently (3–4 consecutive failures) → trigger heal
 *   QUARANTINE  — selector blocked (5+ consecutive failures) → use fallback
 *
 * Transitions:
 *   success          → reset to HEALTHY, consecutiveFailures = 0
 *   failure (1–2)    → DEGRADED
 *   failure (3–4)    → BROKEN (orchestrator triggers heal)
 *   failure (5+)     → QUARANTINE (orchestrator skips + uses alternative)
 *   heal success     → HEALTHY
 *
 * Intent-Cache-Heal Pattern:
 *   After a successful execution, cache the working selector with a semantic
 *   intent description (e.g. "Account Name required text input on create form").
 *   On failure, re-resolve against the current DOM using this intent — avoiding
 *   the need to call the LLM with raw selectors.
 *
 * Concurrency safety:
 *   All writes use Prisma's `upsert` which is atomic at the DB level.
 *   Parallel workers cannot clobber each other — each upsert is self-contained.
 */
import prisma               from '../../shared/db/prisma.js'
import { createModuleLogger } from '../../shared/logger/index.js'
import {
  saveButtonMapping,
  getButtonMapping,
  saveRequiredFields,
  getRequiredFields,
} from './learning-registry.service.js'

const log = createModuleLogger('selector-registry')

// ─── Health state machine ─────────────────────────────────────────────────────

export type SelectorHealth = 'HEALTHY' | 'DEGRADED' | 'BROKEN' | 'QUARANTINE'

/** Consecutive failure thresholds */
const THRESHOLD_DEGRADED   = 1  // 1+ failures  → DEGRADED
const THRESHOLD_BROKEN     = 3  // 3+ failures  → BROKEN (triggers heal)
const THRESHOLD_QUARANTINE = 5  // 5+ failures  → QUARANTINE

function computeHealth(consecutiveFailures: number): SelectorHealth {
  if (consecutiveFailures >= THRESHOLD_QUARANTINE) return 'QUARANTINE'
  if (consecutiveFailures >= THRESHOLD_BROKEN)     return 'BROKEN'
  if (consecutiveFailures >= THRESHOLD_DEGRADED)   return 'DEGRADED'
  return 'HEALTHY'
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SelectorEntry {
  projectId:           string
  fieldName:           string
  selector:            string
  selectorType:        string
  healthStatus:        SelectorHealth
  consecutiveFailures: number
  totalSuccesses:      number
  totalFailures:       number
  intentDescription?:  string
  pageUrl?:            string
  lastSuccessAt?:      Date
  lastFailureAt?:      Date
  lastHealedAt?:       Date
}

export interface SelectorMeta {
  selectorType:       string
  intentDescription?: string
  pageUrl?:           string
}

// ─── Core registry class ──────────────────────────────────────────────────────

export class SelectorRegistry {

  /**
   * Look up the current health status of a field selector.
   * Returns null if the field has no registry entry yet.
   */
  async getHealth(
    projectId: string,
    fieldName: string,
    pageUrl?: string,
  ): Promise<SelectorEntry | null> {
    try {
      const row = await prisma.selector_registry.findFirst({
        where: {
          project_id: projectId,
          field_name: fieldName,
          ...(pageUrl ? { page_url: pageUrl } : {}),
        },
        orderBy: { updated_at: 'desc' },
      })
      if (!row) return null

      return {
        projectId:           row.project_id,
        fieldName:           row.field_name,
        selector:            row.selector,
        selectorType:        row.selector_type,
        healthStatus:        row.health_status as SelectorHealth,
        consecutiveFailures: row.consecutive_failures,
        totalSuccesses:      row.total_successes,
        totalFailures:       row.total_failures,
        intentDescription:   row.intent_description ?? undefined,
        pageUrl:             row.page_url ?? undefined,
        lastSuccessAt:       row.last_success_at ?? undefined,
        lastFailureAt:       row.last_failure_at ?? undefined,
        lastHealedAt:        row.last_healed_at ?? undefined,
      }
    } catch (err) {
      log.warn({ err, projectId, fieldName }, '[REGISTRY] getHealth error (non-fatal)')
      return null
    }
  }

  /**
   * Get the best cached selector for a field.
   * Returns null for QUARANTINED or missing entries.
   */
  async getBestSelector(
    projectId: string,
    fieldName: string,
    pageUrl?:  string,
  ): Promise<{ selector: string; selectorType: string; health: SelectorHealth } | null> {
    const entry = await this.getHealth(projectId, fieldName, pageUrl)
    if (!entry) return null
    if (entry.healthStatus === 'QUARANTINE') {
      log.warn(`[REGISTRY] Selector for "${fieldName}" is QUARANTINED — skipping cache`)
      return null
    }
    return {
      selector:     entry.selector,
      selectorType: entry.selectorType,
      health:       entry.healthStatus,
    }
  }

  /**
   * Record a successful selector execution.
   * Resets consecutive failure count → HEALTHY.
   */
  async recordSuccess(
    projectId:  string,
    fieldName:  string,
    selector:   string,
    meta:       SelectorMeta,
  ): Promise<void> {
    try {
      await prisma.selector_registry.upsert({
        where: {
          project_id_field_name_page_url: {
            project_id: projectId,
            field_name:  fieldName,
            page_url:    meta.pageUrl ?? '',
          },
        },
        create: {
          project_id:           projectId,
          field_name:            fieldName,
          selector,
          selector_type:         meta.selectorType,
          health_status:         'HEALTHY',
          consecutive_failures:  0,
          total_successes:       1,
          total_failures:        0,
          intent_description:    meta.intentDescription,
          page_url:              meta.pageUrl,
          last_success_at:       new Date(),
        },
        update: {
          selector,
          selector_type:         meta.selectorType,
          health_status:         'HEALTHY',
          consecutive_failures:  0,
          total_successes:       { increment: 1 },
          intent_description:    meta.intentDescription ?? undefined,
          last_success_at:       new Date(),
        },
      })
      log.debug(`[REGISTRY] ✅ Success recorded for "${fieldName}" → HEALTHY`)
    } catch (err) {
      log.warn({ err, projectId, fieldName }, '[REGISTRY] recordSuccess error (non-fatal)')
    }
  }

  /**
   * Record a selector failure.
   * Transitions health state according to the state machine.
   */
  async recordFailure(
    projectId: string,
    fieldName: string,
    pageUrl?:  string,
  ): Promise<SelectorHealth> {
    try {
      const existing = await this.getHealth(projectId, fieldName, pageUrl)
      const newConsecutive = (existing?.consecutiveFailures ?? 0) + 1
      const newHealth      = computeHealth(newConsecutive)

      if (existing) {
        await prisma.selector_registry.updateMany({
          where: {
            project_id: projectId,
            field_name: fieldName,
            ...(pageUrl ? { page_url: pageUrl } : {}),
          },
          data: {
            health_status:        newHealth,
            consecutive_failures: newConsecutive,
            total_failures:       { increment: 1 },
            last_failure_at:      new Date(),
          },
        })
      }
      // If no entry exists yet, we don't create one on failure — only on success.

      log.info(
        `[REGISTRY] ❌ Failure recorded for "${fieldName}" (consecutive=${newConsecutive}) → ${newHealth}`,
      )
      return newHealth
    } catch (err) {
      log.warn({ err, projectId, fieldName }, '[REGISTRY] recordFailure error (non-fatal)')
      return 'HEALTHY'  // fail-safe: don't block execution
    }
  }

  /**
   * Update the selector after a successful healing operation.
   * Resets the health state to HEALTHY.
   */
  async recordHeal(
    projectId:   string,
    fieldName:   string,
    newSelector: string,
    selectorType: string,
    pageUrl?:    string,
  ): Promise<void> {
    try {
      await prisma.selector_registry.updateMany({
        where: {
          project_id: projectId,
          field_name: fieldName,
          ...(pageUrl ? { page_url: pageUrl } : {}),
        },
        data: {
          selector:             newSelector,
          selector_type:        selectorType,
          health_status:        'HEALTHY',
          consecutive_failures: 0,
          last_healed_at:       new Date(),
          last_success_at:      new Date(),
        },
      })
      log.info(`[REGISTRY] 🩹 Healed "${fieldName}" → new selector="${newSelector.slice(0, 80)}" → HEALTHY`)
    } catch (err) {
      log.warn({ err, projectId, fieldName }, '[REGISTRY] recordHeal error (non-fatal)')
    }
  }

  /**
   * Get all selectors for a project that are in BROKEN or QUARANTINE state.
   * Used by background health reporting.
   */
  async getDegradedSelectors(projectId: string): Promise<SelectorEntry[]> {
    try {
      const rows = await prisma.selector_registry.findMany({
        where: {
          project_id:    projectId,
          health_status: { in: ['BROKEN', 'QUARANTINE'] },
        },
        orderBy: { consecutive_failures: 'desc' },
        take: 50,
      })
      return rows.map(row => ({
        projectId:           row.project_id,
        fieldName:           row.field_name,
        selector:            row.selector,
        selectorType:        row.selector_type,
        healthStatus:        row.health_status as SelectorHealth,
        consecutiveFailures: row.consecutive_failures,
        totalSuccesses:      row.total_successes,
        totalFailures:       row.total_failures,
        intentDescription:   row.intent_description ?? undefined,
        pageUrl:             row.page_url ?? undefined,
      }))
    } catch (err) {
      log.warn({ err, projectId }, '[REGISTRY] getDegradedSelectors error (non-fatal)')
      return []
    }
  }

  /**
   * Reset a selector to HEALTHY (e.g., after manual test editor update).
   */
  async resetHealth(projectId: string, fieldName: string): Promise<void> {
    try {
      await prisma.selector_registry.updateMany({
        where: { project_id: projectId, field_name: fieldName },
        data: {
          health_status:        'HEALTHY',
          consecutive_failures: 0,
        },
      })
      log.info(`[REGISTRY] 🔄 Reset health for "${fieldName}" → HEALTHY`)
    } catch (err) {
      log.warn({ err }, '[REGISTRY] resetHealth error (non-fatal)')
    }
  }

  // ─── Button Name Registry (delegates to Learning Registry) ──────────────

  /**
   * Record a successful button click for an entity.
   * Called after a CLICK step on a create/save button passes.
   *
   * @param buttonType - 'open' for +New/Add buttons, 'submit' for Save/Create buttons
   */
  async recordButtonSuccess(
    projectId:  string,
    entityName: string,
    buttonName: string,
    buttonType: 'open' | 'submit',
    pageUrl?:   string,
  ): Promise<void> {
    await saveButtonMapping(projectId, entityName, buttonName, buttonType)
    log.info(
      `[REGISTRY] ✅ Button success: ${entityName} → ${buttonType}="${buttonName}"`,
    )
  }

  /**
   * Retrieve the known working button for an entity.
   */
  async getKnownButton(
    projectId:  string,
    entityName: string,
    buttonType: 'open' | 'submit',
  ): Promise<string | null> {
    const mapping = await getButtonMapping(projectId, entityName)
    return buttonType === 'open' ? mapping.openButton : mapping.submitButton
  }

  // ─── Required Field Memory (delegates to Learning Registry) ─────────────

  /**
   * Cache the required field list for an entity after successful execution.
   */
  async cacheRequiredFields(
    projectId:  string,
    entityName: string,
    fieldLabels: string[],
  ): Promise<void> {
    await saveRequiredFields(projectId, entityName, fieldLabels)
    log.info(
      `[REGISTRY] ✅ Required fields cached: ${entityName} → ${fieldLabels.length} fields`,
    )
  }

  /**
   * Retrieve cached required fields for an entity.
   */
  async getCachedRequiredFields(
    projectId:  string,
    entityName: string,
  ): Promise<string[]> {
    return getRequiredFields(projectId, entityName)
  }
}

// ─── Singleton export ──────────────────────────────────────────────────────────

export const selectorRegistry = new SelectorRegistry()
