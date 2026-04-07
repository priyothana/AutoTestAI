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
  getPageLayoutFields,
  getRecordTypes,
  queryLookupSamples,
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
- ASSERT_TOAST
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
  "action": "NAVIGATE | CLICK | TYPE | ASSERT_TEXT | ASSERT_TOAST | WAIT",
  "target": "locator expression (required except NAVIGATE, WAIT, and ASSERT_TOAST)",
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

For NAVIGATE, WAIT, and ASSERT_TOAST actions, locator_type is not needed.

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

6. ASSERT_TOAST
   - Use this to verify success/error notifications (toasts, snackbars) that appear after saving, submitting, or taking an action.
   - NO target or locator_type is needed.
   - value must be the expected visible text in the toast message.
   - Example: { "action": "ASSERT_TOAST", "target": "", "value": "Successfully saved account" }

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
7. For standard record actions (Edit, Delete, Clone, etc.), assume they are directly visible on the page layout. Target them directly instead of clicking "Show more actions" first.

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
- DO NOT EVER invent, guess, or hallucinate fields — use ONLY fields listed in the FIELD MANIFEST below
- DO NOT assume picklist values — use ONLY values from the FIELD MANIFEST
- DO NOT use Salesforce API field names (e.g. "Designation__c") as locator targets — use the field LABEL
- DO NOT use fragile CSS selectors like button[title='...'] — use getByRole instead
- Every step must be executable by the Playwright runner
- ALWAYS use accessibility-based locators (see Locator Priority below)
- For standard record actions (Edit, Delete, Clone, Submit for Approval), assume they are directly visible on the page layout. Target them directly (e.g. role=button, name=Edit). DO NOT generate steps to click "Show more actions" first.

-------------------------
RECORD TYPE SELECTION (CRITICAL — READ BEFORE GENERATING CREATE STEPS)
-------------------------
If a RECORD TYPE MANIFEST is present in the metadata context below, the object has MULTIPLE record types.
In Salesforce Lightning, when an object has multiple record types, clicking "New" opens a record type
selection dialog BEFORE the create form. You MUST model this dialog in your test steps.

The MANDATORY create flow when a RECORD TYPE MANIFEST exists:
  Step 1: NAVIGATE  → /lightning/o/{ObjectApiName}/list   ⚠️ USE THE LIST VIEW URL — NOT /new
            Reason: navigating directly to /new may auto-select the user's default record type
            and skip the selection dialog entirely. The list view + New button ALWAYS shows the dialog.
  Step 2: CLICK     → role=button, name=New          (opens the record type selection modal)
  Step 3: SELECT_RECORD_TYPE → target = EXACT record type Name from the manifest
  Step 4: CLICK     → role=button, name=Next         (submits the dialog, opens the create form)
  Step 5+: TYPE/SELECT fields on the actual create form
  Last-1: CLICK     → role=button, name=Save
  Last:   ASSERT_TOAST → value = "was created"

Rules for SELECT_RECORD_TYPE:
- COPY the Name EXACTLY as it appears in the RECORD TYPE MANIFEST — preserve all capitalisation.
  WRONG: "DAMAGE" or "damage" — CORRECT: "Damage" (if the manifest shows "Damage")
