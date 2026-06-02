/**
 * Step Review Service — NLP-based single-step editing
 *
 * Allows users to modify individual test steps using natural language.
 * Powered by OpenAI GPT-4o-mini (same LLM infrastructure as generation.service.ts).
 *
 * Public interface:
 *   - reviewStep()  — parse NL instruction and return updated step
 *   - applyStepUpdate() — persist the updated step back to the DB
 */
import { ChatAnthropic }         from '@langchain/anthropic'
import { ChatOpenAI }            from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { StringOutputParser }    from '@langchain/core/output_parsers'
import type { BaseChatModel }    from '@langchain/core/language_models/chat_models'

import prisma                    from '../../shared/db/prisma.js'
import { createModuleLogger }    from '../../shared/logger/index.js'

const log = createModuleLogger('step-review')

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StepShape {
  id:           string
  action:       string
  target:       string
  value:        string
  locator_type?: string
  sf_field_type?: string
  [key: string]: unknown
}

export interface ChatMessage {
  role:    'user' | 'assistant'
  content: string
}

export interface ReviewStepRequest {
  testCaseId:  string
  stepIndex:   number   // 0-based
  instruction: string
  chatHistory: ChatMessage[]
}

export interface ReviewStepResponse {
  reply:        string
  updatedStep:  StepShape | null
  applied:      boolean
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const STEP_REVIEW_SYSTEM_PROMPT = `
You are an expert QA Automation Engineer assistant helping a user edit a single Playwright test step using natural language.

The user will describe what change they want to make to a specific test step. You must:
1. Parse the user's natural language instruction
2. Apply it to the CURRENT STEP shown below
3. Return an updated step JSON AND a short human-readable reply

IMPORTANT RULES:
- Only modify the step fields that the instruction refers to
- Keep all other fields exactly as they are in the CURRENT STEP
- Preserve the step "id" field exactly — never change it
- All action values must be UPPERCASE (e.g. CLICK, TYPE, NAVIGATE, WAIT, SELECT, ASSERT_TEXT, ASSERT_URL, ASSERT_TOAST, CHECKBOX, LOOKUP)
- locator_type must be one of: "role", "label", "text", "placeholder", "css"
- For WAIT steps: value must be a number in seconds as string (e.g. "3")
- For NAVIGATE steps: value is a relative URL path, target should be empty
- For role locators: target format is "role=button, name=Submit"
- For label locators: target is the field label text

SUPPORTED ACTIONS:
- NAVIGATE  — navigate to a URL path (value = path, target = "")
- CLICK     — click an element (target = locator, locator_type = "role" preferred)
- TYPE      — type text into a field (target = field label, value = text, locator_type = "label")
- SELECT    — select a dropdown option (target = field label, value = option, locator_type = "label")
- ASSERT_TEXT — assert text is visible (target = container locator, value = expected text)
- ASSERT_URL  — assert the current URL path (value = expected path, target = "")
- ASSERT_TOAST — assert toast/notification text (value = expected text, target = "")
- WAIT     — wait N seconds (value = seconds as string, target = "")
- CHECKBOX  — check/uncheck a checkbox (target = label, value = "true" or "false")
- LOOKUP    — search a lookup field (target = field label, value = search term)

COMMON INSTRUCTIONS AND HOW TO HANDLE THEM:
- "Change value to X" → update the 'value' field only
- "Change target to X" → update the 'target' field only  
- "Change action to X" → update the 'action' field only (must be a valid UPPERCASE action)
- "Update locator to X" → update 'target' and 'locator_type' fields
- "Make this click X button" → change action to CLICK, target to "role=button, name=X", locator_type to "role"
- "Add a 3 second wait" → this is a request to insert a wait AFTER the current step; reply that you cannot insert steps, only edit the current one, but offer to change this step to a WAIT
- "Convert to negative test" → interpret the step as a negative scenario (e.g. verify an error appears)
- "Make this use role locator" → change target to a role-based locator and set locator_type to "role"

CURRENT STEP (JSON):
{current_step}

CHAT HISTORY:
{chat_history}

OUTPUT FORMAT — respond with ONLY valid JSON (no markdown, no code fences):
{
  "reply": "Short human-readable explanation of what you changed (1-2 sentences)",
  "updatedStep": {
    "id": "<same as input>",
    "action": "UPPERCASE_ACTION",
    "target": "locator target",
    "value": "step value",
    "locator_type": "role|label|text|placeholder|css"
  }
}

If the instruction is ambiguous or unclear, return:
{
  "reply": "I need more information. Could you clarify [specific question]?",
  "updatedStep": null
}

If the user is asking a question rather than requesting a change, return:
{
  "reply": "Your answer here",
  "updatedStep": null
}

IMPORTANT: Output ONLY valid JSON. No explanations outside the JSON structure.
`

// ─── LLM factory (reuses same pattern as generation.service.ts) ───────────────

function buildLlm(provider = 'openai'): BaseChatModel {
  if (provider === 'openai') {
    return new ChatOpenAI({
      apiKey:      process.env.OPENAI_API_KEY,
      model:       'gpt-4o-mini',
      temperature: 0.3,
    })
  }
  // Fallback: Anthropic Claude (only if ANTHROPIC_API_KEY is configured)
  return new ChatAnthropic({
    apiKey:    process.env.ANTHROPIC_API_KEY,
    model:     process.env.CLAUDE_MODEL ?? (process.env.LLM_MODEL ?? 'claude-sonnet-4-5'),
    maxTokens: 2048,
    temperature: 0.3,
  })
}

// ─── Core service functions ───────────────────────────────────────────────────

/**
 * Parse a natural language instruction and return an updated step.
 * Does NOT write to DB — call applyStepUpdate() to persist.
 */
export async function reviewStep(req: ReviewStepRequest): Promise<ReviewStepResponse> {
  const { testCaseId, stepIndex, instruction, chatHistory } = req

  // 1. Fetch the test case and find the step
  const testCase = await prisma.test_cases.findUnique({
    where:  { id: testCaseId },
    select: { id: true, steps: true },
  })
  if (!testCase) throw { statusCode: 404, message: 'Test case not found' }

  const steps = (testCase.steps as unknown as StepShape[]) ?? []
  if (stepIndex < 0 || stepIndex >= steps.length) {
    throw { statusCode: 400, message: `Step index ${stepIndex} is out of range (test has ${steps.length} steps)` }
  }

  const currentStep = steps[stepIndex]

  // 2. Build the system prompt with current step context
  const chatHistoryText = chatHistory
    .slice(-8)  // last 8 turns for context window efficiency
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n')

  const systemPrompt = STEP_REVIEW_SYSTEM_PROMPT
    .replace('{current_step}', JSON.stringify(currentStep, null, 2))
    .replace('{chat_history}', chatHistoryText || '(no prior messages)')

  // 3. Call LLM
  const llm    = buildLlm('openai')
  const parser = new StringOutputParser()

  const messages = [
    new SystemMessage(systemPrompt),
    new HumanMessage(
      `User instruction: "${instruction}"\n\nIMPORTANT: Respond with ONLY valid JSON. No markdown.`
    ),
  ]

  let raw: string
  try {
    raw = await llm.pipe(parser).invoke(messages)
  } catch (err) {
    log.error({ err }, '[STEP-REVIEW] LLM call failed')
    throw { statusCode: 503, message: 'AI service unavailable. Please try again.' }
  }

  // 4. Parse LLM response
  raw = raw.trim()
  if (raw.startsWith('```')) {
    raw = raw.split('\n').filter((l: string) => !l.trim().startsWith('```')).join('\n')
  }

  let parsed: { reply: string; updatedStep: StepShape | null }
  try {
    parsed = JSON.parse(raw)
  } catch {
    log.warn({ raw }, '[STEP-REVIEW] Failed to parse LLM JSON response')
    return {
      reply:       'I had trouble processing that. Could you rephrase your instruction?',
      updatedStep: null,
      applied:     false,
    }
  }

  return {
    reply:       parsed.reply || 'Done.',
    updatedStep: parsed.updatedStep ?? null,
    applied:     false,
  }
}

/**
 * Atomically replace a single step in the DB.
 * Only the step at stepIndex is modified — all other steps remain untouched.
 */
export async function applyStepUpdate(
  testCaseId: string,
  stepIndex:  number,
  updatedStep: StepShape,
): Promise<{ success: boolean; updatedStepCount: number }> {
  const testCase = await prisma.test_cases.findUnique({
    where:  { id: testCaseId },
    select: { id: true, steps: true },
  })
  if (!testCase) throw { statusCode: 404, message: 'Test case not found' }

  const steps = (testCase.steps as unknown as StepShape[]) ?? []
  if (stepIndex < 0 || stepIndex >= steps.length) {
    throw { statusCode: 400, message: `Step index ${stepIndex} is out of range` }
  }

  // Atomically replace ONLY the target step
  const newSteps = steps.map((s, i) => (i === stepIndex ? { ...s, ...updatedStep } : s))

  await prisma.test_cases.update({
    where: { id: testCaseId },
    data:  { steps: newSteps as object[] },
  })

  log.info(
    `[STEP-REVIEW] Applied update to testCase=${testCaseId} stepIndex=${stepIndex} ` +
    `action=${updatedStep.action} target="${updatedStep.target}"`
  )

  return { success: true, updatedStepCount: 1 }
}
