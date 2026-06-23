/**
 * Test-Case Generator Module — Service Layer
 *
 * Orchestrates multi-source AI test case generation:
 *   Source 1: BRD / Functional Specification document (uploaded, optional)
 *   Source 2: Existing test cases document (uploaded, optional)
 *   Source 3: Jira board stories (via configured integration, optional)
 *   Source 4: Project metadata via RAG / MCP (always used as primary source)
 *
 * Flow:
 *   1. Collect all available inputs
 *   2. Build a rich structured context blob
 *   3. Send to Claude Sonnet via LangChain
 *   4. Parse + persist generated test cases under a new "Generated Suite" entry
 *      (stored in test_data_sets as a lightweight suite record — no schema migration needed)
 *
 * Async: enqueues a BullMQ job → returns jobId immediately.
 * The worker (test-case-generator.worker.ts) does the heavy lifting.
 */
import { Queue, Worker }           from 'bullmq'
import { ChatAnthropic }           from '@langchain/anthropic'
import { ChatOpenAI }              from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { StringOutputParser }      from '@langchain/core/output_parsers'
import type { BaseChatModel }      from '@langchain/core/language_models/chat_models'

import prisma                      from '../../shared/db/prisma.js'
import { createModuleLogger }      from '../../shared/logger/index.js'
import { getRedisOptions }         from '../../shared/queue/connection.js'
import { QUEUES }                  from '../../shared/queue/queues.js'
import type { TestCaseGenerationJob } from '../../shared/queue/job-types.js'

// Cross-module: RAG retrieval lives in generation.service
import { retrieveRagChunks }       from '../test-generation/generation.service.js'

// Cross-module: field manifest for button name auto-correction + canonical lookup
import { autoCorrectButtonNames, buildFieldManifest } from '../ai-agents/tools/metadata-reader.tool.js'

const log = createModuleLogger('test-case-generator')

/**
 * Generates English singular and plural stems for robust module matching.
 * Handles patterns like:
 *  - y -> ies (opportunity -> opportunities, policy -> policies)
 *  - s/es (agent -> agents, patch -> patches, case -> cases)
 */
export function getEntityStems(name: string): string[] {
  const normalized = name.toLowerCase().trim()
  const stems = new Set<string>([normalized])

  if (normalized.endsWith('ies')) {
    stems.add(normalized.slice(0, -3) + 'y')
  }
  if (normalized.endsWith('y')) {
    stems.add(normalized.slice(0, -1) + 'ies')
  }
  if (normalized.endsWith('es')) {
    stems.add(normalized.slice(0, -2))
    stems.add(normalized.slice(0, -1))
  }
  if (normalized.endsWith('s') && !normalized.endsWith('ss')) {
    stems.add(normalized.slice(0, -1))
  }
  stems.add(normalized + 's')
  stems.add(normalized + 'es')

  return Array.from(stems)
}


// ── BullMQ producer ──────────────────────────────────────────────────────────

const generationQueue = new Queue<TestCaseGenerationJob>(
  QUEUES.TEST_CASE_GENERATION,
  getRedisOptions(),
)

// ── In-memory job status store (lightweight — no DB migration needed) ─────────
// Production-grade: swap for a Redis hash in QUEUES.TEST_CASE_GENERATION

const jobStatusStore = new Map<string, {
  status: 'queued' | 'running' | 'completed' | 'failed'
  projectId: string
  suiteName: string
  progress: number        // 0-100
  message: string
  generatedCount: number
  suiteId?: string        // set when done
  testCaseIds?: string[]
  error?: string
  startedAt: string
  completedAt?: string
}>()

export { jobStatusStore }

// ── Enqueue a generation job ──────────────────────────────────────────────────

export async function enqueueGenerationJob(params: {
  projectId: string
  suiteName?: string
  count: number
  focusAreas: string[]
  selectedModule?: string
  brdContent?: string
  existingTestsContent?: string
  useJira: boolean
}): Promise<{ jobId: string; suiteName: string }> {

  const ts        = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const suiteName = params.suiteName?.trim() || `Generated Suite – ${ts}`

  const job = await generationQueue.add(
    'generate',
    {
      projectId:             params.projectId,
      suiteName,
      count:                 params.count,
      focusAreas:            params.focusAreas,
      selectedModule:        params.selectedModule,
      brdContent:            params.brdContent,
      existingTestsContent:  params.existingTestsContent,
      useJira:               params.useJira,
    },
    { removeOnComplete: 50, removeOnFail: 20 },
  )

  const jobId = job.id!

  jobStatusStore.set(jobId, {
    status:         'queued',
    projectId:      params.projectId,
    suiteName,
    progress:       0,
    message:        'Job queued — waiting for worker…',
    generatedCount: 0,
    startedAt:      new Date().toISOString(),
  })

  log.info({ jobId, projectId: params.projectId, suiteName }, '[TCG] Generation job enqueued')
  return { jobId, suiteName }
}

// ── Get job status ────────────────────────────────────────────────────────────

export function getJobStatus(jobId: string) {
  const entry = jobStatusStore.get(jobId)
  if (!entry) return null
  return entry
}

// ── Multi-source context builder ──────────────────────────────────────────────
// Exported so it can be unit-tested independently

// ── Entity field manifest builder ─────────────────────────────────────────────
// Queries metadata_normalized for real field labels per Salesforce object /
// web app entity so the LLM has a strict, verified allowlist to draw from.

async function buildEntityFieldManifest(projectId: string): Promise<string> {
  try {
    // Load all field rows from DB
    const rows = await prisma.metadata_normalized.findMany({
      where: { project_id: projectId, entity_type: 'field' },
      select: { label: true, object_name: true, structured_json: true },
      orderBy: { object_name: 'asc' },
    })

    const repoCanonicals = await prisma.metadata_canonical.findMany({
      where: { project_id: projectId, source: 'repository' },
      select: { entity_name: true, form_fields: true },
    })

    if (rows.length === 0 && repoCanonicals.length === 0) {
      // Fallback: try webapp_crawl entity pages for field labels
      const webRows = await prisma.metadata_normalized.findMany({
        where: { project_id: projectId, entity_type: 'webapp_crawl' },
        select: { object_name: true, structured_json: true },
        take: 20,
      })
      if (webRows.length === 0) return ''

      const lines: string[] = [
        '=== APPLICATION FIELD MANIFEST (STRICT — only use these fields) ===',
        'DO NOT invent field names. If a field is not listed here, do NOT include it in your test steps.',
        '★ = Required field (MUST be filled or the form will refuse to save)',
        '⚡ = Lookup/reference field — must use LOOKUP action with a real record name',
        '',
      ]
      for (const row of webRows) {
        const data  = (row.structured_json ?? {}) as {
          pages?: Array<{
            path?: string
            form_fields?: string[]
            inputs?: Array<{ locator?: string; required?: boolean; locator_type?: string }>
            selects?: Array<{ locator?: string; required?: boolean; options?: string[] }>
            buttons?: Array<{ name?: string; locator?: string }>
          }>
        }
        const pages = data.pages ?? []
        for (const page of pages) {
          const hasInputs  = (page.inputs  ?? []).length > 0
          const hasSelects = (page.selects ?? []).length > 0
          if (!hasInputs && !hasSelects && !page.form_fields?.length) continue

          lines.push(`\n[Page: ${page.path ?? row.object_name}]`)

          // Use structured inputs if available
          if (hasInputs || hasSelects) {
            const allRequired: string[] = []
            const allOptional: string[] = []

            for (const inp of (page.inputs ?? [])) {
              const loc = inp.locator ?? ''
              if (!loc) continue
              const isLookup = /\b(account|contact|owner|parent|manager|assigned|lead|opportunity|vendor|customer|partner)\b/i.test(loc)
              const prefix = isLookup ? '⚡ ' : ''
              const marker = inp.required ? `★REQUIRED ${prefix}LOOKUP action` : ''
              if (inp.required) {
                allRequired.push(`  • "${loc}" — ${isLookup ? 'LOOKUP (required reference field)' : 'TYPE'}${marker ? ' (' + marker + ')' : ''}`)
              } else {
                allOptional.push(`  • "${loc}" (optional)`)
              }
            }
            for (const sel of (page.selects ?? [])) {
              const loc = sel.locator ?? ''
              if (!loc) continue
              const opts = Array.isArray(sel.options) ? sel.options.join(' | ') : ''
              if (sel.required) {
                allRequired.push(`  • "${loc}" — SELECT (required) [${opts || 'options unknown'}]`)
              } else {
                allOptional.push(`  • "${loc}" — SELECT (optional)`)
              }
            }

            if (allRequired.length > 0) {
              lines.push('  ★ REQUIRED fields (MUST fill all):')
              lines.push(...allRequired)
            }
            if (allOptional.length > 0) {
              lines.push('  Optional fields:')
              lines.push(...allOptional.slice(0, 8))
            }

            // Submit buttons
            const submitBtns = (page.buttons ?? []).filter(b => {
              const n = String(b.name ?? '').toLowerCase()
              return n.includes('create') || n.includes('save') || n.includes('submit') || n.includes('add')
            })
            if (submitBtns.length > 0) {
              const btnName = submitBtns[0].name ?? ''
              lines.push(`  ⚡ SUBMIT BUTTON: "${btnName}" — use this EXACT name as the CLICK target (locator_type: "role")`)
            }
          } else if (page.form_fields?.length) {
            // Legacy: plain string field list
            for (const f of page.form_fields) lines.push(`  • ${f}`)
          }
        }
      }
      // ── Inject REAL trigger/open-form button names from metadata_canonical ──
      // The LLM needs the EXACT button text to use in CLICK steps for opening
      // create/add forms (e.g. "+ New Term", "+ Add Account"). Without this,
      // the LLM hallucinates pluralized or incorrectly-spaced button names.
      try {
        const canonicalRows = await prisma.metadata_canonical.findMany({
          where: { project_id: projectId },
          select: {
            entity_name:            true,
            business_rules:         true,
            learned_rules:          true,
            primary_action_button:  true,
          },
        })

        if (canonicalRows.length > 0) {
          lines.push('')
          lines.push('=== ENTITY BUTTON MANIFEST (STRICT — use these EXACT button names) ===')
          lines.push('When generating CLICK steps to open a create/add form, you MUST use the')
          lines.push('EXACT button name listed below. DO NOT pluralize, singularize, add/remove')
          lines.push('spaces, or change capitalization. Copy the button name CHARACTER-FOR-CHARACTER.')
          lines.push('')

          for (const row of canonicalRows) {
            const br = (row.business_rules ?? {}) as Record<string, unknown>
            const lr = (row.learned_rules ?? {}) as Record<string, unknown>

            const triggerBtn = typeof br.trigger_button === 'string' && br.trigger_button.length > 0
              ? br.trigger_button : undefined
            const openBtn    = typeof lr.open_button === 'string' && lr.open_button.length > 0
              ? lr.open_button : undefined
            const submitBtn  = typeof row.primary_action_button === 'string' && row.primary_action_button.length > 0
              ? row.primary_action_button : undefined

            const effectiveOpenBtn = triggerBtn ?? openBtn
            if (!effectiveOpenBtn && !submitBtn) continue

            lines.push(`[${row.entity_name}]`)
            if (effectiveOpenBtn) {
              lines.push(`  🔘 OPEN FORM BUTTON: "${effectiveOpenBtn}" — use this EXACT text in the CLICK step to open the create/add form`)
            }
            if (submitBtn) {
              lines.push(`  ⚡ SUBMIT BUTTON: "${submitBtn}" — use this EXACT text in the CLICK step to save/submit the form`)
            }
            lines.push('')
          }

          lines.push('⚠️ CRITICAL: The button names above are CHARACTER-EXACT copies from the real app.')
          lines.push(`Using "+New Terms" when the real button says "+ New Term" will cause test FAILURE.`)
        }
      } catch (btnErr) {
        log.warn({ err: btnErr }, '[TCG] Failed to fetch canonical button names — skipping')
      }

      lines.push('')
      lines.push('⚡ = Lookup field: use LOOKUP action, not TYPE. Value must be a real record name from REAL ENTITY RECORDS.')
      return lines.length > 5 ? lines.join('\n') : ''
    }

    // Group by object
    const byObject = new Map<string, Array<{ label: string; type: string; required: boolean; source?: string }>>()
    for (const row of rows) {
      const obj  = row.object_name ?? 'Unknown'
      const json = (row.structured_json ?? {}) as Record<string, any>
      const type = String(json.type ?? json.soap_type ?? 'text').toLowerCase()
      const required = Boolean(json.required ?? json.nillable === false)
      const label = (row.label ?? '').trim()
      if (!label) continue
      if (!byObject.has(obj)) byObject.set(obj, [])
      byObject.get(obj)!.push({ label, type, required, source: 'crawler' })
    }

    for (const canon of repoCanonicals) {
      const obj = canon.entity_name
      const fields = Array.isArray(canon.form_fields)
        ? (canon.form_fields as Array<{ label: string; type: string; required: boolean }>)
        : []
      for (const f of fields) {
        const label = (f.label ?? '').trim()
        if (!label) continue
        if (!byObject.has(obj)) byObject.set(obj, [])
        const existing = byObject.get(obj)!.find(x => x.label.toLowerCase() === label.toLowerCase())
        if (existing) {
          existing.source = 'merged'
          if (f.required) existing.required = true
        } else {
          byObject.get(obj)!.push({
            label,
            type: String(f.type ?? 'text').toLowerCase(),
            required: Boolean(f.required),
            source: 'repository'
          })
        }
      }
    }

    if (byObject.size === 0) return ''

    const lines: string[] = [
      '=== ENTITY FIELD MANIFEST (CRITICAL — ONLY use field labels listed here) ===',
      'The following are the REAL, VERIFIED field names for each entity in this application.',
      'DO NOT invent field names. If a field is not listed here, do NOT include it in your test steps.',
      '★ = Required field — MUST be filled or the form will refuse to save.',
      '⚡ = Lookup/reference type — use LOOKUP action (not TYPE) with a real record name.',
      '',
    ]

    for (const [obj, fields] of byObject.entries()) {
      lines.push(`[${obj}] — ${fields.length} fields:`)
      for (const f of fields) {
        const isLookup = f.type === 'reference' || f.type === 'lookup'
        const req = f.required ? ' ★REQUIRED' : ''
        const lookupHint = isLookup ? ' ⚡LOOKUP' : ''
        const sourceStr = f.source ? ` (source: ${f.source})` : ''
        lines.push(`  • "${f.label}" (${f.type}${req}${lookupHint})${sourceStr}`)
      }
      lines.push('')
    }

    lines.push('★ = Required field (must be filled or test will fail on save)')
    lines.push('⚡ = Lookup/reference field — use LOOKUP action, value must be a real existing record name')
    return lines.join('\n')
  } catch (err) {
    log.warn({ err }, '[TCG] Failed to build entity field manifest — skipping')
    return ''
  }
}