- The target field is CASE-SENSITIVE. Do NOT convert to ALLCAPS, lowercase, or change any letter.
- If the test prompt names a specific record type (e.g. "of type Damage"), match it against the manifest
  and use the manifest Name (not the user's wording).
- If no record type is mentioned, use the FIRST non-master record type Name from the manifest.
- NEVER use the developerName as the target — always use Name.

Step format for SELECT_RECORD_TYPE:
{
  "id": "3",
  "action": "SELECT_RECORD_TYPE",
  "target": "Electronics",
  "value": "",
  "locator_type": "label"
}

IF NO RECORD TYPE MANIFEST IS PRESENT: skip steps 2–4 above. Navigate directly and fill fields.

-------------------------
FIELD MANIFEST RULES (MOST IMPORTANT)
-------------------------
DEFAULT BEHAVIOR: Generate steps for [REQUIRED] fields ONLY.

Rules:
1. ALWAYS include every field marked [REQUIRED] in SECTION 1 — the test WILL FAIL without them.
   This includes required LOOKUP fields — generate a LOOKUP action with a realistic search term.
2. EXCEPTION: Skip fields that are always auto-filled by Salesforce regardless of layout:
   OwnerId (Owner), RecordTypeId, MasterRecordId. These are never interactive form fields.
3. CRITICAL: Fields listed under AUTO-EXCLUDED in the manifest are auto-generated by Salesforce.
   Do NOT generate steps for them under ANY circumstances — not even if named in the prompt.
   Examples: "Record Number", "Inventory Number", "Case Number", "Order Number" — these look
   like user inputs but are auto-filled and the form field is read-only or non-existent.
4. For OPTIONAL fields in SECTION 2: include ONLY if the field's label or API name is explicitly
   named in the user's test prompt. When in doubt, OMIT the field.
5. NEVER generate steps for fields NOT present in the manifest below — do NOT invent field names.
   If you cannot find an obvious field label in the manifest, SKIP that step entirely.
6. NEVER generate more than 1 step per field.

Field action mapping (MUST include sf_field_type for SF fields):
- picklist field        → action: SELECT   | sf_field_type: "picklist"  | target = field locator target (see FIELD MANIFEST) | value = one of the listed values
- dependent picklist    → action: SELECT   | sf_field_type: "dependent_picklist" | target = field locator target | value = one of the listed values
- lookup/reference      → action: LOOKUP   | sf_field_type: "lookup"   | target = field locator target | value = a realistic search term
- text/phone/email/url  → action: TYPE     | target = field locator target | value = realistic test data
- checkbox              → action: CHECKBOX | target = field locator target | value = "true" or "false"
- date                  → action: TYPE     | sf_field_type: "date"     | target = field locator target | value = MM/DD/YYYY format
- textarea              → action: TYPE     | target = field locator target | value = realistic text

CRITICAL LOCATOR TARGET RULE:
- For every field in the FIELD MANIFEST, use the value shown after 'USE ... as locator target' if present.
- For standard Salesforce fields (no __c suffix): the locator target is the apiName (e.g. 'Phone', 'Email', 'Title')
- For custom fields (__c suffix): the locator target is the uiLabel shown in the manifest.
- NEVER use 'Business Phone', 'Mobile Phone', or other metadata label variants that differ from what SF Lightning renders. Use the apiName for standard fields.

-------------------------
SALESFORCE ORG METADATA
-------------------------
{rag_context}

-------------------------
LOCATOR PRIORITY (MUST FOLLOW)
-------------------------
1. For buttons/links: target = "role=button, name=New" | locator_type = "role"
2. For form fields:   target = "Field Label" (the LABEL, not API name) | locator_type = "label"
3. For text clicks:   target = "Visible Text" | locator_type = "text"
4. CSS selectors:     FALLBACK ONLY for toast/structural elements

-------------------------
SUPPORTED ACTIONS
-------------------------
- NAVIGATE — value = relative URL path ("/lightning/o/Account/new")
- CLICK — target = role locator or label
- TYPE — target = field LABEL, value = text to type
- SELECT — target = field LABEL, value = picklist option to select
- LOOKUP — target = field LABEL, value = search text
- CHECKBOX — target = field LABEL, value = "true" or "false"
- SELECT_RECORD_TYPE — target = exact record type name, value = "" (use ONLY when RECORD TYPE MANIFEST is present)
- ASSERT_TEXT — target = locator, value = expected text
- ASSERT_TOAST — target = empty, value = expected text in toast (Use this to verify success/error messages after saving/submitting)
- WAIT — value = seconds as string

-------------------------
SALESFORCE LIGHTNING URL PATTERNS
-------------------------
Object List:    "/lightning/o/{ObjectApiName}/list"
New Record:     "/lightning/o/{ObjectApiName}/new"
Record View:    "/lightning/r/{ObjectApiName}/{RecordId}/view"

⚠ Custom objects ALWAYS use API name with __c suffix: Invoice → Invoice__c

-------------------------
STEP FORMAT (STRICT)
-------------------------
{
  "id": "1",
  "action": "NAVIGATE | CLICK | TYPE | SELECT | LOOKUP | CHECKBOX | SELECT_RECORD_TYPE | ASSERT_TEXT | ASSERT_TOAST | WAIT",
  "target": "Field Label or role locator (required except NAVIGATE/WAIT/ASSERT_TOAST)",
  "value": "url | input value | expected text | wait seconds",
  "locator_type": "role | label | text | css",
  "sf_field_type": "picklist | dependent_picklist | lookup | date (REQUIRED for SELECT/LOOKUP/date TYPE steps — omit for CLICK, NAVIGATE, ASSERT_TEXT, ASSERT_TOAST, WAIT, SELECT_RECORD_TYPE)"
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
ALWAYS use getByRole for buttons and field LABELS for form fields. CSS is FALLBACK ONLY.
NEVER generate steps for fields that are NOT in the FIELD MANIFEST.
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

function filterChunksByObjects(chunks: string[], targetObjs: string[]): string[] {
  const targetLowers = targetObjs.map(t => t.toLowerCase())

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
    
    const matchesAny = targetLowers.some(targetLower => 
      header.includes(targetLower) ||
      lower.substring(0, 300).includes(`object: ${targetLower}`) ||
      lower.substring(0, 300).includes(`fields for ${targetLower}`)
    )

    if (matchesAny) {
      targetMetaChunks.push(c)
    }
  })

  const filtered = [...targetMetaChunks, ...learningChunks]
  return filtered.length > 0 ? filtered : chunks
}

