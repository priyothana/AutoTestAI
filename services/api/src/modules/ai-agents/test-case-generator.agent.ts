/**
 * Test Case Generator Agent — Phase 1, Agent 2
 *
 * Creates high-level test cases (name + description + priority) grounded in:
 *   - Project RAG metadata (primary source of truth)
 *   - BRD / functional specification documents
 *   - Jira story acceptance criteria
 *   - Existing test cases (for de-duplication)
 *
 * LLM: OpenAI gpt-4o
 * HITL: Triggered if no metadata found or focus areas are ambiguous
 */
import { ChatOpenAI }                from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { StringOutputParser }         from '@langchain/core/output_parsers'

import { createModuleLogger }    from '../../shared/logger/index.js'
import { ragSearchTool }         from './tools/rag-search.tool.js'
import { getTestCasesByProject, logAgentExecution } from './tools/db-query.tool.js'
import { hitlTool }              from './tools/hitl.tool.js'
import type { HITLInput }        from './agent.types.js'

// Re-use the project-agnostic BRD helpers from the workflow service.
// We duplicate only the minimum needed here to avoid a circular import.
// (Full implementations live in workflow-chat.service.ts)

/** Extracts word-level entity tokens from BRD text for RAG query enrichment. */
function extractBrdQueryTerms(brdText: string, maxTerms = 15): string {
  if (!brdText || brdText.trim().length < 50) return ''

  const termFreq = new Map<string, number>()
  // Match Title-Case words (potential entity names) in the BRD
  const titleCaseRe = /\b([A-Z][a-z]{2,20}(?:\s+[A-Z][a-z]{2,20})?)\b/g
  const genericStop = new Set([
    'The', 'This', 'That', 'With', 'From', 'Into', 'When', 'Then',
    'Also', 'Each', 'Some', 'Only', 'Once', 'Both', 'Such', 'Note',
    'Here', 'User', 'Test', 'Case', 'Step', 'Page', 'Form', 'Data',
    'List', 'View', 'Edit', 'Show', 'Type', 'Name', 'Date', 'Time',
    'Required', 'Optional', 'System', 'Project', 'Business', 'Process',
  ])

  for (const m of brdText.matchAll(titleCaseRe)) {
    const term = m[1].trim()
    if (term.length < 3 || genericStop.has(term)) continue
    termFreq.set(term, (termFreq.get(term) ?? 0) + 1)
  }

  // Sort by frequency, return top N as a space-separated string for RAG query
  return [...termFreq.entries()]
    .filter(([, freq]) => freq >= 2)
    .sort(([, a], [, b]) => b - a)
    .slice(0, maxTerms)
    .map(([term]) => term)
    .join(' ')
}

/** Returns entities from BRD that have no matching crawled page path. */
function findOrphanedEntitiesForPrompt(
  brdText:     string,
  ragChunks:   string[],
): string[] {
  if (!brdText || brdText.trim().length < 50) return []

  // Collect entity candidates from BRD headings and ALL-CAPS labels
  const candidates = new Set<string>()
  const headingRe = /^#+\s+(?:\d+\.?\s+)?([A-Z][A-Za-z\s&/\-]{2,40})$/gm
  for (const m of brdText.matchAll(headingRe)) {
    const raw = m[1].trim().replace(/\s+/g, ' ')
    if (raw.length >= 3 && raw.length <= 50) candidates.add(raw)
  }
  const allCapsRe = /\b([A-Z]{2,30})\b/g
  for (const m of brdText.matchAll(allCapsRe)) {
    const raw = m[1].trim()
    const skipWords = new Set(['THE', 'AND', 'FOR', 'FROM', 'WITH', 'MUST', 'NOT', 'ALL',
      'ARE', 'HAS', 'CAN', 'WILL', 'WHEN', 'THEN', 'API', 'URL', 'BRD', 'LLM', 'ID',
      'PDF', 'CSV', 'SQL', 'NEW', 'OLD', 'KEY', 'END', 'UI', 'UX'])
    if (!skipWords.has(raw) && raw.length >= 3 && raw.length <= 25) {
      const titled = raw[0] + raw.slice(1).toLowerCase()
      candidates.add(titled)
    }
  }

  // Check which candidates appear in RAG chunks (meaning crawler reached those pages)
  const ragText = ragChunks.join(' ').toLowerCase()
  const orphaned: string[] = []
  for (const entity of candidates) {
    const slug = entity.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20)
    if (slug.length < 3) continue
    // Also check plural/stem variants
    const inRag = ragText.includes(slug) ||
                  ragText.includes(slug + 's') ||
                  (slug.endsWith('y') && ragText.includes(slug.slice(0, -1) + 'ies'))
    if (!inRag) orphaned.push(entity)
  }

  return orphaned.slice(0, 20) // cap to avoid prompt bloat
}