// ── Verified URL path map builder ────────────────────────────────────────────
/**
 * Reads webapp_crawl metadata from DB and returns a deduplicated list of
 * real, crawler-verified URL paths for this project.
 * These are injected into the generation prompt so the LLM uses EXACT paths
 * in NAVIGATE steps and does NOT hallucinate paths like /softwares, /patchs, etc.
 */
async function buildVerifiedUrlMap(projectId: string): Promise<{
  baseUrl: string
  paths: string[]
}> {
  try {
    // 1. Fetch the project's configured base_url (canonical origin)
    const project = await prisma.projects.findUnique({
      where:  { id: projectId },
      select: { base_url: true },
    })
    const rawBase = project?.base_url ?? ''
    let baseUrl = ''
    try { baseUrl = rawBase ? new URL(rawBase).origin : '' } catch { baseUrl = rawBase }

    // 2. Also check project_integrations for a more specific base_url
    if (!baseUrl) {
      const integration = await prisma.project_integrations.findFirst({
        where:  { project_id: projectId },
        select: { base_url: true },
      })
      try { baseUrl = integration?.base_url ? new URL(integration.base_url).origin : '' } catch { /* ignore */ }
    }

    // 3. Extract all real paths from webapp_crawl metadata
    const webRows = await prisma.metadata_normalized.findMany({
      where:  { project_id: projectId, entity_type: 'webapp_crawl' },
      select: { structured_json: true },
    })

    const pathSet = new Set<string>()
    const SKIP = /^(login|logout|signin|signout|signup|register|auth|callback|oauth|sso|api|static|assets|_next|favicon|\.well-known)/i

    for (const row of webRows) {
      const data = (row.structured_json ?? {}) as { pages?: Array<{ path?: string }> }
      for (const page of data.pages ?? []) {
        const p = (page.path ?? '').trim()
        if (!p || p === '/' || SKIP.test(p)) continue
        // Normalise: ensure it starts with /
        const normalised = p.startsWith('/') ? p : `/${p}`
        pathSet.add(normalised)
      }
    }

    return { baseUrl, paths: [...pathSet].sort() }
  } catch (err) {
    log.warn({ err }, '[TCG] buildVerifiedUrlMap failed — skipping URL map injection')
    return { baseUrl: '', paths: [] }
  }
}
// ── Canonical Entity Context builder ───────────────────────────────────────────────────────────

/**
 * Query metadata_canonical for the entity derived from selectedModule and
 * return a formatted prompt block with:
 *   - Exact create_button, update_button, delete_button
 *   - Required fields list
 *   - action_flows (pre-computed CRUD workflow templates)
 *   - Up to 3 real_test_data records as concrete value examples
 *
 * Universal: works for ANY entity in ANY app — no entity-specific logic.
 * Returns empty string if no canonical record exists for this entity.
 */
async function buildCanonicalEntityContext(
  projectId: string,
  selectedModule?: string,
): Promise<string> {
  if (!selectedModule) return ''

  const entityHint = selectedModule
    .replace(/\s*(Management|List|Module|Feature|Settings)$/i, '')
    .trim()
  if (!entityHint || entityHint.length < 2) return ''

  try {
    const manifest = await buildFieldManifest(projectId, entityHint)
    if (!manifest) return ''

    // Only render this block when we have canonical data with action buttons
    // (prevents rendering an empty/useless block when canonical is missing)
    const hasActionData = manifest.openButton || manifest.submitButton || manifest.actionFlows
    if (!hasActionData) return ''

    const lines: string[] = [
      `## 🎯 CANONICAL ENTITY MANIFEST — ${manifest.entityName.toUpperCase()} (PRIMARY SOURCE — READ BEFORE EVERYTHING ELSE)`,
      '',
      `This is the AUTHORITATIVE data for the "${manifest.entityName}" entity, sourced from the live application.`,
      `All button names, field names, and test data below are EXACT — copy them CHARACTER-FOR-CHARACTER.`,
      '',
    ]

    // ── Action flows (canonical CRUD workflow) ───────────────────────────
    if (manifest.actionFlows && typeof manifest.actionFlows === 'object') {
      const flows = manifest.actionFlows as Record<string, {
        navigate_to?: string; trigger_button?: string; is_modal?: boolean;
        required_fields?: string[]; submit_button?: string;
        confirm_button?: string; assert_after?: string
      }>

      lines.push('### CRUD Workflow Templates (use EXACTLY — do not invent alternatives)')
      lines.push('')

      if (flows['create']) {
        const c = flows['create']
        lines.push(`**CREATE flow:**`)
        if (c.navigate_to)     lines.push(`  → Step 1 — NAVIGATE to: ${c.navigate_to}`)
        if (c.trigger_button)  lines.push(`  → Step 2 — CLICK: "${c.trigger_button}"  ← OPEN FORM BUTTON (exact)`)
        if (c.is_modal)        lines.push(`              (this opens a MODAL/DIALOG — do NOT navigate to a new page)`)
        if (c.required_fields?.length) {
          lines.push(`  → Fill required fields: ${c.required_fields.map(f => `"${f}" ★`).join(', ')}`)
        }
        if (c.submit_button)   lines.push(`  → Final CLICK: "${c.submit_button}"  ← SUBMIT BUTTON (exact)`)
        if (c.assert_after)    lines.push(`  → Then: ${c.assert_after}`)
        lines.push('')
      }

      if (flows['update']) {
        const u = flows['update']
        lines.push(`**UPDATE flow:**`)
        if (u.navigate_to)    lines.push(`  → Navigate to: ${u.navigate_to}`)
        if (u.trigger_button) lines.push(`  → CLICK: "${u.trigger_button}"  ← EDIT TRIGGER (exact)`)
        if (u.submit_button)  lines.push(`  → CLICK: "${u.submit_button}"  ← SAVE BUTTON`)
        lines.push('')
      }

      if (flows['delete']) {
        const d = flows['delete']
        lines.push(`**DELETE flow:**`)
        if (d.navigate_to)    lines.push(`  → Navigate to: ${d.navigate_to}`)
        if (d.trigger_button) lines.push(`  → CLICK: "${d.trigger_button}"  ← DELETE TRIGGER (exact)`)
        if (d.confirm_button) lines.push(`  → CLICK: "${d.confirm_button}"  ← CONFIRM button`)
        lines.push('')
      }
    } else {
      // No action_flows — render basic button info
      lines.push('### Buttons (exact names — copy character-for-character)')
      if (manifest.openButton)   lines.push(`  🔘 OPEN FORM BUTTON:  "${manifest.openButton}"`)
      if (manifest.submitButton) lines.push(`  ⚡ SUBMIT BUTTON:    "${manifest.submitButton}"`)
      if (manifest.updateButton) lines.push(`  ✏️  EDIT BUTTON:      "${manifest.updateButton}"`)
      if (manifest.deleteButton) lines.push(`  🗑️  DELETE BUTTON:   "${manifest.deleteButton}"`)
      if (manifest.searchField)  lines.push(`  🔍 SEARCH FIELD:    "${manifest.searchField}"`)
      lines.push('')
    }

    // ── Required fields ───────────────────────────────────────────────────
    const reqFields = manifest.fields.filter(f => f.required)
    if (reqFields.length > 0) {
      lines.push('### Required Fields (★ = MUST fill or form refuses to save)')
      for (const f of reqFields) {
        const typeLabel = f.type === 'lookup' ? '⚡LOOKUP' : f.type === 'select' ? '▼ SELECT' : '✏️  TYPE'
        const opts = f.options?.length ? ` (options: ${f.options.slice(0, 4).join(', ')})` : ''
        const sample = f.sampleValue ? ` [e.g.: "${f.sampleValue}"]` : ''
        lines.push(`  ★ ${f.label} [${typeLabel}]${opts}${sample}`)
      }
      lines.push('')
    }

    // ── Real test data samples ───────────────────────────────────────────────
    // Use up to 3 records as concrete value examples — avoids made-up data
    const samples = manifest.sampleRecords?.slice(0, 3) ?? []
    if (samples.length > 0) {
      lines.push('### Real Test Data (use these EXACT values in your steps — they exist in the app)')
      for (let i = 0; i < samples.length; i++) {
        const rec = samples[i] as Record<string, unknown>
        const pairs = Object.entries(rec)
          .filter(([k]) => !['id','created_at','updated_at','created_by','deleted_at'].includes(k.toLowerCase()))
          .slice(0, 8)
          .map(([k, v]) => `"${k}": "${String(v ?? '')}"`)  
          .join(', ')
        lines.push(`  Record ${i + 1}: { ${pairs} }`)
      }
      lines.push('')
    }

    lines.push('---')
    return lines.join('\n')

  } catch (err) {
    log.warn({ err, projectId, entityHint }, '[TCG] buildCanonicalEntityContext failed (non-fatal)')
    return ''
  }
}