// ── Extract target objects from prompt ───────────────────────────────

function extractTargetObjects(prompt: string): string[] {
  const lower = prompt.toLowerCase()
  const skipWords = new Set(['record', 'entry', 'form', 'item', 'test', 'case', 'step', 'the', 'a', 'an', 'new', 'with', 'for', 'to', 'and', 'convert'])
  
  const targets = new Set<string>();

  const patterns = [
    /\b(?:create|add|convert)\b\s+(?:a\s+)?(?:new\s+)?(\w[\w\s]*?)(?:\s+record|\s+for|\s+with|\s+to|\s*$)/g,
    /\bnew\s+(\w+)(?:\s+(\w+))?/g,
    /\b(\w+)\s+(?:creation|form|page|layout|list|conversion)\b/g,
  ]

  for (const pattern of patterns) {
    for (const match of lower.matchAll(pattern)) {
      const word = match[1]?.trim()
      if (word && !skipWords.has(word)) {
        targets.add(word);
      }
    }
  }

  // Common Salesforce objects that might be mentioned explicitly
  const standardObjects = ['lead', 'account', 'contact', 'opportunity', 'case', 'task', 'event', 'campaign', 'quote', 'contract', 'order'];
  for (const obj of standardObjects) {
    const regex = new RegExp(`\\b${obj}\\b`, 'i');
    if (regex.test(lower)) {
      targets.add(obj.charAt(0).toUpperCase() + obj.slice(1));
    }
  }

  // Any custom object mentioned (ends with __c)
  const customObjRegex = /\b(\w+__c)\b/gi;
  for (const match of lower.matchAll(customObjRegex)) {
    if (match[1]) targets.add(match[1]);
  }

  const formattedTargets = Array.from(targets).map(t => {
    if (t.toLowerCase().endsWith('__c')) return t; // preserve casing
    return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase(); // TitleCase
  });

  return Array.from(new Set(formattedTargets));
}

// ── Resolve object API name with __c suffix fallback ─────────────────

/**
 * Resolves a candidate object name (e.g. 'Inventory') to its full Salesforce
 * API name (e.g. 'Inventory__c') by trying multiple strategies:
 *   1. Exact name (standard objects: Account, Contact, ...)
 *   2. Name + '__c' suffix (most custom objects)
 *   3. DB metadata_raw_store fuzzy match (case-insensitive LIKE)
 *
 * Returns null if no matching metadata can be found.
 */
