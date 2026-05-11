/**
 * Workflow Chat Service
 * Powers the AI-driven Business Flow wizard in the Tests tab:
 *   Phase 1 — Generate business flow options from project metadata + BRD
 *   Phase 2 — Conversational refinement to narrow the workflow scope
 *   Phase 3 — Natural-language filtering of generated test cases
 */
import { ChatOpenAI }            from '@langchain/openai'
import { ChatAnthropic }         from '@langchain/anthropic'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { StringOutputParser }    from '@langchain/core/output_parsers'
import type { BaseChatModel }    from '@langchain/core/language_models/chat_models'
import prisma                    from '../../shared/db/prisma.js'
import { createModuleLogger }    from '../../shared/logger/index.js'

const log = createModuleLogger('workflow-chat')

// ─── LLM factory ─────────────────────────────────────────────────────────────

function buildLlm(): BaseChatModel {
  if (process.env.OPENAI_API_KEY) {
    return new ChatOpenAI({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini', temperature: 0.4 })
  }
  return new ChatAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model:  process.env.LLM_MODEL ?? 'claude-sonnet-4-5',
    maxTokens: 2048,
    temperature: 0.4,
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getProjectContext(projectId: string): Promise<{
  projectName: string
  metadataSummary: string
  brdContent: string
}> {
  const [project, integration, brdRow] = await Promise.all([
    prisma.projects.findUnique({ where: { id: projectId }, select: { name: true, category: true } }),
    prisma.project_integrations.findFirst({
      where: { project_id: projectId },
      select: { last_synced_at: true },
    }),
    (prisma as any).project_brd?.findFirst
      ? (prisma as any).project_brd.findFirst({ where: { project_id: projectId }, select: { content: true } })
      : null,
  ])

  // ── Build metadata summary from correct tables ─────────────────────────
  // Priority: domain_models (has entity_name + actions) >
  //           metadata_raw_store (distinct page paths) >
  //           metadata_normalized (object_name fallback)
  let metaSummary = '(no metadata synced yet)'

  // 1. domain_models — best source: real entity/page names + available actions
  const domainModels = await prisma.domain_models.findMany({
    where: { project_id: projectId },
    select: { entity_name: true, actions: true },
    distinct: ['entity_name'],
    take: 30,
  })

  if (domainModels.length > 0) {
    metaSummary = domainModels.map(dm => {
      const actionList = Array.isArray(dm.actions) ? (dm.actions as string[]).slice(0, 4).join(', ') : ''
      // For web apps entity_name is a URL — extract readable path
      let label = dm.entity_name
      try { const u = new URL(dm.entity_name); label = u.pathname === '/' ? u.hostname : u.pathname } catch { /* not a URL */ }
      return `- ${label}${actionList ? ` [${actionList}]` : ''}`
    }).join('\n')
  } else {
    // 2. Fall back to distinct page paths from metadata_raw_store
    const rawRow = await prisma.metadata_raw_store.findFirst({
      where: { project_id: projectId, metadata_type: 'webpage' },
      select: { raw_json: true },
    })
    const rawPages = ((rawRow?.raw_json as any)?.pages ?? []) as Array<{path?: string; url?: string}>
    const distinctPaths = [...new Set(rawPages.map(p => p.path ?? p.url ?? ''))].filter(Boolean)
    if (distinctPaths.length > 0) {
      metaSummary = distinctPaths.slice(0, 30).map(p => `- ${p}`).join('\n')
    } else {
      // 3. Last resort: metadata_normalized uses object_name (not entity_name)
      const normalised = await prisma.metadata_normalized.findMany({
        where: { project_id: projectId },
        take: 20,
        select: { object_name: true, entity_type: true, label: true },
      })
      if (normalised.length > 0) {
        metaSummary = normalised.map(n => `- ${n.label ?? n.object_name}`).join('\n')
      }
    }
  }

  return {
    projectName:     project?.name ?? 'Unknown Project',
    metadataSummary: metaSummary,
    brdContent:      brdRow?.content ?? '',
  }
}

// ─── Phase 1: Generate Business Flows ────────────────────────────────────────

export interface BusinessFlow {
  name:        string
  description: string   // 1–2 sentence explanation of what the flow tests
}

export async function generateBusinessFlows(
  projectId: string,
  brdContent?: string,
): Promise<{ flows: BusinessFlow[] }> {
  const ctx = await getProjectContext(projectId)
  const brd = brdContent ?? ctx.brdContent

  const systemPrompt = `You are an expert QA Architect with deep knowledge of CRM, ERP, and web application testing.

Your task: generate a COMPREHENSIVE list of BUSINESS FLOWS for the project described below.
A Business Flow is a complete end-to-end user journey that tests real business value — not a single page or button.

═══════════════════════════════════════════════════════
PROJECT: ${ctx.projectName}
ENTITIES / MODULES AVAILABLE IN THIS APPLICATION:
${ctx.metadataSummary}
${brd ? `\nBRD / SPECIFICATION (use this to identify business rules and user journeys):\n${brd.slice(0, 5000)}` : ''}
═══════════════════════════════════════════════════════

MANDATORY GENERATION RULES:
1. ✅ Generate flows for EVERY entity/module visible in the metadata — do NOT skip any.
   For a CRM: you MUST include flows for Accounts, Contacts, Opportunities, Leads, Invoices,
   Contracts, Cases, Tasks, Products, Price Books, Quotes, Campaigns — if they exist in metadata.
   For a Web App: cover every page/module in the metadata summary.

2. ✅ For each major entity, include BOTH:
   a) The core CRUD lifecycle (create → update → delete)
   b) At least one CROSS-ENTITY workflow (e.g. Convert Lead to Opportunity and Account)

3. ✅ Include flows that test BUSINESS RULES from the BRD (e.g. approval workflows, validation gates,
   status transitions, assignment rules).

4. ❌ DO NOT generate flows for entities NOT present in the metadata or BRD.
   If "Opportunity" is not in the metadata, do NOT generate an Opportunity flow.

5. ❌ DO NOT generate vague/generic flows like:
   - "Verify UI is working" — REJECTED
   - "Test the dashboard" — REJECTED
   - "User login" — REJECTED (session is pre-managed, no auth tests)
   - "Verify navigation" — REJECTED

6. ✅ Each flow name should be 4–9 words, action-oriented, and entity-specific.
   GOOD: "Create Lead and Convert to Opportunity"
   GOOD: "Generate Invoice for Closed Opportunity and Mark Paid"
   GOOD: "Assign Case to Support Agent and Resolve"
   BAD:  "Test CRM Features" — too generic

7. ✅ Generate 10–18 flows total. Prioritise the most business-critical journeys first.

8. ✅ Write a clear 1–2 sentence description for each flow explaining:
   - What entities are involved
   - What business outcome it validates

Return ONLY valid JSON with this exact shape (no markdown, no prose):
{
  "flows": [
    {
      "name": "Concise action-oriented flow name",
      "description": "1–2 sentences describing what this flow tests and why it matters for the business."
    }
  ]
}`

  const llm    = buildLlm()
  const parser = new StringOutputParser()
  let raw = ''
  try {
    raw = await llm.pipe(parser).invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage('Generate the complete business flow list now. Return ONLY valid JSON — no markdown fences, no explanation.'),
    ])
    let jsonStr = raw.trim().replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '')
    const firstBrace = jsonStr.indexOf('{')
    const lastBrace  = jsonStr.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace !== -1) {
      jsonStr = jsonStr.slice(firstBrace, lastBrace + 1)
    }
    const parsed = JSON.parse(jsonStr)
    const flows: BusinessFlow[] = (Array.isArray(parsed.flows) ? parsed.flows : [])
      .filter((f: any) => f && typeof f.name === 'string' && f.name.trim())
      .map((f: any) => ({
        name:        String(f.name).trim(),
        description: String(f.description ?? '').trim(),
      }))
    return { flows }
  } catch (err) {
    log.error({ err, raw }, '[WORKFLOW] Failed to generate business flows')
    return { flows: [] }
  }
}