export async function buildGenerationContext(params: {
  projectId: string
  brdContent?: string
  existingTestsContent?: string
  jiraStories?: Array<{ key: string; summary: string; description: string }>
  count: number
  focusAreas: string[]
  /** Optional module name to scope generation to a specific feature area */
  selectedModule?: string
}): Promise<{ systemPrompt: string; userPrompt: string; metadataContext: string }> {

  const { projectId, brdContent, existingTestsContent, jiraStories, count, focusAreas, selectedModule } = params

  const isCrud        = focusAreas.includes('CRUD')
  const isRealCases   = focusAreas.includes('Real Use Cases')
  const isNegative    = focusAreas.includes('Negative Testing')
  const isEdge        = focusAreas.includes('Edge Cases')

  // ── Fetch verified URL map from crawler data ─────────────────────────────────
  // This gives us the REAL paths the app uses so the LLM stops hallucinating
  // paths like /softwares, /patchs, or full domain-prefixed URLs.
  const { baseUrl: projectBaseUrl, paths: verifiedPaths } = await buildVerifiedUrlMap(projectId)
  log.info({ projectId, projectBaseUrl, pathCount: verifiedPaths.length }, '[TCG] Verified URL map built')

  // ── Source 4: Project metadata via RAG (CRUD-targeted, MODULE-SCOPED queries) ─
  // When a selectedModule is provided, ALL queries are prefixed with the module
  // name so cosine-similarity retrieval pulls chunks relevant to THAT entity
  // and not unrelated objects like Contract, Opportunity, Lead, etc.
  const modulePrefix = selectedModule ? `${selectedModule} ` : ''
  const ragQueryStrategies: string[] = []

  if (isCrud || isRealCases) {
    ragQueryStrategies.push(
      `${modulePrefix}create new record form fields buttons validation`,
      `${modulePrefix}edit update record form fields save button`,
      `${modulePrefix}delete remove record confirmation`,
      `${modulePrefix}form submission required fields error validation`
    )
  }
  if (isNegative || isEdge) {
    ragQueryStrategies.push(
      `${modulePrefix}required field validation error message empty null`,
      `${modulePrefix}boundary limit maximum minimum value error`,
      `${modulePrefix}duplicate record error unique constraint`
    )
  }
  if (ragQueryStrategies.length === 0) {
    ragQueryStrategies.push(
      selectedModule
        ? `${modulePrefix}test cases functionality workflows`
        : `test cases for ${focusAreas.join(' ') || 'all functional areas'} of this project`
    )
  }

  let allChunks: string[] = []
  for (const q of ragQueryStrategies.slice(0, 4)) {
    try {
      const chunks = await retrieveRagChunks(projectId, q, 10)
      allChunks.push(...chunks)
    } catch { /* skip */ }
  }
  // Deduplicate by content prefix
  const seen = new Set<string>()
  allChunks = allChunks.filter(c => {
    const key = c.slice(0, 80)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 30)

  // ── Module-scope chunk filter ────────────────────────────────────────────────
  // When a specific module is selected, aggressively filter out chunks that are
  // clearly about OTHER entities to prevent cross-entity contamination.
  if (selectedModule && allChunks.length > 0) {
    // Strip the " Management" suffix to get the raw entity keyword, e.g. "Software"
    const entityKeyword = selectedModule.replace(/\s+management$/i, '').trim().toLowerCase()
    const stems = getEntityStems(entityKeyword)

    // Build a set of common CRM/SF entities to exclude (these bleed in from SF orgs)
    const COMMON_NOISY_ENTITIES = [
      'contract', 'opportunity', 'lead', 'product', 'campaign', 'case', 'order',
      'quote', 'price book', 'pricebook', 'account', 'contact', 'event', 'task',
    ].filter(e => !stems.some(stem => e === stem || e.startsWith(stem) || stem.startsWith(e)))

    const entityPattern = new RegExp(
      `\\b(${COMMON_NOISY_ENTITIES.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
      'i'
    )

    const filteredChunks = allChunks.filter(chunk => {
      // Keep chunks that mention the selected module entity
      const chunkLower = chunk.toLowerCase()
      const mentionsOurEntity = stems.some(stem => chunkLower.includes(stem))
      // Reject chunks that predominantly talk about a noisy entity (not ours)
      const mentionsNoisyEntity = entityPattern.test(chunk)
      // Allow if it mentions our entity OR doesn't mention any noisy entity
      return mentionsOurEntity || !mentionsNoisyEntity
    })

    log.info(
      { projectId, selectedModule, before: allChunks.length, after: filteredChunks.length },
      '[TCG] Module-scoped chunk filter applied'
    )
    allChunks = filteredChunks
  }

  if (allChunks.length === 0) {
    // Fallback: generic query scoped to module if possible
    const fallbackQuery = selectedModule
      ? `${modulePrefix}application pages forms fields`
      : 'application pages forms fields'
    try { allChunks = await retrieveRagChunks(projectId, fallbackQuery, 15) } catch { /* */ }
  }

  const metadataContext = allChunks.length > 0
    ? `=== PROJECT METADATA (from live sync) ===\n${allChunks.join('\n\n---\n\n')}`
    : '=== PROJECT METADATA ===\n(No metadata synced yet — rely on document inputs and Jira stories.)'

  // ── Build focus-area-specific instructions ────────────────────────────────────
  const focusInstructions: string[] = []

  if (isCrud) {
    const crudMin = Math.max(4, Math.floor(count * 0.6))
    focusInstructions.push(`
### CRUD MANDATORY REQUIREMENTS (${crudMin} of your ${count} test cases MUST be CRUD workflows)
⚠️  FORBIDDEN: Do NOT generate "verify page loads", "verify button is clickable", or "verify sidebar" tests.
Those are smoke tests, NOT CRUD tests.

Each CRUD test case MUST be a complete multi-step workflow:
- **CREATE**: Navigate to the entity list page → CLICK the EXACT 🔘 OPEN FORM BUTTON from the Entity Button Manifest → fill required fields with realistic data → click the EXACT ⚡ SUBMIT BUTTON → assert success (URL change OR success toast)
   ⚠️ The OPEN FORM BUTTON name in your CLICK step MUST match the Entity Button Manifest CHARACTER-FOR-CHARACTER.
   ❌ WRONG: "+New Terms" when manifest says "+ New Term" — extra space and plural cause FAILURE.
   ✅ RIGHT: "+ New Term" — copied exactly from the manifest.
- **READ**: Navigate to the list → ASSERT_TEXT with the entity page heading (e.g. target="Opportunities", value="Opportunities") OR search/filter by a specific value then ASSERT_TEXT with that EXACT value. NEVER use an empty string for target or value in ASSERT_TEXT.
- **UPDATE**: Navigate to an existing record → click Edit → change at least 2 field values → save → verify the updated values are shown
- **DELETE**: Navigate to an existing record → trigger delete → confirm the confirmation dialog → verify the record is removed from the list

Distribute evenly: at least ${Math.floor(crudMin / 4)} of each C, R, U, D.`)
  }

  if (isRealCases) {
    focusInstructions.push(`
### REAL USE CASES MANDATORY REQUIREMENTS
Generate real-world business workflow tests that a real user would actually perform.
Examples of what "Real Use Cases" means:
- "Create a record with a required field left EMPTY → click Save → verify required field error appears"
- "Create a record with a duplicate name → verify duplicate error message"
- "Update a numeric field from 5000 to 10000 → verify the new value shows in the record detail"
- "Search for a record by a specific field → verify the correct record appears in results"
- "Create a record with invalid data in a validated field → verify validation error"
- "Delete a record and verify it no longer appears in the list"

Think like a business tester, not a UI tester. Test the BUSINESS LOGIC, not the pixels.`)
  }

  if (isNegative) {
    focusInstructions.push(`
### NEGATIVE TESTING MANDATORY REQUIREMENTS
Generate tests that deliberately provide invalid/missing/boundary-breaking inputs:
- Required field left empty → save → assert specific error message text
- Field value exceeds maximum length → assert truncation or validation error
- Invalid email format → assert format validation error
- Negative number in numeric field → assert validation error
- Special characters (SQL injection attempt) in text field → assert sanitized response
- Future date in "Date of Birth" field → assert validation error
Each negative test MUST include the EXACT expected error message text in expected_outcome.`)
  }

  if (isEdge) {
    focusInstructions.push(`
### EDGE CASE REQUIREMENTS
- Empty string vs whitespace-only inputs
- Maximum allowed values (at the boundary, not beyond)
- Concurrent-edit scenario (same record opened in two tabs)
- Record with all optional fields left blank
- Unicode characters and emoji in text fields
- Extremely long field values (near the max allowed characters)`)
  }

  // ── Build the multi-source system prompt ────────────────────────────────────
  const systemPrompt = buildSystemPrompt(count, focusAreas, selectedModule)

  // ── Build entity field manifest (DB-sourced real field labels) ───────────────
  const fieldManifest = await buildEntityFieldManifest(projectId)
  log.info({ projectId, hasManifest: fieldManifest.length > 0 }, '[TCG] Field manifest built')

  const userPromptParts: string[] = []

  // ── Canonical entity context (primary source — injected FIRST) ───────────
  // Queries metadata_canonical for the selected entity and renders a prompt block
  // with exact button names, required fields, and real data records.
  // Universal — works for any entity / any app without entity-specific logic.
  const canonicalEntityBlock = await buildCanonicalEntityContext(projectId, selectedModule)
  if (canonicalEntityBlock) {
    log.info({ projectId, selectedModule }, '[TCG] ✅ Canonical entity context injected into prompt')
  }

  // ★ ZERO: inject verified URL map FIRST so the LLM never invents paths
  if (verifiedPaths.length > 0 || projectBaseUrl) {
    const urlMapLines: string[] = [
      '## 🚨 CRITICAL — VERIFIED APPLICATION URL MAP (READ THIS BEFORE GENERATING ANY NAVIGATE STEPS)',
      '',
      '⛔ ABSOLUTE RULES FOR NAVIGATE STEPS:',
      '1. NAVIGATE step "value" MUST be a RELATIVE path (e.g. "/software", "/agents") — NEVER include a domain or protocol.',
      '2. You MUST use ONLY the paths listed in the "VERIFIED PAGE PATHS" table below.',
      '3. Do NOT guess, pluralize, or invent paths. If "/software" is listed, do NOT use "/softwares".',
      '4. Do NOT prefix paths with any domain (e.g. "https://d2d-uem.datasirpi.com/agents" is WRONG — use "/agents").',
      '5. If you are unsure of the exact path for a feature, pick the closest match from the table below.',
      '',
    ]
    if (projectBaseUrl) {
      urlMapLines.push(`Application Base URL (origin only — DO NOT copy into NAVIGATE value): ${projectBaseUrl}`)
      urlMapLines.push('')
    }
    if (verifiedPaths.length > 0) {
      urlMapLines.push('VERIFIED PAGE PATHS (use ONLY these in NAVIGATE steps):')
      for (const p of verifiedPaths) {
        urlMapLines.push(`  ✅ ${p}`)
      }
      urlMapLines.push('')
      urlMapLines.push('❌ WRONG: { "action": "NAVIGATE", "value": "https://d2d-uem.datasirpi.com/agents" }')
      urlMapLines.push('✅ RIGHT: { "action": "NAVIGATE", "value": "/agents" }')
      urlMapLines.push('❌ WRONG: { "action": "NAVIGATE", "value": "/softwares" }  ← invented plural, does not exist')
      urlMapLines.push('✅ RIGHT: { "action": "NAVIGATE", "value": "/software" }  ← exact path from the verified map above')
    } else {
      urlMapLines.push('(No crawled paths available — use short relative paths inferred from the metadata below)')
      urlMapLines.push('Still use ONLY relative paths starting with / — NEVER include a domain or full URL.')
    }
    userPromptParts.push(urlMapLines.join('\n'))
  }

  // ★ CANONICAL: inject the canonical entity block right after the URL map
  // This is the SECOND thing the LLM reads — more specific than the field
  // manifest and directly actionable (exact buttons + real data).
  if (canonicalEntityBlock) {
    userPromptParts.push(canonicalEntityBlock)
  }

  // ★ FIRST: inject field manifest so the LLM reads it before anything else
  if (fieldManifest) {
    userPromptParts.push(
      `## ⛔ CRITICAL — VERIFIED FIELD NAMES (READ THIS FIRST, BEFORE GENERATING ANYTHING)\n\n` +
      `The section below contains the EXACT, DATABASE-VERIFIED field labels for every entity in this application.\n` +
      `You MUST use ONLY these field names in your TYPE / SELECT / CHECKBOX / LOOKUP steps.\n` +
      `ANY field name you invent that is NOT listed below will cause test execution to FAIL.\n\n` +
      `❌ WRONG example: { "action": "TYPE", "target": "Value" } on Opportunity — "Value" does not exist\n` +
      `✅ RIGHT example: { "action": "TYPE", "target": "Amount" } on Opportunity — matches the manifest\n\n` +
      fieldManifest
    )
  }

  // Detect list-only module in the user-prompt builder too
  const _isListOnlyUp = selectedModule ? /\s+List$/i.test(selectedModule) : false
  const _moduleEntityUp = selectedModule?.replace(/\s+(Management|List)$/i, '').trim() ?? ''

  userPromptParts.push(
    `## Generation Request\n\nGenerate exactly **${count} test cases** for this project.\n` +
    (selectedModule
      ? [
          '',
          '🔴🔴🔴 MODULE SCOPE LOCK — NON-NEGOTIABLE 🔴🔴🔴',
          `You MUST generate test cases EXCLUSIVELY for the "${selectedModule}" module.`,
          `Every single test case in your output MUST be about "${selectedModule}" — nothing else.`,
          '',
          ...(_isListOnlyUp ? [
            `⚠️  "${_moduleEntityUp}" is a READ-ONLY LIST — there is NO create/edit/delete form.`,
            `✅ ONLY generate tests that navigate to the ${_moduleEntityUp} list, verify records, search/filter.`,
            `⛔ DO NOT generate Create, Edit, Delete tests for "${_moduleEntityUp}".`,
            '',
          ] : []),
          '⛔ FORBIDDEN — DO NOT generate test cases for ANY entity, page, or workflow that is NOT part of "' + selectedModule + '":',
          '  • Do NOT generate tests for entities other than "' + selectedModule + '" even if the metadata mentions them',
          '  • Only the selected module matters — ignore all other entities visible in navigation or metadata',
          '',
          `✅ ONLY generate test cases whose name, description, and steps are 100% about "${selectedModule}".`,
          `✅ Every test case NAME must contain the word "${_moduleEntityUp}" (e.g. "Create ${_moduleEntityUp}", "Delete ${_moduleEntityUp}").`,
          '🔴🔴🔴 END MODULE SCOPE LOCK 🔴🔴🔴',
          '',
        ].join('\n')
      : '') +
    (focusAreas.length > 0 ? `**Focus Areas Selected:** ${focusAreas.join(', ')}` : '')
  )


  // Focus-area specific mandatory instructions
  if (focusInstructions.length > 0) {
    userPromptParts.push(`\n---\n## MANDATORY FOCUS AREA INSTRUCTIONS\n${focusInstructions.join('\n')}`)
  }

  // Source 4 — metadata (always present)
  userPromptParts.push(`\n---\n## Project Metadata (Primary Source of Truth)\n\n${metadataContext}`)

  // Source 1 — BRD
  if (brdContent) {
    userPromptParts.push(`\n---\n## BRD / Functional Specification\n\n${brdContent.slice(0, 12000)}`)
  }

  // Source 3 — Jira
  if (jiraStories && jiraStories.length > 0) {
    const storiesText = jiraStories.map((s, i) =>
      `${i + 1}. **${s.key}** — ${s.summary}\n   ${s.description ? s.description.slice(0, 500) : '(no description)'}`
    ).join('\n\n')
    userPromptParts.push(`\n---\n## Jira User Stories (${jiraStories.length} stories)\n\n${storiesText}`)
  }

  // Source 2 — Existing tests
  if (existingTestsContent) {
    userPromptParts.push(`\n---\n## Existing Test Cases (Coverage Reference — DO NOT DUPLICATE)\n\n${existingTestsContent.slice(0, 8000)}`)
  }

  userPromptParts.push(`\n---\n## Output Format\n\nReturn a JSON array of exactly ${count} objects. Schema:\n\n[
  {
    "name": "Action-oriented name describing WHAT is being tested and HOW",
    "description": "Business scenario being validated",
    "priority": "low | medium | high",
    "steps": [
      { "id": "1", "action": "NAVIGATE", "value": "/contacts" },
      { "id": "2", "action": "CLICK", "target": "+ New Contact", "locator_type": "role" },
      { "id": "3", "action": "TYPE", "target": "First Name", "value": "Sam", "locator_type": "label" },
      { "id": "4", "action": "TYPE", "target": "Email", "value": "sam@example.com", "locator_type": "label" },
      { "id": "5", "action": "CLICK", "target": "Save", "locator_type": "role" },
      { "id": "6", "action": "ASSERT_URL", "value": "/contacts/", "locator_type": "url" }
    ],
    "expected_outcome": "Specific, measurable outcome with exact text/URL",
    "tags": ["CRUD", "Create"]
  }
]

⛔ OUTPUT RULES (violations cause test failures):
1. Output ONLY valid JSON array — no markdown, no explanations
2. Field labels in TYPE/SELECT/LOOKUP steps MUST exactly match the Entity Field Manifest above
   ❌ WRONG: "Value" on Opportunity  ✅ RIGHT: "Amount" on Opportunity
   ❌ WRONG: "Deal Name"              ✅ RIGHT: "Opportunity Name"
   ❌ WRONG: "Contact Email"          ✅ RIGHT: "Email"
3. Test names must describe the WORKFLOW — BAD: "Verify Page Loads" → GOOD: "Create Opportunity With Required Fields and Verify Success"
4. Every test must have at least 4 steps ending with an ASSERT
5. Use field-type-appropriate data — realistic names, valid emails, proper phone numbers, correct URLs:
   • Phone/Mobile fields → phone number ONLY (e.g., "+1 555-123-4567") ❌ NEVER "1234343" or "www.hsdbf.com"
   • Website/URL fields  → full URL ONLY (e.g., "https://www.example.com") ❌ NEVER a plain number or phone number
   • Email fields        → email ONLY (e.g., "user@example.com") ❌ NEVER a URL or phone number
   • Date fields         → MM/DD/YYYY ONLY (e.g., "06/30/2026") ❌ NEVER a name or phone number
   • Amount fields       → numeric digits ONLY (e.g., "50000") ❌ NEVER a name or date
6. Navigation-only tests (only NAVIGATE steps, no TYPE/CLICK/ASSERT) are REJECTED
7. ⛔ ASSERT_TEXT / ASSERT_TOAST / ASSERT_URL steps MUST NEVER have an empty target or value.
   For list-display READ tests: ASSERT_TEXT with target = the entity page heading, NOT an empty string.
   Example READ assertion: { "action": "ASSERT_TEXT", "target": "Entity List Page Heading", "locator_type": "text" }
   Example CRUD assertion: { "action": "ASSERT_TEXT", "target": "Record created successfully", "locator_type": "text" }
   A blank target ("") is INVALID and will be stripped — always use a real, non-empty text value.
8. ⛔ NAVIGATE steps MUST use ONLY relative paths from the VERIFIED APPLICATION URL MAP above.
   NEVER include a full URL with domain. NEVER pluralize or guess a path.
   WRONG example: "https://d2d-uem.datasirpi.com/softwares"  —  RIGHT example: "/software"
   WRONG example: "/patchs"  —  RIGHT example: "/patches" (only if it appears in the verified map)
9. 🔴 MANDATORY FOR ALL CREATE TESTS — Step 2 MUST be a CLICK to open the create form:
   ❌ WRONG: NAVIGATE /accounts/new → TYPE (no open-form click — test will FAIL at runtime)
   ✅ RIGHT:  NAVIGATE /accounts → CLICK "+ Add Account" → TYPE fields → CLICK "Save" → ASSERT_URL
   Use the EXACT button name from the 🔘 OPEN FORM BUTTON in the Entity Button Manifest above.
   NEVER navigate directly to /entity/new — ALWAYS navigate to the list page then CLICK the button.`)

  const userPrompt = userPromptParts.join('\n')

  return { systemPrompt, userPrompt, metadataContext }
}

// ── System prompt for multi-source generation ─────────────────────────────────

function buildSystemPrompt(count: number, focusAreas: string[] = [], selectedModule?: string): string {
  const isCrud      = focusAreas.includes('CRUD')
  const isRealCases = focusAreas.includes('Real Use Cases')
  const isNegative  = focusAreas.includes('Negative Testing')

  const crudEnforcement = (isCrud || isRealCases) ? `
## ⛔ STRICTLY FORBIDDEN (will cause test suite rejection)
- "Verify X page loads" — NOT a test case, it is a smoke check
- "Verify X button is clickable" — NOT a test case
- "Verify sidebar/menu/navigation" — NOT a test case
- Any test with fewer than 4 steps
- Tests that only NAVIGATE and do nothing else
- Duplicate test names or identical workflows

## ✅ REQUIRED: Every CRUD test MUST be a COMPLETE WORKFLOW
A CREATE test MUST:
  1. Navigate to the create/new form URL from the URL MAP
  2. Fill in ALL required fields with realistic data values — including required LOOKUP fields
     ⚠ LOOKUP fields (parent records, related records, owner, etc.) MUST use LOOKUP action, not TYPE.
     ⚠ NEVER skip a required lookup field — the form will NOT save without it.
  3. Click the EXACT submit button name from the metadata — NEVER use a generic "Save" unless it is the real button name
     ⚠ Copy the button name CHARACTER-FOR-CHARACTER from the PRIMARY ACTION BUTTON in the manifest
  4. Assert the result (ASSERT_URL to the list page is preferred over ASSERT_TOAST)

🔴 "WITH REQUIRED FIELDS" RULE:
  When a test case name contains "With Required Fields" or "Required Fields", you MUST include
  a step for EVERY field marked ★REQUIRED or ⚡LOOKUP in the Entity Field Manifest.
  Zero exceptions — missing one required field causes the test to FAIL at runtime.

An UPDATE test MUST:
  1. Navigate to an existing record (use a realistic record name from metadata)
  2. Click Edit
  3. Change at least 2 field values
  4. Save
  5. Assert the new values are visible

A DELETE test MUST:
  1. Navigate to the entity list
  2. Select a specific record
  3. Trigger delete action
  4. Confirm the dialog/modal
  5. Assert the record is gone from the list
` : ''

  const negativeEnforcement = isNegative ? `
## NEGATIVE TEST RULES
- Every negative test MUST supply an invalid value AND assert the EXACT error message text
- Use ASSERT_TEXT to verify the error message appears on screen
- Do NOT just click save and leave — you MUST verify the error response
` : ''

  // Detect whether this is a read-only "List" module (no create form)
  const isListOnlyModule = selectedModule ? /\s+List$/i.test(selectedModule) : false
  const moduleDisplayName = selectedModule?.replace(/\s+(Management|List)$/i, '').trim() ?? ''

  const moduleScopeBlock = selectedModule ? `
## 🔴🔴🔴 ENTITY SCOPE LOCK — ABSOLUTE RULE — READ THIS FIRST 🔴🔴🔴
You are generating tests for ONE SPECIFIC MODULE ONLY: "${selectedModule}"
${isListOnlyModule ? `
⚠️  "${moduleDisplayName}" is a READ-ONLY LIST module — it has NO create/edit/delete UI.
✅ Only generate tests that: navigate to the ${moduleDisplayName} list, verify records are shown, search/filter.
⛔ DO NOT generate Create, Edit, Update, or Delete tests for "${moduleDisplayName}".
⛔ DO NOT generate tests that click "Create ${moduleDisplayName}", "Add ${moduleDisplayName}", or "New ${moduleDisplayName}".
` : ''}
EVERY test case you generate MUST:
✓ Be named EXACTLY after a workflow in "${selectedModule}" — the module name or its root word MUST appear in the test name
✓ Have steps that interact ONLY with "${selectedModule}" pages and forms
✓ Assert outcomes specific to "${selectedModule}"

⛔ THE FOLLOWING RULE IS ABSOLUTE — DO NOT generate even ONE test case about ANY entity that is NOT "${selectedModule}":
• ANY entity, page, or workflow whose name does NOT match "${selectedModule}" is FORBIDDEN
• Even if the metadata mentions other entities — IGNORE them completely
• Only "${selectedModule}" tests are allowed — nothing else

⛔ TEST CASE NAMING RULE — MANDATORY:
Every test case name MUST contain the word "${moduleDisplayName}" (or its plural/abbreviation).
BAD:  "Create Agent and Verify Success"        ← REJECTED (wrong entity)
BAD:  "Create New Record and Verify"           ← REJECTED (too generic, entity unclear)
GOOD: "Create ${moduleDisplayName} With Required Fields and Verify Success"
GOOD: "Delete ${moduleDisplayName} and Verify Removal"

If the metadata context mentions any forbidden entities above, IGNORE THEM COMPLETELY.
Focus 100% on "${selectedModule}" — nothing else.
## 🔴🔴🔴 END ENTITY SCOPE LOCK 🔴🔴🔴
` : ''


  return `
You are a senior QA Automation Engineer specializing in end-to-end Playwright automation and risk-based test design.
${moduleScopeBlock}
## Your Role
Generate ${count} REAL, EXECUTABLE test cases that test actual business workflows — not UI smoke tests.
Think like a business tester validating that the software does what the business needs, not like a UI inspector checking if buttons exist.

## Input Sources (use ALL of them)
1. **Project Metadata (PRIMARY)** — Use exact field labels, button names, URLs, and picklist values from this source. Never invent values.
2. **BRD** — Extract user journeys and business rules to derive scenarios.
3. **Jira Stories** — Each story should become 1-2 concrete test cases covering its acceptance criteria.
4. **Existing Tests** — Reference for style; do NOT duplicate.

## Golden Rules
- ⛔ NEVER generate login/authentication steps — session is pre-managed
- ⛔ NEVER use fabricated field names, URLs, or button text — only use what is in the metadata
- ✅ Use realistic data: real names, valid emails, plausible amounts, actual dates
- ✅ Every test must end with an ASSERT verifying the outcome
- ✅ Vary priority: high=critical paths, medium=standard flows, low=edge/rare
- ✅ Each test must be independently executable (no dependencies on other tests)

## Field Value Type Rules (MANDATORY — violations cause test execution failures)
Each TYPE step value MUST be semantically appropriate for its field:
- **Phone / Mobile / Tel** fields → phone number ONLY (e.g., "+1 555-123-4567") ❌ NOT a URL or number like "1234343"
- **Website / URL / Link** fields → full URL ONLY (e.g., "https://www.example.com") ❌ NOT a phone number or plain number
- **Email / E-mail** fields → email address ONLY (e.g., "user@example.com") ❌ NOT a phone number or URL
- **Date** fields → MM/DD/YYYY format ONLY (e.g., "06/30/2026") ❌ NOT a name or phone number
- **Amount / Price / Cost** fields → numeric digits ONLY (e.g., "50000") ❌ NOT a name or date

❌ NEVER put a URL (e.g., "www.hsdbf.com") into a Phone field
❌ NEVER put a number (e.g., "1234343") into a Website/URL field
❌ NEVER put a phone number into an Email field or vice-versa
${crudEnforcement}${negativeEnforcement}
## Locator Priority (use in this order)
1. label  — getByLabel('Field Label') — for form inputs
2. role   — getByRole('button', { name: 'Submit' }) — for buttons/links
3. text   — getByText('Error: field required') — for assertions
4. css    — LAST RESORT only

## Step Count Rule
- Minimum 4 steps per test case
- Maximum 15 steps per test case
- Rich workflow tests (8-12 steps) are preferred over thin UI checks (2-3 steps)
`.trim()
}

// ── LLM factory (reuses same pattern as generation.service.ts) ────────────────

function useAnthropic(): boolean {
  const provider = (process.env.LLM_PROVIDER ?? '').toLowerCase()
  if (provider === 'anthropic') return true
  if (provider === 'openai')    return false
  // No explicit provider — prefer OpenAI only if key is present
  return !process.env.OPENAI_API_KEY
}

function buildLlm(): BaseChatModel {
  if (!useAnthropic() && process.env.OPENAI_API_KEY) {
    return new ChatOpenAI({
      apiKey:      process.env.OPENAI_API_KEY,
      model:       process.env.TC_GEN_MODEL ?? 'gpt-4o',
      temperature: 0.7,
    })
  }
  const model = process.env.CLAUDE_MODEL ?? (process.env.LLM_MODEL ?? 'claude-sonnet-4-20250514')
  return new ChatAnthropic({
    apiKey:      process.env.ANTHROPIC_API_KEY,
    model,
    maxTokens:   8192,
    temperature: 0.7,
  })
}

function buildFallbackLlm(): BaseChatModel {
  if (!useAnthropic() && process.env.OPENAI_API_KEY) {
    const model = process.env.CLAUDE_MODEL ?? (process.env.LLM_MODEL ?? 'claude-sonnet-4-20250514')
    return new ChatAnthropic({
      apiKey:      process.env.ANTHROPIC_API_KEY,
      model,
      maxTokens:   8192,
      temperature: 0.7,
    })
  }
  return new ChatOpenAI({
    apiKey:      process.env.OPENAI_API_KEY,
    model:       'gpt-4o',
    temperature: 0.7,
  })
}

// ── Core generation invocation ────────────────────────────────────────────────

export async function invokeBulkGeneration(
  systemPrompt: string,
  userPrompt:   string,
): Promise<Array<Record<string, unknown>>> {
  const parser = new StringOutputParser()
  const messages = [
    new SystemMessage(systemPrompt),
    new HumanMessage(userPrompt + '\n\nIMPORTANT: Respond with ONLY a valid JSON array. No markdown, no explanations.'),
  ]

  let raw: string
  try {
    const llm = buildLlm()
    raw = await llm.pipe(parser).invoke(messages)
  } catch (primaryErr) {
    log.warn({ err: primaryErr }, '[TCG] Primary LLM failed — falling back to OpenAI')
    const llm = buildFallbackLlm()
    raw = await llm.pipe(parser).invoke(messages)
  }

  // Strip markdown fences
  raw = raw.trim()
  if (raw.startsWith('```')) {
    raw = raw.split('\n').filter((l) => !l.trim().startsWith('```')).join('\n').trim()
  }

  // Find the JSON array in the response
  const start = raw.indexOf('[')
  const end   = raw.lastIndexOf(']')
  if (start === -1 || end === -1) throw new Error('LLM did not return a JSON array')

  const parsed = JSON.parse(raw.slice(start, end + 1))
  if (!Array.isArray(parsed)) throw new Error('LLM response was not a JSON array')

  return parsed as Array<Record<string, unknown>>
}

// ── Fetch Jira stories for the project ───────────────────────────────────────

export async function fetchJiraStoriesForProject(projectId: string): Promise<Array<{
  key: string
  summary: string
  description: string
}>> {
  try {
    const integration = await prisma.project_integrations.findFirst({
      where: { project_id: projectId, jira_board_id: { not: null } },
    })
    if (!integration?.jira_domain || !integration.jira_email || !integration.jira_token || !integration.jira_board_id) {
      log.info({ projectId }, '[TCG] No Jira config found — skipping Jira stories')
      return []
    }

    const { jira_domain, jira_email, jira_token, jira_board_id } = integration
    const auth = Buffer.from(`${jira_email}:${jira_token}`).toString('base64')

    // Fetch issues from the board's sprint or backlog
    const url = `${jira_domain}/rest/agile/1.0/board/${jira_board_id}/issue?maxResults=50&fields=summary,description,acceptance_criteria`
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    })
    if (!res.ok) {
      log.warn({ status: res.status, projectId }, '[TCG] Jira API call failed')
      return []
    }

    const data = await res.json() as { issues?: Array<{ key: string; fields?: { summary?: string; description?: string } }> }
    return (data.issues ?? []).map((issue) => ({
      key:         issue.key ?? '',
      summary:     issue.fields?.summary ?? '(no summary)',
      description: typeof issue.fields?.description === 'string'
        ? issue.fields.description.slice(0, 600)
        : '',
    }))
  } catch (err) {
    log.warn({ err, projectId }, '[TCG] Jira story fetch failed — proceeding without Jira context')
    return []
  }
}