async function resolveObjectMetadata(
  projectId: string,
  candidateName: string,
): Promise<{ object_name: string; label: string | null; metadata: Record<string, unknown> } | null> {
  // Strategy 1: exact name (standard SF objects like Account, Contact)
  const exactMeta = await getObjectMetadata(projectId, candidateName).catch(() => null)
  if (exactMeta?.metadata) {
    log.info(`[GEN] Resolved object "${candidateName}" → exact match`)
    return exactMeta
  }

  // Strategy 2: name + '__c' (most custom objects)
  if (!candidateName.toLowerCase().endsWith('__c')) {
    const withSuffix = `${candidateName}__c`
    const suffixMeta = await getObjectMetadata(projectId, withSuffix).catch(() => null)
    if (suffixMeta?.metadata) {
      log.info(`[GEN] Resolved object "${candidateName}" → "${withSuffix}" (custom object)`)
      return suffixMeta
    }
  }

  // Strategy 3: DB fuzzy match — search metadata_raw_store for a custom object
  // whose api_name (case-insensitive) matches the candidate
  try {
    const candidateLower = candidateName.toLowerCase()
    const candidateWithSuffix = candidateLower + '__c'
    const dbRows = await prisma.metadata_raw_store.findMany({
      where: {
        project_id: projectId,
        metadata_type: 'object',
      },
      select: { api_name: true, raw_json: true },
    })

    const matched = dbRows.find(r => {
      const name = r.api_name.toLowerCase()
      return name === candidateLower || name === candidateWithSuffix
    })

    if (matched) {
      log.info(`[GEN] Resolved object "${candidateName}" → DB match "${matched.api_name}"`)
      const rawMeta = await getObjectMetadata(projectId, matched.api_name).catch(() => null)
      if (rawMeta?.metadata) return rawMeta

      // Return a minimal shape from DB raw_json if live fetch also fails
      const rawJson = (matched.raw_json ?? {}) as Record<string, unknown>
      return {
        object_name: matched.api_name,
        label: (rawJson['label'] as string) ?? matched.api_name,
        metadata: rawJson,
      }
    }
  } catch { /* DB fallback non-critical */ }

  log.warn(`[GEN] Could not resolve object metadata for "${candidateName}" (tried exact, __c, DB)`)
  return null
}

// ── Build record type manifest for LLM ─────────────────────────────

interface RecordTypeEntry {
  name: string
  developerName: string
  available: boolean
  master: boolean
}

/**
 * Returns a human-readable RECORD TYPE MANIFEST block when an object has
 * more than one available, non-master record type.
 * Returns an empty string if the object uses only the master record type.
 */
function buildRecordTypeManifest(
  objectName: string,
  recordTypes: RecordTypeEntry[],
): string {
  // Filter to only available, non-master record types
  const available = recordTypes.filter(rt => rt.available && !rt.master)
  if (available.length <= 1) return '' // single RT → no dialog shown by SF

  const lines: string[] = [
    `=== RECORD TYPE MANIFEST for ${objectName} ===`,
    `This object has ${available.length} record types. In Salesforce Lightning, clicking "New" will`,
    `open a Record Type Selection dialog BEFORE the create form. You MUST include a SELECT_RECORD_TYPE step.`,
    '',
    'Available Record Types (use exact Name in SELECT_RECORD_TYPE target):',
  ]

  available.forEach((rt, idx) => {
    lines.push(`  ${idx + 1}. ${rt.name}  (developerName: ${rt.developerName})`)
  })

  lines.push('')
  lines.push(`DEFAULT: If the test prompt does not specify a record type, use "${available[0].name}" (the first listed above).`)
  lines.push('=== END RECORD TYPE MANIFEST ===')
  return lines.join('\n')
}

// ── Detect which record type the user is requesting ────────────────────

/**
 * Scans the user's prompt to see if it mentions one of the available record type
 * names or developer names (case-insensitive). Returns the matching record type
 * Name, or the first available non-master RT name as a default.
 *
 * This is used to select the correct page layout for the field manifest so the
 * LLM only sees fields that belong to the chosen record type's layout.
 */
function extractRequestedRecordType(
  prompt: string,
  recordTypes: RecordTypeEntry[],
): string {
  const available = recordTypes.filter(rt => rt.available && !rt.master)
  if (available.length === 0) return ''

  const promptLower = prompt.toLowerCase()
  for (const rt of available) {
    if (
      promptLower.includes(rt.name.toLowerCase()) ||
      promptLower.includes(rt.developerName.toLowerCase().replace(/_/g, ' '))
    ) {
      return rt.name
    }
  }

  // Default: first available non-master RT
  return available[0].name
}

// ── Fetch real lookup values from the org ────────────────────────────

/**
 * For each reference (lookup) field in the object metadata that also appears
 * in the layout, query up to `limit` real record Names from the referenced
 * object. Returns a Map<fieldApiName, string[]> for use in buildFieldManifest.
 *
 * This ensures the LLM generates steps with values that actually exist in the
 * org (e.g. a real SKU name, a real warehouse name) instead of fictional ones.
 */
