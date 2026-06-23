/**
 * Test Step Generator Agent — Phase 1, Agent 3
 *
 * The highest-ROI agent: replaces the single-shot LLM call in generation.service.ts
 * with a fully autonomous, 5-check validated, self-correcting step generation pipeline.
 *
 * LLM: OpenAI gpt-4o
 * ReAct: Observe → Think → Act → Reflect → Deliver
 *
 * Anti-hallucination gate (5 checks before accepting output):
 *   1. Required field coverage  — COUNT_B ≥ COUNT_REQUIRED
 *   2. URL verification         — every NAVIGATE path in verified URL map
 *   3. Button name exactness    — CLICK target matches metadata submit button
 *   4. Locator type validity    — lookups use LOOKUP, selects use SELECT
 *   5. Data type alignment      — phone/email/date/amount format checks
 *
 * Max 3 self-correction loops before calling hitlTool.
 */
import { ChatOpenAI }            from '@langchain/openai'
import { ChatAnthropic }         from '@langchain/anthropic'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { StringOutputParser }    from '@langchain/core/output_parsers'
import { v4 as uuidv4 }          from 'uuid'

import { createModuleLogger }    from '../../shared/logger/index.js'
import { ragSearchTool }         from './tools/rag-search.tool.js'
import { buildFieldManifest, buildUrlMap, formatManifestForPrompt, autoCorrectButtonNames, getEntityPlural } from './tools/metadata-reader.tool.js'
import { getTestCaseById, logAgentExecution } from './tools/db-query.tool.js'
import { hitlTool }              from './tools/hitl.tool.js'
import {
  formatLearningsForPrompt,
  saveGenerationOutcome,
  getButtonMapping,
} from '../self-healing/learning-registry.service.js'
import { loadLearnings, formatLearningsBlock, extractFieldTypeCorrections, formatFieldTypeCorrectionsBlock } from '../test-run/hitl-learning.service.js'
import prisma                    from '../../shared/db/prisma.js'
import type {
  AgentStep_Playwright,
  StepValidationResult,
  HITLInput,
} from './agent.types.js'

const log = createModuleLogger('step-generator-agent')

// ── Operation Type Detection ───────────────────────────────────────────────────
// Single source of truth for detecting the primary operation from a test name.
// Evaluated in PRIORITY ORDER: Update > Delete > View > Convert > Search > Create
// This function is exported so test-case-generator.service.ts can use the same logic.

export type OperationType = 'create' | 'update' | 'delete' | 'view' | 'search' | 'convert' | 'unknown'

export function detectOperationType(testName: string): OperationType {
  const name = testName.trim()

  // ── Priority 1: UPDATE (highest — must beat Create when both keywords appear) ──
  // Covers: "Update SKU weight and dimensions", "Edit Account", "Modify existing Lead"
  // Also covers compound phrases like "Update <field> and <field>" where the
  // entity word comes AFTER Update and before "and".
  const UPDATE_RE = /\b(update|edit|modify|change|updating|modifying|editing|modifies|changes|edits|updates)\b/i
  const EXISTING_RE = /\bexisting\s+\w+/i
  // Extra signal: test mentions a field descriptor + update verb anywhere
  const FIELD_DESCRIPTOR_RE = /\b(weight|dimension|sku|price|quantity|status|value|field|attribute|specification|detail|description|name|title|amount|rate|code|number|date|type|category|address|email|phone|note|comment|tag|label|level)\b/i
  if (UPDATE_RE.test(name) || EXISTING_RE.test(name)) {
    // Confirm: if both Update keyword AND a Create keyword appear (e.g. "Create and Update"),
    // still treat as Update — update intent takes precedence.
    return 'update'
  }

  // ── Priority 2: DELETE ──
  if (/\b(delete|remove|archive|deactivate|trash|destroy)\b/i.test(name)) return 'delete'

  // ── Priority 3: VIEW ──
  if (/\b(view|open|display|read|preview|check\s+details?|see\s+details?|details\s+of|show)\b/i.test(name)) return 'view'

  // ── Priority 4: CONVERT ──
  if (/\b(convert|transform|turn\s+into|move\s+to)\b/i.test(name)) return 'convert'

  // ── Priority 5: SEARCH ──
  if (/\b(search|filter|find|look\s*up|lookup|browse|query|list\s*view)\b/i.test(name)) return 'search'

  // ── Priority 6: CREATE ──
  if (
    /\b(create|creation|add|new|register|registration|signup|sign-up|generation|generate|creating|registering|generating)\b/i.test(name) ||
    /\bnew\s+(record|entity|entry|item)\b/i.test(name)
  ) return 'create'

  return 'unknown'
}

// ── LLM ───────────────────────────────────────────────────────────────────────

function buildLlm() {
  const provider = (process.env.LLM_PROVIDER ?? '').toLowerCase()
  const useAnthropic = provider === 'anthropic' ||
    (provider !== 'openai' && !process.env.OPENAI_API_KEY)
  if (!useAnthropic && process.env.OPENAI_API_KEY) {
    return new ChatOpenAI({
      apiKey:      process.env.OPENAI_API_KEY,
      model:       process.env.STEP_GEN_MODEL ?? 'gpt-4o',
      temperature: 0.1,
      maxTokens:   4096,
    })
  }
  return new ChatAnthropic({
    apiKey:      process.env.ANTHROPIC_API_KEY,
    model:       process.env.CLAUDE_MODEL ?? (process.env.LLM_MODEL ?? 'claude-sonnet-4-5'),
    temperature: 0.1,
    maxTokens:   4096,
  })
}

// ── System prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Test Step Generator Agent for AutoTestAI.
Your job: generate EXECUTABLE Playwright test steps grounded in real metadata.

╔══════════════════════════════════════════════════════════════════════╗
║  🚨 STEP 0 — DETECT OPERATION TYPE FROM TEST NAME (MANDATORY FIRST)  ║
╠══════════════════════════════════════════════════════════════════════╣
║  Read the test name BEFORE writing any step. Identify the type:      ║
║                                                                      ║
║  "Update", "Edit", "Modify", "Change"  → UPDATE flow                 ║
║  "Create", "New", "Add"                → CREATE flow                 ║
║  "Delete", "Remove", "Archive"         → DELETE flow                 ║
║  "View", "Open", "Display", "Preview"  → VIEW flow                   ║
║  "Search", "Filter", "Find", "Browse"  → SEARCH flow                 ║
║  "Convert", "Transform"                → CONVERT flow                ║
║                                                                      ║
║  🔴 CROSS-CONTAMINATION IS ABSOLUTELY FORBIDDEN:                      ║
║  ❌ UPDATE test → NAVIGATE /new, /create, /add       ALWAYS WRONG    ║
║  ❌ UPDATE test → CLICK "+ New <Entity>"              ALWAYS WRONG    ║
║  ❌ UPDATE test → CLICK "Create <Entity>"             ALWAYS WRONG    ║
║  ❌ CREATE test → CLICK "Edit" to open a form         ALWAYS WRONG    ║
║                                                                      ║
║  ✅ UPDATE test MUST follow this EXACT sequence:                      ║
║     NAVIGATE list → TYPE search → CLICK record →                     ║
║     CLICK Edit → modify fields → CLICK Save → ASSERT                 ║
║                                                                      ║
║  ✅ CREATE test MUST follow this EXACT sequence:                      ║
║     NAVIGATE list → CLICK "+New" → fill fields →                     ║
║     CLICK Create/Save → ASSERT detail page                           ║
║                                                                      ║
║  If the test name says "Update SKU weight and dimensions":           ║
║    → This is an UPDATE test. Do NOT navigate to /sku/new.            ║
║    → Navigate to the SKU LIST page, search for an existing SKU,      ║
║      click it, click Edit, update the Weight and Dimensions fields,   ║
║      click Save, and assert the update succeeded.                     ║
╚══════════════════════════════════════════════════════════════════════╝

MANDATORY PRE-FLIGHT (complete BEFORE writing any step):
  A. Identify PRIMARY ENTITY from the test case name.
  B. Find the EXACT page URL from the URL MAP — never invent.
  C. List ALL required fields from the FIELD MANIFEST. Count = COUNT_REQUIRED.
  D. Find the EXACT button name from the "ALL PAGE BUTTONS" or "PRIMARY ACTION BUTTON" list.
     ▶ Example: if the page shows ⚡ PRIMARY ACTION BUTTON: "+New Order" — use EXACTLY "+New Order".
     ▶ NEVER substitute "Save", "Submit", "OK" or any generic name — these are WRONG.
     ▶ Copy the button name CHARACTER-FOR-CHARACTER including symbols (+ signs, dots, brackets, etc).
     ▶ ⚠️  ENTITY SCOPE: If the test is for entity "X", do NOT use buttons for other entities.
          - ❌ WRONG: CLICK "+ New Y" in a test for "X" — Y ≠ X
          - ❌ WRONG: CLICK "Create Z" in a test for "X" — Z ≠ X
          - ✅ CORRECT: Use the button that matches the entity being tested
          - Navigation sidebars often show buttons for ALL entities — IGNORE buttons for other entities.
     ▶ 🔴 CRITICAL OPPORTUNITY EXAMPLE (applies universally to ALL entities):
          Opportunity form has NO "Save" button. The REAL button is "Create Opportunity".
          ❌ WRONG: CLICK "Save"         → This button does NOT exist on the Opportunity form.
          ✅ CORRECT: CLICK "Create Opportunity" → This is the EXACT button name on the form.
          Lesson: EVERY entity has its own specific button name — ALWAYS use the name from
          "PRIMARY ACTION BUTTON" or "ALL PAGE BUTTONS" in the FIELD MANIFEST below.
  E. Self-check: will my steps cover COUNT_REQUIRED fields? If not, add them.
  F. Audit ALL required LOOKUP fields — every ★ lookup field in the manifest MUST have a LOOKUP step:
     ▶ Scan the 🔥 REQUIRED section: count every field with type (lookup).
     ▶ For EACH required lookup field, generate a LOOKUP step with a real value from REAL LOOKUP DATA.
     ▶ If REAL LOOKUP DATA is missing, use the sampleValue from the manifest or a plausible entity name.
     ▶ NEVER skip a required lookup field — missing it causes the form to reject on submission.
     ▶ 🔴 OPPORTUNITY EXAMPLE: "Account Name" (lookup, required) MUST have: 
          { "action": "LOOKUP", "target": "Account Name", "value": "<existing account name>", "locator_type": "label" }
          The Opportunity form WILL NOT save without this field.

╔══════════════════════════════════════════════════════════════════╗
║  🔴 REQUIRED LOOKUP FIELDS — NEVER SKIP                          ║
╠══════════════════════════════════════════════════════════════════╣
║  If the FIELD MANIFEST shows any field with:                     ║
║    ★ "FieldName" (lookup) — REQUIRED                            ║
║  You MUST generate: { "action": "LOOKUP", "target": "FieldName", ║
║    "value": "<real existing record name>", "locator_type": "label" }  ║
║                                                                  ║
║  Common required lookup fields by entity:                        ║
║  • Opportunity → "Account Name" (lookup) — MANDATORY            ║
║  • Contact     → "Account Name" (lookup) — if listed required   ║
║  • Quote       → "Opportunity" (lookup)  — MANDATORY            ║
║  • Order       → "Account" (lookup)      — MANDATORY            ║
║  • Invoice     → "Contact" (lookup)      — MANDATORY            ║
║                                                                  ║
║  ❌ SKIP = Test will FAIL at runtime with a validation error     ║
║  ✅ INCLUDE = Form submits successfully                          ║
╚══════════════════════════════════════════════════════════════════╝

🔴 CREATE OPERATION RULE (applies when test name contains "Create", "New", or "Add"):
  - You MUST generate steps that FILL IN the entity's form fields (TYPE, SELECT, LOOKUP, CHECKBOX).
  - Minimum 2 field-filling steps — never just NAVIGATE + CLICK + ASSERT.
  - MANDATORY SEQUENCE for Create operations:
      1. NAVIGATE to the LIST page (e.g., /accounts, /products)
      2. CLICK the "open form" button (e.g., "+New Account", "+New Product") — this opens the CREATE FORM
         ▶ Check the "ALL PAGE BUTTONS" or "PRIMARY ACTION BUTTON" to find the correct button name.
         ▶ This step MUST come BEFORE any TYPE/SELECT/LOOKUP steps.
      3. TYPE into required text fields (e.g., account name, description)
      4. SELECT required dropdown fields (e.g., type, industry, status)
      5. LOOKUP required reference fields (e.g., parent account)
      6. CLICK the final save/create button (e.g., "Create Account", "Save")
      7. ✅ ASSERT that the record was SUCCESSFULLY CREATED by checking the DETAIL PAGE:
         ▶ PRIMARY:  ASSERT_URL with a partial match for the entity detail URL pattern
                     e.g., value: "/leads/" or "/lead/" or "/contacts/" (the page URL will contain
                     an entity-path segment followed by a record ID after save)
                     Example: { "action": "ASSERT_URL", "value": "/leads/" }
         ▶ BACKUP:   ASSERT_TEXT for a key element visible ONLY on the detail page
                     e.g., the record title (name typed in step 3), a "Lead Details" heading,
                     or any unique field label that only appears on the record detail view.
                     Example: { "action": "ASSERT_TEXT", "target": "John Smith", "locator_type": "text" }
         ▶ You SHOULD include BOTH assertions for maximum coverage.
         ▶ ⚠️ FORBIDDEN: ASSERT_URL with only the LIST page path (e.g. value: "/leads" without an
                     ID segment) — the app DOES NOT redirect to the list page after creation;
                     it redirects to the DETAIL PAGE of the newly created record.
  - ⚠️ CRITICAL ORDERING: Step 2 ("open form" click) MUST come BEFORE steps 3-5 (field filling).
     WRONG ORDER: NAVIGATE → TYPE → SELECT → CLICK "+New Account" ← WRONG
     RIGHT ORDER: NAVIGATE → CLICK "+New Account" → TYPE → SELECT → CLICK "Create Account"
  - If no FIELD MANIFEST is available, use the BRD/SPECIFICATION and PROJECT METADATA sections
    to discover which fields exist on the form, then generate TYPE/SELECT steps for them.
  - A test case that only navigates and clicks WITHOUT filling fields WILL BE REJECTED.

🔴 MODAL FORM RULE (applies when the create form opens as an overlay/dialog on the list page):
   - After CLICK the trigger button (e.g., "+ Add Account"), the modal overlays the SAME page.
   - Do NOT add a NAVIGATE step AFTER clicking the trigger button — the URL does NOT change.
   - Fill fields while the modal is open, then CLICK the submit button (e.g., "Save Account").
   - After submission, the app redirects to the DETAIL PAGE (e.g., /accounts/636a2bf5-...)
   - The CONFIRMED BUTTON NAMES section will tell you EXACTLY which button opens the modal.
   - Final ASSERT_URL must match the entity detail path (e.g., "/accounts/") NOT the modal URL.
   - ✅ CORRECT: ASSERT_URL value "/accounts/" — matches "/accounts/636a2bf5-9051-403b..."
   - ❌ FORBIDDEN: ASSERT_URL value "/accounts" (bare list)
   - ❌ FORBIDDEN: ASSERT_URL value containing "__modal__"

  - ⚠️ PRODUCT FORM EXAMPLE — if the test is for a Product entity and no manifest is present:
      TYPE "Name" / TYPE "Product Name"
      SELECT "Currency" (or TYPE if free-text)
      TYPE "Description"
      TYPE "SKU" or TYPE "Code"
      CLICK save/create button
      ASSERT_URL value: "/products/"  ← detail page URL pattern
      ASSERT_TEXT target: "<product name typed above>"  ← record title on detail page

╔══════════════════════════════════════════════════════════════════╗
║  🆕 UNIQUE TEST DATA RULE — CREATE OPERATIONS (HARD RULE)        ║
╠══════════════════════════════════════════════════════════════════╣
║  Every CREATE test MUST use UNIQUE, NON-DUPLICATE data values    ║
║  for primary name/title/identifier fields to prevent the         ║
║  "duplicate record" error that causes test failures.             ║
║                                                                  ║
║  ✅ REQUIRED for name / title / identifier fields:               ║
║  - Append a short numeric suffix derived from the current time   ║
║    to make the value unique on every run.                        ║
║  - A UNIQUE NAME HINT will be provided in the === TEST CASE ===  ║
║    section below — USE IT EXACTLY for the primary name field.    ║
║                                                                  ║
║  EXAMPLES of unique values (entity-appropriate):                 ║
║  - Lead:        "Test Lead 4821"  (not "John Smith" — too common)║
║  - Account:     "Acme Corp 4821"                                 ║
║  - Contact:     "Jane Test 4821"                                 ║
║  - Product:     "Test Product 4821"                              ║
║  - Campaign:    "Auto Campaign 4821"                             ║
║  - Invoice:     "INV-TEST-4821"                                  ║
║  - Order:       "ORD-TEST-4821"                                  ║
║  - Opportunity: "Q4 Deal 4821"                                   ║
║                                                                  ║
║  ⚠️  The SAMPLE TEST DATA section may show EXISTING records.    ║
║     NEVER reuse a name from SAMPLE TEST DATA for a Create test   ║
║     — it will cause a duplicate-record error at runtime.         ║
║                                                                  ║
║  ❌ FORBIDDEN for name/title fields in Create tests:             ║
║  - Reusing any value from SAMPLE TEST DATA (those already exist) ║
║  - Generic placeholders: "Test", "Sample", "Foo", "Bar"          ║
║  - Status/stage words: "Active", "Prospect", "Open"              ║
║  - Names without a unique suffix that could clash with existing  ║
║    records in the application                                    ║
╚══════════════════════════════════════════════════════════════════╝

╔══════════════════════════════════════════════════════════════════╗
║  🔴 CREATE SUCCESS VALIDATION — HARD RULE (NEVER VIOLATE)        ║
╠══════════════════════════════════════════════════════════════════╣
║  After a Create form is submitted, the app REDIRECTS to the      ║
║  DETAIL PAGE of the newly created record — NOT to the list page. ║
║  There is NO success toast. Do NOT assert a toast or list URL.   ║
║                                                                  ║
║  ✅ REQUIRED: Verify success by ONE or BOTH of these steps:      ║
║  1. ASSERT_URL — partial match for the entity detail URL:        ║
║       { "action": "ASSERT_URL", "value": "/leads/" }            ║
║       { "action": "ASSERT_URL", "value": "/contacts/" }         ║
║       { "action": "ASSERT_URL", "value": "/accounts/" }         ║
║       (The actual URL will be /leads/123, /contacts/456, etc.)   ║
║  2. ASSERT_TEXT — unique detail-page element:                    ║
║       { "action": "ASSERT_TEXT",                                 ║
║         "target": "<record name typed during creation>",         ║
║         "locator_type": "text" }                                  ║
║     OR assert a heading like "Lead Details", "Account Details"   ║
║                                                                  ║
║  ❌ FORBIDDEN final assertions for Create operations:            ║
║  - ASSERT_URL with the EXACT list page path (e.g. "/leads")      ║
║    because after creation the page IS NOT on the list — it is    ║
║    on the detail page (e.g. "/leads/42").                        ║
║  - ASSERT_TOAST — no toast is shown on success.                  ║
║  - No assertion at all — NEVER end without verifying success.    ║
╚══════════════════════════════════════════════════════════════════╝

🔴 UPDATE / EDIT OPERATION RULE (applies when test name contains "Update", "Edit", "Modify", OR "existing"):
  - Works for ANY entity: Account, Lead, Contact, Opportunity, Product, Invoice, Order, etc.
  - MANDATORY SEQUENCE — follow these 7 steps for every Update/Edit test:
      1. NAVIGATE to the entity LIST page
         ▶ Use the LIST page URL (e.g., /accounts, /leads, /contacts) from the URL MAP
         ▶ NEVER use the create/new URL (e.g., /accounts/new is FORBIDDEN for Update)
      2. TYPE the record name into the search/filter field to locate the record
         ▶ action: TYPE, locator_type: "placeholder" or "label"
         ▶ Use the REAL RECORD NAME from REAL LOOKUP DATA or SAMPLE TEST DATA
         ▶ If both are empty, use an entity-appropriate fallback (Account → "Acme Corp", Lead → "John Smith")
         ▶ ⚠️ NEVER use status/stage words ("Prospect", "Active", "Closed") as a record name
      3. CLICK on the record name to open the record's detail page
         ▶ action: CLICK, target: "<record name>", locator_type: "text"
         ▶ ⛔ nav sidebar CLICK (role=link, name=...) does NOT count as a record selection
         ▶ ⛔ "Create <Entity>" / "+ New <Entity>" are CREATE buttons — FORBIDDEN here
      4. CLICK the Edit button to enter edit mode
         ▶ action: CLICK, locator_type: "role"
         ▶ ⛔ NEVER click "Create <Entity>" here — that opens a create form, not an edit form
      5. TYPE/SELECT at least 1 field with REALISTIC, VALID data
         ▶ Use only fields from ALLOWED FIELDS in the manifest
      6. CLICK the save/update button from the manifest button list
      7. ASSERT_URL that the URL confirms the save was successful (redirected back to list page)
  - ⛔ ABSOLUTELY FORBIDDEN in Update tests:
      - CLICK "Create <Entity>" / "+ New <Entity>" (opens a create form — completely wrong)
      - Navigating to a /new or /create URL
      - Skipping step 2 (search) or step 4 (Edit click)
      - Using placeholder/dummy values: "-", "N/A", "123", "test", "x"

🔴 DELETE OPERATION RULE (applies when test name contains "Delete", "Remove", "Archive", "Deactivate"):
  - MANDATORY SEQUENCE for Delete operations:
      1. NAVIGATE to the entity LIST page
      2. TYPE the record name in the search box
      3. CLICK on the record name to open the detail page
      4. CLICK the Delete/Remove/Archive button
      5. CLICK the confirmation button ("Confirm", "Yes", "OK") if a confirmation dialog appears
      6. ASSERT_URL or ASSERT_TEXT that the record was deleted

🔴 VIEW / OPEN OPERATION RULE (applies when test name contains "View", "Open", "Display", "Check Details"):
  - MANDATORY SEQUENCE for View operations:
      1. NAVIGATE to the entity LIST page
      2. TYPE the record name in the search box
      3. CLICK on the record name to open the detail page
      4. ASSERT_TEXT or ASSERT_URL confirming the detail page is displayed
  - Do NOT click Edit or Delete in a View-only test

🔴 CONVERT OPERATION RULE (applies when test name contains "Convert", "Transform", "Move to", or "Turn into"):
  - This is a MULTI-STEP WORKFLOW that converts a SOURCE record (e.g. Quotation) into a TARGET entity (e.g. Booking).
  - The flow has TWO PHASES:
      PHASE 1 — Locate and trigger conversion:
        1. NAVIGATE to the SOURCE entity list page (e.g., /quotations)
        2. TYPE the source record identifier (e.g., "Q-2024-001") in the Search field
        3. CLICK on the matching source record row (e.g., CLICK "Q-2024-001", locator_type: "text")
        4. CLICK the conversion action button on the source record's detail page
           ▶ Use the EXACT button name from "ALL PAGE BUTTONS" or "PRIMARY ACTION BUTTON".
           ▶ NEVER substitute "Save", "Submit", "Convert", or a generic name.
           ▶ Example: the EXACT button may be "Create Booking", "Convert to Booking", "+ Create Booking"
      PHASE 2 — Fill the TARGET entity form (all required fields — DO NOT SKIP ANY):
        5. TYPE/SELECT/LOOKUP ALL required fields of the TARGET entity form
           ▶ The FIELD MANIFEST lists ALL required fields — EVERY ★ field MUST have a step.
           ▶ This is the most commonly missed section — DO NOT generate fewer than COUNT_REQUIRED steps.
        6. CLICK the FINAL submit button to save the new TARGET record
           ▶ Use the EXACT final submit button name from the manifest or button list.
        7. ASSERT_URL — the URL should contain the TARGET entity path (e.g., /bookings/)
        8. ASSERT_TEXT — the TARGET record identifier (e.g., the booking reference) is visible on the page
  - ⚠️ CRITICAL RULES:
      - NEVER skip fields: ALL required form fields MUST have a step. The app will reject the form otherwise.
      - NEVER omit the final CLICK submit button step — the form must be submitted.
      - NEVER omit the final ASSERT steps — they verify the booking was actually created.
      - The search/filter step (step 2) MUST use the source record ID (e.g., quotation number), NOT a status word.
      - If no FIELD MANIFEST is provided, use BRD/SPECIFICATION context to infer the target entity's required fields.

🔴 SEARCH / FILTER OPERATION RULE (applies when test name contains "Search", "Filter", "Find", "Look up", "Browse", or "List View"):
  - This operation searches for a record via the list-page search input and selects it.
  - HOW SEARCH/FILTER WORKS IN THIS APP:
      • Typing in the search field LIVE-FILTERS the list — no separate search button needed.
      • The list view may have TAB-STYLE view filters (e.g., "All Leads", "Recently Viewed",
        "Today's Leads"). Clicking a tab is a CLICK step with locator_type "role" or "text".
      • There is NO standalone "Filter" button that opens a filter panel.
      • There is NO "Create Filter" button, NO "Apply Filter" button, NO status-dropdown filter.
  - MANDATORY SEQUENCE:
      1. NAVIGATE to the entity LIST page (from URL MAP)
      2. [OPTIONAL] CLICK a tab-style view filter if the test explicitly names one
         ▶ e.g., CLICK "All Leads", CLICK "Today's Leads" — locator_type: "text" or "role"
         ▶ Only include this step if the test name specifically mentions a view filter name
      3. TYPE the search term into the search field
         ▶ action: TYPE, locator_type: "placeholder" or "label"
         ▶ value: use the REAL RECORD NAME from EXISTING RECORD / SAMPLE TEST DATA
      4. CLICK on the matching record name from the filtered list to open its detail page
         ▶ action: CLICK, target: "<search term>", locator_type: "text"
         ▶ ⚠️ This is a RECORD CLICK — clicks the ROW/LINK for the matching record
         ▶ ⛔ NOT a "Filter button" click — do NOT use "Filter" as the click target
      5. ASSERT_TEXT or ASSERT_URL confirming the record detail page is loaded
  - ⛔ ABSOLUTELY FORBIDDEN in Search/Filter tests:
      - CLICK any button whose name is only "Filter" (no such standalone button exists)
      - SELECT from a "Status" dropdown as part of a "filter panel" (does not exist)
      - CLICK "Create Filter", "Apply Filter", "Save Filter" — these do NOT exist
      - TYPE or SELECT inside any hallucinated "filter panel" form
      - WAIT steps (search is live-filtered — no wait needed after typing)

