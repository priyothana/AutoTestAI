/**
 * Execution Agent — Phase 1, Agent 4  (upgraded)
 *
 * Wraps the existing execution.worker.ts pipeline with agentic intelligence:
 * - Classifies failures (including navigation-menu and invalid-field failures)
 * - Applies autonomous recovery strategies before calling HITL
 * - OBSERVE → THINK → ACT → REFLECT loop
 * - Logs all decisions to agent_executions for observability
 *
 * LLM: OpenAI gpt-4o (used for failure classification and recovery planning)
 *
 * Recovery strategy priority (before HITL):
 *   0. INVALID_FIELD             — field doesn't exist on entity form → auto-skip
 *   1. NAVIGATION_MENU_STRATEGY — multi-strategy DOM scan for nav items
 *   2. WAIT_AND_RETRY           — element loading / timing issue
 *   3. ALTERNATIVE_LOCATOR      — LLM suggests corrected selector
 *   4. DISMISS_MODAL            — unexpected modal blocking interaction
 *   5. RE_AUTHENTICATE          — session expired
 *   → Only THEN call hitlTool (with rich context + suggestions)
 */
import { ChatOpenAI }            from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { StringOutputParser }    from '@langchain/core/output_parsers'
import { v4 as uuidv4 }          from 'uuid'

import { createModuleLogger }    from '../../shared/logger/index.js'
import { hitlTool }              from './tools/hitl.tool.js'
import { logAgentExecution }     from './tools/db-query.tool.js'
import { buildFieldManifest }    from './tools/metadata-reader.tool.js'
import prisma                    from '../../shared/db/prisma.js'
import {
  getLabelCorrections,
  saveLabelCorrection,
  saveButtonMapping,
  saveRequiredFields,
} from '../self-healing/learning-registry.service.js'
import type { StepData }         from '../../shared/queue/job-types.js'
import type { HITLInput }        from './agent.types.js'

const log = createModuleLogger('execution-agent')

// ── LLM ───────────────────────────────────────────────────────────────────────

function buildLlm() {
  return new ChatOpenAI({
    apiKey:      process.env.OPENAI_API_KEY,
    model:       process.env.EXECUTION_AGENT_MODEL ?? 'gpt-4o',
    temperature: 0.1,
    maxTokens:   1024,
  })
}

// ── Failure classifier ────────────────────────────────────────────────────────

type FailureClass =
  | 'LOCATOR_NOT_FOUND'
  | 'INVALID_FIELD'          // field doesn't exist on the entity form (hallucinated by LLM)
  | 'INVALID_TEST_DATA'     // step value is placeholder/garbage data (e.g. "-", "N/A")
  | 'NAVIGATION_MENU'       // element is a nav/menu item
  | 'ELEMENT_NOT_VISIBLE'
  | 'UNEXPECTED_MODAL'
  | 'SESSION_EXPIRED'
  | 'TIMEOUT'
  | 'ASSERTION_FAILED'
  | 'UNKNOWN'

const FAILURE_PATTERNS: Array<{ pattern: RegExp; class: FailureClass }> = [
  // Navigation menu items — detect by step target keywords
  { pattern: /admin|panel|sidebar|menu|navigation|settings|dashboard|module|section/i, class: 'NAVIGATION_MENU' },
  // Standard locator failures
  { pattern: /locator.*not.*found|no.*element|cannot.*find|element.*not.*found|smartWebAppClick|all.*strateg/i, class: 'LOCATOR_NOT_FOUND' },
  { pattern: /not.*visible|hidden|display.*none|element.*not.*visible/i,          class: 'ELEMENT_NOT_VISIBLE' },
  { pattern: /modal|dialog|overlay|popup/i,                                        class: 'UNEXPECTED_MODAL' },
  { pattern: /session.*expired|login.*required|auth.*challenge|401|403/i,          class: 'SESSION_EXPIRED' },
  { pattern: /timeout|timed.*out/i,                                                class: 'TIMEOUT' },
  { pattern: /assert|expect|expected.*but/i,                                       class: 'ASSERTION_FAILED' },
]

/**
 * Classify a failure using both the error message AND the step target.
 * Navigation failures are detected even when the error message is generic.
 */
