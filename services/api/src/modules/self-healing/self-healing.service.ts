/**
 * Self-Healing Module — AI Fix Assistant Chat Service
 *
 * Port of Python TestHealingService.chat() and generate_healing_suggestions().
 *
 * Endpoints consumed:
 *   POST /api/v1/test-runs/:id/heal
 *
 * Two operating modes (mirrors Python):
 *   1. EDIT MODE  — user provides current_corrected_steps + a targeted instruction
 *                   ("Update step 14 as Order = 00000471")
 *                   → Apply ONLY the requested change, keep everything else
 *
 *   2. CHAT MODE  — standard question / regeneration request
 *                   → Full LLM call with all step context + chat history
 *
 * Response shape (identical to Python):
 *   { reply: string, corrected_steps: CorrectedStep[] }
 */
import prisma                  from '../../shared/db/prisma.js'
import { createModuleLogger }  from '../../shared/logger/index.js'
import { ChatAnthropic }       from '@langchain/anthropic'
import { ChatOpenAI }          from '@langchain/openai'
import type { BaseChatModel }  from '@langchain/core/language_models/chat_models'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { StringOutputParser }  from '@langchain/core/output_parsers'
import type { HealRequest, CorrectedStep } from './self-healing.schema.js'

// Cross-module: fetch SF metadata for manifest injection in healing prompts
import {
  getObjectMetadata,
  getPageLayoutFields,
} from '../salesforce/salesforce.service.js'

const log = createModuleLogger('self-healing-chat')

