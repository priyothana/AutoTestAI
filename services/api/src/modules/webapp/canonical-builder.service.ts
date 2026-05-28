/**
 * Canonical Builder Service — Stage 3.5 of the Metadata Pipeline
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  PURPOSE: Consolidate metadata from MULTIPLE sources into ONE canonical  ║
 * ║  record per entity. This eliminates the multi-source merge that today    ║
 * ║  happens at TEST GENERATION TIME (Path A/B/C in metadata-reader.tool)   ║
 * ║  and pre-computes the exact field manifest, button names, test data,    ║
 * ║  and learned corrections — drastically reducing LLM hallucinations.     ║
 * ║                                                                         ║
 * ║  KNOWLEDGE GRAPH LAYER: Also extracts cross-entity relationships and    ║
 * ║  business rules from domain_models + lookup field analysis.             ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Data Sources (merged in priority order):
 *   1. metadata_normalized (entity_type='webapp_crawl'|'object')  → fields, buttons, page structure
 *   2. web_test_data                                               → sample records, button names
 *   3. execution_learnings (button_mapping|label_correction)       → confirmed buttons & field corrections
 *   4. selector_registry (health_status='HEALTHY')                 → stable locators per field
 *   5. domain_models                                               → testing rules, relationships
 *
 * Output: One `metadata_canonical` row per entity (upserted on project_id + entity_name)
 *
 * Trigger: Runs after Stage 3 (Domain Models) in both BullMQ worker and inline fallback paths.
 * Feature flag: ENABLE_CANONICAL_METADATA (defaults to enabled; set 'false' to disable)
 *
 * @module canonical-builder
 */
import prisma from '../../shared/db/prisma.js'
import { createModuleLogger } from '../../shared/logger/index.js'
import { applyRequiredFieldOverrides } from '../ai-agents/tools/metadata-reader.tool.js'

const log = createModuleLogger('canonical-builder')

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single field entry in the canonical record — matches FieldEntry from agent.types.ts */
interface CanonicalField {
  label:        string
  api_name?:    string           // API-level name if available (Salesforce)
  type:         'input' | 'select' | 'lookup' | 'checkbox' | 'textarea'
  required:     boolean
  options?:     string[]         // valid picklist values for select fields
  locator?:     string           // stable CSS/label locator
  locator_type: 'label' | 'role' | 'placeholder' | 'css' | 'testid'
  sample_value?: string          // realistic test data from web_test_data
}

/** Shape of the structured_json in metadata_normalized for webapp_crawl entries */
interface NormalizedWebPage {
  pages?: Array<{
    url?:      string
    path?:     string
    title?:    string
    headings?: string[]
    inputs?:   Array<{ locator?: string; required?: boolean; type?: string; testid?: string }>
    selects?:  Array<{ locator?: string; required?: boolean; options?: string[]; testid?: string }>
    buttons?:  Array<{ name?: string; locator?: string; testid?: string }>
    testids?:  string[]
  }>
}

// ─── Runtime DDL (same pattern as webapp-test-data.service.ts) ─────────────────

let tableEnsured = false

/**
 * Ensure the metadata_canonical table exists in the database.
 * Uses CREATE TABLE IF NOT EXISTS so it's safe to call repeatedly.
 * Also adds any columns that may be missing from earlier versions.
 */