function classifyFailure(errorMessage: string, stepTarget?: string): FailureClass {
  // Check step target for navigation keywords first
  if (stepTarget) {
    if (FAILURE_PATTERNS[0].pattern.test(stepTarget)) return 'NAVIGATION_MENU'
  }
  const combined = `${errorMessage} ${stepTarget ?? ''}`
  for (const { pattern, class: cls } of FAILURE_PATTERNS) {
    if (pattern.test(combined)) return cls
  }
  return 'UNKNOWN'
}

// ── Smart Locator Tool (LLM + DOM) ────────────────────────────────────────────

const SMART_LOCATOR_SYSTEM_PROMPT = `You are a Playwright expert analyzing a failed web element click.
Given the step target and a DOM snapshot, suggest 3 alternative Playwright locator strategies.

Output ONLY valid JSON (no markdown):
{
  "suggestions": [
    { "strategy": "getByRole('link', {name: 'X'})", "confidence": 0.9 },
    { "strategy": "getByText('X')", "confidence": 0.7 },
    { "strategy": "locator('[data-id=\"admin\"]')", "confidence": 0.5 }
  ],
  "reasoning": "one sentence"
}`

interface LocatorSuggestion {
  strategy:   string
  confidence: number
}

async function smartLocatorTool(
  stepTarget:  string,
  errorMessage: string,
  pageHtml:    string,
): Promise<LocatorSuggestion[]> {
  try {
    const llm    = buildLlm()
    const parser = new StringOutputParser()
    const prompt = [
      `Failed target: "${stepTarget}"`,
      `Error: ${errorMessage.slice(0, 200)}`,
      `DOM snippet (first 1500 chars):\n${pageHtml.slice(0, 1500)}`,
    ].join('\n')

    const raw = await llm.pipe(parser).invoke([
      new SystemMessage(SMART_LOCATOR_SYSTEM_PROMPT),
      new HumanMessage(prompt),
    ])

    let cleaned = raw.trim()
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.split('\n').filter(l => !l.trim().startsWith('```')).join('\n')
    }
    const parsed = JSON.parse(cleaned) as { suggestions: LocatorSuggestion[] }
    return parsed.suggestions ?? []
  } catch {
    return []
  }
}

// ── Recovery strategy planner (deterministic + LLM fallback) ─────────────────

const RECOVERY_SYSTEM_PROMPT = `You are an expert Playwright test recovery agent.
A test step failed. Classify the failure and suggest the best recovery action.

Output ONLY valid JSON (no markdown):
{
  "failureType": "LOCATOR_NOT_FOUND|INVALID_FIELD|NAVIGATION_MENU|ELEMENT_NOT_VISIBLE|UNEXPECTED_MODAL|SESSION_EXPIRED|TIMEOUT|ASSERTION_FAILED|UNKNOWN",
  "recoveryAction": "WAIT_AND_RETRY|ALTERNATIVE_LOCATOR|DISMISS_MODAL|RE_AUTHENTICATE|SKIP_STEP|CALL_HITL",
  "reason": "one sentence explanation",
  "confidence": 0.0-1.0,
  "alternativeLocator": "suggested alternative locator string (if ALTERNATIVE_LOCATOR)"
}`

export interface RecoveryPlan {
  failureType:          FailureClass
  recoveryAction:       'WAIT_AND_RETRY' | 'ALTERNATIVE_LOCATOR' | 'DISMISS_MODAL' | 'RE_AUTHENTICATE' | 'SKIP_STEP' | 'REGENERATE_AND_RETRY' | 'CALL_HITL'
  reason:               string
  confidence:           number
  alternativeLocator?:  string
  locatorSuggestions?:  LocatorSuggestion[]
  availableFields?:     string[]   // populated when INVALID_FIELD — shows actual fields from manifest
  correctedValue?:      string     // populated when INVALID_TEST_DATA — realistic replacement value
}

