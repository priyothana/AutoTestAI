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
import { buildFieldManifest as buildWebAppFieldManifest } from '../ai-agents/tools/metadata-reader.tool.js'

// Layer 1: Structured output schema enforcement
import { STRUCTURED_OUTPUT_SCHEMA_INSTRUCTION } from '../../shared/types/structured-action.schema.js'

const log = createModuleLogger('test-generation')

// ── BullMQ queue (producer side only) ────────────────────────────────

const executionQueue = new Queue<ExecutionJob>(QUEUES.EXECUTION, getRedisOptions())

// ─── System Prompts (exact copy from Python ai_service.py) ──────────

const STANDARD_SYSTEM_PROMPT = `
${STRUCTURED_OUTPUT_SCHEMA_INSTRUCTION}


You are an expert QA Automation Engineer specialized in Playwright test automation.

Your task is to convert a natural language test case into a structured Playwright-compatible JSON test definition that can be executed directly by a Playwright runner.

🚨 AUTHENTICATION — READ FIRST (ABSOLUTE RULE):
- The user IS ALREADY LOGGED IN. A valid browser session with stored credentials is injected before the test starts.
- NEVER generate steps to navigate to /login, /signin, /sign-in, /auth, or any authentication page.
- NEVER generate steps to fill in a username, password, or click a "Log In" / "Sign In" button.
- If the test case name or description mentions login, it is referring to a feature being tested (e.g. contact creation) — it does NOT mean you should produce authentication steps.
- Your FIRST step MUST be a NAVIGATE to the relevant entity page (e.g. /contacts/new, /contacts, /dashboard).

IMPORTANT CONTEXT:
- The application base URL is managed separately in the Project configuration.
- NEVER use mock URLs like "https://example.com".
- For NAVIGATE steps:
  - Use relative paths like "/contacts", "/contacts/new", "/dashboard", "/accounts"
  - Do NOT use "/login" or any auth-related path — the session is already active
  - If no specific path can be inferred, use "/" (the app root)
  - The Playwright runner will automatically prepend the Project Base URL

-------------------------
GENERAL RULES
-------------------------
1. Output ONLY valid JSON (no explanations, no comments).
2. Ensure all steps are executable and valid for Playwright automation.
3. Use ACCESSIBILITY-BASED LOCATORS as the PRIMARY strategy (see Locator Priority below).
4. Avoid fragile CSS selectors like nth-child, [title=...], or class-based selectors unless absolutely necessary.
5. Always include appropriate WAIT steps before ASSERT_TEXT or CLICK if the element loads dynamically.
6. NEVER generate login/authentication steps — start directly from the relevant entity or feature page.

-------------------------
LOCATOR PRIORITY (MUST FOLLOW)
-------------------------
When generating locators for interactive elements, use this priority order:

1. getByRole (PREFERRED) — uses ARIA roles and accessible names
   Example: getByRole('button', { name: 'New Contact' })
   Example: getByRole('link', { name: 'Contacts' })
   Example: getByRole('textbox', { name: 'Full Name' })

2. getByLabel — uses form field labels
   Example: getByLabel('Full Name')
   Example: getByLabel('Phone')

3. getByText — uses visible text content
   Example: getByText('Contact created successfully')

4. CSS selector (FALLBACK ONLY) — use only when no accessible name/role exists
   Example: .toast-message, [data-testid='submit']

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
            target format: "role=button, name=New Contact" or "role=link, name=Contacts"
- "label" → page.getByLabel(target)
            target format: "Full Name" or "Phone"
- "text"  → page.getByText(target)
            target format: "Contact created successfully"
- "css"   → page.locator(target)
            target format: ".toast-message" or "[data-testid='submit']"

For NAVIGATE, WAIT, and ASSERT_TOAST actions, locator_type is not needed.

-------------------------
ACTION RULES
-------------------------

1. NAVIGATE
   - Only needs "value" (URL path)
   - Do not include target or locator_type
   - NEVER navigate to /login or any authentication URL

2. WAIT
   - value must be number of seconds as string (e.g. "3")
   - Use WAIT after navigation or before assertion when UI loads

3. TYPE
   - target must identify an input field
   - value is the text to type
   - Prefer locator_type "label" for form fields
   - Example: { "action": "TYPE", "target": "Full Name", "value": "Jane Smith", "locator_type": "label" }

4. CLICK
   - target must identify a button, link, or clickable element
   - Prefer locator_type "role" for buttons and links
   - Example: { "action": "CLICK", "target": "role=button, name=Create Contact", "locator_type": "role" }

5. ASSERT_TEXT
   - DO NOT put text inside target
   - target must identify the container element
   - value must be the expected visible text
   - Use locator_type "css" for structural selectors, "text" for text-based

   ✅ Correct:
   { "action": "ASSERT_TEXT", "target": "h1", "value": "Contacts", "locator_type": "css" }

   ❌ Wrong:
   { "action": "ASSERT_TEXT", "target": "Contacts" }

6. ASSERT_TOAST
   - Use this to verify success/error notifications (toasts, snackbars) that appear after saving, submitting, or taking an action.
   - NO target or locator_type is needed.
   - value must be the expected visible text in the toast message.
   - Example: { "action": "ASSERT_TOAST", "target": "", "value": "Contact created successfully" }

-------------------------
OUTPUT FORMAT
-------------------------
Return JSON in this structure:

{
  "name": "Concise Test Case Name",
  "description": "Detailed description of what is being tested",
  "priority": "low" | "medium" | "high",
  "preconditions": ["User is already authenticated — no login steps needed"],
  "steps": [
    {
      "id": "1",
      "action": "NAVIGATE",
      "value": "/contacts/new"
    },
    {
      "id": "2",
      "action": "TYPE",
      "target": "Full Name",
      "value": "Jane Smith",
      "locator_type": "label"
    },
    {
      "id": "3",
      "action": "CLICK",
      "target": "role=button, name=Create Contact",
      "locator_type": "role"
    },
    {
      "id": "4",
      "action": "ASSERT_TOAST",
      "target": "",
      "value": "Contact created successfully"
    }
  ],
  "expected_outcome": "Clear expected final result"
}

Generate test steps that will PASS successfully in Playwright runner.
REMEMBER: The first step MUST be NAVIGATE to the entity page — NEVER to /login.
`