async function fetchLookupSamplesForManifest(
  projectId: string,
  metadata: Record<string, unknown>,
  layoutFieldNames: Set<string> | null | undefined,
  limit = 5,
): Promise<Map<string, string[]>> {
  const samples = new Map<string, string[]>()
  const fields = (metadata['fields'] ?? []) as Record<string, unknown>[]

  const lookupFields = fields.filter(f => {
    if (String(f['type'] ?? '') !== 'reference') return false
    if (!Boolean(f['createable'])) return false
    const apiName = String(f['name'] ?? '')
    if (!layoutFieldNames || layoutFieldNames.has(apiName)) return true  // on layout
    return false
  })

  // Parallel queries — fire all, ignore failures
  await Promise.all(
    lookupFields.map(async (f) => {
      const apiName = String(f['name'] ?? '')
      const refs = (f['referenceTo'] as string[] | undefined) ?? []
      if (refs.length === 0) return

      const refObject = refs[0]  // typically one referenced object
      try {
        const names = await queryLookupSamples(projectId, refObject, 'Name', limit)
        if (names.length > 0) {
          samples.set(apiName, names)
          log.info(`[GEN] Lookup samples for ${apiName} (${refObject}): ${names.join(', ')}`)
        }
      } catch { /* non-critical */ }
    })
  )

  return samples
}

// ── Build structured field manifest for LLM ──────────────────────────

/**
 * Builds a human-readable "field manifest" from Salesforce describe metadata.
 * Only includes createable, non-system fields that would appear on a create form.
 * Groups fields by required/optional and includes type + picklist values.
 */