// ─── Phase 2: Refinement Chat ─────────────────────────────────────────────────

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

export interface WorkflowChatResponse {
  reply:         string
  /** true when the AI has gathered enough info and recommends generating */
  readyToGenerate: boolean
  /** structured workflow scope — populated when readyToGenerate=true */
  workflowScope?: {
    flow:          string
    actors:        string[]
    preconditions: string[]
    steps:         string[]
    edgeCases:     string[]
  }
}

export async function workflowRefinementChat(params: {
  projectId:   string
  flow:        string
  history:     ChatMessage[]
  userMessage: string
  brdContent?: string
}): Promise<WorkflowChatResponse> {
  const { projectId, flow, history, userMessage, brdContent } = params
  const ctx = await getProjectContext(projectId)
  const brd = brdContent ?? ctx.brdContent

  const historyText = history
    .slice(-12)
    .map(m => `${m.role === 'user' ? 'You' : 'AI'}: ${m.content}`)
    .join('\n')

  const exchangeCount = history.filter(m => m.role === 'user').length

  const systemPrompt = `You are an expert QA Analyst. Your goal is to QUICKLY set up test generation scope — do NOT over-question the user.

PROJECT: ${ctx.projectName}
SELECTED BUSINESS FLOW: "${flow}"
AVAILABLE METADATA (pages / entities):
${ctx.metadataSummary}
${brd ? `\nBRD:\n${brd.slice(0, 3000)}` : ''}

CONVERSATION SO FAR:
${historyText || '(this is the very first message)'}
USER EXCHANGE COUNT: ${exchangeCount}

══════════════════════════════════════════════════
STRICT AGENT RULES (must follow in order):
══════════════════════════════════════════════════

RULE 1 — PROCEED INTENT: If the user's message contains any of the following signals, you MUST immediately set "readyToGenerate": true with no more questions:
  Keywords: proceed, generate, start, go, next, skip, yes, ok, okay, sure, continue, let's go, create, build, ready, enough, fine, all good, sounds good, just generate, do it
  Short affirmative responses: "admin", "all roles", "standard", "default", any 1-3 word answer to your earlier question

RULE 2 — EXCHANGE LIMIT: If exchangeCount >= 1 (user has already replied once), ALWAYS set "readyToGenerate": true. Never ask a 3rd question.

RULE 3 — FIRST MESSAGE: If exchangeCount === 0, ask AT MOST ONE optional context question, max 15 words. Frame it so skipping is easy. Example: "Any specific role or scenario to focus on, or generate a full suite?"

RULE 4 — AUTO-DERIVE: Use the flow name and metadata to infer ALL workflowScope fields. Do NOT ask the user to list steps, preconditions, actors, or edge cases separately.

══════════════════════════════════════════════════

Respond with ONLY valid JSON, no prose:

If still gathering (first exchange only, no proceed intent):
{"reply": "<single optional question, max 15 words>", "readyToGenerate": false}

If ready (any other case — default to this):
{
  "reply": "Got it! Generating a comprehensive test suite for \\"${flow}\\" now.",
  "readyToGenerate": true,
  "workflowScope": {
    "flow": "${flow}",
    "actors": ["<infer from flow + metadata>"],
    "preconditions": ["<infer>"],
    "steps": ["<infer key steps>"],
    "edgeCases": ["<infer common edge cases>"]
  }
}`

  const llm    = buildLlm()
  const parser = new StringOutputParser()
  let raw = ''
  try {
    raw = await llm.pipe(parser).invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(`User says: "${userMessage}"\n\nRespond with ONLY valid JSON.`),
    ])
    let jsonStr = raw.trim().replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '')
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
    }
    const parsed = JSON.parse(jsonStr)
    return {
      reply:           parsed.reply ?? 'Ready to generate your test cases!',
      readyToGenerate: !!parsed.readyToGenerate,
      workflowScope:   parsed.workflowScope,
    }
  } catch (err) {
    log.error({ err, raw }, '[WORKFLOW] Refinement chat LLM error')
    return { reply: 'I had trouble processing that. Could you rephrase?', readyToGenerate: false }
  }
}

