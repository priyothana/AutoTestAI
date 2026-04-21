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
  type LayoutFieldResult,
} from '../salesforce/salesforce.service.js'

import type { GenerateRequest, GenerateResponse, Step } from './generation.schema.js'
import {
  getTestData,
  buildTestDataContext,
  getEntityUrlMap,
  type EntityUrlInfo,
} from '../webapp/webapp-test-data.service.js'

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
- DO NOT assume picklist values — use ONLY values from the FIELD MANIFEST. If the user explicitly asks for an invalid value (e.g. "Tara"), IGNORE IT and use a valid value from the list!
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
A FIELD MANIFEST is injected below in the metadata context. It lists every field on the create/edit form.
Each field is tagged [REQUIRED] or [OPTIONAL].

Rules:
1. ALWAYS generate a step for EVERY field tagged [REQUIRED] — the test WILL FAIL without them.
   This applies to ALL [REQUIRED] fields including lookup fields (generate a LOOKUP action).
2. For [OPTIONAL] fields: generate a step ONLY if the field's label or API name is explicitly
   named in the user's test prompt. When in doubt, OMIT optional fields.
3. EXCEPTION: Never generate steps for fields tagged [AUTO-EXCLUDED] — they are auto-filled
   by Salesforce and have no interactive form element (e.g. Record Number, Order Number, Owner).
4. STRICT ANTI-HALLUCINATION RULE FOR FIELDS:
   - NEVER generate a step for a field that is NOT EXPLICITLY LISTED in the manifest.
   - If the user's prompt names a field that doesn't exist (e.g. "First Name" and "Last Name"), but the manifest has a combined field (e.g. "Account Name"), you MUST adapt to the manifest. Do NOT invent "First Name" or "Last Name" fields.
   - NEVER split one logical value across multiple hallucinated fields. Always use the EXACT locator string provided in the manifest.
5. NEVER generate more than 1 step per field.

Field action mapping (MUST include sf_field_type for SF fields):
- picklist field        → action: SELECT   | sf_field_type: "picklist"  | target = field locator target | value = one of the listed values. NEVER use a value not in the list even if explicitly requested!
- dependent picklist    → action: SELECT   | sf_field_type: "dependent_picklist" | target = field locator target | value = one of the listed values. NEVER use a value not in the list!
- lookup/reference      → action: LOOKUP   | sf_field_type: "lookup"   | target = field locator target | value = a realistic search term
- text/phone/email/url  → action: TYPE     | target = field locator target | value = realistic test data
- checkbox              → action: CHECKBOX | target = field locator target | value = "true" or "false"
- date                  → action: TYPE     | sf_field_type: "date"     | target = field locator target | value = MM/DD/YYYY format
- textarea              → action: TYPE     | target = field locator target | value = realistic text

CRITICAL LOCATOR TARGET RULE:
- ALWAYS use the uiLabel shown in the FIELD MANIFEST as the locator target for form fields.
  The uiLabel is exactly how the field appears on the Salesforce Lightning page.
- For lookup/reference fields: use the uiLabel (e.g. 'COMPANY NAME' not 'AccountId').
- NEVER invent field labels — copy the exact uiLabel from the manifest.
- NEVER use API names (like 'AccountId', 'Email') as locator targets — they do NOT
  match the page labels in orgs with custom field labels.

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

// ─── Web App RAG System Prompt ────────────────────────────────────────────────
// Used when generating tests for web_app projects that have crawled metadata
// embeddings. Unlike the Salesforce prompt, this one is generic and understands
// CRM-style CRUD forms, SPAs, and standard HTML form elements.

const WEB_APP_RAG_SYSTEM_PROMPT = `
You are an expert QA Automation Engineer specialized in Playwright test automation for modern web applications.

This is a METADATA-DRIVEN + REAL-DATA GENERATION MODE.
You have two sources of truth:
  1. APPLICATION METADATA — exact page fields, locators, and buttons from a live crawl
  2. REAL RECORD VALUES   — actual records extracted from the application (OpenAPI, UI scraping, or manual upload)

CRITICAL RULES:
- DO NOT generate login/authentication steps (session is injected automatically)
- DO NOT invent or hallucinate pages, fields, or buttons that are NOT in the metadata
- Use the EXACT locator strings from the metadata — do NOT paraphrase or rename them
- For every TYPE/SELECT step, use a value from REAL RECORD VALUES when one is available
- For SEARCH/VERIFY/UPDATE/DELETE tests, navigate to an existing record using real data not invented data
- NEVER use generic values like "Test Account", "John Doe", "test@example.com" unless the real data confirms them
- For SELECT (dropdown) steps: you MUST use a value from [VALID OPTIONS] listed in the metadata. NEVER invent a picklist value. If no options are listed, OMIT the SELECT step.

-------------------------
APPLICATION METADATA
(Exact pages, fields, locators, and sample values derived from your web application)
-------------------------
{rag_context}

-------------------------
MANDATORY FIELD RULES
-------------------------
1. Fill EVERY field tagged [REQUIRED] — the test WILL FAIL without them.
2. For TYPE fields: use the ⚡ SAMPLE VALUE shown beside each field.
3. For SELECT (dropdown) fields: use the ⚡ USE value shown, which is always from [VALID OPTIONS].
   - NEVER use a value that is NOT in the [VALID OPTIONS] list — the test WILL FAIL with an invalid option.
   - If the user explicitly asks you to select a specific value (e.g. "Tara") but it is NOT listed in [VALID OPTIONS], you MUST IGNORE the user's value and use one of the values from [VALID OPTIONS] instead. DO NOT HALLUCINATE OR BLINDLY TRUST THE USER.
4. For optional fields: add a step ONLY if the field is mentioned in the test prompt.
5. STRICT ANTI-HALLUCINATION RULE FOR FIELDS:
   - NEVER generate a step for a field that is NOT EXPLICITLY LISTED in the metadata.
   - If the user's prompt names a field that doesn't exist (e.g. "First Name" and "Last Name"), but the metadata has a combined field (e.g. "Account Name"), you MUST adapt to the metadata. Do NOT invent "First Name" or "Last Name" fields.
   - NEVER split one logical value across multiple hallucinated fields. Always use the EXACT locator string provided in the metadata.
-------------------------
FIELD ACTION MAPPING
-------------------------
tag: input   → action: TYPE    (locator_type: "label" or "placeholder")
tag: select  → action: SELECT  (use the exact option text shown in [VALID OPTIONS])
tag: checkbox→ action: CHECKBOX (value: "true" or "false")
button       → action: CLICK   (locator_type: "role")

⛔ SKIP fields: Any field marked with "⛔ SKIP" in the metadata has NO known valid options in the database.
   - You MUST omit that SELECT step entirely — do NOT generate it even if the user's prompt mentions a value for it.
   - Generating a step with an invented value for a ⛔ SKIP field will cause an immediate test failure.

-------------------------
SUBMIT BUTTON RULES (CRITICAL)
-------------------------
- The "Submit Buttons" section in the metadata lists the EXACT button names available on each page.
- For CLICK steps that submit a form, you MUST use the EXACT locator string from the "Submit Buttons" section.
- NEVER use generic names like "Submit", "Save", or "OK" unless that is the EXACT button name shown in the metadata.
- Example: if metadata shows  locator: "Create Campaign"  locator_type: "role"  — your CLICK step MUST have target: "Create Campaign", locator_type: "role".
- If no Submit Buttons section is present for a page, infer the button name from the page title (e.g. page "New Campaign" → button "Create Campaign").

-------------------------
TEST INTENT INSTRUCTIONS
-------------------------
{test_intent_instructions}

-------------------------
REAL ENTITY RECORDS (SAMPLE VALUES)
(Use these as your source of truth for field values)
-------------------------
{test_data_context}

-------------------------
ASSERTION STRATEGY
-------------------------
- After submitting a CREATE form: ALWAYS use ASSERT_URL with the list page path (e.g. "/accounts"). Do NOT use WAIT steps before ASSERT_URL.
- After a SEARCH/FILTER action: use ASSERT_TEXT to verify a matching record appears
- After UPDATE: use ASSERT_URL to confirm the save succeeded
- After DELETE: use ASSERT_TEXT to confirm the record is no longer listed
- NEVER use ASSERT_TOAST for web applications unless explicitly requested. SPAs naturally redirect after save, making toast interactions brittle and prone to failure. Use ASSERT_URL exclusively for submission success.

-------------------------
WEB APP URL PATTERNS
-------------------------
- For NAVIGATE steps: use the EXACT FULL page path shown in the metadata "--- Page: /path ---" header.
  COPY THE ENTIRE PATH including ALL prefix segments — DO NOT shorten or drop any segment.
  ✅ CORRECT: metadata shows "--- Page: /admin/roles ---"   →  use "/admin/roles"
  ❌ WRONG:   metadata shows "--- Page: /admin/roles ---"   →  DO NOT use "/roles" (drops /admin prefix!)
  ✅ CORRECT: metadata shows "--- Page: /campaigns/new ---" →  use "/campaigns/new"
  ❌ WRONG:   use "/campaigns/create" or "/campaigns/add" when metadata says "/campaigns/new"
- Use relative paths only (e.g. "/admin/roles", "/campaigns/new", "/contacts")
- The Playwright runner automatically prepends the project base URL
- NEVER use absolute URLs or hardcoded domains
- NEVER invent a path that is not listed in the metadata
- NEVER shorten a path — preserve every segment exactly as shown in the metadata

-------------------------
LOCATOR PRIORITY (MUST FOLLOW)
-------------------------
1. label      — getByLabel('Account Name')   → for form inputs
2. role       — getByRole('button', {name: 'Save'}) → for buttons/links
3. placeholder— getByPlaceholder('Search...')→ for search boxes
4. text       — getByText('Create Account')  → for visible text
5. css        — FALLBACK ONLY for toast/structural elements

-------------------------
STEP FORMAT (STRICT)
-------------------------
{
  "id": "1",
  "action": "NAVIGATE | CLICK | TYPE | SELECT | CHECKBOX | ASSERT_TEXT | ASSERT_TOAST | ASSERT_URL | WAIT",
  "target": "Exact locator from metadata (required except NAVIGATE/WAIT/ASSERT_TOAST/ASSERT_URL)",
  "value": "url | REAL value from sample data | expected text | seconds",
  "locator_type": "role | label | text | placeholder | css"
}

-------------------------
MULTI-ENTITY FLOW RULES (when the test spans multiple entities)
-------------------------
If the test case mentions CREATING one entity and then VERIFYING or CREATING another entity
(e.g., "Create Opportunity and verify Invoice creation"):

1. IDENTIFY THE PRIMARY ENTITY — the one being CREATED FIRST (usually the subject of "Create")
2. Start test steps with the PRIMARY entity's create page, NOT the secondary entity
3. Fill all REQUIRED fields for the primary entity using its own field metadata
4. After successfully creating the primary entity, proceed to the secondary entity's flow
5. Each entity phase should use fields and values appropriate to THAT entity ONLY
6. Do NOT mix fields from different entities — Opportunity fields stay in the Opportunity phase

Example: "Create Opportunity for account 'Tara' and verify Invoice creation"
  Phase 1: Navigate to /opportunities → Fill Opportunity fields → Save
  Phase 2: Navigate to /invoices or click "Create Invoice" → Verify invoice flow

{multi_entity_instructions}

-------------------------
FIELD-VALUE TYPE ALIGNMENT (CRITICAL — prevents value shuffling)
-------------------------
Each field's value MUST match its expected data type. NEVER cross-assign values:

• Amount / Currency / Price fields → MUST be NUMERIC (e.g., "50000", "1000.50")
• Date / Close Date / Due Date fields → MUST be DATE format MM/DD/YYYY (e.g., "06/30/2026")
• Probability / Percentage fields → MUST be NUMERIC percentage (e.g., "75", "90")
• Stage / Status fields → MUST be a valid STAGE/STATUS option (e.g., "Prospecting", "Closed Won")
• Account / Contact / Name lookup fields → MUST be ENTITY NAMES (e.g., "Tara", "Acme Corp")

❌ NEVER put a person's name (e.g., "Santhosh Sivan") in an Amount field
❌ NEVER put a date (e.g., "4/29/2026") in a Stage field
❌ NEVER put a stage value (e.g., "CLOSED_WON") in a Date field
❌ NEVER put a numeric value (e.g., "30000") in a Contact Name field

If the scraped data shows a field→value pair that violates these type rules,
IGNORE that value and generate a type-appropriate value instead.

-------------------------
USER-SPECIFIED VALUES (HIGHEST PRIORITY)
-------------------------
When the user explicitly mentions a value in their prompt:
  Example: "for the account 'Tara'" → use "Tara" for the Account field
  Example: "with amount 50000" → use "50000" for the Amount field
These user-specified values ALWAYS take priority over scraped sample data.
{user_specified_values}

-------------------------
OUTPUT FORMAT
-------------------------
{
  "name": "Concise Test Case Name",
  "description": "What is being tested",
  "priority": "low" | "medium" | "high",
  "preconditions": ["User is authenticated"],
  "steps": [...],
  "expected_outcome": "Clear expected result"
}

IMPORTANT: Output ONLY valid JSON. No explanations, no comments, no markdown.
ALWAYS use exact field labels from the metadata. NEVER invent field names.
EVERY [REQUIRED] field MUST have a TYPE/SELECT/CHECKBOX step using a REAL value.
EVERY field value MUST match its expected data type (see FIELD-VALUE TYPE ALIGNMENT above).
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
// NOTE: This filter is Salesforce-oriented (looks for SF object names in chunk headers).
// Web app chunks use "WebApp Page: /path" format — call with isWebApp=true to skip
// the object-name filter and return all chunks unchanged.

function filterChunksByObjects(chunks: string[], targetObjs: string[], isWebApp = false): string[] {
  // For web app projects: chunks are per-page, not per-SF-object.
  // Filtering by object name would incorrectly discard the form field chunks we need.
  // Instead filter by path segment (e.g. 'accounts' matches '/accounts/new').
  if (isWebApp) {
    const targetLowers = targetObjs.map(t => t.toLowerCase())
    // Try path-based filter first
    const pathMatched = chunks.filter(c => {
      const lower = c.toLowerCase()
      return targetLowers.some(t =>
        lower.includes(`/ ${t}`) ||
        lower.includes(`/${t}/`) ||
        lower.includes(`/${t}\n`) ||
        lower.includes(`/${t} `) ||
        // Also match "page: /accounts" patterns
        lower.match(new RegExp(`(?:page:|path:)\\s*/${t}`, 'i'))
      )
    })
    // Return path-matched chunks if found; otherwise return ALL chunks so the LLM
    // can still pick the most relevant ones from the full set.
    return pathMatched.length > 0 ? pathMatched : chunks
  }

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
  layoutResult: LayoutFieldResult | null | undefined,
  limit = 5,
): Promise<Map<string, string[]>> {
  const samples = new Map<string, string[]>()
  const fields = (metadata['fields'] ?? []) as Record<string, unknown>[]
  const layoutFieldNames = layoutResult?.available ?? null

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
export function buildFieldManifest(
  metadata: Record<string, unknown>,
  layoutResult?: LayoutFieldResult | null,
  userPrompt?: string,
  lookupSamples?: Map<string, string[]>,  // real record names per field API name
): string {
  // Extract the two sets from the LayoutFieldResult (backwards-compatible with null/undefined)
  const layoutFieldNames  = layoutResult?.available      ?? null
  const layoutRequiredSet = layoutResult?.layoutRequired ?? new Set<string>()
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

    // If page layout fields are known, skip fields not on the layout.
    // CRITICAL EXCEPTIONS that bypass the layout filter:
    //  1. Schema-required fields (nillable=false or required=true in FieldMetadata)
    //  2. Layout-required fields (behavior=Required on the page layout, even if nillable=true)
    // Both types MUST appear in the manifest so the LLM generates steps for them.
    if (layoutFieldNames && layoutFieldNames.size > 0) {
      const rawName = String(f['name'] ?? '')
      if (!layoutFieldNames.has(rawName)) {
        const hasNillableProp = 'nillable' in f
        const isSchemaRequired = hasNillableProp
          ? (!Boolean(f['nillable']) && !Boolean(f['defaultedOnCreate']))
          : Boolean(f['required'])
        const isLayoutRequired = layoutRequiredSet.has(rawName)
        if (!isSchemaRequired && !isLayoutRequired) continue
      }
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

    // Detect required status from EITHER shape:
    //  • FieldMetadata shape (from describeObject live path): has 'required' boolean (nillable excluded from interface)
    //  • Raw describe shape (from DB fallback / raw_json):    has 'nillable' property explicitly
    // Use 'nillable' in f to distinguish shapes — FieldMetadata does NOT define 'nillable'.
    const hasNillable2 = 'nillable' in f
    const isRequiredBySchema = hasNillable2
      ? (!Boolean(f['nillable']) && !Boolean(f['defaultedOnCreate']))  // raw describe shape
      : Boolean(f['required'])                                          // FieldMetadata shape
    // Promote to required if the page layout explicitly marks this field as Required
    // (behavior=Required) — guards against nillable=true fields that admins enforced.
    const isPromotedByLayout = layoutRequiredSet.has(String(f['name'] ?? ''))
    const required = !isAutoFilledLookup && (isRequiredBySchema || isPromotedByLayout)

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

  // Build a unified field list: all createable fields in one list, tagged [REQUIRED] or [OPTIONAL]
  // This ensures the LLM sees ALL form fields, not just filtered sections.
  // Previously the two-section split caused optional-but-important fields (like Email, AccountId)
  // to be hidden from the LLM unless they appeared in the user's prompt.

  const lines: string[] = [
    '=== FIELD MANIFEST (Create/Edit Form) ===',
    '  [REQUIRED] = must fill or record save will fail',
    '  [OPTIONAL] = fill only if explicitly requested in the test prompt',
    '',
  ]

  // Render a single field as a manifest line
  const renderField = (f: FieldInfo): string => {
    // The locator target is ALWAYS the field label (uiLabel) — this is what Salesforce
    // Lightning renders on the form and what Playwright's getByLabel() matches.
    // Previously we used apiName for standard fields, but orgs can customize labels
    // (e.g. AccountId → "COMPANY NAME", Email → "CONTACT EMAIL ADDRESS"), so apiName
    // wouldn't match the page. Always use the actual label the user sees.
    let desc = `• ${f.label} [apiName: ${f.apiName} | uiLabel: ${f.label} | USE '${f.label}' as locator target] — type: ${f.type}`
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

  if (createableFields.length === 0) {
    lines.push('(no createable fields found)')
  } else {
    createableFields.forEach(f => {
      const tag = f.required ? '[REQUIRED]' : '[OPTIONAL]'
      lines.push(`${tag} ${renderField(f)}`)
    })
  }

  lines.push('')
  lines.push('=== END FIELD MANIFEST ===')
  return lines.join('\n')
}

// ── Post-generation: re-number step IDs ──────────────────────────────

function renumberSteps(steps: Step[]): Step[] {
  return steps.map((s, i) => ({ ...s, id: String(i + 1) }))
}

// ─── Test Intent Classification ──────────────────────────────────────────────
//
// Determines what kind of test is being requested from the natural-language prompt.
// This drives two things:
//   1. What "REAL ENTITY RECORDS" instructions to inject into the prompt
//   2. How buildTestDataContextWithIntent() formats the test data

type TestIntent = 'create' | 'search' | 'update' | 'delete' | 'verify' | 'general'

function classifyTestIntent(prompt: string): TestIntent {
  const p = prompt.toLowerCase()
  if (/\b(create|add|new|insert|register|submit)\b/.test(p)) return 'create'
  if (/\b(delete|remove|archive|deactivate)\b/.test(p))      return 'delete'
  if (/\b(update|edit|modify|change|set)\b/.test(p))         return 'update'
  if (/\b(search|filter|find|look.?up|query|browse)\b/.test(p)) return 'search'
  if (/\b(verify|assert|check|validate|confirm|view)\b/.test(p)) return 'verify'
  return 'general'
}

/**
 * Returns step-by-step LLM instructions tailored to what the test is doing.
 * These are injected into the {test_intent_instructions} placeholder.
 */
function buildIntentInstructions(intent: TestIntent): string {
  switch (intent) {

    case 'create':
      return `TEST TYPE: CREATE (adding a new record)

