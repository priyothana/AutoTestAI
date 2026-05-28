/**
 * Metadata Reader Tool — Entity Field Manifest Builder
 *
 * Extracted from test-case-generator.service.ts (buildEntityFieldManifest +
 * buildVerifiedUrlMap). Agents call this to get the exact field labels,
 * required status, locator types, and submit button names for any entity.
 *
 * This is the primary anti-hallucination tool — it gives agents the
 * ground truth from the crawler/metadata instead of letting the LLM guess.
 */
import prisma                 from '../../../shared/db/prisma.js'
import { createModuleLogger } from '../../../shared/logger/index.js'
import { getButtonMapping }   from '../../self-healing/learning-registry.service.js'
import type { FieldManifest, FieldEntry, VerifiedUrlMap, NavigationItem } from '../agent.types.js'

const log = createModuleLogger('metadata-reader-tool')

// ── Universal Required-Field Override Map ─────────────────────────────────────
// Defines known-required fields per entity that must always be included even if
// the crawler did not detect the HTML `required` attribute.
// Keys are lowercase singular entity names; values are lowercase substrings that
// must appear in the field label for the override to fire (partial match so that
// "Currency" matches both "Currency" and "Product Currency" etc.).
//
// HOW TO READ: entity → [...required field label fragments]
// The check is: if field.label.toLowerCase().includes(fragment) → required = true
//
// This map is the canonical, code-level truth for required fields across ALL
// projects and entity types. It supplements — never overrides — fields that the
// crawler already marks as required.
export const REQUIRED_FIELD_OVERRIDE_MAP: Record<string, string[]> = {
  // CRM core objects
  product:          ['name', 'currency'],
  lead:             ['last name', 'company', 'lead status', 'status'],
  opportunity:      ['opportunity name', 'name', 'stage', 'close date', 'account name'],
  contact:          ['last name'],
  account:          ['account name', 'name'],
  campaign:         ['campaign name', 'name', 'status', 'start date', 'type'],
  case:             ['subject', 'status', 'origin'],
  quote:            ['quote name', 'name', 'opportunity'],
  // Finance / ERP
  order:            ['account', 'status'],
  invoice:          ['contact', 'due date', 'number'],
  contract:         ['account', 'start date', 'status'],
  payment:          ['amount', 'date'],
  // Logistics
  shipment:         ['origin', 'destination', 'status'],
  inventory:        ['name', 'quantity', 'unit'],
  // HR
  employee:         ['name', 'first name', 'last name', 'department'],
  job:              ['title', 'name', 'department'],
  // Projects
  project:          ['name', 'title', 'status'],
  task:             ['subject', 'name', 'title', 'due date', 'status'],
  // Generic web-app entities
  user:             ['name', 'email'],
  vendor:           ['name', 'email'],
  customer:         ['name', 'email'],
  supplier:         ['name', 'email'],
  asset:            ['name', 'type'],
  role:             ['name'],
  category:         ['name'],
  policy:           ['name', 'type', 'status'],
}

/**
 * Apply the REQUIRED_FIELD_OVERRIDE_MAP to a list of FieldEntry objects.
 *
 * For each field whose label matches one of the override fragments for the
 * given entity, sets required = true. Does NOT set required = false on any
 * field (additive-only: we never remove required status set by the crawler).
 *
 * @param fields     - FieldEntry array from any manifest-building path
 * @param entityName - The entity name string (case-insensitive, any format)
 * @returns          - A new array with required flags patched
 */
export function applyRequiredFieldOverrides(
  fields: FieldEntry[],
  entityName: string,
): FieldEntry[] {
  if (!entityName || fields.length === 0) return fields

  // Normalize entity name: strip plural suffix and lowercase
  const entityLower = entityName.toLowerCase().trim()
    .replace(/ies$/, 'y')   // opportunities → opportunity
    .replace(/ses$/, 's')   // cases → case
    .replace(/s$/, '')       // products → product, accounts → account
    .trim()

  // Find the best-matching key (exact match, then prefix match)
  const overrideFragments = REQUIRED_FIELD_OVERRIDE_MAP[entityLower]
    ?? REQUIRED_FIELD_OVERRIDE_MAP[
         Object.keys(REQUIRED_FIELD_OVERRIDE_MAP).find(k =>
           entityLower.startsWith(k) || k.startsWith(entityLower)
         ) ?? ''
       ]
    ?? []

  if (overrideFragments.length === 0) return fields

  let patched = 0
  const result = fields.map(f => {
    if (f.required) return f  // already required — leave unchanged
    const labelLower = f.label.toLowerCase().trim()
    const shouldBeRequired = overrideFragments.some(fragment =>
      labelLower.includes(fragment) || fragment.includes(labelLower)
    )
    if (shouldBeRequired) {
      patched++
      return { ...f, required: true }
    }
    return f
  })

  if (patched > 0) {
    log.info(
      { entityName, entityLower, patched },
      '[META-TOOL] applyRequiredFieldOverrides: patched required=true on known-required fields',
    )
  }

  return result
}

// ── Field manifest builder ────────────────────────────────────────────────────

/**
 * Build a structured field manifest for the given project.
 * Prioritises webapp_crawl metadata; falls back to Salesforce field rows.
 */