export async function planRecovery(
  step:         StepData,
  errorMessage: string,
  pageHtml?:    string,
  projectId?:   string,
  executionId?: string,
): Promise<RecoveryPlan> {
  const cls = classifyFailure(errorMessage, step.target ?? undefined)

  // ── INVALID_FIELD detection: check if a field-type step's target actually exists ──
  // When a TYPE/SELECT/LOOKUP/CHECKBOX step fails with LOCATOR_NOT_FOUND, it could be
  // because the field genuinely doesn't exist on the form (hallucinated by the LLM
  // during step generation). Check the field manifest BEFORE trying alternative locators.
  const FIELD_ACTIONS = new Set(['TYPE', 'SELECT', 'LOOKUP', 'CHECKBOX', 'MULTI_SELECT'])
  const stepAction = ((step as any).action ?? '').toUpperCase()
  const stepTarget = (step.target ?? '').trim()

  if (
    projectId &&
    FIELD_ACTIONS.has(stepAction) &&
    stepTarget &&
    (cls === 'LOCATOR_NOT_FOUND' || cls === 'UNKNOWN')
  ) {
    try {
      // Extract entity hint from the test case name
      let entityHint: string | undefined
      if (executionId) {
        const run = await prisma.test_runs.findUnique({
          where: { id: executionId },
          select: {
            test_case: {
              select: { name: true }
            }
          }
        })
        const tcName = run?.test_case?.name
        if (tcName) {
          const rawHint = tcName
            .replace(/^(create|update|edit|delete|view|add|manage|verify|test|check)\s+/i, '')
            .replace(/\b(new|successfully|with|for|and|the|a|an|details|detail|record|records)\b/gi, '')
            .trim()
            .split(/\s+/)[0] ?? ''
          if (rawHint.length > 2) {
            entityHint = rawHint
          }
        }
      }

      const manifest = await buildFieldManifest(projectId, entityHint)
      if (manifest && manifest.fields.length > 0) {
        const knownFields = new Set(manifest.fields.map(f => f.label.toLowerCase().trim()))
        const targetLower = stepTarget.toLowerCase().trim()

        if (!knownFields.has(targetLower)) {
          // Field does NOT exist in the manifest → INVALID_FIELD
          const availableFieldNames = manifest.fields.map(f => f.label)
          log.info(
            { target: stepTarget, entity: manifest.entityName, availableFields: availableFieldNames.slice(0, 10) },
            '[EXEC-AGENT] INVALID_FIELD detected — field not in manifest',
          )
          return {
            failureType:    'INVALID_FIELD',
            recoveryAction: 'SKIP_STEP',
            reason:         `Field "${stepTarget}" does not exist on the ${manifest.entityName} form. ` +
                            `This field was incorrectly generated by AI — it should be removed from the test case. ` +
                            `Available fields: ${availableFieldNames.slice(0, 8).join(', ')}`,
            confidence:     0.95,
            availableFields: availableFieldNames,
          }
        }
      }
    } catch (manifestErr) {
      log.warn({ manifestErr }, '[EXEC-AGENT] Field manifest check failed (non-fatal) — continuing with standard classification')
    }
  }

  // ── INVALID_TEST_DATA detection: check if a field-type step has placeholder/garbage value ──
  // When a TYPE/SELECT step fails, it might be because the value itself is invalid
  // (e.g., "-", "N/A", empty, single char). Detect this and provide a corrected value.
  if (
    projectId &&
    FIELD_ACTIONS.has(stepAction) &&
    stepTarget &&
    (cls === 'LOCATOR_NOT_FOUND' || cls === 'UNKNOWN' || cls === 'TIMEOUT')
  ) {
    const stepValue = ((step as any).value ?? '').trim()
    const PLACEHOLDER_RE_EXEC = /^[-\u2013\u2014.?!_*#@~`\/\\]+$/
    const NA_RE_EXEC = /^n\/?a$/i
    const isPlaceholder = !stepValue || stepValue.length < 2 || PLACEHOLDER_RE_EXEC.test(stepValue) || NA_RE_EXEC.test(stepValue)

    if (isPlaceholder) {
      // Try to generate a corrected value from the manifest
      let correctedValue: string | undefined
      let entityHint: string | undefined

      // Extract entity from test case name
      if (executionId) {
        try {
          const run = await prisma.test_runs.findUnique({
            where: { id: executionId },
            select: { test_case: { select: { name: true } } },
          })
          const tcName = run?.test_case?.name
          if (tcName) {
            const rawHint = tcName
              .replace(/^(create|update|edit|delete|view|add|manage|verify|test|check)\s+/i, '')
              .replace(/\b(new|successfully|with|for|and|the|a|an|details|detail|record|records)\b/gi, '')
              .trim().split(/\s+/)[0] ?? ''
            if (rawHint.length > 2) entityHint = rawHint
          }
        } catch { /* non-fatal */ }
      }

      // Look up the field in the manifest to generate a realistic value
      try {
        const manifest = await buildFieldManifest(projectId, entityHint)
        if (manifest && manifest.fields.length > 0) {
          const targetLower = stepTarget.toLowerCase().trim()
          const field = manifest.fields.find(f => f.label.toLowerCase().trim() === targetLower)

          if (field) {
            // Generate a realistic value based on field metadata
            if (field.options?.length) {
              correctedValue = field.options[0]
            } else if (field.sampleValue) {
              correctedValue = field.sampleValue
            } else {
              const label = field.label.toLowerCase()
              if (/phone|mobile|tel/.test(label))          correctedValue = '+1 555-987-6543'
              else if (/email/.test(label))                correctedValue = 'updated@autotest.com'
              else if (/date/.test(label))                 correctedValue = '12/31/2026'
              else if (/website|url|link/.test(label))     correctedValue = 'https://www.example.com'
              else if (/amount|price|cost|revenue/.test(label)) correctedValue = '50000.00'
              else if (/name|title/.test(label))           correctedValue = `Test ${entityHint ?? 'Record'} ${Date.now() % 10000}`
              else                                         correctedValue = `Updated ${field.label}`
            }
          }
        }
      } catch { /* non-fatal */ }

      log.info(
        { target: stepTarget, originalValue: stepValue, correctedValue, entity: entityHint },
        '[EXEC-AGENT] INVALID_TEST_DATA detected — placeholder value in step',
      )

      return {
        failureType:    'INVALID_TEST_DATA',
        recoveryAction: correctedValue ? 'REGENERATE_AND_RETRY' : 'SKIP_STEP',
        reason:         `Field "${stepTarget}" has placeholder value "${stepValue}" — ` +
                        (correctedValue
                          ? `replacing with realistic value "${correctedValue}" from metadata.`
                          : `no replacement value available from metadata — skipping step.`),
        confidence:     correctedValue ? 0.90 : 0.80,
        correctedValue,
      }
    }
  }

  // Deterministic fast-path mapping
  const deterministicMap: Record<FailureClass, RecoveryPlan['recoveryAction']> = {
    INVALID_FIELD:       'SKIP_STEP',            // field doesn't exist → auto-skip
    INVALID_TEST_DATA:   'REGENERATE_AND_RETRY', // placeholder value → replace with real data
    NAVIGATION_MENU:     'ALTERNATIVE_LOCATOR',  // use smart locator tool
    LOCATOR_NOT_FOUND:   'ALTERNATIVE_LOCATOR',
    ELEMENT_NOT_VISIBLE: 'WAIT_AND_RETRY',
    UNEXPECTED_MODAL:    'DISMISS_MODAL',
    SESSION_EXPIRED:     'RE_AUTHENTICATE',
    TIMEOUT:             'WAIT_AND_RETRY',
    ASSERTION_FAILED:    'CALL_HITL',
    UNKNOWN:             'CALL_HITL',
  }

  if (cls !== 'UNKNOWN') {
    const plan: RecoveryPlan = {
      failureType:    cls,
      recoveryAction: deterministicMap[cls],
      reason:         `Deterministic classification: ${cls}`,
      confidence:     cls === 'NAVIGATION_MENU' ? 0.85 : 0.8,
    }

    // For navigation/locator failures: first check learning registry, then smartLocatorTool
    if ((cls === 'NAVIGATION_MENU' || cls === 'LOCATOR_NOT_FOUND') && projectId) {
      // LEARNING REGISTRY CHECK: try known label corrections before calling LLM
      try {
        const corrections = await getLabelCorrections(projectId)
        if (corrections.has(stepTarget)) {
          const correctedLabel = corrections.get(stepTarget)!
          log.info(
            { original: stepTarget, corrected: correctedLabel },
            '[EXEC-AGENT] Label correction found in learning registry',
          )
          return {
            failureType:        cls,
            recoveryAction:     'ALTERNATIVE_LOCATOR',
            reason:             `Learning registry correction: "${stepTarget}" \u2192 "${correctedLabel}"`,
            confidence:         0.92,
            alternativeLocator: correctedLabel,
          }
        }
      } catch { /* Non-fatal */ }

      // SMART LOCATOR: LLM-based alternative locator suggestions
      if (pageHtml) {
        const suggestions = await smartLocatorTool(
          step.target ?? '', errorMessage, pageHtml,
        )
        if (suggestions.length > 0) {
          plan.alternativeLocator = suggestions[0].strategy
          plan.locatorSuggestions = suggestions
          plan.confidence = Math.max(plan.confidence, suggestions[0].confidence)
          log.info(
            { target: step.target, topSuggestion: suggestions[0].strategy },
            '[EXEC-AGENT] smartLocatorTool returned suggestions',
          )
        }
      }
    }

    return plan
  }

  // Fall back to LLM for UNKNOWN failures
  try {
    const llm    = buildLlm()
    const parser = new StringOutputParser()
    const prompt = `Failed step: ${JSON.stringify(step)}\nError: ${errorMessage}\nPage snippet: ${(pageHtml ?? '').slice(0, 500)}`
    const raw    = await llm.pipe(parser).invoke([
      new SystemMessage(RECOVERY_SYSTEM_PROMPT),
      new HumanMessage(prompt),
    ])
    let cleaned = raw.trim()
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.split('\n').filter(l => !l.trim().startsWith('```')).join('\n')
    }
    return JSON.parse(cleaned) as RecoveryPlan
  } catch {
    return {
      failureType:    'UNKNOWN',
      recoveryAction: 'CALL_HITL',
      reason:         'LLM classification failed — escalating to HITL',
      confidence:     0.3,
    }
  }
}

