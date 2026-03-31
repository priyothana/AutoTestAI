/**
 * Test-Generation Module — Service Layer
 *
 * Full LangChain.js RAG chain ported from Python ai_service.py (50 K lines).
 *
 * Generation pipeline (in priority order):
 *   1. MCP + vector embeddings → strict metadata-driven RAG (MCP_RAG_SYSTEM_PROMPT)
 *   2. Salesforce project + connected → standard RAG (RAG_SYSTEM_PROMPT)
 *   3. Standard path → STANDARD_SYSTEM_PROMPT
 *
 * Cross-module imports (SKILL.md boundary rule):
 *   - salesforce.service.ts → getObjectMetadata enrichment
 *   - project.service.ts    → getIntegrationByProject (via salesforce module)
 *   - QUEUES.EXECUTION      → enqueue if auto-run
 *
 * WebApp crawler path is DEFERRED (queue-based, not inline) — kept as TODO per SKILL.md.
 * Salesforce engine is DEFERRED — salesforce.service.ts proxies through this module.
 */
import { ChatAnthropic }    from '@langchain/anthropic'
import { ChatOpenAI }        from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { StringOutputParser } from '@langchain/core/output_parsers'
import { Queue }              from 'bullmq'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'

import prisma                 from '../../shared/db/prisma.js'
import { createModuleLogger } from '../../shared/logger/index.js'
import { getRedisOptions }    from '../../shared/queue/connection.js'
import { QUEUES }             from '../../shared/queue/queues.js'
import type { ExecutionJob }  from '../../shared/queue/job-types.js'

// Cross-module: public interface of salesforce module only
import {
  getObjectMetadata,
} from '../salesforce/salesforce.service.js'

import type { GenerateRequest, GenerateResponse, Step } from './generation.schema.js'

const log = createModuleLogger('test-generation')

// ── BullMQ queue (producer side only) ────────────────────────────────

const executionQueue = new Queue<ExecutionJob>(QUEUES.EXECUTION, getRedisOptions())

// ─── System Prompts (exact copy from Python ai_service.py) ──────────