export async function buildFieldManifest(
  projectId:    string,
  entityFilter?: string,   // optional: scope to one entity name
): Promise<FieldManifest | null> {
  try {
    // ── Path 0: Canonical metadata (highest priority — Tier 2 layer) ─────────
    // The canonical record pre-merges metadata_normalized + web_test_data +
    // execution_learnings at sync time, so we get ONE definitive record with
    // exact button names, field lists, and sample data. This eliminates the
    // multi-source merge that was the root cause of most hallucination bugs.
    if (process.env.ENABLE_CANONICAL_METADATA !== 'false') {
      try {
        const canonical = await tryCanonicalManifest(projectId, entityFilter)
        if (canonical) {
          log.info(
            { projectId, entityFilter, fieldCount: canonical.fields.length, source: 'canonical' },
            '[META-TOOL] buildFieldManifest: using CANONICAL metadata (Tier 2 — anti-hallucination layer)',
          )
          return canonical
        }
      } catch (canErr) {
        log.warn({ err: canErr }, '[META-TOOL] Canonical lookup failed — falling back to legacy paths')
      }
    }

    const webRows = await prisma.metadata_normalized.findMany({
      where:  { project_id: projectId, entity_type: 'webapp_crawl' },
      select: { object_name: true, structured_json: true },
      take:   30,
    })

    if (webRows.length > 0) {
      for (const row of webRows) {
        const data = (row.structured_json ?? {}) as {
          pages?: Array<{
            path?:       string
            inputs?:     Array<{ locator?: string; required?: boolean }>
            selects?:    Array<{ locator?: string; required?: boolean; options?: string[] }>
            buttons?:    Array<{ name?: string }>
          }>
        }

        // ── FIX 1: Sort pages so form/create pages come BEFORE list pages ──────
        // Without this, the list page (which has search inputs) is returned first
        // and its navigation sidebar buttons (e.g., "+ New Lead") are used as
        // the submit button for a completely different entity.
        const IS_FORM_PAGE = /\/(new|create|add|edit)\b/i
        const allPages = [...(data.pages ?? [])].sort((a, b) => {
          const aIsForm = IS_FORM_PAGE.test(a.path ?? '')
          const bIsForm = IS_FORM_PAGE.test(b.path ?? '')
          if (aIsForm && !bIsForm) return -1   // form pages first
          if (!aIsForm && bIsForm) return 1
          return 0
        })

        for (const page of allPages) {
          const entityName = entityFilter ?? row.object_name ?? 'Unknown'
          if (entityFilter && !page.path?.toLowerCase().includes(entityFilter.toLowerCase())) continue

          const fields: FieldEntry[] = []

          for (const inp of page.inputs ?? []) {
            if (!inp.locator) continue
            // Domain-neutral lookup detection — covers CRM, logistics, ERP, HR, etc.
            const isLookup = /\b(owner|parent|manager|vendor|supplier|customer|account|contact|entity|organization|person|employee|agent|location|department)\b/i.test(inp.locator)
            fields.push({
              label:       inp.locator,
              type:        isLookup ? 'lookup' : 'input',
              required:    inp.required ?? false,
              locatorType: 'label',
            })
          }

          for (const sel of page.selects ?? []) {
            if (!sel.locator) continue
            fields.push({
              label:       sel.locator,
              type:        'select',
              required:    sel.required ?? false,
              options:     sel.options ?? [],
              locatorType: 'label',
            })
          }

          if (fields.length === 0) continue

          // ── FIX 2: Entity-aware submit button detection ───────────────────────
          // Two-tier strategy:
          //   Tier 1 (preferred): button contains BOTH the entity name AND a create/save keyword
          //              e.g., "New Account", "+ New Account", "Create Account"
          //   Tier 2 (fallback): any create/save button that does NOT mention a DIFFERENT entity
          //              e.g., "New" or "Save" — safe generic buttons
          //   ❌ Rejected: "+ New Lead" when entityFilter="Account" (different entity name)
          const entityLower = (entityFilter ?? '').toLowerCase()
          const pageButtons = page.buttons ?? []

          // Build a set of "other entity" signals — button names containing a word that
          // is NOT the current entity. Used to reject cross-entity buttons.
          const isOtherEntityButton = (btnName: string): boolean => {
            if (!entityFilter) return false
            const bLower = btnName.toLowerCase()
            // Must contain an entity-like word
            const entityWordMatch = bLower.match(/\b(new|create|add)\s+([a-z]+(?:\s+[a-z]+)?)\b/)
            if (!entityWordMatch) return false
            const entityWord = entityWordMatch[2].trim()
            // The entity word should match the current entity; if it doesn't → other entity
            return entityWord.length > 2 && !entityLower.includes(entityWord) && !entityWord.includes(entityLower)
          }

          // Tier 1: button that names the CORRECT entity
          let submitBtn = entityFilter
            ? pageButtons.find(b => {
                const n = String(b.name ?? '').toLowerCase()
                return (n.includes(entityLower) || entityLower.includes(n.replace(/[^a-z]/g, ''))) &&
                       (n.includes('create') || n.includes('save') || n.includes('add') || n.includes('new'))
              })
            : undefined

          // Tier 2: generic create/save button that doesn't mention another entity
          if (!submitBtn) {
            submitBtn = pageButtons.find(b => {
              const n = String(b.name ?? '').toLowerCase()
              const isCreateSave = n.includes('create') || n.includes('save') || n.includes('submit') || n.includes('add') || n.includes('new')
              return isCreateSave && !isOtherEntityButton(String(b.name ?? ''))
            })
          }

          log.info(
            { projectId, entityFilter, path: page.path, submitButton: submitBtn?.name, totalButtons: pageButtons.length },
            '[META-TOOL] buildFieldManifest: selected submit button'
          )

          // ── FIX 3: Filter allButtonNames — exclude cross-entity navigation buttons ─
          // The account create page's sidebar has "+ New Lead", "+ New Contact" etc.
          // These must NOT appear in ALLOWED BUTTONS when entityFilter="Account"
          // because the LLM will use the first matching "New X" button it sees.
          const allButtonNames = pageButtons
            .map(b => String(b.name ?? '').trim())
            .filter(n => {
              if (!n || n.length === 0 || n.length >= 60) return false
              // Exclude buttons that clearly belong to a different entity
              if (isOtherEntityButton(n)) {
                log.info({ projectId, entityFilter, excludedButton: n }, '[META-TOOL] Excluding cross-entity button from manifest')
                return false
              }
              return true
            })

          // ── Extract navigation items from this page's navigation_items array ──
          // Pages crawled by the new crawler version store nav items in navigation_items[].
          // We collect them across ALL pages for this project (not just the entity page)
          // so the LLM has the full sidebar available regardless of which page was crawled.
          const rawNavItems = (page as any).navigation_items as Array<{
            text: string; role: string; href?: string; ariaLabel?: string; locator: string
          }> | undefined

          const navigationItems: NavigationItem[] | undefined = rawNavItems && rawNavItems.length > 0
            ? rawNavItems.map(ni => ({
                text:       ni.text,
                role:       (ni.role as NavigationItem['role']) ?? 'unknown',
                href:       ni.href,
                ariaLabel:  ni.ariaLabel,
                locator:    ni.locator,
              }))
            : undefined

          // Apply required-field overrides (crawler may have missed HTML required attrs)
          const patchedFields = applyRequiredFieldOverrides(fields, entityName)

          return {
            entityName,
            requiredCount: patchedFields.filter(f => f.required).length,
            fields:        patchedFields,
            submitButton:  submitBtn?.name,
            allButtons:    allButtonNames,
            createUrl:     page.path,
            navigationItems,
          }
        }
      }
    }

    // ── Path B: Salesforce field rows ────────────────────────────────────────
    const sfRows = await prisma.metadata_normalized.findMany({
      where:  { project_id: projectId, entity_type: 'field' },
      select: { label: true, object_name: true, structured_json: true },
      orderBy: { object_name: 'asc' },
    })

    if (sfRows.length > 0) {
      const filtered = entityFilter
        ? sfRows.filter(r => r.object_name?.toLowerCase().includes(entityFilter.toLowerCase()))
        : sfRows

      if (filtered.length > 0) {
        const entityName = filtered[0].object_name ?? 'Unknown'
        const fields: FieldEntry[] = []

        for (const row of filtered) {
          const json = (row.structured_json ?? {}) as Record<string, unknown>
          const type  = String(json.type ?? 'string').toLowerCase()
          const req   = Boolean(json.required ?? (json.nillable === false))
          const label = (row.label ?? '').trim()
          if (!label) continue

          let fieldType: FieldEntry['type'] = 'input'
          if (type === 'reference') fieldType = 'lookup'
          else if (type === 'picklist' || type === 'multipicklist') fieldType = 'select'
          else if (type === 'boolean') fieldType = 'checkbox'
          else if (type === 'textarea') fieldType = 'textarea'

          fields.push({ label, type: fieldType, required: req, locatorType: 'label' })
        }

        // Apply required-field overrides for Salesforce field rows
        const patchedFieldsSF = applyRequiredFieldOverrides(fields, entityName)

        return {
          entityName,
          requiredCount: patchedFieldsSF.filter(f => f.required).length,
          fields:        patchedFieldsSF,
        }
      }
    }

    // ── Path C: web_test_data (fallback for incomplete crawls) ───────────────
    // When both webapp_crawl and Salesforce metadata are missing, build a synthetic
    // field manifest from scraped test data. web_test_data.records contains actual
    // field-name→value pairs from the form. This is the CRITICAL FALLBACK for
    // entities like "Product" that may lack crawler metadata.
    if (entityFilter && entityFilter.length > 2) {
      try {
        const testDataRow = await prisma.web_test_data.findFirst({
          where: {
            project_id:  projectId,
            entity_name: { contains: entityFilter, mode: 'insensitive' },
          },
        })

        if (testDataRow && Array.isArray(testDataRow.records) && testDataRow.records.length > 0) {
          const sampleRecord = testDataRow.records[0] as Record<string, any>
          const fields: FieldEntry[] = []

          // Entity-specific required field heuristic
          const REQUIRED_MAP: Record<string, string[]> = {
            account:     ['account name', 'name'],
            lead:        ['last name', 'company', 'status', 'lead status'],
            contact:     ['last name'],
            opportunity: ['opportunity name', 'name', 'stage', 'close date'],
            campaign:    ['campaign name', 'name'],
            product:     ['product name', 'name', 'currency', 'sku', 'code', 'description'],
            quote:       ['quote name', 'name', 'opportunity'],
            invoice:     ['invoice name', 'number', 'invoice number', 'contact'],
            order:       ['order name', 'number', 'order number', 'account'],
            contract:    ['contract name', 'number', 'contract number', 'account'],
          }

          const SKIP_KEYS = new Set(['id', 'created_at', 'updated_at', 'created_by', 'modified_by', 'deleted_at'])
          const entityLower = testDataRow.entity_name.toLowerCase()
          const requiredFields = REQUIRED_MAP[entityLower] ?? []

          for (const [key, val] of Object.entries(sampleRecord)) {
            if (SKIP_KEYS.has(key.toLowerCase())) continue
            if (!key || key.length > 100) continue

            const valStr = String(val ?? '')
            const keyLower = key.toLowerCase().trim()

            // Infer field type from key name and value shape
            let fieldType: FieldEntry['type'] = 'input'
            if (/^(true|false)$/i.test(valStr))                                           fieldType = 'checkbox'
            else if (/\b(owner|parent|manager|vendor|supplier|customer|account|contact)\b/i.test(key)) fieldType = 'lookup'
            else if (/\b(status|type|category|stage|priority|level|source|industry|sector|currency)\b/i.test(key)) fieldType = 'select'

            // Determine if required — either from REQUIRED_MAP or treat first 3 fields as required
            const isReq = requiredFields.includes(keyLower) || requiredFields.length === 0

            fields.push({
              label:       key,
              type:        fieldType,
              required:    isReq,
              locatorType: 'label',
              sampleValue: valStr.length > 0 && valStr.length < 200 ? valStr : undefined,
            })
          }

          if (fields.length > 0) {
            // Use button names from the web_test_data table columns
            const createBtn = testDataRow.create_button_name ?? undefined
            const openBtn   = testDataRow.open_button_name ?? undefined
            const allButtons: string[] = []
            if (createBtn) allButtons.push(createBtn)
            if (openBtn) allButtons.push(openBtn)

            const reqCount = fields.filter(f => f.required).length

            log.info(
              { projectId, entityFilter, fieldCount: fields.length, requiredCount: reqCount, createBtn, openBtn },
              '[META-TOOL] buildFieldManifest: built SYNTHETIC manifest from web_test_data',
            )

            // Apply required-field overrides (REQUIRED_MAP may have missed some)
            let patchedFieldsC = applyRequiredFieldOverrides(fields, testDataRow.entity_name)

            // ── Inject synthetic entries for override-required fields that are
            // completely absent from the scraped record (e.g. Currency for Product
            // when web_test_data was scraped from the list page, not the create form).
            const entityKeyC = testDataRow.entity_name.toLowerCase().trim()
              .replace(/ies$/, 'y').replace(/ses$/, 's').replace(/s$/, '').trim()
            const overrideFragsC = REQUIRED_FIELD_OVERRIDE_MAP[entityKeyC]
              ?? REQUIRED_FIELD_OVERRIDE_MAP[
                   Object.keys(REQUIRED_FIELD_OVERRIDE_MAP).find(k =>
                     entityKeyC.startsWith(k) || k.startsWith(entityKeyC)
                   ) ?? ''
                 ]
              ?? []
            const existingLabels = new Set(patchedFieldsC.map(f => f.label.toLowerCase().trim()))
            for (const fragment of overrideFragsC) {
              const alreadyPresent = [...existingLabels].some(l => l.includes(fragment) || fragment.includes(l))
              if (!alreadyPresent) {
                // Determine a sensible TitleCase label from the fragment
                const syntheticLabel = fragment.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
                // Determine field type from fragment keyword
                let synType: FieldEntry['type'] = 'input'
                if (/\b(status|type|category|stage|priority|level|source|industry|sector|currency)\b/i.test(fragment)) synType = 'select'
                else if (/\b(owner|parent|manager|account|contact)\b/i.test(fragment)) synType = 'lookup'
                patchedFieldsC = [{ label: syntheticLabel, type: synType, required: true, locatorType: 'label' }, ...patchedFieldsC]
                existingLabels.add(syntheticLabel.toLowerCase())
                log.info(
                  { entity: testDataRow.entity_name, syntheticField: syntheticLabel },
                  '[META-TOOL] Path C: injected synthetic required field missing from web_test_data',
                )
              }
            }

            const patchedReqCount = patchedFieldsC.filter(f => f.required).length

            return {
              entityName:    testDataRow.entity_name,
              requiredCount: patchedReqCount,
              fields:        patchedFieldsC,
              submitButton:  createBtn,
              allButtons,
            }
          }
        }
      } catch (pathCErr) {
        log.warn({ pathCErr }, '[META-TOOL] Path C (web_test_data) failed (non-fatal)')
      }
    }

    return null
  } catch (err) {
    log.warn({ err, projectId, entityFilter }, '[META-TOOL] buildFieldManifest error')
    return null
  }
}