function buildFieldManifest(
  metadata: Record<string, unknown>,
  layoutFieldNames?: Set<string> | null,
  userPrompt?: string,
  lookupSamples?: Map<string, string[]>,  // real record names per field API name
): string {
  const fields = (metadata['fields'] ?? []) as Record<string, unknown>[]
  if (fields.length === 0) return ''

  // System fields to always exclude
  const systemFields = new Set([
    'id', 'createddate', 'createdbyid', 'lastmodifieddate', 'lastmodifiedbyid',
    'systemmodstamp', 'isdeleted', 'ownerid', 'lastactivitydate', 'lastvieweddate',
    'lastreferenceddate', 'jigsaw', 'jigsawcompanyid', 'cleanstatus',
    'accountsource', 'dunsnumber', 'naicscode', 'naicsdesc', 'yearstarted',
    'sicdesc', 'masterrecordid',
  ])

  interface FieldInfo {
    label: string
    apiName: string
    type: string
    required: boolean
    picklist: string[]
    referenceTo: string[]
  }

  // Custom-object Name field label patterns that indicate auto-generated identifiers:
  // 'Record Number', 'Inventory Number', 'Case Number', 'Order Number', etc.
  // These fields appear on layouts as display-only even when behavior='Edit' because
  // they're auto-populated by Salesforce triggers/automation. Never generate steps for them.
  const AUTO_IDENTIFIER_LABEL_REGEX = /\b(number|no\.|no\b|#|reference|ref\.|ref\b|identifier|id\b)\b/i

  // Detect if this is a custom object (has any __c field in the list)
  const isCustomObject = fields.some(f => String(f['name'] ?? '').endsWith('__c'))

  // Fields explicitly excluded and reported to LLM so it cannot hallucinate them
  const excludedAutoFields: string[] = []

  const createableFields: FieldInfo[] = []

  for (const f of fields) {
    const apiName = String(f['name'] ?? '').toLowerCase()
    const createable = Boolean(f['createable'])
    const custom = Boolean(f['custom'])
    const calculated = Boolean(f['calculated'])
    const autoNumber = Boolean(f['autoNumber'])
    const label = String(f['label'] ?? f['name'] ?? '')

    // Skip non-createable, system, calculated, and auto-number fields
    if (!createable) { excludedAutoFields.push(label); continue }
    if (calculated || autoNumber) { excludedAutoFields.push(label); continue }
    if (systemFields.has(apiName)) continue

    // Skip compound address sub-fields
    if (/^(billing|shipping|mailing|other)(street|city|state|postalcode|country|geocode|latitude|longitude)$/i.test(apiName)) continue

    // On custom objects, the standard 'Name' field (apiName === 'name', non-custom) is
    // frequently an auto-generated record identifier (filled by automation, even if
    // createable=true). Detect by checking if the label matches common identifier patterns.
    if (isCustomObject && !custom && apiName === 'name' && AUTO_IDENTIFIER_LABEL_REGEX.test(label)) {
      excludedAutoFields.push(label)
      continue
    }

    // If page layout fields are known, skip fields not on the layout
    if (layoutFieldNames && layoutFieldNames.size > 0) {
      const rawName = String(f['name'] ?? '')
      if (!layoutFieldNames.has(rawName)) continue
    }

    const type = String(f['type'] ?? 'string').toLowerCase()

    // Lookup/reference fields: respect their actual nillable setting UNLESS
    // they are well-known auto-filled system lookups (Owner, RecordType, etc.)
    // that SF populates automatically and never appear as editable form fields.
    // Previously ALL lookups were forced to optional — but now that the field
    // list is filtered to the RT-specific page layout, any lookup that survived
    // IS on the form and must be included if nillable=false.
    const AUTO_FILLED_LOOKUPS = new Set([
      'ownerid', 'recordtypeid', 'masterrecordid', 'parentid',
    ])
    const isAutoFilledLookup = type === 'reference' && AUTO_FILLED_LOOKUPS.has(apiName)
    const required = !isAutoFilledLookup && !Boolean(f['nillable']) && !Boolean(f['defaultedOnCreate'])

    // Picklist values (only active ones)
    let picklist: string[] = []
    if (type === 'picklist' || type === 'multipicklist') {
      const plv = (f['picklistValues'] ?? []) as Record<string, unknown>[]
      picklist = plv
        .filter(v => Boolean(v['active']))
        .map(v => String(v['label'] ?? v['value'] ?? ''))
        .filter(Boolean)
    }

    // Reference targets (lookups)
    let referenceTo: string[] = []
    if (type === 'reference') {
      const refs = f['referenceTo']
      if (Array.isArray(refs)) referenceTo = refs.map(String)
    }

    createableFields.push({
      label,
      apiName: String(f['name'] ?? ''),
      type,
      required,
      picklist,
      referenceTo,
    })
  }

  if (createableFields.length === 0) return ''

  // Sort: required first, then alphabetical by label
  createableFields.sort((a, b) => {
    if (a.required && !b.required) return -1
    if (!a.required && b.required) return 1
    return a.label.localeCompare(b.label)
  })

  const requiredFields = createableFields.filter(f => f.required)

  // For optional fields: if the user prompt is provided, only show fields
  // whose label appears in the prompt. This pre-filters Section 2 so the LLM
  // doesn't have to decide — it only sees what the user actually asked for.
  const promptLower = (userPrompt ?? '').toLowerCase()
  
  // Strip out quotes to prevent field values from accidentally triggering label matches 
  // e.g. 'Bill To as "Sample Account 25"' won't accidentally match the "Account" field
  const promptWithoutQuotes = promptLower.replace(/"[^"]*"/g, ' ').replace(/'[^']*'/g, ' ')

  const optionalFields = createableFields.filter(f => {
    if (f.required) return false
    if (!promptLower) return true  // no prompt filtering if not provided
    
    const labelLower = f.label.toLowerCase()
    const apiNameLower = f.apiName.toLowerCase().replace(/__c$/i, '').replace(/_/g, ' ')
    
    // Highly preferred: Exact label match in the unquoted portion of the prompt (e.g. "bill to")
    if (promptWithoutQuotes.includes(labelLower)) return true

    // Also match by API name (e.g. prompt says "Phone" and apiName is "Phone")
    // This handles standard fields where metadata label (e.g. "Business Phone") differs from
    // the actual UI label (the API name: "Phone")
    if (promptWithoutQuotes.includes(apiNameLower)) return true
    
    // Backup: Any significant word (>= 5 chars) from the label appears in the unquoted prompt
    // e.g. "opportunity" matching "Opportunity ID"
    if (labelLower.split(/\s+/).some(word => word.length >= 5 && promptWithoutQuotes.includes(word))) {
      return true
    }

    return false
  })

  const renderField = (f: FieldInfo): string => {
    // For standard fields (no __c suffix) the SF Lightning UI renders the field
    // using the API name (e.g. 'Phone'), NOT the metadata label (e.g. 'Business Phone').
    // Always expose both so the LLM can pick the correct locator target.
    const isCustom = f.apiName.endsWith('__c') || f.apiName.endsWith('__C')
    const locatorHint = isCustom
      ? `apiName: ${f.apiName} | uiLabel: ${f.label}`
      : `apiName: ${f.apiName} | uiLabel: ${f.label} | USE '${f.apiName}' as locator target (standard field)`
    let desc = `• ${f.label} [${locatorHint}] — type: ${f.type}`
    if (f.picklist.length > 0) desc += ` | values: [${f.picklist.join(', ')}]`
    if (f.referenceTo.length > 0) {
      desc += ` | lookup to: ${f.referenceTo.join(', ')}`
      // Inject REAL record names queried from the org so the LLM picks a valid value
      const samples = lookupSamples?.get(f.apiName) ?? []
      if (samples.length > 0) {
        desc += ` | ⚡ REAL VALUES FROM ORG — use one of: [${samples.map(s => `"${s}"`).join(', ')}]`
      }
    }
    return desc
  }


  const lines: string[] = [
    '=== FIELD MANIFEST (Create Form) ===',
    '',
    '--- SECTION 1: REQUIRED FIELDS (ALWAYS generate steps for ALL of these) ---',
  ]

  if (requiredFields.length > 0) {
    requiredFields.forEach(f => lines.push(renderField(f)))
  } else {
    lines.push('(none — object has no required fields)')
  }

  lines.push('')
  lines.push('--- SECTION 2: OPTIONAL FIELDS (generate ONLY if explicitly named in the test prompt) ---')

  if (optionalFields.length > 0) {
    optionalFields.forEach(f => lines.push(renderField(f)))
  } else {
    lines.push('(none)')
  }

  lines.push('')
  lines.push('=== END FIELD MANIFEST ===')
  return lines.join('\n')
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
        const targetObjs = extractTargetObjects(prompt)
        if (targetObjs.length > 0) {
          chunks = filterChunksByObjects(chunks, targetObjs)
          log.info(`[GEN] Strict object filter: targets='${targetObjs.join(', ')}', kept ${chunks.length} chunks`)
        }

        let ragContext = buildRagContext(chunks)

        // Supplemental: structured field manifest + record type manifest from salesforce.service.ts
        try {
          if (project_id && targetObjs.length > 0) {
            for (const targetObj of targetObjs) {
              // Resolve API name: 'Inventory' → 'Inventory__c' etc.
              const sfMeta = await resolveObjectMetadata(project_id, targetObj)
              if (sfMeta?.metadata) {
                // ── Record type manifest (inject BEFORE field manifest) ──────
                // When an object has multiple record types, SF shows a selection
                // dialog before the create form. Inject the manifest so the LLM
                // generates a SELECT_RECORD_TYPE step.
                let selectedRTName = ''
                try {
                  const recordTypes = await getRecordTypes(project_id, sfMeta.object_name)
                  const rtManifest = buildRecordTypeManifest(sfMeta.object_name, recordTypes)
                  if (rtManifest) {
                    ragContext = rtManifest + '\n\n' + ragContext
                    selectedRTName = extractRequestedRecordType(prompt, recordTypes)
                    log.info(`[GEN] RT manifest injected for ${sfMeta.object_name}, selected RT: "${selectedRTName}"`)
                  }
                } catch {
                  log.info(`[GEN] Could not fetch record types for ${sfMeta.object_name} — skipping RT manifest`)
                }

                // ── Page layout fields filter ───────────────────────────────
                // Use the RT-specific layout so only the 3 (or N) fields for the
                // selected record type are shown — not all 30+ from every RT layout.
                const layoutFields = await getPageLayoutFields(
                    project_id,
                    sfMeta.object_name,
                    selectedRTName || undefined,
                  ).catch(() => null)
                if (layoutFields) {
                  log.info(`[GEN] Page layout fetched: ${layoutFields.size} fields for ${sfMeta.object_name}`)
                } else {
                  log.info(`[GEN] No page layout data — using all createable schema fields`)
                }

                // Build the field manifest filtered to layout fields + user prompt,
                // injecting REAL lookup values queried from the org.
                const lookupSamples = await fetchLookupSamplesForManifest(
                  project_id, sfMeta.metadata, layoutFields
                ).catch(() => new Map<string, string[]>())
                const manifest = buildFieldManifest(sfMeta.metadata, layoutFields, prompt, lookupSamples)
                if (manifest) {
                  ragContext += `\n\n=== Field Manifest for ${sfMeta.object_name} ===\n` + manifest
                  log.info(`[GEN] Injected field manifest for ${targetObj}`)
                }

                // Also add the object name and label
                ragContext += `\n\nObject API Name: ${sfMeta.object_name} | Label: ${sfMeta.label ?? sfMeta.object_name}`
              }
            }
          }
        } catch {
          // non-critical salesforce metadata enrichment
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

  const userPromptBase = prompt + sessionInstruction

  // Build Salesforce metadata context (RT manifest + field manifest) into a
  // SEPARATE variable so we can choose the right system prompt below.
  // KEY INSIGHT: we must NOT mix this into the user message and use STANDARD_SYSTEM_PROMPT
  // because that prompt has no concept of SELECT_RECORD_TYPE. Instead, when SF context
  // exists, we use MCP_RAG_SYSTEM_PROMPT (which fully explains record type selection)
  // with sfRagContext substituted into {rag_context}.
  let sfRagContext = ''

  if (project_id && sessionInstruction.includes('Salesforce')) {
    try {
      const targetObjs = extractTargetObjects(prompt)
      if (targetObjs.length > 0) {
        for (const targetObj of targetObjs) {
            // Resolve API name: 'Inventory' → 'Inventory__c' etc.
            const sfMeta = await resolveObjectMetadata(project_id, targetObj)
            if (sfMeta?.metadata) {

              // ── Record type manifest FIRST (prepend) ─────────────────
              // When an object has multiple record types, SF shows a record type
              // selection dialog BEFORE the create form. The manifest tells the LLM
              // it must generate a SELECT_RECORD_TYPE step.
              let selectedRTName = ''
              try {
                const recordTypes = await getRecordTypes(project_id, sfMeta.object_name)
                const rtManifest = buildRecordTypeManifest(sfMeta.object_name, recordTypes)
                if (rtManifest) {
                  sfRagContext = rtManifest + '\n\n' + sfRagContext
                  selectedRTName = extractRequestedRecordType(prompt, recordTypes)
                  log.info(`[GEN] Standard path: RT manifest for ${sfMeta.object_name}, selected RT: "${selectedRTName}"`)
                }
              } catch { /* non-critical */ }

              // ── Field manifest ───────────────────────────────────────
              // Use RT-specific layout so only the N fields for the selected
              // record type appear — not all fields from every RT layout.
              const layoutFields = await getPageLayoutFields(
                project_id,
                sfMeta.object_name,
                selectedRTName || undefined,
              ).catch(() => null)
              // Build field manifest with REAL lookup values from the org
              const lookupSamples = await fetchLookupSamplesForManifest(
                project_id, sfMeta.metadata, layoutFields
              ).catch(() => new Map<string, string[]>())
              const manifest = buildFieldManifest(sfMeta.metadata, layoutFields, prompt, lookupSamples)
              if (manifest) {
                sfRagContext += `\n\n=== Field Manifest for ${sfMeta.object_name} ===\n` + manifest
                log.info(`[GEN] Standard path: field manifest injected for ${targetObj}`)
              }

              sfRagContext += `\n\nObject API Name: ${sfMeta.object_name} | Label: ${sfMeta.label ?? sfMeta.object_name}`
            }
        }
      }
    } catch { /* non-critical */ }
  }

  // Choose the system prompt:
  //  • SF metadata found → MCP_RAG_SYSTEM_PROMPT (understands SELECT_RECORD_TYPE, field types, etc.)
  //  • No SF metadata    → STANDARD_SYSTEM_PROMPT (generic web app testing)
  const finalSystemPrompt = sfRagContext
    ? MCP_RAG_SYSTEM_PROMPT.replace('{rag_context}', sfRagContext)
    : STANDARD_SYSTEM_PROMPT

  const finalUserPrompt = sfRagContext
    ? prompt  // context is now in the system prompt via {rag_context}
    : userPromptBase

  log.info(`[GEN] Standard path: using ${sfRagContext ? 'MCP_RAG_SYSTEM_PROMPT (SF metadata found)' : 'STANDARD_SYSTEM_PROMPT'}`)

  try {
    const rawResult = await invokeLlm(finalSystemPrompt, finalUserPrompt, provider, model)
    return normaliseResponse(rawResult)
  } catch (err: unknown) {
    // Auto-fallback to Claude if requested provider fails
    const providerLower = provider.toLowerCase()
    if (providerLower !== 'claude') {
      log.warn({ err }, '[GEN] Primary provider failed — falling back to Claude')
      try {
        const rawResult = await invokeLlm(finalSystemPrompt, finalUserPrompt, 'claude', undefined)
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
   - ASSERT_TOAST → "Verify that success/error toast message contains '[text]'"
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