Step-by-step approach:
1. NAVIGATE to the entity's CREATE page (e.g. /accounts/new, /contacts/create)
2. For each REQUIRED field: generate a TYPE/SELECT/CHECKBOX step using the ⚡ SAMPLE VALUE shown in the metadata
3. For optional fields explicitly mentioned in the test prompt: also add TYPE/SELECT steps
4. CLICK the submit button (use the exact locator from the metadata "Submit Buttons" section)
5. ASSERT_URL to verify the app redirected to the list page (e.g. /accounts) — or ASSERT_TOAST if the page shows a notification

CRITICAL: Use the ⚡ SAMPLE VALUE from metadata for every field value.
Do NOT invent field values. Use the real values from REAL ENTITY RECORDS below.`

    case 'search':
      return `TEST TYPE: SEARCH / FILTER (finding an existing record)

Step-by-step approach:
1. NAVIGATE to the entity's LIST page (e.g. /accounts, /contacts)
2. Locate the search input (use getByPlaceholder('Search...') or getByRole('searchbox'))
3. TYPE the search value — use the FIRST REAL RECORD's primary field (e.g. name) from REAL ENTITY RECORDS below
4. ASSERT_TEXT to confirm the record appears in the results (use the same value you searched for)

CRITICAL: Use a REAL RECORD VALUE as the search term — do NOT search for "Test Account" or invented names.
The record must actually EXIST in the application.`

    case 'verify':
      return `TEST TYPE: VERIFY / VIEW (confirming an existing record's data)

Step-by-step approach:
1. NAVIGATE to the entity's list page or directly to the record if a URL path is known
2. Search for or select the FIRST REAL RECORD from REAL ENTITY RECORDS below
3. ASSERT_TEXT to verify one or more field values match what's in the real data
4. Optionally ASSERT_URL to confirm you are on the correct detail page

CRITICAL: Use values from REAL ENTITY RECORDS — these are actual values stored in the application.`

    case 'update':
      return `TEST TYPE: UPDATE / EDIT (modifying an existing record)

Step-by-step approach:
1. NAVIGATE to the entity's list page or search for a specific record
2. Find the FIRST REAL RECORD from REAL ENTITY RECORDS — search or navigate to it
3. CLICK the Edit button
4. Modify the field(s) mentioned in the test prompt using TYPE/SELECT
5. CLICK Save/Update
6. ASSERT_TEXT or ASSERT_URL to confirm the update succeeded

CRITICAL: Always edit a REAL EXISTING RECORD — use the name/ID from REAL ENTITY RECORDS.
Never navigate to a made-up record path.`

    case 'delete':
      return `TEST TYPE: DELETE (removing an existing record)

Step-by-step approach:
1. NAVIGATE to the entity's list page (e.g. /accounts)
2. Find the FIRST REAL RECORD from REAL ENTITY RECORDS — search for it by name
3. Select or open the record
4. CLICK the Delete/Remove button (confirm in any dialog)
5. ASSERT_TEXT to confirm the record no longer appears (e.g. the deleted name is absent from the list)

CRITICAL: Only delete records that appear in REAL ENTITY RECORDS — never invent record names.`

    default:
      return `TEST TYPE: GENERAL

Use the field metadata and sample values to generate accurate test steps.
For every TYPE/SELECT step, prefer values from REAL ENTITY RECORDS over generic placeholders.`
  }
}

// ─── Multi-Entity Flow Detection ─────────────────────────────────────────────
//
// Detects test cases that span multiple entities, e.g.:
//   "Create a new Opportunity for the account 'Tara' and verify Invoice creation"
// Returns ordered entity phases so the LLM generates steps in the correct sequence.

interface MultiEntityFlow {
  isMultiEntity:    boolean
  primaryEntity:    string   // e.g. "Opportunity" — the entity being CREATED first
  secondaryEntity:  string   // e.g. "Invoice"     — the entity verified/created next
  flowType:         'create_then_verify' | 'create_then_create' | 'single'
}

function detectMultiEntityFlow(prompt: string): MultiEntityFlow {
  const p = prompt.toLowerCase()
  const single: MultiEntityFlow = { isMultiEntity: false, primaryEntity: '', secondaryEntity: '', flowType: 'single' }

  // Pattern: "Create X ... verify/check Y (creation|flow)"
  const createVerify = p.match(
    /(?:create|add|new)\s+(?:a\s+)?(?:new\s+)?(\w+).*?(?:verify|check|validate|confirm).*?(?:the\s+)?(?:flow\s+of\s+)?(\w+)\s+(?:creation|flow|process)/i
  )
  if (createVerify) {
    return {
      isMultiEntity: true,
      primaryEntity:   createVerify[1].charAt(0).toUpperCase() + createVerify[1].slice(1).toLowerCase(),
      secondaryEntity: createVerify[2].charAt(0).toUpperCase() + createVerify[2].slice(1).toLowerCase(),
      flowType: 'create_then_verify',
    }
  }

  // Pattern: "Create X and (then)? create Y"
  const createCreate = p.match(
    /(?:create|add|new)\s+(?:a\s+)?(?:new\s+)?(\w+).*?(?:and|then)\s+(?:create|add|new)\s+(?:a\s+)?(?:new\s+)?(\w+)/i
  )
  if (createCreate) {
    return {
      isMultiEntity: true,
      primaryEntity:   createCreate[1].charAt(0).toUpperCase() + createCreate[1].slice(1).toLowerCase(),
      secondaryEntity: createCreate[2].charAt(0).toUpperCase() + createCreate[2].slice(1).toLowerCase(),
      flowType: 'create_then_create',
    }
  }

  return single
}

// ─── User-Specified Value Extraction ─────────────────────────────────────────
//
// Parses the user's prompt for explicit field-value pairs like:
//   "for the account 'Tara'"         → { field: 'Account', value: 'Tara' }
//   "with amount 50000"              → { field: 'Amount',  value: '50000' }
//   "stage as 'Prospecting'"         → { field: 'Stage',   value: 'Prospecting' }

interface UserSpecifiedValue {
  field: string
  value: string
}

function extractUserSpecifiedValues(prompt: string): UserSpecifiedValue[] {
  const values: UserSpecifiedValue[] = []
  const seen = new Set<string>()

  // Pattern 1: "for the account 'Tara'" / "for account 'Tara'"
  const forPatterns = [
    /(?:for\s+(?:the\s+)?)(account|contact|customer|company|opportunity|lead)\s+['"\u201c]([^'"\u201d]+)['"\u201d]/gi,
    /(account|contact|customer|company|opportunity|lead)\s+(?:named?|called|titled)\s+['"\u201c]([^'"\u201d]+)['"\u201d]/gi,
  ]

  for (const pattern of forPatterns) {
    for (const match of prompt.matchAll(pattern)) {
      const field = match[1]?.trim() ?? ''
      const value = match[2]?.trim() ?? ''
      if (field && value && !seen.has(field.toLowerCase())) {
        seen.add(field.toLowerCase())
        values.push({
          field: field.charAt(0).toUpperCase() + field.slice(1).toLowerCase(),
          value,
        })
      }
    }
  }

  // Pattern 2: Reversed — "'Tara' account"
  const revPattern = /['"\u201c]([^'"\u201d]+)['"\u201d]\s+(account|contact|customer|company|opportunity|lead)/gi
  for (const match of prompt.matchAll(revPattern)) {
    const value = match[1]?.trim() ?? ''
    const field = match[2]?.trim() ?? ''
    if (field && value && !seen.has(field.toLowerCase())) {
      seen.add(field.toLowerCase())
      values.push({
        field: field.charAt(0).toUpperCase() + field.slice(1).toLowerCase(),
        value,
      })
    }
  }

  // Pattern 3: "with amount 50000" / "stage as 'Prospecting'"
  const knownFields = new Map([
    ['amount', 'Amount'], ['stage', 'Stage'], ['status', 'Status'],
    ['probability', 'Probability'], ['close date', 'Close Date'],
    ['currency', 'Currency'], ['type', 'Type'], ['priority', 'Priority'],
  ])

  for (const [keyword, label] of knownFields) {
    if (seen.has(keyword)) continue
    const re = new RegExp(`(?:${keyword})\\s+(?:of|as|to|=|:)?\\s*['"\u201c]?([^'"\u201d,;]+)['"\u201d]?`, 'i')
    const m = prompt.match(re)
    if (m && m[1]?.trim()) {
      seen.add(keyword)
      values.push({ field: label, value: m[1].trim() })
    }
  }

  return values
}

// ─── Field-Value Type Validation Post-Processor ──────────────────────────────
//
// After the LLM generates steps, validates that each step's value is
// type-appropriate for its target field. Fixes detected misalignments by
// swapping values between mismatched fields or using sensible defaults.

function validateFieldValueAlignment(steps: Step[]): Step[] {
  const NUMERIC_FIELDS = /\b(amount|currency|price|cost|total|revenue|quantity|qty|budget|discount|tax|rate|probability|percent|percentage|number|count|weight|balance)\b/i
  const DATE_FIELDS = /\b(date|close date|start date|end date|due date|created|modified|birth|expiry|deadline|service provided|from|till)\b/i
  const STAGE_STATUS_FIELDS = /^(stage|status|state|phase|type|category|priority|level|rating|grade|result)$/i
  const NAME_LOOKUP_FIELDS = /\b(account|contact|customer|company|name|owner|manager|assigned|parent|opportunity|lead|partner|vendor|supplier|bill to|pay to|signed by)\b/i

  const isNumericValue = (v: string) => /^[\d,]+\.?\d*$/.test(v.replace(/[\s$€£¥₹%]/g, ''))
  const isDateValue = (v: string) => /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(v) || /^\d{4}-\d{2}-\d{2}/.test(v)
  const isStageValue = (v: string) => /^[A-Z][A-Z_]+$/.test(v) || /^(open|closed|won|lost|new|pending|active|inactive|qualified|converted|prospecting|negotiation|proposal)/i.test(v)

  function classifyFieldType(name: string): 'numeric' | 'date' | 'stage' | 'name' | 'unknown' {
    const clean = name.replace(/[^a-zA-Z\s]/g, '').trim()
    if (NUMERIC_FIELDS.test(clean)) return 'numeric'
    if (DATE_FIELDS.test(clean)) return 'date'
    if (STAGE_STATUS_FIELDS.test(clean)) return 'stage'
    if (NAME_LOOKUP_FIELDS.test(clean)) return 'name'
    return 'unknown'
  }

  function classifyValueType(value: string): 'numeric' | 'date' | 'stage' | 'name' | 'unknown' {
    if (isNumericValue(value)) return 'numeric'
    if (isDateValue(value)) return 'date'
    if (isStageValue(value)) return 'stage'
    // Name heuristic: starts with uppercase letter, is not a number/date/stage
    if (/^[A-Z][a-z]/.test(value) && !isNumericValue(value) && !isDateValue(value)) return 'name'
    return 'unknown'
  }

  interface MismatchInfo {
    stepIndex: number
    fieldName: string
    currentValue: string
    expectedType: 'numeric' | 'date' | 'stage' | 'name' | 'unknown'
    actualType: 'numeric' | 'date' | 'stage' | 'name' | 'unknown'
  }

  const mismatches: MismatchInfo[] = []

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const action = (step.action ?? '').toUpperCase()
    if (action !== 'TYPE' && action !== 'SELECT' && action !== 'LOOKUP') continue

    const fieldName = String(step.target ?? '')
    const value = String(step.value ?? '')
    if (!fieldName || !value) continue

    const expectedType = classifyFieldType(fieldName)
    const actualType = classifyValueType(value)

    if (expectedType !== 'unknown' && actualType !== 'unknown' && expectedType !== actualType) {
      mismatches.push({ stepIndex: i, fieldName, currentValue: value, expectedType, actualType })
    }
  }

  if (mismatches.length === 0) return steps

  log.warn(`[GEN] Field-value misalignment detected: ${mismatches.length} fields have wrong value types`)
  for (const m of mismatches) {
    log.warn(`[GEN]   Field "${m.fieldName}" expects ${m.expectedType} but got ${m.actualType}: "${m.currentValue}"`)
  }

  // Strategy 1: Swap partners — if field A expects X but has Y, and field B expects Y but has X
  const swapped = new Set<number>()
  for (const m1 of mismatches) {
    if (swapped.has(m1.stepIndex)) continue
    for (const m2 of mismatches) {
      if (m1.stepIndex === m2.stepIndex || swapped.has(m2.stepIndex)) continue
      if (m1.expectedType === m2.actualType && m2.expectedType === m1.actualType) {
        log.info(`[GEN] Swapping: "${m1.fieldName}" ↔ "${m2.fieldName}" ("${m1.currentValue}" ↔ "${m2.currentValue}")`)
        const temp = steps[m1.stepIndex].value
        steps[m1.stepIndex].value = steps[m2.stepIndex].value
        steps[m2.stepIndex].value = temp
        swapped.add(m1.stepIndex)
        swapped.add(m2.stepIndex)
        break
      }
    }
  }

  // Strategy 2: Generate sensible defaults for remaining mismatches
  const DEFAULTS: Record<string, string> = {
    numeric: '50000', date: '06/30/2026', stage: 'Prospecting', name: 'Test Record',
  }
  for (const m of mismatches) {
    if (swapped.has(m.stepIndex)) continue
    const defaultVal = DEFAULTS[m.expectedType]
    if (defaultVal) {
      log.info(`[GEN] Replacing mismatched "${m.fieldName}": "${m.currentValue}" → "${defaultVal}"`)
      steps[m.stepIndex].value = defaultVal
    }
  }

  return steps
}

/**
 * Formats test data into a compact LLM-ready string tailored to the test intent.
 *
 * CREATE:  shows all fields of the first record as "Field: value" pairs
 * SEARCH/VERIFY: highlights the primary identifier field (name/id) as the search term
 * UPDATE/DELETE: shows the full first record as the target to find and act on
 */
function buildTestDataContextWithIntent(
  entities:      import('../webapp/webapp-test-data.service.js').TestDataEntity[],
  intent:        TestIntent,
  targetEntity?: string,
): string {
  if (entities.length === 0) {
    return '(No real records available — use realistic unique placeholder values)'
  }

  // Filter to relevant entity
  let relevant = entities
  if (targetEntity) {
    const lower = targetEntity.toLowerCase()
    const filtered = entities.filter(
      e =>
        e.entity_name.toLowerCase().includes(lower) ||
        lower.includes(e.entity_name.toLowerCase()),
    )
    if (filtered.length > 0) relevant = filtered
  }

  const SOURCE_ICON: Record<string, string> = {
    user_upload: '⭐ USER UPLOAD',
    api:         '🔌 OPENAPI',
    ui_scraping: '🤖 UI SCRAPED',
  }

  const lines: string[] = [
    '=== REAL ENTITY RECORDS ===',
    `Source priority: ⭐ User Upload > 🔌 OpenAPI > 🤖 UI Scraped`,
    '',
  ]

  for (const entity of relevant.slice(0, 3)) {
    const src     = SOURCE_ICON[entity.source] ?? '📋'
    const records = entity.records

    if (records.length === 0) continue

    lines.push(`── ${entity.entity_name} (${src}, ${entity.record_count} records extracted) ──`)

    if (intent === 'create') {
      // For CREATE: show first record as field→value template with type annotations
      lines.push('  Use these values when filling the CREATE form:')
      lines.push('  ⚠ IMPORTANT: Each value is annotated with its DATA TYPE. Map values to fields of the MATCHING type only.')
      const sample = records[0]
      for (const [field, value] of Object.entries(sample).slice(0, 12)) {
        if (value === null || value === undefined || String(value).trim() === '') continue
        const valStr = String(value)
        // Annotate with detected type so LLM knows what kind of data this is
        let typeTag = ''
        if (/^\d+\.?\d*$/.test(valStr.replace(/[,\s]/g, ''))) typeTag = ' [NUMBER]'
        else if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(valStr) || /^\d{4}-\d{2}-\d{2}/.test(valStr)) typeTag = ' [DATE]'
        else if (/^[A-Z][A-Z_]+$/.test(valStr) || /^(open|closed|won|lost|pending|active|qualified|prospecting|negotiation)/i.test(valStr)) typeTag = ' [STATUS/STAGE]'
        else if (/^[A-Z][a-z]/.test(valStr)) typeTag = ' [NAME/TEXT]'
        lines.push(`    ${field}: "${value}"${typeTag}`)
      }
      // Show a few more alternatives
      if (records.length > 1) {
        lines.push('')
        lines.push('  Alternative values (use one of these):')
        for (const rec of records.slice(1, 3)) {
          const primaryKey = Object.keys(rec).find(k => /name|title|id/i.test(k))
          if (primaryKey && rec[primaryKey]) {
            lines.push(`    ${primaryKey}: "${rec[primaryKey]}"`)
          }
        }
      }

    } else if (intent === 'search' || intent === 'verify') {
      // For SEARCH/VERIFY: emphasise the primary identifier to search for
      lines.push('  Search/look up one of these EXISTING records:')
      for (const rec of records.slice(0, 5)) {
        const primaryKey = Object.keys(rec).find(k => /^(name|title|id|code|ref|label)/i.test(k))
          ?? Object.keys(rec)[0]
        if (primaryKey && rec[primaryKey] !== null) {
          lines.push(`    → Search for: "${rec[primaryKey]}"  (${primaryKey})`)
        }
      }

    } else if (intent === 'update' || intent === 'delete') {
      // For UPDATE/DELETE: show full first record to identify the target
      lines.push('  Target record to find and act on:')
      const sample = records[0]
      for (const [field, value] of Object.entries(sample).slice(0, 8)) {
        if (value === null || value === undefined || String(value).trim() === '') continue
        lines.push(`    ${field}: "${value}"`)
      }

    } else {
      // General: show first record as-is
      lines.push('  Sample records:')
      for (const rec of records.slice(0, 3)) {
        const pairs = Object.entries(rec)
          .filter(([, v]) => v !== null && String(v).trim() !== '')
          .slice(0, 5)
          .map(([k, v]) => `${k}: "${v}"`)
          .join(', ')
        lines.push(`    → { ${pairs} }`)
      }
    }

    lines.push('')
  }

  lines.push('=== END REAL ENTITY RECORDS ===')
  return lines.join('\n')
}



// ── Build structured web app context from normalized DB ───────────────
//
// The vector_embeddings chunks for web apps are plain-text summaries:
//   "Required fields: Account Name, Industry"
// These are useful for retrieval but give the LLM no locator info.
// This function pulls the FULL structured page data from metadata_normalized
// and formats it into a rich context string — with exact locator strings,
// locator_type (label/placeholder/css), field tags (input/select/checkbox),
// required status, available submit buttons, AND per-field sample values
// pulled directly from the web_test_data table.
//
// The returned context is placed into WEB_APP_RAG_SYSTEM_PROMPT {rag_context}.

async function buildWebAppStructuredContext(
  projectId: string,
  targetObjs: string[],
  rawChunks: string[],
): Promise<string> {
  const targetLowers = targetObjs.map(t => t.toLowerCase())

  try {
    // ── Load metadata_normalized rows ───────────────────────────────────
    const normalizedRows = await prisma.metadata_normalized.findMany({
      where:  { project_id: projectId, entity_type: 'webapp_crawl' },
      select: { structured_json: true, object_name: true },
    })

    if (normalizedRows.length === 0) return buildWebAppRagContext(rawChunks)

    const allPages: Record<string, unknown>[] = []
    for (const row of normalizedRows) {
      const data  = (row.structured_json ?? {}) as { pages?: Record<string, unknown>[] }
      const pages = Array.isArray(data.pages) ? data.pages : []
      allPages.push(...pages)
    }

    if (allPages.length === 0) return buildWebAppRagContext(rawChunks)

    // ── Load real entity records from web_test_data ──────────────────────
    // Build a map: entityNameLower → first record (flat field→value map)
    // Used to annotate each form field with a sample value the LLM should use.
    const testDataMap = new Map<string, Record<string, string>>()
    try {
      const { getTestData } = await import('../webapp/webapp-test-data.service.js')
      const entities = await getTestData(projectId)
      for (const entity of entities) {
        if (entity.records.length > 0) {
          // Build a merged map of all records' field values (first non-empty wins per key)
          const merged: Record<string, string> = {}
          for (const rec of entity.records.slice(0, 5)) {
            for (const [k, v] of Object.entries(rec)) {
              if (!merged[k] && v !== null && v !== undefined && String(v).trim() !== '') {
                merged[k] = String(v)
              }
            }
          }
          testDataMap.set(entity.entity_name.toLowerCase(), merged)
          // Also index by common variations (singular/plural)
          const singular = entity.entity_name.toLowerCase().replace(/s$/, '')
          const plural   = singular + 's'
          testDataMap.set(singular, merged)
          testDataMap.set(plural, merged)
        }
      }
      log.info(`[GEN] Field-value map loaded for ${testDataMap.size} entity variants`)
    } catch (tdErr) {
      log.warn({ err: tdErr }, '[GEN] Could not load test data for field annotation')
    }

    // ── Score and select top pages ───────────────────────────────────────
    const scoredPages = allPages.map(page => {
      const path = String(page['path'] ?? '').toLowerCase()
      let score = 0
      for (const t of targetLowers) {
        if (path.includes(`/${t}`)) score += 10
        if (path.includes(t))       score += 5
      }
      if (/\/(new|create|add|edit|form)/.test(path)) score += 5
      return { page, score }
    })
    scoredPages.sort((a, b) => b.score - a.score)
    const topPages = scoredPages.slice(0, 5).map(s => s.page)

    // ── Helper: resolve sample value for a field locator ────────────────
    // Looks up the entity's real record map and returns the best matching value.
    function resolveSampleValue(
      fieldLocator: string,
      pagePath: string,
    ): string | null {
      // Derive entity name from page path: /accounts/create → 'account'
      const pathSegments = pagePath.split('/').filter(Boolean)
      const entitySegment = pathSegments.find(s =>
        !/^(new|create|add|edit|list|index|all|\d+)$/i.test(s)
      ) ?? ''
      const entityLower = entitySegment.toLowerCase().replace(/s$/, '')

      // Try the entity map, then each target object
      const maps = [
        testDataMap.get(entityLower),
        testDataMap.get(entityLower + 's'),
        ...targetLowers.map(t => testDataMap.get(t)),
        ...targetLowers.map(t => testDataMap.get(t.replace(/s$/, ''))),
      ].filter(Boolean) as Record<string, string>[]

      for (const dataMap of maps) {
        // Exact match on field locator (case-insensitive)
        const exactKey = Object.keys(dataMap).find(
          k => k.toLowerCase() === fieldLocator.toLowerCase()
        )
        if (exactKey) return dataMap[exactKey]

        // Fuzzy: check if the locator contains a key word or vice versa
        const locLower = fieldLocator.toLowerCase().replace(/[^a-z0-9]/g, '')
        const fuzzyKey = Object.keys(dataMap).find(k => {
          const kn = k.toLowerCase().replace(/[^a-z0-9]/g, '')
          return locLower.includes(kn) || kn.includes(locLower)
        })
        if (fuzzyKey) return dataMap[fuzzyKey]
      }
      return null
    }

    // ── Build context string ─────────────────────────────────────────────
    const lines: string[] = [
      '=== WEB APPLICATION PAGE METADATA ===',
      'The following is REAL metadata crawled from the target web application.',
      'Each field shows its EXACT locator and ⚡ SAMPLE VALUE from real records.',
      'Use the EXACT locator string. Use the ⚡ SAMPLE VALUE as the step value.',
      '',
    ]

    for (const page of topPages) {
      const path    = String(page['path'] ?? '/')
      const title   = String(page['title'] ?? '')
      const inputs  = (Array.isArray(page['inputs'])  ? page['inputs']  : []) as Record<string, unknown>[]
      const selects = (Array.isArray(page['selects']) ? page['selects'] : []) as Record<string, unknown>[]
      const buttons = (Array.isArray(page['buttons']) ? page['buttons'] : []) as Record<string, unknown>[]

      lines.push(`--- Page: ${path}${title ? ` (${title})` : ''} ---`)

      const reqInputs = inputs.filter(i => Boolean(i['required']))
      const optInputs = inputs.filter(i => !Boolean(i['required']))

      const renderInput = (inp: Record<string, unknown>, tag: '[REQUIRED]' | '[OPTIONAL]') => {
        const locator     = String(inp['locator']      ?? inp['name'] ?? '')
        const locatorType = String(inp['locator_type'] ?? 'label')
        const fieldTag    = String(inp['tag']          ?? 'input')
        if (!locator) return null

        const sampleVal = resolveSampleValue(locator, path)
        const sampleStr = sampleVal ? `  ⚡ SAMPLE VALUE: "${sampleVal}"` : ''
        return `    ${tag} locator: "${locator}"  locator_type: "${locatorType}"  tag: ${fieldTag}${sampleStr}`
      }

      if (reqInputs.length > 0) {
        lines.push('  ⚠ REQUIRED Fields (MUST fill — test WILL FAIL if omitted):')
        for (const inp of reqInputs) {
          const line = renderInput(inp, '[REQUIRED]')
          if (line) lines.push(line)
        }
      }
      if (optInputs.length > 0) {
        lines.push('  Optional Fields (fill only if mentioned in the test prompt):')
        for (const inp of optInputs.slice(0, 12)) {
          const line = renderInput(inp, '[OPTIONAL]')
          if (line) lines.push(line)
        }
      }
      if (selects.length > 0) {
        lines.push('  Dropdown/Select Fields (SELECT action — use ONLY values from [VALID OPTIONS]):')
        for (const sel of selects.slice(0, 8)) {
          const locator  = String(sel['locator']  ?? sel['name'] ?? '')
          const required = Boolean(sel['required'])
          if (!locator) continue

          // Resolve valid options: prefer structured array; fall back to parsing the name string
          // (legacy DB rows stored options as "FieldLabel  options: A, B, C" in the name field)
          let validOptions: string[] = []
          const rawOptions = sel['options']
          if (Array.isArray(rawOptions) && rawOptions.length > 0) {
            validOptions = rawOptions.map(String).filter(Boolean)
          } else {
            const nameStr = String(sel['name'] ?? '')
            const optMatch = nameStr.match(/options:\s*(.+)$/i)
            if (optMatch) {
              validOptions = optMatch[1].split(',').map(s => s.trim()).filter(Boolean)
            }
          }

          // Pick a sample value: prefer first real-record match, then first valid option
          const sampleVal = resolveSampleValue(locator, path)
          // Only use sampleVal if it is actually one of the valid options (case-insensitive)
          const chosenSample = sampleVal && validOptions.length > 0
            ? (validOptions.find(o => o.toLowerCase() === sampleVal.toLowerCase()) ?? validOptions[0])
            : (validOptions.length > 0 ? validOptions[0] : null)

          if (validOptions.length === 0) {
            // No known options — explicitly tell the LLM to skip this field to prevent hallucination
            lines.push(`    ⛔ SKIP — locator: "${locator}"  action: SELECT  [NO VALID OPTIONS IN METADATA — DO NOT GENERATE A STEP FOR THIS FIELD. Omit it entirely.]`)
          } else {
            const optionsStr = `  [VALID OPTIONS: ${validOptions.join(' | ')}]`
            const sampleStr  = chosenSample ? `  ⚡ USE: "${chosenSample}"` : ''
            lines.push(`    ${required ? '[REQUIRED]' : '[OPTIONAL]'} locator: "${locator}"  locator_type: "label"  action: SELECT${optionsStr}${sampleStr}`)
          }
        }
      }
      if (buttons.length > 0) {
        const submitBtns = buttons.filter(b => {
          const n = String(b['name'] ?? '').toLowerCase()
          return n.includes('create') || n.includes('save') || n.includes('submit') || n.includes('add')
        })
        if (submitBtns.length > 0) {
          lines.push('  Submit Buttons (use for CLICK step after filling all fields):')
          for (const btn of submitBtns.slice(0, 3)) {
            // Extract the plain button name from the locator (e.g. "role=button, name=Create Campaign" → "Create Campaign")
            const rawLocator = String(btn['locator'] ?? btn['name'] ?? '')
            const btnName    = String(btn['name'] ?? '')
            const nameMatch  = rawLocator.match(/name=(.+)$/)
            const displayName = (nameMatch ? nameMatch[1].trim() : btnName).trim()
            if (!displayName) continue
            // Show both the display name AND the raw locator so the LLM knows exactly what value to use as the CLICK target
            lines.push(`    ⚡ BUTTON NAME: "${displayName}"  →  Use this EXACT name as target for the CLICK step  (locator_type: "role")`)
          }
        }
      }
      lines.push('')
    }

    lines.push('=== END OF WEB APPLICATION PAGE METADATA ===')
    return lines.join('\n')

  } catch (err) {
    log.warn({ err }, '[GEN] buildWebAppStructuredContext failed — using raw chunks')
    return buildWebAppRagContext(rawChunks)
  }
}

// ── Clean web app RAG context builder (no SF category headers) ────────
// Formats raw text chunks from vector_embeddings into a clean context
// string for the web app LLM prompt (no SF-specific headers).

function buildWebAppRagContext(chunks: string[]): string {
  if (chunks.length === 0) return ''
  const parts: string[] = [
    '=== WEB APPLICATION METADATA (from crawl) ===',
    'Use the following metadata to generate accurate test steps.',
    '',
  ]
  chunks.forEach((c, i) => {
    parts.push(`--- Page Context #${i + 1} ---`)
    parts.push(c)
    parts.push('')
  })
  parts.push('=== END OF METADATA ===')
  return parts.join('\n')
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

