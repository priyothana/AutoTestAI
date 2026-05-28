#!/usr/bin/env tsx
/**
 * Universal Canonical Required-Fields Migration
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Patches metadata_canonical.form_fields, required_fields, optional_fields
 * across ALL projects and ALL entities using a multi-signal heuristic approach.
 *
 * DETECTION STRATEGY (applied in order, additive — never removes required=true):
 *
 *   Signal 1 — REQUIRED_FIELD_OVERRIDE_MAP
 *     Code-level truth: known-required fields per entity type (Currency for
 *     Product, Stage/Close Date for Opportunity, etc.). Applied universally.
 *
 *   Signal 2 — metadata_normalized HTML attributes
 *     Re-reads the original crawl data. If the crawler stored required=true on
 *     an input/select, re-applies it to the canonical record even if it was
 *     lost during an earlier canonical build.
 *
 *   Signal 3 — Salesforce schema (nillable=false / required=true)
 *     For Salesforce projects: re-reads metadata_normalized entity_type='field'
 *     rows and applies required=true wherever the schema says so.
 *
 *   Signal 4 — execution_learnings
 *     Fields that have been observed as "required" in past executions
 *     (learning_type='required_field') are also marked required.
 *
 * SAFE TO RE-RUN: Idempotent. Already-correct records are not double-counted.
 * Run time: O(projects × entities) — typically < 5 seconds for small orgs.
 *
 * Usage:
 *   npx tsx services/api/src/scripts/fix-canonical-required-fields.ts
 */

import prisma from '../shared/db/prisma.js'
import { createModuleLogger } from '../shared/logger/index.js'
import { REQUIRED_FIELD_OVERRIDE_MAP, applyRequiredFieldOverrides } from '../modules/ai-agents/tools/metadata-reader.tool.js'
import type { FieldEntry } from '../modules/ai-agents/agent.types.js'

const log = createModuleLogger('canonical-required-fix')

// ─── Types ────────────────────────────────────────────────────────────────────

interface CanonicalFieldRaw {
  label:       string
  type?:       string
  required?:   boolean
  options?:    string[]
  sample_value?: string
  locator_type?: string
  api_name?:   string
}

// ─── Helper: normalize entity name for override map lookup ────────────────────

function normalizeEntityKey(entityName: string): string {
  return entityName.toLowerCase().trim()
    .replace(/ies$/, 'y')
    .replace(/ses$/, 's')
    .replace(/s$/, '')
    .trim()
}

// ─── Main migration function ──────────────────────────────────────────────────