// ── Step sanitizer ────────────────────────────────────────────────────────────
/**
 * Remove or repair degenerate assertion steps before storing to DB:
 *
 *  - ASSERT_TEXT / ASSERT_TOAST / ASSERT_URL with BOTH target AND value empty
 *    → drop them (they always fail with "Verify that '' is visible" nonsense)
 *
 *  - ASSERT_TEXT where target is empty but value has text → swap them (target
 *    is what Playwright looks for on the page)
 *
 *  - ASSERT_TEXT with empty target but value is also empty → try to substitute
 *    with entity name inferred from the test-case name as a last resort
 */
function sanitizeTestCaseSteps(
  steps: unknown[],
  testCaseName: string,
): unknown[] {
  const ASSERT_ACTIONS = new Set(['ASSERT_TEXT', 'ASSERT_TOAST', 'ASSERT_URL'])

  // Infer entity name from the test-case title for fallback assertions.
  // e.g. "Access Opportunities and Verify Opportunity List Display" → "Opportunities"
  const entityFallback = (() => {
    const m = testCaseName.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?(?:ies|s)?)\b/)
    return m ? m[1] : null
  })()

  return (steps as Array<Record<string, unknown>>).filter((step) => {
    if (!step || typeof step !== 'object') return false
    const action = String(step.action ?? '').toUpperCase()
    if (!ASSERT_ACTIONS.has(action)) return true  // non-assert steps always pass

    const target = String(step.target ?? '').trim()
    const value  = String(step.value  ?? '').trim()

    // Case 1: both empty → completely useless, drop it
    if (!target && !value) {
      log.warn(
        { action, testCaseName },
        '[TCG] Dropping degenerate assert step (empty target + empty value)',
      )
      return false
    }

    // Case 2: ASSERT_TEXT with empty target but value present → move value → target
    if (!target && value && action === 'ASSERT_TEXT') {
      step.target = value
      step.value  = ''
      log.info({ testCaseName, newTarget: value }, '[TCG] Swapped empty ASSERT_TEXT target ← value')
    }

    // Case 3: ASSERT_TEXT — target still empty after case 2 → use entity fallback
    const finalTarget = String(step.target ?? '').trim()
    if (!finalTarget && entityFallback && action === 'ASSERT_TEXT') {
      step.target = entityFallback
      log.info(
        { testCaseName, entityFallback },
        '[TCG] Injected entity fallback into empty ASSERT_TEXT target',
      )
    }

    return true
  })
}