const STANDARD_SYSTEM_PROMPT = `
You are an expert QA Automation Engineer specialized in Playwright test automation.

Your task is to convert a natural language test case into a structured Playwright-compatible JSON test definition that can be executed directly by a Playwright runner.

IMPORTANT CONTEXT:
- The application base URL is managed separately in the Project configuration.
- NEVER use mock URLs like "https://example.com".
- For NAVIGATE steps:
  - Use relative paths like "/login", "/dashboard", "/accounts"
  - If no specific path is mentioned, use "/" or leave value empty ""
  - The Playwright runner will automatically prepend the Project Base URL

-------------------------
GENERAL RULES
-------------------------
1. Output ONLY valid JSON (no explanations, no comments).
2. Ensure all steps are executable and valid for Playwright automation.
3. Use ACCESSIBILITY-BASED LOCATORS as the PRIMARY strategy (see Locator Priority below).
4. Avoid fragile CSS selectors like nth-child, [title=...], or class-based selectors unless absolutely necessary.
5. Always include appropriate WAIT steps before ASSERT_TEXT or CLICK if the element loads dynamically.

-------------------------
LOCATOR PRIORITY (MUST FOLLOW)
-------------------------
When generating locators for interactive elements, use this priority order:

1. getByRole (PREFERRED) — uses ARIA roles and accessible names
   Example: getByRole('button', { name: 'Submit' })
   Example: getByRole('link', { name: 'Home' })
   Example: getByRole('textbox', { name: 'Email' })

2. getByLabel — uses form field labels
   Example: getByLabel('Email Address')
   Example: getByLabel('Password')

3. getByText — uses visible text content
   Example: getByText('Welcome Back')
   Example: getByText('Sign In')

4. CSS selector (FALLBACK ONLY) — use only when no accessible name/role exists
   Example: #loginBtn, .toast-message, [data-testid='submit']

-------------------------
SUPPORTED ACTIONS
-------------------------
Each step must use ONLY one of the following actions:

- NAVIGATE
- CLICK
- TYPE
- ASSERT_TEXT
- WAIT
- SELECT
- LOOKUP
- CHECKBOX
- MULTI_SELECT
- UPLOAD

-------------------------
STEP FORMAT
-------------------------
Each step must follow this structure:

{
  "id": "1",
  "action": "NAVIGATE | CLICK | TYPE | ASSERT_TEXT | WAIT",
  "target": "locator expression (required except NAVIGATE and WAIT)",
  "value": "url | text | input value | wait time (seconds)",
  "locator_type": "role | label | text | css"
}

The "locator_type" field tells the runner HOW to resolve the target:
- "role"  → page.getByRole(role, { name: name })
            target format: "role=button, name=Submit" or "role=link, name=Home"
- "label" → page.getByLabel(target)
            target format: "Email Address" or "Password"
- "text"  → page.getByText(target)
            target format: "Welcome Back"
- "css"   → page.locator(target)
            target format: "#loginBtn" or ".toast-message"

For NAVIGATE and WAIT actions, locator_type is not needed.

-------------------------
ACTION RULES
-------------------------

1. NAVIGATE
   - Only needs "value" (URL path)
   - Do not include target or locator_type

2. WAIT
   - value must be number of seconds as string (e.g. "3")
   - Use WAIT after navigation or before assertion when UI loads

3. TYPE
   - target must identify an input field
   - value is the text to type
   - Prefer locator_type "label" for form fields
   - Example: { "action": "TYPE", "target": "Email Address", "value": "user@test.com", "locator_type": "label" }

4. CLICK
   - target must identify a button, link, or clickable element
   - Prefer locator_type "role" for buttons and links
   - Example: { "action": "CLICK", "target": "role=button, name=Submit", "locator_type": "role" }

5. ASSERT_TEXT
   - DO NOT put text inside target
   - target must identify the container element
   - value must be the expected visible text
   - Use locator_type "css" for structural selectors, "text" for text-based

   ✅ Correct:
   { "action": "ASSERT_TEXT", "target": "h1", "value": "Welcome Back", "locator_type": "css" }

   ❌ Wrong:
   { "action": "ASSERT_TEXT", "target": "Welcome Back" }

-------------------------
OUTPUT FORMAT
-------------------------
Return JSON in this structure:

{
  "name": "Concise Test Case Name",
  "description": "Detailed description of what is being tested",
  "priority": "low" | "medium" | "high",
  "preconditions": ["List of preconditions"],
  "steps": [
    {
      "id": "1",
      "action": "NAVIGATE",
      "value": "/dashboard"
    },
    {
      "id": "2",
      "action": "CLICK",
      "target": "role=button, name=New",
      "locator_type": "role"
    }
  ],
  "expected_outcome": "Clear expected final result"
}

Generate test steps that will PASS successfully in Playwright runner.
`

const RAG_SYSTEM_PROMPT = `
You are an expert QA Automation Engineer specialized in Salesforce testing with Playwright.

Your task is to convert a natural language test case into a structured Playwright-compatible JSON test definition, using REAL Salesforce org metadata provided below.

IMPORTANT CONTEXT:
- You are given actual metadata from the user's Salesforce org (objects, fields, flows, validation rules, LWC components).
- Use the REAL field API names, object names, and flow names from the metadata.
- The application base URL is managed separately in the Project configuration.
- For NAVIGATE steps, use relative paths like "/lightning/o/ObjectName/list" or "/lightning/r/ObjectId/view"

-------------------------
METADATA CONTEXT
-------------------------
{rag_context}

-------------------------
LOCATOR PRIORITY (MUST FOLLOW)
-------------------------
When generating locators for interactive elements, use this priority order:

1. getByRole (PREFERRED) — uses ARIA roles and accessible names
2. getByLabel — uses form field labels (ideal for Salesforce fields)
3. getByText — uses visible text content
4. CSS selector (FALLBACK ONLY) — use only for structural/toast elements

-------------------------
GENERAL RULES
-------------------------
1. Output ONLY valid JSON (no explanations, no comments).
2. Use the ACTUAL Salesforce field API names from the metadata context above.
3. Use ACCESSIBILITY-BASED LOCATORS as the primary strategy.
4. For buttons: ALWAYS use getByRole('button', { name: '...' })
5. For form fields: ALWAYS use getByLabel('Field Label')
6. Include WAIT steps after navigation and before assertions.

-------------------------
OUTPUT FORMAT
-------------------------
{
  "name": "Concise Test Case Name",
  "description": "Detailed description of what is being tested",
  "priority": "low" | "medium" | "high",
  "preconditions": ["List of preconditions"],
  "steps": [...],
  "expected_outcome": "Clear expected final result"
}

Generate test steps that use REAL metadata from the context above.
ALWAYS prefer getByRole and getByLabel over CSS selectors.
`