╔══════════════════════════════════════════════════════════════╗
║  VALID ACTIONS — USE ONLY THESE EXACT STRINGS                ║
║  NAVIGATE · CLICK · TYPE · SELECT · LOOKUP · CHECKBOX        ║
║  ASSERT_TEXT · ASSERT_URL · ASSERT_TOAST · WAIT              ║
║  MULTI_SELECT · UPLOAD                                       ║
╠══════════════════════════════════════════════════════════════╣
║  ⛔ FORBIDDEN actions (will fail validation):                 ║
║     FILL_FORM  FILL  ENTER  SET  SET_TEXT  INPUT_TEXT        ║
║     WRITE  TYPE_TEXT  PRESS  TAP  SUBMIT  BUTTON_CLICK       ║
║  To fill a text input → use TYPE                            ║
║  To click a button → use CLICK                              ║
╚══════════════════════════════════════════════════════════════╝

Anti-hallucination rules (ABSOLUTE):
- NEVER use a URL not in the URL MAP
- NEVER use a field label not in the ALLOWED FIELDS list in the FIELD MANIFEST
  ▶ The ALLOWED FIELDS list is the COMPLETE list of fields on this form — no more, no less.
  ▶ If a field is not in ALLOWED FIELDS, do NOT generate a TYPE/SELECT/LOOKUP step for it.
  ▶ Do NOT use your general knowledge of industry-specific forms — use ONLY the FIELD MANIFEST.
  ▶ Every TYPE/SELECT/LOOKUP target MUST exactly match a label from ALLOWED FIELDS.
  ▶ Example: if ALLOWED FIELDS lists ["Name", "Category", "Website"] and you want to add
    a "Phone" step — check first: is "Phone" in ALLOWED FIELDS? If not, skip it entirely.
  ▶ EXCEPTION: if NO FIELD MANIFEST is provided, use fields from BRD/RAG context.
- NEVER invent a button name — use ONLY names from the "ALL PAGE BUTTONS" or "PRIMARY ACTION BUTTON" list
- NEVER use "Save" or "Submit" as a button target unless that EXACT name appears in the button list
- Lookup fields → action: LOOKUP (never TYPE)
- Select fields → action: SELECT with a value from [VALID OPTIONS] — NEVER use "-" or placeholder text
- Phone fields → phone format only (e.g. "+1 555-123-4567") — NEVER use bare numbers like "823462434234"
- Email fields → email format only (e.g. "user@example.com")
- Date fields  → MM/DD/YYYY format only
- Amount/currency fields → numeric with decimals (e.g. "25000.00")
- URL/website fields → MUST start with https:// (e.g. "https://www.example.com") — NEVER use bare numbers
- Industry/sector fields → MUST be a real industry category from VALID OPTIONS; NEVER use names like "Tara"
- ⛔ CRITICAL: "-" is NEVER valid as any field value — it is a placeholder and will always FAIL at runtime
- ⛔ CRITICAL: A bare number (e.g. "823462434234") is NEVER a valid URL or phone — use proper format

╔══════════════════════════════════════════════════════════════╗
║  🔴 REAL DATA ENFORCEMENT — UNIVERSAL HARD RULE              ║
╠══════════════════════════════════════════════════════════════╣
║  The test data sections below contain REAL RECORDS from the  ║
║  live application. You MUST use those exact values.          ║
║                                                              ║
║  🔴 ABSOLUTE RULE: You MUST use one of the REAL EXISTING     ║
║  RECORDS provided in the TEST DATA section. NEVER use        ║
║  placeholder values like:                                    ║
║    ❌ "Test Record"         ❌ "Test Account"               ║
║    ❌ "Sample Account"      ❌ "John Doe"                   ║
║    ❌ "Jane Smith"          ❌ "Test User"                  ║
║    ❌ "Sample Product"      ❌ "Acme Corporation" (generic)  ║
║    ❌ "Test Lead 4821"      ❌ any invented name             ║
║                                                              ║
║  ✅ For UPDATE / SEARCH / VIEW / DELETE operations:          ║
║     The "=== REAL EXISTING RECORDS ==" section below        ║
║     lists actual record names from the app. Use EXACTLY      ║
║     one of those names for both the TYPE search step and     ║
║     the CLICK record step.                                   ║
║                                                              ║
║  ✅ For LOOKUP fields (any operation type):                  ║
║     The "=== REAL LOOKUP DATA ==" section lists valid        ║
║     names for each lookup field. Pick ONE and use it         ║
║     character-for-character.                                 ║
║                                                              ║
║  ✅ If no real data section is provided: use the             ║
║     sampleValue shown in the FIELD MANIFEST (★ fields).     ║
║     Do NOT fall back to generic placeholder names.           ║
║                                                              ║
║  WHY: Placeholder values do not exist in the application.   ║
║  Using them causes the search/lookup to return zero results  ║
║  and the test fails immediately at runtime.                  ║
╚══════════════════════════════════════════════════════════════╝

╔══════════════════════════════════════════════════════════════╗
║  🔍 LOOKUP VALUE RULES — CRITICAL                            ║
╠══════════════════════════════════════════════════════════════╣
║  When generating a LOOKUP step value, you MUST:             ║
║  ✅ Use a value from the REAL LOOKUP DATA section below     ║
║  ✅ The value must be the EXACT name of an existing record  ║
║                                                              ║
║  ❌ NEVER invent names like "John Doe", "Jane Smith",       ║
║     "Test User", "Sample Account" or any made-up record     ║
║  ❌ If no REAL LOOKUP DATA is provided for a field,         ║
║     use the first value listed in the manifest sampleValue  ║
║     or omit the LOOKUP step entirely                        ║
║                                                              ║
║  WHY: Invented lookup values will always fail at runtime    ║
║  because the record does not exist in the application.      ║
╚══════════════════════════════════════════════════════════════╝

╔══════════════════════════════════════════════════════════════╗
║  COMMON MISTAKES — NEVER DO THESE                            ║
╠══════════════════════════════════════════════════════════════╣
║ ❌ CLICK "Save" for Create ops   → ✅ Use the EXACT button  ║
║    e.g. "Create Opportunity"     from the button list       ║
║ ❌ CLICK "Create X" in Update    → ✅ CLICK "Edit" instead  ║
║    test for entity X             (Edit enters edit mode)   ║
║ ❌ Skip Search step in Update    → ✅ TYPE in search box    ║
║    (go straight to click record)    BEFORE clicking record  ║
║ ❌ Skip Edit click in Update     → ✅ CLICK "Edit" AFTER    ║
║    (fill fields without Edit)       opening the record      ║
║ ❌ TYPE on a lookup field        → ✅ Use LOOKUP action     ║
║ ❌ TYPE non-existent fields      → ✅ Only ALLOWED FIELDS   ║
║ ❌ Field steps BEFORE "open      → ✅ NAVIGATE → CLICK open ║
║    form" CLICK in Create test       form btn → TYPE/SELECT  ║
║ ❌ SELECT value not in options   → ✅ Use VALID OPTIONS     ║
║ ❌ Use generic "12345" for phone → ✅ "+1 555-123-4567"     ║
║ ❌ Use number for URL field      → ✅ "https://example.com" ║
║ ❌ Use "-" as any field value   → ✅ Use REALISTIC data     ║
║ ❌ SELECT "Tara" for Industry   → ✅ Pick from VALID        ║
║    (not a valid industry name)     OPTIONS in manifest     ║
╚══════════════════════════════════════════════════════════════╝

🔄 FIELD TYPE → ACTION MAPPING (STRICT):
  • Text input field       → action: TYPE
  • Dropdown / picklist    → action: SELECT (value from VALID OPTIONS only)
  • Lookup / reference     → action: LOOKUP
  • Checkbox / toggle      → action: CHECKBOX
  • Multi-select picklist  → action: MULTI_SELECT
  • Date field             → action: TYPE (value: MM/DD/YYYY)
  • If FIELD MANIFEST shows type="select" → use SELECT, NEVER TYPE
  • If FIELD MANIFEST shows type="lookup" → use LOOKUP, NEVER TYPE