// ── Persist generated test cases to DB ───────────────────────────────────────

export async function persistGeneratedTestCases(params: {
  projectId:      string
  suiteName:      string
  testCases:      Array<Record<string, unknown>>
  selectedModule?: string   // ← forwarded so autoCorrectButtonNames can be entity-scoped
}): Promise<{ suiteId: string; testCaseIds: string[] }> {
  const { projectId, suiteName, testCases, selectedModule } = params

  // Store the suite metadata in test_data_sets (lightweight — no migration needed)
  const suite = await prisma.test_data_sets.create({
    data: {
      name:       suiteName,
      project_id: projectId,
      data: {
        suite_type: 'ai_generated',
        generated_at: new Date().toISOString(),
        test_case_count: testCases.length,
      } as any,
    },
  })

  // Persist each test case
  const createdIds: string[] = []
  for (const tc of testCases) {
    try {
      const rawSteps = Array.isArray(tc['steps']) ? tc['steps'] as Array<Record<string, any>> : []
      const tcName   = String(tc['name'] ?? 'Generated Test Case')

      // ── Infer entity from selectedModule or the test-case name ───────────────
      // Priority: 1) selectedModule  2) first capitalised word after common verbs in tcName
      const entityHint: string = (
        selectedModule
          ? selectedModule.replace(/\s*(Management|List|Module|Feature|Settings)$/i, '').trim()
          : (() => {
              const stripped = tcName
                .replace(/^(create|update|edit|delete|view|add|manage|verify|test|check|search|list|open|close)\s+/i, '')
                .replace(/\b(new|a|an|the|successfully|with|for|and|or|record|records|details|detail|form|page|module|entry|item|valid|invalid|existing|required|optional|active|inactive|duplicate|mandatory|basic|empty|updated|given|correct|incorrect|multiple|successful)\b/gi, '')
                .trim()
              const m = stripped.match(/\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)?)\b/)
              return m?.[1] ?? stripped.split(/\s+/)[0] ?? ''
            })()
      )

      // ── Universal post-correction: fix button names, field names, assert types ─
      // Called here so EVERY code path (agent, direct LLM, chat) is covered.
      if (entityHint && entityHint.length > 2) {
        await autoCorrectButtonNames(rawSteps, projectId, entityHint)
      }

      // ── Inject missing open-form CLICK step for CREATE tests ─────────────────
      // If the LLM skipped the open-form button click (going NAVIGATE→TYPE directly),
      // inject it here so the test doesn't fail at runtime due to no modal being open.
      const isCreateTest = /^(create|add|new)\b/i.test(tcName.trim())
      if (isCreateTest && rawSteps.length >= 2) {
        const firstStep  = rawSteps[0] as Record<string, any>
        const secondStep = rawSteps[1] as Record<string, any>
        const firstIsNav  = String(firstStep?.action ?? '').toUpperCase() === 'NAVIGATE'
        const secondIsType = ['TYPE','SELECT','LOOKUP','CHECKBOX','MULTI_SELECT'].includes(
          String(secondStep?.action ?? '').toUpperCase()
        )

        if (firstIsNav && secondIsType && entityHint && entityHint.length > 2) {
          // Resolve the real open-form button name from metadata_canonical
          try {
            const cleanHint = entityHint.trim()
            const depluralizeHint = cleanHint.endsWith('s') && !cleanHint.endsWith('ss')
              ? cleanHint.slice(0, -1) : cleanHint
            const canonical = await prisma.metadata_canonical.findFirst({
              where: {
                project_id: projectId,
                OR: [
                  { entity_name: { contains: cleanHint,      mode: 'insensitive' } },
                  { entity_name: { contains: depluralizeHint, mode: 'insensitive' } },
                ],
              },
              select: { business_rules: true, learned_rules: true },
            })

            const br = (canonical?.business_rules ?? {}) as Record<string, unknown>
            const lr = (canonical?.learned_rules  ?? {}) as Record<string, unknown>
            const openBtn = (
              (typeof br.trigger_button === 'string' && br.trigger_button.length > 0 ? br.trigger_button : undefined) ??
              (typeof lr.open_button   === 'string' && lr.open_button.length   > 0 ? lr.open_button   : undefined) ??
              `+ New ${cleanHint}`
            )

            const clickStep = {
              id:           '2',
              action:       'CLICK',
              target:       openBtn,
              locator_type: 'role',
            }
            // Insert after step 1 (NAVIGATE), before step 2 (TYPE)
            rawSteps.splice(1, 0, clickStep)
            // Renumber all steps
            rawSteps.forEach((s: any, i: number) => { s.id = String(i + 1) })
            log.info(
              { tcName, openBtn, entityHint },
              '[TCG] ✅ Injected missing open-form CLICK step — LLM skipped it',
            )
          } catch (injectErr) {
            log.warn({ err: injectErr, tcName }, '[TCG] Failed to inject open-form CLICK — skipping injection')
          }
        }
      }

      // ── Sanitize: drop / fix degenerate assert steps before storing ──────────
      const cleanSteps = sanitizeTestCaseSteps(rawSteps, tcName)

      const created = await prisma.test_cases.create({
        data: {
          name:            tcName.slice(0, 255),
          description:     String(tc['description'] ?? '').slice(0, 2000),
          steps:           cleanSteps as any,
          priority:        (['low', 'medium', 'high'].includes(String(tc['priority'])) ? String(tc['priority']) : 'medium'),
          status:          'review',
          project_id:      projectId,
          expected_result: String(tc['expected_outcome'] ?? '').slice(0, 2000) || null,
        },
      })
      createdIds.push(created.id)
    } catch (err) {
      log.warn({ err, tcName: tc['name'] }, '[TCG] Failed to persist one test case — skipping')
    }
  }

  log.info({ suiteId: suite.id, count: createdIds.length, projectId }, '[TCG] Test cases persisted')
  return { suiteId: suite.id, testCaseIds: createdIds }
}


// ── Post-generation module scope filter ──────────────────────────────────────
/**
 * Hard-rejects test cases that clearly reference a different entity than the
 * selected module. Called immediately after the LLM returns its output, before
 * any test cases are persisted to the database.
 *
 * This is the FINAL safety net: even if the system/user prompts are ignored,
 * off-module test cases (e.g. "Create Agent" when module="Dashboard") are
 * stripped here and never saved.
 *
 * Strategy:
 *  1. Derive the "entity keyword" from selectedModule (e.g. "Agent Management" → "agent")
 *  2. Build a deny-list of OTHER common entity names that should NOT appear in
 *     test case names for this module.
 *  3. A test case is REJECTED if:
 *     a. Its name does NOT contain the entity keyword, AND
 *     b. Its name DOES contain a different known entity keyword
 *  4. A test case always passes if it mentions the correct entity keyword at all.
 *
 * Note: we keep test cases even if they don't mention the entity keyword, as
 * long as they don't mention a conflicting entity. Generic names like "Verify
 * List View" are allowed — they are not clearly off-module.
 */