// ── Config ────────────────────────────────────────────────────────────────────
const LLM_PROVIDER = (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase()
const CHAT_MODEL   = process.env.LLM_MODEL ?? 'claude-sonnet-4-20250514'

// ── System prompt (port of Python HEALING_SYSTEM_PROMPT) ─────────────────────
const HEALING_SYSTEM_PROMPT = `You are an expert Salesforce Lightning + Playwright test architect.

A test failed because of application errors (missing required fields, modal overlays, etc.).
Your job is to produce a COMPLETE, CORRECTED test steps array that will run successfully end-to-end.

═══ LOCATOR FORMAT REFERENCE (use these EXACTLY) ═══

For CLICK on a button:
  {"action":"click","target":"role=button, name=New","value":"","locator_type":"role"}
  {"action":"click","target":"role=button, name=Save","value":"","locator_type":"role"}

For CLICK on a link (record row):
  {"action":"click","target":"role=link, name=RecordName","value":"","locator_type":"role"}

For NAVIGATE:
  {"action":"navigate","target":"","value":"/lightning/o/{ObjectApiName}/list","locator_type":"url"}

For FILL a field by label:
  {"action":"fill","target":"FieldLabel","value":"...","locator_type":"label"}

For LOOKUP fields:
  {"action":"lookup","target":"AccountName","value":"Test Account - 1","locator_type":"label"}

For WAIT (milliseconds):
  {"action":"wait","target":"2000","value":"","locator_type":""}

For ASSERT TEXT on element:
  {"action":"assert_text","target":"was created","value":"","locator_type":"text"}

═══ CRITICAL RULES ═══

1. PRESERVE THE ORIGINAL TEST WORKFLOW (MOST IMPORTANT RULE):
   - Study the CURRENT TEST STEPS provided. They define the workflow pattern.
   - If the original test SEARCHES for and OPENS an existing record, keep that pattern.
   - If the original test CREATES a new record, keep that pattern.
   - DO NOT change the workflow type.
   - Keep ALL passing steps (navigate, search, click record, wait, click Edit) exactly as they were.
   - ONLY add/modify/reorder the FORM FIELD steps (fill, lookup, select) to fix the failure.

2. ONLY generate steps relevant to the SPECIFIC OBJECT being tested.

3. After clicking a record link, INSERT A WAIT of 2000ms before the Edit button click.

4. REQUIRED FIELDS must be filled on the RECORD EDIT FORM.

5. For LOOKUP fields: use action="lookup" with locator_type="label".

6. For PICKLIST fields: use action="fill" with the exact picklist value from metadata.

7. For DATE fields: use MM/DD/YYYY format.

8. DEPENDENT FIELD ORDERING (CRITICAL):
   a. DEPENDENT PICKLISTS: controlling field MUST be filled BEFORE the dependent field.
   b. FILTERED LOOKUPS: controlling field MUST be filled BEFORE the filtered lookup.
   c. Order: navigate → click New/Edit → wait → SELECT/LOOKUP fields → TYPE fields → Save

═══ OUTPUT FORMAT ═══

Output ONLY a single JSON object, no markdown, no code fences:
{
  "analysis": "<one sentence: what was wrong and what you changed>",
  "corrected_steps": [
    {"step_order":1,"action":"navigate","target":"","value":"/lightning/o/{ObjectApiName}/list","locator_type":"url"},
    ...all corrected steps...
  ]
}

Include EVERY step from start to finish. The corrected_steps array must be complete and runnable.

═══ INTERACTIVE EDIT MODE ═══

If the user gives an edit instruction like:
- "Update step 14 as Order = 00000471"
- "Change step 8 value to Test Corp"
- "Add a wait of 3000 after step 3"
- "Remove step 12"

Rules:
1. ALWAYS start from the PREVIOUS corrected_steps provided.
2. Apply ONLY the requested change(s) — do not regenerate the whole test.
3. For value updates: match by step_order (1-based), update the "value" field.
4. Output the FULL updated corrected_steps array every time — never partial.
5. In "analysis", briefly describe what was changed.`.trim()

// ── Salesforce field manifest injection ───────────────────────────────────────

/**
 * Extracts the Salesforce object API name from a test steps array by scanning
 * NAVIGATE step values for Lightning URL patterns like /lightning/o/{Object}/list.
 * Returns null if no Lightning object URL is found.
 */
function extractSfObjectFromSteps(steps: { action?: string; value?: string; target?: string }[]): string | null {
  for (const step of steps) {
    const action = String(step.action ?? '').toLowerCase()
    if (action !== 'navigate') continue
    const url = String(step.value ?? step.target ?? '')
    // Match /lightning/o/ObjectApiName/... patterns
    const match = url.match(/\/lightning\/o\/([^/]+)/i)
    if (match?.[1]) return match[1]
  }
  return null
}

/**
 * Fetches a compact field manifest for a Salesforce object to inject into healing prompts.
 * Returns an empty string if the project has no SF integration or metadata is unavailable.
 *
 * This ensures the LLM knows exactly which fields are required (by schema OR by page layout)
 * so it doesn't regenerate test steps that skip them.
 */
async function fetchSfFieldManifestForHealing(
  projectId: string,
  objectApiName: string,
): Promise<string> {
  try {
    const [sfMeta, layoutResult] = await Promise.all([
      getObjectMetadata(projectId, objectApiName).catch(() => null),
      getPageLayoutFields(projectId, objectApiName).catch(() => null),
    ])
    if (!sfMeta?.metadata) return ''

    const fields = (sfMeta.metadata['fields'] ?? []) as Record<string, unknown>[]
    const layoutAvailable = layoutResult?.available ?? null
    const layoutRequired  = layoutResult?.layoutRequired ?? new Set<string>()

    const AUTO_FILLED = new Set(['id', 'ownerid', 'recordtypeid', 'masterrecordid',
      'createddate', 'createdbyid', 'lastmodifieddate', 'lastmodifiedbyid',
      'systemmodstamp', 'isdeleted'])

    const lines: string[] = [
      `=== FIELD MANIFEST for ${objectApiName} ===`,
      '  [REQUIRED] = MUST include a fill/lookup step or record save WILL fail',
      '  [OPTIONAL] = include only if it was in the original steps or is clearly needed',
      '',
    ]

    let anyField = false

    for (const f of fields) {
      const apiName = String(f['name'] ?? '').toLowerCase()
      if (AUTO_FILLED.has(apiName)) continue
      if (!Boolean(f['createable'])) continue
      const name  = String(f['name'] ?? '')
      const label = String(f['label'] ?? name)
      const type  = String(f['type'] ?? 'string').toLowerCase()

      // Skip fields not on the layout if layout data is available
      if (layoutAvailable && layoutAvailable.size > 0 && !layoutAvailable.has(name)) {
        const hasNillable = 'nillable' in f
        const isSchemaReq = hasNillable
          ? (!Boolean(f['nillable']) && !Boolean(f['defaultedOnCreate']))
          : Boolean(f['required'])
        const isLayoutReq = layoutRequired.has(name)
        if (!isSchemaReq && !isLayoutReq) continue
      }

      const hasNillable = 'nillable' in f
      const isSchemaReq = hasNillable
        ? (!Boolean(f['nillable']) && !Boolean(f['defaultedOnCreate']))
        : Boolean(f['required'])
      const isLayoutReq = layoutRequired.has(name)
      const isRequired  = isSchemaReq || isLayoutReq

      const tag = isRequired ? '[REQUIRED]' : '[OPTIONAL]'

      const plv = (f['picklistValues'] as Record<string, unknown>[] | undefined) ?? []
      const picklistVals = plv.filter(v => Boolean(v['active'])).map(v => String(v['label'] ?? v['value'] ?? '')).filter(Boolean)
      const refs = (f['referenceTo'] as string[] | undefined) ?? []

      let desc = `${tag} • ${label} (apiName: ${name}, type: ${type})`
      if (isLayoutReq && !isSchemaReq) desc += ' [layout-required]'
      if (picklistVals.length > 0) desc += ` | values: [${picklistVals.join(', ')}]`
      if (refs.length > 0) desc += ` | lookup to: ${refs.join(', ')}`

      lines.push(desc)
      anyField = true
    }

    if (!anyField) lines.push('  (no form fields found)')
    lines.push('', '=== END FIELD MANIFEST ===')
    return lines.join('\n')
  } catch {
    return ''
  }
}

/**
 * Look up the project_id for a test run so we can fetch SF metadata.
 */
async function getProjectIdForTestRun(testRunId: string): Promise<string | null> {
  try {
    const run = await prisma.test_runs.findUnique({
      where:  { id: testRunId },
      select: { test_case: { select: { project_id: true } } },
    })
    return run?.test_case?.project_id ?? null
  } catch {
    return null
  }
}

// ── LLM factory ───────────────────────────────────────────────────────────────
function buildLlm(): BaseChatModel {
  if (LLM_PROVIDER === 'openai') {
    return new ChatOpenAI({
      apiKey:      process.env.OPENAI_API_KEY,
      model:       process.env.LLM_MODEL ?? 'gpt-4o',
      temperature: 0.1,
      maxTokens:   4096,
    })
  }
  return new ChatAnthropic({
    apiKey:      process.env.ANTHROPIC_API_KEY,
    model:       CHAT_MODEL,
    maxTokens:   4096,
    temperature: 0.1,
  })
}

// ── JSON parse helper (strips markdown fences) ────────────────────────────────
function parseJsonResponse(raw: string): { analysis: string; corrected_steps: CorrectedStep[] } {
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.split('\n').filter((l) => !l.trim().startsWith('```')).join('\n')
  }
  const parsed = JSON.parse(cleaned)
  if (!parsed || typeof parsed !== 'object') throw new Error('LLM returned non-object JSON')
  return {
    analysis:        parsed.analysis        ?? '',
    corrected_steps: parsed.corrected_steps ?? [],
  }
}

