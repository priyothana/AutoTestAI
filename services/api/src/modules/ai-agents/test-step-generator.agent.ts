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
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { StringOutputParser }    from '@langchain/core/output_parsers'
import { v4 as uuidv4 }          from 'uuid'

import { createModuleLogger }    from '../../shared/logger/index.js'
import { ragSearchTool }         from './tools/rag-search.tool.js'
import { buildFieldManifest, buildUrlMap, formatManifestForPrompt, autoCorrectButtonNames } from './tools/metadata-reader.tool.js'
import { getTestCaseById, logAgentExecution } from './tools/db-query.tool.js'
import { hitlTool }              from './tools/hitl.tool.js'
import {
  formatLearningsForPrompt,
  saveGenerationOutcome,
  getButtonMapping,
} from '../self-healing/learning-registry.service.js'
import prisma                    from '../../shared/db/prisma.js'
import type {
  AgentStep_Playwright,
  StepValidationResult,
  HITLInput,
} from './agent.types.js'

const log = createModuleLogger('step-generator-agent')

// ── LLM ───────────────────────────────────────────────────────────────────────

function buildLlm() {
  return new ChatOpenAI({
    apiKey:      process.env.OPENAI_API_KEY,
    model:       process.env.STEP_GEN_MODEL ?? 'gpt-4o',
    temperature: 0.1,
    maxTokens:   4096,
  })
}

// ── System prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Test Step Generator Agent for AutoTestAI.
Your job: generate EXECUTABLE Playwright test steps grounded in real metadata.

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
  E. Self-check: will my steps cover COUNT_REQUIRED fields? If not, add them.

🔴 CREATE OPERATION RULE (applies when test name contains "Create" or "Add"):
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
      7. ASSERT_URL that the page redirected back after saving
  - ⚠️ CRITICAL ORDERING: Step 2 ("open form" click) MUST come BEFORE steps 3-5 (field filling).
     WRONG ORDER: NAVIGATE → TYPE → SELECT → CLICK "+New Account" ← WRONG
     RIGHT ORDER: NAVIGATE → CLICK "+New Account" → TYPE → SELECT → CLICK "Create Account"
  - If no FIELD MANIFEST is available, use the BRD/SPECIFICATION and PROJECT METADATA sections
    to discover which fields exist on the form, then generate TYPE/SELECT steps for them.
  - A test case that only navigates and clicks WITHOUT filling fields WILL BE REJECTED.
  - ⚠️ PRODUCT FORM EXAMPLE — if the test is for a Product entity and no manifest is present:
      TYPE "Name" / TYPE "Product Name"
      SELECT "Currency" (or TYPE if free-text)
      TYPE "Description"
      TYPE "SKU" or TYPE "Code"
      CLICK save/create button

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



// ── 5-Check Validation Gate ───────────────────────────────────────────────────