const log = createModuleLogger('tc-generator-agent')

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GeneratedTestCase {
  name:        string
  description: string
  priority:    'low' | 'medium' | 'high'
  tags:        string[]
  confidence:  number
}

export interface TestCaseGenInput {
  projectId:           string
  count:               number
  focusAreas?:         string[]
  selectedModule?:     string
  brdContent?:         string
  executionId?:        string  // for HITL
  excludeDuplicates?:  boolean // default true
}

export interface TestCaseGenOutput {
  cases:       GeneratedTestCase[]
  thoughts:    string[]
  confidence:  number
  hitlInvoked: boolean
}

// ── LLM ────────────────────────────────────────────────────────────────────────

function buildLlm() {
  return new ChatOpenAI({
    apiKey:      process.env.OPENAI_API_KEY,
    model:       process.env.TC_GEN_MODEL ?? 'gpt-4o',
    temperature: 0.3,
    maxTokens:   3000,
  })
}

// ── System prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Test Case Generator Agent for AutoTestAI.

Your job: Generate high-level test cases (NOT step-by-step — just name, description, priority).

Sources (use ALL provided):
1. PROJECT METADATA (via RAG) — primary source of truth
2. BRD / Functional Specification — business rules
3. Existing Test Cases — avoid duplication
4. Focus Areas — constrain generation scope

Rules:
- NEVER invent entities or pages not in the metadata
- Each test case must describe a REAL business workflow
- Use action-oriented names: "Create Invoice With Required Fields and Verify Success"
- Tags: CRUD | Negative | EdgeCase | Workflow | ReadOnly | Integration
- Do NOT generate smoke tests or UI-only tests without business value
- If metadata is empty, set confidence < 0.5 for all generated cases