// ── URL map builder ───────────────────────────────────────────────────────────

const SKIP_PATHS = /^(login|logout|signin|signout|signup|register|auth|callback|oauth|sso|api|static|assets|_next|favicon|\.well-known)/i

/**
 * Return all crawler-verified paths for the project.
 */
export async function buildUrlMap(projectId: string): Promise<VerifiedUrlMap> {
  try {
    const project = await prisma.projects.findUnique({
      where:  { id: projectId },
      select: { base_url: true },
    })
    let baseUrl = ''
    try { baseUrl = project?.base_url ? new URL(project.base_url).origin : '' } catch { /* */ }

    const webRows = await prisma.metadata_normalized.findMany({
      where:  { project_id: projectId, entity_type: 'webapp_crawl' },
      select: { structured_json: true },
    })

    const pathSet = new Set<string>()
    for (const row of webRows) {
      const data = (row.structured_json ?? {}) as { pages?: Array<{ path?: string }> }
      for (const page of data.pages ?? []) {
        const p = (page.path ?? '').trim()
        if (!p || p === '/' || SKIP_PATHS.test(p.replace(/^\//, ''))) continue
        pathSet.add(p.startsWith('/') ? p : `/${p}`)
      }
    }

    // Also include page_url from canonical records (Tier 2 layer)
    // This ensures form pages discovered during canonical build are verified.
    if (process.env.ENABLE_CANONICAL_METADATA !== 'false') {
      try {
        const canonicalRows = await prisma.metadata_canonical.findMany({
          where:  { project_id: projectId },
          select: { page_url: true },
        })
        for (const row of canonicalRows) {
          const raw = (row.page_url ?? '').trim()
          if (!raw) continue
          // canonical page_url may be an absolute URL — extract pathname only
          let p = raw
          try {
            if (raw.startsWith('http://') || raw.startsWith('https://')) {
              p = new URL(raw).pathname
            }
          } catch { /* invalid URL — use raw value */ }
          p = p.trim()
          if (p && p !== '/' && !SKIP_PATHS.test(p.replace(/^\//, ''))) {
            pathSet.add(p.startsWith('/') ? p : `/${p}`)
          }
        }
      } catch { /* canonical table may not exist yet — non-fatal */ }
    }

    log.info({ projectId, baseUrl, pathCount: pathSet.size }, '[META-TOOL] URL map built')
    return { baseUrl, paths: [...pathSet].sort() }
  } catch (err) {
    log.warn({ err, projectId }, '[META-TOOL] buildUrlMap failed')
    return { baseUrl: '', paths: [] }
  }
}

/**
 * Format a FieldManifest as a human-readable string for LLM prompts.
 */
export function formatManifestForPrompt(manifest: FieldManifest, operationMode: 'create' | 'update' | 'default' = 'default'): string {
  const allFieldNames = manifest.fields.map(f => f.label)

  const lines: string[] = [
    `=== ENTITY FIELD MANIFEST: ${manifest.entityName} ===`,
    '',
    '╔══════════════════════════════════════════════════════════════╗',
    '║  HARD BOUNDARY — ANTI-HALLUCINATION                         ║',
    `║  The ONLY fields that exist on this form are listed below.  ║`,
    '║  DO NOT generate TYPE/SELECT/LOOKUP steps for ANY other     ║',
    '║  field. If a field is not in this list it does NOT exist.   ║',
    '╚══════════════════════════════════════════════════════════════╝',
    '',
    `ALLOWED FIELDS (${allFieldNames.length} total): ${allFieldNames.map(n => `"${n}"`).join(', ')}`,
    '',
    `⛔ FORBIDDEN: Do NOT generate steps for any field NOT in the list above.`,
    `⛔ EXAMPLE: If "FieldX" is not in ALLOWED FIELDS, do NOT add a TYPE/SELECT/LOOKUP step for "FieldX".`,
    `   This rule applies regardless of app type (CRM, Logistics, ERP, HR, Healthcare, etc.).`,
    '',
    `Required fields: ${manifest.requiredCount}`,
    '',
  ]

  const required = manifest.fields.filter(f => f.required)
  const optional = manifest.fields.filter(f => !f.required)

  if (required.length > 0) {
    lines.push('🔥 REQUIRED (must fill ALL or form will reject):')
    for (const f of required) {
      const opts = f.options?.length ? ` [options: ${f.options.slice(0, 4).join(' | ')}]` : ''
      const sample = f.sampleValue ? ` → sample: "${f.sampleValue}"` : ''
      lines.push(`  ★ "${f.label}" (${f.type})${opts}${sample}`)
    }
  }

  if (optional.length > 0) {
    lines.push('\n✅ OPTIONAL:')
    for (const f of optional.slice(0, 8)) {
      lines.push(`  • "${f.label}" (${f.type})`)
    }
  }

  if (manifest.submitButton) {
    const buttonLabel = operationMode === 'update'
      ? `\n⚡ SAVE/UPDATE BUTTON: "${manifest.submitButton}" — use for saving changes (or look for a "Save" / "Update" button)`
      : `\n⚡ PRIMARY ACTION BUTTON: "${manifest.submitButton}" — copy EXACTLY into CLICK target`
    lines.push(buttonLabel)
  }
  if (manifest.allButtons && manifest.allButtons.length > 0) {
    lines.push(`\n📋 ALL PAGE BUTTONS (use EXACT names only):`)
    for (const btn of manifest.allButtons.slice(0, 15)) {
      lines.push(`  → "${btn}"`)
    }
    lines.push('  ⚠️  NEVER invent button names — only use names from this list or the PRIMARY ACTION BUTTON above')
  }
  if (manifest.createUrl) {
    if (operationMode === 'update') {
      // For Update operations: derive list URL from create URL (/accounts/new → /accounts)
      const listUrl = manifest.createUrl.replace(/\/(new|create|add)\b.*$/i, '') || manifest.createUrl
      lines.push(`📄 LIST URL (navigate here first): ${listUrl}`)
      lines.push(`📄 FORM URL (for reference only — do NOT navigate here for Update operations): ${manifest.createUrl}`)
      lines.push(`⚠️  For UPDATE operations: NAVIGATE to the LIST URL above, then CLICK on an existing record.`)
    } else {
      lines.push(`📄 CREATE URL: ${manifest.createUrl}`)
    }
  }

  // Knowledge Graph: navigation items (sidebar/topnav)
  if (manifest.navigationItems && manifest.navigationItems.length > 0) {
    lines.push('\n🧭 NAVIGATION MENU ITEMS (use these locators for CLICK steps to navigate between sections):')
    lines.push('   ⚠️ CRITICAL: For any CLICK step that navigates to a section (Users, Accounts, Dashboard, etc.):')
    lines.push('   ⚠️  • Use locator_type: "role" (NEVER "text" or "label")')
    lines.push('   ⚠️  • Use the EXACT locator string shown below as the target')
    lines.push('   ⚠️  • Example: { "action": "CLICK", "target": "role=link, name=Users", "locator_type": "role" }')
    lines.push('')
    for (const ni of manifest.navigationItems.slice(0, 20)) {
      const href = ni.href ? `  (href: ${(() => { try { return new URL(ni.href).pathname } catch { return ni.href } })()})` : ''
      lines.push(`    → Text: "${ni.text}"  |  Use target: "${ni.locator}"  |  locator_type: "role"${href}`)
    }
  }

  // Knowledge Graph: relationships
  if (manifest.relationships && Object.keys(manifest.relationships).length > 0) {
    lines.push('\n🔗 ENTITY RELATIONSHIPS (Knowledge Graph):')
    for (const [entity, relType] of Object.entries(manifest.relationships)) {
      const relLabel = relType === 'required_lookup'
        ? '★ REQUIRED lookup — must fill before saving'
        : relType === 'optional_lookup'
          ? '• optional lookup'
          : `• ${relType}`
      lines.push(`  ${relLabel}: "${entity}"`)
    }
  }

  // Knowledge Graph: business rules
  if (manifest.businessRules && Object.keys(manifest.businessRules).length > 0) {
    lines.push('\n📏 BUSINESS RULES (Knowledge Graph):')
    for (const [rule, value] of Object.entries(manifest.businessRules)) {
      if (rule === 'validation_rules' && Array.isArray(value)) {
        lines.push('  Validation Rules:')
        for (const vr of value.slice(0, 5) as Array<{ name: string; error_message: string }>) {
          lines.push(`    ⚠️ ${vr.name}: ${vr.error_message}`)
        }
      } else {
        const ruleLabel = rule.replace(/_/g, ' ')
        lines.push(`  • ${ruleLabel}: ${typeof value === 'string' ? value : 'yes'}`)
      }
    }
  }

  lines.push('=== END MANIFEST ===')
  return lines.join('\n')
}


// ── Canonical Manifest Lookup (Tier 2 anti-hallucination layer) ──────────────
// Queries the pre-built metadata_canonical table for a clean, entity-centric
// field manifest. Returns null if no canonical record exists (falls back to
// the legacy Path A/B/C logic in buildFieldManifest).

/**
 * Try to build a FieldManifest from the canonical metadata table.
 * Returns null if no matching canonical record exists.
 *
 * The canonical record already contains pre-merged data from:
 *   - metadata_normalized (fields, buttons, page structure)
 *   - web_test_data (sample records, button names)
 *   - execution_learnings (confirmed buttons, label corrections)
 *   - selector_registry (stable locators)
 *
 * This eliminates the 3-source merge that previously happened at generation time.
 */
async function tryCanonicalManifest(
  projectId:    string,
  entityFilter?: string,
): Promise<FieldManifest | null> {
  if (!entityFilter || entityFilter.length < 2) return null

  // Query canonical table — case-insensitive entity name match
  const canonical = await prisma.metadata_canonical.findFirst({
    where: {
      project_id:  projectId,
      entity_name: { contains: entityFilter, mode: 'insensitive' },
    },
  })

  if (!canonical) return null

  // Map canonical fields to FieldEntry[]
  const formFields   = (canonical.form_fields ?? []) as Array<Record<string, unknown>>
  const reqFields    = (canonical.required_fields ?? []) as Array<Record<string, unknown>>
  const optFields    = (canonical.optional_fields ?? []) as Array<Record<string, unknown>>
  const allButtons   = (canonical.all_buttons ?? []) as string[]
  const sampleData   = (canonical.real_test_data ?? []) as Array<Record<string, unknown>>
  const learnedRules = (canonical.learned_rules ?? {}) as Record<string, unknown>

  // Build FieldEntry[] from form_fields (which has the complete set)
  const fields: FieldEntry[] = formFields.map(f => ({
    label:       String(f.label ?? ''),
    type:        (f.type as FieldEntry['type']) ?? 'input',
    required:    Boolean(f.required ?? false),
    options:     Array.isArray(f.options) ? f.options.map(String) : undefined,
    sampleValue: typeof f.sample_value === 'string' ? f.sample_value : undefined,
    locatorType: (f.locator_type as FieldEntry['locatorType']) ?? 'label',
  })).filter(f => f.label.length > 0)

  // If form_fields is empty, fall back to required + optional fields
  if (fields.length === 0) {
    for (const f of [...reqFields, ...optFields]) {
      fields.push({
        label:       String(f.label ?? ''),
        type:        (f.type as FieldEntry['type']) ?? 'input',
        required:    Boolean(f.required ?? false),
        options:     Array.isArray(f.options) ? f.options.map(String) : undefined,
        sampleValue: typeof f.sample_value === 'string' ? f.sample_value : undefined,
        locatorType: (f.locator_type as FieldEntry['locatorType']) ?? 'label',
      })
    }
  }

  if (fields.length === 0) return null  // no fields → not useful as a manifest

  // Inject sample values from real_test_data if not already present
  if (sampleData.length > 0) {
    const sampleRecord = sampleData[0] as Record<string, unknown>
    for (const field of fields) {
      if (field.sampleValue) continue
      const val = sampleRecord[field.label]
        ?? sampleRecord[field.label.toLowerCase()]
        ?? Object.entries(sampleRecord).find(
          ([k]) => k.toLowerCase().includes(field.label.toLowerCase())
                 || field.label.toLowerCase().includes(k.toLowerCase())
        )?.[1]
      if (val && typeof val === 'string' && val.length > 0 && val.length < 200) {
        field.sampleValue = val
      }
    }
  }

  // Extract Knowledge Graph data
  const relationshipsRaw = (canonical.relationships ?? {}) as Record<string, string>
  const businessRulesRaw = (canonical.business_rules ?? {}) as Record<string, unknown>

  // Apply required-field overrides for any fields the crawler may have missed
  const patchedFields = applyRequiredFieldOverrides(fields, canonical.entity_name)

  return {
    entityName:    canonical.entity_name,
    requiredCount: patchedFields.filter(f => f.required).length,
    fields:        patchedFields,
    submitButton:  canonical.primary_action_button ?? undefined,
    allButtons:    allButtons.length > 0 ? allButtons : undefined,
    createUrl:     canonical.page_url ?? undefined,
    // Derive listUrl from page_url when a learned open_button rule is present
    listUrl:       typeof learnedRules.open_button === 'string'
                     ? (canonical.page_url?.replace(/\/(new|create|add)\b.*$/i, '') || undefined)
                     : undefined,
    // Knowledge Graph data
    relationships:  Object.keys(relationshipsRaw).length > 0 ? relationshipsRaw : undefined,
    businessRules:  Object.keys(businessRulesRaw).length > 0 ? businessRulesRaw : undefined,
  }
}


// ── Centralized, deterministic button name auto-correction ──────────────────
// This is the SINGLE SOURCE OF TRUTH for correcting wrong button names.
// Called from ALL code paths (agent, TCG, workflow-chat, generation.service)
// right before steps are written to the database.
//
// The LLM consistently invents plausible button names like "Create Account",
// "Create New Account", "Save Record" instead of the REAL button "+New Account".
// This function deterministically replaces them with the real button from metadata.

const FORM_ACTION_RE = /\b(create|save|submit|add|new|update|edit|delete|remove|cancel|close|ok|apply|confirm|send|next)\b/i

/**
 * Auto-correct CLICK step button names by replacing LLM-invented names
 * with the REAL PRIMARY ACTION BUTTON from the project metadata.
 *
 * @param steps      - Array of step objects (must have action, target fields)
 * @param projectId  - Project ID to load metadata from
 * @param entityHint - Optional entity name to scope the manifest lookup
 * @returns          - The same steps array with corrected button names (mutated in-place)
 */
function getEntityPlural(entity: string): string {
  // Use only the first word so multi-word hints like "Product Valid" → "products" not "product valids"
  const e = entity.toLowerCase().trim().split(/\s+/)[0] ?? entity.toLowerCase().trim()
  if (e.endsWith('y')) return e.slice(0, -1) + 'ies'
  if (e.endsWith('s')) return e
  return e + 's'
}

/**
 * Auto-correct step elements right before database persist.
 * Universally called from ALL generation & chat pathways.
 * Handles:
 *   1. Upgrades ASSERT_TOAST steps to redirect-resilient ASSERT_URL list pages.
 *   2. Fuzzy corrects wrong field names (e.g. "Parent Company" -> "Parent Account") against manifest.
 *   3. Corrects CLICK step targets — distinguishing "Open Form" (+New X) vs "Submit Form" (Create X).
 */
export async function autoCorrectButtonNames(
  steps: Array<Record<string, any>>,
  projectId: string,
  entityHint?: string,
): Promise<Array<Record<string, any>>> {
  if (!steps || steps.length === 0) return steps

  // ── Step 1: Resolve metadata field & button ground truth ───────────────────
  let realOpenBtn: string | null = null
  let realSubmitBtn: string | null = null
  let knownFields: string[] = []
  let originalFields: FieldEntry[] = []

  if (entityHint && entityHint.length > 2) {
    // ── Strategy A.0: Canonical metadata — best source, pre-merged at sync time
    // The canonical record already has entity-aware primary_action_button and
    // filtered all_buttons, so we try it first before any other strategy.
    if (process.env.ENABLE_CANONICAL_METADATA !== 'false') {
      try {
        const canonical = await prisma.metadata_canonical.findFirst({
          where: {
            project_id:  projectId,
            entity_name: { contains: entityHint, mode: 'insensitive' },
          },
          select: { primary_action_button: true, all_buttons: true, learned_rules: true },
        })
        if (canonical) {
          if (!realSubmitBtn && canonical.primary_action_button) {
            realSubmitBtn = canonical.primary_action_button
            log.info(
              { projectId, entityHint, button: realSubmitBtn },
              '[META-TOOL] autoCorrectButtonNames: using CANONICAL submit button',
            )
          }
          const canButtons = (canonical.all_buttons ?? []) as string[]
          if (!realOpenBtn) {
            realOpenBtn = canButtons.find(b => {
              const n = b.toLowerCase()
              return (n.includes('new') || n.includes('add') || n.startsWith('+')) && !n.includes('save')
            }) ?? null
          }
          // Check learned_rules for open button
          const rules = (canonical.learned_rules ?? {}) as Record<string, unknown>
          if (!realOpenBtn && typeof rules.open_button === 'string') {
            realOpenBtn = rules.open_button
          }
        }
      } catch { /* canonical table may not exist yet — non-fatal */ }
    }

    try {
      const manifest = await buildFieldManifest(projectId, entityHint)
      if (manifest) {
        originalFields = manifest.fields ?? []
        knownFields = originalFields.map(f => f.label.toLowerCase().trim())

        // Find buttons from manifest.allButtons — only set if not already resolved by canonical (A.0)
        const allBtns = manifest.allButtons ?? []

        // Look for open button (starts with + or contains new/add)
        if (!realOpenBtn) {
          realOpenBtn = allBtns.find(b => {
            const n = b.toLowerCase()
            return (n.includes('new') || n.includes('add') || n.startsWith('+')) && !n.includes('save')
          }) ?? null
        }

        // Look for submit button (contains save/create/submit)
        if (!realSubmitBtn) {
          realSubmitBtn = manifest.submitButton ?? allBtns.find(b => {
            const n = b.toLowerCase()
            return n.includes('save') || n.includes('create') || n.includes('submit')
          }) ?? null
        }
      }
    } catch { /* try next strategy */ }
  }

  // Strategy A.5: Learning Registry — check for confirmed button names from past executions
  if (entityHint && entityHint.length > 2 && (!realOpenBtn || !realSubmitBtn)) {
    try {
      const learnedButtons = await getButtonMapping(projectId, entityHint)
      if (learnedButtons.openButton && !realOpenBtn) {
        realOpenBtn = learnedButtons.openButton
        log.info(
          { projectId, entityHint, button: realOpenBtn },
          '[META-TOOL] autoCorrectButtonNames: using LEARNED open button from past executions',
        )
      }
      if (learnedButtons.submitButton && !realSubmitBtn) {
        realSubmitBtn = learnedButtons.submitButton
        log.info(
          { projectId, entityHint, button: realSubmitBtn },
          '[META-TOOL] autoCorrectButtonNames: using LEARNED submit button from past executions',
        )
      }
    } catch { /* non-fatal */ }
  }

  // Strategy B fallback: If entity-scoped manifest has no buttons, scan webapp_crawl for general matching buttons
  if (!realOpenBtn || !realSubmitBtn) {
    try {
      const webRows = await prisma.metadata_normalized.findMany({
        where:  { project_id: projectId, entity_type: 'webapp_crawl' },
        select: { structured_json: true },
        take:   30,
      })
      const entityLower = (entityHint ?? '').toLowerCase()
      for (const row of webRows) {
        const data = (row.structured_json ?? {}) as { pages?: Array<{ buttons?: Array<{ name?: string }> }> }
        for (const page of data.pages ?? []) {
          const pageButtons = (page.buttons ?? []).map(b => String(b.name ?? '').trim()).filter(n => n.length > 0 && n.length < 60)
          if (entityLower) {
            if (!realOpenBtn) {
              const op = pageButtons.find(b => b.toLowerCase().includes('new') && b.toLowerCase().includes(entityLower))
              if (op) realOpenBtn = op
            }
            if (!realSubmitBtn) {
              const sub = pageButtons.find(b => (b.toLowerCase().includes('create') || b.toLowerCase().includes('save')) && b.toLowerCase().includes(entityLower))
              if (sub) realSubmitBtn = sub
            }
          }
        }
      }
    } catch { /* non-critical */ }
  }

  // Strategy D fallback: Fallback to standardized +New <Entity> and Create <Entity> if still not found
  // IMPORTANT: use only the FIRST word of entityHint so that a multi-word hint such as
  // "Product Valid" (inferred from "Create Product with Valid Details") never produces
  // mangled names like "+New Productvalid" or "Create Productvalid".
  if (entityHint && entityHint.length > 2) {
    const firstWord = entityHint.trim().split(/\s+/)[0] ?? ''
    const cleaned   = firstWord.replace(/[^a-zA-Z]/g, '')
    if (cleaned) {
      const capitalized = cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase()
      if (!realOpenBtn) {
        realOpenBtn = `+New ${capitalized}`
      }
      if (!realSubmitBtn) {
        realSubmitBtn = `Create ${capitalized}`
      }
    }
  }

  // Create a case-insensitive check set of valid buttons
  const knownButtonsLower = new Set<string>()
  if (realOpenBtn) {
    knownButtonsLower.add(realOpenBtn.toLowerCase().trim())
    knownButtonsLower.add(realOpenBtn.toLowerCase().replace(/\s+/g, ''))
  }
  if (realSubmitBtn) {
    knownButtonsLower.add(realSubmitBtn.toLowerCase().trim())
    knownButtonsLower.add(realSubmitBtn.toLowerCase().replace(/\s+/g, ''))
  }

  // ── Step 2: Post-process all steps in-place ──────────────────────────────
  let corrected = 0
  const entityPlural = entityHint ? getEntityPlural(entityHint) : ''

  for (const step of steps) {
    const action = String(step.action ?? '').toUpperCase()

    // 1. ASSERT_TOAST/ASSERT_TEXT Success → Convert to ASSERT_URL Redirect
    if ((action === 'ASSERT_TOAST' || action === 'ASSERT_TEXT') && entityPlural) {
      const val = String(step.value ?? step.target ?? '').toLowerCase()
      if (val.includes('success') || val.includes('create') || val.includes('save') || val.includes('thank')) {
        step.action = 'ASSERT_URL'
        step.target = 'url'
        step.value = `/${entityPlural}`
        step.locator_type = 'url'
        corrected++
        log.info({ projectId, entityHint, prevAction: action, newValue: step.value }, '[META-TOOL] Upgraded toast assertion to list page redirect ASSERT_URL')
        continue
      }
    }

    // 2. Fuzzy Field Names Correction
    if (['TYPE', 'SELECT', 'LOOKUP', 'CHECKBOX', 'MULTI_SELECT'].includes(action) && knownFields.length > 0) {
      const target = String(step.target ?? '').trim()
      const targetLower = target.toLowerCase().trim()
      if (target && !knownFields.includes(targetLower)) {
        const match = knownFields.find(f => {
          if (f.includes(targetLower) || targetLower.includes(f)) return true
          const fWords = f.split(/\s+/)
          const tWords = targetLower.split(/\s+/)
          return fWords.some(w => w.length > 3 && tWords.includes(w))
        })
        if (match) {
          const originalField = originalFields.find(of => of.label.toLowerCase().trim() === match)
          if (originalField) {
            log.warn(
              { projectId, entityHint, wrong: target, correct: originalField.label },
              '[META-TOOL] Correcting field name fuzzy match'
            )
            step.target = originalField.label
            corrected++
          }
        }
      }
    }

    // 3. Open Button vs Submit Button Correction
    if (action === 'CLICK') {
      const target = String(step.target ?? '').trim()
      if (!target) continue

      if (knownButtonsLower.has(target.toLowerCase().trim())) continue
      if (!FORM_ACTION_RE.test(target)) continue

      const targetLower = target.toLowerCase()
      const isOpenBtn = targetLower.includes('new') || targetLower.includes('add') || targetLower.startsWith('+')

      if (isOpenBtn && realOpenBtn) {
        log.warn(
          { projectId, entityHint, wrong: target, correct: realOpenBtn },
          '[META-TOOL] autoCorrectButtonNames: replacing wrong open button name',
        )
        step.target = realOpenBtn
        corrected++
      } else if (!isOpenBtn && realSubmitBtn) {
        log.warn(
          { projectId, entityHint, wrong: target, correct: realSubmitBtn },
          '[META-TOOL] autoCorrectButtonNames: replacing wrong submit button name',
        )
        step.target = realSubmitBtn
        corrected++
      }
    }
  }

  if (corrected > 0) {
    log.info(
      { projectId, entityHint, corrected },
      `[META-TOOL] autoCorrectButtonNames: normalized and corrected ${corrected} step element(s)`,
    )
  }

  return steps
}