// ─── Phase 3: Test-Case Filter Chat ───────────────────────────────────────────

export interface TestCaseSummary {
  id:       string
  name:     string
  priority: string
  description?: string | null
}

export interface FilterChatResponse {
  reply:       string
  /** IDs to keep selected */
  selectedIds: string[]
  /** human-readable explanation of what was filtered */
  summary:     string
}

export async function filterTestCasesChat(params: {
  instruction: string
  history:     ChatMessage[]
  testCases:   TestCaseSummary[]
  currentSelectedIds: string[]
}): Promise<FilterChatResponse> {
  const { instruction, history, testCases, currentSelectedIds } = params

  const tcList = testCases.map((tc, i) =>
    `${i + 1}. [${tc.id}] ${tc.name} (priority: ${tc.priority})${tc.description ? ` — ${tc.description.slice(0, 80)}` : ''}`
  ).join('\n')

  const historyText = history.slice(-8)
    .map(m => `${m.role === 'user' ? 'You' : 'AI'}: ${m.content}`)
    .join('\n')

  const systemPrompt = `You are an AI assistant helping a QA engineer review and filter a generated list of test cases.
The user can say things like:
  - "Keep only High priority tests"
  - "Remove all login-related tests"
  - "Select only the edge cases"
  - "Deselect everything related to payments"
  - "Select all"
  - "I want tests 1, 3, and 5"

AVAILABLE TEST CASES (full list):
${tcList}

CURRENTLY SELECTED IDs: ${JSON.stringify(currentSelectedIds)}

CONVERSATION HISTORY:
${historyText || '(start)'}

Based on the user's instruction, determine which test case IDs should be selected.
If the instruction is ambiguous, make your best interpretation and explain it.

Respond with ONLY valid JSON:
{
  "reply": "Your conversational response explaining what you did",
  "selectedIds": ["id1", "id2", ...],
  "summary": "X of Y tests selected — kept all High priority tests"
}`

  const llm    = buildLlm()
  const parser = new StringOutputParser()
  let raw = ''
  try {
    raw = await llm.pipe(parser).invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(`User: "${instruction}"\n\nRespond with ONLY valid JSON.`),
    ])
    let jsonStr = raw.trim().replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '')
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
    }
    const parsed = JSON.parse(jsonStr)
    const validIds = (parsed.selectedIds ?? []).filter((id: string) => testCases.some(tc => tc.id === id))
    return {
      reply:       parsed.reply ?? 'Done.',
      selectedIds: validIds,
      summary:     parsed.summary ?? `${validIds.length} tests selected`,
    }
  } catch (err) {
    log.error({ err, raw }, '[WORKFLOW] Filter chat LLM error')
    return {
      reply:       'I had trouble understanding that. Please try again.',
      selectedIds: currentSelectedIds,
      summary:     `${currentSelectedIds.length} tests selected (unchanged)`,
    }
  }
}
// ─── Phase 4: Multi-Flow Test Suite Generation ────────────────────────────────
// Generates test cases grouped by business flow and orders them for optimal
// sequential execution (e.g. setup flows first, teardown flows last).