// ── Main exported service function ────────────────────────────────────────────

/**
 * Conversational AI Fix Assistant.
 * Called by POST /api/v1/test-runs/:id/heal
 *
 * • EDIT MODE: current_corrected_steps + message → targeted step mutation
 * • CHAT MODE: fresh context → full LLM healing
 */
export async function healTestRun(
  testRunId: string,
  body: HealRequest,
): Promise<{ reply: string; corrected_steps: CorrectedStep[] }> {

  log.info(`[HEAL-CHAT] Request for run ${testRunId}, msg="${(body.message ?? '').slice(0, 80)}"`)

  // ── Load test run + steps ──────────────────────────────────────────────────
  const testRun = await prisma.test_runs.findUnique({
    where:   { id: testRunId },
    include: { test_case: { select: { steps: true, name: true, project_id: true } } },
  })
  if (!testRun) throw { statusCode: 404, message: 'Test run not found' }

  const originalSteps = (testRun.test_case?.steps as Record<string, unknown>[] | null) ?? []
  const logs          = (testRun.logs as Record<string, unknown>[] | null) ?? []

  const userMessage       = body.message ?? ''
  const chatHistory       = body.chat_history ?? []
  const prevCorrected     = body.current_corrected_steps ?? null

  // ─── EDIT MODE: user is adjusting existing corrected steps ────────────────
  if (prevCorrected && prevCorrected.length > 0 && userMessage.trim()) {
    log.info(`[HEAL-CHAT] EDIT MODE — ${prevCorrected.length} current steps, instruction: "${userMessage.slice(0, 80)}"`)

    const editPrompt = `═══ INTERACTIVE EDIT MODE ═══

The user wants to modify the existing corrected test steps.

User instruction: "${userMessage}"

=== CURRENT CORRECTED STEPS ===
${JSON.stringify(prevCorrected, null, 2)}

=== YOUR TASK ===
Apply ONLY the user's requested change to the steps above.
Do NOT regenerate the whole test — just modify what was asked.
Output the FULL updated corrected_steps array with the change applied.
In "analysis", briefly describe what you changed.

Output ONLY a JSON object: {"analysis": "...", "corrected_steps": [...]}
No markdown, no code fences.`

    const messages: { role: 'user' | 'assistant'; content: string }[] = []
    for (const m of chatHistory.slice(-6)) {
      messages.push({ role: m.role as 'user' | 'assistant', content: m.content })
    }
    messages.push({ role: 'user', content: editPrompt })

    const llm    = buildLlm()
    const parser = new StringOutputParser()
    const chain  = llm.pipe(parser)

    const langChainMsgs = [
      new SystemMessage(HEALING_SYSTEM_PROMPT),
      ...messages.map((m) =>
        m.role === 'user' ? new HumanMessage(m.content) : new SystemMessage(m.content)
      ),
    ]

    const raw    = await chain.invoke(langChainMsgs)
    const result = parseJsonResponse(raw)

    log.info(`[HEAL-CHAT] Edit mode → ${result.corrected_steps.length} steps`)
    return {
      reply:           result.analysis || '✅ Steps updated.',
      corrected_steps: result.corrected_steps,
    }
  }

  // ─── STANDARD CHAT / REGENERATION MODE ───────────────────────────────────
  log.info(`[HEAL-CHAT] STANDARD MODE — building context prompt`)

  // Serialize original steps for LLM
  const stepsList = originalSteps.map((s, i) => ({
    step_order:   i + 1,
    action:       (s['action'] as string) ?? '',
    target:       (s['target'] as string) ?? '',
    value:        (s['value']  as string) ?? '',
    locator_type: (s['locator_type'] as string) ?? '',
  }))

  // Extract first failing step + error from logs
  let failingStep: Record<string, unknown> | null = null
  let errorMessage = ''
  for (const logEntry of logs) {
    const status = String(logEntry['status'] ?? '').toLowerCase()
    const error  = String(logEntry['error']  ?? '')
    if ((status === 'failed' || status === 'error') && error) {
      failingStep  = logEntry
      errorMessage = error
      break
    }
  }

  // Extract passing steps from logs
  const passingLogSteps: Record<string, unknown>[] = []
  for (const logEntry of logs) {
    const status = String(logEntry['status'] ?? '').toLowerCase()
    if (status === 'passed' || status === 'success') {
      passingLogSteps.push(logEntry)
    } else {
      break  // stop at first failure
    }
  }

  let sfFieldManifest = ''
  try {
    // Use project_id from the already-loaded test_case (avoids second DB query)
    const projectId = testRun.test_case?.project_id ?? await getProjectIdForTestRun(testRunId)
    if (projectId) {
      const stepsForObj = stepsList.map(s => ({ action: s.action, value: s.value, target: s.target }))
      const objectName = extractSfObjectFromSteps(stepsForObj)
      if (objectName) {
        sfFieldManifest = await fetchSfFieldManifestForHealing(projectId, objectName)
        if (sfFieldManifest) {
          log.info(`[HEAL-CHAT] SF field manifest injected for ${objectName} (${sfFieldManifest.length} chars)`)
        } else {
          log.warn(`[HEAL-CHAT] SF field manifest empty for ${objectName} — metadata may not be cached yet`)
        }
      } else {
        log.info(`[HEAL-CHAT] No Lightning object found in steps — skipping field manifest`)
      }
    } else {
      log.warn(`[HEAL-CHAT] Could not resolve project_id for run ${testRunId} — skipping field manifest`)
    }
  } catch (err) {
    log.warn({ err }, `[HEAL-CHAT] Non-critical: failed to fetch SF field manifest`)
  }

  const contextPrompt = `=== FAILED TEST CONTEXT ===
Failing step: #${failingStep?.['step'] ?? failingStep?.['step_order'] ?? '?'} | action=${failingStep?.['action'] ?? '?'} | target=${failingStep?.['target'] ?? '?'}
Error: "${errorMessage}"
${sfFieldManifest ? '\n' + sfFieldManifest + '\n' : ''}
=== CURRENT TEST STEPS ===
${JSON.stringify(stepsList, null, 2)}

=== RUN LOGS (showing which steps PASSED before failure) ===
The following steps PASSED in the actual test run. These workflow steps MUST be preserved.
${passingLogSteps.length > 0 ? JSON.stringify(passingLogSteps, null, 2) : 'No passing steps available.'}

=== YOUR TASK ===
${sfFieldManifest ? `
CRITICAL: This is a Salesforce record creation/edit test. A FIELD MANIFEST is provided above.
You MUST:
1. Include fill/lookup/select steps for EVERY field listed under "REQUIRED fields" in the manifest
2. Insert these steps AFTER navigate/click-New and BEFORE the Save button click
3. Do NOT skip any REQUIRED field even if it was not in the original steps
4. Use these action types by field type:
   - text/string/email/phone fields → action="fill", locator_type="label"
   - picklist fields → action="fill" with EXACT picklist value, locator_type="label"
   - lookup/reference fields → action="lookup", locator_type="label"
5. Use the field LABEL (not API name) as the target for fill/lookup actions
` : 'Fix ONLY the failing step and any missing required fields.'}
KEEP all the passing workflow steps (navigate, search, click record, wait, click Edit) exactly as they succeeded.
Do NOT skip the record-opening steps. You CANNOT fill fields on a list view.
Output ONLY the JSON object with 'analysis' and 'corrected_steps'. No markdown.`

  let fullPrompt = contextPrompt
  if (userMessage.trim()) {
    fullPrompt = `Follow-up: ${userMessage}\n\n${contextPrompt}`
  }

  // Build message array (chat history + current prompt)
  const messages: { role: 'user' | 'assistant'; content: string }[] = []
  for (const m of chatHistory.slice(-6)) {
    messages.push({ role: m.role as 'user' | 'assistant', content: m.content })
  }
  messages.push({ role: 'user', content: fullPrompt })

  const llm    = buildLlm()
  const parser = new StringOutputParser()
  const chain  = llm.pipe(parser)

  const langChainMsgs = [
    new SystemMessage(HEALING_SYSTEM_PROMPT),
    ...messages.map((m) =>
      m.role === 'user' ? new HumanMessage(m.content) : new SystemMessage(m.content)
    ),
  ]

  const raw    = await chain.invoke(langChainMsgs)
  const result = parseJsonResponse(raw)

  log.info(`[HEAL-CHAT] Standard mode → ${result.corrected_steps.length} steps`)
  return {
    reply:           result.analysis || 'Here are the corrected steps:',
    corrected_steps: result.corrected_steps,
  }
}