const MCP_RAG_SYSTEM_PROMPT = `
You are an expert Salesforce QA Automation Engineer specialized in Playwright test automation with STRICT metadata alignment.

This is a METADATA-DRIVEN GENERATION MODE.
The user's Salesforce org metadata is provided below. You MUST use it.

CRITICAL RULES:
- DO NOT generate login/authentication steps (session is injected automatically)
- DO NOT use hardcoded domains or login.salesforce.com
- DO NOT assume fields — use ONLY fields from the metadata
- DO NOT assume picklist values — use ONLY values from the metadata
- DO NOT use fragile CSS selectors like button[title='...'] — use getByRole instead
- DO NOT use Salesforce API field names (e.g. "Designation__c") as locator targets — use the field LABEL
- Every step must be executable by the Playwright runner
- ALWAYS use accessibility-based locators (see Locator Priority below)

-------------------------
SALESFORCE ORG METADATA
-------------------------
{rag_context}

-------------------------
LOCATOR PRIORITY (MUST FOLLOW)
-------------------------
1. getByRole (PREFERRED) — for buttons, links, tabs, menuitems
   target format: "role=button, name=New" or "role=link, name=Accounts"

2. getByLabel — for form field inputs (IDEAL for Salesforce fields)
   target format: "Account Name" or "Phone" or "Industry"

3. getByText — for visible text content assertions or text-based clicks
   target format: "was created" or "Error"

4. CSS selector (FALLBACK ONLY) — for structural/toast elements
   target format: ".slds-notify_toast" or "[role='option'][data-value='Value']"

-------------------------
SUPPORTED ACTIONS
-------------------------
- NAVIGATE — value = relative URL path
- CLICK — target = locator expression (prefer getByRole)
- TYPE — target = locator expression (prefer getByLabel), value = text to type
- SELECT — target = field label, value = picklist option to select
- MULTI_SELECT — target = field label, value = semicolon-separated options
- LOOKUP — target = field label, value = search text
- CHECKBOX — target = field label, value = "true" or "false"
- ASSERT_TEXT — target = locator expression, value = expected text
- WAIT — value = seconds as string

-------------------------
SALESFORCE LIGHTNING URL PATTERNS
-------------------------
Object List:    "/lightning/o/{ObjectApiName}/list"
New Record:     "/lightning/o/{ObjectApiName}/new"
Record View:    "/lightning/r/{ObjectApiName}/{RecordId}/view"
Home:           "/lightning/page/home"

⚠ CRITICAL: Custom objects ALWAYS use their API name with __c suffix.
  "Invoice" → "Invoice__c"  →  /lightning/o/Invoice__c/list

-------------------------
STEP FORMAT (STRICT)
-------------------------
{
  "id": "1",
  "action": "NAVIGATE | CLICK | TYPE | ASSERT_TEXT | WAIT",
  "target": "locator expression (required except NAVIGATE and WAIT)",
  "value": "url | input value | expected text | wait seconds",
  "locator_type": "role | label | text | css"
}

-------------------------
OUTPUT FORMAT
-------------------------
{
  "name": "Concise Test Case Name",
  "description": "What is being tested with metadata context",
  "priority": "low" | "medium" | "high",
  "preconditions": ["User is authenticated via MCP session"],
  "steps": [...],
  "expected_outcome": "Clear expected result"
}

IMPORTANT: Output ONLY valid JSON. No explanations, no comments, no markdown.
ALWAYS use getByRole for buttons and getByLabel for form fields. CSS is FALLBACK ONLY.
`

// ── LLM factory ───────────────────────────────────────────────────────