╔══════════════════════════════════════════════════════════════╗
║  🧭 NAV-CLICK RULES — NAVIGATION MENU / SIDEBAR ITEMS        ║
╠══════════════════════════════════════════════════════════════╣
║  When the step CLICKS a sidebar/topnav section (e.g., Users, ║
║  Accounts, Dashboard, Settings, Orders, Reports, Products):  ║
║                                                              ║
║  ✅ REQUIRED: locator_type: "role"                           ║
║  ✅ REQUIRED: target: "role=link, name=<SectionName>"        ║
║     OR use the exact locator from NAVIGATION MENU ITEMS list ║
║                                                              ║
║  ❌ FORBIDDEN: locator_type: "text"                          ║
║  ❌ FORBIDDEN: target: "text=Users" or "Users" with text type ║
║  ❌ FORBIDDEN: locator_type: "label" for nav section clicks  ║
║                                                              ║
║  WHY: text= locators match inner <span> elements inside      ║
║  navigation <li>/<a> items and fail because the matched      ║
║  element is not directly clickable (it's display-only text). ║
║                                                              ║
║  EXAMPLE — CORRECT navigation step:                          ║
║  { "action": "CLICK",                                        ║
║    "target": "role=link, name=Users",                        ║
║    "locator_type": "role" }                                  ║
║                                                              ║
║  If the NAVIGATION MENU ITEMS section is present above,      ║
║  copy the locator from that list CHARACTER-FOR-CHARACTER.    ║
╚══════════════════════════════════════════════════════════════╝

Step schema (output a JSON array — no markdown, no fences):
[{
  "id": "1",
  "action": "NAVIGATE|CLICK|TYPE|SELECT|LOOKUP|CHECKBOX|ASSERT_TEXT|ASSERT_URL|ASSERT_TOAST|WAIT",
  "target": "exact locator (omit for NAVIGATE/WAIT/ASSERT_URL)",
  "value": "url | input text | expected text | seconds",
  "locator_type": "label|role|text|placeholder|css"
}]`




// ── Helper: derive a sensible "open form" button hint from a field label ───────
// Used only in validation error messages so the correction instruction is concrete.
// e.g. "Account Name" → "+New Opportunity" (the form-open button, not the lookup target)
function resolveEntityOpenButton(fieldLabel: string): string {
  const lower = fieldLabel.toLowerCase()
  if (lower.includes('account'))    return '+New Opportunity'
  if (lower.includes('contact'))    return '+New Quote'
  if (lower.includes('opportunity')) return '+New Quote'
  return '+New <Entity>'
}

// ── 5-Check Validation Gate ───────────────────────────────────────────────────


export function validateSteps(
  steps:              AgentStep_Playwright[],
  requiredCount:      number,
  verifiedPaths:      string[],
  submitButton?:      string,
  allButtons?:        string[],
  manifestFields?:    import('./agent.types.js').FieldEntry[],
  testEntityHint?:    string,
  minimumFieldSteps?: number,   // override for Create/Add operations when requiredCount=0
): StepValidationResult {
  const issues: string[] = []

  // Check 1: Required field coverage
  // For Create operations with no manifest, enforce a minimum of at least 2 field steps
  // so the LLM cannot pass validation with only NAVIGATE+CLICK+ASSERT.
  let check1 = true
  const isCreateOrUpdateOrConvert = /\b(create|add|new|update|edit|modify|change|convert|transform|turn\s+into|move\s+to)\b/i.test(testEntityHint ?? '')
  const effectiveRequiredCount = Math.max(requiredCount, minimumFieldSteps ?? 0)

  if (isCreateOrUpdateOrConvert) {
    const fieldSteps = steps.filter(s =>
      ['TYPE', 'SELECT', 'LOOKUP', 'CHECKBOX'].includes(s.action.toUpperCase())
    )
    const existingFieldTargetsCheck1 = new Set(fieldSteps.map(s => (s.target ?? '').toLowerCase().trim()))

    // Identify which specific required fields are missing
    const missingRequired = manifestFields
      ? manifestFields
          .filter(f => f.required)
          .filter(f => !existingFieldTargetsCheck1.has(f.label.toLowerCase().trim()))
          .map(f => `"${f.label}" (${f.type})`)
      : []

    check1 = fieldSteps.length >= effectiveRequiredCount && missingRequired.length === 0
    if (!check1) {
      const missingMsg = missingRequired.length > 0
        ? `Missing required fields: [${missingRequired.join(', ')}]. You MUST add steps for EACH of these. `
        : `Found ${fieldSteps.length} field step(s) but need ${effectiveRequiredCount}. `
      issues.push(
        missingMsg +
        `MANDATORY: generate TYPE/SELECT/LOOKUP/CHECKBOX steps for ALL required fields from the FIELD MANIFEST. ` +
        `Example for Product: TYPE "PRODUCT NAME", SELECT "Currency", TYPE "SKU". ` +
        `Check the 🔥 REQUIRED section in the FIELD MANIFEST — every ★ field MUST have a step. ` +
        `The sequence MUST be: NAVIGATE → fill ★ required fields → CLICK submit → ASSERT_URL.`
      )
    }

    // ── Check 1b: Required LOOKUP field audit ─────────────────────────────────
    // This specifically targets the "Account Name" missed for Opportunity pattern.
    // A required field with type=lookup MUST have a LOOKUP step — not a TYPE step.
    // The LLM commonly skips lookup fields when REAL LOOKUP DATA is absent, causing
    // a runtime validation error ("Account is required") even when all text fields are filled.
    const requiredLookupFields = manifestFields
      ? manifestFields.filter(f => f.required && f.type === 'lookup')
      : []
    const lookupSteps   = steps.filter(s => s.action.toUpperCase() === 'LOOKUP')
    const lookupTargets = new Set(lookupSteps.map(s => (s.target ?? '').toLowerCase().trim()))
    const typeTargets1b = new Set(
      steps.filter(s => s.action.toUpperCase() === 'TYPE').map(s => (s.target ?? '').toLowerCase().trim())
    )

    for (const lf of requiredLookupFields) {
      const lfLower = lf.label.toLowerCase().trim()
      const hasLookupStep = lookupTargets.has(lfLower)
      const hasTypeStep   = typeTargets1b.has(lfLower)

      if (!hasLookupStep && !hasTypeStep) {
        // Missing entirely — exact bug: Account Name skipped for Opportunity
        issues.push(
          `Missing required LOOKUP field "${lf.label}": this is a REQUIRED lookup field and MUST have a LOOKUP step. ` +
          `The form WILL NOT submit without it (server-side validation will reject). ` +
          `Add: { "action": "LOOKUP", "target": "${lf.label}", "value": "<real record name>", "locator_type": "label" }. ` +
          `If REAL LOOKUP DATA is not shown, use a plausible name (e.g., "Acme Corp" for Account, "John Smith" for Contact). ` +
          `Place this step AFTER the form is opened (after the CLICK "${resolveEntityOpenButton(lf.label)}" step) and BEFORE the submit button click.`
        )
        check1 = false
      } else if (hasTypeStep && !hasLookupStep) {
        // Wrong action type used: TYPE instead of LOOKUP
        issues.push(
          `Wrong action for required lookup field "${lf.label}": a TYPE step was generated but this is a LOOKUP (reference) field. ` +
          `Replace the TYPE step with: { "action": "LOOKUP", "target": "${lf.label}", "value": "<record name>", "locator_type": "label" }. ` +
          `Lookup fields open a search/autocomplete dialog — they CANNOT be filled with the TYPE action.`
        )
        check1 = false
      }
    }
  }

  // Check 2: URL verification
  // Strip the base domain from absolute URLs (e.g. "https://app.example.com/quotations" → "/quotations")
  // so they compare correctly against verifiedPaths which stores relative paths.
  const navSteps = steps.filter(s => s.action.toUpperCase() === 'NAVIGATE')
  let check2 = true
  if (verifiedPaths.length > 0) {
    for (const nav of navSteps) {
      const rawVal = nav.value ?? ''
      // Normalize: if full URL, extract the path portion
      let val = rawVal
      try {
        if (rawVal.startsWith('http://') || rawVal.startsWith('https://')) {
          val = new URL(rawVal).pathname
        }
      } catch { /* keep rawVal */ }
      const ok = verifiedPaths.some(p => p === val || p === rawVal || val.startsWith(p) || rawVal.startsWith(p))
      if (!ok) {
        issues.push(`URL not in verified map: "${rawVal}"`)
        check2 = false
      }
    }
  }

  // Check 3: Button name exactness — ensure CLICK targets exist in the known button set
  let check3 = true
  const isConvertOrSearchForCheck3 = /\b(convert|transform|turn\s+into|move\s+to|search|filter|find|look\s+up)\b/i.test(testEntityHint ?? '')
  const allKnownButtons = [
    ...(submitButton ? [submitButton] : []),
    ...(allButtons ?? []),
  ]
  // Normalize a button name for fuzzy matching: lowercase, collapse whitespace,
  // strip leading non-alphanumeric characters (e.g. "+New" === "+ New").
  const normBtn = (s: string) => s.toLowerCase().replace(/^[^a-z0-9]+/, '').replace(/\s+/g, ' ').trim()
  if (allKnownButtons.length > 0) {
    const clickSteps = steps.filter(s => s.action.toUpperCase() === 'CLICK')
    for (const cs of clickSteps) {
      const target = (cs.target ?? '').trim()
      if (!target) continue
      // Allow if it matches any known button (case-insensitive) OR a CSS selector / role locator
      const isCssOrRole = target.startsWith('.') || target.startsWith('#') || target.startsWith('[') || target.startsWith('role=')
      if (!isCssOrRole) {
        // Skip record-navigation clicks (e.g., clicking a row by date/ID/reference in list view)
        // These are valid in convert/search/view operations where the user clicks on a record to open it.
        // Indicators: locator_type is 'text', or the target looks like a data value (date, ENQ-XXXX, etc.)
        const isTextLocator = (cs as any).locator_type === 'text'
        const looksLikeDataValue = /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(target)  // date like 5/24/2026
          || /^[A-Z]{2,5}-\d{3,6}$/.test(target)   // reference like ENQ-0017, QUO-0007, BKG-0003
          || /^\d+$/.test(target)                    // pure numeric ID
        if ((isConvertOrSearchForCheck3 || isTextLocator) && looksLikeDataValue) continue
        const normTarget = normBtn(target)
        const matchesKnown = allKnownButtons.some(btn => {
          const normB = normBtn(btn)
          return normB === normTarget || normTarget.includes(normB) || normB.includes(normTarget)
        })
        if (!matchesKnown) {
          issues.push(`Button "${target}" is not in the known button list. Use one of: ${allKnownButtons.slice(0, 5).map(b => `"${b}"`).join(', ')}`)
          check3 = false
        }
      }
    }
  } else if (submitButton) {
    // Legacy: if no allButtons but submitButton is known, just check for it
    const clickSteps = steps.filter(s => s.action.toUpperCase() === 'CLICK')
    const hasCorrectBtn = clickSteps.some(s =>
      (s.target ?? '').toLowerCase() === submitButton.toLowerCase()
    )
    if (clickSteps.length > 0 && !hasCorrectBtn) {
      issues.push(`Submit button mismatch. Expected: "${submitButton}"`)
      check3 = false
    }
  }

  // Check 3b: Cross-entity button guard
  // Detects CLICK steps that reference a DIFFERENT entity than the test case.
  // e.g., test "Create New Account" should NOT have CLICK "+ New Lead"
  // This catches cases where the LLM picks up navigation sidebar buttons for
  // other entities from the page's button list.
  if (testEntityHint) {
    const entityHintLower = testEntityHint.toLowerCase()
    const clickSteps3b = steps.filter(s => s.action.toUpperCase() === 'CLICK')
    for (const cs of clickSteps3b) {
      const target = (cs.target ?? '').toLowerCase().trim()
      // Look for "new X", "create X", "add X" where X is a different entity word
      const entityWordMatch = target.match(/\b(?:new|create|add)\s+([a-z]+(?:\s+[a-z]+)?)\b/)
      if (!entityWordMatch) continue
      const entityWord = entityWordMatch[1].trim()
      // Skip short words and generic words
      if (entityWord.length < 3 || ['the', 'a', 'an', 'new', 'all'].includes(entityWord)) continue
      // If the entity word doesn't match the test entity → cross-entity contamination
      if (!entityHintLower.includes(entityWord) && !entityWord.includes(entityHintLower)) {
        issues.push(
          `Cross-entity button: "${cs.target}" used in a "${testEntityHint}" test — ` +
          `this button creates a "${entityWord}", not a "${testEntityHint}". ` +
          `Use the "${testEntityHint}" create/save button instead.`
        )
        check3 = false
      }
    }
  }

  // Check 4: Locator type validity
  let check4 = true
  for (const s of steps) {
    const action = s.action.toUpperCase()
    if (action === 'LOOKUP' && s.locator_type !== 'label') {
      issues.push(`LOOKUP step "${s.target}" should use locator_type: "label"`)
      check4 = false
    }
  }

  // Check 5: Data type alignment (expanded to cover Industry, URL, and lookup fields)
  let check5 = true
  const phoneRe    = /^\+?[\d\s\-().]{7,20}$/
  const emailRe    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  const dateRe     = /^\d{2}\/\d{2}\/\d{4}$/
  const urlRe      = /^https?:\/\//i
  const pureNumRe  = /^\d{5,}$/  // 5+ digit bare number (not a valid URL)
  const statusWords = /^(prospect|customer|active|inactive|lead|opportunity|closed|open|pending|new|won|lost|qualified)\s*$/i

  const VALID_INDUSTRIES = new Set([
    'Technology', 'Healthcare', 'Finance', 'Education', 'Retail', 'Manufacturing',
    'Real Estate', 'Transportation', 'Energy', 'Agriculture', 'Media', 'Entertainment',
    'Government', 'Nonprofit', 'Construction', 'Legal', 'Consulting', 'Hospitality',
    'Automotive', 'Aerospace', 'Pharmaceuticals', 'Telecommunications', 'Banking',
    'Insurance', 'Food & Beverage', 'Fashion', 'Sports', 'Travel', 'Software',
    'IT Services', 'E-Commerce', 'Logistics', 'Marketing', 'Engineering',
  ])

  for (const s of steps) {
    const action = s.action.toUpperCase()
    if (action !== 'TYPE' && action !== 'SELECT' && action !== 'LOOKUP') continue
    const label = (s.target ?? '').toLowerCase()
    const value = s.value ?? ''
    if (!value) continue

    // Phone field checks
    if (/phone|mobile|tel/.test(label) && !phoneRe.test(value)) {
      issues.push(`Data type: phone field "${s.target}" has non-phone value "${value}" — use format "+1 555-123-4567"`)
      check5 = false
    }
    // Email field checks
    if (/\bemail\b/.test(label) && !emailRe.test(value)) {
      issues.push(`Data type: email field "${s.target}" has non-email value "${value}" — use format "user@example.com"`)
      check5 = false
    }
    // Date field checks
    if (/\bdate\b/.test(label) && !dateRe.test(value)) {
      issues.push(`Data type: date field "${s.target}" must be MM/DD/YYYY, got "${value}"`)
      check5 = false
    }
    // Website/URL field checks — pure numbers are NOT valid URLs
    if (/website|url|link|homepage/i.test(label)) {
      if (pureNumRe.test(value.trim())) {
        issues.push(`Data type: website/URL field "${s.target}" has pure number "${value}" — must be a URL like "https://www.example.com"`)
        check5 = false
      } else if (value && !urlRe.test(value) && !value.startsWith('www.')) {
        issues.push(`Data type: website/URL field "${s.target}" has non-URL value "${value}" — must start with https://`)
        check5 = false
      }
    }
    // Industry field checks — must be a valid industry category
    // Skip if the manifest provides valid options (they take priority over the hardcoded list)
    if (/\bindustry\b|\bsector\b|\bvertical\b/i.test(label)) {
      // First try to validate against manifest options if available
      const manifestFieldForIndustry = manifestFields?.find(
        f => f.label.toLowerCase().trim() === (s.target ?? '').toLowerCase().trim()
      )
      const hasManifestOptions = manifestFieldForIndustry?.options && manifestFieldForIndustry.options.length > 0
      if (hasManifestOptions) {
        // Validate against manifest options (case-insensitive)
        const optionSet = new Set(manifestFieldForIndustry!.options!.map(o => o.toLowerCase().trim()))
        if (!optionSet.has(value.toLowerCase().trim())) {
          issues.push(
            `Data type: industry/select field "${s.target}" has invalid value "${value}". ` +
            `Must be one of the VALID OPTIONS from the manifest: [${manifestFieldForIndustry!.options!.slice(0, 5).join(', ')}...]. ` +
            `Use the FIRST option as default: "${manifestFieldForIndustry!.options![0]}".`
          )
          check5 = false
        }
      } else if (!VALID_INDUSTRIES.has(value)) {
        issues.push(
          `Data type: industry field "${s.target}" has invalid value "${value}". ` +
          `Must be one of: Technology, Healthcare, Finance, Retail, Manufacturing, Education, Consulting, Banking, etc. ` +
          `"${value}" is not a valid industry category — use "Technology" as default.`
        )
        check5 = false
      }
    }
    // Lookup/Parent Account field checks — must not be a status word
    if (/parent|account name|company name/i.test(label) && statusWords.test(value)) {
      issues.push(
        `Data type: lookup field "${s.target}" has status/type word "${value}" — this is NOT an account name. ` +
        `Use a real company name like "Acme Corp" or "GlobalTech Ltd".`
      )
      check5 = false
    }
  }


  // Check 6: Action name validity — detect FILL_FORM, ENTER, SET and other hallucinated names
  const VALID_ACTIONS = new Set([
    'NAVIGATE', 'CLICK', 'TYPE', 'FILL', 'INPUT', 'SELECT', 'LOOKUP',
    'CHECKBOX', 'ASSERT_TEXT', 'ASSERT_URL', 'ASSERT_TOAST', 'WAIT',
    'MULTI_SELECT', 'UPLOAD', 'SCROLL', 'SCREENSHOT',
  ])
  let check6 = true
  for (const s of steps) {
    const a = (s.action ?? '').toUpperCase().trim()
    if (!VALID_ACTIONS.has(a)) {
      issues.push(
        `Invalid action "${s.action}" at step ${s.id}. ` +
        `Valid actions: NAVIGATE, CLICK, TYPE, SELECT, LOOKUP, CHECKBOX, ASSERT_TEXT, ASSERT_URL, ASSERT_TOAST, WAIT. ` +
        `Use TYPE to fill form fields — never FILL_FORM, ENTER, SET, or SET_TEXT.`
      )
      check6 = false
    }
  }

  // Check 7: Field hallucination guard
  // Reject steps that reference field labels NOT in the manifest.
  // This prevents "Email" being generated for Account creation when the
  // actual Account form has no Email field.
  let check7 = true
  if (manifestFields && manifestFields.length > 0) {
    // Build case-insensitive set of known field labels.
    // Normalize underscores to spaces so that snake_case canonical labels (e.g. "origin_port")
    // correctly match LLM-generated targets (e.g. "Origin Port") and vice versa.
    const normalizeLabel = (s: string) => s.toLowerCase().trim().replace(/_/g, ' ')
    const knownFields = new Set(manifestFields.map(f => normalizeLabel(f.label)))

    const FIELD_ACTIONS = new Set(['TYPE', 'SELECT', 'LOOKUP', 'CHECKBOX', 'MULTI_SELECT'])
    const hallucinated: string[] = []
    for (const s of steps) {
      if (!FIELD_ACTIONS.has((s.action ?? '').toUpperCase())) continue
      const target = String(s.target ?? '').trim()
      if (!target) continue
      if (!knownFields.has(normalizeLabel(target))) {
        hallucinated.push(target)
      }
    }
    if (hallucinated.length > 0) {
      const knownList = manifestFields.map(f => `"${f.label}"`).join(', ')
      issues.push(
        `Hallucinated field(s): ${hallucinated.map(f => `"${f}"`).join(', ')} — ` +
        `these fields do NOT exist in the form. ` +
        `ONLY use these fields from the manifest: [${knownList}]. ` +
        `Remove all TYPE/SELECT/LOOKUP steps for unlisted fields.`
      )
      check7 = false
    }
  }

  // Check 8: Navigation CLICK locator type enforcement
  // A CLICK step whose target is a plain navigation section name (no CSS syntax)
  // MUST use locator_type "role" — never "text" or "label".
  // This catches the "text=Users" anti-pattern that fails in SPAs because
  // getByText() matches the inner <span> of the nav <li>, which is not clickable.
  let check8 = true
  const NAV_SECTION_RE = /^(users|user|accounts|account|contacts|contact|leads|lead|opportunities|opportunity|dashboard|home|settings|setting|reports|report|products|product|orders|order|invoices|invoice|campaigns|campaign|tasks|task|cases|case|projects|project|customers|customer|vendors|vendor|employees|employee|admin|panel|modules|module|team|billing|analytics|calendar|messages|notifications|documents|integrations|permissions|roles|groups|categories|workflows|automation)s?$/i
  for (const s of steps) {
    if ((s.action ?? '').toUpperCase() !== 'CLICK') continue
    const target = (s.target ?? '').trim()
    const locType = (s.locator_type ?? '').toLowerCase().trim()
    // Only flag if the target looks like a bare nav section word (no CSS / role syntax)
    if (!target || target.includes('=') || target.includes('.') || target.includes('#')) continue
    if (NAV_SECTION_RE.test(target) && (locType === 'text' || locType === 'label' || locType === '')) {
      issues.push(
        `NAV-CLICK locator type: CLICK "${target}" must use locator_type: "role" (not "${locType || 'unset'}"). ` +
        `Navigation section items must use role=link, name=... to avoid matching unclickable inner <span> elements. ` +
        `Fix: set target to "role=link, name=${target}" and locator_type to "role".`
      )
      check8 = false
    }
  }

  // Check 9: Invalid/Placeholder Data Guard
  // Rejects steps with obviously nonsensical/placeholder values like "-", "N/A", empty strings,
  // single characters, or bare meaningless punctuation. These indicate the LLM had no real data
  // and fell back to garbage placeholders that will always fail at runtime.
  // Also catches pure-number values for URL/phone fields (wrong format).
  let check9 = true
  const PLACEHOLDER_RE = /^[-–—.?!_*#@~`\/\\]+$/
  const NA_RE = /^n\/?a$/i
  for (const s of steps) {
    const action = (s.action ?? '').toUpperCase()
    if (!['TYPE', 'SELECT', 'LOOKUP'].includes(action)) continue
    const value = (s.value ?? '').trim()
    const label = (s.target ?? '').toLowerCase()
    if (!value || value.length < 2 || PLACEHOLDER_RE.test(value) || NA_RE.test(value)) {
      issues.push(
        `Invalid placeholder data: step "${s.target}" has value "${value || '(empty)'}" — ` +
        `use realistic test data (e.g., real phone: "+1 555-123-4567", real name: "Acme Corp", ` +
        `valid dropdown option from VALID OPTIONS). Placeholder values like "-" always fail.`
      )
      check9 = false
    }
    // Also catch: pure number used for a website/URL field
    if (/website|url|link|homepage/i.test(label) && /^\d{5,}$/.test(value)) {
      issues.push(
        `Invalid data: website/URL field "${s.target}" has a bare number "${value}" — ` +
        `must be a full URL starting with https:// (e.g. "https://www.example.com")`
      )
      check9 = false
    }
    // Also catch: non-phone-formatted value for phone fields (pure digits, no formatting)
    if (/phone|mobile|tel/.test(label) && /^\d{7,}$/.test(value) && !value.startsWith('+')) {
      issues.push(
        `Invalid data: phone field "${s.target}" has unformatted number "${value}" — ` +
        `must use phone format like "+1 555-123-4567" or "+91 98765-43210"`
      )
      check9 = false
    }
  }

  // Check 10: Update Operation — Full workflow guard (entity-agnostic)
  // Validates: NAVIGATE (list) → TYPE (search) → CLICK (record) → CLICK (Edit) → field edits → CLICK (save) → ASSERT
  // Works for any entity: Account, Lead, Contact, Opportunity, Product, etc.
  let check10 = true
  const SEARCH_BOX_RE_C10 = /search|filter|find|query/i
  // Wide match — catches "Edit", "Edit Account", "Edit Lead", "✏️ Edit"
  const EDIT_BTN_RE_C10 = /\bedit\b|\bmodify\b/i
  const isUpdateOpForValidation = /\b(update|edit|modify|change)\b/i.test(testEntityHint ?? '')

  // Check 10b: Create-URL-in-Update guard
  // An Update test MUST NEVER navigate to a /new, /create, or /add URL.
  // This is the most common hallucination: LLM generates Create flow for Update tests.
  if (isUpdateOpForValidation) {
    const CREATE_URL_IN_UPDATE_RE = /\/(new|create|add)(\?|\/|$)/i
    const badCreateNavs = steps.filter(s =>
      s.action.toUpperCase() === 'NAVIGATE' &&
      CREATE_URL_IN_UPDATE_RE.test(s.value ?? '')
    )
    if (badCreateNavs.length > 0) {
      const badUrl = badCreateNavs[0].value ?? ''
      const listUrl = badUrl.replace(/\/?(new|create|add)(\?.*)?$/i, '').replace(/\/$/, '') || '/<entity-list>'
      issues.push(
        `🚨 UPDATE OPERATION CRITICAL ERROR: NAVIGATE "${badUrl}" goes to a CREATE page. ` +
        `Update tests MUST NEVER navigate to /new, /create, or /add URLs. ` +
        `REQUIRED: Change NAVIGATE target to the LIST page "${listUrl}" (no /new suffix). ` +
        `Then follow: NAVIGATE list → TYPE search → CLICK record → CLICK Edit → modify fields → CLICK Save → ASSERT.`
      )
      check10 = false
    }

    // Also flag CLICK on "+ New <Entity>" / "Create <Entity>" in an Update test
    const createBtnsInUpdate = steps.filter(s =>
      s.action.toUpperCase() === 'CLICK' &&
      /\b(create|\+\s*new)\s+\w/i.test(s.target ?? '')
    )
    if (createBtnsInUpdate.length > 0) {
      const badBtn = createBtnsInUpdate[0].target ?? ''
      issues.push(
        `🚨 UPDATE OPERATION CRITICAL ERROR: CLICK "${badBtn}" is a CREATE button — FORBIDDEN in Update tests. ` +
        `Update tests click "Edit" to enter edit mode, NOT a Create/New button. ` +
        `Replace with: CLICK "Edit" (or the edit button from the manifest) after opening the record.`
      )
      check10 = false
    }
  }

  if (isUpdateOpForValidation) {
    const FIELD_ACTIONS_C10 = new Set(['TYPE', 'SELECT', 'LOOKUP', 'CHECKBOX', 'MULTI_SELECT'])
    // Find the first TRUE field-edit step — exclude TYPE steps targeting a search box
    const firstFieldIdx = steps.findIndex(s => {
      if (!FIELD_ACTIONS_C10.has((s.action ?? '').toUpperCase())) return false
      if ((s.action ?? '').toUpperCase() === 'TYPE' && SEARCH_BOX_RE_C10.test(s.target ?? '')) return false
      return true
    })

    if (firstFieldIdx >= 0) {
      const NAV_LINK_RE   = /^role=(link|menuitem|tab)/i
      const CREATE_BTN_RE = /\b(create|\+\s*new|new)\s+\w/i
      const stepsBeforeField = steps.slice(0, firstFieldIdx)

      // Record selection: CLICK that is NOT nav link, NOT create button, NOT edit button
      const recordSelectionClicks = stepsBeforeField.filter(s => {
        if ((s.action ?? '').toUpperCase() !== 'CLICK') return false
        const target = (s.target ?? '').trim()
        if (NAV_LINK_RE.test(target)) return false
        if (CREATE_BTN_RE.test(target)) return false
        if (EDIT_BTN_RE_C10.test(target)) return false  // Edit btn ≠ record selection
        const cleanTarget = target.replace(/^(text|css|role|placeholder|label|id|xpath)=/i, '').replace(/["']/g, '').trim()
        if (statusWords.test(cleanTarget) || /^(prospecting|qualification|closed|won|lost|new|pending)$/i.test(cleanTarget)) {
          return false
        }
        return true
      })

      // Also require CLICK on Edit button before field edits
      const hasEditClick = stepsBeforeField.some(s =>
        (s.action ?? '').toUpperCase() === 'CLICK' && EDIT_BTN_RE_C10.test(s.target ?? '')
      )

      const missingItems: string[] = []
      if (recordSelectionClicks.length === 0) missingItems.push('CLICK on record name (e.g., CLICK "Acme Corp")')
      if (!hasEditClick) missingItems.push('CLICK Edit button (e.g., CLICK "Edit")')

      if (missingItems.length > 0) {
        issues.push(
          `Update operation missing required steps before field-edit at position ${firstFieldIdx + 1}: [${missingItems.join(' + ')}]. ` +
          `MANDATORY SEQUENCE: NAVIGATE → TYPE in search box → CLICK record name → CLICK "Edit" → modify fields → CLICK save. ` +
          `"Create <Entity>" / "+ New <Entity>" are FORBIDDEN in Update tests — use "Edit" to enter edit mode.`
        )
        check10 = false
      }
    }
  }

  // Check 11: Create operation step ordering guard
  // For Create operations:
  //   a) The "open form" CLICK (e.g., "+New Account") MUST come BEFORE any TYPE/SELECT/LOOKUP
  //      field-filling steps. If it appears after field steps, the test will try to type into
  //      a form that isn't open yet.
  //   b) NAVIGATE must go to the LIST page, NOT directly to a create/new URL. Navigating
  //      directly to /leads/create bypasses the mandatory "+New Lead" CLICK step.
  //   c) If field steps are present but no OPEN_FORM CLICK exists at all, flag it.
  // NOTE: CONVERT operations are EXCLUDED — they use a different step sequence:
  //       NAVIGATE → TYPE search → CLICK record → CLICK "Create <Target>" trigger → fields → CLICK submit
  //       Check 14 handles the convert-specific validation.
  let check11 = true
  const isConvertOpForCheck11 = /\b(convert|transform|turn\s+into|move\s+to)\b/i.test(testEntityHint ?? '')
  const isCreateOpForCheck11 = !isConvertOpForCheck11 && (minimumFieldSteps === 2 || /\b(create|add|new)\b/i.test(testEntityHint ?? ''))
  if (isCreateOpForCheck11 && !isUpdateOpForValidation) {
    const FIELD_ACTIONS_C11 = new Set(['TYPE', 'SELECT', 'LOOKUP', 'CHECKBOX', 'MULTI_SELECT'])
    const SUBMIT_RE_C11 = /\b(create|save|submit|confirm|done|finish)\b/i
    // Match "new", "add", "open" as word boundary, AND also "+new"/"+add" patterns
    // where "+" is a non-word char before "new" (e.g. "+New Account", "+Add Lead").
    const OPEN_FORM_RE_C11 = /(?:\b|\+)(new|add|open)\b/i
    // URL pattern that indicates navigating DIRECTLY to a create form — forbidden for Create tests
    const CREATE_URL_RE_C11 = /\/(create|new|add)(?:[?|/]|$)/i

    // Sub-check 11a: detect NAVIGATE directly to a create URL (e.g. /leads/create, /accounts/new)
    const directCreateNav = steps.find(s =>
      (s.action ?? '').toUpperCase() === 'NAVIGATE' &&
      CREATE_URL_RE_C11.test(s.value ?? '')
    )
    if (directCreateNav) {
      const badUrl = directCreateNav.value ?? ''
      // Extract the list URL by stripping the /create|/new|/add suffix
      const listUrl = badUrl.replace(/\/?(create|new|add)(\?.*)?$/i, '').replace(/\/$/, '') || '/'
      issues.push(
        `Create operation URL error: NAVIGATE "${badUrl}" goes DIRECTLY to the create form. ` +
        `This bypasses the required CLICK "+ New <Entity>" step that opens the form. ` +
        `REQUIRED ORDER: (1) NAVIGATE to the LIST page "${listUrl || '<list-url>'}" → ` +
        `(2) CLICK "+ New <Entity>" button (from PRIMARY ACTION BUTTON or ALL PAGE BUTTONS) → ` +
        `(3) TYPE/SELECT required fields → (4) CLICK submit button. ` +
        `Change NAVIGATE target to "${listUrl || '<list-url>'}" and ADD a CLICK step for the "+ New <Entity>" button.`
      )
      check11 = false
    }

    const firstFieldIdxC11 = steps.findIndex(s => FIELD_ACTIONS_C11.has((s.action ?? '').toUpperCase()))
    if (firstFieldIdxC11 > 0) {
      // Sub-check 11b: Look for an "open form" CLICK that appears AFTER the first field step
      const misplacedOpenFormIdx = steps.findIndex((s, idx) => {
        if (idx <= firstFieldIdxC11) return false
        if ((s.action ?? '').toUpperCase() !== 'CLICK') return false
        const target = (s.target ?? '').toLowerCase()
        return OPEN_FORM_RE_C11.test(target) && !SUBMIT_RE_C11.test(target)
      })
      if (misplacedOpenFormIdx > firstFieldIdxC11) {
        const offendingTarget = steps[misplacedOpenFormIdx]?.target ?? 'unknown'
        issues.push(
          `Create operation step ordering error: CLICK "${offendingTarget}" (step ${misplacedOpenFormIdx + 1}) ` +
          `appears AFTER field-filling steps (first field step at ${firstFieldIdxC11 + 1}). ` +
          `REQUIRED ORDER: NAVIGATE → CLICK "${offendingTarget}" (open form) → TYPE/SELECT fields → CLICK submit button. ` +
          `Move the "${offendingTarget}" click to STEP 2, right after NAVIGATE, BEFORE any TYPE/SELECT/LOOKUP steps.`
        )
        check11 = false
      }

      // Sub-check 11c: field steps exist but NO open-form CLICK appears before them
      const hasOpenFormClickBefore = steps.slice(0, firstFieldIdxC11).some(s => {
        if ((s.action ?? '').toUpperCase() !== 'CLICK') return false
        const target = (s.target ?? '').toLowerCase()
        return OPEN_FORM_RE_C11.test(target) && !SUBMIT_RE_C11.test(target)
      })
      if (!hasOpenFormClickBefore && !directCreateNav) {
        // No open-form click found anywhere before field filling
        issues.push(
          `Create operation missing OPEN FORM step: field-filling starts at step ${firstFieldIdxC11 + 1} ` +
          `but there is no preceding CLICK to open the create form. ` +
          `REQUIRED ORDER: NAVIGATE to list page → CLICK "+ New <Entity>" button → TYPE/SELECT fields. ` +
          `Add a CLICK step for the "+ New <Entity>" button BEFORE step ${firstFieldIdxC11 + 1}. ` +
          `Check PRIMARY ACTION BUTTON or ALL PAGE BUTTONS for the exact button name.`
        )
        check11 = false
      }
    }
  }

  // Check 12: Submit vs Assertion ordering guard
  // The submit CLICK (e.g. CLICK "Save", CLICK "Create Lead") MUST come BEFORE the final ASSERT_URL / ASSERT_TEXT step.
  // If ASSERT_URL appears before the submit CLICK, the test will assert page redirection/success
  // before the form is actually submitted, leading to a test failure.
  let check12 = true
  const submitClickIdx = steps.findIndex(s => {
    if ((s.action ?? '').toUpperCase() !== 'CLICK') return false
    const target = (s.target ?? '').toLowerCase()
    return /\b(save|submit|create|confirm|finish)\b/i.test(target)
  })
  const assertIdx = steps.findIndex(s => (s.action ?? '').toUpperCase().startsWith('ASSERT'))
  if (submitClickIdx !== -1 && assertIdx !== -1 && assertIdx < submitClickIdx) {
    const submitTarget = steps[submitClickIdx]?.target ?? 'Save'
    issues.push(
      `Step ordering error: The save/submit button click "${submitTarget}" (step ${submitClickIdx + 1}) ` +
      `appears AFTER the assertion step ${assertIdx + 1}. ` +
      `REQUIRED ORDER: NAVIGATE → fill fields → CLICK submit button ("${submitTarget}") → ASSERT/Verify success. ` +
      `Move the submit CLICK to step ${assertIdx + 1} and the assertion/verification step to the very end.`
    )
    check12 = false
  }

  // Check 14: Convert operation — full workflow validation gate
  // Fires ONLY for convert (not create) operations.
  // Verifies the 3-part mandatory structure:
  //   Part A: conversion trigger CLICK on source entity detail page
  //   Part B: ALL required fields of target entity (TYPE/SELECT/LOOKUP)
  //   Part C: final submit CLICK before the ASSERT steps
  const isConvertOpForCheck14 = /\b(convert|transform|turn\s+into|move\s+to)\b/i.test(testEntityHint ?? '')
  if (isConvertOpForCheck14) {
    // Part A: must have a CLICK step targeting the conversion trigger
    const hasTriggerClickC14 = steps.some(s =>
      s.action.toUpperCase() === 'CLICK' &&
      /create\s+booking|create\s+\w+|convert/i.test(s.target ?? '')
    )
    if (!hasTriggerClickC14) {
      issues.push(
        'CONVERT CHECK 14A: Missing conversion trigger CLICK step. ' +
        'Step 4 of PHASE 1 MUST be: CLICK the "Create Booking" (or equivalent) button on the source record detail page. ' +
        'This is the button that opens the target entity creation form. WITHOUT it the booking form never opens.'
      )
    }

    // Part B: minimum required field steps
    const fieldStepsC14 = steps.filter(s => ['TYPE', 'SELECT', 'LOOKUP', 'CHECKBOX'].includes(s.action.toUpperCase()))
    const minForConvert = Math.max(effectiveRequiredCount, minimumFieldSteps ?? 2)
    if (fieldStepsC14.length < minForConvert) {
      issues.push(
        `CONVERT CHECK 14B: Only ${fieldStepsC14.length} field step(s) found — need at least ${minForConvert}. ` +
        'PHASE 2 requires a TYPE/SELECT/LOOKUP step for EVERY ★ required field of the target entity (e.g. Booking). ' +
        'The most common mistake is skipping from PHASE 1 straight to ASSERT_URL. ' +
        'Generate one step per ★ field: Booking Reference, Service Type, Origin Port, Destination Port, etc.'
      )
    }

    // Part C: must have a final submit CLICK between field steps and ASSERTs
    const assertIndexC14 = steps.findIndex(s => s.action.toUpperCase().startsWith('ASSERT'))
    const fieldIndexC14  = fieldStepsC14.length > 0
      ? Math.max(...fieldStepsC14.map(s => steps.indexOf(s)))
      : -1
    const hasSubmitBeforeAssertC14 = steps.some((s, idx) =>
      s.action.toUpperCase() === 'CLICK' &&
      /create|submit|save|confirm/i.test(s.target ?? '') &&
      idx > fieldIndexC14 &&
      (assertIndexC14 < 0 || idx < assertIndexC14)
    )
    if (!hasSubmitBeforeAssertC14 && assertIndexC14 >= 0) {
      issues.push(
        'CONVERT CHECK 14C: Missing final submit CLICK before ASSERT_URL. ' +
        'After filling all required fields, you MUST click the final "Create Booking" submit button. ' +
        'Without this step the form is never submitted and no booking record is created.'
      )
    }
  }

  // Check 13: Create operation — strong success validation gate
  // For Create operations the app redirects to the DETAIL PAGE (e.g. /leads/42), NOT the list page.
  // This check enforces that the final assertion either:
  //   a) Uses ASSERT_URL with a partial entity-detail path (e.g. "/leads/") — not the bare list path
  //   b) Uses ASSERT_TEXT to verify a record-specific element on the detail page
  // A final assertion of ASSERT_URL with only the list page (e.g. value="/leads") is a FALSE
  // POSITIVE: the page never lands on the list, so the assertion would either pass vacuously or fail
  // in ways that mask a real failure (form error, page not redirected).
  let check13 = true
  const isCreateOpForCheck13 = minimumFieldSteps === 2 || /\b(create|add|new)\b/i.test(testEntityHint ?? '')
  if (isCreateOpForCheck13 && !isUpdateOpForValidation) {
    // Gather all final assertion steps (everything after the last submit CLICK)
    const lastSubmitIdx = (() => {
      for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i]
        if ((s.action ?? '').toUpperCase() === 'CLICK' &&
            /\b(save|submit|create|confirm|finish|done)\b/i.test(s.target ?? '')) {
          return i
        }
      }
      return -1
    })()

    const finalAssertionSteps = lastSubmitIdx >= 0
      ? steps.slice(lastSubmitIdx + 1).filter(s => (s.action ?? '').toUpperCase().startsWith('ASSERT'))
      : steps.filter(s => (s.action ?? '').toUpperCase().startsWith('ASSERT'))

    if (finalAssertionSteps.length === 0) {
      // No assertion at all after creation — always reject
      issues.push(
        `Create operation missing success validation: no ASSERT step found after the submit/create button. ` +
        `REQUIRED: add ASSERT_URL with entity detail-page pattern (e.g. value: "/${(testEntityHint ?? 'record').toLowerCase()}s/" or "/leads/") ` +
        `AND/OR ASSERT_TEXT with the record title visible on the detail page. ` +
        `The app redirects to the detail page after creation — NEVER stays on the list page.`
      )
      check13 = false
    } else {
      // Check whether ALL final ASSERT_URL steps are using only a bare list-page path
      // A bare list path looks like "/leads", "/contacts", "/accounts" (no trailing slash or ID)
      // A detail-path looks like "/leads/", "/lead/", "/contacts/42", "/leads?id=" etc.
      const BARE_LIST_PATH_RE = /^\/[a-z_-]+s?\/?$|^\/[a-z_-]+s?\?(?!.*\/)/i
      const DETAIL_PATH_RE = /\/[a-z_-]+s?\/|id=|record|detail|view/i

      const assertUrlSteps = finalAssertionSteps.filter(s => (s.action ?? '').toUpperCase() === 'ASSERT_URL')
      const assertTextSteps = finalAssertionSteps.filter(s => (s.action ?? '').toUpperCase() === 'ASSERT_TEXT')

      const hasDetailUrlAssertion = assertUrlSteps.some(s => {
        const val = (s.value ?? '').trim()
        // Passes if the value contains a detail path indicator (trailing slash after entity = partial match for /entity/ID)
        return DETAIL_PATH_RE.test(val) || val.endsWith('/') || val.includes('/')
          // A value like "/leads/" is correct — it ends with /
          // A value like "/leads" (bare) is wrong — it is the list page
          && !BARE_LIST_PATH_RE.test(val)
      })
      const hasDetailTextAssertion = assertTextSteps.length > 0

      // If the only ASSERT_URL assertions use a bare list-page path, fail the check
      const onlyBareListAssertion = assertUrlSteps.length > 0 &&
        assertUrlSteps.every(s => {
          const val = (s.value ?? '').trim()
          // Bare list paths: "/leads", "/contacts", "/accounts" — no trailing / or ID segment
          return BARE_LIST_PATH_RE.test(val) && !val.endsWith('/')
        })

      if (onlyBareListAssertion && !hasDetailTextAssertion) {
        const badValue = assertUrlSteps[0]?.value ?? ''
        const entityName = (testEntityHint ?? 'record').toLowerCase()
        issues.push(
          `Create operation weak final assertion: ASSERT_URL value "${badValue}" points to the LIST page, not the detail page. ` +
          `After a successful Create, the app redirects to the DETAIL PAGE (e.g. /${entityName}s/42, /${entityName}/123). ` +
          `REQUIRED: Change ASSERT_URL value to the entity detail path pattern (e.g. "/${entityName}s/" or "/${entityName}/") ` +
          `OR add ASSERT_TEXT for the record title/name typed during creation. ` +
          `Example correct steps:\n` +
          `  { "action": "ASSERT_URL", "value": "/${entityName}s/" }   ← detail URL pattern\n` +
          `  { "action": "ASSERT_TEXT", "target": "<name you typed>", "locator_type": "text" }  ← record title`
        )
        check13 = false
      }
    }
  }

  // Check 15: Anti-placeholder guard — real data enforcement
  // Fires for TYPE, LOOKUP, and SELECT steps. Rejects values that look like
  // generic placeholders invented by the LLM ("Test Record", "Sample Account", "John Doe", etc.).
  // When real data exists (injected via REAL EXISTING RECORDS or REAL LOOKUP DATA blocks),
  // the LLM MUST use one of those exact values — not an invented placeholder.
  let check15 = true
  const GENERIC_PLACEHOLDER_RE = /^(test\s+(record|account|lead|contact|product|sku|item|user|company|order|invoice|customer)|sample\s+\w+|john\s+doe|jane\s+(doe|smith)|john\s+smith|foo\s+bar|bar\s+foo|acme\s+corp(oration)?\s*$|lorem|placeholder|dummy|fake|mock|demo\s+\w+|test\s*\d*$|my\s+(account|company|record)|some\s+(record|company|account)|existing\s+(record|account)|new\s+(record|entry))$/i
  const FIELD_ACTIONS_C15 = new Set(['TYPE', 'LOOKUP', 'SELECT'])
  for (const s of steps) {
    const action = (s.action ?? '').toUpperCase()
    if (!FIELD_ACTIONS_C15.has(action)) continue
    const value = (s.value ?? '').trim()
    if (!value || value.length === 0) continue
    // Skip NAVIGATE/ASSERT values and very short values (e.g. single characters, codes)
    if (value.length < 3) continue
    // Skip values that look like valid codes/IDs (alphanumeric with dashes, dots, underscores)
    if (/^[A-Z0-9][A-Z0-9\-_.]{2,}$/i.test(value) && !/\s/.test(value)) continue
    if (GENERIC_PLACEHOLDER_RE.test(value)) {
      issues.push(
        `Anti-placeholder violation: step ${steps.indexOf(s) + 1} (${action} "${s.target ?? ''}") uses ` +
        `placeholder value "${value}" which does NOT exist in the application. ` +
        `You MUST use a REAL EXISTING RECORD name from the "=== REAL EXISTING RECORDS ===" or ` +
        `"=== REAL LOOKUP DATA ===" sections. NEVER invent names like "Test Record", "Sample Account", ` +
        `"John Doe", or "Jane Smith". If no real data section exists, use the sampleValue from the FIELD MANIFEST.`
      )
      check15 = false
    }
  }

  return {
    passed: check1 && check2 && check3 && check4 && check5 && check6 && check7 && check8 && check9 && check10 && check11 && check12 && check13 && check15,
    checks: {
      requiredFieldCoverage:     check1,
      urlVerification:           check2,
      buttonNameExact:           check3,
      locatorTypeValid:          check4,
      dataTypeAlignment:         check5,
      createSuccessValidation:   check13,
      realDataEnforcement:       check15,
    },
    issues,
  }
}