// ── Step result processor ─────────────────────────────────────────────────────

export interface StepResult {
  stepId:      string
  status:      'passed' | 'failed' | 'skipped'
  errorMessage?: string
  screenshot?: string  // base64
  durationMs:  number
}

export interface ExecutionAgentInput {
  executionId: string
  projectId:   string
  testCaseId:  string
  steps:       StepData[]
}

export interface ExecutionAgentOutput {
  executionId:    string
  overallStatus:  'passed' | 'failed' | 'stopped'
  stepResults:    StepResult[]
  recoveryActions: string[]
  hitlInvoked:    boolean
  thoughts:       string[]
}

/**
 * Process a step failure — attempt autonomous recovery before calling HITL.
 *
 * ReAct loop:
 *   OBSERVE  — classify failure type from error + DOM
 *   THINK    — select recovery strategy
 *   ACT      — return recovery action for the worker to execute
 *   REFLECT  — after N attempts, escalate to HITL with rich context
 *
 * Returns the recovery action taken and whether HITL was invoked.
 */
export async function handleStepFailure(params: {
  executionId:  string
  projectId:    string
  failedStep:   StepData
  errorMessage: string
  screenshot?:  string
  pageHtml?:    string
  attemptNum:   number  // 1-2 (HITL fires on attempt ≥ 2)
}): Promise<{ action: string; hitlInvoked: boolean; failureType?: string; reason?: string }> {
  const { executionId, failedStep, errorMessage, screenshot, attemptNum } = params
  const startMs = Date.now()
  const thoughts: string[] = []

  // ── OBSERVE ────────────────────────────────────────────────────────────────
  thoughts.push(`OBSERVE: step "${failedStep.action} ${failedStep.target}" failed — "${errorMessage.slice(0, 120)}"`)
  thoughts.push(`OBSERVE: attempt ${attemptNum}, classifying failure`)

  const plan = await planRecovery(failedStep, errorMessage, params.pageHtml, params.projectId, executionId)

  thoughts.push(`THINK: failure=${plan.failureType}, action=${plan.recoveryAction}, confidence=${plan.confidence}`)

  log.info(
    { executionId, step: failedStep.id, attempt: attemptNum, plan },
    '[EXEC-AGENT] Recovery plan',
  )

  // ── ACT ────────────────────────────────────────────────────────────────────

  // After 2 attempts or explicit CALL_HITL → invoke HITL with rich context
  // (HITL fires on the SECOND call = after 1 autonomous recovery attempt)
  if (attemptNum >= 2 || plan.recoveryAction === 'CALL_HITL') {
    thoughts.push('REFLECT: max attempts reached or CALL_HITL — escalating to HITL tool')

    const suggestions: string[] = [
      `Failure type: ${plan.failureType}`,
      `Root cause: ${plan.reason}`,
    ]

    if (plan.locatorSuggestions && plan.locatorSuggestions.length > 0) {
      suggestions.push('Alternative locators to try manually:')
      for (const s of plan.locatorSuggestions.slice(0, 3)) {
        suggestions.push(`  • ${s.strategy} (confidence: ${Math.round(s.confidence * 100)}%)`)
      }
    }

    if (plan.failureType === 'INVALID_FIELD') {
      suggestions.push(
        `⚠️ INVALID FIELD: "${failedStep.target}" does not exist on this entity\'s form.`,
        'This step was incorrectly generated by AI and should be removed from the test case.',
        'The field was hallucinated — it is not present in the form metadata.',
      )
      if (plan.availableFields && plan.availableFields.length > 0) {
        suggestions.push(`Available fields on this form: ${plan.availableFields.slice(0, 10).join(', ')}`)
      }
      suggestions.push('Recommendation: Skip this step and remove it from the test case.')
    }

    if (plan.failureType === 'INVALID_TEST_DATA') {
      suggestions.push(
        `⚠️ INVALID TEST DATA: Field "${failedStep.target}" has placeholder value "${(failedStep as any).value ?? ''}"`,
        'The AI generated garbage/placeholder data instead of realistic test values.',
        plan.correctedValue
          ? `Corrected value: "${plan.correctedValue}" (from entity metadata)`
          : 'No replacement value available from metadata.',
        'Recommendation: Re-generate test steps with valid data.',
      )
    }

    if (plan.failureType === 'NAVIGATION_MENU') {
      suggestions.push(
        'This is a navigation menu click failure. Common fixes:',
        '  1. Check if the menu item is inside a collapsible sidebar — expand it manually',
        '  2. Look for the item under a different menu name or parent section',
        '  3. Scroll the sidebar to find the item',
        `  4. Check crawled nav metadata for the exact label used in the UI`,
      )
    }

    suggestions.push(`Skip this step and continue with the next one`)

    const hitlInput: HITLInput = {
      agentName:    'execution',
      executionId,
      reason:       `Step "${failedStep.target}" (${failedStep.action}) failed after ${attemptNum} recovery attempts: ${plan.reason}`,
      failedStep:   failedStep as unknown as Record<string, unknown>,
      errorMessage,
      screenshot,
      suggestions,
      metadata: { projectId: params.projectId },
    }

    thoughts.push('ACT: calling hitlTool')
    await hitlTool(hitlInput)

    // Log to observability
    await logAgentExecution({
      projectId:     params.projectId,
      agentName:     'execution',
      taskType:      'step_failure_recovery',
      inputSummary:  { executionId, stepId: failedStep.id, failureType: plan.failureType },
      outputSummary: { action: 'HITL_INVOKED', attempts: attemptNum },
      thoughts,
      hitlInvoked:   true,
      confidence:    plan.confidence,
      tokensUsed:    0,
      durationMs:    Date.now() - startMs,
    }).catch(() => { /* non-fatal */ })

    return { action: 'HITL_INVOKED', hitlInvoked: true, failureType: plan.failureType, reason: plan.reason }
  }

  // ── REFLECT: return action for the worker to execute ───────────────────────
  thoughts.push(`REFLECT: returning "${plan.recoveryAction}" for worker to execute`)

  // Log non-HITL recovery attempt
  await logAgentExecution({
    projectId:     params.projectId,
    agentName:     'execution',
    taskType:      'step_failure_recovery',
    inputSummary:  { executionId, stepId: failedStep.id, failureType: plan.failureType, attempt: attemptNum },
    outputSummary: { action: plan.recoveryAction, confidence: plan.confidence },
    thoughts,
    hitlInvoked:   false,
    confidence:    plan.confidence,
    tokensUsed:    0,
    durationMs:    Date.now() - startMs,
  }).catch(() => { /* non-fatal */ })

  return { action: plan.recoveryAction, hitlInvoked: false, failureType: plan.failureType, reason: plan.reason }
}