Output ONLY valid JSON array (no markdown):
[{ 
  "name": string, 
  "description": string, 
  "priority": "low|medium|high", 
  "tags": string[], 
  "confidence": 0.0-1.0 
}]`

// ── De-duplication ─────────────────────────────────────────────────────────────

function isDuplicate(
  candidate: string,
  existingNames: string[],
  threshold = 0.7,
): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim()
  const a = normalize(candidate)
  for (const ex of existingNames) {
    const b = normalize(ex)
    // Simple word-overlap similarity
    const aWords = new Set(a.split(/\s+/))
    const bWords = new Set(b.split(/\s+/))
    const intersection = [...aWords].filter(w => bWords.has(w)).length
    const union = new Set([...aWords, ...bWords]).size
    if (union > 0 && intersection / union >= threshold) return true
  }
  return false
}

// ── Main function ─────────────────────────────────────────────────────────────

export async function runTestCaseGeneratorAgent(
  input: TestCaseGenInput,
): Promise<TestCaseGenOutput> {
  const startMs   = Date.now()
  const thoughts: string[] = []
  let hitlInvoked = false

  log.info(
    { projectId: input.projectId, count: input.count, focusAreas: input.focusAreas },
    '[TC-GEN] Starting',
  )

  // ── OBSERVE ───────────────────────────────────────────────────────────────

  thoughts.push('OBSERVE: loading metadata, BRD context, existing test cases, and project artifacts')

  // Step 1: Load BRD FIRST so we can build an enriched RAG query from BRD entity terms.
  // This is the key fix for projects where crawlers can't reach dependency-blocked pages:
  // BRD terms (Invoice, Opportunity Products, etc.) are injected into the RAG query so
  // their embeddings are retrieved even if the crawler never visited those pages.
  const projectArtifacts = await (async () => {
    const { default: p } = await import('../../shared/db/prisma.js')
    const row = await p.projects.findUnique({
      where:  { id: input.projectId },
      select: { brd_content: true, existing_tests_content: true },
    })
    return row ?? {}
  })()

  // Decode artifact helper (handles base64-encoded binary uploads)
  function decodeArtifact(raw: string | null | undefined, maxChars = 4000): string {
    if (!raw) return ''
    const isLikelyBase64 = raw.length > 100 && /^[A-Za-z0-9+/=\n\r]+$/.test(raw.trim())
    if (isLikelyBase64) {
      try {
        const decoded = Buffer.from(raw.trim(), 'base64').toString('utf8')
        const printable = decoded.split('').filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127).length
        if (printable / decoded.length > 0.7) return decoded.slice(0, maxChars)
        return '[Binary document — not directly readable. Use filename context.]'
      } catch { return '' }
    }
    return raw.slice(0, maxChars)
  }

  // Resolve BRD content early — caller-provided wins over DB-stored
  const resolvedBrd = decodeArtifact(input.brdContent ?? (projectArtifacts as any).brd_content)
  const resolvedExistingTests = decodeArtifact((projectArtifacts as any).existing_tests_content)

  // Step 2: Build enriched RAG query:
  //   - Module/focus area terms (as before)
  //   - BRD entity terms (NEW: ensures deep/dependency-blocked entities are retrieved)
  // For example, if BRD mentions Invoice, Opportunity Products, Payment:
  //   those terms are injected here so pgvector finds their embeddings even if
  //   the crawler never navigated to those pages.
  const brdQueryTerms = extractBrdQueryTerms(resolvedBrd, 15)
  const enrichedQuery = [
    input.selectedModule ?? '',
    ...(input.focusAreas ?? []),
    'test cases workflows',
    brdQueryTerms,  // ← BRD entity terms added here
  ].filter(Boolean).join(' ').trim()

  thoughts.push(`OBSERVE: enriched RAG query with BRD terms: "${enrichedQuery.slice(0, 80)}…"`)

  const [ragResult, existingCases] = await Promise.all([
    ragSearchTool({
      projectId: input.projectId,
      query:     enrichedQuery,
      topK:      15,  // increased from 12 to capture more coverage
    }),
    input.excludeDuplicates !== false
      ? getTestCasesByProject(input.projectId, 100)
      : Promise.resolve([]),
  ])

  // Apply RAG filter for the agent
  if (input.selectedModule && ragResult.chunks.length > 0) {
    const { getEntityStems } = await import('../test-case-generator/test-case-generator.service.js')
    const entityKeyword = input.selectedModule.replace(/\s+management$/i, '').trim().toLowerCase()
    const stems = getEntityStems(entityKeyword)

    const COMMON_NOISY_ENTITIES = [
      'contract', 'opportunity', 'lead', 'product', 'campaign', 'case', 'order',
      'quote', 'price book', 'pricebook', 'account', 'contact', 'event', 'task',
    ].filter(e => !stems.some(stem => e === stem || e.startsWith(stem) || stem.startsWith(e)))

    const entityPattern = new RegExp(
      `\\b(${COMMON_NOISY_ENTITIES.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
      'i'
    )

    const filteredChunks = ragResult.chunks.filter(chunk => {
      const chunkLower = chunk.toLowerCase()
      const mentionsOurEntity = stems.some(stem => chunkLower.includes(stem))
      const mentionsNoisyEntity = entityPattern.test(chunk)
      return mentionsOurEntity || !mentionsNoisyEntity
    })

    thoughts.push(`OBSERVE: filtered RAG chunks from ${ragResult.chunks.length} to ${filteredChunks.length}`)
    ragResult.chunks = filteredChunks
    ragResult.count = filteredChunks.length
  }

  thoughts.push(`OBSERVE: ${ragResult.count} RAG chunks, ${existingCases.length} existing test cases`)

  // ── Decode artifact helper (handles base64-encoded binary uploads) ────────
  // (already defined above, before enriched RAG query construction)

  // ── HITL if no metadata ────────────────────────────────────────────────────

  if (ragResult.count === 0 && input.executionId) {
    thoughts.push('THINK: no metadata — calling hitlTool')
    const hitlInput: HITLInput = {
      agentName:   'test-case-generator',
      executionId: input.executionId,
      reason:      'No project metadata found — cannot generate grounded test cases',
      suggestions: [
        'Sync project metadata first (Settings → Metadata Sync)',
        'Crawl the application URLs before generating',
        'Provide a BRD document to generate from specification only',
      ],
    }
    await hitlTool(hitlInput)
    hitlInvoked = true
  }

  // ── THINK: build prompt ───────────────────────────────────────────────────

  // Detect BRD entities that are NOT present in RAG chunks (orphaned = crawler-unreachable).
  // For any project with dependency-blocked pages, these are entities the LLM must be
  // explicitly reminded to cover (e.g., Invoice, Opportunity Products, Delivery Note).
  const orphanedEntities = findOrphanedEntitiesForPrompt(resolvedBrd, ragResult.chunks)
  thoughts.push(
    orphanedEntities.length > 0
      ? `THINK: ${orphanedEntities.length} BRD entities not in RAG (orphaned/dependency-blocked): ${orphanedEntities.slice(0, 5).join(', ')}`
      : 'THINK: all BRD entities appear in RAG chunks — no orphan injection needed',
  )

  // Build the coverage gap supplement — injected only when orphaned entities are found.
  // This is domain-neutral: it works for CRM (Invoice), Logistics (Delivery Note),
  // Healthcare (Prescription), ERP (Goods Receipt), etc.
  const coverageGapSupplement = orphanedEntities.length > 0
    ? `
=== COVERAGE GAP — CRAWLER-UNREACHABLE ENTITIES (MANDATORY) ===
The following entities/modules are documented in the BRD but were NOT
found in the project metadata (crawled pages). This happens because
these pages require existing prerequisite records to be navigable
(e.g., an Invoice page requires an existing Order; a Delivery Note
requires a Shipment). The Playwright crawler cannot create those
records, so those pages were never crawled.

YOU MUST include test cases for EACH of the following entities:
${orphanedEntities.map(e => `  - ${e}`).join('\n')}

For each orphaned entity above, generate at minimum:
  1. A CREATE test case — fill required fields (derive from BRD), submit, verify creation
  2. A STATUS TRANSITION test case — ONLY if the BRD explicitly lists status values
     for this entity. Do NOT invent statuses from general industry knowledge.
  3. A CROSS-MODULE test case — ONLY if the BRD explicitly describes a relationship
     between this entity and another entity. Do NOT invent cross-module actions.

ANTI-HALLUCINATION: Do NOT generate test cases with business processes, statuses, or
actions that are NOT documented in the BRD or metadata. If "fulfillment", "shipping",
"delivery", "receipt" etc. are not mentioned in the BRD, do NOT include them.
If in doubt, generate only CREATE and UPDATE test cases — those are always safe.
=== END COVERAGE GAP ===
`
    : ''

  const existingNames = existingCases.map(c => c.name)
  const focusAreasText = input.focusAreas?.length
    ? `Focus areas: ${input.focusAreas.join(', ')}`
    : 'Focus areas: CRUD, Workflow, Negative'
  const moduleText = input.selectedModule ? `Module/Entity: ${input.selectedModule}` : ''

  const userPromptParts = [
    ragResult.chunks.length > 0
      ? `=== PROJECT METADATA ===\n${ragResult.chunks.join('\n\n---\n')}`
      : '(no metadata — generate from specification only)',
    resolvedBrd ? `\n=== BRD / SPECIFICATION ===\n${resolvedBrd.slice(0, 3000)}` : '',
    coverageGapSupplement,  // ← injected only when orphaned entities detected
    resolvedExistingTests ? `\n=== EXISTING TEST PATTERNS (for naming conventions and coverage reference) ===\n${resolvedExistingTests.slice(0, 2000)}` : '',
    existingNames.length > 0
      ? `\n=== EXISTING TEST CASES (avoid duplicating) ===\n${existingNames.slice(0, 30).join('\n')}`
      : '',
  ]

  if (input.selectedModule) {
    const _isListOnlyUp = /\s+List$/i.test(input.selectedModule)
    const _moduleEntityUp = input.selectedModule.replace(/\s+(Management|List)$/i, '').trim()
    userPromptParts.push(
      `## 🔴🔴🔴 MODULE SCOPE LOCK — NON-NEGOTIABLE 🔴🔴🔴\n` +
      `You MUST generate test cases EXCLUSIVELY for the "${input.selectedModule}" module.\n` +
      `Every single test case in your output MUST be about "${input.selectedModule}" — nothing else.\n\n` +
      (_isListOnlyUp ? `⚠️  "${_moduleEntityUp}" is a READ-ONLY LIST — there is NO create/edit/delete form.\n` +
                       `✅ ONLY generate tests that navigate to the ${_moduleEntityUp} list, verify records, search/filter.\n` +
                       `⛔ DO NOT generate Create, Edit, Delete tests for "${_moduleEntityUp}".\n\n` : '') +
      `⛔ FORBIDDEN — DO NOT generate test cases for ANY entity, page, or workflow that is NOT part of "${input.selectedModule}":\n` +
      `  • Do NOT generate tests for entities other than "${input.selectedModule}" even if the metadata mentions them\n` +
      `  • Only the selected module matters — ignore all other entities visible in navigation or metadata\n\n` +
      `✅ ONLY generate test cases whose name, description, and steps are 100% about "${input.selectedModule}".\n` +
      `✅ Every test case NAME must contain the word "${_moduleEntityUp}" (e.g. "Create ${_moduleEntityUp}", "Delete ${_moduleEntityUp}").\n` +
      `🔴🔴🔴 END MODULE SCOPE LOCK 🔴🔴🔴\n`
    )
  }

  userPromptParts.push(
    `\n=== GENERATION REQUEST ===`,
    focusAreasText,
    moduleText,
    `Count: ${input.count}`,
    `Generate ${input.count} high-quality test cases. Output ONLY JSON array.`
  )

  const userPrompt = userPromptParts.join('\n')

  // ── ACT ───────────────────────────────────────────────────────────────────

  thoughts.push('ACT: generating test cases with LLM')
  let cases: GeneratedTestCase[] = []

  try {
    const isListOnlyModule = input.selectedModule ? /\s+List$/i.test(input.selectedModule) : false
    const moduleDisplayName = input.selectedModule?.replace(/\s*(Management|List|Module|Feature|Settings)$/i, '').trim() ?? ''

    const moduleScopeBlock = input.selectedModule ? `
## 🔴🔴🔴 ENTITY SCOPE LOCK — ABSOLUTE RULE — READ THIS FIRST 🔴🔴🔴
You are generating test cases for ONE SPECIFIC MODULE ONLY: "${input.selectedModule}"
${isListOnlyModule ? `
⚠️  "${moduleDisplayName}" is a READ-ONLY LIST module — it has NO create/edit/delete UI.
✅ Only generate tests that: navigate to the ${moduleDisplayName} list, verify records are shown, search/filter.
⛔ DO NOT generate Create, Edit, Update, or Delete tests for "${moduleDisplayName}".
` : ''}
EVERY test case you generate MUST:
✓ Be named EXACTLY after a workflow in "${input.selectedModule}" — the module name or its root word MUST appear in the test name
✓ Assert outcomes specific to "${input.selectedModule}"

⛔ THE FOLLOWING RULE IS ABSOLUTE — DO NOT generate even ONE test case about ANY entity that is NOT "${input.selectedModule}":
• ANY entity, page, or workflow whose name does NOT match "${input.selectedModule}" is FORBIDDEN
• Even if the metadata mentions other entities — IGNORE them completely
• Only "${input.selectedModule}" tests are allowed — nothing else

⛔ TEST CASE NAMING RULE — MANDATORY:
Every test case name MUST contain the word "${moduleDisplayName}" (or its plural/abbreviation).
BAD:  "Create Agent and Verify Success"        ← REJECTED (wrong entity)
BAD:  "Create New Record and Verify"           ← REJECTED (too generic, entity unclear)
GOOD: "Create ${moduleDisplayName} With Required Fields and Verify Success"
GOOD: "Delete ${moduleDisplayName} and Verify Removal"

If the metadata context mentions any forbidden entities above, IGNORE THEM COMPLETELY.
Focus 100% on "${input.selectedModule}" — nothing else.
## 🔴🔴🔴 END ENTITY SCOPE LOCK 🔴🔴🔴
` : ''

    const agentSystemPrompt = `You are the Test Case Generator Agent for AutoTestAI.

Your job: Generate high-level test cases (NOT step-by-step — just name, description, priority).
${moduleScopeBlock}
Sources (use ALL provided):
1. PROJECT METADATA (via RAG) — primary source of truth
2. BRD / Functional Specification — business rules
3. Existing Test Cases — avoid duplication
4. Focus Areas — constrain generation scope

Rules:
- NEVER invent entities or pages not in the metadata
- Each test case must describe a REAL business workflow
- Use action-oriented names: "Create Invoice With Required Fields and Verify Success"
- Tags: CRUD | Negative | EdgeCase | Workflow | ReadOnly | Integration
- Do NOT generate smoke tests or UI-only tests without business value
- If metadata is empty, set confidence < 0.5 for all generated cases

Output ONLY valid JSON array (no markdown):
[{ 
  "name": string, 
  "description": string, 
  "priority": "low|medium|high", 
  "tags": string[], 
  "confidence": 0.0-1.0 
}]`

    const llm    = buildLlm()
    const parser = new StringOutputParser()
    const raw    = await llm.pipe(parser).invoke([
      new SystemMessage(agentSystemPrompt),
      new HumanMessage(userPrompt),
    ])

    let cleaned = raw.trim()
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.split('\n').filter(l => !l.trim().startsWith('```')).join('\n')
    }
    const match = cleaned.match(/\[[\s\S]*\]/)
    if (match) cases = JSON.parse(match[0]) as GeneratedTestCase[]
  } catch (err) {
    thoughts.push(`ACT: parse error — ${String(err).slice(0, 80)}`)
  }

  // ── Post-generation module scope validation ───────────────────────────
  if (input.selectedModule && cases.length > 0) {
    const { filterTestCasesToModule } = await import('../test-case-generator/test-case-generator.service.js')
    const filtered = filterTestCasesToModule(cases as any[], input.selectedModule)
    cases = filtered as any[]
    thoughts.push(`REFLECT: filtered down to ${cases.length} cases strictly belonging to ${input.selectedModule}`)
  }

  // ── REFLECT: de-duplicate ─────────────────────────────────────────────────

  thoughts.push(`REFLECT: de-duplicating ${cases.length} candidates against ${existingNames.length} existing`)
  const deduped = cases.filter(c => !isDuplicate(c.name, existingNames))
  thoughts.push(`REFLECT: ${deduped.length} unique cases after de-duplication`)

  const avgConfidence = deduped.length > 0
    ? deduped.reduce((s, c) => s + (c.confidence ?? 0.7), 0) / deduped.length
    : 0


  // ── DELIVER ───────────────────────────────────────────────────────────────

  await logAgentExecution({
    projectId:     input.projectId,
    agentName:     'test-case-generator',
    taskType:      'generate_test_cases',
    inputSummary:  { count: input.count, focusAreas: input.focusAreas, module: input.selectedModule },
    outputSummary: { generated: deduped.length, duplicatesRemoved: cases.length - deduped.length },
    thoughts,
    hitlInvoked,
    confidence:    avgConfidence,
    tokensUsed:    0,
    durationMs:    Date.now() - startMs,
  })

  log.info(
    { projectId: input.projectId, count: deduped.length, avgConfidence },
    '[TC-GEN] Done',
  )

  return { cases: deduped, thoughts, confidence: avgConfidence, hitlInvoked }
}