export function filterTestCasesToModule(
  testCases: Array<Record<string, unknown>>,
  selectedModule: string,
): Array<Record<string, unknown>> {
  // Derive root entity word, e.g. "Agent Management" → "agent"
  const entityKeyword = selectedModule
    .replace(/\s*(Management|List|Module|Feature|Settings)$/i, '')
    .trim()
    .toLowerCase()

  const stems = getEntityStems(entityKeyword)

  // Known entity names that are commonly hallucinated when unrelated to the
  // selected module. Extend this list as new patterns emerge.
  const KNOWN_ENTITIES = [
    'agent', 'agents',
    'contract', 'contracts',
    'opportunity', 'opportunities',
    'lead', 'leads',
    'product', 'products',
    'campaign', 'campaigns',
    'account', 'accounts',
    'contact', 'contacts',
    'case', 'cases',
    'quote', 'quotes',
    'order', 'orders',
    'invoice', 'invoices',
    'customer', 'customers',
    'vendor', 'vendors',
    'patch', 'patches',
    'policy', 'policies',
    'asset', 'assets',
    'device', 'devices',
    'role', 'roles',
    'user', 'users',
    'ticket', 'tickets',
    'incident', 'incidents',
    'vulnerability', 'vulnerabilities',
    'software', 'endpoint', 'endpoints',
  ]

  // Build deny-set: all known entities EXCEPT the selected module's own keyword stems
  const denyKeywords = KNOWN_ENTITIES.filter(e => {
    return !stems.some(stem => e === stem || e.startsWith(stem) || stem.startsWith(e))
  })

  const before = testCases.length
  const filtered = testCases.filter(tc => {
    const name = String(tc['name'] ?? '').toLowerCase()
    const desc = String(tc['description'] ?? '').toLowerCase()
    const combined = `${name} ${desc}`

    // Always keep if the correct entity keyword stem appears in name or description
    if (stems.some(stem => combined.includes(stem))) return true

    // Reject if a DIFFERENT known entity keyword appears prominently in the NAME

    // (description can mention related entities for context — only police the name)
    const hasForeignEntity = denyKeywords.some(deny => {
      // Match whole-word to avoid false positives (e.g. "cases" in "test cases")
      const re = new RegExp(`\\b${deny}\\b`, 'i')
      return re.test(name)
    })

    if (hasForeignEntity) {
      log.info(
        { selectedModule, testCaseName: tc['name'] },
        '[TCG] REJECTED off-module test case (foreign entity in name)'
      )
      return false
    }

    // No conflict — generic test case name (e.g. "Verify List View") → keep it
    return true
  })

  if (filtered.length < before) {
    log.warn(
      { selectedModule, before, after: filtered.length, rejected: before - filtered.length },
      '[TCG] Post-generation filter removed off-module test cases'
    )
  }

  return filtered
}

// ── BullMQ Worker (started inline — single-process architecture like other workers) ──

let _workerStarted = false

export function startTestCaseGenerationWorker() {
  if (_workerStarted) return
  _workerStarted = true

  const worker = new Worker<TestCaseGenerationJob>(
    QUEUES.TEST_CASE_GENERATION,
    async (job) => {
      const { projectId, suiteName, count, focusAreas, selectedModule, brdContent, existingTestsContent, useJira } = job.data
      const jobId = job.id!

      const updateStatus = (
        status:   'queued' | 'running' | 'completed' | 'failed',
        progress: number,
        message:  string,
        extras:   Record<string, unknown> = {},
      ) => {
        const existing = jobStatusStore.get(jobId)
        jobStatusStore.set(jobId, {
          status,
          projectId,
          suiteName:      suiteName ?? '',
          progress,
          message,
          generatedCount: (existing?.generatedCount ?? 0),
          startedAt:      existing?.startedAt ?? new Date().toISOString(),
          ...extras,
        })
      }

      try {
        updateStatus('running', 5, 'Collecting project context…')

        // Fetch Jira stories if requested
        let jiraStories: Array<{ key: string; summary: string; description: string }> = []
        if (useJira) {
          updateStatus('running', 15, 'Fetching Jira stories…')
          jiraStories = await fetchJiraStoriesForProject(projectId)
          log.info({ projectId, storyCount: jiraStories.length }, '[TCG] Jira stories fetched')
        }

        updateStatus('running', 30, 'Building AI context from all sources…')
        const { systemPrompt, userPrompt } = await buildGenerationContext({
          projectId,
          brdContent,
          existingTestsContent,
          jiraStories,
          count,
          focusAreas,
          selectedModule,
        })

        updateStatus('running', 55, 'Calling AI to generate test cases…')
        let rawTestCases = await invokeBulkGeneration(systemPrompt, userPrompt)
        log.info({ projectId, rawCount: rawTestCases.length }, '[TCG] AI returned test cases')

        // ── Post-generation module scope validation ───────────────────────────
        // Hard-reject any test case whose name clearly references an entity other
        // than the selected module. This is the final safety net against the LLM
        // hallucinating content for wrong modules (e.g. generating "Create Agent"
        // test cases when the selected module is "Dashboard" or vice versa).
        if (selectedModule && rawTestCases.length > 0) {
          rawTestCases = filterTestCasesToModule(rawTestCases, selectedModule)
          log.info({ projectId, selectedModule, filteredCount: rawTestCases.length }, '[TCG] Post-generation module filter applied')
        }

        updateStatus('running', 80, `Saving ${rawTestCases.length} test cases to database…`)
        const { suiteId, testCaseIds } = await persistGeneratedTestCases({
          projectId,
          suiteName:      suiteName ?? `Generated Suite – ${new Date().toISOString()}`,
          testCases:      rawTestCases,
          selectedModule, // ← forward so button/field correction is entity-scoped
        })

        updateStatus('completed', 100, `Done! Generated ${testCaseIds.length} test cases.`, {
          generatedCount: testCaseIds.length,
          suiteId,
          testCaseIds,
          completedAt: new Date().toISOString(),
        })

        log.info({ jobId, projectId, suiteId, count: testCaseIds.length }, '[TCG] Generation job completed')
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        log.error({ err, jobId, projectId }, '[TCG] Generation job failed')
        const existing = jobStatusStore.get(jobId)
        jobStatusStore.set(jobId, {
          status:         'failed',
          projectId,
          suiteName:      suiteName ?? '',
          progress:       0,
          message:        `Generation failed: ${msg}`,
          generatedCount: 0,
          error:          msg,
          startedAt:      existing?.startedAt ?? new Date().toISOString(),
          completedAt:    new Date().toISOString(),
        })
        throw err
      }
    },
    { ...getRedisOptions(), concurrency: 2 },
  )

  worker.on('error', (err) => log.error({ err }, '[TCG] Worker error'))
  log.info('[TCG] Test-case-generation worker started')
}

// ── Action alias normalizer (mirrors generation.service.ts normaliseAction) ────
// Catches any surviving FILL_FORM / ENTER / SET action names before DB persist.
const TCG_ACTION_ALIASES: Record<string, string> = {
  fill_form: 'TYPE', fillform: 'TYPE', fill_field: 'TYPE', fillfield: 'TYPE',
  enter: 'TYPE', enter_text: 'TYPE', set: 'TYPE', set_text: 'TYPE',
  settext: 'TYPE', input_text: 'TYPE', write: 'TYPE', type_text: 'TYPE',
  press: 'CLICK', tap: 'CLICK', submit: 'CLICK', button_click: 'CLICK',
  choose: 'SELECT', pick: 'SELECT', dropdown: 'SELECT', select_option: 'SELECT',
  goto: 'NAVIGATE', go_to: 'NAVIGATE', open: 'NAVIGATE', visit: 'NAVIGATE',
}

const TCG_CANONICAL_ACTIONS = new Set([
  'NAVIGATE','CLICK','TYPE','FILL','INPUT','SELECT','LOOKUP','CHECKBOX',
  'ASSERT_TEXT','ASSERT_URL','ASSERT_TOAST','WAIT','MULTI_SELECT','UPLOAD',
])

function normaliseActionAlias(action: string): string {
  const upper = (action ?? '').toUpperCase().trim()
  if (TCG_CANONICAL_ACTIONS.has(upper)) return upper
  const mapped = TCG_ACTION_ALIASES[(action ?? '').toLowerCase().trim()]
  if (mapped) {
    log.warn(`[TCG] normaliseAction: mapped "${action}" → "${mapped}"`)
    return mapped
  }
  return upper
}

function normaliseSteps(steps: unknown[]): unknown[] {
  return (steps as Array<Record<string, unknown>>).map(s => ({
    ...s,
    action: normaliseActionAlias(String(s.action ?? '')),
  }))
}

// ── On-demand step generation for selected test cases ─────────────────────────
/**
 * Called when the user clicks "Add Selected to Tests" on the frontend.
 * For each selected test case (which was created without steps during bulk
 * generation), this function:
 *   1. Fetches the test case (name + description) from the DB
 *   2. Routes through runTestStepGeneratorAgent (STEP_GEN_MODEL) for validated
 *      metadata-grounded step generation with 6-check validation + self-correction
 *   3. Applies action alias normalization (FILL_FORM → TYPE, etc.)
 *   4. Persists the steps back to the test case record
 */
