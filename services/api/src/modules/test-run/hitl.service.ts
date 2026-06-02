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
 *
 * Design decisions (Option A confirmed by user):
 *   - AI gives advice; the human performs the action manually in the browser.
 *   - No automatic step patching from HITL — the user may optionally save fixes
 *     via the existing NEXUS panel after resuming.
 *   - Error is read from the `.error` field of the failing log entry.
 */
import { ChatOpenAI }                       from '@langchain/openai'
import { ChatAnthropic }                    from '@langchain/anthropic'
import { HumanMessage, SystemMessage }      from '@langchain/core/messages'
import { StringOutputParser }               from '@langchain/core/output_parsers'
import type { BaseChatModel }               from '@langchain/core/language_models/chat_models'

import prisma                               from '../../shared/db/prisma.js'
import { createModuleLogger }               from '../../shared/logger/index.js'

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

export interface HitlAiResponse {
  reply:             string
  suggestion_type:   'advice' | 'valid' | 'clarify' | 'invalid'
  /** Human-readable action the user should take in the browser */
  suggested_action?: string
  /** Quick-reply chips to surface as buttons */
  quick_replies?:    string[]
}

// ─── LLM factory (mirrors nexus.service.ts) ───────────────────────────────────

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
A test has PAUSED because a step failed. Your job is to help the human understand the error and
decide what to do — the human will then perform the corrective action manually in the browser before
clicking Resume.

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

═══════════════════════════════════════════════════════════════════
YOUR ROLE
═══════════════════════════════════════════════════════════════════

1. Analyse the error message and the paused step's context.
2. Give the human a clear, actionable suggestion for what to do in the browser.
3. When the human proposes their own fix (NLP input), evaluate it:
   - VALID   → confirm it sounds correct, describe exactly what to do in the browser
   - CLARIFY → ask one concise follow-up question to understand intent
   - INVALID → explain why it won't work, give a better alternative

Keep responses short and practical (2–4 sentences max). No waffle.

IMPORTANT RULES:
- You do NOT modify test steps directly — the human acts in the browser, then clicks Resume.
- Do NOT suggest actions outside the supported set: NAVIGATE CLICK TYPE SELECT ASSERT_TEXT WAIT CHECKBOX LOOKUP ASSERT_VISIBLE ASSERT_URL ASSERT_TOAST.
- If the error suggests a data-uniqueness issue (e.g. "already exists"), suggest using different test data.
- If the error is a locator/element-not-found issue, suggest checking if the page loaded correctly or if the element has a different label.
- If the error is an assertion failure, suggest what the actual vs expected value discrepancy might mean.

═══════════════════════════════════════════════════════════════════
OUTPUT FORMAT — respond with ONLY valid JSON (no markdown, no code fences)
═══════════════════════════════════════════════════════════════════

{
  "reply": "Short, helpful message to show in the chat bubble (2-4 sentences, plain text)",
  "suggestion_type": "advice" | "valid" | "clarify" | "invalid",
  "suggested_action": "One sentence describing exactly what to do in the browser right now (omit if clarify)",
  "quick_replies": ["chip 1", "chip 2"]   // 2-3 short buttons the user can click to reply quickly
}

IMPORTANT: Output ONLY valid JSON. No markdown, no explanation outside JSON.
`

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function loadContext(testCaseId: string, pausedStep: number | null) {
  const testCase = await prisma.test_cases.findUnique({
    where:  { id: testCaseId },
    select: { id: true, name: true, steps: true },
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

  let parsed: HitlAiResponse
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

  return {
    reply:            parsed.reply            || 'Let me know what you see and I will help.',
    suggestion_type:  parsed.suggestion_type  || 'advice',
    suggested_action: parsed.suggested_action,
    quick_replies:    Array.isArray(parsed.quick_replies) ? parsed.quick_replies.slice(0, 3) : undefined,
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Called once when the HITL panel opens — generates the AI's automatic first
 * analysis message without any user input.
 */
export async function hitlAnalyze(req: HitlAnalyzeRequest): Promise<HitlAiResponse> {
  const { testCaseId, pausedStep, errorMessage } = req
  log.info({ testCaseId, pausedStep, errorMessage }, '[HITL-AI] Analyzing paused step')

  const { testCase, steps, pausedStepObj } = await loadContext(testCaseId, pausedStep)
  const systemPrompt = buildPrompt(
    testCase.name ?? 'Untitled',
    steps,
    pausedStep,
    pausedStepObj,
    errorMessage,
    [],
  )

  const userMessage = `
The test has just paused at step ${pausedStep ?? '?'}.
Error: "${errorMessage ?? 'No error message'}"
Please analyse this error and suggest what the human should do in the browser to fix it before clicking Resume.
`

  return callLlm(systemPrompt, userMessage)
}

/**
 * Called for every user turn in the HITL chat. Evaluates the user's proposed
 * fix and responds with valid / clarify / invalid classification.
 */
export async function hitlChat(req: HitlChatRequest): Promise<HitlAiResponse> {
  const { testCaseId, pausedStep, errorMessage, instruction, chatHistory } = req
  log.info({ testCaseId, pausedStep }, '[HITL-AI] Chat turn received')

  const { testCase, steps, pausedStepObj } = await loadContext(testCaseId, pausedStep)
  const systemPrompt = buildPrompt(
    testCase.name ?? 'Untitled',
    steps,
    pausedStep,
    pausedStepObj,
    errorMessage,
    chatHistory,
  )

  const userMessage = `User says: "${instruction}"

Evaluate this suggestion. Is it a valid fix? If so, describe exactly what the human should do in the browser.`

  return callLlm(systemPrompt, userMessage)
}