function buildLlm(provider: string, model?: string): BaseChatModel {
  const providerLower = provider.toLowerCase().trim()

  if (providerLower === 'openai') {
    const modelName = model ?? 'gpt-4o-mini'
    return new ChatOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      model:  modelName,
      temperature: 0.7,
    })
  }

  if (providerLower === 'claude') {
    const modelName = model ?? (process.env.LLM_MODEL ?? 'claude-sonnet-4-20250514')
    return new ChatAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model:  modelName,
      maxTokens: 4096,
      temperature: 0.7,
    })
  }

  throw { statusCode: 400, message: `Unsupported provider '${provider}'. Use 'openai' or 'claude'.` }
}

// ── Core LLM invocation ───────────────────────────────────────────────
// NOTE: We use HumanMessage/SystemMessage directly instead of
// ChatPromptTemplate.fromMessages() to avoid LangChain's template parser
// treating literal { } braces in the system prompt (JSON examples) as
// template variables, which causes "Single '}' in template" errors.

async function invokeLlm(
  systemPrompt: string,
  userPrompt:   string,
  provider:     string,
  model?:       string,
): Promise<Record<string, unknown>> {
  const llm    = buildLlm(provider, model)
  const parser = new StringOutputParser()

  const messages = [
    new SystemMessage(systemPrompt),
    new HumanMessage(userPrompt + '\n\nIMPORTANT: Respond with ONLY valid JSON. No explanations or markdown.'),
  ]

  let raw = await llm.pipe(parser).invoke(messages)

  // Strip markdown code fences if the model wraps the response
  raw = raw.trim()
  if (raw.startsWith('```')) {
    raw = raw
      .split('\n')
      .filter((l: string) => !l.trim().startsWith('```'))
      .join('\n')
  }

  return JSON.parse(raw) as Record<string, unknown>
}

// ── RAG retrieval (cosine similarity in Postgres) ─────────────────────