export async function generateStepsForTestCases(
  projectId: string,
  testCaseIds: string[],
  selectedModule?: string,
  brdContent?: string,
  existingTestsContent?: string,
): Promise<{ generated: number; failed: number; errors: string[] }> {
  let generated = 0
  let failed = 0
  const errors: string[] = []

  const testCases = await prisma.test_cases.findMany({
    where: { id: { in: testCaseIds }, project_id: projectId },
    select: { id: true, name: true, description: true, priority: true, expected_result: true },
  })

  // Lazily import the STEP_GEN_MODEL agent (avoids circular deps at module load)
  let runTestStepGeneratorAgent: typeof import('../ai-agents/test-step-generator.agent.js').runTestStepGeneratorAgent
  let detectOperationType: typeof import('../ai-agents/test-step-generator.agent.js').detectOperationType | undefined
  try {
    const agentMod = await import('../ai-agents/test-step-generator.agent.js')
    runTestStepGeneratorAgent = agentMod.runTestStepGeneratorAgent
    detectOperationType = agentMod.detectOperationType
  } catch (importErr) {
    log.warn({ err: importErr }, '[TCG] Could not import runTestStepGeneratorAgent — will use direct LLM fallback')
  }

  // Fetch RAG context once for all cases (used for direct-LLM fallback path)
  // NOTE: We use a general query here — per-test-case queries happen inside the agent.
  // The fallback path only needs broad context.
  const ragQuery = selectedModule
    ? `${selectedModule} create edit update delete form fields buttons navigation existing records`
    : 'create edit update delete form fields buttons navigation existing records'
  let ragContext = ''
  try {
    const chunks = await retrieveRagChunks(projectId, ragQuery, 15)
    if (chunks.length > 0) {
      ragContext = `=== PROJECT METADATA (from live sync) ===\n${chunks.join('\n\n---\n\n')}`
    }
  } catch { /* skip */ }

  let fieldManifest = ''
  try { fieldManifest = await buildEntityFieldManifest(projectId) } catch { /* skip */ }

  for (const tc of testCases) {
    try {
      let steps: unknown[] = []

      // Extract entity filter from test case name or selected module.
      // Must strip verb prefixes ("Create", "Update", etc.) and noise words
      // to get the actual entity noun. This is used by BOTH the agent path
      // and the cross-entity CLICK filter below.
      const tcOpType = detectOperationType ? detectOperationType(tc.name) : 'unknown'
      log.info({ tcId: tc.id, tcName: tc.name, tcOpType }, '[TCG] Detected operation type for test case')

      const entityFilter = selectedModule
        ? selectedModule.replace(/\s*(Management|List|Module|Feature)$/i, '').trim()
        : (() => {
            const stripped = tc.name
              .replace(/^(create|update|edit|delete|view|add|manage|verify|test|check|search|list|open|close)\s+/i, '')
              .replace(/\b(new|a|an|the|successfully|with|for|and|or|record|records|details|detail|form|page|module|entry|item|valid|invalid|existing|required|optional|active|inactive|duplicate|mandatory|basic|empty|updated|given|correct|incorrect|multiple|successful)\b/gi, '')
              .trim()
            // Case-agnostic: normalize to lowercase so ALL-CAPS, TitleCase, mixed-case all work
            const STOP = new Set(['the','and','for','with','new','all','record','records','form','page','test','case'])
            const words = stripped.toLowerCase().split(/\s+/).filter(w => w.length >= 3 && !STOP.has(w))
            const entity = words[0] ?? stripped.split(/\s+/)[0] ?? ''
            return entity.charAt(0).toUpperCase() + entity.slice(1)
          })()


      // ── Primary path: STEP_GEN_MODEL agent ──────────────────────────────────
      // The agent has a 6-check validation gate + up to 3 self-correction loops:
      //   Check 1: Required field coverage
      //   Check 2: URL verification
      //   Check 3: Button name exactness (rejects "Save" if actual button is "Create Account")
      //   Check 4: Locator type validity
      //   Check 5: Data type alignment (rejects Industry="Tara", Website=number, etc.)
      //   Check 6: Action name validity (rejects FILL_FORM, ENTER, SET, SUBMIT, etc.)
      if (runTestStepGeneratorAgent!) {
        try {

          log.info(
            { tcId: tc.id, tcName: tc.name, entityFilter },
            '[TCG] Routing to STEP_GEN_MODEL agent'
          )

          const agentOutput = await runTestStepGeneratorAgent({
            projectId,
            testName:     tc.name,
            description:  tc.description ?? tc.name,
            entityFilter: entityFilter || undefined,
            brdContent,
            existingTestsContent,
          })

          log.info(
            {
              tcId: tc.id, steps: agentOutput.steps.length,
              loops: agentOutput.loopCount, passed: agentOutput.validation.passed,
              issues: agentOutput.validation.issues,
            },
            '[TCG] STEP_GEN_MODEL agent completed'
          )

          steps = agentOutput.steps.map((s, i) => ({
            id:           String(i + 1),
            action:       normaliseActionAlias(s.action),
            target:       s.target,
            value:        s.value,
            locator_type: s.locator_type,
          }))

        } catch (agentErr) {
          log.warn({ err: agentErr, tcId: tc.id }, '[TCG] STEP_GEN_MODEL agent failed — falling back to direct LLM')
          steps = [] // signal to use fallback below
        }
      }

      // ── Fallback path: Direct LLM with strict action schema ─────────────────
      // Used only when agent import failed or agent threw an unrecoverable error.
      if (steps.length === 0) {
        const moduleScopeLines = selectedModule ? [
          '',
          `## 🔴 MODULE SCOPE LOCK: Generate steps for the "${selectedModule}" module ONLY.`,
          `⛔ FORBIDDEN: Do NOT generate steps for any entity outside "${selectedModule}". Only generate steps for "${selectedModule}".`,
          '',
        ] : []

        const systemPrompt = [
          'You are a senior QA Automation Engineer. Generate executable Playwright test steps for the given test case.',
          ...moduleScopeLines,
          '',
          '## Golden Rules',
          '- NEVER generate login steps — authentication is pre-managed',
          '- Use ONLY field names verified in the Entity Field Manifest below',
          '- Every test must end with an ASSERT step',
          '- Use realistic data: real names, valid emails, plausible amounts',
          '- Minimum 4 steps, maximum 15 steps',
          '',
          '╔══════════════════════════════════════════════════════════════╗',
          '║  VALID ACTIONS — USE ONLY THESE EXACT STRINGS                ║',
          '║  NAVIGATE · CLICK · TYPE · SELECT · LOOKUP · CHECKBOX        ║',
          '║  ASSERT_TEXT · ASSERT_URL · ASSERT_TOAST · WAIT              ║',
          '╠══════════════════════════════════════════════════════════════╣',
          '║  ⛔ FORBIDDEN (will be skipped at runtime — NEVER use):      ║',
          '║     FILL_FORM  FILL  ENTER  SET  SET_TEXT  INPUT_TEXT        ║',
          '║     WRITE  TYPE_TEXT  PRESS  TAP  SUBMIT  BUTTON_CLICK       ║',
          '║  Use TYPE to fill a form field. Use CLICK to click a button. ║',
          '╚══════════════════════════════════════════════════════════════╝',
          '',
          '## Button Name Rule (CRITICAL)',
          '- For the submit/save button, use ONLY the EXACT button label visible on screen.',
          '- Look for it in the Entity Field Manifest or Project Metadata below.',
          '- NEVER use generic names: "Save", "Submit", "OK" are WRONG unless explicitly listed.',
          '- Use ONLY the button for the SAME ENTITY as this test case. Do NOT click buttons for other entities.',
          '- NEVER click buttons for OTHER entities. Sidebars/navbars show buttons for all entities — IGNORE buttons for entities you are NOT testing.',
          '',
          '## Locator Priority',
          '1. label — for form inputs (locator_type: "label")',
          '2. role  — for buttons/links (locator_type: "role")',
          '3. text  — for assertions (locator_type: "text")',
          '4. css   — LAST RESORT',
          '',
          // Null-manifest fallback: tell LLM to use BRD/RAG when no manifest available
          // Operation-aware fallback instructions — use tcOpType for strict operation-specific guidance
          (() => {
            if (tcOpType === 'update') return [
              '## 🔴 UPDATE OPERATION — MANDATORY SEQUENCE (DO NOT DEVIATE):',
              `This is an UPDATE/EDIT test for entity: "${entityFilter}".`,
              '⛔ FORBIDDEN: Do NOT navigate to /new, /create, /add URLs.',
              '⛔ FORBIDDEN: Do NOT click "+ New <Entity>" or "Create <Entity>" buttons.',
              '',
              'REQUIRED 7-STEP SEQUENCE:',
              `  1. NAVIGATE to the ${entityFilter} LIST page (NOT /new or /create)`,
              `  2. TYPE the record name in the search input (use a real record from SAMPLE DATA above)`,
              `  3. CLICK the record name to open its detail page`,
              `  4. CLICK "Edit" (or the edit button from the manifest) to enter edit mode`,
              `  5. TYPE/SELECT the fields mentioned in the test name (e.g. Weight, Dimensions, SKU)`,
              `  6. CLICK the Save button to save changes`,
              `  7. ASSERT_URL or ASSERT_TEXT to verify the update succeeded`,
            ].join('\n')
            if (tcOpType === 'delete') return [
              '## 🔴 DELETE OPERATION — MANDATORY SEQUENCE:',
              `  1. NAVIGATE to the ${entityFilter} LIST page`,
              `  2. TYPE the record name in the search input`,
              `  3. CLICK the record to open its detail page`,
              `  4. CLICK the Delete button`,
              `  5. CLICK Confirm (if a confirmation dialog appears)`,
              `  6. ASSERT that the record was deleted (e.g. redirected to list, or toast message)`,
            ].join('\n')
            if (tcOpType === 'view') return [
              '## 🔴 VIEW OPERATION — MANDATORY SEQUENCE:',
              `  1. NAVIGATE to the ${entityFilter} LIST page`,
              `  2. TYPE the record name in the search input`,
              `  3. CLICK the record to open its detail page`,
              `  4. ASSERT_URL or ASSERT_TEXT to verify the record detail page loaded`,
            ].join('\n')
            // CREATE (default)
            if (!fieldManifest) return [
              '## 🔴 CREATE OPERATION — NO FIELD MANIFEST',
              `This is a CREATE test. You MUST generate at least 2 TYPE/SELECT/LOOKUP steps.`,
              `Use the Project Metadata section below to discover which fields exist on the form.`,
              `Common create-form fields: Name, Description, Type/Category, Status, SKU, Currency.`,
              `DO NOT generate only NAVIGATE + CLICK + ASSERT — that WILL FAIL validation.`,
            ].join('\n')
            return ''
          })(),
          fieldManifest ? `## Entity Field Manifest (ONLY use these fields)\n${fieldManifest}` : '',
          ragContext ? `## Project Metadata\n${ragContext}` : '',
          '## Output Format',
          'Return ONLY a valid JSON array of step objects. No markdown, no explanations.',
          '[',
          '  { "id": "1", "action": "NAVIGATE", "value": "/path/to/page" },',
          '  { "id": "2", "action": "TYPE", "target": "Field Label", "value": "realistic value", "locator_type": "label" },',
          '  { "id": "3", "action": "CLICK", "target": "Exact Button Name from Manifest", "locator_type": "role" },',
          '  { "id": "4", "action": "ASSERT_TEXT", "target": "Expected text on page", "locator_type": "text" }',
          ']',
        ].filter(Boolean).join('\n')

        const userPrompt = [
          'Generate test steps for this test case:',
          `Name: ${tc.name}`,
          `Description: ${tc.description ?? '(no description)'}`,
          `Priority: ${tc.priority ?? 'medium'}`,
          `Expected Outcome: ${tc.expected_result ?? '(no expected outcome)'}`,
          '',
          tcOpType === 'update'
            ? `⚠️ UPDATE CONSTRAINT: This test UPDATES an existing ${entityFilter} record. Navigate to the LIST page, search for an existing record, click it, click Edit, modify the relevant fields, click Save, and assert success. NEVER navigate to /new or /create.`
            : tcOpType === 'create'
              ? `⚠️ CREATE CONSTRAINT: You MUST include at least 2 TYPE/SELECT/LOOKUP steps that fill in form fields.\nDo NOT produce only NAVIGATE+CLICK+ASSERT steps.`
              : '',
          'Return ONLY a valid JSON array of step objects. No markdown, no code fences.',
        ].filter(Boolean).join('\n')

        const rawSteps = await invokeBulkGeneration(systemPrompt, userPrompt)
        steps = Array.isArray(rawSteps) ? rawSteps : []
        log.info({ tcId: tc.id, stepsCount: steps.length }, '[TCG] Direct LLM fallback produced steps')
      }

      // ── Normalize action names before persisting ─────────────────────────────
      // Safety net: convert any surviving FILL_FORM/ENTER/SET → TYPE, etc.
      let normalisedSteps = normaliseSteps(steps)

      // ── Cross-entity CLICK button filter (HARD GUARD) ───────────────────────
      // Strip CLICK steps like "+ New Lead" in an Account test.
      // This is the LAST defence before steps are written to the DB.
      const effectiveEntity = (typeof entityFilter === 'string' && entityFilter.length > 2)
        ? entityFilter
        : (() => {
            const stripped = tc.name
              .replace(/^(create|update|edit|delete|view|add|manage|verify|test|check|search|list|open|close)\s+/i, '')
              .replace(/\b(new|a|an|the|successfully|with|for|and|or|record|records|details|detail|form|page|module|entry|item|valid|invalid|existing|required|optional|active|inactive|duplicate|mandatory|basic|empty|updated|given|correct|incorrect|multiple|successful)\b/gi, '')
              .trim()
            // Case-agnostic extraction for effective entity
            const STOP = new Set(['the','and','for','with','new','all','record','records','form','page'])
            const words = stripped.toLowerCase().split(/\s+/).filter(w => w.length >= 3 && !STOP.has(w))
            const entity = words[0] ?? stripped.split(/\s+/)[0] ?? ''
            return entity.charAt(0).toUpperCase() + entity.slice(1)
          })()

      if (effectiveEntity && effectiveEntity.length > 2) {
        const eLower = effectiveEntity.toLowerCase()
        const beforeLen = normalisedSteps.length
        normalisedSteps = normalisedSteps.filter((s: any) => {
          if (String(s.action ?? '').toUpperCase() !== 'CLICK') return true
          const target = String(s.target ?? '').toLowerCase().trim()
          if (!target) return true
          const match = target.match(/\b(?:new|create|add)\s+([a-z]+(?:\s+[a-z]+)?)\b/)
          if (!match) return true
          const entityWord = match[1].trim()
          if (entityWord.length < 3 || ['the', 'a', 'an', 'new', 'all', 'item', 'record', 'entry'].includes(entityWord)) return true
          if (eLower.includes(entityWord) || entityWord.includes(eLower)) return true
          log.warn(
            { tcId: tc.id, tcName: tc.name, target: s.target, entityWord, effectiveEntity },
            '[TCG] ⚠️ Stripped cross-entity CLICK step — button is for wrong entity',
          )
          return false
        })
        if (normalisedSteps.length < beforeLen) {
          // Renumber remaining steps
          normalisedSteps = normalisedSteps.map((s: any, i: number) => ({ ...s, id: String(i + 1) }))
          log.info(
            { tcId: tc.id, removed: beforeLen - normalisedSteps.length },
            '[TCG] Cross-entity CLICK steps stripped before DB persist',
          )
        }
      }

      // ── Button name auto-correction (CENTRALIZED) ─────────────────────────
      // Uses the centralized autoCorrectButtonNames() which independently loads
      // the manifest and deterministically replaces LLM-invented button names.
      if (effectiveEntity && effectiveEntity.length > 2) {
        await autoCorrectButtonNames(normalisedSteps as Array<Record<string, any>>, projectId, effectiveEntity)
      }

      const cleanSteps = sanitizeTestCaseSteps(normalisedSteps, tc.name)

      await prisma.test_cases.update({
        where: { id: tc.id },
        data:  { steps: cleanSteps as any, status: 'draft' },
      })

      generated++
      log.info({ tcId: tc.id, stepsCount: cleanSteps.length }, '[TCG] Steps generated for test case')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn({ err, tcId: tc.id, tcName: tc.name }, '[TCG] Failed to generate steps for test case')
      errors.push(`${tc.name}: ${msg}`)
      failed++

      // Still update status to draft so it appears in the Tests tab even without steps
      await prisma.test_cases.update({
        where: { id: tc.id },
        data:  { status: 'draft' },
      }).catch(() => {/* ignore */})
    }
  }

  log.info({ projectId, generated, failed }, '[TCG] generateStepsForTestCases complete')
  return { generated, failed, errors }
}


// ── Salesforce managed package object detection ──────────────────────────────
function isManagedPackageObject(apiName: string): boolean {
  const KNOWN_MANAGED_PREFIXES = [
    'sflma', 'sfcma', 'channel_orders', 'channel orders',
    'npe', 'npsp', 'hed', 'fsc', 'vlocity', 'omnistudio',
    'copado', 'sf_com', 'b2bcommerce', 'commerceextension',
    'sfdc_checkout', 'ccrz', 'sfbase', 'finserv', 'sfcloud',
    'dspdf', 'kpiapp', 'docgen',
  ]
  const lower = apiName.toLowerCase().replace(/\s+/g, '_')
  for (const prefix of KNOWN_MANAGED_PREFIXES) {
    const normalizedPrefix = prefix.replace(/\s+/g, '_')
    if (lower.startsWith(normalizedPrefix + '__') || lower.startsWith(normalizedPrefix + '_')) {
      return true
    }
  }
  const parts = apiName.split('__')
  if (parts.length >= 3) return true
  if (apiName.endsWith('__hd')) return true
  if (apiName.endsWith('__e')) return true
  if (apiName.endsWith('__mdt')) return true
  return false
}