const RAG_SYSTEM_PROMPT = `
${STRUCTURED_OUTPUT_SCHEMA_INSTRUCTION}


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
${STRUCTURED_OUTPUT_SCHEMA_INSTRUCTION}


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
${STRUCTURED_OUTPUT_SCHEMA_INSTRUCTION}


🚨🚨🚨 STOP — READ THIS ENTIRE PROMPT BEFORE WRITING A SINGLE STEP 🚨🚨🚨
================================================================================
⚠️  DEEP METADATA ANALYSIS MODE — GROUND EVERY STEP IN REAL CRAWLED DATA  ⚠️
================================================================================

=========================================================
DEEP METADATA ANALYSIS PHASE — MANDATORY BEFORE ANY STEP
=========================================================
Before writing the first step, you MUST complete this 5-step analysis.
The analysis answers are found in the ENTITY ANALYSIS CARD at the top of the APPLICATION METADATA.

  ANALYSIS A — ENTITY: Read the 🏷️ ENTITY line from the ENTITY ANALYSIS CARD.
    → What is the primary entity? (e.g., "Opportunity", "Contact", "Lead")

  ANALYSIS B — PAGE URL: Read the 📄 PAGE URL line.
    → What is the EXACT URL to navigate to? Copy it verbatim.
    → For CREATE: use the "Create Page" URL  (e.g., /opportunities/new)
    → For UPDATE: use the "Edit Page" URL    (e.g., /contacts/:id/edit)
    → For DELETE/SEARCH: use the "List Page" URL (e.g., /contacts)

  ANALYSIS C — REQUIRED FIELDS: Read all 🔥 REQUIRED lines in the FIELD CATALOG.
    → List EVERY required field. Count them. You MUST generate a step for each.
    → Lookup fields (marked LOOKUP) need action: "LOOKUP", not "TYPE".
    → Select fields (marked SELECT) need action: "SELECT" with a valid option.

  ANALYSIS D — SUBMIT BUTTON: Read the ⚡ SUBMIT BUTTON line.
    → What is the EXACT button name? Copy it character-for-character.
    → This is the ONLY valid button name. Do NOT use "Save", "Submit", or anything else.

  ANALYSIS E — SELF-CHECK before outputting:
    → Count REQUIRED fields in ANALYSIS C → COUNT_A
    → Count TYPE + SELECT + LOOKUP steps in your planned output → COUNT_B
    → If COUNT_B < COUNT_A: you are missing required steps. ADD THEM.
    → Does your CLICK step target EXACTLY match ANALYSIS D? If not, fix it.

=========================================================
FEW-SHOT EXAMPLES (4 complete scenarios — study ALL before generating)
=========================================================

─────────────────────────────────────────────────────────────────
EXAMPLE 1 — CREATE with Required Lookup ("Create Opportunity With Required Fields")
─────────────────────────────────────────────────────────────────
ENTITY ANALYSIS CARD from metadata:
  🏷️ ENTITY: Opportunity
  📄 PAGE URL (Create): /opportunities/new
  📄 PAGE URL (List):   /opportunities
  🔑 FIELD CATALOG:
    🔥 REQUIRED LOOKUP  "Account"           locator_type: label  → sample: "Acme Corp"
    🔥 REQUIRED INPUT   "Opportunity Name"  locator_type: label  → sample: "New Business Deal 2026"
    🔥 REQUIRED INPUT   "Close Date"        locator_type: label  → sample: "06/30/2026"
    🔥 REQUIRED SELECT  "Stage"             locator_type: label  → options: Prospecting | Qualification | Closed Won  ⚡ USE: "Prospecting"
    ✅ OPTIONAL INPUT   "Amount"            locator_type: label  → sample: "50000"
  ⚡ SUBMIT BUTTON: "Create Opportunity"  (locator_type: role)
REAL ENTITY RECORDS: { account: "Acme Corp", name: "New Business Deal 2026", close_date: "06/30/2026", stage: "Prospecting" }

PRE-FLIGHT CHECK:
  ANALYSIS A → Entity = Opportunity
  ANALYSIS B → Create URL = /opportunities/new
  ANALYSIS C → Required fields = Account (LOOKUP), Opportunity Name (TYPE), Close Date (TYPE), Stage (SELECT) — 4 fields
  ANALYSIS D → Submit button = "Create Opportunity"
  ANALYSIS E → My steps will have 4 field steps + 1 CLICK = COUNT_B = 4 ≥ COUNT_A = 4 ✓

✅ CORRECT OUTPUT:
  Step 1: { action: "NAVIGATE",  value: "/opportunities/new" }
  Step 2: { action: "LOOKUP",    target: "Account",           value: "Acme Corp",             locator_type: "label" }
  Step 3: { action: "TYPE",      target: "Opportunity Name",  value: "New Business Deal 2026", locator_type: "label" }
  Step 4: { action: "TYPE",      target: "Close Date",        value: "06/30/2026",             locator_type: "label" }
  Step 5: { action: "SELECT",    target: "Stage",             value: "Prospecting",            locator_type: "label" }
  Step 6: { action: "CLICK",     target: "Create Opportunity",                                 locator_type: "role" }
  Step 7: { action: "ASSERT_URL",value: "/opportunities" }

❌ INVALID OUTPUTS (automatic rejection):
  × { action: "CLICK", target: "Save" }                    ← "Save" is NOT the button name
  × { action: "CLICK", target: "Create" }                   ← missing entity name
  × missing Account LOOKUP step                              ← required field skipped = form will fail

─────────────────────────────────────────────────────────────────
EXAMPLE 2 — UPDATE specific field ("Update Contact Phone Number")
─────────────────────────────────────────────────────────────────
ENTITY ANALYSIS CARD from metadata:
  🏷️ ENTITY: Contact
  📄 PAGE URL (List): /contacts
  📄 PAGE URL (Edit): /contacts/:id/edit
  🔑 FIELD CATALOG (edit form):
    🔥 REQUIRED INPUT   "Full Name"   locator_type: label  → sample: "Priya Sharma"
    ✅ OPTIONAL INPUT   "Phone"       locator_type: label  → sample: "+91 98765 43210"
    ✅ OPTIONAL INPUT   "Email"       locator_type: label  → sample: "priya@example.com"
  ⚡ SUBMIT BUTTON: "Update Contact"  (locator_type: role)
REAL ENTITY RECORDS: { name: "Priya Sharma", phone: "+91 98765 43210", email: "priya@example.com" }

PRE-FLIGHT CHECK:
  ANALYSIS A → Entity = Contact
  ANALYSIS B → List URL = /contacts (navigate here to search)
  ANALYSIS C → Focus field = Phone (the field the test asks to update)
  ANALYSIS D → Submit button = "Update Contact"
  ANALYSIS E → Search for real name, open record, type Phone value, click "Update Contact" ✓

✅ CORRECT OUTPUT:
  Step 1: { action: "NAVIGATE", value: "/contacts" }
  Step 2: { action: "TYPE",     target: "searchbox",      value: "Priya Sharma",    locator_type: "role" }
  Step 3: { action: "CLICK",    target: "Priya Sharma",                              locator_type: "text" }
  Step 4: { action: "TYPE",     target: "Phone",           value: "+91 98765 43210", locator_type: "label" }
  Step 5: { action: "CLICK",    target: "Update Contact",                            locator_type: "role" }
  Step 6: { action: "ASSERT_URL",value: "/contacts" }

❌ INVALID OUTPUTS:
  × Step 4: { target: "Phone", value: "priya@example.com" }   ← email in Phone field (DATA TYPE ERROR)
  × Step 5: { target: "Save" }                                  ← wrong button name
  × Step 2: { target: "Phone", locator_type: "label" }         ← label locator on LIST page search (wrong)

─────────────────────────────────────────────────────────────────
EXAMPLE 3 — DELETE with confirmation dialog ("Delete Contact")
─────────────────────────────────────────────────────────────────
ENTITY ANALYSIS CARD from metadata:
  🏷️ ENTITY: Contact
  📄 PAGE URL (List): /contacts
  🔑 BUTTONS:
    ⚡ ACTION MENU BUTTON: "More"  (opens dropdown with secondary actions)
    ⚡ SUBMENU ITEM:       "Delete"  [SUBMENU under "More" — click "More" first]
    ⚡ CONFIRM BUTTON:     "Delete Contact"  (appears in confirmation dialog)
REAL ENTITY RECORDS: { name: "Ravi Kumar" }

PRE-FLIGHT CHECK:
  ANALYSIS B → List URL = /contacts (search for record here)
  ANALYSIS D → Confirmation button = "Delete Contact"
  NOTE: Delete is a SUBMENU item — must click "More" first

✅ CORRECT OUTPUT:
  Step 1: { action: "NAVIGATE",   value: "/contacts" }
  Step 2: { action: "TYPE",       target: "searchbox",    value: "Ravi Kumar",    locator_type: "role" }
  Step 3: { action: "CLICK",      target: "Ravi Kumar",                           locator_type: "text" }
  Step 4: { action: "CLICK",      target: "More",                                 locator_type: "role" }  ← MUST open menu first
  Step 5: { action: "CLICK",      target: "Delete",                               locator_type: "text" }  ← menu item
  Step 6: { action: "CLICK",      target: "Delete Contact",                       locator_type: "role" }  ← MANDATORY confirm dialog
  Step 7: { action: "ASSERT_URL", value: "/contacts" }

❌ INVALID OUTPUTS:
  × Step 4: { target: "Delete" }  ← can't click Delete without opening "More" menu first
  × missing Step 6               ← confirm dialog stays open, redirect never happens

─────────────────────────────────────────────────────────────────
EXAMPLE 4 — SEARCH / FILTER ("Search Contact By Name")
─────────────────────────────────────────────────────────────────
ENTITY ANALYSIS CARD from metadata:
  🏷️ ENTITY: Contact
  📄 PAGE URL (List): /contacts
  🔑 LIST PAGE ELEMENTS:
    🔍 SEARCH BOX: role=searchbox (placeholder: "Search contacts...")
REAL ENTITY RECORDS: { name: "Anjali Menon", email: "anjali@company.com" }

✅ CORRECT OUTPUT:
  Step 1: { action: "NAVIGATE",     value: "/contacts" }
  Step 2: { action: "TYPE",         target: "searchbox",    value: "Anjali Menon",  locator_type: "role" }
  Step 3: { action: "ASSERT_TEXT",  target: ".results",     value: "Anjali Menon",  locator_type: "css" }

❌ INVALID OUTPUTS:
  × Step 2: { target: "Contact Name", locator_type: "label" }  ← label locator on LIST page (wrong)
  × missing ASSERT_TEXT                                          ← search test must verify results

=========================================================
END FEW-SHOT EXAMPLES
=========================================================

================================================================================
⚙️  GROUNDING RULES — READ ALL 8 RULES BEFORE GENERATING ANY STEP
================================================================================

RULE 1 — DEEP METADATA ANALYSIS FIRST (NON-NEGOTIABLE):
  Before generating any step, you MUST complete the 5-step DEEP METADATA ANALYSIS
  PHASE defined above. The ENTITY ANALYSIS CARD at the top of APPLICATION METADATA
  gives you the exact URL, fields, and button name to use.
  ❌ NEVER skip this analysis. ❌ NEVER guess fields or URLs without checking the card.

RULE 2 — REQUIRED FIELDS ARE ABSOLUTE:
  Any field tagged 🔥 REQUIRED in the ENTITY ANALYSIS CARD MUST have a step.
  This applies to ALL types — input, select, lookup, checkbox.
  ❌ NEVER skip a required field. The form WILL reject the submission without it.
  ❌ ANY output missing a required field is INVALID and will be rejected.

RULE 3 — LOOKUP FIELDS USE LOOKUP ACTION (zero exceptions):
  Any field referencing another entity (Account, Contact, Owner, Parent, etc.)
  that is tagged REQUIRED MUST use action: "LOOKUP" — NOT action: "TYPE".
  Use a real value from REAL ENTITY RECORDS or a plausible name like "Acme Corp".
  ❌ NEVER skip a required lookup field.
  ❌ NEVER use TYPE instead of LOOKUP for a lookup/reference field.

RULE 4 — BUTTON NAME MUST BE EXACT (ZERO TOLERANCE):
  The submit button name is in the ENTITY ANALYSIS CARD as ⚡ SUBMIT BUTTON: "...".
  Copy that name CHARACTER-FOR-CHARACTER. Treat it as a locked string.
  ✅ If card shows "Create Opportunity" → target MUST BE exactly "Create Opportunity"
  ✅ If card shows "Update Contact" → target MUST BE exactly "Update Contact"
  ✅ If card shows "Save Changes" → target MUST BE exactly "Save Changes"
  ❌ NEVER use "Save", "Submit", "OK", "Update", or ANY other assumed name.
  ❌ NEVER combine entity name with test data (e.g. "Create Tara" = WRONG, "Create Opportunity" = RIGHT).
  ❌ For UPDATE tests: the edit form button is ALWAYS different from the create button. Read it from metadata.

RULE 5 — REAL TEST DATA IS MANDATORY:
  Use values from REAL ENTITY RECORDS for all TYPE/SELECT/LOOKUP/CHECKBOX steps.
  ❌ NEVER use placeholders like "Test Contact", "John Doe", "test@example.com".
  ❌ NEVER invent record names. Use ACTUAL values from the REAL ENTITY RECORDS section.
  ✅ When real data is available for a field, ALWAYS use it over any invented value.

RULE 6 — SEMANTIC DATA TYPE ALIGNMENT:
  Each field value MUST match the field's expected data type.
  • Phone / Mobile → phone number (digits, spaces, dashes, + country code)
  • Email → email address (contains @ and a domain suffix)
  • Name / Title → person or company name string
  • Date fields → MM/DD/YYYY format
  • Amount / Price → numeric digits only
  ❌ NEVER put an email address into a Phone field.
  ❌ NEVER put a phone number into an Email field.
  ❌ NEVER put a name into an Amount or Date field.

RULE 7 — SEARCH STEP LOCATOR ON LIST PAGES:
  When an UPDATE or DELETE test searches for a record on the list page:
  ✅ Use:  { action: "TYPE", target: "searchbox", locator_type: "role" }
  ✅ Or:   { action: "TYPE", target: "Search...", locator_type: "placeholder" }
  ❌ NEVER use a form field label ("Name", "Phone", "Company") for the list-page search step.
  ❌ NEVER use locator_type: "label" for the list-page search step.

RULE 8 — URL MUST EXACTLY MATCH METADATA:
  Use ONLY URLs that appear in the ENTITY ANALYSIS CARD under 📄 PAGE URL.
  ❌ NEVER invent a URL. ❌ NEVER shorten /admin/contacts to /contacts.
  ❌ NEVER append /new or /create to a URL unless the metadata shows that suffix.
  ❌ NEVER guess a URL by combining an entity name with a path pattern (e.g. NEVER write /invoices/custom-fields just because entity is "Invoice Custom Fields").
  ⚠ IF the ENTITY ANALYSIS CARD shows "⚠ UNKNOWN" for the page URL:
    → DO NOT generate a NAVIGATE step with an invented path.
    → Instead, generate a NAVIGATE step to "/" (app root) and add a CLICK step on the sidebar/navigation link for the entity.
    → Example when URL is unknown: { action: "NAVIGATE", value: "/" } then { action: "CLICK", target: "Terms and Conditions", locator_type: "text" }

================================================================================
🚨🚨🚨 END OF GROUNDING RULES BLOCK 🚨🚨🚨
================================================================================

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
ENTITY METADATA PRE-FLIGHT (MANDATORY — do this before writing ANY step)
-------------------------
Before generating a SINGLE step:

STEP A — Identify PRIMARY ENTITY from the test case name (e.g. "Opportunity", "Account", "Contact").
STEP B — Find the MANDATORY CHECKLIST in the APPLICATION METADATA block below.
          The checklist shows every required field with 🔥 REQUIRED LOOKUP or [REQUIRED] tags.
STEP C — Count how many required fields are in the checklist. Your steps MUST cover all of them.
STEP D — Find the ⚡ BUTTON NAME in the APPLICATION METADATA. Copy it EXACTLY into the CLICK step.
          For UPDATE tests: look for ⚡ BUTTON NAME with "Update" or "Save Changes" pattern.
          For CREATE tests: look for ⚡ BUTTON NAME with "Create" or "Add" pattern.
STEP E — Write the steps array only after steps A–D are complete.

-------------------------
CRUD-ACTION GUARD (READ BEFORE GENERATING ANY STEPS)
-------------------------
The test prompt determines which action type you must perform. Read it carefully:

• If prompt contains CREATE / ADD / NEW / REGISTER / SUBMIT / "WITH REQUIRED FIELDS"  →  TEST TYPE = CREATE
  ✅ Correct flow: NAVIGATE to create/new page → fill ALL [REQUIRED] fields → CLICK submit button → ASSERT_URL
  ⛔ WRONG: DO NOT type into search boxes, filter dropdowns, or assert list content
  ⛔ WRONG: DO NOT navigate to the list page and stop — you must open the CREATE FORM
  ⛔ WRONG: DO NOT omit any [REQUIRED] field — including required LOOKUP fields

  🔴 SPECIAL RULE — "WITH REQUIRED FIELDS" in test name:
  When the test case name or description contains the phrase "With Required Fields" or "Required Fields",
  you MUST include a step for EVERY SINGLE [REQUIRED] field shown in the metadata — no exceptions.
  Required LOOKUP fields (like Account, Contact, Owner) MUST use a LOOKUP action with a real value.

• If prompt contains SEARCH / FIND / FILTER / LOOK UP / QUERY  →  TEST TYPE = SEARCH
  ✅ Correct flow: NAVIGATE to list page → TYPE into search box → ASSERT_TEXT for result
  ⛔ WRONG: DO NOT fill a create form for a search test

• If prompt contains UPDATE / EDIT / MODIFY / CHANGE  →  TEST TYPE = UPDATE
  ✅ Correct flow: NAVIGATE to list page → find REAL record from REAL ENTITY RECORDS → open it → edit fields → CLICK exact ⚡ BUTTON NAME → ASSERT_URL
  ⛔ CRITICAL: The update/edit form has a SPECIFIC button name (e.g. "Update Contact", "Save Changes").
              You MUST use the EXACT button name from the ⚡ BUTTON NAME in APPLICATION METADATA.
              NEVER use "Save", "Submit", or "Update" alone — always the full exact name.
  ⛔ WRONG: DO NOT use generic button names like "Save" or "Submit" for UPDATE tests.

• If prompt contains DELETE / REMOVE / ARCHIVE  →  TEST TYPE = DELETE
  ✅ Correct flow: find existing record → delete it → assert it is gone

CRITICAL: The user's TEST TYPE dictates the entire step sequence.
If the metadata context shows BOTH list-page fields (search box, filter dropdowns) AND create-form fields,
you MUST use the create-form fields for a CREATE test, and IGNORE the list-page search/filter fields.

-------------------------
APPLICATION METADATA
(Exact pages, fields, locators, and sample values derived from your web application)
-------------------------
{rag_context}

-------------------------
MANDATORY FIELD RULES
-------------------------
1. Fill EVERY field tagged [REQUIRED] — the test WILL FAIL without them.
   ‼ This includes LOOKUP fields (e.g. Account, Contact, Owner). A required LOOKUP field MUST use the LOOKUP action.
   ‼ Do NOT skip a [REQUIRED] field just because it is a lookup or reference type — use a real value from REAL ENTITY RECORDS.
2. For TYPE fields: use the ⚡ SAMPLE VALUE shown beside each field.
3. For SELECT (dropdown) fields: use the ⚡ USE value shown, which is always from [VALID OPTIONS].
   - NEVER use a value that is NOT in the [VALID OPTIONS] list — the test WILL FAIL with an invalid option.
   - If the user explicitly asks you to select a specific value (e.g. "Tara") but it is NOT listed in [VALID OPTIONS], you MUST IGNORE the user's value and use one of the values from [VALID OPTIONS] instead. DO NOT HALLUCINATE OR BLINDLY TRUST THE USER.
4. For optional fields: add a step ONLY if the field is mentioned in the test prompt.
5. STRICT ANTI-HALLUCINATION RULE FOR FIELDS:
   - NEVER generate a step for a field that is NOT EXPLICITLY LISTED in the metadata.
   - If the user's prompt names a field that doesn't exist (e.g. "First Name" and "Last Name"), but the metadata has a combined field (e.g. "Account Name"), you MUST adapt to the metadata. Do NOT invent "First Name" or "Last Name" fields.
   - NEVER split one logical value across multiple hallucinated fields. Always use the EXACT locator string provided in the metadata.
6. FIELD-TO-VALUE SEMANTIC MAPPING (prevents cross-type data errors):
   - Phone / Mobile fields   → MUST receive a phone number (digits, spaces, dashes, +code)
   - Email fields            → MUST receive an email address (contains @ and a domain)
   - Name / Title fields     → MUST receive a person or company name string
   - Date fields             → MUST receive MM/DD/YYYY format
   - Amount / Numeric fields → MUST receive digits only
   ❌ NEVER put an email address into a Phone field
   ❌ NEVER put a phone number into an Email field
   ❌ NEVER put a name into an Amount or Date field
   ✅ Match the DATA TYPE of the value to the DATA TYPE of the field — always
7. PLACEHOLDER TEXT PROHIBITION (absolute rule):
   ❌ NEVER output literal instruction text as a step value, such as:
      - "real contact name from REAL ENTITY RECORDS"
      - "first real record"
      - "<search term>" or "[contact name]"
      These are INSTRUCTIONS TO YOU — replace them with the ACTUAL value from the data.
   ✅ If the REAL ENTITY RECORDS section contains a name like "Priya Sharma", use "Priya Sharma" — not a description of where to find it.
-------------------------
FIELD ACTION MAPPING
-------------------------
tag: input   → action: TYPE    (locator_type: "label" or "placeholder")
tag: select  → action: SELECT  (use the exact option text shown in [VALID OPTIONS])
tag: checkbox→ action: CHECKBOX (value: "true" or "false")
tag: lookup  → action: LOOKUP  (locator_type: "label" | value: a real record name from REAL ENTITY RECORDS)
button       → action: CLICK   (locator_type: "role")

⚠ LOOKUP FIELDS (critical — these are required references to other entities):
   - Any [REQUIRED] field that references another entity (e.g. "Account", "Contact", "Owner") MUST use the LOOKUP action.
   - The value MUST be a real record name from REAL ENTITY RECORDS (e.g. an actual account name, not "Test Account").
   - If no real value is available, use a plausible name such as "Acme Corp" for Account or "John Smith" for Contact.
   - NEVER skip a required lookup field — the form will refuse to save without it.

⛔ SKIP fields: Any field marked with "⛔ SKIP" in the metadata has NO known valid options in the database.
   - You MUST omit that SELECT step entirely — do NOT generate it even if the user's prompt mentions a value for it.
   - Generating a step with an invented value for a ⛔ SKIP field will cause an immediate test failure.

-------------------------
SUBMIT BUTTON RULES (CRITICAL)
-------------------------
- The "Submit Buttons" section in the metadata lists the EXACT button names available on each page.
- For CLICK steps that submit a form, you MUST use the EXACT locator string from the "Submit Buttons" section.
- NEVER use generic names like "Submit", "Save", or "OK" unless that is the EXACT button name shown in the metadata.
- NEVER invent a button name by combining entity name + test data (e.g. NEVER write "Create Aero" when entity is Campaign).
- Example: if metadata shows  ⚡ BUTTON NAME: "Create Opportunity"  — your CLICK step MUST have target: "Create Opportunity", locator_type: "role".
- If no Submit Buttons section is present for a page, DO NOT invent a button name. Instead: navigate to the list page and use a CLICK step with the exact text visible in the UI (e.g. "⚡ PRIMARY ACTION BUTTON" from the ENTITY ANALYSIS CARD). NEVER assume "Create [Entity]" or "Save [Entity]" — these are likely wrong for custom web apps.
- The button name comes ONLY from the metadata. If the metadata shows "+ New Lead", use "+ New Lead". If it shows "New Lead", use "New Lead". Never transform or rewrite the button name.


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
SEARCH STEP LOCATOR RULES (UPDATE/DELETE tests)
-------------------------
When an UPDATE or DELETE test searches for a record on the list page, the search input MUST use:
  locator_type: "role"         → target: "searchbox"         (preferred — works for aria searchbox role)
  OR
  locator_type: "placeholder"  → target: "Search..."          (use the actual placeholder text from metadata)

❌ NEVER use a form-field label like "TITLE", "Name", "Company", "First Name" as the TYPE target for the search step.
   Those labels exist on the EDIT FORM, not on the list page search bar.
❌ NEVER use locator_type: "label" for the list-page search step.

The correct UPDATE search step JSON is:
  { "action": "TYPE", "target": "searchbox", "value": "<actual contact name>", "locator_type": "role" }
  OR if the page metadata shows a placeholder:
  { "action": "TYPE", "target": "Search contacts...", "value": "<actual contact name>", "locator_type": "placeholder" }

After the search TYPE step, click on the matching row/link:
  { "action": "CLICK", "target": "<actual contact name>", "locator_type": "text" }

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

• Amount / Currency / Price fields       → MUST be NUMERIC (e.g., "50000", "1000.50")
• Date / Close Date / Due Date fields    → MUST be DATE format MM/DD/YYYY (e.g., "06/30/2026")
• Probability / Percentage fields        → MUST be NUMERIC percentage (e.g., "75", "90")
• Stage / Status / State / Phase fields       → MUST be a valid option from the field's picklist (e.g., "Active", "Completed", "Pending", "Approved")
• Industry / Sector / Vertical / Segment fields → MUST be an INDUSTRY CATEGORY name (e.g., "Technology", "Healthcare", "Finance",
                                           "Retail", "Manufacturing", "Education", "Consulting", "Banking")
                                           ❌ NEVER put a person's name (e.g., a test user's name) in an Industry field
                                           ❌ NEVER put status words (e.g., "Active", "New", "Draft") in an Industry field
• Lookup / Reference / Name fields           → MUST be a REAL ENTITY NAME that exists in the system (e.g., "Sample Org Ltd", "Global Entity Inc")
                                           ❌ NEVER put status words (e.g., "Active", "New") in a lookup/name field
                                           ❌ NEVER put a bare phone number or date in a name/lookup field
• Phone / Mobile / Tel / Fax fields         → MUST be a PHONE NUMBER (digits, spaces, dashes, +country code)
                                           ✅ e.g., "+1 555-123-4567"  ❌ NOT a URL  ❌ NOT a plain number like "1234343"
• Website / URL / Link / Homepage fields    → MUST be a full URL starting with http:// or https://
                                           ✅ e.g., "https://www.example.com"  ❌ NOT a phone number  ❌ NOT a plain number like "823462434234"
• Email / E-mail / Mail fields              → MUST be an email address with @ and a domain suffix
                                           ✅ e.g., "user@example.com"  ❌ NOT a phone number or URL

❌ NEVER put a person's name (e.g., a test user's name) in an Amount or Numeric field
❌ NEVER put a date in a Stage, Status, or Industry field
❌ NEVER put a status/stage value in an Industry or Lookup/Reference field
❌ NEVER put a numeric value in a Name or Website field
❌ NEVER put a URL in a Phone / Mobile field
❌ NEVER put a plain number (e.g., "823462434234") in a Website / URL field — this is NOT a URL

If the scraped data or sample values show a field→value pair that violates these type rules,
DISCARD that value and generate a correct type-appropriate value instead.
For Industry/Sector fields with no metadata options: default to "Technology".
For Website/URL fields with no metadata: default to "https://www.example.com".
For Lookup/Reference/Name fields with no data: default to a realistic entity name like "Sample Organization Ltd".


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

-------------------------
ENTITY SCOPE LOCK (CRITICAL — READ FIRST)
-------------------------
The user's test case name and description define the SOLE entity you must test.

RULE: Identify the PRIMARY ENTITY from the test prompt (e.g. "Create an account" → entity = Account).
Then STRICTLY follow these constraints:
- ONLY navigate to pages that belong to the primary entity (e.g. /accounts, /accounts/new, /accounts/create)
- NEVER navigate to an unrelated page (e.g. if the entity is Account, do NOT navigate to /roles, /admin/roles, /users, /campaigns, etc.)
- ONLY fill fields that exist on the primary entity's create/edit form
- NEVER use field names, buttons, or page paths from a different entity
- If the metadata provides context for multiple entity pages, use ONLY the pages matching the primary entity
- If no matching page metadata is provided, generate generic steps for the primary entity only

Example:
  Prompt: "Create an account for Lara"
  PRIMARY ENTITY: Account
  ✅ Correct NAVIGATE: /accounts OR /accounts/new OR /accounts/create
  ❌ WRONG NAVIGATE: /roles, /admin/roles, /users, /campaigns, /admin/anything
  ✅ Correct fields: Account Name, Industry, Website, Phone, etc.
  ❌ WRONG fields: Role Name, Permissions, User fields

IMPORTANT: Output ONLY valid JSON. No explanations, no comments, no markdown.
ALWAYS use exact field labels from the metadata. NEVER invent field names.
EVERY [REQUIRED] field MUST have a TYPE/SELECT/CHECKBOX step using a REAL value.
EVERY field value MUST match its expected data type (see FIELD-VALUE TYPE ALIGNMENT above).
`


// ── Semantic field-value type validator ──────────────────────────────
// Detects a field's expected data type from its locator label and validates
// that the resolved sample value is semantically appropriate.
// If the stored value is mismatched (e.g. a number in a Website field or a URL
// in a Phone field), a correct fallback value is returned instead so that
// the LLM never receives misleading sample data.

type SemanticFieldType = 'phone' | 'email' | 'url' | 'date' | 'numeric' | 'name' | 'text'

const SEMANTIC_FIELD_PATTERNS: Array<{ pattern: RegExp; type: SemanticFieldType; fallback: string }> = [
  { pattern: /\b(phone|mobile|cell|tel|telephone|fax|contact\s*number|mobile\s*number|phone\s*number)\b/i, type: 'phone',   fallback: '+1 555-123-4567' },
  { pattern: /\b(email|e-mail|mail)\b/i,                                                                   type: 'email',   fallback: 'user@example.com' },
  { pattern: /\b(website|url|link|homepage|web\s*address|site)\b/i,                                        type: 'url',     fallback: 'https://www.example.com' },
  { pattern: /\b(date|dob|birth|expiry|deadline|close\s*date|start\s*date|end\s*date|due\s*date)\b/i,     type: 'date',    fallback: '06/30/2026' },
  { pattern: /\b(amount|price|cost|revenue|budget|salary|value|qty|quantity|number|count|total)\b/i,       type: 'numeric', fallback: '50000' },
  { pattern: /\b(name|title|full\s*name|first\s*name|last\s*name|company|account\s*name)\b/i,              type: 'name',    fallback: 'Sample Organization Ltd' },
]

/** Classify the expected semantic type of a field from its locator label. */
function classifyFieldSemanticType(fieldLabel: string): SemanticFieldType {
  const clean = fieldLabel.trim()
  for (const rule of SEMANTIC_FIELD_PATTERNS) {
    if (rule.pattern.test(clean)) return rule.type
  }
  return 'text'
}

/** Return the hard-coded fallback sample value for a given semantic type. */
function getFallbackForSemanticType(type: SemanticFieldType): string {
  return SEMANTIC_FIELD_PATTERNS.find(r => r.type === type)?.fallback ?? ''
}

/**
 * Validate that `value` is semantically appropriate for `fieldLabel`.
 * Returns `value` unchanged when it matches, or a type-appropriate fallback
 * when it does not (e.g. numeric string for a Website field → https://www.example.com).
 */
function validateAndFixSampleValue(fieldLabel: string, value: string): string {
  if (!value) return value
  const expectedType = classifyFieldSemanticType(fieldLabel)
  if (expectedType === 'text') return value  // no strong type constraint → keep as-is

  const v = value.trim()

  const isPhone   = (s: string) => /^[+\d][\d\s\-().]{5,}$/.test(s)
  const isEmail   = (s: string) => /@/.test(s) && /\.[a-z]{2,}$/i.test(s)
  const isUrl     = (s: string) => /^https?:\/\//i.test(s) || /^www\./i.test(s)
  const isDate    = (s: string) => /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s) || /^\d{4}-\d{2}-\d{2}/.test(s)
  const isNumeric = (s: string) => /^[\d,]+\.?\d*$/.test(s.replace(/[\s$€£¥₹%]/g, ''))

  let valueMatchesType = false
  switch (expectedType) {
    case 'phone':   valueMatchesType = isPhone(v) && !isEmail(v) && !isUrl(v); break
    case 'email':   valueMatchesType = isEmail(v); break
    case 'url':     valueMatchesType = isUrl(v); break
    case 'date':    valueMatchesType = isDate(v); break
    case 'numeric': valueMatchesType = isNumeric(v); break
    case 'name':    valueMatchesType = !isPhone(v) && !isEmail(v) && !isUrl(v) && !isDate(v) && !isNumeric(v); break
  }

  if (!valueMatchesType) {
    const fallback = getFallbackForSemanticType(expectedType)
    return fallback  // return correct semantic fallback; empty string keeps original
  }
  return value
}