async function retrieveRagChunks(
  projectId: string,
  queryText: string,
  topK:      number = 15,
): Promise<string[]> {
  // Embed the query using OpenAI text-embedding-3-small (same as Python)
  let queryEmbedding: number[]
  try {
    const { OpenAI } = await import('openai')
    const client     = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const resp       = await client.embeddings.create({
      model: 'text-embedding-3-small',
      input: [queryText],
    })
    queryEmbedding = resp.data[0].embedding
  } catch (err) {
    log.warn({ err }, '[RAG] Failed to generate query embedding — returning no chunks')
    return []
  }

  // Fetch all embeddings for this project from Prisma
  const embeddings = await prisma.vector_embeddings.findMany({
    where:  { project_id: projectId },
    select: { embedding_vector: true, text_chunk: true, chunk_type: true },
  })

  if (embeddings.length === 0) return []

  // Compute cosine similarity
  type Scored = { score: number; chunk: string; chunkType: string }
  const scored: Scored[] = embeddings.map((row) => {
    const stored = row.embedding_vector as number[]
    const score  = cosineSimilarity(queryEmbedding, stored)
    return { score, chunk: row.text_chunk, chunkType: row.chunk_type ?? 'metadata' }
  })

  scored.sort((a, b) => b.score - a.score)

  const top = scored.slice(0, topK)

  // Log query (non-critical)
  try {
    await prisma.rag_query_logs.create({
      data: {
        project_id:      projectId,
        query_text:      queryText,
        retrieved_chunks: top.map((t, i) => ({
          rank:          i + 1,
          similarity:    Math.round(t.score * 10000) / 10000,
          chunk_preview: t.chunk.substring(0, 200),
          chunk_type:    t.chunkType,
        })),
      },
    })
  } catch {
    // non-critical
  }

  log.info(`[RAG] Retrieved ${top.length} chunks for query: "${queryText.substring(0, 80)}"`)
  return top.map((t) => t.chunk)
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

// ── RAG context builder (matches Python RAGService.build_rag_context) ──

function buildRagContext(chunks: string[], categorize = true): string {
  if (chunks.length === 0) return ''

  if (!categorize) {
    const parts = [
      '=== SALESFORCE ORG METADATA CONTEXT (Retrieved via RAG) ===',
      'Use the following metadata to generate accurate, org-specific Playwright test steps.',
      '',
    ]
    chunks.forEach((c, i) => {
      parts.push(`--- Relevant Context #${i + 1} ---`)
      parts.push(c)
      parts.push('')
    })
    parts.push('=== END OF METADATA CONTEXT ===')
    return parts.join('\n')
  }

  const metadata:  string[] = []
  const fieldRules: string[] = []
  const patterns:  string[] = []

  chunks.forEach((c) => {
    const lower = c.toLowerCase()
    if (lower.startsWith('field behavior rules') || lower.startsWith('failure correction pattern')) {
      fieldRules.push(c)
    } else if (lower.startsWith('successful test execution pattern')) {
      patterns.push(c)
    } else {
      metadata.push(c)
    }
  })

  const parts: string[] = []

  if (metadata.length > 0) {
    parts.push('=== SALESFORCE METADATA ===')
    parts.push('Use the following metadata to generate accurate, org-specific Playwright test steps.')
    parts.push('')
    metadata.forEach((c, i) => { parts.push(`--- Metadata #${i + 1} ---`); parts.push(c); parts.push('') })
  }

  if (fieldRules.length > 0) {
    parts.push('=== FIELD INTERACTION RULES ===')
    parts.push('The following rules were learned from past test executions. Apply these when generating test steps to avoid known failures.')
    parts.push('')
    fieldRules.forEach((c, i) => { parts.push(`--- Rule #${i + 1} ---`); parts.push(c); parts.push('') })
  }

  if (patterns.length > 0) {
    parts.push('=== SUCCESSFUL EXECUTION PATTERNS ===')
    parts.push('The following patterns were successful in past test executions. Use these as reference for generating similar test steps.')
    parts.push('')
    patterns.forEach((c, i) => { parts.push(`--- Pattern #${i + 1} ---`); parts.push(c); parts.push('') })
  }

  parts.push('=== END OF RAG CONTEXT ===')
  return parts.join('\n')
}

// ── Object-scoped chunk filtering (matches Python filtering logic) ────

function filterChunksByObject(chunks: string[], targetObj: string): string[] {
  const targetLower = targetObj.toLowerCase()

  const learningChunks: string[] = []
  const targetMetaChunks: string[] = []

  chunks.forEach((c) => {
    const lower  = c.toLowerCase()
    const header = lower.substring(0, 150)
    if (
      lower.startsWith('field behavior rules') ||
      lower.startsWith('successful test execution') ||
      lower.startsWith('failure correction')
    ) {
      learningChunks.push(c)
      return
    }
    if (
      header.includes(targetLower) ||
      lower.substring(0, 300).includes(`object: ${targetLower}`) ||
      lower.substring(0, 300).includes(`fields for ${targetLower}`)
    ) {
      targetMetaChunks.push(c)
    }
  })

  const filtered = [...targetMetaChunks, ...learningChunks]
  return filtered.length > 0 ? filtered : chunks
}

// ── Extract target object from prompt ────────────────────────────────

function extractTargetObject(prompt: string): string | null {
  const lower     = prompt.toLowerCase()
  const skipWords = new Set(['record', 'entry', 'form', 'item', 'test', 'case', 'step', 'the', 'a', 'an', 'new', 'with', 'for'])

  const patterns = [
    /\b(?:create|add)\b\s+(?:a\s+)?(?:new\s+)?(\w[\w\s]*?)(?:\s+record|\s+for|\s+with|\s*$)/,
    /\bnew\s+(\w+)(?:\s+(\w+))?/,
    /\b(\w+)\s+(?:creation|form|page|layout|list)\b/,
  ]

  for (const pattern of patterns) {
    const m = lower.match(pattern)
    if (m) {
      const word = m[1].trim()
      if (word && !skipWords.has(word)) return word
    }
  }

  return null
}

// ── Post-generation: re-number step IDs ──────────────────────────────

function renumberSteps(steps: Step[]): Step[] {
  return steps.map((s, i) => ({ ...s, id: String(i + 1) }))
}

// ── Normalise LLM output to GenerateResponse shape ───────────────────

function normaliseResponse(raw: Record<string, unknown>): GenerateResponse {
  const steps = (Array.isArray(raw['steps']) ? raw['steps'] : []) as Step[]
  return {
    name:             String(raw['name']             ?? 'Unnamed Test'),
    description:      String(raw['description']      ?? ''),
    steps:            renumberSteps(steps),
    priority:         String(raw['priority']         ?? 'medium'),
    preconditions:    Array.isArray(raw['preconditions'])
      ? (raw['preconditions'] as string[])
      : [],
    expected_outcome: String(raw['expected_outcome'] ?? ''),
  }
}

// ══════════════════════════════════════════════════════════════════════
// PUBLIC API — generateTest
// ══════════════════════════════════════════════════════════════════════

/**
 * Full generation pipeline — port of Python tests.py generate_test_steps_endpoint.
 *
 * Priority:
 *   1. MCP + embeddings → strict MCP_RAG_SYSTEM_PROMPT
 *   2. Connected Salesforce → RAG_SYSTEM_PROMPT
 *   3. Standard → STANDARD_SYSTEM_PROMPT
 *
 * After generation, enqueues to execution-queue if auto_run is set
 * on the project (currently always false — future feature).
 */
export async function generateTest(data: GenerateRequest): Promise<GenerateResponse> {
  const { prompt, provider = 'claude', model, project_id } = data

  log.info(`[GEN] Prompt: "${prompt.substring(0, 80)}" | provider=${provider} | project=${project_id ?? 'none'}`)

  // ── Detect project category and integration ────────────────────────

  let sessionInstruction = ''
  let useMcpRag          = false
  let embeddingCount     = 0

  if (project_id) {
    try {
      const integration = await prisma.project_integrations.findFirst({
        where:  { project_id },
        select: {
          category:             true,
          status:               true,
          mcp_connected:        true,
        },
      })

      const isConnected = integration?.status === 'connected'
      const isMcp       = Boolean(integration?.mcp_connected)
      const category    = integration?.category ?? ''

      if (isMcp && isConnected) {
        embeddingCount = await prisma.vector_embeddings.count({ where: { project_id } })
        if (embeddingCount > 0) {
          useMcpRag = true
          log.info(`[GEN] MCP project ${project_id} has ${embeddingCount} embeddings → strict metadata RAG`)
        } else {
          sessionInstruction =
            '\n\nIMPORTANT: This is a Salesforce MCP-connected project. ' +
            'DO NOT generate any login/authentication steps. The user is already authenticated. ' +
            'Start the test from the Lightning home page or the relevant object page directly. ' +
            'Use Salesforce Lightning URL patterns like /lightning/o/ObjectName/list.'
        }
      } else if (category === 'salesforce' && isConnected) {
        sessionInstruction =
          '\n\nIMPORTANT: This is a Salesforce project with an active OAuth connection. ' +
          'DO NOT generate any login/authentication steps. The user is already authenticated. ' +
          'Start the test from the application home page or the relevant object page directly.'
      }
    } catch (err) {
      log.warn({ err }, '[GEN] Project detection error — falling back to standard generation')
    }
  }

  // ── MCP RAG path ───────────────────────────────────────────────────

  if (useMcpRag && project_id) {
    try {
      let chunks = await retrieveRagChunks(project_id, prompt, 15)

      if (chunks.length > 0) {
        const targetObj = extractTargetObject(prompt)
        if (targetObj) {
          chunks = filterChunksByObject(chunks, targetObj)
          log.info(`[GEN] Strict object filter: target='${targetObj}', kept ${chunks.length} chunks`)
        }

        let ragContext = buildRagContext(chunks)

        // Supplemental direct metadata enrichment via salesforce.service.ts
        try {
          if (project_id && targetObj) {
            const sfMeta = await getObjectMetadata(project_id, targetObj).catch(() => null)
            if (sfMeta) {
              const directMetaSection = [
                '\n\n=== DIRECT SALESFORCE OBJECT METADATA ===',
                `Object: ${sfMeta.object_name} | Label: ${sfMeta.label ?? sfMeta.object_name}`,
                JSON.stringify(sfMeta.metadata, null, 2).substring(0, 3000),
                '=== END DIRECT METADATA ===',
              ].join('\n')
              ragContext += directMetaSection
            }
          }
        } catch {
          // non-critical sailsforce metadata enrichment
        }

        const systemPrompt = MCP_RAG_SYSTEM_PROMPT.replace('{rag_context}', ragContext)
        const rawResult    = await invokeLlm(systemPrompt, prompt, provider, model)
        const result       = normaliseResponse(rawResult)

        log.info(`[GEN] MCP RAG generation successful with ${chunks.length} chunks`)
        return { ...result, rag_context_used: true, retrieved_chunks: chunks.length }
      } else {
        log.info('[GEN] No RAG chunks found — falling back to standard with MCP session instruction')
        sessionInstruction =
          '\n\nIMPORTANT: This is a Salesforce MCP-connected project. ' +
          'DO NOT generate any login/authentication steps. ' +
          'Use Salesforce Lightning URL patterns like /lightning/o/ObjectName/list.'
      }
    } catch (ragErr) {
      log.warn({ err: ragErr }, '[GEN] MCP RAG failed — falling back to standard')
    }
  }

  // ── Standard path ─────────────────────────────────────────────────

  const effectivePrompt = prompt + sessionInstruction

  try {
    const rawResult = await invokeLlm(STANDARD_SYSTEM_PROMPT, effectivePrompt, provider, model)
    return normaliseResponse(rawResult)
  } catch (err: unknown) {
    // Auto-fallback to Claude if requested provider fails
    const providerLower = provider.toLowerCase()
    if (providerLower !== 'claude') {
      log.warn({ err }, '[GEN] Primary provider failed — falling back to Claude')
      try {
        const rawResult = await invokeLlm(STANDARD_SYSTEM_PROMPT, effectivePrompt, 'claude', undefined)
        return normaliseResponse(rawResult)
      } catch (claudeErr) {
        log.error({ err: claudeErr }, '[GEN] Claude fallback also failed')
        throw { statusCode: 502, message: `Both ${provider} and Claude failed to generate. Check API keys.` }
      }
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw { statusCode: 500, message: `Generation failed: ${msg}` }
  }
}

// ══════════════════════════════════════════════════════════════════════
// PUBLIC API — humanizeSteps
// ══════════════════════════════════════════════════════════════════════

const HUMANIZE_SYSTEM_PROMPT = `
You are a QA documentation specialist. Convert technical Playwright test steps into clear, human-readable natural language descriptions.

INPUT: A JSON array of test steps with action/target/value fields.

RULES:
1. Convert EACH step into a single clear English sentence.
2. Do NOT include technical details like CSS selectors, role attributes, or locator types.
3. Use action-appropriate phrasing:
   - NAVIGATE → "Navigate to [page/URL]" or "Go to the [page name]"
   - CLICK → "Click on [element description]"
   - TYPE → "Enter '[value]' in the [field name] field"
   - ASSERT_TEXT → "Verify that '[text]' is displayed"
   - WAIT → "Wait for [N] seconds"
   - SELECT → "Select '[value]' from the [field name] dropdown"
   - LOOKUP → "Search and select '[value]' in the [field name] lookup"
   - CHECKBOX → "Check/Uncheck the [field name] checkbox"

OUTPUT FORMAT:
{
  "readable_steps": [
    "Step 1 description in plain English",
    "Step 2 description in plain English"
  ]
}

IMPORTANT: Output ONLY valid JSON. No explanations, no markdown.
`

export async function humanizeSteps(
  steps:    Record<string, unknown>[],
  provider: string = 'claude',
): Promise<{ readable_steps: string[] }> {
  if (!steps || steps.length === 0) {
    throw { statusCode: 400, message: "A non-empty 'steps' array is required" }
  }

  const userPrompt = JSON.stringify(steps, null, 2)
  const raw        = await invokeLlm(HUMANIZE_SYSTEM_PROMPT, userPrompt, provider)
  return { readable_steps: Array.isArray(raw['readable_steps']) ? raw['readable_steps'] as string[] : [] }
}

// ══════════════════════════════════════════════════════════════════════
// PUBLIC API — enqueueForExecution
// ══════════════════════════════════════════════════════════════════════

/**
 * Enqueue a generated test script to the execution queue.
 * Called after generation when auto-run is enabled on a project.
 * Job type matches SKILL.md ExecutionJob contract.
 */
export async function enqueueForExecution(job: ExecutionJob): Promise<string> {
  const queued = await executionQueue.add('run-test', job, {
    attempts: 3,
    backoff:  { type: 'exponential', delay: 2000 },
  })
  log.info(`[GEN] Enqueued job ${queued.id} for testCase ${job.testCaseId}`)
  return queued.id ?? 'unknown'
}