/**
 * Post-execution analysis — called after all steps complete.
 * Logs the run summary to agent_executions.
 * ENHANCED: Now also saves learnings from execution results.
 */
export async function analyzeExecution(
  executionId: string,
  projectId:   string,
  stepResults: StepResult[],
  originalSteps?: StepData[],
): Promise<void> {
  const passed  = stepResults.filter(s => s.status === 'passed').length
  const failed  = stepResults.filter(s => s.status === 'failed').length
  const skipped = stepResults.filter(s => s.status === 'skipped').length
  const total   = stepResults.length
  const success = failed === 0

  log.info(
    { executionId, passed, failed, skipped, total, success },
    '[EXEC-AGENT] Execution analysis',
  )

  // ── POST-EXECUTION LEARNING LOOP ──────────────────────────────────────────
  if (originalSteps && originalSteps.length > 0) {
    try {
      await postExecutionLearning(projectId, executionId, originalSteps, stepResults)
    } catch (err) {
      log.warn({ err }, '[EXEC-AGENT] Post-execution learning failed (non-fatal)')
    }
  }

  await logAgentExecution({
    projectId,
    agentName:     'execution',
    taskType:      'execute_test',
    inputSummary:  { executionId, totalSteps: total },
    outputSummary: { passed, failed, skipped, success },
    thoughts:      [`${passed}/${total} steps passed`],
    hitlInvoked:   false,
    confidence:    success ? 1.0 : failed / total,
    tokensUsed:    0,
    durationMs:    stepResults.reduce((s, r) => s + r.durationMs, 0),
  })
}

