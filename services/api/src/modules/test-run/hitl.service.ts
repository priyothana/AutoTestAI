/**
 * HITL AI Chat Service
 *
 * Powers the AI-driven HITL (Human-in-the-Loop) chatbot panel that appears
 * when a test step is paused due to a failure.
 *
 * Two entry points:
 *   1. hitlAnalyze()  — called once when the panel opens; generates the AI's
 *                       automatic first message analysing the error.
 *   2. hitlChat()     — handles every subsequent user turn; evaluates whether
 *                       the user's suggestion is valid / unclear / invalid and
 *                       responds accordingly.
 */
import { ChatOpenAI }                       from '@langchain/openai'
import { ChatAnthropic }                    from '@langchain/anthropic'
import { HumanMessage, SystemMessage }      from '@langchain/core/messages'
import { StringOutputParser }               from '@langchain/core/output_parsers'
import type { BaseChatModel }               from '@langchain/core/language_models/chat_models'

import prisma                               from '../../shared/db/prisma.js'
import { createModuleLogger }               from '../../shared/logger/index.js'
import { loadLearnings, formatLearningsBlock } from './hitl-learning.service.js'
import { hitlContextStore }                 from '../ai-agents/tools/hitl.tool.js'

const log = createModuleLogger('hitl-ai')

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChatMsg {
  role:    'user' | 'assistant'
  content: string
}

export interface HitlAnalyzeRequest {
  runId:        string
  testCaseId:   string
  pausedStep:   number | null   // 1-based
  errorMessage: string | null
}

export interface HitlChatRequest {
  runId:        string
  testCaseId:   string
  pausedStep:   number | null
  errorMessage: string | null
  instruction:  string
  chatHistory:  ChatMsg[]
}

/** A concrete step the AI has agreed to insert/update/delete */
export interface ProposedStep {
  action: string   // NAVIGATE | CLICK | TYPE | LOOKUP | SELECT | WAIT | …
  target: string   // URL, field name, selector
  value:  string   // optional value (typed text, selected option)
  label:  string   // human-readable one-liner shown in the Apply button card
  /** insert = add before paused step | update = patch paused step | delete = remove paused step */
  opType?: 'insert' | 'update' | 'delete'
}

/**
 * A structured suggestion card shown in the HITL panel.
 * Each suggestion has enough information to apply the change without further
 * parsing — eliminating fragile regex-based option parsing on the frontend.
 */
export interface SuggestionOption {
  /** Short human-readable label shown on the card */
  label:  string
  /** Playwright action keyword */
  action: string
  /** Field label, URL path, or selector */
  target: string
  /** Value to type / select (empty string if N/A) */
  value:  string
  /** Whether to insert a new step, update the paused step, or delete it */
  opType: 'insert' | 'update' | 'delete'
}

export interface HitlAiResponse {
  reply:             string
  suggestion_type:   'advice' | 'valid' | 'clarify' | 'invalid'
  /** Human-readable action the user should take in the browser */
  suggested_action?: string
  /** Quick-reply chips to surface as buttons */
  quick_replies?:    string[]
  /**
   * Structured suggestion cards — each item contains enough info for
   * the UI to apply the change immediately (no parsing required).
   * Prefer this over the legacy `options` string array.
   */
  suggestions?:      SuggestionOption[]
  /**
   * Legacy string options array kept for backward-compatibility with
   * the in-browser Playwright overlay script.
   * When `suggestions` is present, this is derived from it automatically.
   */
  options?:          string[]
  /**
   * When suggestion_type === "valid" AND the AI has agreed on a concrete step
   * to INSERT/UPDATE before the paused step, this field contains the structured step.
   * The UI renders it as a prominent "✓ Accept & Resume Testing" card.
   */
  proposed_step?:    ProposedStep
}

// ─── LLM factory ──────────────────────────────────────────────────────────────