// ── JSON parse helper ─────────────────────────────────────────────────────────

function parseStepsJson(raw: string): AgentStep_Playwright[] {
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.split('\n').filter(l => !l.trim().startsWith('```')).join('\n')
  }
  // Extract first JSON array
  const match = cleaned.match(/\[[\s\S]*\]/)
  if (!match) throw new Error('No JSON array found in LLM output')
  return JSON.parse(match[0]) as AgentStep_Playwright[]
}

// ── Main exported function ────────────────────────────────────────────────────

export interface StepGenInput {
  projectId:    string
  testCaseId?:  string  // if editing an existing test case
  testName:     string  // e.g. "Create Invoice With Required Fields"
  description?: string
  executionId?: string  // required for HITL
  entityFilter?: string // narrow metadata to one entity
  brdContent?:  string  // optional override
  existingTestsContent?: string // optional override
}

export interface StepGenOutput {
  steps:      AgentStep_Playwright[]
  validation: StepValidationResult
  thoughts:   string[]
  loopCount:  number
  confidence: number
}

export async function runTestStepGeneratorAgent(
  input: StepGenInput,
): Promise<StepGenOutput> {
  const startMs = Date.now()
  const jobId   = uuidv4()
  const thoughts: string[] = []

  log.info({ projectId: input.projectId, testName: input.testName }, '[STEP-GEN] Starting')

  // ── OBSERVE: gather all context ───────────────────────────────────────────

  thoughts.push('OBSERVE: gathering field manifest, URL map, metadata chunks, project artifacts, and learnings')

  // Detect entity name early for learning registry queries
  const entityHintForLearnings = input.entityFilter ?? (() => {
    // Priority 0: Convert/Transform flow — extract TARGET entity (word after "to")
    // "Convert Quotation to Booking - Happy Path" → "Booking"
    const convertMatchHL = input.testName.match(/\b(?:convert|transform|turn\s+into|move\s+to)\s+\w+\s+to\s+(\w+)/i)
    if (convertMatchHL) {
      const t = convertMatchHL[1].trim()
      return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()
    }
    const stripped = input.testName
      // Strip leading verb (create, update, etc.)
      .replace(/^(create|update|edit|delete|view|add|manage|verify|test|check)\s+/i, '')
      // Strip conjunctions followed by another verb (e.g., "and Submit", "and Verify", "or Check")
      .replace(/\b(and|or)\s+(submit|verify|check|save|confirm|cancel|click|navigate|launch|open|close|send|view|search|select|fill)\b/gi, '')
      // Strip common filler words
      .replace(/\b(new|a|an|the|successfully|with|for|and|or|record|records|details|detail|valid|invalid|existing|required|optional|active|inactive|duplicate|mandatory|basic|empty|updated|given|correct|incorrect|multiple|successful|happy|path|flow|scenario|case)\b/gi, '')
      // Strip anything after a dash or hyphen (e.g., "- Happy Path")
      .replace(/\s*[-–—].*$/, '')
      .trim()
    // Case-agnostic extraction: normalize to lowercase first so ALL-CAPS,
    // TitleCase, and mixed-case entity names all resolve correctly.
    // Verb-form stop words (creating, adding, etc.) prevent "Test creating a product" → "Creating"
    const STOP_WORDS = new Set([
      'the','and','or','for','with','new','all','record','records','form','page','test','case',
      'creating','adding','editing','updating','deleting','viewing','checking','verifying',
      'testing','managing','making','submitting','saving','clicking','navigating',
      'submit','verify','check','save','confirm','cancel','launch','open','close','send','search','select','fill',
      'happy','path','flow','scenario','step','steps',
    ])
    const words = stripped.toLowerCase().split(/\s+/).filter(w => w.length >= 3 && !STOP_WORDS.has(w))
    const entity = words[0] ?? stripped.split(/\s+/)[0] ?? ''
    return entity.charAt(0).toUpperCase() + entity.slice(1)
  })()

  // ── CRITICAL: resolve entity name BEFORE fetching manifest ──────────────
  // entityFilter may be empty, ALL-CAPS ("PRODUCT"), or TitleCase ("Product").
  // We normalize it to TitleCase here so buildFieldManifest always gets a
  // clean, non-empty entity name. This is the fix for the case-sensitivity bug.
  let resolvedEntityFilter = (() => {
    // Priority 0: Convert/Transform flow — extract TARGET entity (word after "to" or "into")
    // e.g. "Convert Quotation to Booking - Happy Path" → "Booking"
    // The TARGET entity is whose form we fill, so its manifest is what we need.
    // We prioritize this even if entityFilter is set, because for conversion tests,
    // entityFilter is often set to the source entity (e.g. "Quotation"), but we must
    // load the target entity's field manifest (e.g. "Booking") to generate modal inputs.
    const convertMatchEF = input.testName.match(/\b(?:convert|conversion|transform|move)(?:\s+[\w\-]+)?\s+to\s+(\w+)/i)
      || input.testName.match(/\b(?:turn)(?:\s+[\w\-]+)?\s+into\s+(\w+)/i)
    if (convertMatchEF) {
      const t = convertMatchEF[1].trim()
      return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()
    }
    // Priority 1: explicitly passed entityFilter (truthy, length > 2)
    if (input.entityFilter && input.entityFilter.trim().length > 2) {
      const ef = input.entityFilter.trim()
      const efNorm = ef.charAt(0).toUpperCase() + ef.slice(1).toLowerCase()
      // Discard if it is actually just a field name context (like "Last Name", "First Name", "Email")
      const isFieldFilter = /^(last|first|email|phone|website|industry|status|type|subject|origin|description|amount|stage|date|currency)/i.test(efNorm)
        || /\bname$/i.test(efNorm)
      if (!isFieldFilter) {
        return efNorm
      }
    }
    // Priority 2: extract from test name (case-agnostic)
    const stripped = input.testName
      // Strip leading verb (create, update, etc.)
      .replace(/^(create|update|edit|delete|view|add|manage|verify|test|check)\s+/i, '')
      // Strip conjunctions followed by another verb (e.g., "and Submit", "and Verify", "or Check")
      .replace(/\b(and|or)\s+(submit|verify|check|save|confirm|cancel|click|navigate|launch|open|close|send|view|search|select|fill)\b/gi, '')
      // Strip common filler words
      .replace(/\b(new|a|an|the|successfully|with|for|and|or|record|records|details|detail|valid|invalid|existing|required|optional|active|inactive|duplicate|mandatory|basic|empty|updated|given|correct|incorrect|multiple|successful|happy|path|flow|scenario|case)\b/gi, '')
      // Strip anything after a dash or hyphen (e.g., "- Happy Path")
      .replace(/\s*[-–—].*$/, '')
      .trim()
    // Expanded stop words: verb forms prevent "Test creating a product" → "Creating"
    const STOP_RE = new Set([
      'the','and','or','for','with','new','all','record','records','form','page','test','case',
      'creating','adding','editing','updating','deleting','viewing','checking','verifying',
      'testing','managing','making','submitting','saving','clicking','navigating',
      'submit','verify','check','save','confirm','cancel','launch','open','close','send','search','select','fill',
      'happy','path','flow','scenario','step','steps',
    ])
    const words = stripped.toLowerCase().split(/\s+/).filter(w => w.length >= 3 && !STOP_RE.has(w))
    const entity = words[0] ?? stripped.split(/\s+/)[0] ?? ''
    return entity.length > 0 ? entity.charAt(0).toUpperCase() + entity.slice(1) : undefined
  })()

  log.info(
    { projectId: input.projectId, testName: input.testName, rawEntityFilter: input.entityFilter, resolvedEntityFilter },
    '[STEP-GEN] Resolved entity filter for manifest lookup',
  )

  let [manifest, urlMap, ragResult, projectArtifacts, learningsText, learnedButtons, sampleTestData, hitlLearnings, fieldTypeCorrections] = await Promise.all([
    buildFieldManifest(input.projectId, resolvedEntityFilter),
    buildUrlMap(input.projectId),
    ragSearchTool({ projectId: input.projectId, query: `${input.testName} form fields steps`, topK: 8 }),
    // Pull stored BRD + existing tests from the projects table
    (async () => {
      const row = await prisma.projects.findUnique({
        where:  { id: input.projectId },
        select: { brd_content: true, existing_tests_content: true, existing_tests_filename: true },
      })
      return row ?? {}
    })(),
    // Pull past learnings for this entity (failures, button mappings, corrections)
    entityHintForLearnings.length > 2
      ? formatLearningsForPrompt(input.projectId, entityHintForLearnings)
      : Promise.resolve(''),
    // Pull confirmed button names from learning registry
    entityHintForLearnings.length > 2
      ? getButtonMapping(input.projectId, entityHintForLearnings)
      : Promise.resolve({ openButton: null, submitButton: null }),
    // Pull sample test data for realistic value generation
    // Returns the first matching record — used as sampleTestData for field value injection
    (async () => {
      if (!resolvedEntityFilter || resolvedEntityFilter.length < 2) return null
      try {
        // Fetch multiple records to maximize chance of finding a real existing name
        const rows = await prisma.web_test_data.findMany({
          where: {
            project_id:  input.projectId,
            entity_name: { contains: resolvedEntityFilter, mode: 'insensitive' },
          },
          take: 5,
        })
        for (const row of rows) {
          if (row?.records && Array.isArray(row.records) && row.records.length > 0) {
            return row.records[0] as Record<string, unknown>
          }
        }
        return null
      } catch { return null }
    })(),
    // Pull HITL learnings — real user-confirmed fixes from past HITL decisions
    loadLearnings(input.projectId, input.testCaseId ?? '').catch(() => []),
    // Pull field-type corrections — where humans changed action types (e.g. LOOKUP → TYPE)
    extractFieldTypeCorrections(input.projectId, input.testCaseId ?? '').catch(() => []),
  ])

  // Update resolvedEntityFilter with the canonical entity name if found
  if (manifest?.entityName && manifest.entityName !== resolvedEntityFilter) {
    resolvedEntityFilter = manifest.entityName

    // Re-fetch sampleTestData using the correct resolvedEntityFilter if it was not found
    if (!sampleTestData) {
      try {
        const rows = await prisma.web_test_data.findMany({
          where: {
            project_id:  input.projectId,
            entity_name: { contains: resolvedEntityFilter, mode: 'insensitive' },
          },
          take: 3,
        })
        for (const row of rows) {
          if (row?.records && Array.isArray(row.records) && row.records.length > 0) {
            sampleTestData = row.records[0] as Record<string, unknown>
            break
          }
        }
      } catch { /* non-critical */ }
    }
  }

  // ── For Convert operations: fetch SOURCE entity records from web_test_data ──
  // This provides the real quotation reference (e.g. QUO-0007) to use in the search step.
  // sampleTestData above loads TARGET entity (Booking) data; this loads SOURCE entity data.
  let sourceEntityTestData: Record<string, unknown> | null = null
  if (/\b(convert|transform|turn\s+into|move\s+to)\b/i.test(input.testName)) {
    const sourceEntityForLookup = (() => {
      const m = input.testName.match(/\b(?:convert|transform|turn\s+into|move\s+to)\s+(\w+)\s+to\b/i)
      return m ? m[1] : 'Quotation'
    })()
    try {
      const sourceRows = await prisma.web_test_data.findMany({
        where: {
          project_id:  input.projectId,
          entity_name: { contains: sourceEntityForLookup, mode: 'insensitive' },
        },
        take: 3,
      })
      for (const row of sourceRows) {
        if (row?.records && Array.isArray(row.records) && row.records.length > 0) {
          sourceEntityTestData = row.records[0] as Record<string, unknown>
          break
        }
      }
      thoughts.push(`THINK: source entity (${sourceEntityForLookup}) test data loaded: ${sourceEntityTestData ? 'YES' : 'none'}`)
    } catch { /* non-fatal */ }
  }

  // Automatically discover list URLs from create URLs in the URL map
  // e.g. if URL map has "/leads/new", we also allow "/leads" so Check 2 (URL verification)
  // doesn't block the agent when it is forced by Check 11 to use the list page first.
  const CREATE_URL_PATTERN = /\/(create|new|add)(?:[?|/]|$)/i
  const derivedListPaths: string[] = []
  for (const path of urlMap.paths) {
    if (CREATE_URL_PATTERN.test(path)) {
      const listPath = path.replace(/\/?(create|new|add)(\?.*)?$/i, '').replace(/\/$/, '')
      const listPathWithSlash = listPath.startsWith('/') ? listPath : `/${listPath}`
      if (listPath && listPath !== path && !urlMap.paths.includes(listPath) && !urlMap.paths.includes(listPathWithSlash)) {
        derivedListPaths.push(listPathWithSlash)
      }
    }
  }
  if (derivedListPaths.length > 0) {
    urlMap.paths.push(...derivedListPaths)
    log.info({ derivedListPaths, projectId: input.projectId }, '[STEP-GEN] Injected derived list URLs into URL map')
  }

  // ── Fetch real lookup values for all lookup fields in the manifest ────────
  // For each lookup field (e.g., "User", "Account", "Role"), query web_test_data
  // for existing records so the LLM uses REAL names, never invented ones.
  // Result: Map<fieldLabel, string[]> — up to 5 real record names per lookup field.
  const realLookupValues = new Map<string, string[]>()
  if (manifest && manifest.fields.length > 0) {
    const lookupFields = manifest.fields.filter(f => f.type === 'lookup')
    if (lookupFields.length > 0) {
      // Also pull all web_test_data rows for this project once to search across entities
      try {
        const allTestDataRows = await prisma.web_test_data.findMany({
          where:  { project_id: input.projectId },
          select: { entity_name: true, records: true },
          take:   20,
        })

        for (const field of lookupFields) {
          // Derive the likely related entity name from the field label:
          //   "User" → "User", "Account Name" → "Account", "Role" → "Role"
          const fieldLabel = field.label
          const relatedEntity = fieldLabel
            .replace(/\bname\b/gi, '').replace(/\bId\b/gi, '').replace(/\bref\b/gi, '').trim()
            || fieldLabel

          // Find a web_test_data row whose entity_name is closest to the related entity
          const matchingRow = allTestDataRows.find(r => {
            const en = (r.entity_name ?? '').toLowerCase()
            const re = relatedEntity.toLowerCase()
            return en.includes(re) || re.includes(en)
          })

          if (matchingRow?.records && Array.isArray(matchingRow.records) && matchingRow.records.length > 0) {
            // Extract name-like values from the records
            const nameValues: string[] = []
            for (const rec of (matchingRow.records as Array<Record<string, unknown>>).slice(0, 5)) {
              // Look for a field that looks like a name (name, full_name, title, label, display_name)
              const nameKey = Object.keys(rec).find(k =>
                /^(name|full.?name|display.?name|title|label|username|user.?name|first.?name)$/i.test(k)
              )
              const val = nameKey ? String(rec[nameKey] ?? '') : ''
              if (val && val.length > 0 && val.length < 100) nameValues.push(val)
            }
            if (nameValues.length > 0) {
              realLookupValues.set(fieldLabel, nameValues)
              log.info(
                { projectId: input.projectId, field: fieldLabel, relatedEntity, count: nameValues.length },
                '[STEP-GEN] Found real lookup values for field',
              )
            }
          }
        }
      } catch (lookupErr) {
        log.warn({ lookupErr }, '[STEP-GEN] Failed to fetch real lookup values (non-fatal)')
      }
    }
  }
  thoughts.push(`THINK: real lookup values resolved for ${realLookupValues.size} lookup field(s): [${[...realLookupValues.keys()].join(', ')}]`)

  // ── THINK: build context prompt ───────────────────────────────────────────

  thoughts.push(`THINK: manifest has ${manifest?.requiredCount ?? 0} required fields [${manifest?.fields.filter(f => f.required).map(f => f.label).join(', ') ?? 'none'}], URL map has ${urlMap.paths.length} paths, learnings: ${learningsText.length > 0 ? 'YES' : 'none'}, fieldTypeCorrections: ${fieldTypeCorrections.length}`)

  // ── Apply field-type corrections to in-memory manifest ─────────────────────
  // When a human previously confirmed that e.g. "Account Name" is TYPE not LOOKUP,
  // patch the manifest field in-memory so Check 7 and the manifest text both
  // reflect the corrected type — preventing the same failure on re-generation.
  if (manifest && manifest.fields.length > 0 && fieldTypeCorrections.length > 0) {
    for (const correction of fieldTypeCorrections) {
      const correctedLabel = correction.fieldTarget.toLowerCase().trim()
      const fieldIdx = manifest.fields.findIndex(
        f => f.label.toLowerCase().trim() === correctedLabel ||
             correctedLabel.startsWith(f.label.toLowerCase().trim()) ||
             f.label.toLowerCase().trim().startsWith(correctedLabel)
      )
      if (fieldIdx >= 0) {
        const oldType = manifest.fields[fieldIdx].type
        // Map action name to manifest field type
        const newType: 'input' | 'select' | 'lookup' | 'checkbox' | 'textarea' =
          correction.correctAction === 'TYPE'     ? 'input'
          : correction.correctAction === 'SELECT'   ? 'select'
          : correction.correctAction === 'LOOKUP'   ? 'lookup'
          : correction.correctAction === 'CHECKBOX' ? 'checkbox'
          : 'input'
        manifest.fields[fieldIdx] = { ...manifest.fields[fieldIdx], type: newType }
        thoughts.push(`THINK: manifest patch — field "${manifest.fields[fieldIdx].label}" type changed from ${oldType} → ${newType} based on HITL correction`)
        log.info(
          { field: manifest.fields[fieldIdx].label, oldType, newType, correction: correction.correctAction },
          '[STEP-GEN] Patched manifest field type from HITL correction',
        )
      }
    }
  }


  // ── Detect operation type from test name ─────────────────────────────────────
  // Uses the centralized detectOperationType() — single source of truth.
  // This ensures compound test names like "Update SKU weight and dimensions"
  // are correctly identified as Update, not Create.
  const opType = detectOperationType(input.testName)

  const isUpdateOperation  = opType === 'update'
  const isDeleteOperation  = opType === 'delete'
  const isViewOperation    = opType === 'view'
  const isConvertOperation = opType === 'convert'
  const isSearchOperation  = opType === 'search'
  // isCreateOperation includes 'unknown' to give benefit of doubt for unrecognized test names
  const isCreateOperation  = opType === 'create' || opType === 'unknown'

  log.info(
    { projectId: input.projectId, testName: input.testName, opType, isUpdateOperation, isCreateOperation },
    '[STEP-GEN] Operation type detected',
  )


  // ── Entity-specific record name fallbacks ─────────────────────────────────
  // NOTE: These are LAST-RESORT fallbacks only — real data from web_test_data or
  // knowledge_graph.real_test_data ALWAYS takes precedence over these.
  // These fallbacks should be plausible real-world values, NEVER generic placeholders.
  const ENTITY_RECORD_FALLBACKS: Record<string, string> = {
    account:     'Acme Corp',
    lead:        'John Smith',
    contact:     'Jane Doe',
    opportunity: 'Q4 Enterprise Deal',
    product:     'Premium Widget',
    sku:         'SKU-39281',
    campaign:    'Summer Launch 2024',
    invoice:     'INV-0001',
    order:       'ORD-0001',
    contract:    'CTR-0001',
    quote:       'QT-0001',
    case:        'CS-0001',
    task:        'Follow Up Call',
    project:     'Website Redesign',
    vendor:      'GlobalSupply Ltd',
    customer:    'TechCorp Inc',
    employee:    'Alice Johnson',
    user:        'testuser@example.com',
  }
  const entityKey = (resolvedEntityFilter ?? '').toLowerCase().trim()
    .replace(/ies$/, 'y').replace(/ses$/, 's').replace(/s$/, '').trim()
  // CRITICAL: Never default to 'Test Record' — it does not exist in any real application.
  // Instead use an entity-appropriate plausible name or the entity name itself.
  const entityRecordFallback =
    ENTITY_RECORD_FALLBACKS[entityKey] ??
    ENTITY_RECORD_FALLBACKS[Object.keys(ENTITY_RECORD_FALLBACKS).find(k =>
      entityKey.startsWith(k) || k.startsWith(entityKey)
    ) ?? ''] ??
    // Last resort: use a sensible default based on entity name (still NOT 'Test Record')
    `${(resolvedEntityFilter ?? 'Record').charAt(0).toUpperCase() + (resolvedEntityFilter ?? 'Record').slice(1)}-0001`

  // ── Resolve real edit button from manifest (entity-agnostic) ─────────────
  const resolvedEditButton = manifest?.allButtons?.find(b => /\bedit\b/i.test(b)) ?? 'Edit'

  // ── Resolve real search input hint from manifest (entity-agnostic) ────────
  const resolvedSearchHint: string = (() => {
    const searchField = manifest?.fields.find(f =>
      /search|filter|find|query/i.test(f.label) && f.type === 'input'
    )
    if (searchField) return searchField.label
    if (resolvedEntityFilter) {
      const plural = resolvedEntityFilter.endsWith('s') ? resolvedEntityFilter : resolvedEntityFilter.endsWith('y') ? resolvedEntityFilter.slice(0, -1) + 'ies' : resolvedEntityFilter + 's'
      return `Search ${plural}`
    }
    return 'Search'
  })()

  // Minimum field steps: Create needs ≥2, Convert needs ≥2, Update needs ≥1, others 0
  // Combined with manifest.requiredCount so real manifest always wins if higher.
  const minimumFieldSteps = (isCreateOperation || isConvertOperation) ? 2 : isUpdateOperation ? 1 : 0

  const manifestText = manifest
    ? formatManifestForPrompt(manifest, isUpdateOperation ? 'update' : isCreateOperation ? 'create' : 'default')
    : isCreateOperation
      ? [
          `(no pre-crawled field manifest available for this entity)`,
          ``,
          `🔴 NO-MANIFEST INSTRUCTION — YOU MUST STILL FILL THE FORM:`,
          `Since no field manifest is available, use the BRD/SPECIFICATION and PROJECT METADATA`,
          `sections below to discover which fields exist on the ${input.entityFilter ?? 'entity'} creation form.`,
          `You MUST generate at least ${minimumFieldSteps} TYPE/SELECT/LOOKUP/CHECKBOX steps for form fields.`,
          `Typical create-form fields include: name/title, description, type/category, status, and any`,
          `entity-specific fields mentioned in the BRD. Do NOT skip field-filling steps.`,
          ``,
          `🔴 SUGGESTED BUTTON NAMES FOR ${input.entityFilter ?? 'entity'} CREATE FLOW:`,
          `  - OPEN FORM CLICK: "+ New ${input.entityFilter ?? 'Lead'}" (or "+New ${input.entityFilter ?? 'Lead'}", "New ${input.entityFilter ?? 'Lead'}", "New")`,
          `  - SUBMIT CLICK: "Save" (or "Create ${input.entityFilter ?? 'Lead'}", "Submit")`,
        ].join('\n')
      : isUpdateOperation
        ? [
            `(no pre-crawled field manifest available for this entity)`,
            ``,
            `🔴 NO-MANIFEST INSTRUCTION — YOU MUST SEARCH AND UPDATE:`,
            `Use the BRD/SPECIFICATION and PROJECT METADATA sections to discover how to edit the ${input.entityFilter ?? 'entity'}.`,
            ``,
            `🔴 SUGGESTED BUTTON NAMES FOR ${input.entityFilter ?? 'entity'} UPDATE FLOW:`,
            `  - EDIT BUTTON CLICK: "Edit"`,
            `  - SAVE BUTTON CLICK: "Save" (or "Save & New")`,
          ].join('\n')
        : '(no field manifest — use RAG metadata only)'

  // For Update operations: ensure the list page URL is in the URL map
  // The crawler may only have the create page (/account/new) but Update operations
  // need to navigate to the list page (/accounts) first.
  if (isUpdateOperation && manifest?.createUrl) {
    const listUrl = manifest.createUrl.replace(/\/(new|create|add)\b.*$/i, '')
    if (listUrl && listUrl !== manifest.createUrl && !urlMap.paths.includes(listUrl)) {
      urlMap.paths.push(listUrl)
      log.info({ listUrl, createUrl: manifest.createUrl }, '[STEP-GEN] Injected list URL for Update operation')
    }
  }

  // ── Change 2: Inject manifest.listUrl into URL map ALWAYS (modal + non-modal) ─
  // For modal forms the createUrl is /accounts/__modal__/account but the test MUST
  // NAVIGATE to /accounts. The manifest.listUrl (from business_rules.list_url) is the
  // authoritative source. Without this injection, Check 2 rejects NAVIGATE /accounts.
  if (manifest?.listUrl && !urlMap.paths.some(p => p === manifest!.listUrl)) {
    urlMap.paths.push(manifest.listUrl)
    log.info({ listUrl: manifest.listUrl }, '[STEP-GEN] Injected manifest.listUrl into URL map')
  }

  // For Convert operations: ensure BOTH source entity list URL AND target entity detail URL are in the map.
  // e.g. "Convert Quotation to Booking" needs /quotations (source list) + /bookings/ (target detail).
  if (isConvertOperation) {
    const srcEnt = (() => {
      const m = input.testName.match(/\b(?:convert|transform|turn\s+into|move\s+to)\s+(\w+)\s+to\b/i)
      return m ? m[1].toLowerCase() : 'quotation'
    })()
    const tgtEnt = (resolvedEntityFilter ?? 'booking').toLowerCase()
    const sourceListPath  = `/${srcEnt.endsWith('s') ? srcEnt : srcEnt.endsWith('y') ? srcEnt.slice(0, -1) + 'ies' : srcEnt + 's'}`
    const targetListPath  = `/${tgtEnt.endsWith('s') ? tgtEnt : tgtEnt.endsWith('y') ? tgtEnt.slice(0, -1) + 'ies' : tgtEnt + 's'}`
    if (!urlMap.paths.some(p => p.toLowerCase().includes(srcEnt))) {
      urlMap.paths.push(sourceListPath)
      log.info({ sourceListPath }, '[STEP-GEN] Injected source entity list URL for Convert operation')
    }
    if (!urlMap.paths.some(p => p.toLowerCase().includes(tgtEnt))) {
      urlMap.paths.push(targetListPath)
      log.info({ targetListPath }, '[STEP-GEN] Injected target entity list URL for Convert operation')
    }
  }

  const urlMapText = urlMap.paths.length > 0
    ? `=== VERIFIED URL MAP ===\nBase URL: ${urlMap.baseUrl}\nPaths (use ONLY these):\n${urlMap.paths.map(p => `  ✅ ${p}`).join('\n')}`
    : '(no crawler URL map — use relative paths inferred from metadata)'

  const ragText = ragResult.chunks.length > 0
    ? `=== PROJECT METADATA (RAG) ===\n${ragResult.chunks.join('\n\n---\n\n')}`
    : ''

  // ── Decode and include project artifact documents ───────────────────────
  function decodeArtifact(raw: string | null | undefined, maxChars = 4000): string {
    if (!raw) return ''
    const isLikelyBase64 = raw.length > 100 && /^[A-Za-z0-9+/=\n\r]+$/.test(raw.trim())
    if (isLikelyBase64) {
      try {
        const decoded = Buffer.from(raw.trim(), 'base64').toString('utf8')
        const printable = decoded.split('').filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127).length
        if (printable / decoded.length > 0.7) return decoded.slice(0, maxChars)
        return '[Binary document attached — not directly readable. Use filename context.]'
      } catch { return '' }
    }
    return raw.slice(0, maxChars)
  }

  const brdText = decodeArtifact(input.brdContent ?? (projectArtifacts as any).brd_content)
  const existingTestsText = decodeArtifact(input.existingTestsContent ?? (projectArtifacts as any).existing_tests_content)

  // ── Inject sample test data into manifest fields for realistic values ──────
  if (sampleTestData && manifest && manifest.fields.length > 0) {
    for (const field of manifest.fields) {
      if (field.sampleValue) continue  // already has a sample
      // Try direct key match and case-insensitive match
      const val = sampleTestData[field.label]
        ?? sampleTestData[field.label.toLowerCase()]
        ?? Object.entries(sampleTestData).find(
          ([k]) => k.toLowerCase().includes(field.label.toLowerCase())
                || field.label.toLowerCase().includes(k.toLowerCase())
        )?.[1]
      if (val && typeof val === 'string' && val.length > 0 && val.length < 200) {
        field.sampleValue = val
      }
    }
    thoughts.push(`THINK: injected ${manifest.fields.filter(f => f.sampleValue).length} sample values from web_test_data`)
  }

  // ── Change 1: Build sample data text — prefer canonical sampleRecords over web_test_data ─
  // web_test_data.records is often empty for modal-form entities (e.g., Account modal).
  // metadata_canonical.real_test_data always has real records and is the better source.
  const canonicalSampleRecord: Record<string, unknown> | null = (
    manifest?.sampleRecords && manifest.sampleRecords.length > 0
  ) ? (manifest.sampleRecords[0] as Record<string, unknown>) : null

  // Use canonical record first, then fall back to web_test_data
  const effectiveSampleRecord = canonicalSampleRecord ?? sampleTestData


  const sampleDataText = effectiveSampleRecord
    ? `=== SAMPLE TEST DATA (existing records — use for UPDATE/VIEW/SEARCH only, NOT for create) ===\n` +
      Object.entries(effectiveSampleRecord)
        .filter(([k, v]) => typeof v === 'string' && v.length > 0 && v.length < 200
          && !['id', 'created_at', 'updated_at'].includes(k.toLowerCase()))
        .slice(0, 15)
        .map(([k, v]) => `  "${k}": "${v}"`)
        .join('\n')
    : ''

  // ── Build real lookup values text block for LLM ───────────────────────────
  // This is the CRITICAL section that prevents invented lookup names.
  // For each lookup field, we provide the EXACT names that exist in the application.
  const lookupValuesText = realLookupValues.size > 0
    ? [
        `=== REAL LOOKUP DATA (MANDATORY — use ONLY these values for LOOKUP steps) ===`,
        `⚠️  These are REAL records that exist in the application. You MUST use one of these`,
        `   values as the "value" for any LOOKUP step. NEVER invent a name not listed here.`,
        ``,
        ...[...realLookupValues.entries()].map(([field, values]) =>
          `  Lookup field "${field}" — valid values (pick any one):\n` +
          values.map(v => `    ✅ "${v}"`).join('\n')
        ),
        ``,
        `⛔ FORBIDDEN: Using any name NOT listed above (e.g. "John Doe", "Jane Smith",`,
        `   "Test User", "Sample User") will cause the test to FAIL at runtime.`,
      ].join('\n')
    : ''

  // ── Build existing record name text block for Update/Search/View/Delete operations ──
  // For update/search/view/delete tests, the LLM MUST use a real record name that exists in the app.
  // This block provides the ground truth so the LLM never invents a name or a UUID.
  // Priority: manifest.sampleRecords (real_test_data from knowledge_graph) > web_test_data > realLookupValues

  // Helper: extract the best name-like field value from a record object
  const extractNameFromRecord = (rec: Record<string, unknown>): string | null => {
    // Priority 1: exact name fields
    const nameKey = Object.keys(rec).find(k =>
      /^(name|full.?name|display.?name|title|label|account.?name|contact.?name|lead.?name|company.?name|subject|first.?name)$/i.test(k)
    ) ?? Object.keys(rec).find(k => /name$/i.test(k) && !/id$/i.test(k))
    const nameVal = nameKey ? String(rec[nameKey] ?? '') : ''
    if (nameVal && nameVal.length > 0 && nameVal.length < 100) return nameVal
    // Priority 2: domain-specific identifier keys
    const idKey = Object.keys(rec).find(k =>
      /^(bl[_\s]?number|bl[_\s]?no|bl[_\s]?ref|booking[_\s]?number|booking[_\s]?ref|invoice[_\s]?number|order[_\s]?number|reference[_\s]?number|ref[_\s]?no|doc[_\s]?number|document[_\s]?number|quotation[_\s]?number|quote[_\s]?number|delivery[_\s]?number|shipment[_\s]?number|sku[_\s]?number|sku[_\s]?code|number|reference|code|identifier)$/i.test(k)
    )
    const idVal = idKey ? String(rec[idKey] ?? '') : ''
    if (idVal && idVal.length > 0 && idVal.length < 100) return idVal
    return null
  }

  // Collect ALL real record names from multiple sources — give the LLM a list of options
  const allRealRecordNames: string[] = []

  // Source 1: manifest.sampleRecords — real_test_data from knowledge_graph (highest priority)
  if (manifest?.sampleRecords && manifest.sampleRecords.length > 0) {
    for (const rec of manifest.sampleRecords.slice(0, 5) as Array<Record<string, unknown>>) {
      const n = extractNameFromRecord(rec)
      if (n && !allRealRecordNames.includes(n)) allRealRecordNames.push(n)
    }
  }

  // Source 2: sampleTestData from web_test_data (fallback)
  if (sampleTestData) {
    const n = extractNameFromRecord(sampleTestData)
    if (n && !allRealRecordNames.includes(n)) allRealRecordNames.push(n)
  }

  // Source 3: realLookupValues (secondary fallback)
  if (allRealRecordNames.length === 0 && realLookupValues.size > 0) {
    const first = [...realLookupValues.values()][0]
    if (first?.length && !allRealRecordNames.includes(first[0])) allRealRecordNames.push(first[0])
  }

  // Also fetch from knowledge_graph.real_test_data via additional web_test_data fetch (if still empty)
  if (allRealRecordNames.length === 0 && resolvedEntityFilter && resolvedEntityFilter.length >= 2) {
    try {
      const extraRows = await prisma.web_test_data.findMany({
        where: { project_id: input.projectId, entity_name: { contains: resolvedEntityFilter, mode: 'insensitive' } },
        take: 5,
      })
      for (const row of extraRows) {
        if (!row?.records || !Array.isArray(row.records)) continue
        for (const rec of (row.records as Array<Record<string, unknown>>).slice(0, 3)) {
          const n = extractNameFromRecord(rec)
          if (n && !allRealRecordNames.includes(n)) allRealRecordNames.push(n)
        }
      }
    } catch { /* non-fatal */ }
  }

  thoughts.push(`THINK: real entity record names resolved: [${allRealRecordNames.join(', ')}] (source: manifest.sampleRecords + web_test_data)`)

  const existingRecordNameForPrompt = (
    (isUpdateOperation || isSearchOperation || isViewOperation || isDeleteOperation) && allRealRecordNames.length > 0
  ) ? allRealRecordNames[0] : null

  const existingRecordsText = allRealRecordNames.length > 0 && (isUpdateOperation || isSearchOperation || isViewOperation || isDeleteOperation)
    ? [
        `=== REAL EXISTING RECORDS (USE THESE ONLY) ===`,
        `🔴 CRITICAL: The records below are REAL, EXISTING records in the live application.`,
        `   You MUST use ONE of these exact values for the search/click steps in this test.`,
        `   Do NOT invent any other name. If you use a name not listed here, the search`,
        `   will return zero results and the test will FAIL immediately.`,
        ``,
        `${resolvedEntityFilter ?? 'Entity'}: [${allRealRecordNames.map(n => `"${n}"`).join(', ')}]`,
        ``,
        `  ✅ PRIMARY record to use: "${allRealRecordNames[0]}"`,
        allRealRecordNames.length > 1
          ? `  ✅ Alternatives (also real):${allRealRecordNames.slice(1).map(n => ` "${n}"`).join(',')}`
          : '',
        ``,
        `⛔ FORBIDDEN: Do NOT use ANY of these invented/placeholder names:`,
        `   "Test Record", "Test Account", "Sample Account", "John Doe", "Jane Smith",`,
        `   "Test User", "Acme Corporation" (generic), "Test ${resolvedEntityFilter ?? 'Record'}", or any made-up name.`,
        `⛔ The search TYPE step value AND the record CLICK target MUST BOTH be: "${allRealRecordNames[0]}"`,
      ].filter(Boolean).join('\n')
    : allRealRecordNames.length === 0 && (isUpdateOperation || isSearchOperation || isViewOperation || isDeleteOperation)
      ? [
          `=== REAL EXISTING RECORDS — NOT FOUND ===`,
          `⚠️  No real test data was found in the database for entity: ${resolvedEntityFilter ?? 'unknown'}.`,
          `   Use the best available sample value from the FIELD MANIFEST (sampleValue field).`,
          `   If no sample value exists, use a plausible realistic value appropriate for this entity type.`,
          `⛔ NEVER use "Test Record", "Sample Account", "John Doe", or any generic placeholder.`,
        ].join('\n')
      : ''

  // Pre-compute whether the manifest has required fields that need explicit enumeration in prompt.
  // This is used by the CREATE OPERATION CONSTRAINT block below.
  const hasMissingRequiredFieldsForPrompt = manifest != null && manifest.fields.some(f => f.required)

  // Format HITL learnings for prompt injection
  const hitlLearningsText = Array.isArray(hitlLearnings) && hitlLearnings.length > 0
    ? formatLearningsBlock(hitlLearnings as import('../test-run/hitl-learning.service.js').FormattedLearning[])
    : ''

  // Format field-type corrections as CRITICAL OVERRIDES block (placed at TOP of prompt)
  const fieldTypeCorrectionsText = formatFieldTypeCorrectionsBlock(
    fieldTypeCorrections as import('../test-run/hitl-learning.service.js').FieldTypeCorrection[]
  )

  const userPrompt = [
    // ── 🚨 CRITICAL OVERRIDES — always first so they win over everything below ──
    fieldTypeCorrectionsText, // ← HITL field-type corrections: LOOKUP→TYPE etc. OVERRIDE manifest
    hitlLearningsText,        // ← HITL learnings: real user-confirmed fixes from past runs
    urlMapText,
    manifestText,
    learningsText,   // ← Past learnings: failures, button mappings, corrections
    lookupValuesText, // ← Real lookup values from web_test_data — MANDATORY for LOOKUP steps
    existingRecordsText, // ← Real existing record name for Update/Search/View ops — MANDATORY
    sampleDataText,  // ← Sample test data for realistic values
    ragText,
    brdText ? `=== BRD / SPECIFICATION (business rules to follow) ===\n${brdText}` : '',
    existingTestsText ? `=== EXISTING TEST CASES (for naming conventions and coverage reference) ===\n${existingTestsText}` : '',
    `=== TEST CASE ===\nName: ${input.testName}\nDescription: ${input.description ?? ''}`,
    // ── VIEW OPERATION CONSTRAINT ─────────────────────────────────────────────────
    // Injected for "View", "Open", "Preview", "Check Details" tests.
    // Grounds the LLM in the real record name and manifest-verified buttons.
    // Without this block the LLM hallucinates UUIDs and non-existent buttons.
    isViewOperation
      ? (() => {
          const listUrl = manifest?.createUrl
            ? manifest.createUrl.replace(/\/(new|create|add)\b.*$/i, '')
            : urlMap.paths.find(p =>
                p.toLowerCase().includes((resolvedEntityFilter ?? '').toLowerCase()) &&
                !/new|create|add/i.test(p)
              ) ?? (() => {
                const el = (resolvedEntityFilter ?? 'records').toLowerCase()
                return `/${el.endsWith('s') ? el : el.endsWith('y') ? el.slice(0, -1) + 'ies' : el + 's'}`
              })()

          const recordName = existingRecordNameForPrompt ?? entityRecordFallback

          // Build list of real buttons from manifest (action buttons only — exclude generic Submit/Save)
          const realActionButtons = manifest?.allButtons
            ?.filter(b => b && b.length > 0 && !/^(save|submit|cancel|close|reset|back)$/i.test(b))
            ?? []
          const buttonList = realActionButtons.length > 0
            ? realActionButtons.map(b => `    ✅ "${b}"`).join('\n')
            : '    (no action buttons found in metadata — do NOT invent button names)'

          return [
            `🔴 VIEW / PREVIEW OPERATION — ENTITY: ${resolvedEntityFilter ?? 'record'}`,
            ``,
            `This test navigates to and views an existing record. Follow EXACTLY these steps:`,
            ``,
            `  1. NAVIGATE to the ${resolvedEntityFilter ?? 'entity'} list page:`,
            `     action: NAVIGATE, value: "${listUrl}"`,
            `  2. TYPE the record identifier in the search/filter field:`,
            `     action: TYPE`,
            `     target: "${resolvedSearchHint}"`,
            `     locator_type: "placeholder"`,
            `     value: "${recordName}"`,
            `     ▶ MANDATORY: use EXACTLY this real record name — do NOT change it, do NOT use a UUID`,
            `  3. CLICK the matching record name/link from the filtered list:`,
            `     action: CLICK, target: "${recordName}", locator_type: "text"`,
            `     ▶ This clicks the record row/link that appeared in the filtered results`,
            `  4. ASSERT the detail page loaded:`,
            `     ASSERT_URL with the entity list path pattern (e.g. "${listUrl}/") OR`,
            `     ASSERT_TEXT with a field value from the record (e.g. "${recordName}")`,
            ``,
            `⛔ FORBIDDEN — do NOT generate any of these:`,
            `   - Search value or CLICK target using a UUID (e.g. "737b1b37-83ec-...") — FORBIDDEN`,
            `   - Any URL that contains a UUID (e.g. "${listUrl}/737b1b37-...") — FORBIDDEN`,
            `   - CLICK or ASSERT for buttons that do NOT appear in the list below`,
            `   - Inventing button names like "Preview Shipping Instructions" that are not in the manifest`,
            ``,
            realActionButtons.length > 0
              ? [
                  `⚠️ REAL ACTION BUTTONS verified from metadata (only use buttons from this list):`,
                  buttonList,
                  ``,
                  `⛔ ANY button NOT listed above does NOT exist in this application. Do NOT reference it.`,
                ].join('\n')
              : `⚠️ No action buttons found in metadata — if the test requires clicking a button after opening the record, use ASSERT_TEXT or ASSERT_URL only (no CLICK on invented buttons).`,
          ].join('\n')
        })()
      : '',
    // ── SEARCH/FILTER OPERATION CONSTRAINT ────────────────────────────────────────
    // Placed before CREATE/UPDATE so it also lands in the recency window.
    // Gives the LLM an explicit step-by-step search flow grounded in this app's behavior.
    isSearchOperation
      ? (() => {
          // Detect if the test name mentions a specific tab-style view filter
          const mentionsAllLeads        = /\ball\s*(leads|records|contacts|accounts)\b/i.test(input.testName)
          const mentionsRecentlyViewed  = /\brecently\s*viewed\b/i.test(input.testName)
          const mentionsTodaysLeads     = /\btoday\s*[''s]*\s*(leads|records)\b/i.test(input.testName)
          const hasTabFilter = mentionsAllLeads || mentionsRecentlyViewed || mentionsTodaysLeads
          const tabFilterStep = mentionsAllLeads       ? `CLICK "All Leads" tab (locator_type: "text" or "role")`
            : mentionsRecentlyViewed ? `CLICK "Recently Viewed" tab (locator_type: "text" or "role")`
            : mentionsTodaysLeads    ? `CLICK "Today's Leads" tab (locator_type: "text" or "role")`
            : ''

          const listUrl = manifest?.createUrl
            ? manifest.createUrl.replace(/\/(new|create|add)\b.*$/i, '')
            : urlMap.paths.find(p =>
                p.toLowerCase().includes((resolvedEntityFilter ?? '').toLowerCase()) &&
                !/new|create|add/i.test(p)
              ) ?? (() => {
                const el = (resolvedEntityFilter ?? 'records').toLowerCase()
                return `/${el.endsWith('s') ? el : el.endsWith('y') ? el.slice(0, -1) + 'ies' : el + 's'}`
              })()

          const recordName = existingRecordNameForPrompt ?? entityRecordFallback

          const lines = [
            `🔴 SEARCH / FILTER OPERATION — ENTITY: ${resolvedEntityFilter ?? 'record'}`,
            ``,
            `This test searches for a record in the list view. The list filters live as you type.`,
            `This app has TAB-STYLE view filters (e.g., "All Leads", "Recently Viewed", "Today's Leads")`,
            `but NO standalone "Filter" button and NO filter panel with dropdowns or "Create Filter".`,
            ``,
            `MANDATORY SEQUENCE — generate EXACTLY these steps:`,
            `  1. NAVIGATE to: ${listUrl}`,
          ]

          if (hasTabFilter) {
            lines.push(`  2. ${tabFilterStep} — this is a tab, not a form dropdown`)
            lines.push(`  3. TYPE search term into the search input:`)
          } else {
            lines.push(`  2. TYPE search term into the search input:`)
          }

          const typeStepNum = hasTabFilter ? 3 : 2
          const clickStepNum = typeStepNum + 1
          const assertStepNum = clickStepNum + 1

          lines.push(
            `     action: TYPE, target: "${resolvedSearchHint}", locator_type: "placeholder"`,
            `     value: "${recordName}"`,
            `     ▶ MANDATORY: use EXACTLY this record name — do NOT change it`,
            `  ${clickStepNum}. CLICK the matching record name from the filtered list:`,
            `     action: CLICK, target: "${recordName}", locator_type: "text"`,
            `     ▶ This clicks the RECORD ROW/LINK that appeared in the filtered list`,
            `     ▶ ⛔ NOT a "Filter" button — do NOT use "Filter" as target`,
            `  ${assertStepNum}. ASSERT the detail page loaded:`,
            `     ASSERT_URL with entity detail path OR ASSERT_TEXT with the record title`,
            ``,
            `⛔ FORBIDDEN — do NOT generate any of these:`,
            `   - CLICK "Filter" (no standalone filter button in this app)`,
            `   - SELECT from any Status/Type dropdown as a filter panel (does not exist)`,
            `   - CLICK "Create Filter", "Apply Filter", "Save Filter"`,
            `   - Any step that references a filter panel, filter dialog, or filter form`,
            `   - WAIT steps`,
          )

          return lines.join('\n')
        })()
      : '',

    // ── CONVERT OPERATION CONSTRAINT ──────────────────────────────────────────────
    // Injected for "Convert X to Y" tests. Fires even when manifest is null.
    // Enumerates ALL required target-entity fields and mandates the submit + assert steps.
    isConvertOperation
      ? (() => {
          const sourceEntity = (() => {
            const m = input.testName.match(/\bconvert\s+(\w+)\s+to\b/i)
              ?? input.testName.match(/\btransform\s+(\w+)\s+to\b/i)
            return m ? m[1] : 'Quotation'
          })()
          const targetEntity = resolvedEntityFilter ?? 'Booking'
          const sourceListUrl = urlMap.paths.find(p =>
            p.toLowerCase().includes(sourceEntity.toLowerCase()) && !/new|create|add/i.test(p)
          ) ?? (() => {
            const se = sourceEntity.toLowerCase()
            return `/${se.endsWith('s') ? se : se.endsWith('y') ? se.slice(0, -1) + 'ies' : se + 's'}`
          })()
          const targetDetailUrlHint = (() => {
            const te = targetEntity.toLowerCase()
            const tp = te.endsWith('s') ? te : te.endsWith('y') ? te.slice(0, -1) + 'ies' : te + 's'
            return `/${tp}/`
          })()
          // submitBtn = the FINAL button inside the Booking form to save the record
          const submitBtn = (manifest?.submitButton ?? learnedButtons.submitButton) ?? `Create ${targetEntity}`
          // conversionTriggerBtn = the button ON THE SOURCE ENTITY (Quotation) detail page
          // that opens the conversion form. In DS Logistics this is "Create Booking" — same as submitBtn.
          // IMPORTANT: Do NOT use learnedButtons.openButton (that is the list-page "+New X" button).
          // The conversion trigger is always named like "Create <TargetEntity>" on the source detail page.
          const conversionTriggerBtn = submitBtn

          // Build the required-field list — use manifest if available, otherwise build from TYPICAL_FIELDS
          const reqFields = manifest?.fields.filter(f => f.required) ?? []
          const reqList   = reqFields.length > 0
            ? reqFields.map(f => `  ★ [${f.type.toUpperCase()}] "${f.label}"${f.options?.length ? ' (pick from: ' + f.options.slice(0, 3).join(' | ') + ')' : ''}`).join('\n')
            : [
                `  ★ [INPUT]  "Booking Reference"  — unique booking ID (e.g. BK-2024-4821)`,
                `  ★ [SELECT] "Service Type"        — e.g. Ocean Freight | Air Freight | Road Freight`,
                `  ★ [INPUT]  "Origin Port"          — departure port/location (e.g. Shanghai Port)`,
                `  ★ [INPUT]  "Destination Port"     — arrival port/location (e.g. Los Angeles Port)`,
                `  ★ [INPUT]  "Estimated Departure Date" — MM/DD/YYYY format`,
                `  ★ [INPUT]  "Estimated Arrival Date"   — MM/DD/YYYY format`,
                `  ★ [INPUT]  "Carrier"              — shipping carrier name`,
                `  ★ [INPUT]  "Vessel"               — vessel/flight/truck reference`,
                `  ★ [SELECT] "Container Type"       — e.g. 20ft Standard | 40ft Standard | LCL`,
                `  ★ [INPUT]  "Number of Containers" — numeric count`,
                `  ★ [TEXTAREA] "Cargo Description"  — description of goods`,
                `  ★ [INPUT]  "Total Weight (kg)"    — total cargo weight`,
                `  ★ [INPUT]  "Total Volume (CBM)"   — total cargo volume`,
                `  ★ [INPUT]  "Freight Charges"      — cost of shipment`,
                `  ★ [SELECT] "Payment Terms"        — e.g. Prepaid | Collect | Third Party`,
                `  ★ [TEXTAREA] "Special Instructions" — any special handling notes`,
              ].join('\n')

          // Real source record name from web_test_data (source entity) or fallback
          // sourceEntityTestData holds real Quotation records from the DS Logistics app
          const sourceRecordId = (() => {
            const dataToSearch = sourceEntityTestData ?? (sampleTestData as Record<string,unknown> | null)
            if (dataToSearch) {
              const found = Object.entries(dataToSearch)
                .find(([k]) => /reference|number|quotation_?id|quote_?id|name|id/i.test(k))
              if (found && typeof found[1] === 'string' && found[1].length > 0) return found[1] as string
            }
            return 'QUO-0007'
          })()

          const uniqueSuffix = String(Date.now()).slice(-4)

          return [
            `🔴 CONVERT OPERATION — SOURCE: ${sourceEntity} → TARGET: ${targetEntity}`,
            ``,
            `This is a multi-step CONVERSION workflow. Follow EXACTLY these steps in order:`,
            ``,
            `⚠️ CRITICAL: This is NOT a Create or Search test. The button in PHASE 1 step 4`,
            `is the CONVERSION TRIGGER on the ${sourceEntity} DETAIL page, not a list-page button.`,
            `The button name is "${conversionTriggerBtn}" — use this EXACTLY.`,
            ``,
            `PHASE 1 — Locate the source ${sourceEntity} record and trigger conversion:`,
            `  1. NAVIGATE to the ${sourceEntity} list page: ${sourceListUrl}`,
            `     action: NAVIGATE, value: "${sourceListUrl}"`,
            `  2. TYPE the ${sourceEntity} identifier in the search/filter field:`,
            `     action: TYPE`,
            `     locator_type: "placeholder"`,
            `     value: "${sourceRecordId}"  ← USE THIS EXACT value (real existing record)`,
            `  3. CLICK the matching ${sourceEntity} record to open its detail page:`,
            `     action: CLICK, target: "${sourceRecordId}", locator_type: "text"`,
            `  4. CLICK the CONVERSION TRIGGER button on the ${sourceEntity} detail page:`,
            `     action: CLICK, target: "${conversionTriggerBtn}", locator_type: "role"`,
            `     ▶ This is the button that opens the ${targetEntity} creation form.`,
            `     ▶ It appears on the ${sourceEntity} DETAIL PAGE — NOT on the list page.`,
            `     ▶ NEVER use "+New ${sourceEntity}" or any button referencing the source entity.`,
            `     ▶ Copy the button name EXACTLY: "${conversionTriggerBtn}"`,
            ``,
            `PHASE 2 — Fill ALL required fields of the ${targetEntity} booking form:`,
            `The ${targetEntity} form has the following REQUIRED fields — generate a step for EACH:`,
            ``,
            reqList,
            ``,
            `Generate ONE TYPE/SELECT/LOOKUP step per ★ field above.`,
            `  ▶ Every ★ field MUST have its own step. Skipping even one causes form rejection.`,
            `  ▶ Use the unique booking reference: "BK-2024-${uniqueSuffix}" for the Booking Reference field.`,
            `  ▶ Use dates in MM/DD/YYYY format.`,
            `  ▶ Use realistic port names (e.g. "Shanghai Port", "Los Angeles Port", "Dubai Port").`,
            ``,
            `FINAL STEPS (MANDATORY — always included, never skip):`,
            `  CLICK "${submitBtn}" — final submit button to create the ${targetEntity} record`,
            `     action: CLICK, target: "${submitBtn}", locator_type: "role"`,
            `  ASSERT_URL — URL contains the ${targetEntity} detail path after successful creation:`,
            `     action: ASSERT_URL, value: "${targetDetailUrlHint}"`,
            `  ASSERT_TEXT — the Booking Reference value is visible confirming creation:`,
            `     action: ASSERT_TEXT, target: "BK-2024-${uniqueSuffix}", locator_type: "text"`,
            ``,
            `⛔ FORBIDDEN — NEVER do these:`,
            `  - CLICK "+New ${sourceEntity}" or "+New ${targetEntity}" (those are list-page buttons, NOT the conversion trigger)`,
            `  - Skip any ★ field (form validation will reject the submission)`,
            `  - Omit the CLICK "${submitBtn}" step (form is never submitted)`,
            `  - Omit the ASSERT_URL and ASSERT_TEXT steps`,
            `  - ASSERT_URL value "${sourceListUrl}" (bare source list — wrong, must be booking detail path)`,
          ].join('\n')
        })()
      : '',

    // ── CREATE/UPDATE OPERATION CONSTRAINT: explicit required fields listed by name ──
    // This is the highest-priority instruction — placed LAST in the prompt so
    // it is in the LLM's recency window. Lists every required field by name so
    // the LLM cannot miss them even if it skimmed the FIELD MANIFEST section.
    !isConvertOperation && (isCreateOperation || isUpdateOperation || hasMissingRequiredFieldsForPrompt)
      ? (() => {
          const reqFields = manifest ? manifest.fields.filter(f => f.required) : []
          const reqList   = reqFields.length > 0
            ? reqFields.map(f => `  ★ [${f.type.toUpperCase()}] "${f.label}"${f.options?.length ? ' (pick from: ' + f.options.slice(0,3).join(' | ') + ')' : ''}`).join('\n')
            : `  ★ [INPUT] "Name / Title"`
          if (isUpdateOperation) {
            // Update-specific instructions — fully entity-agnostic
            const listUrl = manifest?.createUrl
              ? manifest.createUrl.replace(/\/(new|create|add)\b.*$/i, '')
              : urlMap.paths.find(p => p.toLowerCase().includes((resolvedEntityFilter ?? '').toLowerCase()) && !/new|create|add/i.test(p))
              ?? (() => {
                const el = (resolvedEntityFilter ?? 'records').toLowerCase()
                return `/${getEntityPlural(el)}`
              })()

            // Build a clear record hint list for the UPDATE constraint block
            const updateRecordHint = allRealRecordNames.length > 0
              ? allRealRecordNames[0]
              : (existingRecordNameForPrompt ?? entityRecordFallback)
            const updateRecordAlternatives = allRealRecordNames.length > 1
              ? `\n     ▶ Other real options: ${allRealRecordNames.slice(1).map(n => `"${n}"`).join(', ')}`
              : ''

            return [
              `🔴 UPDATE OPERATION — ENTITY: ${resolvedEntityFilter ?? 'record'}`,
              ``,
              `AVAILABLE FIELDS FOR EDITING (pick at least 1):`,
              reqList || '  (all fields optional — pick any field to modify)',
              ``,
              allRealRecordNames.length > 0
                ? [
                    `╔══════════════════════════════════════════════════════════════════╗`,
                    `║  🔴 REAL EXISTING RECORDS — USE ONE OF THESE (MANDATORY)         ║`,
                    `╠══════════════════════════════════════════════════════════════════╣`,
                    `║  These records ACTUALLY EXIST in the application.                ║`,
                    `║  You MUST use one for BOTH the search step and the click step.   ║`,
                    `║                                                                   ║`,
                    `║  ✅ Available records for ${(resolvedEntityFilter ?? 'entity').padEnd(38)}║`,
                    ...allRealRecordNames.slice(0, 5).map(n => `║    → "${n}"${' '.repeat(Math.max(0, 59 - n.length))}║`),
                    `║                                                                   ║`,
                    `║  ❌ FORBIDDEN placeholder names (do NOT use these):              ║`,
                    `║    "Test Record"  "Test Account"  "John Doe"  "Sample Account"   ║`,
                    `╚══════════════════════════════════════════════════════════════════╝`,
                  ].join('\n')
                : '',
              ``,
              `UPDATE WORKFLOW — follow these 7 steps EXACTLY:`,
              `  1. NAVIGATE to: ${listUrl}`,
              `     ▶ This is the LIST page. NEVER navigate to a /new, /create, or /add URL.`,
              `  2. SEARCH STEP — TYPE the record name in the search input:`,
              `     ▶ action: TYPE`,
              `     ▶ target: "${resolvedSearchHint}"`,
              `     ▶ locator_type: "placeholder"`,
              `     ▶ value: "${updateRecordHint}"  ← USE THIS EXACT REAL RECORD NAME${updateRecordAlternatives}`,
              `     ▶ ⛔ MANDATORY: use EXACTLY this record name — do NOT change it or invent a new one`,
              `     ▶ ⚠️ Do NOT use status words ("Active", "Closed", "Prospect") as a record name`,
              `  3. CLICK the record name to open its detail page:`,
              `     ▶ action: CLICK, target: "${updateRecordHint}", locator_type: "text"`,
              `     ▶ ⛔ DO NOT click "Create ${resolvedEntityFilter ?? 'Record'}" — FORBIDDEN`,
              `  4. EDIT BUTTON — CLICK to enter edit mode:`,
              `     ▶ action: CLICK`,
              `     ▶ target: "${resolvedEditButton}"`,
              `     ▶ locator_type: "role"`,
              `     ▶ ⛔ NEVER use "Create ${resolvedEntityFilter ?? 'Record'}" — that opens a create form`,
              `  5. Modify at least 1 field — pick from AVAILABLE FIELDS above. Use REALISTIC data.`,
              `  6. CLICK the save button to save changes.`,
              `  7. ASSERT_URL that the URL confirms the save succeeded (e.g., back to list page).`,
              ``,
              `⚠️ CRITICAL: ALL of steps 2, 3, 4 are MANDATORY. Skipping any one will FAIL validation.`,
              `⚠️ CRITICAL: Step 4 MUST be CLICK "${resolvedEditButton}" — NOT "Create ${resolvedEntityFilter ?? 'Record'}".`,
            ].filter(Boolean).join('\n')
          }
          // Derive the entity detail-page URL pattern hint for the final assertion
          const entityLower = (resolvedEntityFilter ?? 'record').toLowerCase()
          const detailPlural = getEntityPlural(entityLower)
          const detailUrlHint = `/${detailPlural}/`  // e.g. /leads/, /contacts/, /accounts/
          const detailUrlAlt  = `/${entityLower}/`   // e.g. /lead/, /contact/
          // Generate a short, time-derived numeric suffix (4 digits) for unique record names
          const uniqueSuffix = String(Date.now()).slice(-4)
          const entityNameForDisplay = resolvedEntityFilter ?? 'Record'
          // Build entity-appropriate unique name hint
          const uniqueNameHint = (() => {
            const el = entityNameForDisplay.toLowerCase()
            if (/lead|contact/.test(el))        return `Test ${entityNameForDisplay} ${uniqueSuffix}`
            if (/account|company|vendor|customer/.test(el)) return `Acme ${entityNameForDisplay} ${uniqueSuffix}`
            if (/invoice/.test(el))             return `INV-TEST-${uniqueSuffix}`
            if (/order/.test(el))               return `ORD-TEST-${uniqueSuffix}`
            if (/opportunity|deal/.test(el))    return `Q4 Deal ${uniqueSuffix}`
            if (/campaign/.test(el))            return `Auto Campaign ${uniqueSuffix}`
            return `Test ${entityNameForDisplay} ${uniqueSuffix}`
          })()

          // Resolve the open-form and submit button names for explicit mention in the prompt
          // Change 3: triggerButton (from business_rules.trigger_button) takes highest priority —
          // it is the user-verified, authoritative name of the button on the list page.
          const openBtnForPrompt   = manifest?.triggerButton ?? learnedButtons.openButton ?? manifest?.openButton ?? `+ New ${entityNameForDisplay}`
          const submitBtnForPrompt = learnedButtons.submitButton ?? manifest?.submitButton ?? `Create ${entityNameForDisplay}`

          // Change 4: Use manifest.detailUrlPattern for the ASSERT_URL hint when available
          const detailUrlHintFinal = manifest?.detailUrlPattern ?? detailUrlHint
          const detailUrlAltFinal  = detailUrlAlt

          // The list URL for NAVIGATE step (from manifest.listUrl — authoritative for modal forms)
          const createListUrl = manifest?.listUrl
            ?? urlMap.paths.find(p =>
                p.toLowerCase().includes((resolvedEntityFilter ?? '').toLowerCase()) &&
                !/new|create|add|modal/i.test(p)
              )
            ?? `/${getEntityPlural(entityLower)}`

          return [
            `🔴 MANDATORY FIELDS — YOU MUST GENERATE A STEP FOR EVERY ★ FIELD BELOW:`,
            reqList,
            ``,
            `This test creates a new ${entityNameForDisplay}.`,
            `Rules:`,
            `  1. Generate one TYPE/SELECT/LOOKUP step per ★ field above — NO SKIPPING`,
            `  2. Use the EXACT label string shown (e.g. "${reqFields[0]?.label ?? 'Field'}")`,
            `  3. MANDATORY STEP SEQUENCE (in this exact order):`,
            `     Step 1: NAVIGATE to the ${entityNameForDisplay} LIST page → value: "${createListUrl}"`,
            `     Step 2: CLICK the OPEN FORM button → { "action": "CLICK", "target": "${openBtnForPrompt}", "locator_type": "role" }`,
            `            ⚠️  This CLICK step MUST come BEFORE any TYPE/SELECT/LOOKUP steps.`,
            `            ⚠️  Use EXACTLY this button name: "${openBtnForPrompt}"`,
            `     Steps 3-N: TYPE/SELECT/LOOKUP all ★ required fields listed above`,
            `     Step N+1: CLICK the SUBMIT button → { "action": "CLICK", "target": "${submitBtnForPrompt}", "locator_type": "role" }`,
            `     Step N+2: ASSERT_URL and/or ASSERT_TEXT to verify success`,
            `  4. Missing even ONE ★ field will FAIL validation and trigger re-generation`,
            `  5. The CLICK "${openBtnForPrompt}" step at Step 2 is MANDATORY — omitting it causes test failure`,
            ``,
            `╔══════════════════════════════════════════════════════════════════╗`,
            `║  🆕 UNIQUE TEST DATA — MANDATORY FOR THIS CREATE TEST            ║`,
            `╠══════════════════════════════════════════════════════════════════╣`,
            `║  To avoid duplicate-record errors, use this pre-generated UNIQUE  ║`,
            `║  name for the primary name / title field of this record:          ║`,
            `║                                                                   ║`,
            `║  ✅ USE THIS EXACT VALUE: "${uniqueNameHint.padEnd(37)}"  ║`,
            `║                                                                   ║`,
            `║  ⚠️  SAMPLE TEST DATA shows EXISTING records — do NOT reuse      ║`,
            `║     any name from it. Existing names cause duplicate errors.       ║`,
            `║  ❌ FORBIDDEN: plain names with no suffix (e.g. "John Smith",     ║`,
            `║     "Acme Corp", "Test Record") — these likely already exist.     ║`,
            `╚══════════════════════════════════════════════════════════════════╝`,
            ``,
            `🔴 CREATE SUCCESS VALIDATION — MANDATORY (final 1-2 steps after submit):`,
            `  The app redirects to the DETAIL PAGE after creation (NOT the list page, NO toast).`,
            `  You MUST add BOTH of these final steps:`,
            `  Step A — ASSERT_URL (detail page pattern):`,
            `    { "action": "ASSERT_URL", "value": "${detailUrlHintFinal}" }`,
            `    OR: { "action": "ASSERT_URL", "value": "${detailUrlAltFinal}" }`,
            `    ⚠️ The URL after save will be "${detailUrlHintFinal}42" or similar — NOT "${detailUrlHintFinal.replace(/\/$/, '')}" (bare list).`,
            `    ✅ Using "${detailUrlHintFinal}" (with trailing slash) correctly matches "/accounts/636a2bf5..." as a contains check.`,
            `  Step B — ASSERT_TEXT (record title or unique detail field):`,
            `    { "action": "ASSERT_TEXT", "target": "${uniqueNameHint}", "locator_type": "text" }`,
            `    OR: { "action": "ASSERT_TEXT", "target": "${entityNameForDisplay} Details", "locator_type": "text" }`,
            `  ❌ FORBIDDEN: ASSERT_URL value "${detailUrlHintFinal.replace(/\/$/, '')}" (bare list page — will never match after redirect)`,
            `  ❌ FORBIDDEN: ASSERT_TOAST — no toast is shown on successful creation`,
          ].join('\n')
        })()
      : '',

    // ── DELETE OPERATION CONSTRAINT ──
    isDeleteOperation
      ? (() => {
          const listUrl = manifest?.createUrl
            ? manifest.createUrl.replace(/\/(new|create|add)\b.*$/i, '')
            : urlMap.paths.find(p => p.toLowerCase().includes((resolvedEntityFilter ?? '').toLowerCase()) && !/new|create|add/i.test(p))
            ?? (() => {
              const el = (resolvedEntityFilter ?? 'records').toLowerCase()
              return `/${getEntityPlural(el)}`
            })()
          
          const deleteBtn = manifest?.allButtons?.find(b => /\b(delete|remove|archive|deactivate|trash)\b/i.test(b)) ?? 'Delete'
          const deleteRecordHint = allRealRecordNames.length > 0
            ? allRealRecordNames[0]
            : (existingRecordNameForPrompt ?? entityRecordFallback)

          return [
            `🔴 DELETE OPERATION — ENTITY: ${resolvedEntityFilter ?? 'record'}`,
            ``,
            allRealRecordNames.length > 0
              ? `🔴 REAL EXISTING RECORD TO DELETE: ${allRealRecordNames.map(n => `"${n}"`).join(' | ')} — use ONE of these EXACT names`
              : '',
            ``,
            `DELETE WORKFLOW — follow these 6 steps EXACTLY:`,
            `  1. NAVIGATE to: ${listUrl}`,
            `     ▶ This is the LIST page.`,
            `  2. SEARCH STEP — TYPE the record name in the search input:`,
            `     ▶ action: TYPE`,
            `     ▶ target: "${resolvedSearchHint}"`,
            `     ▶ locator_type: "placeholder"`,
            `     ▶ value: "${deleteRecordHint}"  ← USE THIS EXACT REAL RECORD NAME`,
            `     ▶ ⛔ MANDATORY: use EXACTLY this record name — do NOT change it or invent a new one`,
            `  3. CLICK the record name to open its detail page or select it:`,
            `     ▶ action: CLICK, target: "${deleteRecordHint}", locator_type: "text"`,
            `  4. DELETE BUTTON — CLICK to trigger deletion:`,
            `     ▶ action: CLICK`,
            `     ▶ target: "${deleteBtn}"`,
            `     ▶ locator_type: "role"`,
            `  5. CONFIRM DELETION (if confirmation modal/button appears):`,
            `     ▶ action: CLICK`,
            `     ▶ target: "Confirm" (or "Delete", "Yes", "OK" — whatever confirms the prompt)`,
            `     ▶ locator_type: "role"`,
            `  6. ASSERT_TEXT / ASSERT_URL to confirm deletion succeeded (e.g. redirected to list page, or "deleted successfully" toast is visible, or record no longer appears in search).`,
            ``,
            `⚠️ CRITICAL: ALL of steps 2, 3, 4 are MANDATORY. Skipping any one will FAIL validation.`,
            `⚠️ CRITICAL: Step 4 MUST be CLICK "${deleteBtn}" — NOT "Create ${resolvedEntityFilter ?? 'Record'}".`,
          ].filter(Boolean).join('\n')
        })()
      : '',

    // Inject confirmed button names — learning registry (runtime-confirmed) > manifest (metadata-derived)
    (() => {
      const openBtn   = learnedButtons.openButton   ?? manifest?.triggerButton ?? manifest?.openButton
      const submitBtn = learnedButtons.submitButton ?? manifest?.submitButton
      if (!openBtn && !submitBtn) return ''
      const lines = [`⚠️  CONFIRMED BUTTON NAMES (from metadata/past executions):`]
      if (openBtn) {
        lines.push(`  🔓 OPEN FORM button (Step 2 — CLICK on the LIST page to open the form):`)
        lines.push(`     "${openBtn}"`)
        lines.push(`     → This opens the create form. DO NOT use this as the save button.`)
      }
      if (submitBtn) {
        lines.push(`  💾 SUBMIT FORM button (last CLICK — inside the form to save the record):`)
        lines.push(`     "${submitBtn}"`)
        lines.push(`     → This saves/creates the record. DO NOT use this to open the form.`)
      }
      lines.push(`  ⛔ NEVER substitute, abbreviate, or invent button names. Copy EXACTLY character-for-character.`)
      return lines.join('\n')
    })(),
    `Generate executable Playwright steps for this test case. Output ONLY a JSON array.`,
  ].filter(Boolean).join('\n\n')

  // ── ACT + REFLECT: generate and self-validate (max 3 loops) ───────────────

  const llm    = buildLlm()
  const parser = new StringOutputParser()
  const chain  = llm.pipe(parser)

  let steps: AgentStep_Playwright[] = []
  let validation: StepValidationResult = { passed: false, checks: {} as any, issues: ['Not generated yet'] }
  let loopCount = 0

  while (loopCount < 3) {
    loopCount++
    thoughts.push(`ACT (loop ${loopCount}): calling LLM to generate steps`)

    const correctionHint = loopCount > 1
      ? `\n\nPREVIOUS ATTEMPT FAILED THESE CHECKS:\n${validation.issues.map(i => `• ${i}`).join('\n')}\nFix ALL of the above issues.`
      : ''

    try {
      const raw = await chain.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(userPrompt + correctionHint),
      ])
      steps = parseStepsJson(raw)
    } catch (err) {
      thoughts.push(`ACT (loop ${loopCount}): LLM parse error — ${String(err).slice(0, 100)}`)
      continue
    }

    // Assign sequential IDs
    steps = steps.map((s, i) => ({ ...s, id: String(i + 1) }))

    // Extract entity hint from test name for Check 3b (cross-entity button guard)
    // e.g. "Create and Submit New Campaign - Happy Path" → "Campaign"
    // Case-agnostic entity hint extraction for Check 3b (cross-entity button guard)
    // Handles ALL-CAPS, TitleCase, and mixed-case entity names identically.
    const STOP_HINT = new Set([
      'new','successfully','with','for','and','or','the','a','an',
      'submit','verify','check','save','confirm','cancel','launch','open','close','send','search','select','fill',
      'happy','path','flow','scenario','step','steps',
      'creating','adding','editing','updating','deleting','viewing','checking','verifying',
      'testing','managing','making','submitting','saving','clicking','navigating',
    ])
    const entityHintRaw = input.testName
      .replace(/^(create|update|edit|delete|view|add|manage|verify|test|check)\s+/i, '')
      // Strip conjunctions followed by a verb (e.g., "and Submit", "or Verify")
      .replace(/\b(and|or)\s+(submit|verify|check|save|confirm|cancel|click|navigate|launch|open|close|send|view|search|select|fill)\b/gi, '')
      .replace(/\b(new|successfully|with|for|and|or|the|a|an|happy|path|flow|scenario)\b/gi, '')
      // Strip anything after a dash/hyphen (e.g., "- Happy Path")
      .replace(/\s*[-\u2013\u2014].*$/, '')
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length >= 3 && !STOP_HINT.has(w))[0] ?? ''
    const entityHintNorm = entityHintRaw.charAt(0).toUpperCase() + entityHintRaw.slice(1)
    // For update operations, pass the full test name so Check 10 can detect
    // the operation type from the test name (not just the entity hint)
    const testEntityHint = entityHintNorm.length > 2 ? entityHintNorm : (input.entityFilter ?? '')
    const testNameForValidation = isUpdateOperation
      ? `update ${testEntityHint}`
      : isCreateOperation
        ? `create ${testEntityHint}`
        : isConvertOperation
          ? input.testName
          : isDeleteOperation
            ? `delete ${testEntityHint}`
            : isViewOperation
              ? `view ${testEntityHint}`
              : isSearchOperation
                ? `search ${testEntityHint}`
                : testEntityHint

    validation = validateSteps(
      steps,
      manifest?.requiredCount ?? 0,
      urlMap.paths,
      manifest?.submitButton,
      manifest?.allButtons,
      manifest?.fields,            // ← pass field list for Check 7 (hallucination guard)
      testNameForValidation,       // ← pass entity hint for Check 3b + Check 10 (update guard)
      minimumFieldSteps,           // ← enforce min field steps for Create/Add operations
    )


    thoughts.push(`REFLECT (loop ${loopCount}): validation ${validation.passed ? '✅ PASSED' : '❌ FAILED'} — ${validation.issues.join('; ')}`)

    if (validation.passed) break
  }

  // ── HITL if still failing after 3 loops ──────────────────────────────────

  if (!validation.passed && input.executionId) {
    thoughts.push('Calling hitlTool: could not pass validation after 3 loops')

    const hitlInput: HITLInput = {
      agentName:    'test-step-generator',
      executionId:  input.executionId,
      reason:       `Step generation failed ${loopCount} validation checks: ${validation.issues.join('; ')}`,
      suggestions: [
        'Verify the metadata is synced for this project',
        'Check that the entity name in the test case matches the metadata',
        `Required fields count: ${manifest?.requiredCount ?? 'unknown'}`,
      ],
      metadata: { projectId: input.projectId, testName: input.testName },
    }
    await hitlTool(hitlInput)
  }

  // Extract entity hint early for Safety Nets 0, 2, 3
  const effectiveEntityHint = resolvedEntityFilter ?? input.entityFilter ?? (() => {
    const stripped = input.testName
      .replace(/^(create|update|edit|delete|view|add|manage|verify|test|check)\s+/i, '')
      .replace(/\b(new|a|an|the|successfully|with|for|and|or|record|records|details|detail|valid|invalid|existing|required|optional|active|inactive|duplicate|mandatory|basic|empty|updated|given|correct|incorrect|multiple|successful)\b/gi, '')
      .trim()
    // Case-agnostic: normalize to lowercase so PRODUCT, Product, product all work
    const STOP_EFF = new Set(['the','and','for','with','new','all','record','records','form','page'])
    const words = stripped.toLowerCase().split(/\s+/).filter(w => w.length >= 3 && !STOP_EFF.has(w))
    const entity = words[0] ?? stripped.split(/\s+/)[0] ?? ''
    return entity.charAt(0).toUpperCase() + entity.slice(1)
  })()

  // ── SAFETY NET 0: Deterministic field injection for Create operations ─────
  // THE MOST CRITICAL SAFETY NET.
  // Fires when the manifest has required fields that the LLM didn't fill.
  // IMPORTANT: Does NOT fire for Update operations — Safety Net U handles those.
  // Without this guard, Safety Net 0 injects Create-flow steps (navigate to /new,
  // click "Create Account") into Update test cases, breaking them.
  const hasManifestWithFields = manifest && manifest.fields.length > 0
  const hasMissingRequiredFields = hasManifestWithFields && (() => {
    // Normalize: underscore → space so 'origin_port' ≡ 'origin port' when comparing
    const normalizeFieldLbl = (s: string) => s.toLowerCase().trim().replace(/_/g, ' ')
    const FIELD_ACTIONS_PRE = new Set(['TYPE', 'SELECT', 'LOOKUP', 'CHECKBOX', 'MULTI_SELECT'])
    const coveredTargets = new Set(
      steps.filter(s => FIELD_ACTIONS_PRE.has((s.action ?? '').toUpperCase()))
           .map(s => normalizeFieldLbl(s.target ?? ''))
    )
    return manifest!.fields.filter(f => f.required)
                           .some(f => !coveredTargets.has(normalizeFieldLbl(f.label)))
  })()

  if ((isCreateOperation || isConvertOperation) && hasManifestWithFields && !isUpdateOperation) {
    const FIELD_ACTIONS_SN0 = new Set(['TYPE', 'SELECT', 'LOOKUP', 'CHECKBOX', 'MULTI_SELECT'])
    const normalizeFL = (s: string) => s.toLowerCase().trim().replace(/_/g, ' ')
    const existingFieldSteps = steps.filter(s => FIELD_ACTIONS_SN0.has((s.action ?? '').toUpperCase()))
    const existingFieldTargets = new Set(existingFieldSteps.map(s => normalizeFL(s.target ?? '')))

    // Check: how many REQUIRED fields are already covered?
    const requiredFields = manifest.fields.filter(f => f.required)
    const requiredCoverage = requiredFields.filter(
      f => existingFieldTargets.has(normalizeFL(f.label))
    ).length

    const needsInjection = (
      existingFieldSteps.length < minimumFieldSteps ||
      (requiredFields.length > 0 && requiredCoverage < requiredFields.length)
    )

    // ── CONVERT TRIGGER SAFETY NET (runs independently of needsInjection) ──
    // For convert operations, always ensure there is a "Create Booking" (or similar) CLICK
    // step between the source-record navigation steps and the field-filling steps.
    // This check runs even when all required field steps are already present,
    // because the LLM often generates the field steps but forgets the trigger button click.
    if (isConvertOperation) {
      const hasTriggerClickSN = steps.some(s =>
        s.action.toUpperCase() === 'CLICK' &&
        /create\s+(booking|delivery|order|enquiry)|convert/i.test(s.target ?? '')
      )
      if (!hasTriggerClickSN) {
        const triggerBtnSN = (manifest?.submitButton ?? learnedButtons.submitButton) ?? `Create ${resolvedEntityFilter ?? 'Booking'}`
        // Insert trigger CLICK: find last CLICK step (source record click) and inject after it
        let lastClickIdxSN = -1
        for (let i = 0; i < steps.length; i++) {
          if (steps[i].action.toUpperCase() === 'CLICK') lastClickIdxSN = i
        }
        const triggerStepSN: AgentStep_Playwright = {
          id: '0', action: 'CLICK', target: triggerBtnSN, locator_type: 'role',
        }
        // Insert before the first field step or after last CLICK, whichever comes first
        const firstFieldIdx = steps.findIndex(s => FIELD_ACTIONS_SN0.has((s.action ?? '').toUpperCase()))
        const insertAt = firstFieldIdx > 0 ? firstFieldIdx : (lastClickIdxSN >= 0 ? lastClickIdxSN + 1 : steps.length)
        steps.splice(insertAt, 0, triggerStepSN)
        steps = steps.map((s, i) => ({ ...s, id: String(i + 1) }))
        thoughts.push(`CONVERT TRIGGER SAFETY NET: Injected missing trigger CLICK "${triggerBtnSN}" at step ${insertAt + 1}`)
        log.warn(
          { projectId: input.projectId, testName: input.testName, triggerBtn: triggerBtnSN, insertedAt: insertAt + 1 },
          '[STEP-GEN] ⚡ CONVERT TRIGGER SAFETY NET: Injected missing conversion trigger CLICK',
        )
      }
    }

    if (needsInjection) {
      thoughts.push(
        `SAFETY NET 0: Only ${existingFieldSteps.length} field steps found (need ≥${minimumFieldSteps}), ` +
        `required coverage: ${requiredCoverage}/${requiredFields.length} — INJECTING field steps from manifest`
      )
      log.warn(
        { projectId: input.projectId, testName: input.testName, existingFieldSteps: existingFieldSteps.length, requiredFields: requiredFields.length },
        '[STEP-GEN] ⚡ SAFETY NET 0: Deterministic field injection triggered',
      )

      // Build field steps from manifest
      const injectedFieldSteps: AgentStep_Playwright[] = []
      for (const field of manifest.fields) {
        // Skip fields that already have a step (normalize underscore → space for matching)
        if (existingFieldTargets.has((field.label.toLowerCase().trim().replace(/_/g, ' ')))) continue

        // Map field type to action
        let action: string
        let value: string
        switch (field.type) {
          case 'select':
            action = 'SELECT'
            value = field.options?.[0] ?? field.sampleValue ?? 'Option1'
            break
          case 'lookup': {
            action = 'LOOKUP'
            // Use real lookup values if available (prevents invented names like "John Doe")
            const realValues = realLookupValues.get(field.label)
            if (realValues && realValues.length > 0) {
              value = realValues[0]
            } else if (field.sampleValue) {
              value = field.sampleValue
            } else {
              // No real data available — skip this lookup step entirely
              // to avoid injecting a value that won't exist in the app.
              log.warn(
                { projectId: input.projectId, field: field.label },
                '[STEP-GEN] Safety Net 0: skipping LOOKUP step — no real lookup values available for field',
              )
              continue
            }
            break
          }
          case 'checkbox':
            action = 'CHECKBOX'
            value = 'true'
            break
          case 'textarea':
            action = 'TYPE'
            value = field.sampleValue ?? 'Test description for automated testing'
            break
          default:
            action = 'TYPE'
            // Generate realistic values based on field label
            // IMPORTANT: for name/title fields, always generate a unique suffix to prevent
            // duplicate-record errors at runtime. We deliberately do NOT reuse sampleValue
            // for name/title fields in Create flows — those values already exist in the app.
            const label = field.label.toLowerCase()
            const uniqueTs = String(Date.now()).slice(-4)  // 4-digit suffix for uniqueness
            if (/phone|mobile|tel/.test(label))          value = field.sampleValue ?? '+1 555-123-4567'
            else if (/email/.test(label))                value = field.sampleValue ?? `auto${uniqueTs}@autotest.com`
            else if (/date/.test(label))                 value = field.sampleValue ?? '12/31/2026'
            else if (/website|url|link/.test(label))     value = field.sampleValue ?? 'https://www.example.com'
            else if (/amount|price|cost|revenue/.test(label)) value = field.sampleValue ?? '25000.00'
            else if (/name|title/.test(label))           value = `Test ${manifest.entityName} ${uniqueTs}`  // always unique — never reuse sampleValue
            else if (/description|note|comment/.test(label)) value = field.sampleValue ?? `Automated test description ${uniqueTs}`
            else                                         value = field.sampleValue ?? `Test ${field.label} ${uniqueTs}`
            break
        }

        injectedFieldSteps.push({
          id:           '', // Will be renumbered below
          action:       action as any,
          target:       field.label,
          value,
          locator_type: field.locatorType ?? 'label',
        })
      }

      if (injectedFieldSteps.length > 0) {
        // Remove any existing field steps that are NOT in the manifest (hallucinated)
        const normalizeFL2 = (s: string) => s.toLowerCase().trim().replace(/_/g, ' ')
        const cleanedSteps = steps.filter(s => {
          if (!FIELD_ACTIONS_SN0.has((s.action ?? '').toUpperCase())) return true
          // Keep field steps that ARE in the manifest (normalize underscores)
          const target = normalizeFL2(s.target ?? '')
          return manifest.fields.some(f => normalizeFL2(f.label) === target)
        })

        if (isConvertOperation) {
          // ── CONVERT OPERATION: dedicated injection strategy ──────────────────────
          // Required structure: [NAVIGATE, TYPE search, CLICK record, CLICK trigger, ...fields, CLICK submit, ASSERT_URL, ASSERT_TEXT]
          //
          // Step 1: Ensure conversion trigger CLICK is present.
          // The trigger button on the source entity detail page is typically named "Create <TargetEntity>"
          // (e.g. "Create Booking" on the Quotation detail page) — SAME as manifest.submitButton.
          // Do NOT use manifest.openButton (that is the list-page "+New X" button).
          const triggerBtnName = (manifest?.submitButton ?? learnedButtons.submitButton) ?? `Create ${resolvedEntityFilter ?? 'Booking'}`
          const hasTriggerClick = cleanedSteps.some(s =>
            s.action.toUpperCase() === 'CLICK' &&
            /create\s+booking|create\s+\w+|convert/i.test(s.target ?? '')
          )
          if (!hasTriggerClick) {
            // Find the last CLICK step (e.g. CLICK quotation record) and insert trigger after it
            let lastClickIdx = -1
            for (let i = 0; i < cleanedSteps.length; i++) {
              if (cleanedSteps[i].action.toUpperCase() === 'CLICK') lastClickIdx = i
            }
            const triggerStep: AgentStep_Playwright = {
              id: '0', action: 'CLICK', target: triggerBtnName, locator_type: 'role',
            }
            const insertTriggerAt = lastClickIdx >= 0 ? lastClickIdx + 1 : cleanedSteps.length
            cleanedSteps.splice(insertTriggerAt, 0, triggerStep)
            thoughts.push(`SAFETY NET 0 CONVERT: Injected conversion trigger CLICK "${triggerBtnName}"`)
          }

          // Step 2: Find the position AFTER the trigger click to inject field steps
          let afterTriggerIdx = cleanedSteps.length - 1
          for (let i = 0; i < cleanedSteps.length; i++) {
            if (
              cleanedSteps[i].action.toUpperCase() === 'CLICK' &&
              /create\s+booking|create\s+\w+|convert/i.test(cleanedSteps[i].target ?? '')
            ) {
              afterTriggerIdx = i + 1
              break
            }
          }

          // Step 3: Find the first ASSERT or final submit CLICK position (inject field steps before it)
          let beforeAssertIdx = cleanedSteps.length
          for (let i = afterTriggerIdx; i < cleanedSteps.length; i++) {
            const action = cleanedSteps[i].action.toUpperCase()
            if (action.startsWith('ASSERT') || (action === 'CLICK' && /submit|save|create|confirm/i.test(cleanedSteps[i].target ?? ''))) {
              beforeAssertIdx = i
              break
            }
          }

          cleanedSteps.splice(beforeAssertIdx, 0, ...injectedFieldSteps)

          // Step 4: Ensure final submit CLICK is present before the ASSERTs
          const submitBtnName = manifest?.submitButton ?? learnedButtons.submitButton ?? `Create ${resolvedEntityFilter ?? 'Booking'}`
          const hasSubmitClick = cleanedSteps.some(s =>
            s.action.toUpperCase() === 'CLICK' &&
            /create\s+booking|submit|save|confirm/i.test(s.target ?? '') &&
            cleanedSteps.indexOf(s) > beforeAssertIdx   // must come AFTER the fields
          )
          if (!hasSubmitClick) {
            let firstAssertIdx = cleanedSteps.length
            for (let i = beforeAssertIdx + injectedFieldSteps.length; i < cleanedSteps.length; i++) {
              if (cleanedSteps[i].action.toUpperCase().startsWith('ASSERT')) {
                firstAssertIdx = i
                break
              }
            }
            const submitStep: AgentStep_Playwright = {
              id: '0', action: 'CLICK', target: submitBtnName, locator_type: 'role',
            }
            cleanedSteps.splice(firstAssertIdx, 0, submitStep)
            thoughts.push(`SAFETY NET 0 CONVERT: Injected final submit CLICK "${submitBtnName}"`)
          }

        } else {
          // ── CREATE / EDIT OPERATION: original insertion strategy ──────────────────
          let navigateIdx = -1
          for (let i = steps.length - 1; i >= 0; i--) {
            if ((steps[i].action ?? '').toUpperCase() === 'NAVIGATE') { navigateIdx = i; break }
          }

          // Find insertion point in cleaned steps (before submit or assert)
          const insertIdx = cleanedSteps.findIndex(s => {
            const a = (s.action ?? '').toUpperCase()
            if (a === 'CLICK') {
              const t = (s.target ?? '').toLowerCase()
              return /\b(create|save|submit|add|new|update|confirm)\b/.test(t)
            }
            return a === 'ASSERT_URL' || a === 'ASSERT_TEXT' || a === 'ASSERT_TOAST'
          })

          if (insertIdx > 0) {
            cleanedSteps.splice(insertIdx, 0, ...injectedFieldSteps)
          } else if (navigateIdx >= 0) {
            cleanedSteps.splice(navigateIdx + 1, 0, ...injectedFieldSteps)
          } else {
            // Last resort: append before the last step (typically ASSERT)
            const lastIdx = cleanedSteps.length > 1 ? cleanedSteps.length - 1 : cleanedSteps.length
            cleanedSteps.splice(lastIdx, 0, ...injectedFieldSteps)
          }
        }

        steps = cleanedSteps.map((s, i) => ({ ...s, id: String(i + 1) }))
        thoughts.push(`SAFETY NET 0: injected ${injectedFieldSteps.length} field steps from manifest`)
        log.info(
          { injected: injectedFieldSteps.length, totalSteps: steps.length },
          '[STEP-GEN] ✅ SAFETY NET 0: Field steps injected successfully',
        )

        // Re-run validation after injection
        const entityHintRe = effectiveEntityHint || input.entityFilter || ''
        const testNameRe = isConvertOperation
          ? input.testName
          : isCreateOperation
            ? `create ${entityHintRe}`
            : entityHintRe
        validation = validateSteps(
          steps,
          manifest.requiredCount ?? 0,
          urlMap.paths,
          manifest.submitButton,
          manifest.allButtons,
          manifest.fields,
          testNameRe,
          minimumFieldSteps,
        )
        thoughts.push(`SAFETY NET 0: re-validation ${validation.passed ? '✅ PASSED' : '❌ still failing'} — ${validation.issues.join('; ')}`)
      }
    }
  }

  // ── SAFETY NET P: Create operation placeholder replacement + step reordering ─
  // Fires for Create/Add test cases to fix two common LLM failures:
  //   1. Placeholder values like "-", "N/A", bare numbers for URL fields
  //   2. Wrong step ordering: field steps before the "open form" CLICK button
  if (isCreateOperation && !isUpdateOperation && steps.length > 0) {
    thoughts.push('SAFETY NET P: checking Create operation step values and ordering')

    // ── P.1: Replace placeholder/invalid values with realistic data ───────
    const PLACEHOLDER_SNP = /^[-–—.?!_*#@~`\/\\]+$/
    const NA_SNP = /^n\/?a$/i
    const PURE_NUM_SNP = /^\d{5,}$/
    let replacedP = 0
    for (const s of steps) {
      const action = (s.action ?? '').toUpperCase()
      if (!['TYPE', 'SELECT', 'LOOKUP'].includes(action)) continue
      const value = (s.value ?? '').trim()
      const fieldLabelP = (s.target ?? '').toLowerCase().trim()

      // Detect bad value: placeholder, N/A, or a pure number on a URL/phone field
      const isPureBadPlaceholder = !value || value.length < 2 || PLACEHOLDER_SNP.test(value) || NA_SNP.test(value)
      const isPureNumberOnUrl = PURE_NUM_SNP.test(value) && /website|url|link|homepage/i.test(fieldLabelP)
      const isPureNumberOnPhone = PURE_NUM_SNP.test(value) && /phone|mobile|tel/.test(fieldLabelP) && !value.startsWith('+')

      if (!isPureBadPlaceholder && !isPureNumberOnUrl && !isPureNumberOnPhone) continue

      // Find matching manifest field for proper replacement
      const manifestFieldP = manifest?.fields.find(f => f.label.toLowerCase().trim() === fieldLabelP)
      if (manifestFieldP) {
        if (manifestFieldP.options?.length) {
          s.value = manifestFieldP.options[0]
        } else if (manifestFieldP.sampleValue && !PLACEHOLDER_SNP.test(manifestFieldP.sampleValue) && !PURE_NUM_SNP.test(manifestFieldP.sampleValue)) {
          s.value = manifestFieldP.sampleValue
        } else {
          // Generate realistic value by field label pattern
          const lbl = manifestFieldP.label.toLowerCase()
          if (/phone|mobile|tel/.test(lbl))           s.value = '+1 555-123-4567'
          else if (/email/.test(lbl))                 s.value = 'contact@example.com'
          else if (/date/.test(lbl))                  s.value = '12/31/2026'
          else if (/website|url|link|homepage/i.test(lbl)) s.value = 'https://www.example.com'
          else if (/amount|price|cost|revenue/.test(lbl))  s.value = '25000.00'
          else if (/name|title/.test(lbl))            s.value = `Test ${manifest?.entityName ?? 'Record'} ${Date.now() % 9000 + 1000}`
          else if (/description|note|comment/.test(lbl)) s.value = 'Automated test data — valid description'
          else if (/industry|sector|vertical/i.test(lbl)) s.value = manifestFieldP.options?.[0] ?? 'Technology'
          else                                         s.value = `Test ${manifestFieldP.label}`
        }
        replacedP++
        log.info(
          { field: s.target, oldValue: value, newValue: s.value },
          '[STEP-GEN] ⚡ SAFETY NET P: replaced placeholder/invalid value with realistic data',
        )
      } else {
        // No manifest field found — apply label-based heuristic
        const lbl = fieldLabelP
        if (/phone|mobile|tel/.test(lbl))           s.value = '+1 555-123-4567'
        else if (/email/.test(lbl))                 s.value = 'contact@example.com'
        else if (/website|url|link|homepage/i.test(lbl)) s.value = 'https://www.example.com'
        else if (/industry|sector|vertical/i.test(lbl)) s.value = 'Technology'
        else if (isPureBadPlaceholder)               s.value = `Test ${s.target ?? 'Value'}`
        replacedP++
      }
    }
    if (replacedP > 0) {
      thoughts.push(`SAFETY NET P: replaced ${replacedP} invalid/placeholder value(s) with realistic data`)
    }

    // ── P.2: Fix step ordering — "open form" CLICK must precede field steps ─
    // Correct Create flow: NAVIGATE → CLICK (open form) → TYPE/SELECT/LOOKUP... → CLICK (submit) → ASSERT
    // The LLM sometimes outputs: NAVIGATE → TYPE → SELECT → CLICK (open form) → CLICK (submit) — WRONG.
    //
    // Strategy: find the "open form" CLICK step (a CLICK whose target matches the
    // open-button pattern and appears AFTER the first field step) and move it to
    // immediately after the last NAVIGATE step.
    const FIELD_ACTIONS_SNP = new Set(['TYPE', 'SELECT', 'LOOKUP', 'CHECKBOX', 'MULTI_SELECT'])
    const SUBMIT_RE = /\b(create|save|submit|confirm|done|finish)\b/i
    const OPEN_FORM_RE = /\b(new|add|open|create)\b/i

    const firstFieldStepIdx = steps.findIndex(s => FIELD_ACTIONS_SNP.has((s.action ?? '').toUpperCase()))
    if (firstFieldStepIdx > 0) {
      // Look for a CLICK step after the first field step whose target is NOT a submit button
      // and looks like an "open form" button (contains "new", "add", etc.)
      const openFormClickIdx = steps.findIndex((s, idx) => {
        if (idx <= firstFieldStepIdx) return false  // only look AFTER first field step
        if ((s.action ?? '').toUpperCase() !== 'CLICK') return false
        const target = (s.target ?? '').toLowerCase()
        // Must look like "open form" and NOT like a "submit/save/create" final-step
        return OPEN_FORM_RE.test(target) && !SUBMIT_RE.test(target)
      })

      // Also check: is there a CLICK before the first field step that's supposed to be the open-form?
      // If NOT, check for any nav-section CLICK that should actually be BEFORE fields
      const lastNavIdx = (() => {
        let idx = -1
        for (let i = 0; i < steps.length; i++) {
          if ((steps[i].action ?? '').toUpperCase() === 'NAVIGATE') idx = i
        }
        return idx
      })()

      if (openFormClickIdx > firstFieldStepIdx) {
        // The "open form" CLICK is misplaced — move it to after the last NAVIGATE
        const [openFormStep] = steps.splice(openFormClickIdx, 1)
        const insertAt = lastNavIdx >= 0 ? lastNavIdx + 1 : 0
        steps.splice(insertAt, 0, openFormStep)
        steps = steps.map((s, i) => ({ ...s, id: String(i + 1) }))
        thoughts.push(
          `SAFETY NET P: reordered — moved "open form" CLICK ("${openFormStep.target}") ` +
          `from step ${openFormClickIdx + 1} to step ${insertAt + 1} (before field-filling steps)`
        )
        log.info(
          { openFormTarget: openFormStep.target, fromIdx: openFormClickIdx, toIdx: insertAt },
          '[STEP-GEN] ⚡ SAFETY NET P: moved "open form" CLICK before field steps',
        )
      }
    }
  }

  // ── SAFETY NET U: Deterministic Update operation workflow injection ────────
  // Fires for Update/Edit test cases when the LLM fails to include proper
  // record selection steps. Injects: NAVIGATE to list → CLICK record → CLICK Edit
  // Also replaces placeholder values (like "-") with realistic data from manifest.
  if (isUpdateOperation && steps.length > 0) {
    thoughts.push('SAFETY NET U: checking Update operation workflow integrity')

    // 1. Replace placeholder values with realistic data
    const PLACEHOLDER_SNU = /^[-–—.?!_*#@~`\/\\]+$/
    const NA_SNU = /^n\/?a$/i
    let replacedValues = 0
    for (const s of steps) {
      const action = (s.action ?? '').toUpperCase()
      if (!['TYPE', 'SELECT', 'LOOKUP'].includes(action)) continue
      const value = (s.value ?? '').trim()
      if (!value || value.length < 2 || PLACEHOLDER_SNU.test(value) || NA_SNU.test(value)) {
        // Find a replacement from manifest
        const fieldLabel = (s.target ?? '').toLowerCase().trim()
        const manifestField = manifest?.fields.find(f => f.label.toLowerCase().trim() === fieldLabel)
        if (manifestField) {
          if (manifestField.options?.length) {
            s.value = manifestField.options[0]
          } else if (manifestField.sampleValue) {
            s.value = manifestField.sampleValue
          } else {
            // Generate realistic value based on field type
            const label = manifestField.label.toLowerCase()
            if (/phone|mobile|tel/.test(label))          s.value = '+1 555-987-6543'
            else if (/email/.test(label))                s.value = 'updated@autotest.com'
            else if (/date/.test(label))                 s.value = '12/31/2026'
            else if (/website|url|link/.test(label))     s.value = 'https://www.updated-example.com'
            else if (/amount|price|cost|revenue/.test(label)) s.value = '50000.00'
            else if (/name|title/.test(label))           s.value = `Updated ${effectiveEntityHint} ${Date.now() % 10000}`
            else if (/description|note|comment/.test(label)) s.value = 'Updated via automated test'
            else                                         s.value = `Updated ${manifestField.label}`
          }
          replacedValues++
        }
      }
    }
    if (replacedValues > 0) {
      thoughts.push(`SAFETY NET U: replaced ${replacedValues} placeholder value(s) with realistic data`)
      log.info(
        { projectId: input.projectId, testName: input.testName, replacedValues },
        '[STEP-GEN] ⚡ SAFETY NET U: replaced placeholder values',
      )
    }

    // 2. Fix NAVIGATE steps that point to create/new page instead of list page
    // The LLM may navigate to /account/new because that's the CREATE URL in the manifest.
    // For Update operations, we need to navigate to the list page instead.
    // IMPORTANT: NAVIGATE action uses the 'value' field (not 'target') for the URL.
    const CREATE_URL_RE_SNU = /\/(new|create|add)(\?|\/|$)/i
    for (const s of steps) {
      if ((s.action ?? '').toUpperCase() === 'NAVIGATE') {
        // Check both 'value' (primary) and 'target' (legacy) for the URL
        const urlVal = (s.value ?? s.target ?? '').trim()
        if (urlVal && CREATE_URL_RE_SNU.test(urlVal)) {
          const listUrl = urlVal.replace(/\/?(new|create|add)(\?.*)?$/i, '').replace(/\/$/, '') || '/'
          const listUrlNorm = listUrl.startsWith('/') ? listUrl : `/${listUrl}`
          if (s.value !== undefined) s.value = listUrlNorm
          if (s.target !== undefined && s.target !== s.value) s.target = listUrlNorm
          thoughts.push(`SAFETY NET U: fixed NAVIGATE from create URL "${urlVal}" → list URL "${listUrlNorm}"`)
          log.warn(
            { projectId: input.projectId, testName: input.testName, originalUrl: urlVal, listUrl: listUrlNorm },
            '[STEP-GEN] ⚡ SAFETY NET U: redirected NAVIGATE from create/new URL to list page for Update test',
          )
          // Ensure the corrected list URL is in the URL map so Check 2 passes
          if (listUrlNorm && !urlMap.paths.some(p => p === listUrlNorm || listUrlNorm.startsWith(p))) {
            urlMap.paths.push(listUrlNorm)
          }
        }
      }
    }

    // 2b. Detect and strip Create-flow steps injected into an Update test
    // The LLM sometimes generates a full Create flow (navigate to /new, click "Create Account",
    // TYPE into create form) for Update tests. Identify this by looking for a CLICK on a
    // "create/new <entity>" button — this should NEVER appear in an Update operation.
    // Strip such create-flow buttons and replace with a proper save/update button.
    const CREATE_FLOW_BTN_RE_SNU = /\b(create|\+\s*new)\s+\w+/i
    const beforeStrip = steps.length
    steps = steps.filter(s => {
      if ((s.action ?? '').toUpperCase() !== 'CLICK') return true
      const target = (s.target ?? '').trim()
      if (CREATE_FLOW_BTN_RE_SNU.test(target)) {
        log.warn(
          { projectId: input.projectId, target },
          '[STEP-GEN] ⚡ SAFETY NET U 2b: stripped Create-flow button from Update test',
        )
        thoughts.push(`SAFETY NET U 2b: stripped Create-flow button "${target}" — this is an Update test, not Create`)
        return false
      }
      return true
    })
    if (steps.length < beforeStrip) {
      steps = steps.map((s, i) => ({ ...s, id: String(i + 1) }))
    }

    // 2c. Remove form field steps that appear BEFORE any record-selection CLICK
    // (i.e., field steps on the list page, where there is no open record yet)
    // IMPORTANT: Search TYPE steps (target matches search|filter|find) are PRESERVED.
    {
      const FIELD_ACTIONS_2C = new Set(['TYPE', 'SELECT', 'LOOKUP', 'CHECKBOX', 'MULTI_SELECT'])
      const SEARCH_BOX_RE_2C = /search|filter|find|query/i
      const NAV_LINK_RE_2C   = /^role=(link|menuitem|tab)/i
      const CREATE_BTN_RE_2C = /\b(create|\+\s*new|new)\s+\w/i
      const EDIT_BTN_RE_2C   = /\bedit\b|\bmodify\b/i

      // Find the first record-selection CLICK: NOT nav link, NOT create button, NOT Edit button
      const firstRecordClickIdx = steps.findIndex(s => {
        if ((s.action ?? '').toUpperCase() !== 'CLICK') return false
        const target = (s.target ?? '').trim()
        if (NAV_LINK_RE_2C.test(target)) return false
        if (CREATE_BTN_RE_2C.test(target)) return false
        if (EDIT_BTN_RE_2C.test(target)) return false  // Edit btn is NOT record selection
        return true
      })

      if (firstRecordClickIdx < 0) {
        // No record-selection CLICK found — strip orphaned field steps EXCEPT search steps
        const beforeC = steps.length
        steps = steps.filter(s => {
          if (!FIELD_ACTIONS_2C.has((s.action ?? '').toUpperCase())) return true
          // Preserve search TYPE steps — valid even before a record is selected
          if ((s.action ?? '').toUpperCase() === 'TYPE' && SEARCH_BOX_RE_2C.test(s.target ?? '')) return true
          return false
        })
        if (steps.length < beforeC) {
          steps = steps.map((s, i) => ({ ...s, id: String(i + 1) }))
          thoughts.push(`SAFETY NET U 2c: stripped ${beforeC - steps.length} orphaned field steps (search steps preserved)`)
          log.warn(
            { projectId: input.projectId, stripped: beforeC - steps.length },
            '[STEP-GEN] ⚡ SAFETY NET U 2c: stripped orphaned field steps (no record selection)',
          )
        }
      }
    }

    // 3. Verify and inject the full Update workflow: search → record click → Edit → field edits
    // Entity-agnostic: works for Account, Lead, Contact, Opportunity, etc.
    const FIELD_ACTIONS_SNU = new Set(['TYPE', 'SELECT', 'LOOKUP', 'CHECKBOX', 'MULTI_SELECT'])
    const SEARCH_BOX_RE_SNU = /search|filter|find|query/i
    const NAV_LINK_RE_SNU   = /^role=(link|menuitem|tab)/i
    const CREATE_BTN_RE_SNU = /\b(create|\+\s*new|new)\s+\w/i
    // Wide match: "Edit", "Edit Account", "Edit Lead", "✏️ Edit"
    const EDIT_BTN_RE_SNU   = /\bedit\b|\bmodify\b/i

    // Find the first TRUE field-edit step (excludes search TYPE steps)
    const firstFieldIdx = steps.findIndex(s => {
      if (!FIELD_ACTIONS_SNU.has((s.action ?? '').toUpperCase())) return false
      if ((s.action ?? '').toUpperCase() === 'TYPE' && SEARCH_BOX_RE_SNU.test(s.target ?? '')) return false
      return true
    })

    // Resolve real record name (multi-source, entity-agnostic)
    const resolveRecordName = (): string => {
      // Priority 1: sampleTestData from web_test_data for the entity being tested
      // This contains REAL existing records in the application
      if (sampleTestData) {
        // Try multiple key patterns to find the record's display name
        const nameKey = Object.keys(sampleTestData).find(k =>
          /^(name|full.?name|display.?name|title|label|account.?name|contact.?name|lead.?name|company.?name|subject|first.?name)$/i.test(k)
        )
        // Also try: any key that ends with 'name'
        const nameKeyFallback = !nameKey
          ? Object.keys(sampleTestData).find(k => /name$/i.test(k) && !/id$/i.test(k))
          : undefined
        const resolvedKey = nameKey ?? nameKeyFallback
        const nameVal = resolvedKey ? String(sampleTestData[resolvedKey] ?? '') : ''
        if (nameVal && nameVal.length > 0 && nameVal.length < 100) return nameVal

        // Priority 1b: Domain-specific identifier keys — bl_number, number, reference, code, etc.
        // (common in logistics/freight/supply-chain apps where records have no generic "name" key)
        const idKey = Object.keys(sampleTestData).find(k =>
          /^(bl[_\s]?number|bl[_\s]?no|bl[_\s]?ref|booking[_\s]?number|booking[_\s]?ref|invoice[_\s]?number|order[_\s]?number|reference[_\s]?number|ref[_\s]?no|doc[_\s]?number|document[_\s]?number|quotation[_\s]?number|quote[_\s]?number|delivery[_\s]?number|shipment[_\s]?number|number|reference|code|identifier)$/i.test(k)
        )
        const idVal = idKey ? String(sampleTestData[idKey] ?? '') : ''
        if (idVal && idVal.length > 0 && idVal.length < 100) return idVal
      }
      // Priority 2: real lookup values already fetched for lookup fields
      if (realLookupValues.size > 0) {
        const first = [...realLookupValues.values()][0]
        if (first?.length) return first[0]
      }
      // Priority 3: fallback — may not exist in app, but better than empty
      return entityRecordFallback
    }

    if (firstFieldIdx >= 0) {
      const stepsBeforeField = steps.slice(0, firstFieldIdx)

      const recordSelectionClicks = stepsBeforeField.filter(s => {
        if ((s.action ?? '').toUpperCase() !== 'CLICK') return false
        const t = (s.target ?? '').trim()
        if (NAV_LINK_RE_SNU.test(t)) return false
        if (CREATE_BTN_RE_SNU.test(t)) return false
        if (EDIT_BTN_RE_SNU.test(t)) return false  // Edit btn ≠ record selection
        return true
      })
      const hasSearchStep = stepsBeforeField.some(s =>
        (s.action ?? '').toUpperCase() === 'TYPE' && SEARCH_BOX_RE_SNU.test(s.target ?? '')
      )
      const hasEditClick = stepsBeforeField.some(s =>
        (s.action ?? '').toUpperCase() === 'CLICK' && EDIT_BTN_RE_SNU.test(s.target ?? '')
      )

      const missingRecordClick = recordSelectionClicks.length === 0
      const missingSearch      = !hasSearchStep
      const missingEdit        = !hasEditClick

      if (missingRecordClick || missingSearch || missingEdit) {
        thoughts.push(
          `SAFETY NET U: missing steps — ` +
          `search: ${hasSearchStep ? '✅' : '❌'}, ` +
          `record click: ${!missingRecordClick ? '✅' : '❌'}, ` +
          `Edit click: ${hasEditClick ? '✅' : '❌'} — injecting`
        )

        const existingRecordName = resolveRecordName()
        const injectedSteps: AgentStep_Playwright[] = []

        if (missingSearch) {
          injectedSteps.push({
            id: '', action: 'TYPE' as any,
            target: resolvedSearchHint,
            value:  existingRecordName,
            locator_type: 'placeholder',
          })
        }

        if (missingRecordClick) {
          injectedSteps.push({
            id: '', action: 'CLICK' as any,
            target: existingRecordName,
            value: '',
            locator_type: 'text',
          })
        }

        if (missingEdit) {
          injectedSteps.push({
            id: '', action: 'CLICK' as any,
            target: resolvedEditButton,
            value: '',
            locator_type: 'role',
          })
        }

        if (injectedSteps.length > 0) {
          let insertIdx = 0
          for (let i = firstFieldIdx - 1; i >= 0; i--) {
            if ((steps[i].action ?? '').toUpperCase() === 'NAVIGATE') { insertIdx = i + 1; break }
          }
          while (
            insertIdx < steps.length &&
            (steps[insertIdx].action ?? '').toUpperCase() === 'TYPE' &&
            SEARCH_BOX_RE_SNU.test(steps[insertIdx].target ?? '')
          ) { insertIdx++ }

          steps.splice(insertIdx, 0, ...injectedSteps)
          steps = steps.map((s, i) => ({ ...s, id: String(i + 1) }))

          log.info(
            { projectId: input.projectId, entity: effectiveEntityHint, existingRecordName, editBtn: resolvedEditButton, injected: injectedSteps.length },
            '[STEP-GEN] ✅ SAFETY NET U: injected missing steps for Update operation',
          )
          thoughts.push(
            `SAFETY NET U: injected ${injectedSteps.length} step(s) for entity "${effectiveEntityHint}" — ` +
            `search("${resolvedSearchHint}"): ${missingSearch ? 'added' : 'present'}, ` +
            `record click("${existingRecordName}"): ${missingRecordClick ? 'added' : 'present'}, ` +
            `Edit("${resolvedEditButton}"): ${missingEdit ? 'added' : 'present'}`
          )
        }
      }
    } else {
      log.warn(
        { projectId: input.projectId, testName: input.testName, entity: effectiveEntityHint },
        '[STEP-GEN] ⚠️ SAFETY NET U: no field-edit steps found in Update test — may need more context',
      )
      thoughts.push(
        `SAFETY NET U: WARNING — no field-edit steps found for entity "${effectiveEntityHint}"; ` +
        `check that the manifest has at least 1 field and that the test name says "Update" or "Edit"`
      )
    }

    // Re-run validation after Update safety net
    const entityHintReU = effectiveEntityHint || input.entityFilter || ''
    const testNameReU = `update ${entityHintReU}`
    validation = validateSteps(
      steps,
      manifest?.requiredCount ?? 0,
      urlMap.paths,
      manifest?.submitButton,
      manifest?.allButtons,
      manifest?.fields,
      testNameReU,
      minimumFieldSteps,
    )
    thoughts.push(`SAFETY NET U: re-validation ${validation.passed ? '✅ PASSED' : '❌ still failing'} — ${validation.issues.join('; ')}`)
  }

  // ── Safety net: forcefully strip hallucinated field steps ─────────────────
  // IMPORTANT: Only run this safety net when validation FAILED after all loops.
  // If validation PASSED, Check 7 (hallucination guard) already verified that
  // every field step target exists in the manifest — running Safety Net 1 again
  // would redundantly strip those verified steps and break Create operations.
  //
  // When validation FAILED, we still strip to avoid sending bad data to the DB.
  if (!validation.passed && manifest && manifest.fields.length > 0 && steps.length > 0) {
    // Normalize: strip trailing asterisks, '(required)' etc. from both manifest and step targets
    const normLabel = (s: string) =>
      s.toLowerCase().replace(/\s*\*+\s*$/, '').replace(/\s*\(required\)\s*$/i, '').replace(/\s*required\s*$/i, '').trim()
    const knownFields = new Set(manifest.fields.map(f => normLabel(f.label)))
    const FIELD_ACTIONS = new Set(['TYPE', 'SELECT', 'LOOKUP', 'CHECKBOX', 'MULTI_SELECT'])
    const beforeCount = steps.length

    steps = steps.filter(s => {
      if (!FIELD_ACTIONS.has((s.action ?? '').toUpperCase())) return true  // keep non-field steps
      const target = (s.target ?? '').trim()
      if (!target) return true
      if (knownFields.has(normLabel(target))) return true  // field exists in manifest
      // Field NOT in manifest → strip it
      return false
    })


    if (steps.length < beforeCount) {
      const stripped = beforeCount - steps.length
      // Renumber remaining steps
      steps = steps.map((s, i) => ({ ...s, id: String(i + 1) }))
      log.warn(
        { projectId: input.projectId, testName: input.testName, stripped, remaining: steps.length },
        `[STEP-GEN] ⚠️ Safety net: forcefully stripped ${stripped} hallucinated field step(s)`,
      )
      thoughts.push(`SAFETY NET: forcefully stripped ${stripped} hallucinated field step(s) not in manifest`)

      // Guard: if stripping violated the minimum field step requirement for a
      // Create operation, warn loudly so the issue is surfaced in logs/HITL.
      const remainingFieldSteps = steps.filter(s => FIELD_ACTIONS.has((s.action ?? '').toUpperCase())).length
      if (isCreateOperation && remainingFieldSteps < minimumFieldSteps) {
        log.warn(
          { projectId: input.projectId, testName: input.testName, remainingFieldSteps, minimumFieldSteps },
          `[STEP-GEN] ⚠️ Safety net stripped field steps below minimum (${remainingFieldSteps} < ${minimumFieldSteps}) — manifest may be incomplete for this entity`,
        )
        thoughts.push(
          `SAFETY NET WARNING: only ${remainingFieldSteps} field step(s) remain after stripping — ` +
          `manifest may lack form fields for this entity; consider re-crawling`,
        )
      }
    }
  } else if (validation.passed) {
    thoughts.push('SAFETY NET 1: skipped — validation passed; Check 7 already verified field-step targets against manifest')
  }

  // ── Safety net 2: forcefully strip cross-entity CLICK buttons ────────────
  // Catches CLICK steps like "+ New Lead" in a test for "Account".
  // The sidebar/nav often lists buttons for ALL entities; the LLM picks the
  // wrong one even after Check 3b correction hints.
  // (effectiveEntityHint already declared above before Safety Net 0)

  if (effectiveEntityHint && effectiveEntityHint.length > 2 && steps.length > 0) {
    const entityLower = effectiveEntityHint.toLowerCase()
    // For convert operations, also exempt CLICKs referencing the TARGET entity (resolvedEntityFilter)
    // e.g. "Create Booking" is NOT a cross-entity step — it is the conversion trigger on the Quotation detail page.
    const targetEntityLower = (isConvertOperation && resolvedEntityFilter)
      ? resolvedEntityFilter.toLowerCase()
      : null
    const beforeClickCount = steps.length

    steps = steps.filter(s => {
      if ((s.action ?? '').toUpperCase() !== 'CLICK') return true
      const target = (s.target ?? '').toLowerCase().trim()
      if (!target) return true

      // Detect "new/create/add <entity>" pattern
      const match = target.match(/\b(?:new|create|add)\s+([a-z]+(?:\s+[a-z]+)?)\b/)
      if (!match) return true
      const entityWord = match[1].trim()
      if (entityWord.length < 3 || ['the', 'a', 'an', 'new', 'all', 'item', 'record', 'entry'].includes(entityWord)) return true
      // Keep if it matches the correct source entity
      if (entityLower.includes(entityWord) || entityWord.includes(entityLower)) return true
      // For CONVERT operations: also keep CLICKs referencing the TARGET entity
      // (e.g. "Create Booking" on a Quotation test is the conversion trigger — NOT a cross-entity step)
      if (targetEntityLower && (targetEntityLower.includes(entityWord) || entityWord.includes(targetEntityLower))) return true
      // Cross-entity → strip
      return false
    })

    if (steps.length < beforeClickCount) {
      const stripped = beforeClickCount - steps.length
      steps = steps.map((s, i) => ({ ...s, id: String(i + 1) }))
      log.warn(
        { projectId: input.projectId, testName: input.testName, entity: effectiveEntityHint, stripped },
        `[STEP-GEN] ⚠️ Safety net 2: stripped ${stripped} cross-entity CLICK step(s)`,
      )
      thoughts.push(`SAFETY NET 2: stripped ${stripped} cross-entity CLICK step(s) targeting wrong entity`)
    }
  }

  // ── Safety net 3: force-correct wrong button names ──────────────────────
  // Uses the centralized autoCorrectButtonNames() which independently loads
  // the manifest (even if the agent's own manifest loading failed) and
  // deterministically replaces LLM-invented button names with the real one.
  // ENHANCED: Also checks learning registry for confirmed button names.
  // For CONVERT operations, use the TARGET entity (resolvedEntityFilter) as the hint so that
  // "Create Booking" is NOT replaced with "Create Quotation". The correct submit button is
  // the target entity's, not the source entity's.
  if (steps.length > 0) {
    const stepsAsRecords = steps as unknown as Array<Record<string, any>>
    const correctionEntityHint = (isConvertOperation && resolvedEntityFilter)
      ? resolvedEntityFilter
      : effectiveEntityHint
    await autoCorrectButtonNames(stepsAsRecords, input.projectId, correctionEntityHint)
    steps = stepsAsRecords as unknown as AgentStep_Playwright[]
    thoughts.push('SAFETY NET 3: ran centralized button name auto-correction (metadata + learning registry)')
  }

  // ── SAFETY NET F: Strip hallucinated filter-panel steps ──────────────────
  // For Search/Filter operations, the LLM sometimes hallucinates:
  //   - CLICK "Filter" (a button that doesn't exist as a standalone control)
  //   - SELECT from a Status/Type dropdown inside an imaginary filter panel
  //   - CLICK "Create Filter" / "Apply Filter" / "Save Filter"
  // This safety net strips those steps deterministically.
  // It also covers cases where isSearchOperation is false but a non-search test
  // somehow ends up with filter-panel hallucinations (defense in depth).
  if (isSearchOperation && steps.length > 0) {
    thoughts.push('SAFETY NET F: checking Search/Filter operation for hallucinated filter-panel steps')

    // Patterns that indicate hallucinated filter-panel interaction
    const FILTER_PANEL_BTN_RE = /^(filter|apply\s*filter|create\s*filter|save\s*filter|reset\s*filter|clear\s*filter|filter\s*results|add\s*filter)$/i
    // Patterns for hallucinated filter-panel SELECT steps (Status/Type dropdown inside a non-existent panel)
    // NOTE: We only strip bare "Status" / "Type" SELECT steps — not ones targeting real field labels in the manifest
    const manifestFieldLabels = new Set((manifest?.fields ?? []).map(f => f.label.toLowerCase().trim()))
    const FILTER_PANEL_SELECT_RE = /^(status|type|category|stage|priority|filter\s*by)$/i

    const beforeF = steps.length
    steps = steps.filter(s => {
      const action = (s.action ?? '').toUpperCase()
      const target = (s.target ?? '').trim()
      const targetLower = target.toLowerCase()

      // Strip hallucinated CLICK on a bare "Filter" button or "Create/Apply/Save Filter"
      if (action === 'CLICK' && FILTER_PANEL_BTN_RE.test(target)) {
        log.warn(
          { projectId: input.projectId, target },
          '[STEP-GEN] ⚡ SAFETY NET F: stripped hallucinated filter-panel CLICK',
        )
        thoughts.push(`SAFETY NET F: stripped hallucinated filter-panel CLICK — target: "${target}"`)
        return false
      }

      // Strip hallucinated SELECT steps on filter-panel dropdowns (e.g. SELECT "Status" with value "New")
      // Only strip if the target is not a real manifest field (to avoid stripping valid create/update selects)
      if (action === 'SELECT' && FILTER_PANEL_SELECT_RE.test(target) && !manifestFieldLabels.has(targetLower)) {
        log.warn(
          { projectId: input.projectId, target },
          '[STEP-GEN] ⚡ SAFETY NET F: stripped hallucinated filter-panel SELECT',
        )
        thoughts.push(`SAFETY NET F: stripped hallucinated filter SELECT — target: "${target}"`)
        return false
      }

      return true
    })

    if (steps.length < beforeF) {
      const stripped = beforeF - steps.length
      steps = steps.map((s, i) => ({ ...s, id: String(i + 1) }))
      log.info(
        { projectId: input.projectId, testName: input.testName, stripped },
        `[STEP-GEN] ✅ SAFETY NET F: stripped ${stripped} hallucinated filter-panel step(s)`,
      )
      thoughts.push(`SAFETY NET F: ✅ stripped ${stripped} hallucinated filter-panel step(s) — Search/Filter test is now clean`)
    } else {
      thoughts.push('SAFETY NET F: no hallucinated filter-panel steps detected')
    }
  }

  // ── DELIVER ───────────────────────────────────────────────────────────────

  // Final validation pass: re-validate the cleaned-up steps after ALL safety nets have run.
  // This ensures the final validation.issues reflect only real remaining problems,
  // not issues that safety nets already fixed (e.g., stripped hallucinated fields).
  if (steps.length > 0) {
    const entityHintFinal = effectiveEntityHint || input.entityFilter || ''
    const testNameFinal = isConvertOperation
      ? input.testName
      : isCreateOperation
        ? `create ${entityHintFinal}`
        : isUpdateOperation
          ? `update ${entityHintFinal}`
          : entityHintFinal
    const finalValidation = validateSteps(
      steps,
      manifest?.requiredCount ?? 0,
      urlMap.paths,
      manifest?.submitButton,
      manifest?.allButtons,
      manifest?.fields,
      testNameFinal,
      minimumFieldSteps,
    )
    // Only use the final re-validation if it improved the result (fewer issues or passed)
    if (finalValidation.issues.length < validation.issues.length || finalValidation.passed) {
      validation = finalValidation
      thoughts.push(`FINAL VALIDATION: re-validated after all safety nets — ${finalValidation.passed ? '✅ PASSED' : `❌ ${finalValidation.issues.length} remaining issues`}`)
    }
  }

  const confidence = validation.passed ? 0.95 - (loopCount - 1) * 0.1 : 0.4
  thoughts.push(`DELIVER: ${steps.length} steps, confidence: ${confidence}`)

  // ── LEARNING LOOP: record generation outcome for future prompt injection ──
  const outcomeEntity = entityHintForLearnings || input.entityFilter || 'unknown'
  saveGenerationOutcome(input.projectId, input.testCaseId ?? 'unknown', {
    testName:       input.testName,
    entityName:     outcomeEntity,
    passed:         validation.passed,
    failureReasons: validation.issues,
    stepCount:      steps.length,
  }).catch(() => { /* non-fatal */ })

  await logAgentExecution({
    projectId:     input.projectId,
    agentName:     'test-step-generator',
    taskType:      'generate_steps',
    inputSummary:  { testName: input.testName, entityFilter: input.entityFilter },
    outputSummary: { stepCount: steps.length, loopCount, passed: validation.passed },
    thoughts,
    hitlInvoked:   !validation.passed,
    confidence,
    tokensUsed:    0,
    durationMs:    Date.now() - startMs,
  })

  log.info(
    { testName: input.testName, steps: steps.length, loopCount, confidence, passed: validation.passed },
    '[STEP-GEN] Done',
  )

  return { steps, validation, thoughts, loopCount, confidence }
}