/**
 * Post-execution learning feedback — saves button mappings, required fields,
 * and label corrections from execution results.
 */
async function postExecutionLearning(
  projectId:     string,
  _executionId:  string,
  originalSteps: StepData[],
  stepResults:   StepResult[],
): Promise<void> {
  // Extract entity name from navigate step URL
  let entityName = ''
  for (const step of originalSteps) {
    const action = ((step as any).action ?? '').toUpperCase()
    if (action !== 'NAVIGATE') continue
    const url = ((step as any).value ?? (step as any).target ?? '') as string
    const sfMatch = url.match(/\/lightning\/o\/([^/]+)/i)
    if (sfMatch) { entityName = sfMatch[1]; break }
    const webMatch = url.match(/\/([a-z_-]+)\/(new|create|list|edit)/i)
    if (webMatch) { entityName = webMatch[1]; break }
  }
  if (!entityName) return

  const FIELD_ACTIONS  = new Set(['TYPE', 'SELECT', 'LOOKUP', 'CHECKBOX', 'FILL', 'MULTI_SELECT'])
  const SUBMIT_PATTERNS = /^(save|create|submit|update|add|confirm|apply|done|ok)/i
  const OPEN_PATTERNS   = /^(\+?\s*new|add|open|create new)/i

  const passedFieldLabels: string[] = []

  for (let i = 0; i < originalSteps.length; i++) {
    const step   = originalSteps[i] as Record<string, any>
    const result = stepResults[i]
    if (!result || result.status !== 'passed') continue

    const action = (step.action ?? '').toUpperCase()
    const target = (step.target ?? '') as string

    if (action === 'CLICK' && target) {
      if (SUBMIT_PATTERNS.test(target)) {
        saveButtonMapping(projectId, entityName, target, 'submit').catch(() => {})
      } else if (OPEN_PATTERNS.test(target)) {
        saveButtonMapping(projectId, entityName, target, 'open').catch(() => {})
      }
    }

    if (FIELD_ACTIONS.has(action) && target) {
      passedFieldLabels.push(target)
    }
  }

  if (passedFieldLabels.length > 0) {
    saveRequiredFields(projectId, entityName, passedFieldLabels).catch(() => {})
  }

  log.info(
    { entityName, fieldsCached: passedFieldLabels.length },
    '[EXEC-AGENT] Post-execution learning saved',
  )
}