// ── Salesforce system/setup object detection ─────────────────────────────────
function isSystemObject(apiName: string): boolean {
  const SYSTEM_OBJECTS = new Set([
    'User', 'Profile', 'UserRole', 'PermissionSet', 'PermissionSetAssignment',
    'PermissionSetGroup', 'LoginHistory', 'AuthSession', 'SessionPermSetActivation',
    'TwoFactorInfo', 'VerificationHistory',
    'Organization', 'BusinessHours', 'FiscalYearSettings', 'Holiday',
    'ApexClass', 'ApexTrigger', 'ApexComponent', 'ApexPage',
    'CustomPermission', 'ConnectedApplication', 'InstalledMobileApp',
    'NamedCredential', 'ExternalDataSource',
    'ContentDocument', 'ContentVersion', 'ContentDocumentLink',
    'ContentWorkspace', 'ContentFolder', 'Attachment', 'Document',
    'ObjectPermissions', 'FieldPermissions', 'SetupAuditTrail',
    'LoginGeo', 'EventLogFile',
    'EntityDefinition', 'FieldDefinition', 'RecordType', 'BusinessProcess',
    'ListView', 'Layout',
    'EmailTemplate', 'EmailMessage', 'EmailServicesAddress', 'OrgWideEmailAddress',
    'FlowDefinition', 'FlowInterview', 'ProcessDefinition',
    'Group', 'GroupMember', 'QueueSobject',
    'PlatformEventChannel', 'PlatformEventChannelMember',
    'AsyncApexJob', 'CronTrigger', 'CronJobDetail',
    'BrandTemplate', 'Folder', 'Scontrol',
    'StaticResource', 'WebLink',
    'DuplicateRule', 'DuplicateRecordSet', 'DuplicateRecordItem',
    'FeedItem', 'FeedComment', 'CollaborationGroup', 'CollaborationGroupMember',
    'TopicAssignment', 'Topic', 'ChatterActivity', 'ChatterMessage',
    'Report', 'Dashboard', 'DashboardComponent',
    'Idea', 'IdeaComment', 'Vote', 'UserPreference',
    'RecordAction', 'RecordActionHistory',
    'ActionLinkGroupTemplate', 'ActionLinkTemplate',
    'AppMenuItem', 'AppDefinition',
  ])
  if (SYSTEM_OBJECTS.has(apiName)) return true
  if (/bypass/i.test(apiName.toLowerCase())) return true
  return false
}

// ── Derive module list directly from project metadata (no LLM) ──────────────
/**
 * Reads the project's ACTUAL metadata from the database and derives a list of
 * test modules deterministically — NO LLM involved.
 *
 * **Category-aware**: Detects the project's integration category first.
 *   - web_app projects: Only use crawled pages, URL-based domain models, web_test_data
 *   - salesforce projects: Only use SF objects/fields, non-URL domain models
 *
 * Returns an array of module name strings derived ONLY from this project's data.
 */
export async function generateModulesForProject(projectId: string): Promise<string[]> {
  try {
    const modules = new Set<string>()

    // ── Detect project category to gate which sources are relevant ──
    // 1. Try project_integrations first (most specific)
    const integration = await prisma.project_integrations.findFirst({
      where: { project_id: projectId },
      select: { category: true },
    })
    // 2. Fallback to projects.category if no integration row exists
    let rawCategory = integration?.category
    if (!rawCategory) {
      const project = await prisma.projects.findUnique({
        where: { id: projectId },
        select: { category: true },
      })
      rawCategory = project?.category
    }
    const category = (rawCategory ?? 'webapp').toLowerCase()
    const isSalesforce = category === 'salesforce'
    // Treat web_app, webapp, or ANY unrecognised category as a web app
    // (safe default — prevents SF objects from leaking into non-SF projects)
    const isWebApp = !isSalesforce

    log.info({ projectId, category, isWebApp, isSalesforce }, '[TCG] generateModulesForProject — detected project category')

    // Segments to skip when extracting modules from URL paths
    const SKIP_AUTH_SEGMENTS = /^(login|logout|signin|signout|signup|register|auth|callback|favicon|api|static|assets|_next|oauth|sso|\.well-known)/i
    const SKIP_NOISE_SEGMENTS = /^(new|edit|create|delete|update|view|detail|details|list|index|home|page|tab|tabs|profile|account|session|sessions|token|tokens|undefined|null|#|[0-9a-f]{8,})$/i
    const SKIP_CONTAINER_SEGMENTS = /^(admin|manage|settings|dashboard|panel|v[0-9]+|module|modules|system|app|main)$/i

    // ── Source priority for web_app projects: ───────────────────────────────────
    //   1st  web_test_data  — explicitly synced module definitions (AUTHORITATIVE)
    //                         When present, these override all URL-scraped sources.
    //                         Reason: the crawler may hit the wrong URL, a CRM demo,
    //                         or a login wall and never see the real application.
    //   2nd  webapp_crawl   — fallback when web_test_data is empty
    //
    // ── Source priority for salesforce projects: ─────────────────────────────────
    //   1st  SF objects / fields (Sources 2 & 3)
    //   2nd  domain_models (non-URL entity names only)

    // ── Source A (HIGHEST PRIORITY, web_app only): web_test_data ─────────────────
    // Check this FIRST. If the project has explicitly-synced module entries, use
    // them exclusively and skip all URL-scraping sources entirely.
    //
    // CRITICAL: Only surface entities that have a create_button_name — i.e.
    // the crawler found an actual form/button to create records for this entity.
    // Entities with NO create button are read-only views (e.g. an "Agents" list
    // page where agents are provisioned externally) and MUST NOT be listed as
    // "Management" modules that imply Create/Edit/Delete test cases.
    let webTestDataUsed = false
    if (!isSalesforce) {
      const webTestData = await prisma.$queryRaw<Array<{
        entity_name:        string
        create_button_name: string | null
        open_button_name:   string | null
      }>>`
        SELECT entity_name,
               COALESCE(create_button_name, '') as create_button_name,
               COALESCE(open_button_name,   '') as open_button_name
        FROM   web_test_data
        WHERE  project_id = ${projectId}::uuid
        ORDER  BY entity_name
      `

      if (webTestData.length > 0) {
        webTestDataUsed = true
        log.info({ projectId, count: webTestData.length }, '[TCG] web_test_data entries found — checking create_button_name for each')

        for (const wtd of webTestData) {
          const raw = (wtd.entity_name ?? '').trim()
          if (!raw || raw.length < 2) continue

          // Check whether this entity has a known create path.
          // create_button_name is set by the Tier-2 UI scraper when it finds
          // a "New", "Add", "Create" button on the entity's list page.
          // open_button_name is the button that opens a modal form (e.g. "Add Role").
          const hasCreateButton = !!(wtd.create_button_name?.trim() || wtd.open_button_name?.trim())

          // Strip trailing "Management" to avoid double-suffix
          const stripped = raw.replace(/\s+management$/i, '').trim()
          const name = stripped
            .replace(/[_-]/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase())
            .replace(/\s+/g, ' ')
            .trim()
          if (name.length < 2) continue

          if (hasCreateButton) {
            // Full CRUD module — can test Create, Edit, Delete
            modules.add(`${name} Management`)
            log.info({ name, create: wtd.create_button_name, open: wtd.open_button_name }, '[TCG] Added CRUD module from web_test_data')
          } else {
            // Read-only entity — the list page exists but there is no create/add
            // button, meaning the app does NOT support creating these records via UI.
            // Expose it only as a read/list module so the LLM generates VIEW tests,
            // NOT Create/Edit/Delete tests.
            modules.add(`${name} List`)
            log.info({ name }, '[TCG] Added LIST-ONLY module (no create button found) from web_test_data')
          }
        }
      }
    }

    // ── Source B (FALLBACK, web_app only): webapp_crawl pages ────────────────────
    // Only used when web_test_data has zero entries for this project.
    if (!isSalesforce && !webTestDataUsed) {
      const webRows = await prisma.metadata_normalized.findMany({
        where: { project_id: projectId, entity_type: 'webapp_crawl' },
        select: { structured_json: true, label: true },
      })

      for (const row of webRows) {
        const data = (row.structured_json ?? {}) as {
          pages?: Array<{
            path?: string
            title?: string
            nav_items?: string[]
          }>
        }
        const pages = data.pages ?? []

        for (const page of pages) {
          const path = page.path ?? ''
          if (!path || path === '/') continue

          const segments = path.split('/').filter(Boolean)
          if (segments.length === 0) continue
          if (SKIP_AUTH_SEGMENTS.test(segments[0])) continue

          let entitySegment: string | null = null
          for (const seg of segments) {
            if (SKIP_CONTAINER_SEGMENTS.test(seg)) continue
            if (SKIP_NOISE_SEGMENTS.test(seg)) continue
            if (/^[:\[{]/.test(seg)) continue
            if (/^\d+$/.test(seg)) continue
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg)) continue
            entitySegment = seg
            break
          }

          if (!entitySegment || entitySegment.length < 2) continue

          const entityName = entitySegment
            .replace(/[_-]/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase())
            .replace(/\s+/g, ' ')
            .trim()

          if (!entityName || entityName.length < 2) continue
          modules.add(`${entityName} Management`)

          // Also check nav_items if the crawler captured sidebar links
          if (Array.isArray(page.nav_items)) {
            for (const navItem of page.nav_items) {
              const clean = String(navItem ?? '').trim()
              if (clean.length >= 2 && !SKIP_AUTH_SEGMENTS.test(clean) && !SKIP_NOISE_SEGMENTS.test(clean)) {
                modules.add(`${clean.replace(/\b\w/g, c => c.toUpperCase())} Management`)
              }
            }
          }
        }
      }
    }

    // ── Sources 2 & 3: Salesforce objects/fields — ONLY for salesforce projects ──
    if (isSalesforce) {
      const sfObjects = await prisma.metadata_normalized.findMany({
        where: { project_id: projectId, entity_type: 'object' },
        select: { object_name: true, label: true },
      })

      for (const obj of sfObjects) {
        const apiName = (obj.object_name ?? '').trim()
        const label   = (obj.label ?? apiName).trim()
        if (!apiName) continue
        if (isManagedPackageObject(apiName)) continue
        if (isSystemObject(apiName)) continue
        if (/bypass/i.test(label)) continue

        const displayName = (label && label.length >= 2 && !/bypass/i.test(label)) ? label : apiName
        const cleanName = displayName
          .replace(/__c$/i, '')
          .replace(/__hd$/i, '')
          .replace(/[_-]/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase())
          .replace(/\s+/g, ' ')
          .trim()

        if (cleanName.length >= 2) {
          modules.add(`${cleanName} Management`)
        }
      }

      // Source 3: SF fields fallback when no objects found
      const sfObjectCount = await prisma.metadata_normalized.count({
        where: { project_id: projectId, entity_type: 'object' },
      })
      if (sfObjectCount === 0) {
        const fieldObjectNames = await prisma.metadata_normalized.findMany({
          where: { project_id: projectId, entity_type: 'field' },
          select: { object_name: true },
          distinct: ['object_name'],
        })
        for (const row of fieldObjectNames) {
          const name = (row.object_name ?? '').trim()
          if (!name || name.length < 2) continue
          if (isManagedPackageObject(name)) continue
          if (isSystemObject(name)) continue
          const cleanName = name
            .replace(/__c$/i, '')
            .replace(/[_-]/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase())
            .replace(/\s+/g, ' ')
            .trim()
          if (cleanName.length >= 2) modules.add(`${cleanName} Management`)
        }
      }

      // Source 4: domain_models — SF non-URL entity names only
      const domainModels = await prisma.domain_models.findMany({
        where: { project_id: projectId },
        select: { entity_name: true },
      })
      for (const dm of domainModels) {
        const entityName = (dm.entity_name ?? '').trim()
        if (!entityName) continue
        try { new URL(entityName); continue } catch { /* not a URL — use it */ }
        if (isManagedPackageObject(entityName)) continue
        if (isSystemObject(entityName)) continue
        const name = entityName
          .replace(/__c$/i, '')
          .replace(/[_-]/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase())
          .replace(/\s+/g, ' ')
          .trim()
        if (name.length >= 2) modules.add(`${name} Management`)
      }
    }

    const dedupedModules = deduplicateModules([...modules])

    log.info({ projectId, category, count: dedupedModules.length, modules: dedupedModules }, '[TCG] Modules derived from project metadata')
    return dedupedModules.sort()
  } catch (err) {
    log.warn({ err, projectId }, '[TCG] generateModulesForProject failed — returning empty array')
    return []
  }
}

/**
 * De-duplicates modules that differ only by pluralization, camelCase vs spaces,
 * or trivial suffixes like "Custom".
 */
function deduplicateModules(modules: string[]): string[] {
  const seen = new Map<string, string>()
  for (const mod of modules) {
    const key = mod
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/\s*\(.*?\)\s*/g, ' ')
      .replace(/\s+custom\s+/gi, ' ')
      .replace(/s\s+management$/i, ' management')
      .replace(/\s+/g, ' ')
      .trim()
    if (!seen.has(key)) {
      seen.set(key, mod)
    } else {
      const existing = seen.get(key)!
      if (mod.includes(' ') && !existing.includes(' ')) {
        seen.set(key, mod)
      }
      if (existing.includes('Custom') && !mod.includes('Custom')) {
        seen.set(key, mod)
      }
    }
  }
  return [...seen.values()]
}

