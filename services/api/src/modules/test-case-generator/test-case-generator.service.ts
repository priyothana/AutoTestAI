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

const log = createModuleLogger('test-case-generator')

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

    if (rows.length === 0) {
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
      lines.push('')
      lines.push('⚡ = Lookup field: use LOOKUP action, not TYPE. Value must be a real record name from REAL ENTITY RECORDS.')
      return lines.length > 5 ? lines.join('\n') : ''
    }

    // Group by object
    const byObject = new Map<string, Array<{ label: string; type: string; required: boolean }>>()
    for (const row of rows) {
      const obj  = row.object_name ?? 'Unknown'
      const json = (row.structured_json ?? {}) as Record<string, any>
      const type = String(json.type ?? json.soap_type ?? 'text').toLowerCase()
      const required = Boolean(json.required ?? json.nillable === false)
      const label = (row.label ?? '').trim()
      if (!label) continue
      if (!byObject.has(obj)) byObject.set(obj, [])
      byObject.get(obj)!.push({ label, type, required })
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
        lines.push(`  • "${f.label}" (${f.type}${req}${lookupHint})`)
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

export async function buildGenerationContext(params: {
  projectId: string
  brdContent?: string
  existingTestsContent?: string
  jiraStories?: Array<{ key: string; summary: string; description: string }>
  count: number
  focusAreas: string[]
}): Promise<{ systemPrompt: string; userPrompt: string; metadataContext: string }> {

  const { projectId, brdContent, existingTestsContent, jiraStories, count, focusAreas } = params

  const isCrud        = focusAreas.includes('CRUD')
  const isRealCases   = focusAreas.includes('Real Use Cases')
  const isNegative    = focusAreas.includes('Negative Testing')
  const isEdge        = focusAreas.includes('Edge Cases')

  // ── Source 4: Project metadata via RAG (CRUD-targeted queries) ───────────────
  // Use multiple targeted queries when CRUD/Real Use Cases selected so we get
  // create-form and edit-page metadata instead of nav/sidebar metadata.
  const ragQueryStrategies: string[] = []

  if (isCrud || isRealCases) {
    ragQueryStrategies.push(
      'create new record form fields buttons validation',
      'edit update record form fields save button',
      'delete remove record confirmation',
      'form submission required fields error validation'
    )
  }
  if (isNegative || isEdge) {
    ragQueryStrategies.push(
      'required field validation error message empty null',
      'boundary limit maximum minimum value error',
      'duplicate record error unique constraint'
    )
  }
  if (ragQueryStrategies.length === 0) {
    ragQueryStrategies.push(
      `test cases for ${focusAreas.join(' ') || 'all functional areas'} of this project`
    )
  }

  let allChunks: string[] = []
  for (const q of ragQueryStrategies.slice(0, 3)) {
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
  }).slice(0, 25)

  if (allChunks.length === 0) {
    // Fallback: generic query
    try { allChunks = await retrieveRagChunks(projectId, 'application pages forms fields', 15) } catch { /* */ }
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
- **CREATE**: Navigate to the create/new form → fill required fields with realistic data → click Save/Submit → assert success (URL change OR success toast)
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
- "Create a Contact named 'Sam Wilson' with email left EMPTY → click Save → verify required field error 'Email is required' appears"
- "Create an Account with duplicate name 'Acme Corp' → verify duplicate error message"
- "Update an Opportunity amount from 5000 to 10000 → verify the new amount shows in the record detail"
- "Search for a Contact by phone number → verify the correct contact appears in results"
- "Assign a Lead to a User who does not exist → verify the lookup shows no results"
- "Create an Invoice with negative amount → verify validation error"

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
  const systemPrompt = buildSystemPrompt(count, focusAreas)

  // ── Build entity field manifest (DB-sourced real field labels) ───────────────
  const fieldManifest = await buildEntityFieldManifest(projectId)
  log.info({ projectId, hasManifest: fieldManifest.length > 0 }, '[TCG] Field manifest built')

  const userPromptParts: string[] = []

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

  userPromptParts.push(
    `## Generation Request\n\nGenerate exactly **${count} test cases** for this project.\n` +
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
      { "id": "1", "action": "NAVIGATE", "value": "/contacts/new" },
      { "id": "2", "action": "TYPE", "target": "First Name", "value": "Sam", "locator_type": "label" },
      { "id": "3", "action": "TYPE", "target": "Email", "value": "", "locator_type": "label" },
      { "id": "4", "action": "CLICK", "target": "Save", "locator_type": "role" },
      { "id": "5", "action": "ASSERT_TEXT", "target": "Email is required", "locator_type": "text" }
    ],
    "expected_outcome": "Specific, measurable outcome with exact text/URL",
    "tags": ["CRUD", "Create", "Negative"]
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
5. Use realistic data: real names, valid emails, plausible amounts, actual dates
6. Navigation-only tests (only NAVIGATE steps, no TYPE/CLICK/ASSERT) are REJECTED
7. ⛔ ASSERT_TEXT / ASSERT_TOAST / ASSERT_URL steps MUST NEVER have an empty target or value.
   For list-display READ tests: ASSERT_TEXT with target = the entity page heading (e.g. "Opportunities"), NOT an empty string.
   Example READ assertion: { "action": "ASSERT_TEXT", "target": "Opportunities", "locator_type": "text" }
   Example CRUD assertion: { "action": "ASSERT_TEXT", "target": "Account created successfully", "locator_type": "text" }
   A blank target ("") is INVALID and will be stripped — always use a real, non-empty text value.`)

  const userPrompt = userPromptParts.join('\n')

  return { systemPrompt, userPrompt, metadataContext }
}

// ── System prompt for multi-source generation ─────────────────────────────────

function buildSystemPrompt(count: number, focusAreas: string[] = []): string {
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
  1. Navigate to the create/new form URL (e.g. /opportunities/new, /accounts/new)
  2. Fill in ALL required fields with realistic data values — including required LOOKUP fields
     ⚠ LOOKUP fields (Account, Contact, Owner, Parent, etc.) MUST use LOOKUP action, not TYPE.
     ⚠ NEVER skip a required lookup field — the form will NOT save without it.
  3. Click the EXACT submit button name from the metadata (e.g. "Create Opportunity", NOT generic "Save")
     ⚠ Button name is always "Create [EntityName]" or "Save [EntityName]" — NEVER "Create [RecordName]"
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

  return `
You are a senior QA Automation Engineer specializing in end-to-end Playwright automation and risk-based test design.

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
${crudEnforcement}${negativeEnforcement}
## Locator Priority (use in this order)
1. label  — getByLabel('Account Name') — for form inputs
2. role   — getByRole('button', { name: 'Save' }) — for buttons/links
3. text   — getByText('Error: Email required') — for assertions
4. css    — LAST RESORT only

## Step Count Rule
- Minimum 4 steps per test case
- Maximum 15 steps per test case
- Rich workflow tests (8-12 steps) are preferred over thin UI checks (2-3 steps)
`.trim()
}

// ── LLM factory (reuses same pattern as generation.service.ts) ────────────────

function buildLlm(): BaseChatModel {
  const model = process.env.LLM_MODEL ?? 'claude-sonnet-4-20250514'
  return new ChatAnthropic({
    apiKey:      process.env.ANTHROPIC_API_KEY,
    model,
    maxTokens:   8192,
    temperature: 0.7,
  })
}

function buildFallbackLlm(): BaseChatModel {
  return new ChatOpenAI({
    apiKey:      process.env.OPENAI_API_KEY,
    model:       'gpt-4o-mini',
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
  projectId: string
  suiteName: string
  testCases: Array<Record<string, unknown>>
}): Promise<{ suiteId: string; testCaseIds: string[] }> {
  const { projectId, suiteName, testCases } = params

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
      const rawSteps   = Array.isArray(tc['steps']) ? tc['steps'] : []
      const tcName     = String(tc['name'] ?? 'Generated Test Case')
      // ── Sanitize: drop / fix degenerate assert steps before storing ──
      const cleanSteps = sanitizeTestCaseSteps(rawSteps, tcName)

      const created = await prisma.test_cases.create({
        data: {
          name:            tcName.slice(0, 255),
          description:     String(tc['description'] ?? '').slice(0, 2000),
          steps:           cleanSteps as any,
          priority:        (['low', 'medium', 'high'].includes(String(tc['priority'])) ? String(tc['priority']) : 'medium'),
          status:          'draft',
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


// ── BullMQ Worker (started inline — single-process architecture like other workers) ──

let _workerStarted = false

export function startTestCaseGenerationWorker() {
  if (_workerStarted) return
  _workerStarted = true

  const worker = new Worker<TestCaseGenerationJob>(
    QUEUES.TEST_CASE_GENERATION,
    async (job) => {
      const { projectId, suiteName, count, focusAreas, brdContent, existingTestsContent, useJira } = job.data
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
        })

        updateStatus('running', 55, 'Calling AI to generate test cases…')
        const rawTestCases = await invokeBulkGeneration(systemPrompt, userPrompt)
        log.info({ projectId, rawCount: rawTestCases.length }, '[TCG] AI returned test cases')

        updateStatus('running', 80, `Saving ${rawTestCases.length} test cases to database…`)
        const { suiteId, testCaseIds } = await persistGeneratedTestCases({
          projectId,
          suiteName: suiteName ?? `Generated Suite – ${new Date().toISOString()}`,
          testCases: rawTestCases,
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
