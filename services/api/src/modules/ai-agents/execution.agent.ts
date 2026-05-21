/**
 * Execution Agent — Phase 1, Agent 4  (upgraded)
 *
 * Wraps the existing execution.worker.ts pipeline with agentic intelligence:
 * - Classifies failures (including navigation-menu failures)
 * - Applies autonomous recovery strategies before calling HITL
 * - OBSERVE → THINK → ACT → REFLECT loop
 * - Logs all decisions to agent_executions for observability
 *
 * LLM: OpenAI gpt-4o (used for failure classification and recovery planning)
 *
 * Recovery strategy priority (before HITL):
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
import prisma                    from '../../shared/db/prisma.js'
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
  | 'NAVIGATION_MENU'       // ← NEW: element is a nav/menu item
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
  "failureType": "LOCATOR_NOT_FOUND|NAVIGATION_MENU|ELEMENT_NOT_VISIBLE|UNEXPECTED_MODAL|SESSION_EXPIRED|TIMEOUT|ASSERTION_FAILED|UNKNOWN",
  "recoveryAction": "WAIT_AND_RETRY|ALTERNATIVE_LOCATOR|DISMISS_MODAL|RE_AUTHENTICATE|SKIP_STEP|CALL_HITL",
  "reason": "one sentence explanation",
  "confidence": 0.0-1.0,
  "alternativeLocator": "suggested alternative locator string (if ALTERNATIVE_LOCATOR)"
}`

interface RecoveryPlan {
  failureType:          FailureClass
  recoveryAction:       'WAIT_AND_RETRY' | 'ALTERNATIVE_LOCATOR' | 'DISMISS_MODAL' | 'RE_AUTHENTICATE' | 'SKIP_STEP' | 'CALL_HITL'
  reason:               string
  confidence:           number
  alternativeLocator?:  string
  locatorSuggestions?:  LocatorSuggestion[]
}

async function planRecovery(
  step:         StepData,
  errorMessage: string,
  pageHtml?:    string,
): Promise<RecoveryPlan> {
  const cls = classifyFailure(errorMessage, step.target ?? undefined)

  // Deterministic fast-path mapping
  const deterministicMap: Record<FailureClass, RecoveryPlan['recoveryAction']> = {
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

    // For navigation/locator failures: run smartLocatorTool to get alternative suggestions
    if ((cls === 'NAVIGATION_MENU' || cls === 'LOCATOR_NOT_FOUND') && pageHtml) {
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

  const plan = await planRecovery(failedStep, errorMessage, params.pageHtml)

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
 */
export async function analyzeExecution(
  executionId: string,
  projectId:   string,
  stepResults: StepResult[],
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