function buildLlm(): BaseChatModel {
  const provider    = (process.env.LLM_PROVIDER ?? '').toLowerCase()
  const useAnthropic = provider === 'anthropic' ||
    (provider !== 'openai' && !process.env.OPENAI_API_KEY)

  if (!useAnthropic && process.env.OPENAI_API_KEY) {
    return new ChatOpenAI({
      apiKey:      process.env.OPENAI_API_KEY,
      model:       'gpt-4o-mini',
      temperature: 0.4,
    })
  }
  return new ChatAnthropic({
    apiKey:      process.env.ANTHROPIC_API_KEY,
    model:       process.env.CLAUDE_MODEL ?? (process.env.LLM_MODEL ?? 'claude-sonnet-4-5'),
    maxTokens:   1024,
    temperature: 0.4,
  })
}

// ─── System prompt ────────────────────────────────────────────────────────────

const HITL_SYSTEM_PROMPT = `
You are NEXUS, an expert QA Automation Engineer AI assistant embedded in the AutoTest AI platform.
A test has PAUSED because a step failed. Your job is to help the human CHOOSE the best corrective
action from a set of structured suggestions you provide so they can click "Apply & Resume".

═══════════════════════════════════════════════════════════════════
CONTEXT
═══════════════════════════════════════════════════════════════════

TEST CASE NAME: {test_case_name}

ALL TEST STEPS (JSON, 1-based step numbering shown):
{all_steps}

PAUSED AT: Step {paused_step}
STEP DETAILS: {paused_step_detail}
ERROR MESSAGE: {error_message}

RECENT CHAT HISTORY:
{chat_history}

{learnings_block}

═══════════════════════════════════════════════════════════════════
YOUR ROLE
═══════════════════════════════════════════════════════════════════

1. Analyse the error and the paused step context.
2. Provide 2–4 CONCRETE, DISTINCT structured suggestions the user can select from.
   Each suggestion must be specific and directly actionable — not generic advice.
3. When the human selects/confirms a specific fix ("yes", "ok", "use this", "apply", etc.):
   - Set suggestion_type="valid"
   - Set proposed_step with the EXACT structured step to apply
   - proposed_step.opType: "insert" (add before paused step), "update" (patch paused step), or "delete" (remove paused step)
   - proposed_step fields: action, target, value, opType, label
   - Do NOT include suggestions[] when suggestion_type="valid" — only proposed_step
4. If the user's natural language instruction is valid (e.g. "use SKU-100", "change value to USD"),
   classify as suggestion_type="valid" and include proposed_step immediately. Do NOT ask for more info.
5. If unclear, set suggestion_type="clarify" and ask ONE specific follow-up question.
6. If invalid, set suggestion_type="invalid" and explain why, with corrected suggestions.

Keep responses short and practical (2–4 sentences max).

IMPORTANT RULES:
- Supported action keywords: NAVIGATE CLICK TYPE SELECT ASSERT_TEXT WAIT CHECKBOX LOOKUP ASSERT_VISIBLE ASSERT_URL ASSERT_TOAST SCROLL HOVER.
- If error is data-uniqueness issue → suggest using different/unique test data values.
- If error is element-not-found → suggest checking page navigation or element label.
- If the step value is clearly wrong/placeholder → suggest opType="update" to fix the value.
- If the step is fundamentally invalid → suggest opType="delete" to remove it.
- If a prerequisite step is missing → suggest opType="insert" for the missing step.
- 🔴 IF PAST HUMAN CORRECTIONS APPEAR ABOVE: they OVERRIDE your general knowledge.
- When user confirms ("yes", "ok", "go ahead", "do it") → treat as confirmation of the last discussed option.

═══════════════════════════════════════════════════════════════════
OUTPUT FORMAT — respond with ONLY valid JSON (no markdown, no code fences)
═══════════════════════════════════════════════════════════════════

// When suggestion_type is "advice" (initial analysis or info needed):
{
  "reply": "Short analysis (2-4 sentences, plain text)",
  "suggestion_type": "advice",
  "suggested_action": "One-sentence action hint",
  "suggestions": [
    {
      "label": "Navigate to the Accounts page first",
      "action": "NAVIGATE",
      "target": "/accounts",
      "value": "",
      "opType": "insert"
    },
    {
      "label": "Update step value to use real SKU-100 instead",
      "action": "TYPE",
      "target": "Product Code",
      "value": "SKU-100",
      "opType": "update"
    }
  ],
  "options": ["NAVIGATE → /accounts", "TYPE 'SKU-100' into Product Code"],
  "quick_replies": ["Try option 1", "Try option 2"]
}

// When suggestion_type is "valid" (user confirmed or instruction is clear):
{
  "reply": "Got it! Applying the fix now.",
  "suggestion_type": "valid",
  "proposed_step": {
    "action": "NAVIGATE",
    "target": "/bank-details",
    "value": "",
    "opType": "insert",
    "label": "Navigate to Bank Details page before the failing step"
  }
}

// When suggestion_type is "clarify":
{
  "reply": "Which Currency value should I use instead?",
  "suggestion_type": "clarify",
  "quick_replies": ["USD", "EUR", "GBP"]
}

// When suggestion_type is "invalid":
{
  "reply": "That action is not supported. Here are valid alternatives:",
  "suggestion_type": "invalid",
  "suggestions": [ ... ]
}

CRITICAL RULES:
- ALWAYS include "suggestions" array (2-4 items) when suggestion_type is "advice" or "invalid".
- ALWAYS include "options" string array alongside "suggestions" for backward-compat with the browser overlay (derive it from suggestions: "ACTION → target").
- When suggestion_type="valid", include ONLY "reply" and "proposed_step" (no suggestions array).
- Output ONLY valid JSON. No markdown, no explanation outside JSON.
- proposed_step.opType MUST be one of: "insert", "update", "delete".
`