export interface FlowTestCase {
  name: string
  description: string | null
  priority: string
  steps: unknown[]
  tags?: string[]
}

export interface FlowGroup {
  flow: string
  order: number
  rationale: string
  testCases: (FlowTestCase & { id?: string })[]
}

export interface GenerateTestSuiteResult {
  groups: FlowGroup[]
  totalTestCases: number
}

export async function generateTestSuite(params: {
  projectId:  string
  flows:      string[]
  brdContent?: string
}): Promise<GenerateTestSuiteResult> {
  const { projectId, flows, brdContent } = params
  const ctx = await getProjectContext(projectId)
  const brd = brdContent ?? ctx.brdContent

  const llm    = buildLlm()
  const parser = new StringOutputParser()

  // ── Step 1: Ask LLM to order the flows for optimal execution ─────────────────
  let orderedFlows: Array<{ flow: string; order: number; rationale: string }> = flows.map((f, i) => ({
    flow: f, order: i + 1, rationale: 'User-specified order',
  }))

  try {
    const orderPrompt = `You are a QA Architect. Given these business flows for the project "${ctx.projectName}", 
order them optimally for sequential test execution (prerequisite flows first, cleanup/teardown flows last).
FLOWS TO ORDER:
${flows.map((f, i) => `${i + 1}. ${f}`).join('\n')}

METADATA CONTEXT:
${ctx.metadataSummary.slice(0, 1000)}

Return ONLY valid JSON:
{
  "ordered": [
    { "flow": "exact flow name", "order": 1, "rationale": "why this comes first (max 10 words)" },
    ...
  ]
}`
    const raw = await llm.pipe(parser).invoke([
      new SystemMessage(orderPrompt),
      new HumanMessage('Order the flows now. Return ONLY valid JSON.'),
    ])
    let jsonStr = raw.trim().replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '')
    const fb = jsonStr.indexOf('{'); const lb = jsonStr.lastIndexOf('}')
    if (fb !== -1 && lb !== -1) jsonStr = jsonStr.slice(fb, lb + 1)
    const parsed = JSON.parse(jsonStr)
    if (Array.isArray(parsed.ordered)) {
      orderedFlows = parsed.ordered.filter((x: any) => x.flow && x.order)
    }
  } catch (err) {
    log.warn({ err }, '[SUITE] Flow ordering failed — using default order')
  }

  // ── Step 2: Generate test cases per flow in parallel ────────────────────────
  const PER_FLOW_COUNT = Math.min(Math.max(4, Math.floor(20 / flows.length)), 8)

  const groupResults = await Promise.allSettled(
    orderedFlows.map(async (entry) => {
      const tcPrompt = `You are a senior QA Automation Engineer. 
Generate exactly ${PER_FLOW_COUNT} test cases for this SPECIFIC BUSINESS FLOW: "${entry.flow}"

PROJECT: ${ctx.projectName}
AVAILABLE ENTITIES/PAGES:
${ctx.metadataSummary}
${brd ? `\nBRD:\n${brd.slice(0, 3000)}` : ''}

RULES:
- Test cases must be SPECIFIC to the "${entry.flow}" flow only
- Each test case must end with an ASSERT step
- Names must be action-oriented (verb + entity + outcome)
- Cover happy path, edge cases, and at least 1 negative test
- No login/auth steps — session is pre-established

Return ONLY valid JSON array (no markdown):
[
  {
    "name": "string",
    "description": "string",
    "priority": "high|medium|low",
    "steps": [
      { "id": "1", "action": "NAVIGATE", "value": "/path" },
      { "id": "2", "action": "TYPE", "target": "Field Label", "value": "test value", "locator_type": "label" }
    ],
    "tags": ["FlowName", "CRUD"]
  }
]`
      const raw = await llm.pipe(parser).invoke([
        new SystemMessage(tcPrompt),
        new HumanMessage('Generate the test cases now. Return ONLY a valid JSON array.'),
      ])
      let jsonStr = raw.trim().replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '')
      const fa = jsonStr.indexOf('['); const la = jsonStr.lastIndexOf(']')
      if (fa !== -1 && la !== -1) jsonStr = jsonStr.slice(fa, la + 1)
      const testCases: FlowTestCase[] = JSON.parse(jsonStr)
      return { ...entry, testCases: Array.isArray(testCases) ? testCases : [] }
    })
  )

  // ── Step 3: Persist test cases to DB and collect IDs ────────────────────────
  const groups: FlowGroup[] = []
  for (const result of groupResults) {
    if (result.status === 'rejected') {
      log.warn({ err: result.reason }, '[SUITE] Flow generation failed')
      continue
    }
    const { flow, order, rationale, testCases } = result.value
    const persisted: (FlowTestCase & { id?: string })[] = []

    for (const tc of testCases) {
      try {
        const row = await prisma.test_cases.create({
          data: {
            name:        tc.name,
            description: tc.description ?? '',
            priority:    tc.priority ?? 'medium',
            steps:       (tc.steps ?? []) as any,
            status:      'active',
            project_id:  projectId,   // ← required so test-run service can resolve the project
          },
        })
        persisted.push({ ...tc, id: row.id })
      } catch (err) {
        log.warn({ err, tcName: tc.name }, '[SUITE] Failed to persist TC')
      }
    }
    groups.push({ flow, order, rationale, testCases: persisted })
  }

  // Sort by order
  groups.sort((a, b) => a.order - b.order)
  const totalTestCases = groups.reduce((s, g) => s + g.testCases.length, 0)

  log.info({ projectId, flowCount: groups.length, totalTestCases }, '[SUITE] Generation complete')
  return { groups, totalTestCases }
}