// ── Depluralization helper ────────────────────────────────────────────
// Handles common English plural → singular conversion:
//   opportunities → opportunity  (ies → y)
//   addresses     → address      (sses → ss)
//   boxes         → box          (xes → x)
//   campaigns     → campaign     (s → ∅)
//   status        → status       (already singular)
function depluralize(word: string): string {
  const w = word.toLowerCase()
  if (w.endsWith('ies') && w.length > 4)  return w.slice(0, -3) + 'y'   // opportunities → opportunity
  if (w.endsWith('sses'))                  return w.slice(0, -2)         // addresses → address (via 'esses' actually 'sses')
  if (w.endsWith('ches') || w.endsWith('shes') || w.endsWith('xes') || w.endsWith('zes'))
    return w.slice(0, -2)                                                // boxes → box, watches → watch
  if (w.endsWith('ses') && w.length > 4)   return w.slice(0, -1)         // cases → case  (keep the 'e')
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is') && w.length > 3)
    return w.slice(0, -1)                                                // campaigns → campaign
  return w                                                               // status, analysis → unchanged
}

// ── LLM factory ───────────────────────────────────────────────────────

function buildLlm(provider: string, model?: string): BaseChatModel {
  const providerLower = provider.toLowerCase().trim()

  if (providerLower === 'openai') {
    const modelName = model ?? 'gpt-4o'
    return new ChatOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      model:  modelName,
      temperature: 0.7,
    })
  }

  if (providerLower === 'claude') {
    const modelName = model ?? (process.env.CLAUDE_MODEL ?? (process.env.LLM_MODEL ?? 'claude-sonnet-4-20250514'))
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

export async function retrieveRagChunks(
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

    // Build tokenized representations for compound entity names
    // e.g. "Invoice Custom Fields" → tokens: ['invoice', 'custom', 'fields']
    //      slug: 'invoice-custom-fields' or 'invoicecustomfields'
    const targetTokenSets = targetLowers.map(t => {
      const tokens = t.split(/[\s_-]+/).filter(Boolean)
      const slug   = tokens.join('-')
      const noslug = tokens.join('')
      return { original: t, tokens, slug, noslug }
    })

    const pathMatched = chunks.filter(c => {
      const lower = c.toLowerCase()
      return targetTokenSets.some(({ original, tokens, slug, noslug }) => {
        // Single-word: exact path segment matching
        if (tokens.length === 1) {
          return (
            lower.includes(`/ ${original}`) ||
            lower.includes(`/${original}/`) ||
            lower.includes(`/${original}\n`) ||
            lower.includes(`/${original} `) ||
            !!lower.match(new RegExp(`(?:page:|path:)\\s*/${original}`, 'i'))
          )
        }
        // Multi-word: match hyphenated slug, no-separator slug, OR ordered tokens in path
        const slugMatch  = lower.includes(`/${slug}/`) || lower.includes(`/${slug}\n`) || lower.includes(`/${slug} `) || lower.includes(`/${slug}`)
        const nosepMatch = lower.includes(`/${noslug}/`) || lower.includes(`/${noslug}`)
        if (slugMatch || nosepMatch) return true
        // Token-sequence: check if the path contains all tokens in sequence (possibly with separators)
        const tokenPattern = new RegExp(tokens.map(tok => tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[/_-]'), 'i')
        return tokenPattern.test(lower)
      })
    })

    // Return ONLY the matched chunks — if none match, return empty so the
    // LLM falls back to the standard prompt rather than using unrelated pages.
    return pathMatched
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
  const skipWords = new Set(['record', 'entry', 'form', 'item', 'test', 'case', 'step', 'the', 'a', 'an', 'new', 'with', 'for', 'to', 'and', 'convert',
    'create', 'update', 'edit', 'delete', 'view', 'add', 'successfully', 'success', 'details', 'detail'])
  
  const targets = new Set<string>()

  // ── Phase 1: Multi-word compound entity extraction (highest priority) ───────
  // Matches 2-4 consecutive non-stop words after a verb or before an action word.
  // This handles entities like "Terms and Conditions", "Invoice Custom Fields",
  // "Credit Notes", etc., which are compound noun phrases.
  const COMPOUND_AFTER_VERB = /\b(?:create|update|edit|delete|view|add|manage)\s+(?:a\s+|an\s+|new\s+)?([A-Z][a-zA-Z]+(?:\s+(?:and\s+|&\s+)?[A-Z][a-zA-Z]+){1,3})\b/g
  const COMPOUND_BEFORE_ACTION = /\b([A-Z][a-zA-Z]+(?:\s+(?:and\s+|&\s+)?[A-Z][a-zA-Z]+){1,3})\s+(?:successfully|details?|list|management|page|form)\b/g

  for (const pattern of [COMPOUND_AFTER_VERB, COMPOUND_BEFORE_ACTION]) {
    for (const match of prompt.matchAll(pattern)) {
      const phrase = match[1]?.trim()
      if (phrase && phrase.split(/\s+/).length >= 2) {
        // Add the FULL phrase AND each word as individual targets
        targets.add(phrase)
        for (const word of phrase.split(/\s+/)) {
          const w = word.toLowerCase().replace(/[^a-z]/g, '')
          if (w.length > 2 && !skipWords.has(w)) targets.add(w.charAt(0).toUpperCase() + w.slice(1))
        }
      }
    }
  }

  // ── Phase 2: Standard single-word extraction patterns ────────────────────────
  const patterns = [
    /\b(?:create|add|convert)\b\s+(?:a\s+)?(?:new\s+)?(\w[\w\s]*?)(?:\s+record|\s+for|\s+with|\s+to|\s*$)/g,
    /\bnew\s+(\w+)(?:\s+(\w+))?/g,
    /\b(\w+)\s+(?:creation|form|page|layout|list|conversion)\b/g,
  ]

  for (const pattern of patterns) {
    for (const match of lower.matchAll(pattern)) {
      const word = match[1]?.trim()
      if (word && !skipWords.has(word)) {
        targets.add(word)
      }
    }
  }

  // ── Phase 3: Common Salesforce objects ───────────────────────────────────────
  const standardObjects = ['lead', 'account', 'contact', 'opportunity', 'case', 'task', 'event', 'campaign', 'quote', 'contract', 'order']
  for (const obj of standardObjects) {
    const regex = new RegExp(`\\b${obj}\\b`, 'i')
    if (regex.test(lower)) {
      targets.add(obj.charAt(0).toUpperCase() + obj.slice(1))
    }
  }

  // ── Phase 4: Custom objects ending in __c ────────────────────────────────────
  const customObjRegex = /\b(\w+__c)\b/gi
  for (const match of lower.matchAll(customObjRegex)) {
    if (match[1]) targets.add(match[1])
  }

  // ── Phase 5: Format and deduplicate ──────────────────────────────────────────
  const formattedTargets = Array.from(targets).map(t => {
    if (t.toLowerCase().endsWith('__c')) return t  // preserve __c casing
    // Multi-word phrases: TitleCase each word
    if (t.includes(' ')) return t.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
    return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()
  })

  // Sort: longer (more specific) phrases first so they get priority in matching
  return Array.from(new Set(formattedTargets)).sort((a, b) => b.length - a.length)
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
  // DELETE must be checked BEFORE UPDATE — "delete" tests contain "delete" not "update"
  if (/\b(delete|remove|archive|deactivate)\b/.test(p))         return 'delete'
  if (/\b(create|add|new|insert|register|submit)\b/.test(p))    return 'create'
  if (/\b(update|edit|modify|change|set)\b/.test(p))            return 'update'
  if (/\b(search|filter|find|look.?up|query|browse)\b/.test(p)) return 'search'
  if (/\b(verify|assert|check|validate|confirm|view)\b/.test(p)) return 'verify'
  return 'general'
}

// ─── Focus Field Extraction ───────────────────────────────────────────────────
//
// Parses an UPDATE/EDIT prompt for the specific field being modified.
// Examples:
//   "Update Contact Phone Number"    → { label: "Phone",   semanticType: "phone" }
//   "Edit Lead Email Address"        → { label: "Email",   semanticType: "email" }
//   "Modify Opportunity Close Date"  → { label: "Close Date", semanticType: "date" }
//   "Update Account Name"            → { label: "Name",    semanticType: "name" }
//
// Returns null when no specific field is detected (general update).

interface FocusField {
  label:        string   // e.g. "Phone Number" → "Phone"
  semanticType: 'phone' | 'email' | 'name' | 'date' | 'number' | 'address' | 'text'
  dataRule:     string   // human-readable rule injected into the prompt
}

function extractFocusField(prompt: string): FocusField | null {
  const p = prompt.toLowerCase()

  const FIELD_PATTERNS: Array<{ pattern: RegExp; label: string; semanticType: FocusField['semanticType']; dataRule: string }> = [
    {
      pattern: /\b(phone|mobile|cell|telephone|contact number|phone number|mobile number)\b/,
      label: 'Phone', semanticType: 'phone',
      dataRule: 'The Phone field MUST receive a PHONE NUMBER value (digits, spaces, dashes, +country code). NEVER put an email address or name into the Phone field.',
    },
    {
      pattern: /\b(email|e-mail|email address|mail)\b/,
      label: 'Email', semanticType: 'email',
      dataRule: 'The Email field MUST receive an EMAIL ADDRESS value (contains @ and a domain). NEVER put a phone number or name into the Email field.',
    },
    {
      pattern: /\b(close date|due date|start date|end date|date of birth|birth date|expiry date|deadline)\b/,
      label: 'Close Date', semanticType: 'date',
      dataRule: 'The Date field MUST receive a DATE value in MM/DD/YYYY format. NEVER put a name or phone number into a date field.',
    },
    {
      pattern: /\b(account name|contact name|company name|full name|first name|last name|lead name|opportunity name)\b/,
      label: 'Name', semanticType: 'name',
      dataRule: 'The Name field MUST receive a PERSON or COMPANY NAME. NEVER put an email or phone number into the Name field.',
    },
    {
      pattern: /\b(address|street|city|state|zip|postal|country)\b/,
      label: 'Address', semanticType: 'address',
      dataRule: 'The Address field MUST receive an ADDRESS value. NEVER put a phone number or email into an address field.',
    },
    {
      pattern: /\b(amount|price|cost|revenue|budget|salary|value)\b/,
      label: 'Amount', semanticType: 'number',
      dataRule: 'The Amount field MUST receive a NUMERIC value (digits only, no letters). NEVER put a name or date into a numeric field.',
    },
    {
      pattern: /\b(website|url|link|homepage)\b/,
      label: 'Website', semanticType: 'text',
      dataRule: 'The Website field MUST receive a URL value (starts with http:// or https://). NEVER put a phone number or email into a URL field.',
    },
  ]

  for (const fp of FIELD_PATTERNS) {
    if (fp.pattern.test(p)) {
      return { label: fp.label, semanticType: fp.semanticType, dataRule: fp.dataRule }
    }
  }
  return null
}

/**
 * Returns step-by-step LLM instructions tailored to what the test is doing.
 * These are injected into the {test_intent_instructions} placeholder.
 */
function buildIntentInstructions(intent: TestIntent, prompt = ''): string {
  switch (intent) {

    case 'create':
      return `TEST TYPE: CREATE (adding a new record)

🚨 PRE-FLIGHT CHECKLIST — COMPLETE THIS BEFORE WRITING THE FIRST STEP 🚨

You MUST perform this analysis first and satisfy ALL items:

  ITEM 1 — ENTITY:
    Identify the primary entity from the test name (e.g. "Opportunity", "Account").

  ITEM 2 — REQUIRED FIELDS (critical — must not skip any):
    Open the MANDATORY CHECKLIST block in the metadata.
    List every field tagged 🔥 REQUIRED LOOKUP or [REQUIRED].
    Every single one MUST have a corresponding step in your output.
    🔥 REQUIRED LOOKUP fields (like "Account", "Contact", "Owner") → use LOOKUP action.
    [REQUIRED] text/date fields → use TYPE action with ⚡ SAMPLE VALUE.
    [REQUIRED] select fields → use SELECT action with a value from [VALID OPTIONS].

  ITEM 3 — SUBMIT BUTTON:
    Find the [SUBMIT BUTTON] line in the mandatory checklist.
    Copy the button name EXACTLY — do NOT paraphrase it.
    ✅ e.g. "Create Opportunity" → target: "Create Opportunity", locator_type: "role"
    ❌ NEVER use "Save", "Submit", or any other generic name.
    ❌ NEVER append data to entity name (e.g. "Create Tara" is WRONG).

  ITEM 4 — SELF-VALIDATION before JSON output:
    Count required fields in checklist → COUNT_A
    Count TYPE/SELECT/LOOKUP/CHECKBOX steps in your output → COUNT_B
    If COUNT_B < COUNT_A: you are missing required fields — ADD THEM before outputting.

Step ordering:
  Step 1: NAVIGATE to the entity's create/new page.
  Steps 2–N: One step per required field from Item 2 (preserve order from checklist).
  Step N+1: CLICK [SUBMIT BUTTON exact name].
  Step N+2: ASSERT_URL to the entity list page.

⛔ FORBIDDEN (these belong to SEARCH tests, NOT CREATE):
- DO NOT type into a Search box or Search bar
- DO NOT filter a list by status or dropdown
- DO NOT assert a record appears in a list (that is READ, not CREATE)
- DO NOT stop at the list page — you MUST fill the create form and submit
- DO NOT use generic button names like "Save" or "Submit"

User-specified values override metadata samples:
- Prompt says 'for account "Tara"' → use "Tara" as the Account lookup value
- Prompt says 'with amount 50000' → use "50000" as the Amount value

🔴 "WITH REQUIRED FIELDS" ABSOLUTE RULE:
  When the test case name contains "Required Fields" or "With Required Fields":
  - ZERO exceptions — every 🔥 REQUIRED LOOKUP and [REQUIRED] field MUST have a step.
  - Count them in the checklist, count them in your steps — the numbers must match.
  - Submitting the form without ALL required fields = the form WILL reject = test FAILS.
  - This rule overrides all other rules. No skipping for any reason whatsoever.`

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

    case 'update': {
      const focusField = extractFocusField(prompt)
      const focusBlock = focusField ? `
🎯 FOCUS FIELD ANALYSIS — THIS IS WHAT THE TEST WANTS TO UPDATE:
  Target field:  "${focusField.label}"
  Data type:     ${focusField.semanticType.toUpperCase()}
  Mapping rule:  ${focusField.dataRule}

  ⚠ HOW TO USE REAL ENTITY RECORDS FOR THIS FIELD:
  Look at the REAL ENTITY RECORDS section below.
  Find the value whose DATA TYPE is ${focusField.semanticType.toUpperCase()} — that is the value to put into the "${focusField.label}" field.
  ❌ DO NOT use placeholder text like 'real contact name from REAL ENTITY RECORDS' — use the ACTUAL value.
  ❌ DO NOT put an email address into the Phone field or vice versa.
  ✅ The search/name field uses the ⭐ PRIMARY_IDENTIFIER value from the records.
  ✅ The "${focusField.label}" field uses the ${focusField.semanticType.toUpperCase()}-type value from the records.
` : `
🎯 FOCUS FIELD: No specific field detected — update the field(s) mentioned in the test name.
  Use the matching DATA TYPE value from REAL ENTITY RECORDS for each field.
`

      return `TEST TYPE: UPDATE / EDIT (modifying an existing record)
${focusBlock}
🚨 SEARCH STEP LOCATOR RULE 🚨
The search input on the LIST PAGE uses a SEARCHBOX role or placeholder, NOT a form field label.
Step 2 (the search/find step) MUST follow this exact format:
  { "action": "TYPE", "target": "searchbox", "value": "<ACTUAL_NAME_FROM_REAL_RECORDS>", "locator_type": "role" }
  ❌ target MUST NOT be: "TITLE", "Name", "Company", "First Name", or any form field label
  ❌ locator_type MUST NOT be: "label" for the search step
  ✅ Use the ⭐ PRIMARY_IDENTIFIER value (person/company name) from REAL ENTITY RECORDS as the value

Step 3 (click to open the record) format:
  { "action": "CLICK", "target": "<ACTUAL_NAME_FROM_REAL_RECORDS>", "locator_type": "text" }

🚨 BUTTON NAME CRITICAL RULE 🚨
The submit button for update forms has a SPECIFIC name — it is NEVER generic "Save".
Look for the ⚡ BUTTON NAME in the APPLICATION METADATA.
Copy the button name EXACTLY — character for character.
  ✅ CORRECT: "Update Contact"    (if metadata shows ⚡ BUTTON NAME: "Update Contact")
  ✅ CORRECT: "Save Changes"       (if metadata shows ⚡ BUTTON NAME: "Save Changes")
  ❌ NEVER use: "Save", "Submit", "Create Contact", "OK" or ANY generic/wrong-action name
  ❌ The button CANNOT be a CREATE button for an UPDATE test

🚨 PLACEHOLDER TEXT RULE 🚨
NEVER output literal text like:
  ❌ 'real contact name from REAL ENTITY RECORDS'
  ❌ '<search term>'
  ❌ '[contact name]'
These are INSTRUCTIONS TO YOU, not values to use. Replace them with the ACTUAL value from the records.

Step-by-step:
  Step 1: { action: "NAVIGATE", value: "/<entity-list-path>" }
  Step 2: { action: "TYPE", target: "searchbox", value: "<⭐ PRIMARY_IDENTIFIER from records>", locator_type: "role" }
  Step 3: { action: "CLICK", target: "<⭐ PRIMARY_IDENTIFIER from records>", locator_type: "text" }
  Step 4: { action: "TYPE", target: "${focusField?.label ?? '<field label from metadata>'}", value: "<${focusField?.semanticType?.toUpperCase() ?? 'appropriate'}-type value from records>", locator_type: "label" }
  Step 5: { action: "CLICK", target: "<⚡ BUTTON NAME from metadata>", locator_type: "role" }
  Step 6: { action: "ASSERT_URL", value: "/<entity-list-path>" }

CRITICAL: The ⭐ PRIMARY_IDENTIFIER is the NAME of the record (person name, company name, lead name).
It is shown in REAL ENTITY RECORDS below with the label ⭐ PRIMARY_IDENTIFIER.
Use that EXACT string as the value in Step 2 and the target in Step 3.`
    }

    case 'delete': {
      // Extract entity name from the prompt for confirmation button
      const delEntityMatch = prompt.match(/\b(delete|remove|archive)\s+(?:a\s+|an\s+|the\s+)?([a-z]+)/i)
      const delEntity = delEntityMatch ? delEntityMatch[2].charAt(0).toUpperCase() + delEntityMatch[2].slice(1).toLowerCase() : 'Record'
      const confirmBtnLabel = `Delete ${delEntity}`  // e.g. "Delete Contact"

      return `TEST TYPE: DELETE (removing an existing record)

🚨 ENTITY FOR THIS DELETE TEST: ${delEntity}
🚨 CONFIRMATION BUTTON NAME: "${confirmBtnLabel}" — COPY THIS EXACTLY in Step 6.

🚨 SEARCH STEP LOCATOR RULE 🚨
The search input on the LIST PAGE uses a SEARCHBOX role or placeholder, NOT a form field label.
Step 2 (the search step) MUST follow this exact format:
  { "action": "TYPE", "target": "searchbox", "value": "<⭐ PRIMARY_IDENTIFIER from records>", "locator_type": "role" }
  ❌ target MUST NOT be: "Name", "TITLE", "Company", "First Name" or any form field label
  ✅ Use the ⭐ PRIMARY_IDENTIFIER value (actual person/company name) from REAL ENTITY RECORDS as the value

🚨 DELETE ACTION FLOW — MANDATORY 7-STEP SEQUENCE 🚨

  Step 1: { "action": "NAVIGATE",  "value": "/<entity-list-path>" }
  Step 2: { "action": "TYPE",      "target": "searchbox",                   "value": "<⭐ PRIMARY_IDENTIFIER>",  "locator_type": "role" }
  Step 3: { "action": "CLICK",     "target": "<⭐ PRIMARY_IDENTIFIER>",                                          "locator_type": "text" }
  Step 4: { "action": "CLICK",     "target": "<action menu button>",                                             "locator_type": "role" }  ← open "More"/"Actions" menu
  Step 5: { "action": "CLICK",     "target": "Delete",                                                           "locator_type": "text" }  ← click Delete from menu
  Step 6: { "action": "CLICK",     "target": "${confirmBtnLabel}",                                               "locator_type": "role" }  ← MANDATORY confirm dialog button
  Step 7: { "action": "ASSERT_URL","value": "/<entity-list-path>" }

⚠️ ACTION MENU RULE:
  Look in APPLICATION METADATA for a button named "More", "More actions", "Actions", or "Options".
  That is the action menu trigger. Use its EXACT name in Step 4.
  If metadata shows ⚡ BUTTON NAME: "More" → use target: "More", locator_type: "role"
  If metadata shows ⚡ BUTTON NAME: "Actions" → use target: "Actions", locator_type: "role"
  If no action menu button is found in metadata, use: target: "More", locator_type: "role"

⚠️ CONFIRMATION DIALOG RULE (MOST CRITICAL):
  After clicking "Delete" from the menu, a CONFIRMATION DIALOG ALWAYS appears.
  The confirm button is ALWAYS named "${confirmBtnLabel}" (Delete + EntityType).
  ❌ DO NOT skip Step 6 — without it the dialog stays open and ASSERT_URL fails.
  ❌ DO NOT use "Confirm", "Yes", or "OK" as the confirm button — use "${confirmBtnLabel}".
  ❌ DO NOT use a plain "Delete" button as Step 6 — that is Step 5 (the menu item).
  ✅ Step 6 MUST be: { "action": "CLICK", "target": "${confirmBtnLabel}", "locator_type": "role" }

CRITICAL: Only delete records that appear in REAL ENTITY RECORDS — never invent record names.`
    }

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

  // Pattern 3: Bare quoted value as the entity name after the entity keyword
  // Handles: "Create a Lead 'Megha'" or "Create Lead \"Megha\"" where the quoted
  // value is the primary entity name (First Name / Full Name / Lead Name).
  // We only apply this when the entity type is directly followed by the quoted value.
  const entityNamePattern = /\b(create|add|new)\b\s+(?:a\s+)?(?:new\s+)?(lead|account|contact|customer|opportunity|campaign|role|user)\s+['"\u201c]([^'"\u201d]+)['"\u201d]/gi
  for (const match of prompt.matchAll(entityNamePattern)) {
    const entityType = (match[2] ?? '').toLowerCase()
    const value = match[3]?.trim() ?? ''
    // Map entity type to likely field name
    const fieldMap: Record<string, string> = {
      lead: 'Lead Name',
      account: 'Account Name',
      contact: 'Contact Name',
      customer: 'Customer Name',
      opportunity: 'Opportunity Name',
      campaign: 'Campaign Name',
      role: 'Role Name',
      user: 'Username',
    }
    const field = fieldMap[entityType] ?? `${entityType.charAt(0).toUpperCase() + entityType.slice(1)} Name`
    // Also store a generic "Name" entry so it matches any name-like field
    for (const key of [field, 'Name', 'First Name', 'Full Name']) {
      if (!seen.has(key.toLowerCase()) && value) {
        seen.add(key.toLowerCase())
        values.push({ field: key, value })
      }
    }
  }

  // Pattern 4: "with status 'Qualified'" / "status as 'Qualified'"
  const statusPattern = /\bstatus\s+(?:of|as|to|=|:)?\s*['"\u201c]?([A-Za-z][A-Za-z\s]*)['"\u201d]?/gi
  for (const match of prompt.matchAll(statusPattern)) {
    const value = match[1]?.trim() ?? ''
    if (value && !seen.has('status')) {
      seen.add('status')
      values.push({ field: 'Status', value })
    }
  }

  // Pattern 5: "with amount 50000" / "stage as 'Prospecting'"
  const knownFields = new Map([
    ['amount', 'Amount'], ['stage', 'Stage'],
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
  // ── Field type classifiers ───────────────────────────────────────────────────
  const NUMERIC_FIELDS    = /\b(amount|currency|price|cost|total|revenue|quantity|qty|budget|discount|tax|rate|probability|percent|percentage|number|count|weight|balance|fee|charge|salary|wage|turnover)\b/i
  const DATE_FIELDS       = /\b(date|close date|start date|end date|due date|created|modified|birth|expiry|deadline|service provided|from|till|valid until|effective|delivery|dispatch|arrival|departure)\b/i
  const STAGE_STATUS_FIELDS = /^(stage|status|state|phase|type|category|priority|level|rating|grade|result|mode|condition|disposition)$/i
  // Generic lookup/name patterns — covers CRM, logistics, ERP, HR, healthcare and any other domain
  const NAME_LOOKUP_FIELDS = /\b(name|owner|manager|assigned|parent|partner|entity|organization|org|group|department|division|location|region|branch|site|facility|warehouse|vessel|carrier|shipper|consignee|vendor|supplier|customer|client|account|contact|person|employee|agent|operator|user|requestor|approver|buyer|seller)\b/i
  const PHONE_FIELDS      = /\b(phone|mobile|cell|tel|telephone|fax|contact number|mobile number|phone number|landline|hotline|helpdesk)\b/i
  const EMAIL_FIELDS      = /\b(email|e-mail|mail|inbox|address)\b/i
  const URL_FIELDS        = /\b(website|url|link|homepage|web address|site|portal|endpoint|api url|base url)\b/i
  const INDUSTRY_FIELDS   = /\b(industry|sector|vertical|market|domain|field of business|niche|segment|business type)\b/i

  // Valid industry category values — any value NOT in this set when going into an Industry field is wrong
  const VALID_INDUSTRY_VALUES = new Set([
    'Technology', 'Healthcare', 'Finance', 'Education', 'Retail', 'Manufacturing',
    'Real Estate', 'Transportation', 'Energy', 'Agriculture', 'Media', 'Entertainment',
    'Government', 'Nonprofit', 'Construction', 'Legal', 'Consulting', 'Hospitality',
    'Automotive', 'Aerospace', 'Pharmaceuticals', 'Telecommunications', 'Banking',
    'Insurance', 'Food & Beverage', 'Fashion', 'Sports', 'Travel', 'Software',
    'IT Services', 'E-Commerce', 'Logistics', 'Marketing', 'Engineering',
  ])
  const DEFAULT_INDUSTRY = 'Technology'

  // Type-appropriate canonical fallback values — all domain-neutral
  const CANONICAL_FALLBACKS: Record<string, string> = {
    numeric:  '50000',
    date:     '06/30/2026',
    stage:    'Active',           // generic status — not CRM-specific "Prospecting"
    name:     'Sample Organization Ltd',  // generic entity name — not CRM-specific "Acme Corp"
    phone:    '+1 555-123-4567',
    email:    'test@example.com',
    url:      'https://www.example.com',
    industry: DEFAULT_INDUSTRY,
  }

  type FieldKind = 'numeric' | 'date' | 'stage' | 'name' | 'phone' | 'email' | 'url' | 'industry' | 'unknown'

  const isNumericValue = (v: string) => /^[\d,]+\.?\d*$/.test(v.replace(/[\s$€£¥₹%]/g, ''))
  const isDateValue    = (v: string) => /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(v) || /^\d{4}-\d{2}-\d{2}/.test(v)
  const isStageValue   = (v: string) => /^[A-Z][A-Z_]+$/.test(v) || /^(open|closed|won|lost|new|pending|active|inactive|qualified|converted|prospecting|negotiation|proposal)/i.test(v)
  const isPhoneValue   = (v: string) => /^[+\d][\d\s\-().]{6,}$/.test(v.trim()) && !v.includes('@') && !v.startsWith('http')
  const isEmailValue   = (v: string) => /@/.test(v) && /\.[a-z]{2,}$/i.test(v.trim())
  const isUrlValue     = (v: string) => /^https?:\/\//i.test(v) || /^www\./i.test(v)
  const isPersonName   = (v: string) => /^[A-Z][a-z]+(\s+[A-Z][a-z]+)*$/.test(v.trim()) && v.split(' ').length <= 4
  const isPureNumber   = (v: string) => /^\d{5,}$/.test(v.trim())  // bare digits with no formatting

  function classifyFieldKind(name: string): FieldKind {
    const clean = name.replace(/[^a-zA-Z\s]/g, '').trim()
    if (PHONE_FIELDS.test(clean))       return 'phone'
    if (EMAIL_FIELDS.test(clean))       return 'email'
    if (URL_FIELDS.test(clean))         return 'url'
    if (INDUSTRY_FIELDS.test(clean))    return 'industry'
    if (NUMERIC_FIELDS.test(clean))     return 'numeric'
    if (DATE_FIELDS.test(clean))        return 'date'
    if (STAGE_STATUS_FIELDS.test(clean)) return 'stage'
    if (NAME_LOOKUP_FIELDS.test(clean)) return 'name'
    return 'unknown'
  }

  function isValueValidForKind(value: string, kind: FieldKind): boolean {
    const v = value.trim()
    switch (kind) {
      case 'phone':    return isPhoneValue(v)
      case 'email':    return isEmailValue(v)
      case 'url':      return isUrlValue(v) && !isPureNumber(v)
      case 'industry': return VALID_INDUSTRY_VALUES.has(v)
      case 'numeric':  return isNumericValue(v)
      case 'date':     return isDateValue(v)
      case 'stage':    return isStageValue(v)
      case 'name':
        // A name field must NOT contain pure status words (Prospect, Active, Closed) or
        // a bare number — it should be a real entity/company name
        if (isStageValue(v) && !isPersonName(v)) return false
        if (isPureNumber(v)) return false
        return true
      default:         return true  // unknown type — do not touch
    }
  }

  function fixValueForKind(fieldName: string, badValue: string, kind: FieldKind): string {
    // For URL fields: bare number like "823462434234" → "https://www.example.com"
    if (kind === 'url' && isPureNumber(badValue)) {
      log.warn(`[GEN] validateFieldValueAlignment: Website field "${fieldName}" has pure number "${badValue}" → https://www.example.com`)
      return 'https://www.example.com'
    }
    // For Industry fields: a person's name like "Tara" → "Technology"
    if (kind === 'industry' && !VALID_INDUSTRY_VALUES.has(badValue)) {
      log.warn(`[GEN] validateFieldValueAlignment: Industry field "${fieldName}" has invalid value "${badValue}" → ${DEFAULT_INDUSTRY}`)
      return DEFAULT_INDUSTRY
    }
    // For lookup/name fields: a bare status word → generic entity name
    if (kind === 'name' && isStageValue(badValue) && !isPersonName(badValue)) {
      log.warn(`[GEN] validateFieldValueAlignment: Lookup/Name field "${fieldName}" has status value "${badValue}" → Sample Organization Ltd`)
      return 'Sample Organization Ltd'
    }
    // For phone fields: URL or email → canonical phone
    if (kind === 'phone' && (isUrlValue(badValue) || isEmailValue(badValue))) {
      log.warn(`[GEN] validateFieldValueAlignment: Phone field "${fieldName}" has non-phone value "${badValue}" → +1 555-123-4567`)
      return '+1 555-123-4567'
    }
    // For email fields: phone or URL → canonical email
    if (kind === 'email' && !isEmailValue(badValue)) {
      log.warn(`[GEN] validateFieldValueAlignment: Email field "${fieldName}" has non-email value "${badValue}" → test@example.com`)
      return 'test@example.com'
    }
    // Default: use canonical fallback
    const fallback = CANONICAL_FALLBACKS[kind] ?? ''
    if (fallback) {
      log.warn(`[GEN] validateFieldValueAlignment: Field "${fieldName}" (kind=${kind}) has wrong value "${badValue}" → "${fallback}"`)
    }
    return fallback || badValue
  }

  interface MismatchInfo {
    stepIndex: number
    fieldName: string
    currentValue: string
    expectedKind: FieldKind
  }

  const mismatches: MismatchInfo[] = []

  for (let i = 0; i < steps.length; i++) {
    const step   = steps[i]
    const action = (step.action ?? '').toUpperCase()
    if (action !== 'TYPE' && action !== 'SELECT' && action !== 'LOOKUP') continue

    const fieldName = String(step.target ?? '')
    const value     = String(step.value ?? '')
    if (!fieldName || !value) continue

    const expectedKind = classifyFieldKind(fieldName)
    if (expectedKind === 'unknown') continue   // no type constraint — leave alone

    if (!isValueValidForKind(value, expectedKind)) {
      mismatches.push({ stepIndex: i, fieldName, currentValue: value, expectedKind })
    }
  }

  if (mismatches.length === 0) return steps

  log.warn(`[GEN] Field-value misalignment: ${mismatches.length} field(s) have wrong value types`)
  for (const m of mismatches) {
    log.warn(`[GEN]   Field "${m.fieldName}" (expects ${m.expectedKind}) has bad value: "${m.currentValue}"`)
  }

  // ── Strategy 1: Swap partner steps (e.g. Phone↔Email values transposed) ──
  const swapped = new Set<number>()
  for (const m1 of mismatches) {
    if (swapped.has(m1.stepIndex)) continue
    for (const m2 of mismatches) {
      if (m1.stepIndex === m2.stepIndex || swapped.has(m2.stepIndex)) continue
      const m2Kind = classifyFieldKind(String(steps[m2.stepIndex].target ?? ''))
      // Check if swapping would fix both
      const m1ValFitsM2 = isValueValidForKind(m1.currentValue, m2Kind)
      const m2ValFitsM1 = isValueValidForKind(String(steps[m2.stepIndex].value ?? ''), m1.expectedKind)
      if (m1ValFitsM2 && m2ValFitsM1) {
        log.info(`[GEN] Swap fix: "${m1.fieldName}" ↔ "${steps[m2.stepIndex].target}" ("${m1.currentValue}" ↔ "${steps[m2.stepIndex].value}")`)
        const temp = steps[m1.stepIndex].value
        steps[m1.stepIndex].value = steps[m2.stepIndex].value
        steps[m2.stepIndex].value = temp
        swapped.add(m1.stepIndex)
        swapped.add(m2.stepIndex)
        break
      }
    }
  }

  // ── Strategy 2: For remaining mismatches, replace with type-correct fallback ──
  for (const m of mismatches) {
    if (swapped.has(m.stepIndex)) continue
    steps[m.stepIndex].value = fixValueForKind(m.fieldName, m.currentValue, m.expectedKind)
  }

  return steps
}


/**
 * Universal field-existence filter — removes TYPE/SELECT/LOOKUP steps that
 * reference fields which do NOT exist on the real form.
 *
 * Called alongside validateFieldValueAlignment() to ensure both:
 *   1. Field values have correct data types (phone in phone field, etc.)
/**
 * Post-generation safety net — ensures step quality at the API boundary:
 *   1. Steps use valid action names
 *   2. Fields actually EXIST on the form (no hallucinated "Email" on Account)
 *   3. CLICK steps don't target buttons for a DIFFERENT entity
 *      (no "+ New Lead" button in an Account test)
 *
 * Uses buildFieldManifest (same as Check 7 in runTestStepGeneratorAgent)
 * to load the real field inventory from crawler/metadata.
 *
 * @returns filtered steps — hallucinated field steps AND cross-entity clicks removed
 */
async function filterNonExistentFieldSteps(
  steps: Step[],
  projectId: string,
  entityHint?: string,
): Promise<Step[]> {
  try {
    const manifest = await buildWebAppFieldManifest(projectId, entityHint)

    let filtered = [...steps]

    // ── Part A: Filter hallucinated field steps ──────────────────────────────
    if (manifest && manifest.fields.length > 0) {
      // Normalize field labels: strip trailing '*', '(required)', etc. that live scrape may add
      const normalizeLabel = (s: string) =>
        s.toLowerCase()
         .replace(/\s*\*+\s*$/, '')       // trailing asterisk(s): "PRODUCT NAME *" → "product name"
         .replace(/\s*\(required\)\s*$/i, '') // "(required)" suffix
         .replace(/\s*\[required\]\s*$/i, '') // "[required]" suffix
         .replace(/\s*required\s*$/i, '')     // trailing "required"
         .trim()

      const knownFieldLabels = new Set(
        manifest.fields.map(f => normalizeLabel(f.label))
      )
      const FIELD_ACTIONS = new Set(['TYPE', 'SELECT', 'LOOKUP', 'CHECKBOX', 'MULTI_SELECT'])

      const beforeFieldFilter = filtered.length
      filtered = filtered.filter(s => {
        const action = (s.action ?? '').toUpperCase()
        if (!FIELD_ACTIONS.has(action)) return true  // keep non-field steps (NAVIGATE, CLICK, etc.)
        const target = (s.target ?? '').trim()
        if (!target) return true
        const normTarget = normalizeLabel(target)
        if (knownFieldLabels.has(normTarget)) return true  // field exists in manifest

        // Field NOT in manifest → hallucinated → remove
        log.warn(
          `[GEN] filterNonExistentFieldSteps: Removing step "${action} → ${target}" (normalized: "${normTarget}") — ` +
          `field does NOT exist in the ${entityHint ?? 'entity'} form. ` +
          `Known fields: ${manifest.fields.map(f => f.label).join(', ')}`
        )
        return false
      })


      if (filtered.length < beforeFieldFilter) {
        log.info(
          `[GEN] filterNonExistentFieldSteps: removed ${beforeFieldFilter - filtered.length} hallucinated field steps ` +
          `(${filtered.length} remaining) for entity "${entityHint ?? 'unknown'}"`
        )
      }
    }

    // ── Part B: Filter cross-entity CLICK buttons ───────────────────────────
    // Catches steps like CLICK "+ New Lead" in an Account test.
    // A CLICK target containing "new/create/add <Entity>" where <Entity> ≠ entityHint
    // is a cross-entity contamination from sidebar navigation buttons.
    if (entityHint && entityHint.length > 2) {
      const entityHintLower = entityHint.toLowerCase()
      const beforeClickFilter = filtered.length

      filtered = filtered.filter(s => {
        const action = (s.action ?? '').toUpperCase()
        if (action !== 'CLICK') return true  // only filter CLICK steps

        const target = (s.target ?? '').toLowerCase().trim()
        if (!target) return true

        // Detect "new/create/add <entity>" pattern in the click target
        const entityWordMatch = target.match(/\b(?:new|create|add)\s+([a-z]+(?:\s+[a-z]+)?)\b/)
        if (!entityWordMatch) return true  // no entity word pattern → keep

        const entityWord = entityWordMatch[1].trim()
        // Skip short/generic words
        if (entityWord.length < 3 || ['the', 'a', 'an', 'new', 'all', 'item', 'record', 'entry'].includes(entityWord)) return true

        // Check if the entity word matches our target entity
        if (entityHintLower.includes(entityWord) || entityWord.includes(entityHintLower)) return true  // correct entity → keep

        // Entity word does NOT match → cross-entity contamination → remove
        log.warn(
          `[GEN] filterNonExistentFieldSteps: Removing CLICK step "CLICK → ${s.target}" — ` +
          `this button is for "${entityWord}", not for "${entityHint}". ` +
          `Cross-entity button contamination from sidebar/navigation.`
        )
        return false
      })

      if (filtered.length < beforeClickFilter) {
        log.info(
          `[GEN] filterNonExistentFieldSteps: removed ${beforeClickFilter - filtered.length} cross-entity CLICK steps ` +
          `for entity "${entityHint}"`
        )
      }
    }

    // Re-number remaining steps if any were removed
    if (filtered.length < steps.length) {
      filtered = filtered.map((s, i) => ({ ...s, id: String(i + 1) }))
    }

    return filtered
  } catch (err) {
    log.warn({ err }, '[GEN] filterNonExistentFieldSteps failed (non-critical) — returning original steps')
    return steps
  }
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
      // For UPDATE/DELETE: emit type-annotated records so the LLM knows which value goes
      // into which field type. Prevents email-into-phone and placeholder text leakage.
      lines.push('  Target record to find and EDIT (use ACTUAL values — NO placeholders):')
      const sample = records[0]
      let primaryEmitted = false

      const detectDT = (key: string, val: string): string => {
        const k = key.toLowerCase()
        if (/\b(phone|mobile|cell|tel)\b/.test(k))          return 'PHONE'
        if (/\b(email|e-mail|mail)\b/.test(k))              return 'EMAIL'
        if (/\b(date|dob|birth|expiry|deadline)\b/.test(k)) return 'DATE'
        if (/\b(name|title|full.?name|first.?name|last.?name)\b/.test(k)) return 'NAME'
        if (/\b(amount|price|cost|revenue|budget|value|qty)\b/.test(k))   return 'NUMBER'
        if (/\b(address|street|city|state|zip|postal)\b/.test(k))         return 'ADDRESS'
        if (/^[+\d][\d\s\-.]{6,}$/.test(val.trim()))       return 'PHONE'
        if (/@/.test(val) && /\.[a-z]{2,}$/.test(val))     return 'EMAIL'
        if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(val) || /^\d{4}-\d{2}-\d{2}/.test(val)) return 'DATE'
        return 'TEXT'
      }

      // PRIMARY_IDENTIFIER priority order:
      // 1. Exact person-name fields: first_name, last_name, contact_name, full_name
      // 2. Generic name field: name
      // 3. Entity-specific name: account_name, opportunity_name, lead_name etc.
      // 4. Last resort: title, id, code, ref
      // "title" is intentionally LOWER priority than "name" to avoid picking
      // a company title like "Test Company 2123" as the search term for a contact.
      const sampleKeys = Object.keys(sample).filter(k =>
        sample[k] !== null && sample[k] !== undefined && String(sample[k]).trim() !== ''
      )
      const primaryFieldKey =
        sampleKeys.find(k => /^(first.?name|last.?name|full.?name|contact.?name)$/i.test(k)) ??
        sampleKeys.find(k => /^name$/i.test(k)) ??
        sampleKeys.find(k => /\bname\b/i.test(k) && !/company|account|email/i.test(k)) ??
        sampleKeys.find(k => /^(name|id|code|ref|label)/i.test(k)) ??
        sampleKeys[0]

      for (const [field, value] of Object.entries(sample).slice(0, 12)) {
        if (value === null || value === undefined || String(value).trim() === '') continue
        const valStr = String(value)
        const dt = detectDT(field, valStr)
        const isPrimary = !primaryEmitted && field === primaryFieldKey
        if (isPrimary) primaryEmitted = true
        const roleLabel = isPrimary
          ? '  ⭐ PRIMARY_IDENTIFIER — use as SEARCH TERM to find the record'
          : `  [DATA_TYPE: ${dt}] — use ONLY in ${dt}-type fields`
        lines.push(`    ${field}: "${valStr}"${roleLabel}`)
      }

      lines.push('')
      lines.push('  ⚠ DATA MAPPING RULES:')
      lines.push('    • ⭐ PRIMARY_IDENTIFIER value → search step TYPE value')
      lines.push('    • [DATA_TYPE: PHONE] values → Phone/Mobile fields ONLY')
      lines.push('    • [DATA_TYPE: EMAIL] values → Email fields ONLY')
      lines.push('    • [DATA_TYPE: NAME] values  → Name/Title fields ONLY')
      lines.push('    • [DATA_TYPE: DATE] values  → Date fields ONLY (MM/DD/YYYY)')
      lines.push('    • ❌ Cross-assigning types = test FAILURE (email ≠ phone ≠ name)')
      lines.push('    • ❌ NEVER output template placeholder text — use actual string values')

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

// ── ENTITY ANALYSIS CARD builder ─────────────────────────────────────
//
// Synthesises a concise, visual "ENTITY ANALYSIS CARD" from crawled pages.
// The card is placed at the TOP of the RAG context so the LLM always reads
// it first during its mandatory Deep Metadata Analysis Phase.
//
// Card structure (mirrors the few-shot examples in WEB_APP_RAG_SYSTEM_PROMPT):
//   🏷️ ENTITY: <EntityName>
//   📄 PAGE URL (Create): /path/new
//   📄 PAGE URL (List):   /path
//   📄 PAGE URL (Edit):   /path/:id/edit
//   🔑 FIELD CATALOG:
//     🔥 REQUIRED LOOKUP  "Account"           locator_type: label  → sample: "Acme Corp"
//     🔥 REQUIRED INPUT   "Opportunity Name"  locator_type: label  → sample: "New Deal"
//     🔥 REQUIRED SELECT  "Stage"             locator_type: label  → options: A | B  ⚡ USE: "A"
//     ✅ OPTIONAL INPUT   "Amount"            locator_type: label  → sample: "50000"
//   ⚡ SUBMIT BUTTON: "Create Opportunity"  (locator_type: role)

function buildEntityAnalysisHeader(
  entityName: string,
  topPages: Record<string, unknown>[],
  testDataMap: Map<string, Record<string, string>>,
  targetLowers: string[],
  testIntent: TestIntent,
  entityUrlMap: Record<string, EntityUrlInfo> = {},
): string {

  // ── Helpers ──────────────────────────────────────────────────────────
  const deplurSeg = (s: string) => depluralize(s)

  // Identify page categories
  const CREATE_REGEX = /\/(new|create|add|form)(\/.*)?(\/|\?|$)/
  const EDIT_REGEX   = /\/(edit|update)(\/.*)?($|\?)/
  const isCreatePage = (p: string) => CREATE_REGEX.test(p.toLowerCase())
  const isEditPage   = (p: string) => EDIT_REGEX.test(p.toLowerCase())
  const isListPage   = (p: string) => !isCreatePage(p) && !isEditPage(p)

  const createPages = topPages.filter(p => isCreatePage(String(p['path'] ?? '')))
  const editPages   = topPages.filter(p => isEditPage(String(p['path'] ?? '')))
  const listPages   = topPages.filter(p => isListPage(String(p['path'] ?? '')))

  const primaryPage: Record<string, unknown> | undefined =
    (testIntent === 'update' ? editPages[0] : createPages[0])
    ?? topPages[0]

  // Resolved entity name from page path (more reliable than caller's guess)
  const allPaths = topPages.map(p => String(p['path'] ?? ''))
  const resolvedEntity = (() => {
    for (const p of allPaths) {
      const segs = p.split('/').filter(s => s && !/^(new|create|add|edit|update|list|index|all|\d+)$/i.test(s))
      const last = segs.find(s => targetLowers.some(t => s.toLowerCase().includes(t) || t.includes(s.toLowerCase())))
      if (last) return deplurSeg(last).charAt(0).toUpperCase() + deplurSeg(last).slice(1)
    }
    return entityName
  })()

  // Resolve sample value for a locator from test data.
  // Validates that the value is semantically appropriate for the field type
  // (e.g. a URL value is not returned for a Phone field and vice-versa).
  function sampleFor(locator: string): string | null {
    const locLower = locator.toLowerCase().replace(/[^a-z0-9]/g, '')
    const maps: Record<string, string>[] = []
    for (const t of targetLowers) {
      const m = testDataMap.get(t) ?? testDataMap.get(deplurSeg(t))
      if (m) maps.push(m)
    }
    for (const dm of maps) {
      const exact = Object.keys(dm).find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === locLower)
      if (exact) {
        const fixed = validateAndFixSampleValue(locator, dm[exact])
        return fixed || dm[exact]
      }
      const fuzzy = Object.keys(dm).find(k => {
        const kn = k.toLowerCase().replace(/[^a-z0-9]/g, '')
        return locLower.includes(kn) || kn.includes(locLower)
      })
      if (fuzzy) {
        const fixed = validateAndFixSampleValue(locator, dm[fuzzy])
        return fixed || dm[fuzzy]
      }
    }
    return null
  }

  // ── ENTITY KNOWN LOOKUPS (same as in buildRequiredFieldsSummary) ─────
  const ENTITY_REQUIRED_LOOKUPS: Record<string, Array<{ locator: string; hint: string }>> = {
    opportunity:  [{ locator: 'Account', hint: 'Acme Corp' }, { locator: 'Close Date', hint: '06/30/2026' }],
    lead:         [{ locator: 'Company', hint: 'Acme Corp' }],
    contact:      [{ locator: 'Account Name', hint: 'Acme Corp' }],
    case:         [{ locator: 'Account Name', hint: 'Acme Corp' }],
    invoice:      [{ locator: 'Account', hint: 'Acme Corp' }, { locator: 'Opportunity', hint: 'New Business Deal' }],
    order:        [{ locator: 'Account', hint: 'Acme Corp' }],
    quote:        [{ locator: 'Opportunity', hint: 'New Business Deal' }],
    task:         [{ locator: 'Related To', hint: 'Acme Corp' }],
    activity:     [{ locator: 'Related To', hint: 'Acme Corp' }],
    deal:         [{ locator: 'Account', hint: 'Acme Corp' }],
    project:      [{ locator: 'Account', hint: 'Acme Corp' }],
    ticket:       [{ locator: 'Account', hint: 'Acme Corp' }],
    proposal:     [{ locator: 'Opportunity', hint: 'New Business Deal' }],
    subscription: [{ locator: 'Account', hint: 'Acme Corp' }],
    product:      [{ locator: 'Name', hint: 'Sample Product' }, { locator: 'Currency', hint: 'USD' }],
  }

  // ── Build field catalog from primaryPage (or all pages merged) ───────
  const allInputs: Record<string, unknown>[] = []
  const allSelects: Record<string, unknown>[] = []
  const allButtons: Record<string, unknown>[] = []

  for (const pg of (primaryPage ? [primaryPage, ...topPages.filter(p => p !== primaryPage)] : topPages)) {
    if (Array.isArray(pg['inputs']))  allInputs.push(...(pg['inputs'] as Record<string, unknown>[]))
    if (Array.isArray(pg['selects'])) allSelects.push(...(pg['selects'] as Record<string, unknown>[]))
    if (Array.isArray(pg['buttons'])) allButtons.push(...(pg['buttons'] as Record<string, unknown>[]))
  }

  // Deduplicate by locator
  const dedup = <T extends Record<string, unknown>>(arr: T[]) => {
    const seen = new Set<string>()
    return arr.filter(it => {
      const key = String(it['locator'] ?? it['name'] ?? '').toLowerCase()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  const inputs  = dedup(allInputs)
  const selects = dedup(allSelects)
  const buttons = dedup(allButtons)

  // Identify known-required lookup fields for the entity
  const entityPathKey = resolvedEntity.toLowerCase()
  const knownLookups  = ENTITY_REQUIRED_LOOKUPS[entityPathKey] ?? []
  const existingLocators = new Set(inputs.map(i => String(i['locator'] ?? i['name'] ?? '').toLowerCase()))
  const syntheticLookups = knownLookups.filter(l => !existingLocators.has(l.locator.toLowerCase()))

  // ── Build card lines ──────────────────────────────────────────────────
  const card: string[] = [
    '╔══════════════════════════════════════════════════════════════════════════════╗',
    '║  ENTITY ANALYSIS CARD — READ THIS FIRST BEFORE WRITING ANY STEP            ║',
    '║  This card contains the EXACT data you need for the 5-step analysis phase.  ║',
    '╚══════════════════════════════════════════════════════════════════════════════╝',
    '',
    `🏷️  ENTITY: ${resolvedEntity}`,
    '',
  ]

  // Page URLs: prefer verified entityUrlMap → crawl metadata → guessed fallback
  // Helper: find a verified URL from entityUrlMap for the current entity
  const findVerifiedPath = (): string | null => {
    const lowerEntity = resolvedEntity.toLowerCase()
    // Try exact name match
    for (const [name, info] of Object.entries(entityUrlMap)) {
      const p = typeof info === 'string' ? info : info.path
      if (name.toLowerCase() === lowerEntity || name.toLowerCase() === lowerEntity + 's') return p
    }
    // Try partial match (e.g. entityUrlMap has "Invoice Custom Field" for target "Invoice Custom Fields")
    for (const [name, info] of Object.entries(entityUrlMap)) {
      const p = typeof info === 'string' ? info : info.path
      const nLower = name.toLowerCase()
      if (nLower.includes(lowerEntity) || lowerEntity.includes(nLower)) return p
    }
    // Try token-based match for compound entities
    const tokens = lowerEntity.split(/[\s-]+/).filter(t => t.length > 2)
    if (tokens.length > 1) {
      for (const [name, info] of Object.entries(entityUrlMap)) {
        const p = typeof info === 'string' ? info : info.path
        const pLower = p.toLowerCase()
        if (tokens.every(tok => pLower.includes(tok))) return p
      }
    }
    return null
  }

  const verifiedBasePath = findVerifiedPath()

  const listPath   = listPages[0]
    ? String(listPages[0]['path'] ?? '')
    : verifiedBasePath
      ?? `⚠ UNKNOWN — check the app navigation for the exact URL (do NOT guess)`
  const createPath = createPages[0]
    ? String(createPages[0]['path'] ?? '')
    : verifiedBasePath
      ? `${verifiedBasePath}/new`
      : `⚠ UNKNOWN — navigate to the list page and click the Add/New button`
  const editPath   = editPages[0]
    ? String(editPages[0]['path'] ?? '')
    : verifiedBasePath
      ? `${verifiedBasePath}/:id/edit`
      : `⚠ UNKNOWN — open a record and use the Edit button`

  // If both crawl metadata AND entityUrlMap have no matching URLs, add a hard warning
  const hasNoVerifiedUrl = !listPages[0] && !verifiedBasePath

  card.push('📄 PAGE URLS:')
  card.push(`   List Page:   ${listPath}`)
  card.push(`   Create Page: ${createPath}`)
  card.push(`   Edit Page:   ${editPath}`)
  if (hasNoVerifiedUrl) {
    card.push(`   ⚠️  WARNING: NO verified URL found in crawl metadata or entity URL map for entity "${resolvedEntity}".`)
    card.push(`   ⚠️  DO NOT invent a URL. Check the app's actual navigation structure.`)
    card.push(`   ⚠️  RULE 8: Use ONLY URLs from this ENTITY ANALYSIS CARD. If all URLs show ⚠ UNKNOWN, navigate to the app root and discover the correct page by clicking.`)
  }
  card.push('')

  // Field catalog
  card.push('🔑 FIELD CATALOG:')
  card.push('   (🔥 = REQUIRED  |  ✅ = OPTIONAL  |  ⛔ = SKIP)')
  card.push('')

  // Required inputs
  const reqInputs = inputs.filter(i => Boolean(i['required']))
  const optInputs = inputs.filter(i => !Boolean(i['required']))

  // For CREATE tests where the crawler found no required fields: promote all
  // available inputs so the LLM knows it must fill the form fields.
  const isCreateTest = testIntent === 'create' || testIntent === 'general'
  const effectiveReqInputs = (reqInputs.length === 0 && syntheticLookups.length === 0 && inputs.length > 0 && isCreateTest)
    ? inputs.slice(0, 8)
    : reqInputs
  const effectiveOptInputs = (effectiveReqInputs !== reqInputs) ? [] : optInputs

  for (const inp of effectiveReqInputs) {
    const loc  = String(inp['locator'] ?? inp['name'] ?? '')
    const lt   = String(inp['locator_type'] ?? 'label')
    const isLookup = /\b(account|contact|owner|parent|manager|assigned|lead|opportunity|vendor|customer|partner|related\s*to|bill\s*to|ship\s*to)\b/i.test(loc)
    const isPromoted = effectiveReqInputs !== reqInputs
    const tag  = isLookup ? '🔥 REQUIRED LOOKUP ' : (isPromoted ? '🔥 FILL (create form)' : '🔥 REQUIRED INPUT  ')
    const sample = sampleFor(loc) ?? (isLookup ? 'Acme Corp' : '')
    const sampleStr = sample ? `  → sample: "${sample}"` : ''
    card.push(`   ${tag} "${loc}"  locator_type: ${lt}${sampleStr}`)
  }

  // Synthetic required lookups (from ENTITY_REQUIRED_LOOKUPS)
  for (const syn of syntheticLookups) {
    const sample = sampleFor(syn.locator) ?? syn.hint
    card.push(`   🔥 REQUIRED LOOKUP  "${syn.locator}"  locator_type: label  → sample: "${sample}"  [injected — not in HTML but MUST be filled]`)
  }

  // Required selects
  const reqSelects = selects.filter(s => Boolean(s['required']))
  for (const sel of reqSelects) {
    const loc  = String(sel['locator'] ?? sel['name'] ?? '')
    const raw  = sel['options']
    const opts: string[] = Array.isArray(raw) ? raw.map(String).filter(Boolean) : []
    const sample = sampleFor(loc)
    const chosen = sample && opts.length > 0
      ? (opts.find(o => o.toLowerCase() === sample.toLowerCase()) ?? opts[0])
      : (opts[0] ?? '')
    if (opts.length === 0) {
      card.push(`   ⛔ SKIP              "${loc}"  [NO VALID OPTIONS — omit this step]`)
    } else {
      const optsStr = opts.slice(0, 5).join(' | ')
      card.push(`   🔥 REQUIRED SELECT  "${loc}"  locator_type: label  → options: ${optsStr}  ⚡ USE: "${chosen}"`)
    }
  }

  // Optional inputs (up to 6) — only show when not already promoted to required
  for (const inp of effectiveOptInputs.slice(0, 6)) {
    const loc    = String(inp['locator'] ?? inp['name'] ?? '')
    const lt     = String(inp['locator_type'] ?? 'label')
    const sample = sampleFor(loc)
    const sampleStr = sample ? `  → sample: "${sample}"` : ''
    card.push(`   ✅ OPTIONAL INPUT   "${loc}"  locator_type: ${lt}${sampleStr}`)
  }

  // Optional selects (up to 4)
  const optSelects = selects.filter(s => !Boolean(s['required']))
  for (const sel of optSelects.slice(0, 4)) {
    const loc  = String(sel['locator'] ?? sel['name'] ?? '')
    const raw  = sel['options']
    const opts: string[] = Array.isArray(raw) ? raw.map(String).filter(Boolean) : []
    if (opts.length === 0) continue
    const optsStr = opts.slice(0, 5).join(' | ')
    card.push(`   ✅ OPTIONAL SELECT  "${loc}"  locator_type: label  → options: ${optsStr}`)
  }

  card.push('')

  // Submit buttons
  const ACTION_MENU_NAMES = /^(more|actions?|options?|settings?)$/i
  const SUBMENU_ACTIONS   = /^(delete|remove|archive|clone|duplicate|deactivate|disable|export)$/i
  const SUBMIT_VERBS      = /create|save|submit|add|new|update|delete|change|apply|confirm|done|finish|complete|more|action/i

  const submitBtns = buttons.filter(b => {
    const n = String(b['name'] ?? '').toLowerCase()
    return SUBMIT_VERBS.test(n)
  })

  if (submitBtns.length > 0) {
    const hasMenuBtn = submitBtns.some(b => ACTION_MENU_NAMES.test(String(b['name'] ?? '').trim()))
    const menuBtnName = hasMenuBtn
      ? String(submitBtns.find(b => ACTION_MENU_NAMES.test(String(b['name'] ?? '').trim()))?.['name'] ?? 'More')
      : null

    // For CREATE tests: prefer create/add/save buttons
    // For UPDATE tests: prefer update/save/change buttons
    const preferredBtn = (() => {
      if (testIntent === 'update') {
        return submitBtns.find(b => /update|save\s*changes|modify/i.test(String(b['name'] ?? '')))
          ?? submitBtns.find(b => /save/i.test(String(b['name'] ?? '')))
          ?? submitBtns.find(b => !ACTION_MENU_NAMES.test(String(b['name'] ?? '').trim()) && !SUBMENU_ACTIONS.test(String(b['name'] ?? '').trim()))
      }
      return submitBtns.find(b => /create|add|submit/i.test(String(b['name'] ?? '')))
        ?? submitBtns.find(b => /^\+\s*new|\bnew\s+/i.test(String(b['name'] ?? '')))
        ?? submitBtns.find(b => /save/i.test(String(b['name'] ?? '')))
        ?? submitBtns.find(b => !ACTION_MENU_NAMES.test(String(b['name'] ?? '').trim()) && !SUBMENU_ACTIONS.test(String(b['name'] ?? '').trim()))
    })()

    const primaryBtnName = preferredBtn ? String(preferredBtn['name'] ?? '').trim() : ''

    card.push('⚡ BUTTONS:')
    if (primaryBtnName) {
      card.push(`   ⚡ SUBMIT BUTTON: "${primaryBtnName}"  (locator_type: role)`)
      card.push(`      ← COPY THIS NAME EXACTLY — this is the ONLY valid submit button name`)
    }
    if (menuBtnName) {
      card.push(`   ⚡ ACTION MENU BUTTON: "${menuBtnName}"  (opens dropdown with secondary actions)`)
      // List submenu items
      const subItems = submitBtns.filter(b => SUBMENU_ACTIONS.test(String(b['name'] ?? '').trim()))
      for (const si of subItems) {
        const siName = String(si['name'] ?? '').trim()
        card.push(`   ⚡ SUBMENU ITEM: "${siName}"  [SUBMENU under "${menuBtnName}" — click "${menuBtnName}" first]`)
        // Inject confirmation button for delete
        if (/^delete$/i.test(siName)) {
          card.push(`   ⚡ CONFIRM BUTTON: "Delete ${resolvedEntity}"  (appears in confirmation dialog after clicking "${siName}")`)
        }
      }
    }

    // List all other buttons for reference
    const otherBtns = submitBtns.filter(b => {
      const n = String(b['name'] ?? '').trim()
      return n !== primaryBtnName && n !== menuBtnName && !SUBMENU_ACTIONS.test(n)
    }).slice(0, 4)
    for (const ob of otherBtns) {
      const n = String(ob['name'] ?? '').trim()
      if (n) card.push(`   ⚡ OTHER BUTTON: "${n}"  (locator_type: role)`)
    }
    card.push('')
  }

  card.push('══════════════════════════════════════════════════════════════════════════════')
  card.push('END OF ENTITY ANALYSIS CARD')
  card.push('══════════════════════════════════════════════════════════════════════════════')
  card.push('')

  return card.join('\n')
}


async function buildWebAppStructuredContext(
  projectId: string,
  targetObjs: string[],
  rawChunks: string[],
  testIntent: TestIntent = 'general',
  entityUrlMap: Record<string, EntityUrlInfo> = {},
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
          const singular = depluralize(entity.entity_name)
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
    // Scoring rationale:
    //   +10 — path segment exactly matches target entity (e.g. /leads)
    //   +5  — path contains entity string anywhere
    //   +20 — path contains a CREATE/NEW indicator → strongly prefer for CREATE tests
    //   +25 — path contains an EDIT/UPDATE indicator → strongly prefer for UPDATE tests
    //   +2  — entity appears in page title
    const scoredPages = allPages.map(page => {
      const path  = String(page['path']  ?? '').toLowerCase()
      const title = String(page['title'] ?? '').toLowerCase()
      let score = 0
      for (const t of targetLowers) {
        if (path.includes(`/${t}`)) score += 10
        if (path.includes(t))       score += 5
        if (title.includes(t))      score += 2
      }
      // Strong bonus for create/new pages — prevents list-page search fields from dominating
      if (/\/(new|create|add|form)(\/.*)?(\?|$)/.test(path))    score += 20
      // Equal/higher bonus for edit/update pages — prevents CREATE page buttons from polluting UPDATE tests
      else if (/\/(edit|update)(\/.*)?($|\?)/.test(path))       score += 25
      return { page, score }
    })
    scoredPages.sort((a, b) => b.score - a.score)
    // Only use pages that scored > 0 (i.e. path contains the target entity).
    // If nothing scored, fall back to the top-5 overall so we never return
    // a completely empty context — but log a warning so this is visible.
    const relevantPages = scoredPages.filter(s => s.score > 0)

    // Intent-aware page filtering:
    // • CREATE tests → strongly prefer create/new pages (filter out list pages)
    // • UPDATE tests → strongly prefer edit/update pages (filter out create pages)
    // • Other tests  → use all relevant pages
    let topCandidates = relevantPages.length > 0 ? relevantPages : scoredPages
    const hasCreatePage = topCandidates.some(s =>
      /\/(new|create|add|form)(\/.*)?(\?|$)/.test(String(s.page['path'] ?? '').toLowerCase())
    )
    const hasEditPage = topCandidates.some(s =>
      /\/(edit|update)(\/.*)?($|\?)/.test(String(s.page['path'] ?? '').toLowerCase())
    )

    if (testIntent === 'update' && hasEditPage) {
      // For UPDATE: prefer edit pages; drop pure CREATE and pure list pages
      const editOnly = topCandidates.filter(s =>
        /\/(edit|update)(\/.*)?($|\?)/.test(String(s.page['path'] ?? '').toLowerCase())
      )
      if (editOnly.length > 0) {
        topCandidates = editOnly
        log.info(`[GEN] buildWebAppStructuredContext: UPDATE test — filtered to ${editOnly.length} edit pages (dropped create/list pages)`)
      }
    } else if (hasCreatePage) {
      // For CREATE: drop pure list pages that would pollute the form field context
      const createOnly = topCandidates.filter(s =>
        /\/(new|create|add|form|edit|update)(\/.*)?(\?|$)/.test(String(s.page['path'] ?? '').toLowerCase())
      )
      if (createOnly.length > 0) {
        topCandidates = createOnly
        log.info(`[GEN] buildWebAppStructuredContext: CREATE test — filtered to ${createOnly.length} create/edit pages (dropped list pages to avoid search-field contamination)`)
      }
    }

    const topPages = topCandidates.slice(0, 5).map(s => s.page)
    if (relevantPages.length === 0) {
      log.warn(`[GEN] buildWebAppStructuredContext: no pages matched targets [${targetLowers.join(', ')}] — serving top-5 unfiltered pages (may cause irrelevant steps)`)
    } else {
      log.info(`[GEN] buildWebAppStructuredContext: ${relevantPages.length} pages matched targets [${targetLowers.join(', ')}], topPages=${topPages.length}`)
    }

    // ── Helper: resolve sample value for a field locator ────────────────
    // Looks up the entity's real record map and returns the best matching value.
    // Validates the value against the field's expected semantic type to prevent
    // mismatches like a URL being used for a Phone field or a number for a Website.
    function resolveSampleValue(
      fieldLocator: string,
      pagePath: string,
    ): string | null {
      // Derive entity name from page path: /accounts/create → 'account'
      const pathSegments = pagePath.split('/').filter(Boolean)
      const entitySegment = pathSegments.find(s =>
        !/^(new|create|add|edit|list|index|all|\d+)$/i.test(s)
      ) ?? ''
      const entityLower = depluralize(entitySegment)

      // Try the entity map, then each target object
      const maps = [
        testDataMap.get(entityLower),
        testDataMap.get(entityLower + 's'),
        ...targetLowers.map(t => testDataMap.get(t)),
        ...targetLowers.map(t => testDataMap.get(depluralize(t))),
      ].filter(Boolean) as Record<string, string>[]

      for (const dataMap of maps) {
        // Exact match on field locator (case-insensitive)
        const exactKey = Object.keys(dataMap).find(
          k => k.toLowerCase() === fieldLocator.toLowerCase()
        )
        if (exactKey) {
          const fixed = validateAndFixSampleValue(fieldLocator, dataMap[exactKey])
          return fixed || dataMap[exactKey]
        }

        // Fuzzy: check if the locator contains a key word or vice versa
        const locLower = fieldLocator.toLowerCase().replace(/[^a-z0-9]/g, '')
        const fuzzyKey = Object.keys(dataMap).find(k => {
          const kn = k.toLowerCase().replace(/[^a-z0-9]/g, '')
          return locLower.includes(kn) || kn.includes(locLower)
        })
        if (fuzzyKey) {
          const fixed = validateAndFixSampleValue(fieldLocator, dataMap[fuzzyKey])
          return fixed || dataMap[fuzzyKey]
        }
      }
      return null
    }

    // ── Build Required Fields + Button Grounding Summary ────────────────────
    // Scans ALL selected pages and collects:
    //   1. Every [REQUIRED] input/select/lookup field
    //   2. ALL submit/action buttons (create, save, update, delete, change, apply, etc.)
    // This is the GROUNDING BLOCK — injected first so the LLM is forced to plan
    // all required steps and copy the exact button name before writing any step.
    function buildRequiredFieldsSummary(): string {
      const allPageSummaries: string[] = []

      for (const page of topPages) {
        const path    = String(page['path'] ?? '/')
        const inputs  = (Array.isArray(page['inputs'])  ? page['inputs']  : []) as Record<string, unknown>[]
        const selects = (Array.isArray(page['selects']) ? page['selects'] : []) as Record<string, unknown>[]
        const buttons = (Array.isArray(page['buttons']) ? page['buttons'] : []) as Record<string, unknown>[]

        const reqInputs  = inputs.filter(i  => Boolean(i['required']))
        const reqSelects = selects.filter(s => Boolean(s['required']))
        // ── Expanded button matching: include ALL action/submit buttons ──────
        // Previously only matched 'create|save|submit|add' — this missed "Update Contact",
        // "Delete Record", "Save Changes", "Apply", etc. causing hallucinations.
        const submitBtns = buttons.filter(b => {
          const n = String(b['name'] ?? '').toLowerCase()
          return n.includes('create') || n.includes('save')   || n.includes('submit')
              || n.includes('add')    || n.includes('new')    || n.includes('update') || n.includes('delete')
              || n.includes('change') || n.includes('apply')  || n.includes('confirm')
              || n.includes('done')   || n.includes('finish')  || n.includes('complete')
        })


        // ── Inject synthetic required lookup fields for known entity relationships ──
        // The HTML crawler cannot detect custom lookup/combobox widgets that don't use
        // native <input required> — this is the root cause of "Account" being missed
        // on the Opportunity create page. We inject them programmatically here.
        const ENTITY_REQUIRED_LOOKUPS: Record<string, Array<{ locator: string; hint: string }>> = {
          opportunity:  [{ locator: 'Account', hint: 'Acme Corp' }, { locator: 'Close Date', hint: '06/30/2026' }],
          lead:         [{ locator: 'Company', hint: 'Acme Corp' }],
          contact:      [{ locator: 'Account Name', hint: 'Acme Corp' }],
          case:         [{ locator: 'Account Name', hint: 'Acme Corp' }],
          invoice:      [{ locator: 'Account', hint: 'Acme Corp' }, { locator: 'Opportunity', hint: 'New Business Deal' }],
          order:        [{ locator: 'Account', hint: 'Acme Corp' }],
          quote:        [{ locator: 'Opportunity', hint: 'New Business Deal' }],
          task:         [{ locator: 'Related To', hint: 'Acme Corp' }],
          activity:     [{ locator: 'Related To', hint: 'Acme Corp' }],
          deal:         [{ locator: 'Account', hint: 'Acme Corp' }],
          project:      [{ locator: 'Account', hint: 'Acme Corp' }],
          ticket:       [{ locator: 'Account', hint: 'Acme Corp' }],
          proposal:     [{ locator: 'Opportunity', hint: 'New Business Deal' }],
          subscription: [{ locator: 'Account', hint: 'Acme Corp' }],
          product:      [{ locator: 'Name', hint: 'Sample Product' }, { locator: 'Currency', hint: 'USD' }],
        }
        // Determine entity from path: /opportunity/new → 'opportunity'
        const pathEntity = path.split('/').filter(s => s && !/^(new|create|add|edit|list|index|all|\d+)$/i.test(s)).slice(-1)[0]?.toLowerCase() ?? ''
        const knownLookups = ENTITY_REQUIRED_LOOKUPS[pathEntity] ?? []
        // Only inject lookups that aren't ALREADY in reqInputs (avoid duplicates)
        const existingLocators = new Set(reqInputs.map(i => String(i['locator'] ?? '').toLowerCase()))
        const syntheticLookups = knownLookups.filter(l => !existingLocators.has(l.locator.toLowerCase()))

        // ── Fallback for CREATE pages where the crawler found no required fields ──
        // When a create form has all inputs marked required:false (common with modern
        // SPAs that handle validation client-side), reqInputs is empty and the page
        // is skipped — leaving the LLM with no field grounding.
        // Fix: for CREATE pages (/new, /create, /add), promote ALL inputs to
        // implicitly-required so the LLM knows what form fields exist.
        const isCreatePagePath = /\/(new|create|add|form)(\/.*)?(\?|$)/i.test(path)
        let effectiveReqInputs = reqInputs
        if (isCreatePagePath && reqInputs.length === 0 && inputs.length > 0 && syntheticLookups.length === 0) {
          // Use all available inputs as implicit required fields for the grounding table
          effectiveReqInputs = inputs.slice(0, 8)  // cap at 8 to avoid token overload
          log.info(
            { path, inputCount: inputs.length },
            '[GEN] buildRequiredFieldsSummary: CREATE page has no marked-required fields — promoting all inputs as implicit required'
          )
        }

        if (effectiveReqInputs.length === 0 && reqSelects.length === 0 && syntheticLookups.length === 0) continue

        const pageLines: string[] = []
        pageLines.push(`  Create Page: ${path}`)
        pageLines.push('  ┌─────────────────────────────────────────────────────────────────┐')
        pageLines.push('  │ STEP # │ ACTION │ FIELD LOCATOR (exact) │ REQUIRED VALUE        │')
        pageLines.push('  ├─────────────────────────────────────────────────────────────────┤')

        let stepNum = 2  // step 1 is always NAVIGATE
        let lookupCount = 0

        for (const inp of effectiveReqInputs) {
          const locator     = String(inp['locator'] ?? inp['name'] ?? '')
          const locatorType = String(inp['locator_type'] ?? 'label')
          const isLookup = /\b(account|contact|owner|parent|manager|assigned|lead|opportunity|vendor|customer|partner|report\s*to|bill\s*to|ship\s*to|related\s*to)\b/i.test(locator)
          const action   = isLookup ? 'LOOKUP ' : 'TYPE   '
          const sampleVal = resolveSampleValue(locator, path)
          const isImplicit = effectiveReqInputs !== reqInputs  // promoted from optional
          const valueHint = sampleVal
            ? `"${sampleVal}"`
            : isLookup
              ? '"Acme Corp" (or real record name)'
              : '"<realistic value>"'
          const prefix = isLookup
            ? '🔥 REQUIRED LOOKUP'
            : isImplicit
              ? '  [FILL — form field]'
              : '  [REQUIRED]       '
          if (isLookup) lookupCount++
          pageLines.push(`  │ Step ${stepNum++} │ ${action} │ ${prefix} "${locator}" (locator_type: "${locatorType}") │ → ${valueHint} │`)
        }

        // Render synthetic lookups that the crawler missed (custom lookup components)
        for (const syn of syntheticLookups) {
          const sampleVal = resolveSampleValue(syn.locator, path) ?? syn.hint
          pageLines.push(`  │ Step ${stepNum++} │ LOOKUP │ 🔥 REQUIRED LOOKUP "${syn.locator}" (locator_type: "label") │ → "${sampleVal}" │`)
          lookupCount++
        }

        for (const sel of reqSelects) {
          const locator = String(sel['locator'] ?? sel['name'] ?? '')
          const rawOptions = sel['options']
          const validOptions: string[] = Array.isArray(rawOptions) ? rawOptions.map(String).filter(Boolean) : []
          const valueHint = validOptions.length > 0 ? `"${validOptions[0]}" (options: ${validOptions.slice(0, 3).join(' | ')})` : '⛔ SKIP — no valid options'
          pageLines.push(`  │ Step ${stepNum++} │ SELECT │   [REQUIRED]        "${locator}" │ → ${valueHint} │`)
        }

        pageLines.push('  ├─────────────────────────────────────────────────────────────────┤')

        // Submit button
        let submitButtonName = ''
        if (submitBtns.length > 0) {
          const rawLocator  = String(submitBtns[0]['locator'] ?? submitBtns[0]['name'] ?? '')
          const nameMatch   = rawLocator.match(/name=(.+)$/)
          submitButtonName  = (nameMatch ? nameMatch[1].trim() : String(submitBtns[0]['name'] ?? '')).trim()
        }
        if (submitButtonName) {
          pageLines.push(`  │ Step ${stepNum} │ CLICK  │ [SUBMIT BUTTON] target: "${submitButtonName}" (locator_type: "role") │`)
          pageLines.push(`  │         ← COPY THIS NAME EXACTLY — do NOT use "Save" or any other name                     │`)
        } else {
          pageLines.push(`  │ Step ${stepNum} │ CLICK  │ [SUBMIT BUTTON] Infer from entity: "Create <EntityName>" (locator_type: "role")       │`)
        }
        pageLines.push('  └─────────────────────────────────────────────────────────────────┘')

        if (lookupCount > 0) {
          pageLines.push(`  ‼️  This page has ${lookupCount} 🔥 REQUIRED LOOKUP field(s). Each MUST have a LOOKUP step. No exceptions.`)
        }
        pageLines.push('')
        allPageSummaries.push(...pageLines)
      }

      if (allPageSummaries.length === 0) return ''

      return [
        '┌══════════════════════════════════════════════════════════════════════════════════════════┐',
        '│  🚨 MANDATORY REQUIRED FIELDS + BUTTON GROUNDING — READ THIS BEFORE WRITING ANY STEP   │',
        '│  Every row in the table below is a REQUIRED STEP. Missing even one = INVALID OUTPUT.   │',
        '│  🔥 REQUIRED LOOKUP rows are highest priority — NEVER skip them.                       │',
        '│  ⚡ [SUBMIT BUTTON] name must be COPIED EXACTLY — NEVER use "Save", "Submit", or any   │',
        '│     other assumed name. The EXACT name from the metadata IS the only valid button name. │',
        '│  ❌ DO NOT invent button names. DO NOT use generic names. Copy from [SUBMIT BUTTON].    │',
        '└══════════════════════════════════════════════════════════════════════════════════════════┘',
        '',
        ...allPageSummaries,
        '══════════════════════════════════════════════════════════════════════════════════════════',
        '',
      ].join('\n')
    }

    const requiredFieldsSummary = buildRequiredFieldsSummary()

    // ── Build entity analysis card (injected FIRST for deep analysis phase) ─
    // Extract entity name from targetObjs for the card builder
    const primaryEntityName = targetObjs[0]
      ? (depluralize(targetObjs[0]).charAt(0).toUpperCase() + depluralize(targetObjs[0]).slice(1))
      : 'Entity'
    const entityAnalysisCard = buildEntityAnalysisHeader(
      primaryEntityName,
      topPages,
      testDataMap,
      targetLowers,
      testIntent,
      entityUrlMap,
    )
    log.info(`[GEN] Entity analysis card built for "${primaryEntityName}" (${entityAnalysisCard.length} chars)`)

    // ── Build context string ─────────────────────────────────────────────
    const lines: string[] = [
      '=== WEB APPLICATION PAGE METADATA ===',
      'The following is REAL metadata crawled from the target web application.',
      'Each field shows its EXACT locator and ⚡ SAMPLE VALUE from real records.',
      'Use the EXACT locator string. Use the ⚡ SAMPLE VALUE as the step value.',
      '',
      // ── ENTITY ANALYSIS CARD first so LLM does its mandatory analysis ──
      ...(entityAnalysisCard ? [entityAnalysisCard] : []),
      ...(requiredFieldsSummary ? [requiredFieldsSummary] : []),
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
        // ── Expanded button detection — match ALL action/submit button types ──
        // Includes: update, delete, change, apply, confirm, done, finish, complete
        // This prevents hallucination of "Save" when the real button is "Update Contact"
        const submitBtns = buttons.filter(b => {
          const n = String(b['name'] ?? '').toLowerCase()
          return n.includes('create') || n.includes('save')   || n.includes('submit')
              || n.includes('add')    || n.includes('new')    || n.includes('update') || n.includes('delete')
              || n.includes('change') || n.includes('apply')  || n.includes('confirm')
              || n.includes('done')   || n.includes('finish')  || n.includes('complete')
              || n.includes('more')   || n.includes('action')  || n.includes('clone')
              || n.includes('remove') || n.includes('archive')
        })


        // ── Detect action-menu structure ─────────────────────────────────────
        // If there is a "More" / "Actions" / "Options" button on the page AND
        // destructive/secondary actions (Delete, Clone, Archive) are also present,
        // those secondary actions are SUBMENU items under the "More" button.
        // They CANNOT be clicked directly — the "More" button must be opened first.
        const ACTION_MENU_NAMES = /^(more|actions?|options?|settings?)$/i
        const SUBMENU_ACTIONS   = /^(delete|remove|archive|clone|duplicate|deactivate|disable|export)$/i

        const hasActionMenuBtn = submitBtns.some(b => ACTION_MENU_NAMES.test(String(b['name'] ?? '').trim()))
        const actionMenuBtnName = hasActionMenuBtn
          ? (submitBtns.find(b => ACTION_MENU_NAMES.test(String(b['name'] ?? '').trim()))?.['name'] as string ?? 'More')
          : null

        if (submitBtns.length > 0) {
          lines.push('  ⚡ SUBMIT / ACTION BUTTONS — COPY THESE NAMES EXACTLY FOR CLICK STEPS:')
          lines.push('  ❌ DO NOT use generic names ("Save", "Submit", "OK") — use ONLY the names listed below.')
          if (hasActionMenuBtn) {
            lines.push(`  ⚠ ACTION MENU DETECTED: "${actionMenuBtnName}" button opens a dropdown with secondary actions.`)
            lines.push(`    Submenu items (Delete, Clone, etc.) CANNOT be clicked directly.`)
            lines.push(`    You MUST click "${actionMenuBtnName}" FIRST, then click the submenu item.`)
          }
          for (const btn of submitBtns.slice(0, 8)) {
            // Extract the plain button name from the locator
            const rawLocator  = String(btn['locator'] ?? btn['name'] ?? '')
            const btnName     = String(btn['name'] ?? '')
            const nameMatch   = rawLocator.match(/name=(.+)$/)
            const displayName = (nameMatch ? nameMatch[1].trim() : btnName).trim()
            if (!displayName) continue
            const isSubmenu = hasActionMenuBtn && SUBMENU_ACTIONS.test(displayName)
            const annotation = isSubmenu
              ? `  [SUBMENU under "${actionMenuBtnName}" — click "${actionMenuBtnName}" first, then click "${displayName}"]`
              : ''
            lines.push(`    ⚡ BUTTON NAME: "${displayName}"${annotation}`)
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

// ── Canonical action name map ─────────────────────────────────────────────────
// AI models (especially non-gpt-4o) sometimes emit non-standard action names.
// Map them to the canonical names understood by the execution worker.
const ACTION_ALIASES: Record<string, string> = {
  // TYPE aliases — most common hallucination is FILL_FORM
  fill_form:     'TYPE',
  fillform:      'TYPE',
  fill_field:    'TYPE',
  fillfield:     'TYPE',
  enter:         'TYPE',
  enter_text:    'TYPE',
  set:           'TYPE',
  set_text:      'TYPE',
  settext:       'TYPE',
  input_text:    'TYPE',
  inputtext:     'TYPE',
  write:         'TYPE',
  type_text:     'TYPE',
  // CLICK aliases
  press:         'CLICK',
  tap:           'CLICK',
  submit:        'CLICK',
  button_click:  'CLICK',
  // SELECT aliases
  choose:        'SELECT',
  pick:          'SELECT',
  dropdown:      'SELECT',
  select_option: 'SELECT',
  // NAVIGATE aliases
  goto:          'NAVIGATE',
  go_to:         'NAVIGATE',
  open:          'NAVIGATE',
  visit:         'NAVIGATE',
  load:          'NAVIGATE',
}

function normaliseAction(raw: string): string {
  const upper = raw.toUpperCase().trim()
  const lower = raw.toLowerCase().trim()
  // Already canonical — return immediately
  const CANONICAL = new Set([
    'NAVIGATE', 'CLICK', 'TYPE', 'FILL', 'INPUT', 'SELECT', 'LOOKUP',
    'CHECKBOX', 'ASSERT_TEXT', 'ASSERT_URL', 'ASSERT_TOAST', 'WAIT',
    'MULTI_SELECT', 'UPLOAD', 'SCROLL', 'SCREENSHOT', 'CLEARCOOKIES',
  ])
  if (CANONICAL.has(upper)) return upper
  // Alias lookup
  const mapped = ACTION_ALIASES[lower]
  if (mapped) {
    log.warn(`[GEN] normaliseAction: mapped non-standard action "${raw}" → "${mapped}"`)
    return mapped
  }
  // Return upper-cased anyway — let the worker handle unknown gracefully
  return upper
}

function normaliseResponse(raw: Record<string, unknown>): GenerateResponse {
  const steps = (Array.isArray(raw['steps']) ? raw['steps'] : []) as Step[]
  // Normalize action names in every step before passing to the runner
  const normalizedSteps = steps.map(s => ({
    ...s,
    action: normaliseAction(String(s.action ?? '')),
  }))
  return {
    name:             String(raw['name']             ?? 'Unnamed Test'),
    description:      String(raw['description']      ?? ''),
    steps:            renumberSteps(normalizedSteps),
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

  // ── -2. Strip hallucinated login/authentication steps (HARD GUARD) ─────────
  // The LLM may still generate login steps despite prompt-level instructions.
  // This filter removes them at the output level — it is the final safety net.
  // A step is classified as a login step if:
  //   • It is a NAVIGATE to /login, /signin, /sign-in, /auth, or /session
  //   • It is a TYPE into a username/email/password field (for auth purposes)
  //   • It is a CLICK on a "Log In" / "Sign In" / "Login" button
  // EXCEPTION: a test whose name explicitly includes "login" (i.e. the feature
  //            being tested IS the login flow) is left untouched.
  const testingLoginFeature = /\blogin\b.*\bfeature\b|\btest.*login.*page\b/i.test(prompt)
  if (!testingLoginFeature) {
    const LOGIN_NAVIGATE_PATTERN = /^\/(login|signin|sign-in|auth|session)(\/|$)/i
    const AUTH_FIELD_PATTERN = /\b(username|password|email.*login|login.*email|sign.?in)\b/i
    const AUTH_BUTTON_PATTERN = /^(log\s*in|sign\s*in|login|signin)$/i

    const originalCount = result.steps.length
    result.steps = result.steps.filter((step) => {
      const action = String(step.action ?? '').toLowerCase()
      const target = String(step.target ?? '')
      const value  = String(step.value  ?? '')

      // NAVIGATE /login → strip
      if ((action === 'navigate' || action === 'goto' || action === 'open') &&
          LOGIN_NAVIGATE_PATTERN.test(value.trim())) {
        log.warn(`[GEN] Post-process: stripped login NAVIGATE step (value="${value}")`)
        return false
      }

      // TYPE into auth fields → strip
      if (action === 'type' && AUTH_FIELD_PATTERN.test(target)) {
        log.warn(`[GEN] Post-process: stripped auth TYPE step (target="${target}")`)
        return false
      }

      // CLICK on Log In / Sign In button → strip
      if (action === 'click' && AUTH_BUTTON_PATTERN.test(target.trim())) {
        log.warn(`[GEN] Post-process: stripped auth CLICK step (target="${target}")`)
        return false
      }

      return true
    })

    if (result.steps.length < originalCount) {
      log.info(`[GEN] Post-process: removed ${originalCount - result.steps.length} login/auth step(s). Remaining: ${result.steps.length}`)
      // Re-number remaining steps so ids are sequential
      result.steps = result.steps.map((step, idx) => ({ ...step, id: String(idx + 1) }))
    }
  }

  // ── -1b. Strip cross-entity CLICK buttons (HARD GUARD) ──────────────────
  // The LLM picks sidebar buttons for the WRONG entity (e.g. "+ New Lead"
  // in an Account test). This catches them at the final output level.
  {
    const entityMatch = prompt
      .replace(/^(create|update|edit|delete|view|add|manage|verify|test|check)\s+/i, '')
      .replace(/\b(new|a|an|the|successfully|with|for|and|or|record|records|details|detail|form|page|module|entry|item|valid|invalid|existing|required|optional|active|inactive|duplicate|mandatory|basic|empty|updated|given|correct|incorrect|multiple|successful)\b/gi, '')
      .trim()
    const entityHint = (entityMatch.match(/\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)?)\b/)?.[1]
      ?? entityMatch.split(/\s+/)[0] ?? '').trim()

    if (entityHint && entityHint.length > 2) {
      const entityLower = entityHint.toLowerCase()
      const beforeCount = result.steps.length

      result.steps = result.steps.filter(step => {
        const action = (step.action ?? '').toUpperCase()
        if (action !== 'CLICK') return true
        const target = (step.target ?? '').toLowerCase().trim()
        if (!target) return true

        // Detect "new/create/add <entity>" pattern
        const match = target.match(/\b(?:new|create|add)\s+([a-z]+(?:\s+[a-z]+)?)\b/)
        if (!match) return true
        const entityWord = match[1].trim()
        if (entityWord.length < 3 || ['the', 'a', 'an', 'new', 'all', 'item', 'record', 'entry'].includes(entityWord)) return true

        // Keep if entity matches
        if (entityLower.includes(entityWord) || entityWord.includes(entityLower)) return true

        // Cross-entity contamination → strip
        log.warn(`[GEN] Post-process: stripped cross-entity CLICK "${step.target}" — button is for "${entityWord}", test is for "${entityHint}"`)
        return false
      })

      if (result.steps.length < beforeCount) {
        log.info(`[GEN] Post-process: removed ${beforeCount - result.steps.length} cross-entity CLICK step(s) for entity "${entityHint}"`)
        result.steps = result.steps.map((step, idx) => ({ ...step, id: String(idx + 1) }))
      }
    }
  }

  // ── -1. Sanitise placeholder text leaking into step values ────────────────
  // The LLM sometimes copies instruction fragments like "real contact name from
  // REAL ENTITY RECORDS" verbatim into step values instead of using actual data.
  // These patterns are NEVER valid step values — strip them with an empty string
  // so the runner skips rather than attempting to type the instruction text.
  const PLACEHOLDER_PATTERNS = [
    /real\s+\w+\s+name\s+from\s+REAL\s+ENTITY\s+RECORDS/i,
    /REAL\s+ENTITY\s+RECORDS/i,
    /first\s+real\s+record/i,
    /primary[_\s]identifier/i,
    /search\s+term/i,
    /<[^>]+>/,       // angle-bracket placeholders like <contact name>
    /\[contact\s+name\]/i,
    /\[record\s+name\]/i,
  ]
  for (const step of result.steps) {
    const val = String(step.value ?? '')
    for (const pat of PLACEHOLDER_PATTERNS) {
      if (pat.test(val)) {
        log.warn(`[GEN] Post-process: placeholder text detected in step ${step.id} value "${val.slice(0, 60)}" — clearing`)
        step.value = ''
        break
      }
    }
    // Also check target
    const tgt = String(step.target ?? '')
    for (const pat of PLACEHOLDER_PATTERNS) {
      if (pat.test(tgt)) {
        log.warn(`[GEN] Post-process: placeholder text detected in step ${step.id} target "${tgt.slice(0, 60)}" — clearing`)
        step.target = ''
        break
      }
    }
  }

  // ── 0a. Fix bad search step locators for UPDATE/DELETE tests ──────────────
  // Problem: the LLM generates Step 2 as:
  //   { action: TYPE, target: "TITLE", locator_type: "label", value: "Test Company 2123" }
  // But there is no "TITLE" field on the list page — that's an edit form label.
  // The list page search box uses role=searchbox or a placeholder.
  //
  // Fix: for UPDATE/DELETE tests, if the 2nd non-NAVIGATE TYPE step has a target
  // that looks like a form field label (not "searchbox", not a placeholder-style string),
  // correct it to use role=searchbox.
  const isUpdateOrDelete = /\b(update|edit|modify|change|delete|remove|archive)\b/i.test(prompt)
  if (isUpdateOrDelete) {
    // Form-field label patterns that CANNOT be a list-page search box
    const FORM_FIELD_LABELS = /^(title|name|first.?name|last.?name|company|email|phone|account|contact|lead|subject|description|address|status|stage|type|category|priority|amount|date)$/i

    let typeStepCount = 0
    for (const step of result.steps) {
      const action = (step.action ?? '').toUpperCase()
      if (action === 'NAVIGATE') continue
      if (action !== 'TYPE') { typeStepCount = 0; continue }

      typeStepCount++
      // The FIRST TYPE step after NAVIGATE is the search step
      if (typeStepCount === 1) {
        const tgt = String(step.target ?? '').trim()
        const lt  = String(step.locator_type ?? '').toLowerCase()
        // If the target is a form-field label (not searchbox/placeholder), fix it
        if (FORM_FIELD_LABELS.test(tgt) || (lt === 'label' && tgt.toLowerCase() !== 'searchbox')) {
          log.warn(`[GEN] Post-process: bad search step target "${tgt}" (locator_type: "${lt}") — correcting to searchbox`)
          step.target       = 'searchbox'
          step.locator_type = 'role'
          // Keep the value (the actual name) — it should still be valid
        }
        break // Only fix the first TYPE step
      }
    }
  }

  // ── 0b. Inject "Click More" + confirm step for DELETE tests ──────────────
  // Problem 1: "Delete" is a submenu item under "More" — need to open More first.
  // Problem 2: Clicking "Delete" opens a confirmation dialog ("Delete Contact?") —
  //            need to click the confirm button ("Delete Contact") before asserting.
  const isDeleteTest = /\b(delete|remove|archive|trash)\b/i.test(prompt)
  if (isDeleteTest) {
    // Check if the context mentions a 'More'/'Actions' button
    const contextHasMoreBtn = /⚡ BUTTON NAME:\s*"(More|Actions?|Options?)"/i.test(ragContext)

    // Extract entity name from prompt for confirmation button (e.g. "Delete Contact" → "Contact")
    const entityMatch = prompt.match(/\b(delete|remove)\s+(?:a\s+|an\s+|the\s+)?([a-z]+)\b/i)
    const entityName = entityMatch ? entityMatch[2].trim() : ''
    // Confirmation button name: "Delete Contact", "Delete Account", etc.
    const confirmBtnName = entityName
      ? `Delete ${entityName.charAt(0).toUpperCase() + entityName.slice(1).toLowerCase()}`
      : 'Delete Contact'

    const DESTRUCTIVE_TARGETS = /^(delete|remove|archive|deactivate|trash)$/i
    const ACTION_MENU_TARGETS = /^(more|actions?|options?)$/i
    const CONFIRM_TARGETS     = /^(delete|remove|confirm|yes|proceed|ok)/i

    for (let i = 0; i < result.steps.length; i++) {
      const step = result.steps[i]
      const action = (step.action ?? '').toUpperCase()
      const tgt = String(step.target ?? '').trim()

      if (action !== 'CLICK' || !DESTRUCTIVE_TARGETS.test(tgt)) continue

      // ── Fix A: Inject "Click More" before the destructive step if missing ──
      const prevClickStep = result.steps.slice(0, i).reverse().find(s =>
        (s.action ?? '').toUpperCase() === 'CLICK'
      )
      const prevClickTarget = String(prevClickStep?.target ?? '').trim()
      const alreadyOpensMenu = ACTION_MENU_TARGETS.test(prevClickTarget) ||
        /more|action|option/i.test(prevClickTarget)

      if (!alreadyOpensMenu) {
        const menuBtnName = contextHasMoreBtn
          ? (ragContext.match(/⚡ BUTTON NAME:\s*"(More|Actions?|Options?)"/i)?.[1] ?? 'More')
          : 'More'

        const moreStep = {
          id: `${step.id}-more`,
          action: 'CLICK',
          target: menuBtnName,
          locator_type: 'role',
          value: '',
          expected_result: `"${menuBtnName}" dropdown menu opens`,
          test_data: '',
        }
        result.steps.splice(i, 0, moreStep)
        i++ // shift index since we inserted before current
        log.info(`[GEN] Post-process: injected "Click ${menuBtnName}" before "Click ${tgt}"`)
      }

      // ── Fix B: Inject confirmation step after the destructive step if missing ──
      // Check the step immediately AFTER the current destructive step
      const nextStepIdx = i + 1
      const nextStep = result.steps[nextStepIdx]
      const nextAction = (nextStep?.action ?? '').toUpperCase()
      const nextTarget = String(nextStep?.target ?? '').trim()
      const nextIsConfirm = nextAction === 'CLICK' && CONFIRM_TARGETS.test(nextTarget)

      if (!nextIsConfirm) {
        const confirmStep = {
          id: `${step.id}-confirm`,
          action: 'CLICK',
          target: confirmBtnName,
          locator_type: 'role',
          value: '',
          expected_result: `Record is deleted and confirmation dialog is dismissed`,
          test_data: '',
        }
        result.steps.splice(nextStepIdx, 0, confirmStep)
        log.info(`[GEN] Post-process: injected confirm step "Click ${confirmBtnName}" after "Click ${tgt}"`)
      }

      break // Only process the first destructive step
    }
  }

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
  // Hoist knownPaths to function scope so entityListPath derivation below can use it
  const knownPaths: string[] = []

  if (ragContext || Object.keys(entityUrlMap).length > 0) {
    // Collect all known page paths from the RAG context header lines
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

  // ── NEW: Catch compound-path hallucinations using entityUrlMap fuzzy match ──
  // Problem: LLM generates /invoices/custom-fields for entity "Invoice Custom Fields"
  // because no metadata exists and it guesses based on entity name tokens.
  // Fix: if a NAVIGATE step path does not match any known path, try to find
  // the correct path by token-matching against entityUrlMap values.
  if (isWebApp && Object.keys(entityUrlMap).length > 0) {
    for (const step of result.steps) {
      if ((step.action ?? '').toUpperCase() !== 'NAVIGATE') continue
      const rawUrlHalluc = String(step.value || step.target || '').replace(/^URL:\s*/i, '').trim()
      if (!rawUrlHalluc.startsWith('/') || rawUrlHalluc === '/') continue

      // Skip if already a known path (exact or prefix)
      const alreadyKnownHalluc = knownPaths.some(p => p === rawUrlHalluc || rawUrlHalluc.startsWith(p))
      if (alreadyKnownHalluc) continue

      // Token-match generated path against entityUrlMap verified paths
      const rawTokensHalluc = rawUrlHalluc.toLowerCase().split(/[\/\-]/).filter((t: string) => t.length > 2 && !/^(new|create|add|edit|list)$/.test(t))
      if (rawTokensHalluc.length === 0) continue

      let bestHallucMatch: string | null = null
      let bestHallucScore = 0

      for (const [, info] of Object.entries(entityUrlMap)) {
        const verifiedPath = typeof info === 'string' ? info : (info as EntityUrlInfo).path
        const pathTokens = verifiedPath.toLowerCase().split(/[\/\-]/).filter(Boolean)
        const matchCount = rawTokensHalluc.filter((t: string) => pathTokens.some((pt: string) => pt.includes(t) || t.includes(pt))).length
        const score = matchCount / rawTokensHalluc.length
        if (score > 0.5 && score > bestHallucScore) {
          bestHallucScore = score
          bestHallucMatch = verifiedPath
        }
      }

      if (bestHallucMatch && bestHallucMatch !== rawUrlHalluc) {
        log.warn(`[GEN] Post-process: compound-path hallucination corrected "${rawUrlHalluc}" → "${bestHallucMatch}" (entityUrlMap token match, score=${bestHallucScore.toFixed(2)})`)
        step.value = bestHallucMatch
      } else if (!bestHallucMatch) {
        log.warn(`[GEN] Post-process: no verified URL for invented path "${rawUrlHalluc}" — replacing with "/" to avoid 404`)
        step.value = '/'
      }
    }
  }

  // Fix button names for ALL form-submission test types (CREATE, UPDATE, DELETE)
  // Previously only CREATE tests were patched — this caused hallucinated "Save" buttons
  // on UPDATE tests even when metadata clearly showed "Update Contact".
  const isCreateTest = /\b(create|add|new)\b/i.test(prompt)
  const isUpdateTest = /\b(update|edit|modify|change)\b/i.test(prompt)
  if (!isCreateTest && !isUpdateTest) return result

  let expectedBtnName = ''
  let foundExactBtnInRag = false

  // ── A. Extract the EXACT button name from the RAG metadata ─────────────
  // The structured context builder formats buttons as: ⚡ BUTTON NAME: "Update Contact"
  // For UPDATE tests: prefer buttons with "update|save|change" in name.
  // For CREATE tests: prefer buttons with "create|add|submit" in name.
  if (ragContext) {
    // Collect ALL button names from the metadata
    const allBtnMatches = [...ragContext.matchAll(/⚡ BUTTON NAME:\s*"([^"]+)"/gi)]
    if (allBtnMatches.length > 0) {
      const allBtnNames = allBtnMatches.map(m => m[1].trim())
      log.info(`[GEN] Post-process: found ${allBtnNames.length} button name(s) in RAG context: ${allBtnNames.join(', ')}`)

      if (isUpdateTest) {
        // Prefer update/save/change buttons for UPDATE tests
        const updateBtn = allBtnNames.find(n => /update|save changes|modify/i.test(n))
        expectedBtnName = updateBtn ?? allBtnNames[0]
      } else {
        // Prefer create/add/submit buttons for CREATE tests
        const createBtn = allBtnNames.find(n => /create|add|submit/i.test(n))
        expectedBtnName = createBtn ?? allBtnNames[0]
      }

      if (expectedBtnName) {
        foundExactBtnInRag = true
        log.info(`[GEN] Post-process: selected exact button name "${expectedBtnName}" from RAG context (intent: ${isUpdateTest ? 'UPDATE' : 'CREATE'})`)
      }
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
        seg = depluralize(seg)
        entityName = seg.charAt(0).toUpperCase() + seg.slice(1)
        entityExtractedFromSteps = true
        log.info(`[GEN] Post-process: entity "${entityName}" extracted from NAVIGATE URL "${urlVal}" (last segment)`)
        break
      }
    }
  }

  // B2. Fallback: Try TYPE/CLICK step targets (e.g., "Campaign Name", "New Campaign")
  if (!entityName) {
    // ── FIELD-QUALIFIER BLACKLIST ──
    // Words that commonly prefix "Name" but are NOT entity names.
    // "Last Name" → "Last" is a field qualifier, NOT the entity.
    // "Lead Name" → "Lead" IS the entity.
    const FIELD_QUALIFIER_WORDS = new Set([
      'first', 'last', 'middle', 'full', 'nick', 'maiden', 'given', 'family',
      'company', 'email', 'phone', 'mobile', 'fax', 'street', 'city', 'state',
      'country', 'zip', 'postal', 'billing', 'shipping', 'mailing',
      'user', 'display', 'file', 'folder', 'tag', 'label', 'field',
      'product', 'item', 'task', 'event', 'note',  // ambiguous — skip in this context
    ])

    for (const step of result.steps) {
      const action = (step.action ?? '').toUpperCase()
      const target = String(step.target ?? '')
      if (action === 'TYPE' && target) {
        // "Campaign Name" → "Campaign", "Account Name" → "Account"
        const fieldMatch = target.match(/^([A-Z][a-z]+)\s+Name$/i)
        if (fieldMatch) {
          const candidate = fieldMatch[1].toLowerCase()
          // Skip field qualifiers — they are NOT entity names
          if (FIELD_QUALIFIER_WORDS.has(candidate)) {
            log.info(`[GEN] Post-process: skipped field qualifier "${fieldMatch[1]}" from TYPE field "${target}" — not an entity`)
            continue   // keep looking at other steps
          }
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
  
  // ── Derive the real list-page URL for ASSERT_URL ──────────────────────────
  // Priority: (1) entity URL map, (2) known page path from RAG context that matches
  // entity name, (3) naive pluralization (last resort — avoids '/opportunitys' typo)
  let entityListPath = `/${capitalizedEntity.toLowerCase()}s`  // naive default

  // Check entityUrlMap first (highest confidence)
  const urlInfoForEntity = Object.entries(entityUrlMap).find(
    ([eName]) => eName.toLowerCase() === capitalizedEntity.toLowerCase()
  )?.[1]
  if (urlInfoForEntity) {
    const rawPath = typeof urlInfoForEntity === 'string' ? urlInfoForEntity : urlInfoForEntity.path
    // Strip any /new, /create suffix to get the list page
    entityListPath = rawPath.replace(/\/(new|create|add|edit|update)(\/.*)?(\?|$).*/, '')
    log.info(`[GEN] Post-process: list path from entityUrlMap → "${entityListPath}"`)
  } else if (knownPaths.length > 0) {
    // Find the best list-page path from RAG context: a path containing the entity name
    // but NOT containing /new|/create|/edit suffixes
    const entityLower = capitalizedEntity.toLowerCase()
    const listPage = knownPaths.find(p => {
      const pl = p.toLowerCase()
      return pl.includes(entityLower) && !/\/(new|create|add|edit|update)(\/?|$)/i.test(p)
    })
    if (listPage) {
      // Strip any trailing /new|/create suffix
      entityListPath = listPage.replace(/\/(new|create|add|edit|update)(\/.*)?(\?|$).*/, '')
      log.info(`[GEN] Post-process: list path from knownPaths → "${entityListPath}"`)
    }
  }

  const entityPlural = entityListPath  // renamed for clarity, keeps backward compat

  log.info(`[GEN] Post-process: entity="${capitalizedEntity}", expectedBtn="${expectedBtnName}", listPath="${entityPlural}", foundInRag=${foundExactBtnInRag}`)

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
      const curUrlEntity = depluralize(curUrl.replace(/^\//, ''))
      const entityMismatch = curUrlEntity && curUrlEntity !== capitalizedEntity.toLowerCase()
      if (foundExactBtnInRag || (entityExtractedFromSteps && entityMismatch) || curUrl.length < 3 || curUrl === '/') {
         assertStep.value = entityPlural
         log.info(`[GEN] Post-process: corrected ASSERT_URL "${curUrl}" → "${entityPlural}"`)
      }
    }
  } else {
    // Append ASSERT_URL if completely missing
    result.steps.push({
      id: String((result.steps.length) + 1),
      action: 'ASSERT_URL',
      target: 'url',
      locator_type: 'url',
      value: entityPlural,
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
  const providerLower = provider.toLowerCase().trim()
  if (providerLower !== 'openai' && providerLower !== 'claude') {
    throw { statusCode: 400, message: `Unsupported provider '${provider}'. Use 'openai' or 'claude'.` }
  }

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
    testIntentInstructions = buildIntentInstructions(testIntent, prompt)

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
          ragContext = await buildWebAppStructuredContext(project_id, targetObjs, chunks, testIntent, globalEntityUrlMap)
          log.info(`[GEN] Web App: built structured context for intent=${testIntent} (${ragContext.length} chars)`)
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

        // ── Web App: route through STEP_GEN_MODEL agent for validated generation ──
        // The runTestStepGeneratorAgent uses STEP_GEN_MODEL (env var, defaults to gpt-4o)
        // and runs up to 3 self-correction loops with a 5-check validation gate:
        //   ✅ Check 1: required field coverage (no missing REQUIRED fields)
        //   ✅ Check 2: URL verification (only crawled paths used)
        //   ✅ Check 3: button name exactness (actual button from page, e.g. "Create Account")
        //   ✅ Check 4: locator type validity (LOOKUP uses label, SELECT uses options)
        //   ✅ Check 5: data type alignment (phone/email/date formats)
        // Non-webapp projects (Salesforce) continue using the direct LLM call below.
        if (isWebAppProject) {
          try {
            const { runTestStepGeneratorAgent } = await import('../ai-agents/test-step-generator.agent.js')
            const targetObjs = extractTargetObjects(prompt)
            const entityFilter = targetObjs[0] // narrow metadata to primary entity

            log.info(`[GEN] Web App: delegating to STEP_GEN_MODEL agent (entity="${entityFilter}", chunks=${chunks.length})`)

            const agentOutput = await runTestStepGeneratorAgent({
              projectId:    project_id,
              testName:     prompt.trim().slice(0, 200),
              description:  prompt,
              entityFilter: entityFilter || undefined,
            })

            log.info(
              `[GEN] STEP_GEN_MODEL agent done: ${agentOutput.steps.length} steps, ` +
              `loops=${agentOutput.loopCount}, confidence=${agentOutput.confidence}, ` +
              `passed=${agentOutput.validation.passed}`,
            )

            if (agentOutput.validation.issues.length > 0) {
              log.warn(`[GEN] Agent validation issues: ${agentOutput.validation.issues.join('; ')}`)
            }

            // Map AgentStep_Playwright → Step (same shape, just ensure required fields)
            const agentSteps: Step[] = agentOutput.steps.map((s, i) => ({
              id:           String(i + 1),
              action:       normaliseAction(s.action),
              target:       s.target,
              value:        s.value,
              locator_type: s.locator_type,
            }))

            const agentNormalised: GenerateResponse = {
              name:             prompt.trim().slice(0, 80),
              description:      prompt,
              steps:            agentSteps,
              priority:         'medium',
              preconditions:    ['User is already authenticated'],
              expected_outcome: `${entityFilter ?? 'Entity'} created/updated successfully`,
            }

            agentNormalised.steps = validateFieldValueAlignment(agentNormalised.steps)
            // Filter hallucinated fields (e.g., "Email" on Account form)
            if (project_id) {
              agentNormalised.steps = await filterNonExistentFieldSteps(agentNormalised.steps, project_id, entityFilter)
            }
            const agentResult = ensureWebAppCreateSteps(agentNormalised, prompt, true, ragContext, entityUrlMap)

            log.info(`[GEN] Web App via STEP_GEN_MODEL: ${agentResult.steps.length} final steps`)
            return { ...agentResult, rag_context_used: true, retrieved_chunks: chunks.length }

          } catch (agentErr) {
            log.warn({ err: agentErr }, '[GEN] STEP_GEN_MODEL agent failed — falling back to direct LLM')
            // Fall through to direct LLM call below
          }
        }

        // ── Non-webapp (Salesforce MCP) — direct LLM call ──────────────────────
        const ragSystemPrompt = WEB_APP_RAG_SYSTEM_PROMPT
          .replace('{rag_context}', ragContext)
          .replace('{test_data_context}', webTestDataContext || '(No real records available — use realistic unique placeholders)')
          .replace('{test_intent_instructions}', testIntentInstructions)
          .replace('{multi_entity_instructions}', multiEntityInstructions)
          .replace('{user_specified_values}', userSpecifiedValuesContext)

        const rawResult    = await invokeLlm(ragSystemPrompt, prompt, provider, model)
        const normalised   = normaliseResponse(rawResult)
        // Filter hallucinated fields — runs for ALL project types (web app + Salesforce)
        if (isWebAppProject) {
          normalised.steps = validateFieldValueAlignment(normalised.steps)
        }
        if (project_id) {
          const directEntityHint = prompt
            .replace(/^(create|update|edit|delete|view|add|manage|verify|test|check)\s+/i, '')
            .replace(/\b(new|a|an|the|successfully|with|for|and|or|record|records|details|detail|valid|invalid|existing|required|optional|active|inactive|duplicate|mandatory|basic|empty|updated|given|correct|incorrect|multiple|successful)\b/gi, '')
            .trim().split(/\s+/)[0] ?? ''
          normalised.steps = await filterNonExistentFieldSteps(normalised.steps, project_id, directEntityHint || undefined)
        }
        const result       = ensureWebAppCreateSteps(normalised, prompt, isWebAppProject, ragContext, entityUrlMap)

        log.info(`[GEN] ${isWebAppProject ? 'Web App (direct LLM fallback)' : 'MCP'} RAG generation successful with ${chunks.length} chunks`)
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
      const structured = await buildWebAppStructuredContext(project_id, targetObjs, [], testIntent, globalEntityUrlMap)
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

  // ── LAST RESORT: synthesize metadata from web_test_data field names ──────
  // When BOTH crawled metadata AND live scrape failed (no webAppRagContext),
  // but we DO have web_test_data records for the entity, we can still extract
  // the field NAMES (keys) from those records and build synthetic form metadata.
  // This ensures the LLM gets WEB_APP_RAG_SYSTEM_PROMPT with a proper required-
  // fields checklist instead of the generic STANDARD_SYSTEM_PROMPT.
  if (project_id && isWebAppProject && !webAppRagContext && !sfRagContext) {
    try {
      const { getTestData } = await import('../webapp/webapp-test-data.service.js')
      const targetObjs = extractTargetObjects(prompt)
      const testDataEntities = await getTestData(project_id)

      // Find the matching entity's test data
      const matchingEntity = testDataEntities.find(e =>
        targetObjs.some(t => e.entity_name.toLowerCase() === t.toLowerCase() ||
                              e.entity_name.toLowerCase() === depluralize(t))
      )

      if (matchingEntity && matchingEntity.records.length > 0) {
        // Extract unique field names from all records (deduplicate case-insensitively)
        const fieldNameMap = new Map<string, string>()  // lowercase → best display name
        for (const rec of matchingEntity.records.slice(0, 5)) {
          for (const key of Object.keys(rec)) {
            const trimmed = key.trim()
            if (!trimmed) continue
            const lower = trimmed.toLowerCase()
            // Prefer Title Case over ALL CAPS (e.g. "Account" over "ACCOUNT")
            if (!fieldNameMap.has(lower) || (trimmed !== trimmed.toUpperCase() && fieldNameMap.get(lower) === fieldNameMap.get(lower)?.toUpperCase())) {
              fieldNameMap.set(lower, trimmed)
            }
          }
        }
        const fieldNames = new Set(fieldNameMap.values())

        if (fieldNames.size > 0) {
          const entityName = matchingEntity.entity_name  // e.g. "Opportunity"
          const entityLower = entityName.toLowerCase()    // e.g. "opportunity"

          // Known entity-to-URL patterns for common CRM apps
          const createPath = `/${entityLower}/new`

          // Build synthetic page metadata
          const LOOKUP_FIELDS = /^(account|contact|owner|parent|manager|assigned|lead|opportunity|vendor|customer|partner|report\s*to|bill\s*to|ship\s*to|related\s*to|company)$/i
          const REQUIRED_FIELDS = /^(account|contact|name|first\s*name|last\s*name|email|close\s*date|company|status|stage|opportunity\s*name|account\s*name|lead\s*name|contact\s*name)$/i

          const lines: string[] = [
            '=== WEB APPLICATION PAGE METADATA ===',
            'The following metadata was derived from stored entity field names.',
            'Use these EXACT field names and page routes when generating test steps.',
            '',
            // Inject the mandatory checklist header
            '\u250c\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2510',
            '\u2502  \ud83d\udea8 MANDATORY REQUIRED FIELDS CHECKLIST \u2014 READ THIS BEFORE WRITING ANY STEP \ud83d\udea8          \u2502',
            '\u2502  Every row in the table below is a REQUIRED STEP. Missing even one = INVALID OUTPUT.    \u2502',
            '\u2502  \ud83d\udd25 REQUIRED LOOKUP rows are highest priority \u2014 NEVER skip them.                        \u2502',
            '\u2514\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2518',
            '',
            `  Create Page: ${createPath}`,
          ]

          let stepNum = 2
          const fieldArray = Array.from(fieldNames)

          // Required lookup fields first
          for (const field of fieldArray) {
            if (LOOKUP_FIELDS.test(field)) {
              lines.push(`  │ Step ${stepNum++} │ LOOKUP │ 🔥 REQUIRED LOOKUP "${field}" (locator_type: "label") │ → use real record name │`)
            }
          }
          // Then other required fields
          for (const field of fieldArray) {
            if (!LOOKUP_FIELDS.test(field) && REQUIRED_FIELDS.test(field)) {
              lines.push(`  │ Step ${stepNum++} │ TYPE   │   [REQUIRED]        "${field}" (locator_type: "label") │ → use realistic value  │`)
            }
          }
          // Then all remaining fields as optional
          for (const field of fieldArray) {
            if (!LOOKUP_FIELDS.test(field) && !REQUIRED_FIELDS.test(field)) {
              lines.push(`    [OPTIONAL] TYPE  locator: "${field}"  (locator_type: "label")`)
            }
          }

          lines.push('')
          lines.push(`  [SUBMIT BUTTON] CLICK  target: "Create ${entityName}"  locator_type: "role"  ← USE THIS EXACT NAME`)
          lines.push('')

          lines.push(`--- Page: ${createPath} (${entityName} Create Form) ---`)
          lines.push('  Submit Buttons (use for CLICK step after filling all fields):')
          lines.push(`    ⚡ BUTTON NAME: "Create ${entityName}"  →  Use this EXACT name as target for the CLICK step  (locator_type: "role")`)
          lines.push('')

          // Add required fields section
          lines.push('  ⚠ MANDATORY Form Fields (MUST fill these when creating a record):')
          for (const field of fieldArray) {
            if (LOOKUP_FIELDS.test(field) || REQUIRED_FIELDS.test(field)) {
              const isLookup = LOOKUP_FIELDS.test(field)
              lines.push(`    \u2022 [REQUIRED] [label] ${field}  (tag=${isLookup ? 'lookup' : 'input'})`)
            }
          }

          // Add optional fields
          const optFields = fieldArray.filter(f => !LOOKUP_FIELDS.test(f) && !REQUIRED_FIELDS.test(f))
          if (optFields.length > 0) {
            lines.push('  Optional Form Fields:')
            for (const field of optFields) {
              lines.push(`    \u2022 [label] ${field}  (tag=input)`)
            }
          }

          lines.push('')
          lines.push('=== END OF WEB APPLICATION PAGE METADATA ===')

          webAppRagContext = lines.join('\n')
          log.info(`[GEN] Synthesized metadata from web_test_data: entity=${entityName}, fields=${fieldNames.size}, path=${createPath}`)

          // Update session instruction to be metadata-aware
          sessionInstruction =
            '\n\nIMPORTANT: This is a web application project with an active login session. ' +
            'DO NOT generate any login/authentication steps. The user is ALREADY authenticated. ' +
            'Start the test from the relevant page directly using relative URL paths. ' +
            'Use ONLY field labels from the APPLICATION METADATA provided — do not invent field names.'
        }
      }
    } catch (synthErr) {
      log.warn({ err: synthErr }, '[GEN] Synthetic metadata from web_test_data failed (non-critical)')
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
    // Filter hallucinated fields — runs for ALL project types (web app + Salesforce)
    if (project_id) {
      const promptEntityHint = prompt
        .replace(/^(create|update|edit|delete|view|add|manage|verify|test|check)\s+/i, '')
        .replace(/\b(new|a|an|the|successfully|with|for|and|or|record|records|details|detail|valid|invalid|existing|required|optional|active|inactive|duplicate|mandatory|basic|empty|updated|given|correct|incorrect|multiple|successful)\b/gi, '')
        .trim().split(/\s+/)[0] ?? ''
      normalised.steps = await filterNonExistentFieldSteps(normalised.steps, project_id, promptEntityHint || undefined)
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
        // Filter hallucinated fields — runs for ALL project types
        if (project_id) {
          const fbEntityHint = prompt
            .replace(/^(create|update|edit|delete|view|add|manage|verify|test|check)\s+/i, '')
            .replace(/\b(new|a|an|the|successfully|with|for|and|or|record|records|details|detail|valid|invalid|existing|required|optional|active|inactive|duplicate|mandatory|basic|empty|updated|given|correct|incorrect|multiple|successful)\b/gi, '')
            .trim().split(/\s+/)[0] ?? ''
          fallbackNormalised.steps = await filterNonExistentFieldSteps(fallbackNormalised.steps, project_id, fbEntityHint || undefined)
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