/**
 * Post-processing: ensure web app "create entity" tests have complete steps.
 * LLMs frequently return only NAVIGATE + TYPE steps but omit CLICK submit
 * and a final assertion. This function appends the missing steps automatically.
 *
 * Assertion strategy for web apps:
 *   - Use ASSERT_URL (redirect check) rather than ASSERT_TOAST/ASSERT_TEXT because most
 *     CRM-style SPAs redirect to the list/detail page after a successful create.
 *   - If the LLM already generated any assertion (ASSERT_TOAST/ASSERT_TEXT/ASSERT_URL), leave it.
 */
function ensureWebAppCreateSteps(
  result: GenerateResponse,
  prompt: string,
  isWebApp: boolean,
  ragContext: string = '',
  entityUrlMap: Record<string, EntityUrlInfo> = {},
): GenerateResponse {
  if (!isWebApp) return result
  if (!result.steps || result.steps.length === 0) return result

  // ── 0. Correct NAVIGATE URLs using known page paths from RAG context ──────
  // Problem: the LLM ignores path prefixes (e.g. /admin/) and generates
  // a short relative path like "/roles" when the real page is "/admin/roles".
  // This causes the browser to navigate to a non-existent route and fail at step 1.
  //
  // Fix: extract all "--- Page: /some/path ---" entries from the RAG context
  // and for each NAVIGATE step, check if the LLM's path ends-matches any known
  // page path. If so, replace it with the full known path.
  //
  // Additionally: use entityUrlMap (from web_test_data.source_url) as the
  // authoritative source of verified URLs. These are paths the scraper
  // ACTUALLY navigated to successfully.
  if (ragContext || Object.keys(entityUrlMap).length > 0) {
    // Collect all known page paths from the RAG context header lines
    const knownPaths: string[] = []
    for (const m of ragContext.matchAll(/---\s*Page:\s*([^\s(]+)/gi)) {
      const p = m[1].trim()
      if (p.startsWith('/')) knownPaths.push(p)
    }
    // Also add verified URLs from entityUrlMap (highest priority — these are real)
    for (const [, info] of Object.entries(entityUrlMap)) {
      const path = typeof info === 'string' ? info : info.path
      if (path.startsWith('/') && !knownPaths.includes(path)) {
        knownPaths.push(path)
      }
    }

    if (knownPaths.length > 0) {
      for (const step of result.steps) {
        if ((step.action ?? '').toUpperCase() !== 'NAVIGATE') continue
        let rawUrl = String(step.value || step.target || '')
        rawUrl = rawUrl.replace(/^URL:\s*/i, '').trim()
        if (!rawUrl.startsWith('/')) continue  // absolute URLs — leave as-is

        // Check if the generated path exactly matches a known path
        const exactMatch = knownPaths.find(p => p === rawUrl)
        if (exactMatch) continue  // already correct

        // Find a known path whose LAST segment(s) match the generated path
        // e.g. generated="/roles" matches known="/admin/roles"
        // e.g. generated="/roles/create" matches known="/admin/roles/create"
        const normalizedRaw = rawUrl.replace(/\/$/, '')
        const bestMatch = knownPaths.find(p => {
          const norm = p.replace(/\/$/, '')
          return norm.endsWith(normalizedRaw) && norm !== normalizedRaw
        })

        if (bestMatch) {
          log.info(`[GEN] Post-process: NAVIGATE URL corrected "${rawUrl}" → "${bestMatch}" (matched known page path)`)
          if (step.value && String(step.value).includes(rawUrl)) step.value = bestMatch
          else if (step.target && String(step.target).includes(rawUrl)) step.target = bestMatch
          else step.value = bestMatch
        } else {
          // Check for a close suffix match (e.g. generated="/roles/new" and known="/admin/roles")
          // by comparing the entity segment
          const rawSegments = normalizedRaw.split('/').filter(Boolean)
          const entitySeg = rawSegments.find(s => !/^(new|create|add|edit|list|index|all|\d+)$/i.test(s)) ?? ''
          if (entitySeg) {
            const formAction = rawSegments[rawSegments.length - 1]
            const isFormAction = /^(new|create|add|edit)$/i.test(formAction)
            
            // Try to find a known path that matches BOTH entity and form action (if any)
            let suffixMatch = knownPaths.find(p => {
              const segs = p.split('/').filter(Boolean)
              const hasEntity = segs.some(s => s.toLowerCase() === entitySeg.toLowerCase())
              if (!hasEntity) return false
              if (isFormAction) {
                return segs.some(s => s.toLowerCase() === formAction.toLowerCase())
              }
              return true
            })

            // Fallback: just match the entity segment
            if (!suffixMatch) {
              suffixMatch = knownPaths.find(p => {
                const segs = p.split('/').filter(Boolean)
                return segs.some(s => s.toLowerCase() === entitySeg.toLowerCase())
              })
            }

            if (suffixMatch) {
              // The known path IS the correct URL. Do not append imaginary suffixes.
              const corrected = suffixMatch
              if (corrected !== rawUrl) {
                log.info(`[GEN] Post-process: NAVIGATE URL corrected "${rawUrl}" → "${corrected}" (entity segment match)`)
                if (step.value && String(step.value).includes(rawUrl)) step.value = corrected
                else if (step.target && String(step.target).includes(rawUrl)) step.target = corrected
                else step.value = corrected
              }
            }
          }
        }
      }
    }
  }

  // Only fix "create/add/new" type tests
  const isCreateTest = /\b(create|add|new)\b/i.test(prompt)
  if (!isCreateTest) return result

  let expectedBtnName = ''
  let foundExactBtnInRag = false

  // ── A. First, try to extract the EXACT button name from the RAG metadata ──
  // The structured context builder formats it as: ⚡ BUTTON NAME: "Create Campaign"
  if (ragContext) {
    const btnMatch = ragContext.match(/⚡ BUTTON NAME:\s*"([^"]+)"/i)
    if (btnMatch && btnMatch[1]) {
      expectedBtnName = btnMatch[1].trim()
      foundExactBtnInRag = true
      log.info(`[GEN] Post-process: extracted exact button name "${expectedBtnName}" from RAG context`)
    }
  }

  // ── B. Extract entity name from the LLM's GENERATED STEPS, not the user prompt ──
  // The LLM correctly identifies the entity (e.g., "Campaign") even when the user
  // prompt includes test data (e.g., "Create Aero Campaign"). We can reliably
  // extract the entity from:
  //   - NAVIGATE step URL:  /campaigns → entity = "campaign"
  //   - TYPE step targets:  "Campaign Name" → entity = "Campaign"
  //   - CLICK step targets: "New Campaign"  → entity = "Campaign"
  let entityName = ''
  let entityExtractedFromSteps = false  // true when entity was reliably inferred from generated steps

  // B1. Try NAVIGATE step URL (most reliable — e.g., "/campaigns" or "/admin/roles")
  for (const step of result.steps) {
    if ((step.action ?? '').toUpperCase() === 'NAVIGATE') {
      const urlVal = String(step.value ?? step.target ?? '').replace(/^URL:\s*/i, '').trim()
      if (!urlVal.startsWith('/')) continue

      // B1a. Reverse-lookup in entityUrlMap — most reliable
      // e.g. entityUrlMap = { Role: { path: "/admin/roles" } }, urlVal = "/admin/roles" → entity = "Role"
      const normalizedUrl = urlVal.replace(/\/$/, '').replace(/\/(new|create|add|edit|list)$/, '')
      for (const [eName, eInfo] of Object.entries(entityUrlMap)) {
        const ePath = typeof eInfo === 'string' ? eInfo : eInfo.path
        if (ePath.replace(/\/$/, '') === normalizedUrl) {
          entityName = eName
          entityExtractedFromSteps = true
          log.info(`[GEN] Post-process: entity "${entityName}" resolved from URL map (URL: "${urlVal}")`)
          break
        }
      }
      if (entityName) break

      // B1b. Fallback: extract the LAST meaningful path segment (not the first!)
      // "/admin/roles" → segments = ["admin", "roles"] → entity = "Role"
      // "/campaigns/new" → segments = ["campaigns"] (after filtering action suffixes) → entity = "Campaign"
      const SKIP_SEGMENTS = /^(admin|api|app|manage|dashboard|panel|v[0-9]+|module|modules|settings|system)$/i
      const ACTION_SUFFIXES = /^(new|create|add|edit|list|index|all|view|detail|update|delete)$/i
      const segments = urlVal.split('/').filter(s => s && !ACTION_SUFFIXES.test(s))
      // Pick the last segment that isn't a generic prefix
      let seg = ''
      for (let i = segments.length - 1; i >= 0; i--) {
        if (!SKIP_SEGMENTS.test(segments[i])) {
          seg = segments[i]
          break
        }
      }
      if (seg) {
        // Depluralize: "roles" → "role", "campaigns" → "campaign"
        if (seg.endsWith('s') && seg.length > 3) seg = seg.slice(0, -1)
        entityName = seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase()
        entityExtractedFromSteps = true
        log.info(`[GEN] Post-process: entity "${entityName}" extracted from NAVIGATE URL "${urlVal}" (last segment)`)
        break
      }
    }
  }

  // B2. Fallback: Try TYPE/CLICK step targets (e.g., "Campaign Name", "New Campaign")
  if (!entityName) {
    for (const step of result.steps) {
      const action = (step.action ?? '').toUpperCase()
      const target = String(step.target ?? '')
      if (action === 'TYPE' && target) {
        // "Campaign Name" → "Campaign", "Account Name" → "Account"
        const fieldMatch = target.match(/^([A-Z][a-z]+)\s+Name$/i)
        if (fieldMatch) {
          entityName = fieldMatch[1].charAt(0).toUpperCase() + fieldMatch[1].slice(1).toLowerCase()
          entityExtractedFromSteps = true
          log.info(`[GEN] Post-process: entity "${entityName}" extracted from TYPE field "${target}"`)
          break
        }
      }
      if (action === 'CLICK' && target) {
        // "New Campaign" → "Campaign"
        const clickMatch = target.match(/^(?:New|Add)\s+([A-Za-z]+)$/i)
        if (clickMatch) {
          entityName = clickMatch[1].charAt(0).toUpperCase() + clickMatch[1].slice(1).toLowerCase()
          entityExtractedFromSteps = true
          log.info(`[GEN] Post-process: entity "${entityName}" extracted from CLICK target "${target}"`)
          break
        }
      }
    }
  }

  // B3. Last resort: parse from prompt (but use known stop words to avoid test data)
  if (!entityName) {
    const STOP_WORDS = /^(a|an|new|record|test|the|this|my|it)$/i
    const entityMatch = prompt.match(/(?:create|add|new)\s+(?:a\s+|an\s+|new\s+)?(\w+)/i)
    entityName = entityMatch ? entityMatch[1] : ''
    if (!entityName || STOP_WORDS.test(entityName)) {
      const words = prompt.split(/\s+/)
      const verbIdx = words.findIndex(w => /^(create|add|new)$/i.test(w))
      if (verbIdx >= 0) {
        for (let wi = verbIdx + 1; wi < words.length; wi++) {
          const w = words[wi].replace(/[^a-zA-Z]/g, '')
          if (w && !STOP_WORDS.test(w)) { entityName = w; break }
        }
      }
    }
    if (!entityName) entityName = 'Record'
    entityName = entityName.charAt(0).toUpperCase() + entityName.slice(1).toLowerCase()
    log.info(`[GEN] Post-process: entity "${entityName}" from prompt fallback (less reliable)`)
  }

  const capitalizedEntity = entityName
  
  // ── C. Build button name and entity plural ──
  // Priority: 1) exact from RAG metadata, 2) from entityUrlMap.buttonName, 3) default "Create X"
  if (!expectedBtnName) {
    // Check entityUrlMap for a known button name for this entity
    const urlInfo = Object.entries(entityUrlMap).find(
      ([eName]) => eName.toLowerCase() === capitalizedEntity.toLowerCase()
    )?.[1]
    const knownBtnName     = urlInfo && typeof urlInfo !== 'string' ? urlInfo.buttonName     : undefined
    const knownOpenBtnName = urlInfo && typeof urlInfo !== 'string' ? urlInfo.openButtonName : undefined
    if (knownBtnName) {
      expectedBtnName = knownBtnName
      // Mark as authoritative ONLY if it's the final submit button (not just an opener)
      // For two-step flows (openButtonName exists), both buttons are authoritative
      foundExactBtnInRag = true
      log.info(`[GEN] Post-process: verified submit button "${expectedBtnName}"${knownOpenBtnName ? ` (modal opened by "${knownOpenBtnName}")` : ''} for entity "${capitalizedEntity}"`)
    } else {
      expectedBtnName = `Create ${capitalizedEntity}`          // e.g. "Create Campaign"
    }
  }
  
  const entityPlural = `/${capitalizedEntity.toLowerCase()}s` // e.g. "/campaigns"

  log.info(`[GEN] Post-process: entity="${capitalizedEntity}", expectedBtn="${expectedBtnName}", foundInRag=${foundExactBtnInRag}`)

  // ── 1. Correct the LAST CLICK step ──
  // If we found the exact button in RAG context, we unconditionally override.
  // If we inferred from generated steps, override anything that doesn't match.
  const lastClickIdx = result.steps.reduce(
    (acc, s, i) => (s.action ?? '').toUpperCase() === 'CLICK' ? i : acc, -1
  )
  if (lastClickIdx >= 0) {
    const step    = result.steps[lastClickIdx]
    const curTarget = String(step.target ?? '')
    const roleMatch  = curTarget.match(/name=(.+)$/i)
    const curName    = (roleMatch ? roleMatch[1] : curTarget).trim()
    
    // Check if the LLM's button name looks like it used test data instead of entity name.
    // e.g., "Create Aero" when entity is "Campaign" — "Aero" is NOT the entity
    const curBtnEntity = curName.match(/^(?:Create|New|Add|Save)\s+(.+)$/i)?.[1]?.trim() || ''
    const looksLikeTestData = curBtnEntity && curBtnEntity.toLowerCase() !== capitalizedEntity.toLowerCase()
    
    let shouldOverride = false
    if (foundExactBtnInRag) {
      // 100% confident from live metadata — always override
      shouldOverride = curName !== expectedBtnName
    } else if (looksLikeTestData) {
      // LLM used test data as entity (e.g., "Create Aero" when entity is "Campaign")
      shouldOverride = true
      log.info(`[GEN] Post-process: detected test-data in button "${curName}" (entity should be "${capitalizedEntity}")`)
    } else {
      // Only override highly generic names
      const GENERIC_BTN = /^(save|submit|ok|confirm|done|send|create|add|new)$/i
      shouldOverride = GENERIC_BTN.test(curName)
    }

    if (shouldOverride) {
      step.target       = expectedBtnName
      step.locator_type = 'role'
      log.info(`[GEN] Post-process: corrected last CLICK "${curName}" → "${expectedBtnName}"`)
    }
  }

  // ── 2. Replace ASSERT_TOAST with ASSERT_URL ────────────────────────────
  // SPAs redirect to the list page on success; toasts are transient and time out.
  let assertIdx = result.steps.findIndex(s => (s.action ?? '').toUpperCase().startsWith('ASSERT_'))
  
  if (assertIdx >= 0) {
    const assertStep = result.steps[assertIdx]
    if (assertStep.action === 'ASSERT_TOAST' || assertStep.action === 'ASSERT_TEXT') {
      assertStep.action = 'ASSERT_URL'
      assertStep.target = 'url'
      assertStep.value  = entityPlural
      assertStep.locator_type = 'url'
      log.info(`[GEN] Post-process: upgraded assertion to ASSERT_URL "${entityPlural}"`)
    } else if (assertStep.action === 'ASSERT_URL') {
      const curUrl = String(assertStep.value ?? '')
      // Overwrite if: (a) exact button from RAG, (b) entity reliably from steps, (c) URL is generic/empty
      // This catches cases like '/aeros' when entity is 'Campaign' → corrects to '/campaigns'
      const curUrlEntity = curUrl.replace(/^\//, '').replace(/s$/, '').toLowerCase()
      const entityMismatch = curUrlEntity && curUrlEntity !== capitalizedEntity.toLowerCase()
      if (foundExactBtnInRag || (entityExtractedFromSteps && entityMismatch) || curUrl.length < 3 || curUrl === '/') {
         assertStep.value = entityPlural
         log.info(`[GEN] Post-process: corrected ASSERT_URL "${curUrl}" → "${entityPlural}"`)
      }
    }
  } else {
    // Append ASSERT_URL if completely missing
    result.steps.push({
      action: 'ASSERT_URL',
      target: 'url',
      locator_type: 'url',
      value: entityPlural,
      status: 'pending'
    })
    log.info(`[GEN] Post-process: injected missing ASSERT_URL "${entityPlural}"`)
  }

  // ── 3. Remove WAIT steps that appear after the last CLICK ─────────────
  // Explicit waits after clicking submit are unreliable; the runner handles timing.
  // (re-use lastClickIdx computed above — may have changed if we appended CLICK)
  const lastClickIdx2 = result.steps.reduce(
    (acc, s, i) => (s.action ?? '').toUpperCase() === 'CLICK' ? i : acc, -1
  )
  if (lastClickIdx2 >= 0) {
    const before = result.steps.length
    result.steps = result.steps.filter(
      (s, i) => !((s.action ?? '').toUpperCase() === 'WAIT' && i > lastClickIdx2)
    )
    if (result.steps.length < before) {
      log.info(`[GEN] Post-process: removed ${before - result.steps.length} WAIT step(s) after CLICK`)
    }
  }

  // ── Re-derive state after corrections ─────────────────────────────────
  const actions2  = result.steps.map(s => (s.action ?? '').toUpperCase())
  const hasType   = actions2.some(a => a === 'TYPE' || a === 'SELECT' || a === 'CHECKBOX')
  const hasClick  = actions2.includes('CLICK')
  const hasAssert = actions2.includes('ASSERT_URL') || actions2.includes('ASSERT_TEXT')

  if (!hasType) return result // not a form test — nothing else to add

  const nextId = () => String(result.steps.length + 1)

  // ── 4. Append CLICK if still missing ──────────────────────────────────
  if (!hasClick) {
    result.steps.push({
      id:           nextId(),
      action:       'CLICK',
      target:       expectedBtnName,
      value:        '',
      locator_type: 'role',
    })
    log.info(`[GEN] Post-process: appended CLICK "${expectedBtnName}"`)
  }

  // ── 5. Append ASSERT_URL if still no assertion ─────────────────────────
  if (!hasAssert) {
    result.steps.push({
      id:     nextId(),
      action: 'ASSERT_URL',
      target: '',
      value:  entityPlural,
    })
    log.info(`[GEN] Post-process: appended ASSERT_URL "${entityPlural}"`)
  }

  // Re-number all steps
  result.steps = renumberSteps(result.steps)
  return result
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

  let sessionInstruction  = ''
  let useMcpRag           = false
  let embeddingCount      = 0
  let isSalesforceProject = false  // true for any SF project regardless of connection status
  let isWebAppProject     = false  // true for any web_app project

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

      // Track whether this is a Salesforce project regardless of connection status.
      // This is used below to always inject the SF field manifest when available,
      // even when the live connection is down (DB fallback still has metadata).
      isSalesforceProject = category.toLowerCase() === 'salesforce'
      // DB stores the category as 'web_app' (with underscore) — accept both for safety
      isWebAppProject     = category.toLowerCase() === 'web_app' || category.toLowerCase() === 'webapp'

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
      } else if (isSalesforceProject && isConnected) {
        sessionInstruction =
          '\n\nIMPORTANT: This is a Salesforce project with an active OAuth connection. ' +
          'DO NOT generate any login/authentication steps. The user is already authenticated. ' +
          'Start the test from the application home page or the relevant object page directly.'
      } else if (isSalesforceProject) {
        // Not connected yet — still inject Lightning URL guidance
        sessionInstruction =
          '\n\nIMPORTANT: This is a Salesforce Lightning project. ' +
          'DO NOT generate login steps. Use Lightning URL patterns: /lightning/o/{Object}/list, /lightning/o/{Object}/new.'
      }

      // ── Web App session instruction ─────────────────────────────────
      if (isWebAppProject) {
        // Check for web app RAG embeddings FIRST so we know if metadata is available
        embeddingCount = await prisma.vector_embeddings.count({ where: { project_id } })
        const hasWebMetadata = embeddingCount > 0
        if (hasWebMetadata) {
          useMcpRag = true  // re-use the MCP RAG flag to trigger RAG retrieval
          log.info(`[GEN] Web app project ${project_id} has ${embeddingCount} embeddings → metadata-driven generation`)
        }

        if (hasWebMetadata) {
          // Metadata available — strict mode: only use known fields
          sessionInstruction =
            '\n\nIMPORTANT: This is a web application project with an active login session. ' +
            'DO NOT generate any login/authentication steps. The user is ALREADY authenticated. ' +
            'Start the test from the relevant page directly using relative URL paths. ' +
            'Use ONLY field labels from the APPLICATION METADATA provided — do not invent field names.'
        } else {
          // No metadata synced yet — MINIMAL generation mode.
          // Without crawled metadata we don't know what fields exist, so
          // we MUST NOT guess field names. Only generate the essential steps.
          sessionInstruction =
            '\n\nIMPORTANT: This is a web application project with an active login session. ' +
            'DO NOT generate any login/authentication steps (no sign-in, no email/password for auth). ' +
            'The user is ALREADY authenticated. ' +
            'Start the test from the relevant page directly using relative URL paths. ' +
            'Infer the page purpose from the URL path and test case name. ' +
            'CRITICAL — NO METADATA IS AVAILABLE. You MUST follow these rules:\n' +
            '1. Generate EXACTLY 4 steps — no more, no less:\n' +
            '   Step 1: NAVIGATE to the entity page (use /entity-name/new, /entity-name/create, or /entity-name/add)\n' +
            '   Step 2: TYPE ONLY the primary name field — this is always "[Entity] Name" (e.g. "Account Name" for /accounts, "Contact Name" for /contacts, "Lead Name" for /leads). Do NOT add any other fields.\n' +
            '   Step 3: CLICK the submit button — use the entity-specific button text like "Create Account", "Create Contact", "Add Lead", NOT generic "Save" or "Submit".\n' +
            '   Step 4: ASSERT_TOAST for a success/confirmation message.\n' +
            '2. Do NOT generate steps for fields you are uncertain about (e.g. Account Number, Phone, Email, Industry, etc.).\n' +
            '3. Do NOT guess field labels — without metadata, you CANNOT know what fields exist on the form.\n' +
            '4. Only fill the MINIMUM required to submit the form (the entity name is always required).\n' +
            '5. Use locator_type="label" for form fields and locator_type="role" for buttons.'
        }
      }
    } catch (err) {
      log.warn({ err }, '[GEN] Project detection error — falling back to standard generation')
    }
  }

  // ── Web App: fetch real test data + classify intent ────────────────────────
  // Loaded once here so both the RAG path and standard path can inject it.
  let webTestDataContext     = ''
  let testIntentInstructions = ''
  let globalEntityUrlMap: Record<string, EntityUrlInfo> = {}
  let multiEntityInstructions = ''
  let userSpecifiedValuesContext = ''
  const testIntent = classifyTestIntent(prompt)
  if (isWebAppProject && project_id) {
    // ── Detect multi-entity flow ──────────────────────────────────────────
    const multiFlow = detectMultiEntityFlow(prompt)
    if (multiFlow.isMultiEntity) {
      log.info(`[GEN] Multi-entity flow detected: ${multiFlow.primaryEntity} → ${multiFlow.secondaryEntity} (${multiFlow.flowType})`)
      multiEntityInstructions = `
⚠ MULTI-ENTITY FLOW DETECTED in this test case:
  PRIMARY ENTITY: ${multiFlow.primaryEntity} (create THIS first)
  SECONDARY ENTITY: ${multiFlow.secondaryEntity} (${multiFlow.flowType === 'create_then_verify' ? 'verify after primary is created' : 'create after primary is created'})

You MUST start with the ${multiFlow.primaryEntity} create page, NOT the ${multiFlow.secondaryEntity} page.
Phase 1 steps: Navigate to /${multiFlow.primaryEntity.toLowerCase()}s → Fill ${multiFlow.primaryEntity} fields → Submit
Phase 2 steps: Navigate to or click through to ${multiFlow.secondaryEntity} → Verify/Create`
    }

    // ── Extract user-specified values ──────────────────────────────────────
    const userValues = extractUserSpecifiedValues(prompt)
    if (userValues.length > 0) {
      log.info(`[GEN] User-specified values: ${userValues.map(v => `${v.field}="${v.value}"`).join(', ')}`)
      const lines = ['⚡ USER-SPECIFIED VALUES (use these EXACT values, they override sample data):']
      for (const uv of userValues) {
        lines.push(`  • ${uv.field} → "${uv.value}"`)
      }
      userSpecifiedValuesContext = lines.join('\n')
    }

    try {
      const testDataEntities = await getTestData(project_id)
      if (testDataEntities.length > 0) {
        // For multi-entity flows, filter to the PRIMARY entity for test data
        const targetObjs = extractTargetObjects(prompt)
        const primaryTarget = multiFlow.isMultiEntity ? multiFlow.primaryEntity : targetObjs[0]
        webTestDataContext = buildTestDataContextWithIntent(testDataEntities, testIntent, primaryTarget)
        log.info(`[GEN] Test data context loaded: ${testDataEntities.length} entities, intent=${testIntent}, target=${primaryTarget}, ${webTestDataContext.length} chars`)
      }
    } catch (tdErr) {
      log.warn({ err: tdErr }, '[GEN] Test data fetch failed (non-critical) — skipping')
    }
    testIntentInstructions = buildIntentInstructions(testIntent)

    // Load verified entity→URL map (from web_test_data.source_url)
    try {
      globalEntityUrlMap = await getEntityUrlMap(project_id)
      if (Object.keys(globalEntityUrlMap).length > 0) {
        log.info(`[GEN] Global entity URL map loaded: ${JSON.stringify(globalEntityUrlMap)}`)
      }
    } catch { /* non-critical */ }
  }

  // ── MCP RAG path ───────────────────────────────────────────────────

  if (useMcpRag && project_id) {
    try {
      let chunks = await retrieveRagChunks(project_id, prompt, 20)

      if (chunks.length > 0) {
        const targetObjs = extractTargetObjects(prompt)
        if (targetObjs.length > 0) {
          // Pass isWebApp so web-app chunks are filtered by URL path, not SF object name
          chunks = filterChunksByObjects(chunks, targetObjs, isWebAppProject)
          log.info(`[GEN] Object filter (isWebApp=${isWebAppProject}): targets='${targetObjs.join(', ')}', kept ${chunks.length} chunks`)
        }

        // ── Web App: check if retrieved chunks actually contain form field metadata ──
        // The RAG retrieval may find /home page chunks (because "Accounts" appears
        // as a sidebar button), but those don't have form fields for /accounts/create.
        // Web app chunks stored by salesforce.embeddings.ts use:
        //   "Required fields: X, Y" and "Optional fields: A, B"
        if (isWebAppProject && chunks.length > 0) {
          const formFieldIndicators = /required fields:|optional fields:|buttons:|dropdowns:|\[required\]|\[optional\]|form field|input fields/i
          const hasFormFields = chunks.some(c => formFieldIndicators.test(c))
          if (!hasFormFields) {
            log.info(`[GEN] Web App: ${chunks.length} RAG chunks found but NONE contain form field metadata — falling through to standard path for field inference`)
            chunks = [] // clear so we fall through
          }
        }

        if (chunks.length > 0) {

        // ── Web App: build a dedicated structured context from normalized DB ─
        // The RAG chunks contain plain-text summaries (field names only). We
        // supplement with the full structured page data so the LLM sees locator
        // types, field tags, required status, and submit buttons — not just names.
        let ragContext: string
        if (isWebAppProject) {
          ragContext = await buildWebAppStructuredContext(project_id, targetObjs, chunks)
          log.info(`[GEN] Web App: built structured context (${ragContext.length} chars)`)
        } else {
          ragContext = buildRagContext(chunks)
        }

        // Supplemental: structured field manifest + record type manifest from salesforce.service.ts
        // Skip this for web app projects — they use crawled page metadata, not SF describe API
        if (!isWebAppProject) {
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
                // Build the field manifest filtered to layout fields + user prompt,
                // injecting REAL lookup values queried from the org.
                if (layoutFields) {
                  log.info(`[GEN] Page layout fetched: ${layoutFields.available.size} fields (${layoutFields.layoutRequired.size} layout-required) for ${sfMeta.object_name}`)
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
        } // end if (!isWebAppProject)

        // ── Web App: inject verified entity URL map into ragContext ────────
        // The metadata crawler may only have /home pages. The test data scraper
        // discovered REAL URLs (e.g. /roles, /campaigns). Inject them so the LLM
        // uses verified paths and the post-processor can correct hallucinated ones.
        const entityUrlMap = globalEntityUrlMap
        if (isWebAppProject && Object.keys(entityUrlMap).length > 0) {
          const urlMapSection = [
            '',
            '=== VERIFIED URL MAP (use these EXACT paths and button names) ===',
            ...Object.entries(entityUrlMap).map(([entity, info]) => {
              const path   = typeof info === 'string' ? info : info.path
              const btn    = typeof info === 'string' ? undefined : info.buttonName
              const opener = typeof info === 'string' ? undefined : info.openButtonName
              if (opener && btn) {
                // Two-step modal flow: click opener → fill form → click submit
                return (
                  `  Entity: ${entity}  →  List Page: ${path}\n` +
                  `    CREATE FLOW (TWO STEPS REQUIRED):\n` +
                  `      Step A: CLICK "${opener}" button  (this OPENS the create form/modal)\n` +
                  `      Step B: Fill all required fields\n` +
                  `      Step C: CLICK "${btn}" button  (this SUBMITS the form — use as CLICK target)`
                )
              }
              const btnNote = btn
                ? `  |  Submit Button: "${btn}" (use this EXACT text for the CLICK step)`
                : `  |  Create Page: ${path}/new`
              return `  Entity: ${entity}  →  List Page: ${path}${btnNote}`
            }),
            '=== END VERIFIED URL MAP ===',
            '',
          ].join('\n')
          ragContext = urlMapSection + ragContext
          log.info(`[GEN] Injected verified URL map: ${Object.keys(entityUrlMap).length} entities`)
        }

        // Choose the right system prompt based on project type
        const ragSystemPrompt = isWebAppProject
          ? WEB_APP_RAG_SYSTEM_PROMPT
              .replace('{rag_context}', ragContext)
              .replace('{test_data_context}', webTestDataContext || '(No real records available — use realistic unique placeholders)')
              .replace('{test_intent_instructions}', testIntentInstructions)
              .replace('{multi_entity_instructions}', multiEntityInstructions)
              .replace('{user_specified_values}', userSpecifiedValuesContext)
          : MCP_RAG_SYSTEM_PROMPT.replace('{rag_context}', ragContext)

        const rawResult    = await invokeLlm(ragSystemPrompt, prompt, provider, model)
        const normalised   = normaliseResponse(rawResult)
        // Post-process: fix field-value type misalignment (e.g. names in Amount fields)
        if (isWebAppProject) {
          normalised.steps = validateFieldValueAlignment(normalised.steps)
        }
        const result       = ensureWebAppCreateSteps(normalised, prompt, isWebAppProject, ragContext, entityUrlMap)

        log.info(`[GEN] ${isWebAppProject ? 'Web App' : 'MCP'} RAG generation successful with ${chunks.length} chunks`)
        return { ...result, rag_context_used: true, retrieved_chunks: chunks.length }
        } // end inner if (chunks.length > 0)
      } else if (isWebAppProject) {
        log.info('[GEN] Web App: No RAG chunks found — falling back to standard with session instruction')
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

  // Standard path: inject SF metadata whenever this is a Salesforce project
  // (regardless of connection status — DB fallback has cached metadata).
  // Previously guarded by sessionInstruction.includes('Salesforce') which
  // silently skipped metadata injection when the session instruction wasn't set.
  if (project_id && isSalesforceProject) {
    try {
      const targetObjs = extractTargetObjects(prompt)
      log.info(`[GEN] Standard path: SF project detected, target objects: [${targetObjs.join(', ')}]`)
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
              if (layoutFields) {
                log.info(`[GEN] Standard path: layout fetched: ${layoutFields.available.size} fields (${layoutFields.layoutRequired.size} layout-required) for ${sfMeta.object_name}`)
              }
              const lookupSamples = await fetchLookupSamplesForManifest(
                project_id, sfMeta.metadata, layoutFields
              ).catch(() => new Map<string, string[]>())
              const manifest = buildFieldManifest(sfMeta.metadata, layoutFields, prompt, lookupSamples)
              if (manifest) {
                sfRagContext += `\n\n=== Field Manifest for ${sfMeta.object_name} ===\n` + manifest
                log.info(`[GEN] Standard path: field manifest injected for ${targetObj}`)
              }

              sfRagContext += `\n\nObject API Name: ${sfMeta.object_name} | Label: ${sfMeta.label ?? sfMeta.object_name}`
            } else {
              log.warn(`[GEN] Standard path: could not resolve metadata for ${targetObj} — no field manifest`)
            }
        }
      }
    } catch (err) {
      log.warn({ err }, '[GEN] Standard path: non-critical SF metadata injection error')
    }
  }

  // ── Standard path: Web App metadata injection ─────────────────────
  // When the web app project has no RAG embeddings (or they weren't retrieved),
  // use buildWebAppStructuredContext to inject structured page metadata from
  // metadata_normalized. This gives the LLM exact locator strings and types
  // rather than hallucinating generic forms.
  let webAppRagContext = ''

  if (project_id && isWebAppProject && !sfRagContext) {
    try {
      const targetObjs = extractTargetObjects(prompt)
      log.info(`[GEN] Standard path: Web App — building structured context, targets=[${targetObjs.join(', ')}]`)
      // buildWebAppStructuredContext pulls from metadata_normalized and scores pages
      // by relevance to the target entity, then formats them with exact locator info.
      const structured = await buildWebAppStructuredContext(project_id, targetObjs, [])
      const hasRealFormFields = structured.includes('[REQUIRED]') ||
        structured.includes('REQUIRED Form Fields') ||
        structured.includes('Optional Form Fields') ||
        structured.includes('Submit Buttons')
      if (hasRealFormFields) {
        webAppRagContext = structured
        log.info(`[GEN] Standard path: web app structured context injected (${structured.length} chars)`)
      } else {
        // Fallback to domain_models if normalized data has no form fields
        const domainRows = await prisma.domain_models.findMany({
          where:  { project_id },
          select: { entity_name: true, testing_rules: true },
          take:   10,
        })
        if (domainRows.length > 0) {
          const parts: string[] = [
            '=== WEB APPLICATION PAGE METADATA ===',
            'The following pages, fields, and actions were discovered by crawling the target web application.',
            'Use these EXACT field names and page routes when generating test steps.',
            '',
          ]
          for (const row of domainRows) {
            parts.push(`Page: ${row.entity_name}`)
            const rules = (Array.isArray(row.testing_rules) ? row.testing_rules : []) as Record<string, unknown>[]
            const requiredFields = rules.filter(r => r['type'] === 'mandatory_field_test')
            const optionalFields = rules.filter(r => r['type'] !== 'mandatory_field_test' && r['type'] !== 'page_load_test' && r['type'] !== 'form_fill_test' && r['field'])
            const submitBtns    = rules.filter(r => r['type'] === 'form_submission_test')
            if (requiredFields.length > 0) {
              parts.push('  Required fields:')
              for (const f of requiredFields) {
                parts.push(`    [REQUIRED] "${String(f['field'] ?? '')}" (locator: ${String(f['locator'] ?? '')}, locator_type: ${String(f['locator_type'] ?? 'label')})`)
              }
            }
            if (optionalFields.length > 0) {
              parts.push('  Optional fields:')
              for (const f of optionalFields.slice(0, 10)) {
                if (!f['field']) continue
                parts.push(`    [OPTIONAL] "${String(f['field'] ?? '')}" (locator: ${String(f['locator'] ?? '')}, locator_type: ${String(f['locator_type'] ?? 'label')})`)
              }
            }
            if (submitBtns.length > 0) {
              parts.push('  Submit buttons (⚡ use the EXACT button name as CLICK target — NOT "Submit"):')
              for (const b of submitBtns) {
                const btnLabel = String(b['button'] ?? '')
                if (!btnLabel) continue
                parts.push(`    ⚡ BUTTON NAME: "${btnLabel}"  →  Use this EXACT name as the CLICK target (locator_type: "role")`)
              }
            }
            parts.push('')
          }
          parts.push('=== END WEB APPLICATION PAGE METADATA ===')
          const dmContext = parts.join('\n')
          const dmHasFields = dmContext.includes('[REQUIRED]') || dmContext.includes('Required fields:') || dmContext.includes('Submit buttons:')
          if (dmHasFields) {
            webAppRagContext = dmContext
            log.info(`[GEN] Standard path: domain_models fallback injected (${domainRows.length} pages)`)
          } else {
            log.info('[GEN] Standard path: web app metadata has NO form fields — using permissive prompt')
          }
        } else {
          log.info('[GEN] Standard path: web app project has no crawled domain models yet')
        }
      }
    } catch (err) {
      log.warn({ err }, '[GEN] Standard path: non-critical web app metadata injection error')
    }
  }


  // ── On-demand live page scrape (web app, no metadata) ─────────────────
  // When no form metadata exists (webAppRagContext is empty), scrape the
  // actual target page in real-time to get REAL field names and buttons.
  if (project_id && isWebAppProject && !webAppRagContext && !sfRagContext) {
    try {
      // 1. Infer the target page URL from the prompt
      // Extract ALL words after the verb (create/add/new) and try each as entity candidate.
      // This handles prompts like "Create Aero Campaign" where "Aero" is test data, not the entity.
      // We generate candidate paths for each word so "/campaigns/create" will be tried alongside "/aeros/create".
      const verbMatch = prompt.match(/(?:create|add|new)\s+(.+)/i)
      const wordsAfterVerb = verbMatch ? verbMatch[1].split(/\s+/).map(w => w.replace(/[^a-zA-Z]/g, '').toLowerCase()).filter(Boolean) : []
      const SKIP_WORDS = new Set(['a', 'an', 'the', 'new', 'record', 'test', 'for', 'with', 'and', 'in', 'on', 'to'])
      const entityCandidates = wordsAfterVerb.filter(w => w.length > 1 && !SKIP_WORDS.has(w))
      
      // Build candidate paths — put longer/more common entity names FIRST (they're more likely to be real entities)
      const candidatePaths: string[] = []
      // Reverse so the LAST word (likely the entity: "Create Aero Campaign" → "campaign") is tried first
      for (const ent of [...entityCandidates].reverse()) {
        candidatePaths.push(`/${ent}s/create`, `/${ent}s/new`, `/${ent}/create`, `/${ent}/new`, `/${ent}s/add`)
      }

      if (candidatePaths.length > 0) {
        // 2. Get project credentials
        const integration = await prisma.project_integrations.findFirst({
          where: { project_id, category: { in: ['web_app', 'webapp'] } },
          select: { base_url: true, username: true, password: true },
        })

        if (integration?.base_url && integration?.username && integration?.password) {
          const baseOrigin = new URL(integration.base_url).origin
          log.info(`[GEN] Live page scrape: attempting to crawl ${candidatePaths[0]} for real form metadata`)

          const { WebMetadataService } = await import('../webapp/webapp-crawler.js')
          const { chromium } = await import('playwright')
          const browser = await chromium.launch({ headless: true })

          try {
            const context = await browser.newContext()
            const page = await context.newPage()
            page.setDefaultTimeout(15_000)

            // 3. Login first
            await page.goto(integration.base_url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
            await page.waitForTimeout(1_000)

            const pwdField = page.locator('input[type="password"]')
            if (await pwdField.count() > 0 && await pwdField.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
              for (const sel of [
                'input[type="email"]', 'input[name="username"]', 'input[name="email"]',
                'input[name="user"]', 'input[name="login"]', 'input[id="username"]',
                'input[id="email"]', 'input[type="text"]',
              ]) {
                const f = page.locator(sel).first()
                if (await f.isVisible({ timeout: 1_000 }).catch(() => false)) {
                  await f.fill(integration.username)
                  break
                }
              }
              await pwdField.first().fill(integration.password)

              for (const name of ['Log In', 'Login', 'Sign In', 'Submit', 'Sign in']) {
                const btn = page.getByRole('button', { name, exact: false })
                if (await btn.count() > 0) {
                  await btn.first().click({ timeout: 5_000 })
                  break
                }
              }
              await page.waitForTimeout(2_000)
              await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {})
            }

            // 4. Try each candidate path
            let scrapedMeta: import('../webapp/webapp-crawler.js').PageMetadata | null = null
            for (const candidatePath of candidatePaths) {
              try {
                const targetUrl = `${baseOrigin}${candidatePath}`
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
                await page.waitForTimeout(2_000)

                const inputCount = await page.locator('input:not([type=hidden]), textarea, select').count()
                if (inputCount > 0) {
                  scrapedMeta = await WebMetadataService._visitPage(page, targetUrl, baseOrigin)
                  if (scrapedMeta && (scrapedMeta.inputs.length > 0 || scrapedMeta.selects.length > 0)) {
                    log.info(`[GEN] Live scrape SUCCESS: ${candidatePath} → ${scrapedMeta.inputs.length} inputs, ${scrapedMeta.selects.length} selects, ${scrapedMeta.buttons.length} buttons`)
                    break
                  }
                }
              } catch {
                log.debug(`[GEN] Live scrape: ${candidatePath} failed — trying next`)
              }
            }

            // 5. Build context from scraped metadata
            if (scrapedMeta && (scrapedMeta.inputs.length > 0 || scrapedMeta.selects.length > 0)) {
              webAppRagContext = WebMetadataService.buildContextString({
                base_url: baseOrigin,
                pages: [scrapedMeta],
              })
              log.info(`[GEN] Live scrape: injected REAL form metadata (${scrapedMeta.inputs.length} fields)`)

              // Override the conservative sessionInstruction since we now have real metadata
              sessionInstruction =
                '\n\nIMPORTANT: This is a web application project with an active login session. ' +
                'DO NOT generate any login/authentication steps. The user is ALREADY authenticated. ' +
                'Start the test from the relevant page directly using relative URL paths. ' +
                'Use ONLY field labels from the APPLICATION METADATA provided — do not invent field names. ' +
                'Generate a COMPLETE test: NAVIGATE → fill required fields → CLICK submit → ASSERT_TOAST.'
            }

            await context.close()
          } finally {
            await browser.close().catch(() => {})
          }
        }
      }
    } catch (scrapeErr) {
      log.warn({ err: scrapeErr }, '[GEN] Live page scrape failed (non-critical) — falling back to conservative prompt')
    }
  }

  // Choose the system prompt:
  //  • SF metadata found      → MCP_RAG_SYSTEM_PROMPT (understands SELECT_RECORD_TYPE, field types, etc.)
  //  • Web app metadata found → WEB_APP_RAG_SYSTEM_PROMPT (understands SPA forms, page routes, etc.)
  //  • No metadata            → STANDARD_SYSTEM_PROMPT (generic web app testing)
  const finalSystemPrompt = sfRagContext
    ? MCP_RAG_SYSTEM_PROMPT.replace('{rag_context}', sfRagContext)
    : webAppRagContext
      ? WEB_APP_RAG_SYSTEM_PROMPT
          .replace('{rag_context}', webAppRagContext)
          .replace('{test_data_context}', webTestDataContext || '(No real records available — use realistic unique placeholders)')
          .replace('{test_intent_instructions}', testIntentInstructions)
          .replace('{multi_entity_instructions}', multiEntityInstructions)
          .replace('{user_specified_values}', userSpecifiedValuesContext)
      : STANDARD_SYSTEM_PROMPT

  const finalUserPrompt = (sfRagContext || webAppRagContext)
    ? prompt  // context is now in the system prompt via {rag_context}
    : userPromptBase

  log.info(`[GEN] Standard path: using ${sfRagContext ? 'MCP_RAG_SYSTEM_PROMPT (SF metadata)' : webAppRagContext ? 'WEB_APP_RAG_SYSTEM_PROMPT (web app metadata)' : 'STANDARD_SYSTEM_PROMPT'}`)

  try {
    const rawResult = await invokeLlm(finalSystemPrompt, finalUserPrompt, provider, model)
    const normalised = normaliseResponse(rawResult)
    // Post-process: fix field-value type misalignment (e.g. names in Amount fields)
    if (isWebAppProject) {
      normalised.steps = validateFieldValueAlignment(normalised.steps)
    }
    return ensureWebAppCreateSteps(normalised, prompt, isWebAppProject, sfRagContext || webAppRagContext, globalEntityUrlMap)
  } catch (err: unknown) {
    // Auto-fallback to Claude if requested provider fails
    const providerLower = provider.toLowerCase()
    if (providerLower !== 'claude') {
      log.warn({ err }, '[GEN] Primary provider failed — falling back to Claude')
      try {
        const rawResult = await invokeLlm(finalSystemPrompt, finalUserPrompt, 'claude', undefined)
        const fallbackNormalised = normaliseResponse(rawResult)
        if (isWebAppProject) {
          fallbackNormalised.steps = validateFieldValueAlignment(fallbackNormalised.steps)
        }
        return ensureWebAppCreateSteps(fallbackNormalised, prompt, isWebAppProject, sfRagContext || webAppRagContext, globalEntityUrlMap)
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

interface ReadableStep {
  test_step:       string
  test_data:       string
  expected_result: string
  actual_result:   string
  status:          string
  comments:        string
}

const HUMANIZE_SYSTEM_PROMPT = `
You are a QA documentation specialist. Convert technical Playwright test steps into a structured, human-readable test case table format.

INPUT: A JSON array of test steps with action/target/value fields.

RULES:
1. Convert EACH step into a structured object with these columns:
   - test_step: Clear, human-readable step-by-step action (e.g. "Navigate to the Accounts list page", "Click on the New button")
   - test_data: The input values used in this step. Use the value from the step if present, otherwise use "—"
   - expected_result: What should happen after this step is executed (e.g. "Accounts list page is displayed", "New Account dialog opens")
   - actual_result: Set to "—" (will be filled after execution)
   - status: Set to "—" (will be updated after execution as Pass/Fail)
   - comments: Set to "—" (will be updated after execution with errors or defect info)
2. Do NOT include technical details like CSS selectors, role attributes, or locator types in test_step.
3. Use action-appropriate phrasing for test_step:
   - NAVIGATE → "Navigate to [page/URL]" or "Go to the [page name]"
   - CLICK → "Click on the [EXACT button/element name from the 'target' field]" — ALWAYS use the exact name from 'target'. For example if target is "Create Campaign" write "Click on the 'Create Campaign' button". NEVER substitute with "Submit" or "Save" unless 'target' literally says that.
   - TYPE → "Enter '[value]' in the [field name] field"
   - ASSERT_TEXT → "Verify that '[text]' is displayed on the page"
   - ASSERT_TOAST → "Verify success/error toast message shows '[text]'"
   - ASSERT_URL → "Verify that the page URL contains '[value]' (i.e. the form was submitted successfully and the app navigated to the [value] list page)"
   - WAIT → "Wait for [N] seconds"
   - SELECT → "Select '[value]' from the [field name] dropdown"
   - LOOKUP → "Search and select '[value]' in the [field name] lookup"
   - CHECKBOX → "Check/Uncheck the [field name] checkbox"
4. For expected_result, describe what a user would visually expect to see after the action.
5. For test_data, extract the meaningful input value (e.g. the text being typed, the URL, the selected option).

OUTPUT FORMAT:
{
  "readable_steps": [
    {
      "test_step": "Navigate to the Accounts list page",
      "test_data": "URL: /lightning/o/Account/list",
      "expected_result": "Accounts list page is displayed with the list of accounts",
      "actual_result": "—",
      "status": "—",
      "comments": "—"
    }
  ]
}

IMPORTANT: Output ONLY valid JSON. No explanations, no markdown.
`

export async function humanizeSteps(
  steps:    Record<string, unknown>[],
  provider: string = 'claude',
): Promise<{ readable_steps: ReadableStep[] }> {
  if (!steps || steps.length === 0) {
    throw { statusCode: 400, message: "A non-empty 'steps' array is required" }
  }

  const userPrompt = JSON.stringify(steps, null, 2)
  const raw        = await invokeLlm(HUMANIZE_SYSTEM_PROMPT, userPrompt, provider)

  const rawSteps = Array.isArray(raw['readable_steps']) ? raw['readable_steps'] : []

  // Normalise each step — ensure all fields exist with defaults
  const readable_steps: ReadableStep[] = rawSteps.map((s: any) => ({
    test_step:       String(s?.test_step       ?? '—'),
    test_data:       String(s?.test_data       ?? '—'),
    expected_result: String(s?.expected_result ?? '—'),
    actual_result:   String(s?.actual_result   ?? '—'),
    status:          String(s?.status          ?? '—'),
    comments:        String(s?.comments        ?? '—'),
  }))

  return { readable_steps }
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