async function fixCanonicalRequiredFields(): Promise<void> {
  log.info('[FIX] Starting universal canonical required-fields migration')

  // ── Load all canonical records ────────────────────────────────────────────
  const canonicalRows = await (prisma as any).$queryRaw<Array<{
    id:              string
    project_id:      string
    entity_name:     string
    entity_type:     string
    form_fields:     unknown
    required_fields: unknown
    optional_fields: unknown
  }>>`
    SELECT id, project_id, entity_name, entity_type, form_fields, required_fields, optional_fields
    FROM metadata_canonical
    ORDER BY entity_name
  `

  log.info(`[FIX] Found ${canonicalRows.length} canonical records to process`)

  // ── Load metadata_normalized crawl data (Signal 2) ───────────────────────
  // Build a map: (project_id, entity_name_lower) → Set<field_label_lower>
  // where the field was marked required in the original HTML crawl data.
  const crawlRequiredFields = new Map<string, Set<string>>()
  try {
    const normalizedRows = await prisma.metadata_normalized.findMany({
      where:  { entity_type: 'webapp_crawl' },
      select: { project_id: true, structured_json: true },
      take:   500,
    })
    for (const row of normalizedRows) {
      const data = (row.structured_json ?? {}) as {
        pages?: Array<{
          inputs?:  Array<{ locator?: string; required?: boolean }>
          selects?: Array<{ locator?: string; required?: boolean }>
        }>
      }
      for (const page of data.pages ?? []) {
        for (const inp of [...(page.inputs ?? []), ...(page.selects ?? [])]) {
          if (inp.required && inp.locator) {
            const key = `${row.project_id}::${inp.locator.toLowerCase().trim()}`
            if (!crawlRequiredFields.has(key)) crawlRequiredFields.set(key, new Set())
            crawlRequiredFields.get(key)!.add(inp.locator.toLowerCase().trim())
          }
        }
      }
    }
    log.info(`[FIX] Signal 2 (crawl): built required-field map with ${crawlRequiredFields.size} entries`)
  } catch (err) {
    log.warn({ err }, '[FIX] Signal 2 (crawl): failed to load metadata_normalized — skipping')
  }

  // ── Load Salesforce field required flags (Signal 3) ───────────────────────
  // Build: (project_id, label_lower) → true
  const sfRequiredFields = new Map<string, boolean>()
  try {
    const sfFieldRows = await prisma.metadata_normalized.findMany({
      where:  { entity_type: 'field' },
      select: { project_id: true, label: true, structured_json: true },
      take:   5000,
    })
    for (const row of sfFieldRows) {
      if (!row.label) continue
      const json = (row.structured_json ?? {}) as Record<string, unknown>
      const isRequired = Boolean(json.required) || json.nillable === false
      if (isRequired) {
        const key = `${row.project_id}::${row.label.toLowerCase().trim()}`
        sfRequiredFields.set(key, true)
      }
    }
    log.info(`[FIX] Signal 3 (Salesforce): found ${sfRequiredFields.size} required fields in schema`)
  } catch (err) {
    log.warn({ err }, '[FIX] Signal 3 (Salesforce): failed to load field metadata — skipping')
  }

  // ── Load execution learning required-field signals (Signal 4) ────────────
  const learnedRequiredFields = new Map<string, Set<string>>()
  try {
    const learnings = await prisma.execution_learnings.findMany({
      where:  { learning_type: 'required_field' },
      select: { project_id: true, field_name: true },
      take:   1000,
    })
    for (const l of learnings) {
      if (!l.field_name) continue
      if (!learnedRequiredFields.has(l.project_id)) learnedRequiredFields.set(l.project_id, new Set())
      learnedRequiredFields.get(l.project_id)!.add(l.field_name.toLowerCase().trim())
    }
    log.info(`[FIX] Signal 4 (learned): found ${learnings.length} learned required fields`)
  } catch (err) {
    log.warn({ err }, '[FIX] Signal 4 (learned): failed to load execution_learnings — skipping')
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Process each canonical record
  // ─────────────────────────────────────────────────────────────────────────

  let totalPatched  = 0
  let totalUnchanged = 0
  let totalFailed   = 0
  const patchedEntities: string[] = []

  for (const row of canonicalRows) {
    try {
      const rawFormFields = (Array.isArray(row.form_fields) ? row.form_fields : []) as CanonicalFieldRaw[]

      if (rawFormFields.length === 0) {
        totalUnchanged++
        continue
      }

      const entityKey = normalizeEntityKey(row.entity_name)
      const overrideFragments = REQUIRED_FIELD_OVERRIDE_MAP[entityKey]
        ?? REQUIRED_FIELD_OVERRIDE_MAP[
             Object.keys(REQUIRED_FIELD_OVERRIDE_MAP).find(k =>
               entityKey.startsWith(k) || k.startsWith(entityKey)
             ) ?? ''
           ]
        ?? []

      // Build per-project Signal 2/3/4 lookup sets
      const crawlSet  = new Set<string>()
      const sfSet     = new Set<string>()
      const learnSet  = learnedRequiredFields.get(row.project_id) ?? new Set<string>()

      // Extract all crawl required fields for this project (any entity)
      for (const [key, _] of crawlRequiredFields) {
        if (key.startsWith(row.project_id)) {
          crawlSet.add(key.split('::')[1] ?? '')
        }
      }
      // Extract all SF required fields for this project
      for (const [key, _] of sfRequiredFields) {
        if (key.startsWith(row.project_id)) {
          sfSet.add(key.split('::')[1] ?? '')
        }
      }

      // Patch form_fields using all 4 signals
      let fieldsPatchedCount = 0
      const patchedFields: CanonicalFieldRaw[] = rawFormFields.map(field => {
        if (field.required) return field  // already required — skip

        const labelLower = (field.label ?? '').toLowerCase().trim()

        // Signal 1: REQUIRED_FIELD_OVERRIDE_MAP
        const signal1 = overrideFragments.some(fragment =>
          labelLower.includes(fragment) || fragment.includes(labelLower)
        )

        // Signal 2: original crawl HTML attribute
        const signal2 = crawlSet.has(labelLower)

        // Signal 3: Salesforce schema nillable=false
        const signal3 = sfSet.has(labelLower)
          || sfRequiredFields.has(`${row.project_id}::${labelLower}`)

        // Signal 4: execution learnings
        const signal4 = learnSet.has(labelLower)

        if (signal1 || signal2 || signal3 || signal4) {
          fieldsPatchedCount++
          const signals = [
            signal1 ? 'override_map' : null,
            signal2 ? 'crawl_html'   : null,
            signal3 ? 'sf_schema'    : null,
            signal4 ? 'learned'      : null,
          ].filter(Boolean).join('+')
          log.info(
            { entity: row.entity_name, field: field.label, signals, projectId: row.project_id },
            '[FIX] Patching field: required=true',
          )
          return { ...field, required: true }
        }

        return field
      })

      if (fieldsPatchedCount === 0) {
        totalUnchanged++
        continue
      }

      // Rebuild required_fields and optional_fields from patched form_fields
      const newRequiredFields = patchedFields.filter(f => f.required)
      const newOptionalFields = patchedFields.filter(f => !f.required)

      // Update the canonical record
      await (prisma as any).$executeRaw`
        UPDATE metadata_canonical
        SET
          form_fields     = ${JSON.stringify(patchedFields)}::jsonb,
          required_fields = ${JSON.stringify(newRequiredFields)}::jsonb,
          optional_fields = ${JSON.stringify(newOptionalFields)}::jsonb,
          last_synced_at  = now(),
          version         = version + 1
        WHERE id = ${row.id}::uuid
      `

      totalPatched++
      patchedEntities.push(`${row.entity_name} (${fieldsPatchedCount} field(s) fixed, project=${row.project_id.slice(0, 8)})`)

    } catch (err) {
      log.warn({ err, entity: row.entity_name, projectId: row.project_id }, '[FIX] Failed to patch record')
      totalFailed++
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────────────────

  log.info({
    totalCanonicalRecords: canonicalRows.length,
    patched:    totalPatched,
    unchanged:  totalUnchanged,
    failed:     totalFailed,
  }, '[FIX] ✅ Universal required-fields migration complete')

  if (patchedEntities.length > 0) {
    console.log('\n✅ Patched entities:')
    for (const e of patchedEntities) {
      console.log(`  • ${e}`)
    }
  } else {
    console.log('\n✅ All canonical records already had correct required flags — no changes needed.')
  }

  console.log(`\nSummary: ${totalPatched} patched, ${totalUnchanged} unchanged, ${totalFailed} failed`)
}

// ─── Entry point ──────────────────────────────────────────────────────────────

fixCanonicalRequiredFields()
  .catch(err => {
    console.error('[FIX] Fatal error:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