function validateSteps(
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
  const effectiveRequiredCount = Math.max(requiredCount, minimumFieldSteps ?? 0)
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

  const check1 = fieldSteps.length >= effectiveRequiredCount && missingRequired.length === 0
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

  // Check 2: URL verification
  const navSteps = steps.filter(s => s.action.toUpperCase() === 'NAVIGATE')
  let check2 = true
  if (verifiedPaths.length > 0) {
    for (const nav of navSteps) {
      const val = nav.value ?? ''
      const ok = verifiedPaths.some(p => p === val || val.startsWith(p))
      if (!ok) {
        issues.push(`URL not in verified map: "${val}"`)
        check2 = false
      }
    }
  }

  // Check 3: Button name exactness — ensure CLICK targets exist in the known button set
  let check3 = true
  const allKnownButtons = [
    ...(submitButton ? [submitButton] : []),
    ...(allButtons ?? []),
  ]
  if (allKnownButtons.length > 0) {
    const clickSteps = steps.filter(s => s.action.toUpperCase() === 'CLICK')
    for (const cs of clickSteps) {
      const target = (cs.target ?? '').trim()
      if (!target) continue
      // Allow if it matches any known button (case-insensitive) OR a CSS selector / role locator
      const isCssOrRole = target.startsWith('.') || target.startsWith('#') || target.startsWith('[') || target.startsWith('role=')
      if (!isCssOrRole) {
        const matchesKnown = allKnownButtons.some(
          btn => btn.toLowerCase() === target.toLowerCase() || target.toLowerCase().includes(btn.toLowerCase())
        )
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
    // Build case-insensitive set of known field labels
    const knownFields = new Set(manifestFields.map(f => f.label.toLowerCase().trim()))

    const FIELD_ACTIONS = new Set(['TYPE', 'SELECT', 'LOOKUP', 'CHECKBOX', 'MULTI_SELECT'])
    const hallucinated: string[] = []
    for (const s of steps) {
      if (!FIELD_ACTIONS.has((s.action ?? '').toUpperCase())) continue
      const target = String(s.target ?? '').trim()
      if (!target) continue
      if (!knownFields.has(target.toLowerCase())) {
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
  // For Create operations, the "open form" CLICK (e.g., "+New Account") MUST come
  // BEFORE any TYPE/SELECT/LOOKUP field-filling steps. If it appears after field steps,
  // the test will try to type into a form that isn't open yet.
  let check11 = true
  const isCreateOpForCheck11 = /\b(create|add|new)\b/i.test(testEntityHint ?? '')
  if (isCreateOpForCheck11 && !isUpdateOpForValidation) {
    const FIELD_ACTIONS_C11 = new Set(['TYPE', 'SELECT', 'LOOKUP', 'CHECKBOX', 'MULTI_SELECT'])
    const SUBMIT_RE_C11 = /\b(create|save|submit|confirm|done|finish)\b/i
    const OPEN_FORM_RE_C11 = /\b(new|add|open)\b/i

    const firstFieldIdxC11 = steps.findIndex(s => FIELD_ACTIONS_C11.has((s.action ?? '').toUpperCase()))
    if (firstFieldIdxC11 > 0) {
      // Look for an "open form" CLICK that appears AFTER the first field step
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
    }
  }

  return {
    passed: check1 && check2 && check3 && check4 && check5 && check6 && check7 && check8 && check9 && check10 && check11,
    checks: {
      requiredFieldCoverage: check1,
      urlVerification:       check2,
      buttonNameExact:       check3,
      locatorTypeValid:      check4,
      dataTypeAlignment:     check5,
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
    const stripped = input.testName
      .replace(/^(create|update|edit|delete|view|add|manage|verify|test|check)\s+/i, '')
      .replace(/\b(new|a|an|the|successfully|with|for|and|or|record|records|details|detail|valid|invalid|existing|required|optional|active|inactive|duplicate|mandatory|basic|empty|updated|given|correct|incorrect|multiple|successful)\b/gi, '')
      .trim()
    // Case-agnostic extraction: normalize to lowercase first so ALL-CAPS,
    // TitleCase, and mixed-case entity names all resolve correctly.
    // Verb-form stop words (creating, adding, etc.) prevent "Test creating a product" → "Creating"
    const STOP_WORDS = new Set([
      'the','and','for','with','new','all','record','records','form','page','test','case',
      'creating','adding','editing','updating','deleting','viewing','checking','verifying',
      'testing','managing','making','submitting','saving','clicking','navigating',
    ])
    const words = stripped.toLowerCase().split(/\s+/).filter(w => w.length >= 3 && !STOP_WORDS.has(w))
    const entity = words[0] ?? stripped.split(/\s+/)[0] ?? ''
    return entity.charAt(0).toUpperCase() + entity.slice(1)
  })()

  // ── CRITICAL: resolve entity name BEFORE fetching manifest ──────────────
  // entityFilter may be empty, ALL-CAPS ("PRODUCT"), or TitleCase ("Product").
  // We normalize it to TitleCase here so buildFieldManifest always gets a
  // clean, non-empty entity name. This is the fix for the case-sensitivity bug.
  const resolvedEntityFilter = (() => {
    // Priority 1: explicitly passed entityFilter (truthy, length > 2)
    if (input.entityFilter && input.entityFilter.trim().length > 2) {
      // Still normalize casing: "PRODUCT" → "Product"
      const ef = input.entityFilter.trim()
      return ef.charAt(0).toUpperCase() + ef.slice(1).toLowerCase()
    }
    // Priority 2: extract from test name (case-agnostic)
    const stripped = input.testName
      .replace(/^(create|update|edit|delete|view|add|manage|verify|test|check)\s+/i, '')
      .replace(/\b(new|a|an|the|successfully|with|for|and|or|record|records|details|detail|valid|invalid|existing|required|optional|active|inactive|duplicate|mandatory|basic|empty|updated|given|correct|incorrect|multiple|successful)\b/gi, '')
      .trim()
    // Expanded stop words: verb forms prevent "Test creating a product" → "Creating"
    const STOP_RE = new Set([
      'the','and','for','with','new','all','record','records','form','page','test','case',
      'creating','adding','editing','updating','deleting','viewing','checking','verifying',
      'testing','managing','making','submitting','saving','clicking','navigating',
    ])
    const words = stripped.toLowerCase().split(/\s+/).filter(w => w.length >= 3 && !STOP_RE.has(w))
    const entity = words[0] ?? stripped.split(/\s+/)[0] ?? ''
    return entity.length > 0 ? entity.charAt(0).toUpperCase() + entity.slice(1) : undefined
  })()

  log.info(
    { projectId: input.projectId, testName: input.testName, rawEntityFilter: input.entityFilter, resolvedEntityFilter },
    '[STEP-GEN] Resolved entity filter for manifest lookup',
  )

  const [manifest, urlMap, ragResult, projectArtifacts, learningsText, learnedButtons, sampleTestData] = await Promise.all([
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
    (async () => {
      if (!resolvedEntityFilter || resolvedEntityFilter.length < 2) return null
      try {
        const row = await prisma.web_test_data.findFirst({
          where: {
            project_id:  input.projectId,
            entity_name: { contains: resolvedEntityFilter, mode: 'insensitive' },
          },
        })
        if (row?.records && Array.isArray(row.records) && row.records.length > 0) {
          return row.records[0] as Record<string, unknown>
        }
        return null
      } catch { return null }
    })(),
  ])

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

  thoughts.push(`THINK: manifest has ${manifest?.requiredCount ?? 0} required fields [${manifest?.fields.filter(f => f.required).map(f => f.label).join(', ') ?? 'none'}], URL map has ${urlMap.paths.length} paths, learnings: ${learningsText.length > 0 ? 'YES' : 'none'}`)


  // ── Detect operation type from test name ─────────────────────────────────────
  // testName may be a short clean title ("Create Product") OR a full paragraph prompt.
  // We detect create intent anywhere in the string, not just at the start.
  const isUpdateOperation = /\b(update|edit|modify|change|updating|modifying|editing)\b/i.test(input.testName)
    // "existing <entity>" is a clear update signal — e.g. "To update the existing Account"
    || /\bexisting\s+\w+/i.test(input.testName)
  // Delete/Remove: navigate → search → click → delete button → confirm
  const isDeleteOperation = !isUpdateOperation &&
    /\b(delete|remove|archive|deactivate|trash)\b/i.test(input.testName)
  // View/Open: navigate → search → click → assert detail page
  const isViewOperation = !isUpdateOperation && !isDeleteOperation &&
    /\b(view|open|display|read|preview|check details|details of|see details)\b/i.test(input.testName)
  // Create is only true when update/delete/view is NOT detected — update intent takes priority
  const isCreateOperation = !isUpdateOperation && !isDeleteOperation && !isViewOperation && (
    /\b(create|add|new)\b/i.test(input.testName)
    || /\bcreating\b/i.test(input.testName)
    || /\bnew\s+(product|lead|contact|account|opportunity|quote|order|invoice|campaign|contract|record|entity)\b/i.test(input.testName)
  )

  // ── Entity-specific record name fallbacks ─────────────────────────────────
  const ENTITY_RECORD_FALLBACKS: Record<string, string> = {
    account:     'Acme Corp',
    lead:        'John Smith',
    contact:     'Jane Doe',
    opportunity: 'Q4 Enterprise Deal',
    product:     'Premium Widget',
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
  const entityRecordFallback =
    ENTITY_RECORD_FALLBACKS[entityKey] ??
    ENTITY_RECORD_FALLBACKS[Object.keys(ENTITY_RECORD_FALLBACKS).find(k =>
      entityKey.startsWith(k) || k.startsWith(entityKey)
    ) ?? ''] ??
    'Test Record'

  // ── Resolve real edit button from manifest (entity-agnostic) ─────────────
  const resolvedEditButton = manifest?.allButtons?.find(b => /\bedit\b/i.test(b)) ?? 'Edit'

  // ── Resolve real search input hint from manifest (entity-agnostic) ────────
  const resolvedSearchHint: string = (() => {
    const searchField = manifest?.fields.find(f =>
      /search|filter|find|query/i.test(f.label) && f.type === 'input'
    )
    if (searchField) return searchField.label
    return resolvedEntityFilter ? `Search ${resolvedEntityFilter}s` : 'Search'
  })()

  // Minimum field steps: Create needs ≥2, Update needs ≥1, others 0
  // Combined with manifest.requiredCount so real manifest always wins if higher.
  const minimumFieldSteps = isCreateOperation ? 2 : isUpdateOperation ? 1 : 0

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

  const brdText = decodeArtifact((projectArtifacts as any).brd_content)
  const existingTestsText = decodeArtifact((projectArtifacts as any).existing_tests_content)

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

  // ── Build sample data text block for LLM ──────────────────────────────────
  const sampleDataText = sampleTestData
    ? `=== SAMPLE TEST DATA (use realistic values like these) ===\n` +
      Object.entries(sampleTestData)
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

  // Pre-compute whether the manifest has required fields that need explicit enumeration in prompt.
  // This is used by the CREATE OPERATION CONSTRAINT block below.
  const hasMissingRequiredFieldsForPrompt = manifest != null && manifest.fields.some(f => f.required)

  const userPrompt = [
    urlMapText,
    manifestText,
    learningsText,   // ← Past learnings: failures, button mappings, corrections
    lookupValuesText, // ← Real lookup values from web_test_data — MANDATORY for LOOKUP steps
    sampleDataText,  // ← Sample test data for realistic values
    ragText,
    brdText ? `=== BRD / SPECIFICATION (business rules to follow) ===\n${brdText}` : '',
    existingTestsText ? `=== EXISTING TEST CASES (for naming conventions and coverage reference) ===\n${existingTestsText}` : '',
    `=== TEST CASE ===\nName: ${input.testName}\nDescription: ${input.description ?? ''}`,
    // ── CREATE/UPDATE OPERATION CONSTRAINT: explicit required fields listed by name ──
    // This is the highest-priority instruction — placed LAST in the prompt so
    // it is in the LLM's recency window. Lists every required field by name so
    // the LLM cannot miss them even if it skimmed the FIELD MANIFEST section.
    (isCreateOperation || isUpdateOperation || hasMissingRequiredFieldsForPrompt) && manifest
      ? (() => {
          const reqFields = manifest.fields.filter(f => f.required)
          const reqList   = reqFields.map(f => `  ★ [${f.type.toUpperCase()}] "${f.label}"${f.options?.length ? ' (pick from: ' + f.options.slice(0,3).join(' | ') + ')' : ''}`).join('\n')
          if (isUpdateOperation) {
            // Update-specific instructions — fully entity-agnostic
            const listUrl = manifest?.createUrl
              ? manifest.createUrl.replace(/\/(new|create|add)\b.*$/i, '')
              : urlMap.paths.find(p => p.toLowerCase().includes((resolvedEntityFilter ?? '').toLowerCase()) && !/new|create|add/i.test(p))
              ?? `/${(resolvedEntityFilter ?? 'records').toLowerCase()}s`

            return [
              `🔴 UPDATE OPERATION — ENTITY: ${resolvedEntityFilter ?? 'record'}`,
              ``,
              `AVAILABLE FIELDS FOR EDITING (pick at least 1):`,
              reqList || '  (all fields optional — pick any field to modify)',
              ``,
              `UPDATE WORKFLOW — follow these 7 steps EXACTLY:`,
              `  1. NAVIGATE to: ${listUrl}`,
              `     ▶ This is the LIST page. NEVER navigate to a /new, /create, or /add URL.`,
              `  2. SEARCH STEP — TYPE the record name in the search input:`,
              `     ▶ action: TYPE`,
              `     ▶ target: "${resolvedSearchHint}"`,
              `     ▶ locator_type: "placeholder"`,
              `     ▶ value: <record name — use REAL LOOKUP DATA or SAMPLE TEST DATA, or "${entityRecordFallback}">`,
              `     ▶ ⚠️ Do NOT use status words ("Active", "Closed", "Prospect") as a record name`,
              `  3. CLICK the record name to open its detail page:`,
              `     ▶ action: CLICK, target: <same record name as step 2>, locator_type: "text"`,
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
            ].join('\n')
          }
          return [
            `🔴 MANDATORY FIELDS — YOU MUST GENERATE A STEP FOR EVERY ★ FIELD BELOW:`,
            reqList,
            ``,
            `This test creates a new ${resolvedEntityFilter ?? 'record'}.`,
            `Rules:`,
            `  1. Generate one TYPE/SELECT/LOOKUP step per ★ field above — NO SKIPPING`,
            `  2. Use the EXACT label string shown (e.g. "${reqFields[0]?.label ?? 'Field'}")`,
            `  3. Sequence: NAVIGATE → fill all ★ fields → CLICK submit → ASSERT_URL`,
            `  4. Missing even ONE ★ field will FAIL validation and trigger re-generation`,
          ].join('\n')
        })()
      : '',

    // Inject confirmed button names from learning registry as a high-priority override
    learnedButtons.openButton || learnedButtons.submitButton
      ? `⚠️  CONFIRMED BUTTON NAMES FROM PAST EXECUTIONS:\n` +
        (learnedButtons.openButton ? `  OPEN button: "${learnedButtons.openButton}" — use this EXACTLY for opening the form\n` : '') +
        (learnedButtons.submitButton ? `  SUBMIT button: "${learnedButtons.submitButton}" — use this EXACTLY for saving/creating\n` : '') +
        `  These were confirmed by successful past test runs. Do NOT substitute other names.`
      : '',
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
    // e.g. "Create New Account Successfully" → "Account"
    // Case-agnostic entity hint extraction for Check 3b (cross-entity button guard)
    // Handles ALL-CAPS, TitleCase, and mixed-case entity names identically.
    const STOP_HINT = new Set(['new','successfully','with','for','and','the','a','an'])
    const entityHintRaw = input.testName
      .replace(/^(create|update|edit|delete|view|add|manage|verify|test|check)\s+/i, '')
      .replace(/\b(new|successfully|with|for|and|the|a|an)\b/gi, '')
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
  const effectiveEntityHint = input.entityFilter ?? (() => {
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
    const FIELD_ACTIONS_PRE = new Set(['TYPE', 'SELECT', 'LOOKUP', 'CHECKBOX', 'MULTI_SELECT'])
    const coveredTargets = new Set(
      steps.filter(s => FIELD_ACTIONS_PRE.has((s.action ?? '').toUpperCase()))
           .map(s => (s.target ?? '').toLowerCase().trim())
    )
    return manifest!.fields.filter(f => f.required)
                           .some(f => !coveredTargets.has(f.label.toLowerCase().trim()))
  })()

  if ((isCreateOperation || hasMissingRequiredFields) && hasManifestWithFields && !isUpdateOperation) {
    const FIELD_ACTIONS_SN0 = new Set(['TYPE', 'SELECT', 'LOOKUP', 'CHECKBOX', 'MULTI_SELECT'])
    const existingFieldSteps = steps.filter(s => FIELD_ACTIONS_SN0.has((s.action ?? '').toUpperCase()))
    const existingFieldTargets = new Set(existingFieldSteps.map(s => (s.target ?? '').toLowerCase().trim()))

    // Check: how many REQUIRED fields are already covered?
    const requiredFields = manifest.fields.filter(f => f.required)
    const requiredCoverage = requiredFields.filter(
      f => existingFieldTargets.has(f.label.toLowerCase().trim())
    ).length

    const needsInjection = (
      existingFieldSteps.length < minimumFieldSteps ||
      (requiredFields.length > 0 && requiredCoverage < requiredFields.length)
    )

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
        // Skip fields that already have a step
        if (existingFieldTargets.has(field.label.toLowerCase().trim())) continue

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
            const label = field.label.toLowerCase()
            if (/phone|mobile|tel/.test(label))          value = field.sampleValue ?? '+1 555-123-4567'
            else if (/email/.test(label))                value = field.sampleValue ?? 'test@autotest.com'
            else if (/date/.test(label))                 value = field.sampleValue ?? '12/31/2026'
            else if (/website|url|link/.test(label))     value = field.sampleValue ?? 'https://www.example.com'
            else if (/amount|price|cost|revenue/.test(label)) value = field.sampleValue ?? '25000.00'
            else if (/name|title/.test(label))           value = field.sampleValue ?? `Test ${manifest.entityName} ${Date.now() % 10000}`
            else if (/description|note|comment/.test(label)) value = field.sampleValue ?? 'Automated test data'
            else                                         value = field.sampleValue ?? `Test ${field.label}`
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
        // Strategy: Insert field steps BETWEEN the NAVIGATE and CLICK steps
        // Find the insertion point: after the last NAVIGATE, before the first CLICK (that's a submit)
        let navigateIdx = -1
        for (let i = steps.length - 1; i >= 0; i--) {
          if ((steps[i].action ?? '').toUpperCase() === 'NAVIGATE') { navigateIdx = i; break }
        }
        const submitClickIdx = steps.findIndex(s => {
          const a = (s.action ?? '').toUpperCase()
          if (a !== 'CLICK') return false
          const t = (s.target ?? '').toLowerCase()
          return /\b(create|save|submit|add|new|update|confirm)\b/.test(t)
        })

        // Remove any existing minimal field steps (they may be hallucinated)
        const cleanedSteps = steps.filter(s => {
          if (!FIELD_ACTIONS_SN0.has((s.action ?? '').toUpperCase())) return true
          // Keep field steps that ARE in the manifest
          const target = (s.target ?? '').toLowerCase().trim()
          return manifest.fields.some(f => f.label.toLowerCase().trim() === target)
        })

        // Find insertion point in cleaned steps
        const insertIdx = cleanedSteps.findIndex(s => {
          const a = (s.action ?? '').toUpperCase()
          if (a === 'CLICK') {
            const t = (s.target ?? '').toLowerCase()
            return /\b(create|save|submit|add|new|update|confirm)\b/.test(t)
          }
          return a === 'ASSERT_URL' || a === 'ASSERT_TEXT' || a === 'ASSERT_TOAST'
        })

        if (insertIdx > 0) {
          // Insert BEFORE the submit click / assert
          cleanedSteps.splice(insertIdx, 0, ...injectedFieldSteps)
        } else if (navigateIdx >= 0) {
          // Insert AFTER the last navigate
          cleanedSteps.splice(navigateIdx + 1, 0, ...injectedFieldSteps)
        } else {
          // Append before last step (which is typically ASSERT)
          const lastIdx = cleanedSteps.length > 1 ? cleanedSteps.length - 1 : cleanedSteps.length
          cleanedSteps.splice(lastIdx, 0, ...injectedFieldSteps)
        }

        steps = cleanedSteps.map((s, i) => ({ ...s, id: String(i + 1) }))
        thoughts.push(`SAFETY NET 0: injected ${injectedFieldSteps.length} field steps from manifest`)
        log.info(
          { injected: injectedFieldSteps.length, totalSteps: steps.length },
          '[STEP-GEN] ✅ SAFETY NET 0: Field steps injected successfully',
        )

        // Re-run validation after injection
        const entityHintRe = effectiveEntityHint || input.entityFilter || ''
        validation = validateSteps(
          steps,
          manifest.requiredCount ?? 0,
          urlMap.paths,
          manifest.submitButton,
          manifest.allButtons,
          manifest.fields,
          entityHintRe,
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
    const CREATE_URL_RE = /\/(new|create|add)\b/i
    for (const s of steps) {
      if ((s.action ?? '').toUpperCase() === 'NAVIGATE' && s.target && CREATE_URL_RE.test(s.target)) {
        const originalUrl = s.target
        const listUrl = s.target.replace(/\/(new|create|add)\b.*$/i, '')
        if (listUrl && listUrl !== s.target) {
          s.target = listUrl
          thoughts.push(`SAFETY NET U: fixed NAVIGATE from create page "${originalUrl}" → list page "${listUrl}"`)
          log.info(
            { projectId: input.projectId, originalUrl, listUrl },
            '[STEP-GEN] ⚡ SAFETY NET U: redirected NAVIGATE from create page to list page',
          )
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
      if (sampleTestData) {
        const nameKey = Object.keys(sampleTestData).find(k =>
          /^(name|full.?name|display.?name|title|label|account.?name|first.?name|contact.?name|lead.?name)$/i.test(k)
        )
        const val = nameKey ? String(sampleTestData[nameKey] ?? '') : ''
        if (val && val.length > 0 && val.length < 100) return val
      }
      if (realLookupValues.size > 0) {
        const first = [...realLookupValues.values()][0]
        if (first?.length) return first[0]
      }
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
      // Keep if it matches the correct entity
      if (entityLower.includes(entityWord) || entityWord.includes(entityLower)) return true
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
  if (steps.length > 0) {
    const stepsAsRecords = steps as unknown as Array<Record<string, any>>
    await autoCorrectButtonNames(stepsAsRecords, input.projectId, effectiveEntityHint)
    steps = stepsAsRecords as unknown as AgentStep_Playwright[]
    thoughts.push('SAFETY NET 3: ran centralized button name auto-correction (metadata + learning registry)')
  }

  // ── DELIVER ───────────────────────────────────────────────────────────────

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