// ─── Step parser — extracts proposed steps from AI text ───────────────────────

const VALID_ACTIONS = ['NAVIGATE','CLICK','TYPE','SELECT','LOOKUP','WAIT',
  'ASSERT_TEXT','ASSERT_VISIBLE','ASSERT_URL','ASSERT_TOAST','CHECKBOX','SCROLL','HOVER']

/**
 * Extracts a proposed step from a plain-text AI reply when the LLM failed to
 * include a structured proposed_step object. Used as a fallback.
 */
function extractStepFromText(text: string): ProposedStep | null {
  // NAVIGATE
  const navRe = /navigat\w*\s+(?:step\s+)?to\s+['"]?(\/[\w\-./?#=&%]*|https?:\/\/[\w\-./~:?#=&%]+)['"]?/i
  const navM  = text.match(navRe)
  if (navM) {
    const url = navM[1]
    return { action: 'NAVIGATE', target: url, value: '', label: `Navigate to ${url}` }
  }

  // LOOKUP / SELECT targeting field
  const lookRe = /(?:LOOKUP|SELECT)\s+(?:\S+\s+){0,5}?(?:the\s+)?['"]?([A-Za-z][A-Za-z ]{2,30}?)['"]?\s*field/i
  const lookM  = text.match(lookRe)
  if (lookM) {
    const field = lookM[1].trim()
    return { action: 'LOOKUP', target: field, value: '', label: `Lookup / Select "${field}"` }
  }

  // fill in / populate field
  const fillRe = /(?:fill\s+in|populate|enter|select)\s+(?:the\s+)?['"]?([A-Za-z][A-Za-z ]{1,30}?)['"]?\s*(?:field|dropdown|input)/i
  const fillM  = text.match(fillRe)
  if (fillM) {
    const field = fillM[1].trim()
    return { action: 'LOOKUP', target: field, value: '', label: `Lookup / Select "${field}"` }
  }

  // add a CLICK step
  const clickRe = /(?:add\s+a?\s*)?CLICK\s+step\s+(?:to\s+)?['"+]?([A-Za-z+][A-Za-z0-9 +\-_]{1,40}?)['"]?(?:\s|$|[.,!?])/i
  const clickM  = text.match(clickRe)
  if (clickM) {
    const tgt = clickM[1].trim()
    return { action: 'CLICK', target: tgt, value: '', label: `Click "${tgt}"` }
  }

  return null
}

/**
 * When the user confirms ("yes", "ok", "insert", etc.) look back through the
 * chat history to find the most recently discussed proposed step, so we can
 * re-use it in the proposed_step field.
 */
function extractLastProposedStepFromHistory(chatHistory: ChatMsg[]): ProposedStep | null {
  // Walk backwards through assistant messages looking for a step description
  const assistantMsgs = [...chatHistory].reverse().filter(m => m.role === 'assistant')
  for (const msg of assistantMsgs) {
    const step = extractStepFromText(msg.content)
    if (step) return step
  }
  return null
}

/** Returns true if the user message is a simple confirmation */
function isConfirmation(text: string): boolean {
  return /^(yes|ok|okay|sure|go ahead|do it|insert|add it|add this|apply|confirm|proceed|that'?s? (right|correct|fine)|perfect|good|great|sounds? good|please|yep|yup|👍)[\s.!]*$/i.test(text.trim())
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function loadContext(testCaseId: string, pausedStep: number | null) {
  const testCase = await prisma.test_cases.findUnique({
    where:  { id: testCaseId },
    select: { id: true, name: true, steps: true, project_id: true },
  })
  if (!testCase) throw { statusCode: 404, message: 'Test case not found' }

  const steps = (testCase.steps as any[]) ?? []
  const stepIndex = pausedStep != null ? pausedStep - 1 : -1
  const pausedStepObj = stepIndex >= 0 ? steps[stepIndex] : null

  return { testCase, steps, pausedStepObj }
}

function buildPrompt(
  testCaseName: string,
  steps:        any[],
  pausedStep:   number | null,
  pausedStepObj: any | null,
  errorMessage: string | null,
  chatHistory:  ChatMsg[],
): string {
  const stepsJson = JSON.stringify(
    steps.map((s, i) => ({ stepNumber: i + 1, ...s })),
    null, 2
  )

  const chatHistoryText = chatHistory
    .slice(-8)
    .map(m => `${m.role === 'user' ? 'User' : 'NEXUS'}: ${m.content}`)
    .join('\n')

  const pausedStepDetail = pausedStepObj
    ? `action=${pausedStepObj.action}, target="${pausedStepObj.target}", value="${pausedStepObj.value}"`
    : 'Unknown step'

  return HITL_SYSTEM_PROMPT
    .replace('{test_case_name}',     testCaseName ?? 'Untitled')
    .replace('{all_steps}',          stepsJson)
    .replace('{paused_step}',        String(pausedStep ?? '?'))
    .replace('{paused_step_detail}', pausedStepDetail)
    .replace('{error_message}',      errorMessage ?? 'No error message available')
    .replace('{chat_history}',       chatHistoryText || '(no prior messages)')
    .replace('{learnings_block}',    '')  // filled in by callers
}

async function callLlm(systemPrompt: string, userMessage: string): Promise<HitlAiResponse> {
  const llm    = buildLlm()
  const parser = new StringOutputParser()

  const messages = [
    new SystemMessage(systemPrompt),
    new HumanMessage(`${userMessage}\n\nRespond with ONLY valid JSON.`),
  ]

  let raw: string
  try {
    raw = await llm.pipe(parser).invoke(messages)
  } catch (err) {
    log.error({ err }, '[HITL-AI] LLM call failed')
    throw { statusCode: 503, message: 'AI service unavailable. Please try again.' }
  }

  raw = raw.trim()
  // Strip any accidental markdown code fences
  if (raw.startsWith('```')) {
    raw = raw.split('\n').filter((l: string) => !l.trim().startsWith('```')).join('\n').trim()
  }

  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    log.warn({ raw }, '[HITL-AI] Failed to parse LLM JSON — using fallback')
    return {
      reply:           'I had trouble analysing that. Could you describe what you see in the browser?',
      suggestion_type: 'clarify',
      quick_replies:   ['Element not found', 'Data already exists', 'Page did not load'],
    }
  }

  // Normalise proposed_step from LLM (validate action is known)
  let proposedStep: ProposedStep | undefined
  if (parsed.proposed_step && typeof parsed.proposed_step === 'object') {
    const ps = parsed.proposed_step
    const action = (ps.action || 'NAVIGATE').toUpperCase()
    const opType = ['insert', 'update', 'delete'].includes(ps.opType) ? ps.opType : 'insert'
    if (VALID_ACTIONS.includes(action)) {
      proposedStep = {
        action,
        target: String(ps.target || ''),
        value:  String(ps.value  || ''),
        label:  String(ps.label  || `${action} → ${ps.target}`),
        opType,
      }
    }
  }

  // Parse structured suggestions array from LLM
  let suggestions: SuggestionOption[] | undefined
  if (Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0) {
    suggestions = parsed.suggestions
      .filter((s: any) => s && typeof s === 'object' && s.action)
      .slice(0, 4)
      .map((s: any) => ({
        label:  String(s.label  || `${s.action} → ${s.target}`),
        action: (s.action || 'NAVIGATE').toUpperCase(),
        target: String(s.target || ''),
        value:  String(s.value  || ''),
        opType: ['insert', 'update', 'delete'].includes(s.opType) ? s.opType : 'insert',
      } as SuggestionOption))

    // Derive legacy options strings from suggestions for backward-compat with browser overlay
    if (!Array.isArray(parsed.options) || parsed.options.length === 0) {
      parsed.options = suggestions!.map(s =>
        s.value ? `${s.action} '${s.value}' into ${s.target}` : `${s.action} → ${s.target}`
      )
    }
  }

  return {
    reply:            parsed.reply            || 'Let me know what you see and I will help.',
    suggestion_type:  parsed.suggestion_type  || 'advice',
    suggested_action: parsed.suggested_action,
    quick_replies:    Array.isArray(parsed.quick_replies) ? parsed.quick_replies.slice(0, 4) : undefined,
    suggestions,
    options:          Array.isArray(parsed.options) ? parsed.options.slice(0, 4) : undefined,
    proposed_step:    proposedStep,
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Called once when the HITL panel opens — generates the AI's automatic first
 * analysis message without any user input.
 */
export async function hitlAnalyze(req: HitlAnalyzeRequest): Promise<HitlAiResponse> {
  const { runId, testCaseId, pausedStep, errorMessage } = req
  log.info({ testCaseId, pausedStep, errorMessage }, '[HITL-AI] Analyzing paused step')

  // Check if we have pre-calculated suggestions in the context store
  const cachedContext = hitlContextStore.get(runId)
  if (cachedContext && cachedContext.structuredSuggestions && cachedContext.structuredSuggestions.length > 0) {
    log.info({ runId }, '[HITL-AI] Found pre-calculated structured suggestions in context store')
    // Construct options string array for backward compatibility
    const options = cachedContext.structuredSuggestions.map(s =>
      s.value ? `${s.action} '${s.value}' into ${s.target}` : `${s.action} → ${s.target}`
    )
    return {
      reply: `Step ${pausedStep ?? '?'} failed: "${errorMessage ?? 'Unknown error'}".\n\n${cachedContext.reason}`,
      suggestion_type: 'advice',
      suggested_action: cachedContext.reason,
      suggestions: cachedContext.structuredSuggestions,
      options,
      quick_replies: ['Skip this step', 'Delete this step']
    }
  }

  const { testCase, steps, pausedStepObj } = await loadContext(testCaseId, pausedStep)

  const projectId = testCase.project_id ?? ''
  const learnings = await loadLearnings(projectId, testCaseId).catch(() => [])
  const learningsBlock = formatLearningsBlock(learnings)

  const systemPrompt = buildPrompt(
    testCase.name ?? 'Untitled',
    steps,
    pausedStep,
    pausedStepObj,
    errorMessage,
    [],
  ).replace('{learnings_block}', learningsBlock)

  const userMessage = `
The test has just paused at step ${pausedStep ?? '?'}.
Error: "${errorMessage ?? 'No error message'}"
Please analyse this error and suggest 2-4 concrete resolution options the human can choose from.
`

  return callLlm(systemPrompt, userMessage)
}

/**
 * Called for every user turn in the HITL chat. Evaluates the user's proposed
 * fix and responds with valid / clarify / invalid classification.
 *
 * Key behaviour: when the user confirms a previously discussed step
 * ("yes", "ok insert", etc.), this function:
 *  1. Tries to use the AI to generate a structured proposed_step
 *  2. Falls back to extracting the step from recent chat history
 * Either way, the response includes proposed_step so the UI can show
 * the "✓ Accept & Resume Testing" button immediately.
 */
export async function hitlChat(req: HitlChatRequest): Promise<HitlAiResponse> {
  const { testCaseId, pausedStep, errorMessage, instruction, chatHistory } = req
  log.info({ testCaseId, pausedStep, instruction }, '[HITL-AI] Chat turn received')

  const { testCase, steps, pausedStepObj } = await loadContext(testCaseId, pausedStep)

  const projectId = testCase.project_id ?? ''
  const learnings = await loadLearnings(projectId, testCaseId).catch(() => [])
  const learningsBlock = formatLearningsBlock(learnings)

  const systemPrompt = buildPrompt(
    testCase.name ?? 'Untitled',
    steps,
    pausedStep,
    pausedStepObj,
    errorMessage,
    chatHistory,
  ).replace('{learnings_block}', learningsBlock)

  // ── Fast path: user is just confirming ──────────────────────────────────────
  // Skip the LLM round-trip: build the response from the chat history.
  if (isConfirmation(instruction)) {
    const histStep = extractLastProposedStepFromHistory(chatHistory)
    if (histStep) {
      log.info({ histStep }, '[HITL-AI] User confirmed — returning proposed_step from history')
      return {
        reply:           `Got it! I'll insert a ${histStep.action} step (${histStep.label}) before step ${pausedStep ?? '?'}. Click "Accept & Resume Testing" below to apply it now.`,
        suggestion_type: 'valid',
        proposed_step:   histStep,
      }
    }
  }

  // ── Normal path: call the LLM ───────────────────────────────────────────────
  const userMessage = `User says: "${instruction}"

Evaluate this suggestion:
- If it's a clear confirmation of an earlier option, set suggestion_type="valid" and include proposed_step.
- If it's a new idea, evaluate it. If valid, set suggestion_type="valid" and include proposed_step.
- If unclear, set suggestion_type="clarify".
- If invalid, set suggestion_type="invalid" and provide corrected options.`

  const response = await callLlm(systemPrompt, userMessage)

  // ── Fallback: if AI returned "valid" but no proposed_step, extract it ───────
  if (response.suggestion_type === 'valid' && !response.proposed_step) {
    // Try to extract from the AI's reply text
    const fromReply = extractStepFromText(response.reply)
    if (fromReply) {
      response.proposed_step = fromReply
    } else {
      // Fall back to the most recent step from chat history
      const fromHistory = extractLastProposedStepFromHistory(chatHistory)
      if (fromHistory) response.proposed_step = fromHistory
    }

    // If we still found a proposed_step, enhance the reply
    if (response.proposed_step) {
      response.reply = response.reply.trim()
      if (!response.reply.includes('Accept')) {
        response.reply += ` Click "Accept & Resume Testing" below to apply this step.`
      }
    }
  }

  log.info(
    { suggestion_type: response.suggestion_type, has_proposed_step: !!response.proposed_step },
    '[HITL-AI] Chat response ready',
  )
  return response
}