async function ensureCanonicalTable(): Promise<void> {
  if (tableEnsured) return
  try {
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS metadata_canonical (
        id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id            UUID         NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        entity_name           TEXT         NOT NULL,
        entity_type           TEXT         NOT NULL,
        page_url              TEXT,
        required_fields       JSONB        DEFAULT '[]',
        optional_fields       JSONB        DEFAULT '[]',
        primary_action_button TEXT,
        all_buttons           JSONB        DEFAULT '[]',
        form_fields           JSONB        DEFAULT '[]',
        real_test_data        JSONB        DEFAULT '[]',
        stable_locators       JSONB        DEFAULT '{}',
        learned_rules         JSONB        DEFAULT '{}',
        last_synced_at        TIMESTAMPTZ  DEFAULT now(),
        version               INT          DEFAULT 1,
        UNIQUE(project_id, entity_name)
      )
    `
    // Indexes
    await prisma.$executeRaw`
      CREATE INDEX IF NOT EXISTS idx_metadata_canonical_project
        ON metadata_canonical(project_id)
    `
    await prisma.$executeRaw`
      CREATE INDEX IF NOT EXISTS idx_metadata_canonical_entity
        ON metadata_canonical(project_id, entity_name)
    `
    tableEnsured = true
    log.info('[CANONICAL] metadata_canonical table ensured')
  } catch (err) {
    log.warn({ err }, '[CANONICAL] ensureCanonicalTable failed — table may already exist')
    tableEnsured = true
  }

  // Ensure Knowledge Graph columns exist (for tables created before KG enhancement)
  try {
    await prisma.$executeRaw`ALTER TABLE metadata_canonical ADD COLUMN IF NOT EXISTS relationships JSONB DEFAULT '{}'`
    await prisma.$executeRaw`ALTER TABLE metadata_canonical ADD COLUMN IF NOT EXISTS business_rules JSONB DEFAULT '{}'`
  } catch { /* columns may already exist */ }
}

// ─── Entity Name Derivation ───────────────────────────────────────────────────

/**
 * Derive a clean, human-readable entity name from a URL path.
 *
 * Examples:
 *   /products/new         → "Product"
 *   /opportunities/create → "Opportunity"
 *   /contacts             → "Contact"
 *   /api/v1/users         → "User"
 *   /order-items/new      → "Order Item"
 *
 * Strategy:
 *   1. Strip trailing action segments (/new, /create, /edit, /add)
 *   2. Take the last meaningful path segment
 *   3. De-pluralize (simple English heuristic)
 *   4. Title-case and de-hyphenate
 */
function deriveEntityName(path: string): string {
  const segments = path
    .replace(/^\/+|\/+$/g, '')               // trim slashes
    .split('/')
    .filter(s => s.length > 0)

  // Strip trailing action segments
  const actionSegments = new Set(['new', 'create', 'edit', 'add', 'update', 'delete', 'view', 'detail', 'details'])
  while (segments.length > 1 && actionSegments.has(segments[segments.length - 1].toLowerCase())) {
    segments.pop()
  }

  // Strip leading API version or common prefixes
  const skipPrefixes = new Set(['api', 'v1', 'v2', 'v3', 'app', 'admin', 'dashboard', 'manage', 'portal'])
  while (segments.length > 1 && skipPrefixes.has(segments[0].toLowerCase())) {
    segments.shift()
  }

  // Take the last segment as the entity identifier
  const raw = segments[segments.length - 1] ?? 'Unknown'

  // De-hyphenate and de-underscore → "order-items" → "order items"
  const words = raw.replace(/[-_]/g, ' ').split(/\s+/)

  // De-pluralize the last word (simple English rules)
  const lastWord = words[words.length - 1]
  words[words.length - 1] = depluralize(lastWord)

  // Title-case each word
  return words
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

/**
 * Simple English de-pluralizer.
 * Handles: -ies → -y, -ses → -s, -es → -e, -s → (remove)
 * Does NOT handle irregular plurals (children, people, etc.)
 */
function depluralize(word: string): string {
  const w = word.toLowerCase()
  if (w.length < 3) return word

  // Keep words that are already singular-ish
  const keepAsIs = new Set(['status', 'address', 'process', 'access', 'success', 'business', 'class', 'analysis'])
  if (keepAsIs.has(w)) return word

  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y'
  if (w.endsWith('sses')) return w.slice(0, -2)  // addresses → address
  if (w.endsWith('ses') && w.length > 4) return w.slice(0, -1)  // cases → case
  if (w.endsWith('ves') && w.length > 4) return w.slice(0, -3) + 'f'  // halves → half (rare)
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) {
    return w.slice(0, -1)
  }
  return word
}

// ─── Page Classification ──────────────────────────────────────────────────────

/** Classify a page as form, list_page, or web_page based on its path and content. */
function classifyPage(
  path: string,
  inputs: number,
  selects: number,
): 'form' | 'list_page' | 'web_page' {
  const pathLower = path.toLowerCase()
  const isFormPath = /\/(new|create|add|edit|update)\b/i.test(pathLower)
  const hasFormElements = (inputs + selects) >= 2

  if (isFormPath || hasFormElements) return 'form'

  // List pages: path ends in a plural noun, few inputs
  const lastSegment = path.split('/').filter(Boolean).pop() ?? ''
  if (/s$/i.test(lastSegment) && !isFormPath) return 'list_page'

  return 'web_page'
}

// ─── Button Detection ─────────────────────────────────────────────────────────

/**
 * Detect the primary action button for a form, using entity-aware matching.
 * Same logic as metadata-reader.tool.ts L91-L130 but centralized here.
 *
 * Two-tier strategy:
 *   Tier 1: Button contains BOTH the entity name AND a create/save keyword
 *   Tier 2: Any create/save button that does NOT mention a DIFFERENT entity
 */
function detectPrimaryButton(
  buttons: Array<{ name?: string }>,
  entityName: string,
): string | undefined {
  const entityLower = entityName.toLowerCase()

  // Helper: check if a button belongs to a different entity
  const isOtherEntityButton = (btnName: string): boolean => {
    if (!entityName) return false
    const bLower = btnName.toLowerCase()
    const match = bLower.match(/\b(new|create|add)\s+([a-z]+(?:\s+[a-z]+)?)\b/)
    if (!match) return false
    const entityWord = match[2].trim()
    return entityWord.length > 2
      && !entityLower.includes(entityWord)
      && !entityWord.includes(entityLower)
  }

  // Tier 1: entity-specific button (e.g., "Create Opportunity", "+New Account")
  const tier1 = buttons.find(b => {
    const n = String(b.name ?? '').toLowerCase()
    return (n.includes(entityLower) || entityLower.includes(n.replace(/[^a-z]/g, '')))
      && (n.includes('create') || n.includes('save') || n.includes('add') || n.includes('new'))
  })
  if (tier1?.name) return tier1.name

  // Tier 2: generic create/save button that doesn't belong to another entity
  const tier2 = buttons.find(b => {
    const n = String(b.name ?? '').toLowerCase()
    const isCreateSave = n.includes('create') || n.includes('save') || n.includes('submit')
      || n.includes('add') || n.includes('new')
    return isCreateSave && !isOtherEntityButton(String(b.name ?? ''))
  })

  return tier2?.name
}

/**
 * Filter button names to exclude cross-entity navigation buttons.
 * e.g., on the Account page, exclude "+ New Lead", "+ New Contact" etc.
 */
function filterCrossEntityButtons(
  buttonNames: string[],
  entityName: string,
): string[] {
  const entityLower = entityName.toLowerCase()
  return buttonNames.filter(n => {
    if (!n || n.length === 0 || n.length >= 60) return false
    const bLower = n.toLowerCase()
    const match = bLower.match(/\b(new|create|add)\s+([a-z]+(?:\s+[a-z]+)?)\b/)
    if (!match) return true  // keep non-entity buttons
    const entityWord = match[2].trim()
    if (entityWord.length <= 2) return true
    // Keep only if it matches the current entity
    return entityLower.includes(entityWord) || entityWord.includes(entityLower)
  })
}

// ─── Field Type Detection ─────────────────────────────────────────────────────

/**
 * Classify an input field by its label into the CanonicalField type system.
 * Domain-neutral — covers CRM, logistics, ERP, HR, healthcare, etc.
 */
function classifyInputType(label: string): CanonicalField['type'] {
  const labelLower = label.toLowerCase()
  // Lookup fields — domain-neutral
  if (/\b(owner|parent|manager|vendor|supplier|customer|account|contact|entity|organization|person|employee|agent|location|department)\b/i.test(labelLower)) {
    return 'lookup'
  }
  return 'input'
}

// ─── Main Builder ─────────────────────────────────────────────────────────────

/**
 * Build canonical metadata records for a web app project.
 *
 * Reads from metadata_normalized, web_test_data, execution_learnings,
 * and selector_registry — then upserts into metadata_canonical.
 *
 * @returns Number of canonical records upserted.
 */
export async function buildCanonicalMetadata(projectId: string): Promise<number> {
  await ensureCanonicalTable()

  log.info(`[CANONICAL] Starting canonical build for project ${projectId}`)
  const startMs = Date.now()

  // ── 1. Load all source data in parallel ───────────────────────────────────

  const [webRows, testDataRows, buttonLearnings, labelCorrections, healthySelectors] = await Promise.all([
    // Source 1: Normalized webapp crawl data
    prisma.metadata_normalized.findMany({
      where:  { project_id: projectId, entity_type: 'webapp_crawl' },
      select: { object_name: true, structured_json: true },
      take:   30,
    }),

    // Source 2: Sample test data + discovered button names
    prisma.web_test_data.findMany({
      where:  { project_id: projectId },
      select: { entity_name: true, records: true, create_button_name: true, open_button_name: true },
    }),

    // Source 3a: Learned button mappings from past executions
    prisma.execution_learnings.findMany({
      where:  { project_id: projectId, learning_type: 'button_mapping' },
      orderBy: { created_at: 'desc' },
      take:   50,
    }),

    // Source 3b: Learned label corrections from past executions
    prisma.execution_learnings.findMany({
      where:  { project_id: projectId, learning_type: 'label_correction' },
      orderBy: { created_at: 'desc' },
      take:   100,
    }),

    // Source 4: Healthy selectors from selector registry
    prisma.selector_registry.findMany({
      where:  { project_id: projectId, health_status: 'HEALTHY' },
      select: { field_name: true, selector: true, selector_type: true, page_url: true },
    }),
  ])

  if (webRows.length === 0) {
    log.info(`[CANONICAL] No webapp_crawl data found — nothing to canonicalize`)
    return 0
  }

  // ── 2. Build lookup maps for quick merging ────────────────────────────────

  // Test data: entity name (lowercase) → records + buttons
  const testDataMap = new Map<string, {
    records:          unknown[]
    createButtonName: string | null
    openButtonName:   string | null
  }>()
  for (const td of testDataRows) {
    testDataMap.set(td.entity_name.toLowerCase(), {
      records:          Array.isArray(td.records) ? (td.records as unknown[]).slice(0, 5) : [],
      createButtonName: td.create_button_name,
      openButtonName:   td.open_button_name,
    })
  }

  // Button learnings: entity (lowercase) → { open, submit }
  const buttonMap = new Map<string, { openButton: string | null; submitButton: string | null }>()
  for (const bl of buttonLearnings) {
    const entity = (bl.object_name ?? '').toLowerCase()
    if (!entity) continue
    const existing = buttonMap.get(entity) ?? { openButton: null, submitButton: null }
    if (bl.field_type === 'open' && !existing.openButton) existing.openButton = bl.correct_action
    if (bl.field_type === 'submit' && !existing.submitButton) existing.submitButton = bl.correct_action
    buttonMap.set(entity, existing)
  }

  // Label corrections: aiLabel (lowercase) → actualLabel
  const labelCorrectionMap = new Map<string, string>()
  for (const lc of labelCorrections) {
    if (lc.field_name && lc.correct_action) {
      labelCorrectionMap.set(lc.field_name.toLowerCase(), lc.correct_action)
    }
  }

  // Healthy selectors: field_name (lowercase) → { selector, selector_type }
  const selectorMap = new Map<string, { selector: string; selectorType: string }>()
  for (const sel of healthySelectors) {
    const key = sel.field_name.toLowerCase()
    if (!selectorMap.has(key)) {
      selectorMap.set(key, { selector: sel.selector, selectorType: sel.selector_type })
    }
  }

  // ── 3. Process each normalized row → build canonical records ──────────────

  let upsertCount = 0
  const IS_FORM_PAGE = /\/(new|create|add|edit)\b/i

  for (const row of webRows) {
    const data = (row.structured_json ?? {}) as NormalizedWebPage
    const pages = data.pages ?? []

    // Sort form pages first (same strategy as metadata-reader.tool.ts)
    const sortedPages = [...pages].sort((a, b) => {
      const aForm = IS_FORM_PAGE.test(a.path ?? '')
      const bForm = IS_FORM_PAGE.test(b.path ?? '')
      if (aForm && !bForm) return -1
      if (!aForm && bForm) return 1
      return 0
    })

    for (const page of sortedPages) {
      const path = (page.path ?? '').trim()
      if (!path || path === '/') continue

      // Skip login/auth pages
      if (/^\/(login|logout|signin|signout|signup|register|auth|callback|oauth)\b/i.test(path)) continue

      const inputCount  = (page.inputs ?? []).length
      const selectCount = (page.selects ?? []).length
      const buttonCount = (page.buttons ?? []).length

      // Skip pages with zero interactive elements
      if (inputCount + selectCount + buttonCount === 0) continue

      const entityName = deriveEntityName(path)
      const entityType = classifyPage(path, inputCount, selectCount)
      const entityLower = entityName.toLowerCase()

      // ── Build field lists ─────────────────────────────────────────────

      const requiredFields: CanonicalField[] = []
      const optionalFields: CanonicalField[] = []
      const allFields: CanonicalField[] = []

      // Process inputs
      for (const inp of page.inputs ?? []) {
        if (!inp.locator) continue

        // Apply label corrections if available
        let label = inp.locator
        const correctedLabel = labelCorrectionMap.get(label.toLowerCase())
        if (correctedLabel) {
          log.info({ original: label, corrected: correctedLabel }, '[CANONICAL] Applied label correction')
          label = correctedLabel
        }

        const fieldType = classifyInputType(label)
        const healthySelector = selectorMap.get(label.toLowerCase())

        const field: CanonicalField = {
          label,
          type:         fieldType,
          required:     inp.required ?? false,
          locator_type: 'label',
          ...(healthySelector ? { locator: healthySelector.selector } : {}),
          ...(inp.testid ? { locator: `[data-testid="${inp.testid}"]`, locator_type: 'testid' as const } : {}),
        }

        if (field.required) {
          requiredFields.push(field)
        } else {
          optionalFields.push(field)
        }
        allFields.push(field)
      }

      // Process selects
      for (const sel of page.selects ?? []) {
        if (!sel.locator) continue

        let label = sel.locator
        const correctedLabel = labelCorrectionMap.get(label.toLowerCase())
        if (correctedLabel) label = correctedLabel

        const healthySelector = selectorMap.get(label.toLowerCase())

        const field: CanonicalField = {
          label,
          type:         'select',
          required:     sel.required ?? false,
          options:      sel.options ?? [],
          locator_type: 'label',
          ...(healthySelector ? { locator: healthySelector.selector } : {}),
          ...(sel.testid ? { locator: `[data-testid="${sel.testid}"]`, locator_type: 'testid' as const } : {}),
        }

        if (field.required) {
          requiredFields.push(field)
        } else {
          optionalFields.push(field)
        }
        allFields.push(field)
      }

      // ── Detect buttons ────────────────────────────────────────────────

      const rawButtonNames = (page.buttons ?? [])
        .map(b => String(b.name ?? '').trim())
        .filter(n => n.length > 0 && n.length < 60)
      const filteredButtons = filterCrossEntityButtons(rawButtonNames, entityName)

      // Primary action button — resolve from multiple sources, in priority order:
      //   1. execution_learnings (confirmed by past test runs)
      //   2. web_test_data.create_button_name
      //   3. DOM crawl detection (entity-aware matching)
      let primaryButton: string | undefined

      // Priority 1: Learned button from execution_learnings
      const learned = buttonMap.get(entityLower)
      if (learned?.submitButton) {
        primaryButton = learned.submitButton
        log.info({ entity: entityName, button: primaryButton }, '[CANONICAL] Using learned submit button')
      }

      // Priority 2: web_test_data.create_button_name
      if (!primaryButton) {
        const td = testDataMap.get(entityLower)
        if (td?.createButtonName) {
          primaryButton = td.createButtonName
        }
      }

      // Priority 3: DOM crawl detection
      if (!primaryButton) {
        primaryButton = detectPrimaryButton(page.buttons ?? [], entityName)
      }

      // ── Merge real test data ──────────────────────────────────────────

      const testData = testDataMap.get(entityLower)
      const sampleRecords = testData?.records ?? []

      // Inject sample values into fields from test data
      if (sampleRecords.length > 0) {
        const sampleRecord = sampleRecords[0] as Record<string, unknown>
        for (const field of allFields) {
          if (field.sample_value) continue  // already has a value
          // Try direct key match and case-insensitive match
          const val = sampleRecord[field.label]
            ?? sampleRecord[field.label.toLowerCase()]
            ?? Object.entries(sampleRecord).find(
                ([k]) => k.toLowerCase().includes(field.label.toLowerCase())
                       || field.label.toLowerCase().includes(k.toLowerCase())
              )?.[1]
          if (val && typeof val === 'string' && val.length > 0 && val.length < 200) {
            field.sample_value = val
          }
        }
      }

      // Apply required-field overrides (ensure known-required fields are flagged
      // correctly even if the crawler missed the HTML required attribute).
      // This mutates allFields in place and rebuilds requiredFields/optionalFields.
      const patchedAllFields = applyRequiredFieldOverrides(
        allFields as unknown as import('../ai-agents/agent.types.js').FieldEntry[],
        entityName,
      ) as unknown as CanonicalField[]
      // Update allFields and rebuild required/optional splits
      allFields.length = 0
      allFields.push(...patchedAllFields)
      requiredFields.length = 0
      optionalFields.length = 0
      for (const f of allFields) {
        if (f.required) requiredFields.push(f)
        else optionalFields.push(f)
      }

      // ── Build stable locators map ─────────────────────────────────────

      const stableLocators: Record<string, { selector: string; type: string }> = {}
      for (const field of allFields) {
        const healthy = selectorMap.get(field.label.toLowerCase())
        if (healthy) {
          stableLocators[field.label] = {
            selector: healthy.selector,
            type:     healthy.selectorType,
          }
        }
      }

      // ── Build learned rules ───────────────────────────────────────────

      const learnedRules: Record<string, unknown> = {}

      // Add learned open button (for navigating to the form)
      if (learned?.openButton) {
        learnedRules.open_button = learned.openButton
      }

      // Add learned label corrections relevant to this entity's fields
      const fieldLabels = allFields.map(f => f.label.toLowerCase())
      const relevantCorrections: Record<string, string> = {}
      for (const [aiLabel, actualLabel] of labelCorrectionMap) {
        if (fieldLabels.includes(actualLabel.toLowerCase()) || fieldLabels.includes(aiLabel)) {
          relevantCorrections[aiLabel] = actualLabel
        }
      }
      if (Object.keys(relevantCorrections).length > 0) {
        learnedRules.label_corrections = relevantCorrections
      }

      // ── Extract relationships (Knowledge Graph) ────────────────────────

      const relationships: Record<string, string> = {}

      // Detect lookup relationships from field labels
      for (const field of allFields) {
        const labelLower = field.label.toLowerCase()
        if (field.type === 'lookup') {
          // Extract the entity name from lookup label: "Account Name" → "Account"
          const relName = field.label.replace(/\s*(name|id|lookup)\s*$/i, '').trim()
          if (relName.length > 1 && relName.toLowerCase() !== entityLower) {
            relationships[relName] = field.required ? 'required_lookup' : 'optional_lookup'
          }
        }
      }

      // ── Extract business rules (Knowledge Graph) ───────────────────────

      const businessRules: Record<string, unknown> = {}

      // Required field patterns → business rules
      for (const field of requiredFields) {
        const ruleKey = field.label.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_required'
        businessRules[ruleKey] = true
      }

      // ── Upsert into metadata_canonical ────────────────────────────────

      try {
        await prisma.$executeRaw`
          INSERT INTO metadata_canonical (
            id, project_id, entity_name, entity_type, page_url,
            required_fields, optional_fields, primary_action_button,
            all_buttons, form_fields, real_test_data,
            stable_locators, learned_rules,
            relationships, business_rules,
            last_synced_at, version
          ) VALUES (
            gen_random_uuid(),
            ${projectId}::uuid,
            ${entityName},
            ${entityType},
            ${path},
            ${JSON.stringify(requiredFields)}::jsonb,
            ${JSON.stringify(optionalFields)}::jsonb,
            ${primaryButton ?? null},
            ${JSON.stringify(filteredButtons)}::jsonb,
            ${JSON.stringify(allFields)}::jsonb,
            ${JSON.stringify(sampleRecords.slice(0, 5))}::jsonb,
            ${JSON.stringify(stableLocators)}::jsonb,
            ${JSON.stringify(learnedRules)}::jsonb,
            ${JSON.stringify(relationships)}::jsonb,
            ${JSON.stringify(businessRules)}::jsonb,
            now(),
            1
          )
          ON CONFLICT (project_id, entity_name) DO UPDATE SET
            entity_type           = EXCLUDED.entity_type,
            page_url              = EXCLUDED.page_url,
            required_fields       = EXCLUDED.required_fields,
            optional_fields       = EXCLUDED.optional_fields,
            primary_action_button = EXCLUDED.primary_action_button,
            all_buttons           = EXCLUDED.all_buttons,
            form_fields           = EXCLUDED.form_fields,
            real_test_data        = EXCLUDED.real_test_data,
            stable_locators       = EXCLUDED.stable_locators,
            learned_rules         = EXCLUDED.learned_rules,
            relationships         = EXCLUDED.relationships,
            business_rules        = EXCLUDED.business_rules,
            last_synced_at        = now(),
            version               = metadata_canonical.version + 1
        `
        upsertCount++
      } catch (upsertErr) {
        log.warn(
          { err: upsertErr, entity: entityName, path },
          '[CANONICAL] Failed to upsert canonical record (non-fatal)',
        )
      }
    }
  }

  const durationMs = Date.now() - startMs
  log.info(
    { projectId, upsertCount, durationMs },
    `[CANONICAL] ✅ Canonical build complete — ${upsertCount} entities in ${durationMs}ms`,
  )

  return upsertCount
}

// ═══════════════════════════════════════════════════════════════════════════════
// Salesforce Canonical Builder — processes entity_type='object' from normalizer
// ═══════════════════════════════════════════════════════════════════════════════

/** Shape of the structured_json in metadata_normalized for Salesforce objects */
interface SfNormalizedObject {
  object:           string
  label:            string
  custom:           boolean
  createable:       boolean
  fields:           Array<{
    api:              string
    label:            string
    type:             string
    required:         boolean
    createable:       boolean
    picklistValues:   Array<{ label: string; value: string; active: boolean }>
    referenceTo:      string[]
    unique:           boolean
    controllerName:   string
    dependentPicklist: boolean
    filteredLookupInfo: unknown
    relationshipName: string
    ui_label?:        string
  }>
  validation_rules: Array<{
    name:          string
    error_message: string
    formula:       string
    active:        boolean
  }>
}

/**
 * Build canonical metadata records for a Salesforce project.
 *
 * Reads from metadata_normalized (entity_type='object'), plus
 * execution_learnings for button/label corrections.
 *
 * This gives Salesforce entities the same canonical treatment as web app entities:
 * one row per entity with exact field lists, relationships, and business rules.
 *
 * @returns Number of canonical records upserted.
 */
export async function buildSalesforceCanonicalMetadata(projectId: string): Promise<number> {
  await ensureCanonicalTable()

  log.info(`[CANONICAL-SF] Starting Salesforce canonical build for project ${projectId}`)
  const startMs = Date.now()

  // ── Load Salesforce normalized objects ───────────────────────────────────
  const sfRows = await prisma.metadata_normalized.findMany({
    where:  { project_id: projectId, entity_type: 'object' },
    select: { object_name: true, label: true, structured_json: true },
    take:   50,
  })

  if (sfRows.length === 0) {
    log.info(`[CANONICAL-SF] No Salesforce objects found — nothing to canonicalize`)
    return 0
  }

  // Load execution learnings for button + label corrections
  const [buttonLearnings, labelCorrections] = await Promise.all([
    prisma.execution_learnings.findMany({
      where:  { project_id: projectId, learning_type: 'button_mapping' },
      orderBy: { created_at: 'desc' },
      take:   50,
    }),
    prisma.execution_learnings.findMany({
      where:  { project_id: projectId, learning_type: 'label_correction' },
      orderBy: { created_at: 'desc' },
      take:   100,
    }),
  ])

  // Button learnings map
  const buttonMap = new Map<string, { openButton: string | null; submitButton: string | null }>()
  for (const bl of buttonLearnings) {
    const entity = (bl.object_name ?? '').toLowerCase()
    if (!entity) continue
    const existing = buttonMap.get(entity) ?? { openButton: null, submitButton: null }
    if (bl.field_type === 'open' && !existing.openButton) existing.openButton = bl.correct_action
    if (bl.field_type === 'submit' && !existing.submitButton) existing.submitButton = bl.correct_action
    buttonMap.set(entity, existing)
  }

  // Label corrections map
  const labelCorrectionMap = new Map<string, string>()
  for (const lc of labelCorrections) {
    if (lc.field_name && lc.correct_action) {
      labelCorrectionMap.set(lc.field_name.toLowerCase(), lc.correct_action)
    }
  }

  let upsertCount = 0

  for (const row of sfRows) {
    const data = (row.structured_json ?? {}) as unknown as SfNormalizedObject
    const objectName = data.object ?? row.object_name
    const objectLabel = data.label ?? objectName
    const fields = data.fields ?? []
    const validationRules = data.validation_rules ?? []
    const entityLower = objectLabel.toLowerCase()

    // Only process createable objects with fields
    if (!data.createable || fields.length === 0) continue

    // ── Build field lists ──────────────────────────────────────────────

    const requiredFields: CanonicalField[] = []
    const optionalFields: CanonicalField[] = []
    const allFields: CanonicalField[] = []

    for (const f of fields) {
      if (!f.createable) continue  // Skip non-createable fields

      // Apply label corrections
      let label = f.ui_label ?? f.label
      const corrected = labelCorrectionMap.get(label.toLowerCase())
      if (corrected) label = corrected

      // Map SF field type to canonical type
      let fieldType: CanonicalField['type'] = 'input'
      if (f.type === 'picklist' || f.type === 'multipicklist' || f.dependentPicklist) {
        fieldType = 'select'
      } else if (f.type === 'reference') {
        fieldType = 'lookup'
      } else if (f.type === 'boolean') {
        fieldType = 'checkbox'
      } else if (f.type === 'textarea') {
        fieldType = 'textarea'
      }

      const options = f.picklistValues
        ?.filter(pv => pv.active)
        .map(pv => pv.label)

      const field: CanonicalField = {
        label,
        api_name:     f.api,
        type:         fieldType,
        required:     f.required,
        locator_type: 'label',
        ...(options && options.length > 0 ? { options } : {}),
      }

      if (f.required) {
        requiredFields.push(field)
      } else {
        optionalFields.push(field)
      }
      allFields.push(field)
    }

      // Apply required-field overrides (Salesforce required flag from schema may miss
      // business-logic required fields — override map corrects this).
      const patchedSfFields = applyRequiredFieldOverrides(
        allFields as unknown as import('../ai-agents/agent.types.js').FieldEntry[],
        objectLabel,
      ) as unknown as CanonicalField[]
      allFields.length = 0
      allFields.push(...patchedSfFields)
      requiredFields.length = 0
      optionalFields.length = 0
      for (const f of allFields) {
        if (f.required) requiredFields.push(f)
        else optionalFields.push(f)
      }

      // ── Extract relationships from reference fields ─────────────────────

    const relationships: Record<string, string> = {}
    for (const f of fields) {
      if (f.type === 'reference' && f.referenceTo?.length > 0) {
        const targetEntity = f.referenceTo[0]
        if (targetEntity && targetEntity !== objectName) {
          relationships[targetEntity] = f.required ? 'required_lookup' : 'optional_lookup'
        }
      }
    }

    // ── Extract business rules from validation rules ────────────────────

    const businessRules: Record<string, unknown> = {}

    // Required field rules
    for (const f of requiredFields) {
      const ruleKey = (f.api_name ?? f.label).toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_required'
      businessRules[ruleKey] = true
    }

    // Active validation rules
    const activeVRs = validationRules.filter(vr => vr.active)
    if (activeVRs.length > 0) {
      businessRules.validation_rules = activeVRs.map(vr => ({
        name:          vr.name,
        error_message: vr.error_message,
      }))
    }

    // ── Resolve button names ────────────────────────────────────────────

    const learned = buttonMap.get(entityLower)
    const primaryButton = learned?.submitButton ?? `Save`
    const openButton = learned?.openButton ?? null

    const learnedRules: Record<string, unknown> = {}
    if (openButton) learnedRules.open_button = openButton

    // ── Upsert into metadata_canonical ──────────────────────────────────

    try {
      await prisma.$executeRaw`
        INSERT INTO metadata_canonical (
          id, project_id, entity_name, entity_type, page_url,
          required_fields, optional_fields, primary_action_button,
          all_buttons, form_fields, real_test_data,
          stable_locators, learned_rules,
          relationships, business_rules,
          last_synced_at, version
        ) VALUES (
          gen_random_uuid(),
          ${projectId}::uuid,
          ${objectLabel},
          'salesforce_object',
          ${null},
          ${JSON.stringify(requiredFields)}::jsonb,
          ${JSON.stringify(optionalFields.slice(0, 30))}::jsonb,
          ${primaryButton},
          ${JSON.stringify(['Save', 'Save & New', 'Cancel'])}::jsonb,
          ${JSON.stringify(allFields.slice(0, 50))}::jsonb,
          '[]'::jsonb,
          '{}'::jsonb,
          ${JSON.stringify(learnedRules)}::jsonb,
          ${JSON.stringify(relationships)}::jsonb,
          ${JSON.stringify(businessRules)}::jsonb,
          now(),
          1
        )
        ON CONFLICT (project_id, entity_name) DO UPDATE SET
          entity_type           = EXCLUDED.entity_type,
          required_fields       = EXCLUDED.required_fields,
          optional_fields       = EXCLUDED.optional_fields,
          primary_action_button = EXCLUDED.primary_action_button,
          all_buttons           = EXCLUDED.all_buttons,
          form_fields           = EXCLUDED.form_fields,
          stable_locators       = EXCLUDED.stable_locators,
          learned_rules         = EXCLUDED.learned_rules,
          relationships         = EXCLUDED.relationships,
          business_rules        = EXCLUDED.business_rules,
          last_synced_at        = now(),
          version               = metadata_canonical.version + 1
      `
      upsertCount++
    } catch (upsertErr) {
      log.warn(
        { err: upsertErr, entity: objectLabel },
        '[CANONICAL-SF] Failed to upsert canonical record (non-fatal)',
      )
    }
  }

  const durationMs = Date.now() - startMs
  log.info(
    { projectId, upsertCount, durationMs },
    `[CANONICAL-SF] ✅ Salesforce canonical build complete — ${upsertCount} entities in ${durationMs}ms`,
  )

  return upsertCount
}