/**
 * Generate AI healing suggestions for a failed test run.
 * Called inline by the execution worker immediately after a failed run.
 * Writes { analysis, corrected_steps } to test_runs.ai_suggestions.
 *
 * @param testRunId    - the UUID of the test run
 * @param steps        - the original test steps array
 * @param logs         - the step execution logs
 */
export async function generateAiSuggestions(
  testRunId: string,
  steps:     Record<string, unknown>[],
  logs:      Record<string, unknown>[],
): Promise<void> {
  try {
    // Find the first failing step
    let failingStep: Record<string, unknown> | null = null
    let errorMessage = ''
    for (const entry of logs) {
      const status = String(entry['status'] ?? '').toLowerCase()
      const error  = String(entry['error']  ?? '')
      if ((status === 'failed' || status === 'error') && error) {
        failingStep  = entry
        errorMessage = error
        break
      }
    }

    if (!failingStep) {
      log.info(`[AI-SUGGEST] No failing step found in logs for run ${testRunId} — skipping`)
      return
    }

    // Check APP_ERROR_PATTERNS (mirrors Python) — only generate for app-level errors
    const APP_ERROR_PATTERNS = [
      'update failed', 'required field', 'first error:', 'error in expression',
      'field integrity exception', 'validation rule', 'system.dmlexception',
      'insufficient access', 'apex error', "the record couldn't be saved",
      'review the following', 'save failed', 'missing required',
      'subtree intercepts pointer events', 'dependent picklist',
      'all strategies exhausted', 'timeout', 'locator', 'element', 'not found',
      'cannot find', 'no element', 'failed to', 'timed out',
    ]
    const errLower = errorMessage.toLowerCase()
    const isRelevant = APP_ERROR_PATTERNS.some((p) => errLower.includes(p))
    if (!isRelevant) {
      log.info(`[AI-SUGGEST] Error doesn't match healing patterns for run ${testRunId} — skipping`)
    }
    // We generate suggestions for ALL failures (not just SF), keeping it consistent with Python

    // Build the steps list
    const stepsList = steps.map((s, i) => ({
      step_order:   i + 1,
      action:       (s['action'] as string) ?? '',
      target:       (s['target'] as string) ?? '',
      value:        (s['value']  as string) ?? '',
      locator_type: (s['locator_type'] as string) ?? '',
    }))

    const passingLogs: Record<string, unknown>[] = []
    for (const entry of logs) {
      const status = String(entry['status'] ?? '').toLowerCase()
      if (status === 'passed' || status === 'success') {
        passingLogs.push(entry)
      } else {
        break
      }
    }

    const stepsForObj2 = stepsList.map(s => ({ action: s.action, value: s.value, target: s.target }))
    let sfManifest = ''
    try {
      const projectId = await getProjectIdForTestRun(testRunId)
      if (projectId) {
        const objName = extractSfObjectFromSteps(stepsForObj2)
        if (objName) {
          sfManifest = await fetchSfFieldManifestForHealing(projectId, objName)
          if (sfManifest) {
            log.info(`[AI-SUGGEST] SF field manifest injected for ${objName} (${sfManifest.length} chars)`)
          } else {
            log.warn(`[AI-SUGGEST] SF field manifest empty for ${objName} — metadata may not be cached yet`)
          }
        } else {
          log.info(`[AI-SUGGEST] No Lightning object found in steps — skipping field manifest`)
        }
      } else {
        log.warn(`[AI-SUGGEST] Could not resolve project_id for run ${testRunId} — skipping field manifest`)
      }
    } catch (err) {
      log.warn({ err }, `[AI-SUGGEST] Non-critical: failed to fetch SF field manifest`)
    }

    const prompt = `=== FAILED TEST CONTEXT ===
Failing step: #${failingStep['step'] ?? failingStep['step_order'] ?? '?'} | action=${failingStep['action'] ?? '?'} | target=${failingStep['target'] ?? '?'}
Error: "${errorMessage}"
${sfManifest ? '\n' + sfManifest + '\n' : ''}
=== CURRENT TEST STEPS ===
${JSON.stringify(stepsList, null, 2)}

=== RUN LOGS (steps that PASSED before failure) ===
${passingLogs.length > 0 ? JSON.stringify(passingLogs, null, 2) : 'No passing steps available.'}

=== YOUR TASK ===
${sfManifest ? `
CRITICAL: This is a Salesforce record creation/edit test. A FIELD MANIFEST is provided above.
You MUST:
1. Include fill/lookup/select steps for EVERY field listed under "REQUIRED fields" in the manifest
2. Insert these steps AFTER navigate/click-New and BEFORE the Save button click
3. Do NOT skip any REQUIRED field even if it was not in the original steps
4. Use these action types by field type:
   - text/string/email/phone fields → action="fill", locator_type="label"
   - picklist fields → action="fill" with EXACT picklist value, locator_type="label"
   - lookup/reference fields → action="lookup", locator_type="label"
5. Use the field LABEL (not API name) as the target for fill/lookup actions
` : 'Fix ONLY the failing step and any missing required fields.'}
KEEP all the passing workflow steps exactly as they succeeded.
Output ONLY the JSON object with 'analysis' and 'corrected_steps'. No markdown.`

    const llm    = buildLlm()
    const parser = new StringOutputParser()
    const chain  = llm.pipe(parser)

    const raw    = await chain.invoke([new SystemMessage(HEALING_SYSTEM_PROMPT), new HumanMessage(prompt)])
    const result = parseJsonResponse(raw)

    if (!result.corrected_steps || result.corrected_steps.length === 0) {
      log.warn(`[AI-SUGGEST] LLM returned 0 corrected steps for run ${testRunId} — not saving`)
      return
    }

    await prisma.test_runs.update({
      where: { id: testRunId },
      data:  { ai_suggestions: result as object },
    })

    log.info(`[AI-SUGGEST] ✅ Saved ${result.corrected_steps.length} corrected steps for run ${testRunId}`)
  } catch (err) {
    log.warn({ err }, `[AI-SUGGEST] Non-fatal: failed to generate AI suggestions for run ${testRunId}`)
  }
}
