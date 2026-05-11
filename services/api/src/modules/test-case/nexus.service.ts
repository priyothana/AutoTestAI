/**
 * NEXUS AI Assistant Service
 * General-purpose test case assistant — can read/edit ANY step by number.
 * Includes a safety-validation layer that blocks harmful/illogical requests
 * and offers smart alternatives instead of blindly applying them.
 */
import { ChatOpenAI }            from '@langchain/openai'
import { ChatAnthropic }         from '@langchain/anthropic'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { StringOutputParser }    from '@langchain/core/output_parsers'
import type { BaseChatModel }    from '@langchain/core/language_models/chat_models'

import prisma                    from '../../shared/db/prisma.js'
import { createModuleLogger }    from '../../shared/logger/index.js'

const log = createModuleLogger('nexus')

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StepShape {
  id:            string
  action:        string
  target:        string
  value:         string
  locator_type?: string
  sf_field_type?: string
  [key: string]: unknown
}

export interface ChatMsg {
  role:    'user' | 'assistant'
  content: string
}

export interface NexusChatRequest {
  testCaseId:  string
  instruction: string
  chatHistory: ChatMsg[]
}

export interface StepUpdate {
  stepIndex: number   // 0-based
  updatedStep: StepShape
  deleted?: boolean   // true when the step should be removed
}

export interface NexusChatResponse {
  reply:        string
  stepUpdates:  StepUpdate[]   // may be empty if just answering a question
  isWarning?:   boolean        // true when NEXUS blocked a risky request
  suggestions?: string[]       // 1-3 safe alternatives (present only when isWarning=true)
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const NEXUS_SYSTEM_PROMPT = `
You are NEXUS, an expert QA Automation Engineer AI assistant embedded in the AutoTest AI platform.
You help users understand and modify test steps using natural language — but you are also a
SAFETY GUARDIAN that protects test integrity.

ALL STEPS IN THE CURRENT TEST CASE (JSON array, 0-indexed):
{all_steps}

TEST CASE NAME: {test_case_name}

RECENT CHAT HISTORY:
{chat_history}

═══════════════════════════════════════════════════════════════════
SAFETY VALIDATION — MANDATORY FIRST STEP BEFORE EVERY RESPONSE
═══════════════════════════════════════════════════════════════════

Before making ANY change, classify the request as VALID or RISKY/INVALID.

🔴 RISKY / INVALID — BLOCK and WARN (set isWarning=true, stepUpdates=[]):
  1. Delete ALL steps at once (e.g. "delete all steps", "clear all steps", "remove everything")
  2. Remove a required/critical field step (fields like Account, Opportunity Name, Stage, Close Date,
     Name, Email, Phone, Required Field — anything whose label/target suggests it is mandatory)
  3. Change locator_type to an unstable strategy for no reason (e.g. switch from "label"/"role" to
     raw "css" or "xpath" without the user providing a selector)
  4. Add an unsupported action type (anything outside: NAVIGATE CLICK TYPE SELECT ASSERT_TEXT
     ASSERT_URL ASSERT_TOAST WAIT CHECKBOX LOOKUP ASSERT_VISIBLE)
  5. Remove a NAVIGATE step that is the first step (breaks the entire test flow)
  6. Delete a step that is directly referenced by a later assertion (would break the assertion)
  7. Requests that would result in zero steps remaining in the test case
  8. Bypass or remove assertion/validation steps without a clear reason
  9. Set a WAIT value to more than 30 seconds (unrealistic / hanging tests)
 10. Replace a structured locator with obviously incorrect/random text

✅ VALID — proceed normally (set isWarning=false or omit it):
  - Change a value in any step
  - Update a single step's action/target/value to something reasonable
  - Add a new step (WAIT, CLICK, TYPE, NAVIGATE, etc.) with sensible parameters
  - Delete a single non-critical step
  - Explain or describe any step
  - Suggest improvements
  - Make a step a negative test case variant

═══════════════════════════════════════════════════════════════════
YOUR CAPABILITIES
═══════════════════════════════════════════════════════════════════
- Answer questions about any step ("Why is step 3 clicking X?")
- Modify one or more steps by step number ("Change step 2 value to Acme Corp")
- DELETE a single step by step number ("Delete step 6", "Remove step 3")
- Explain what a step does
- Suggest improvements
- Make steps negative tests

STEP FIELD RULES:
- action: UPPERCASE — NAVIGATE, CLICK, TYPE, SELECT, ASSERT_TEXT, ASSERT_URL, ASSERT_TOAST, WAIT, CHECKBOX, LOOKUP, ASSERT_VISIBLE
- locator_type: one of "role", "label", "text", "placeholder", "css"
- WAIT: value = seconds as string (e.g. "3"), target = ""
- NAVIGATE: value = URL path, target = ""
- CLICK role: target = "role=button, name=ButtonLabel"
- TYPE/SELECT/LOOKUP: target = field label, locator_type = "label"

IMPORTANT: When referring to steps, users use 1-based numbering ("step 1" = index 0 in the array).

═══════════════════════════════════════════════════════════════════
FEW-SHOT EXAMPLES — BLOCKED REQUESTS
═══════════════════════════════════════════════════════════════════

EXAMPLE 1 — Delete all steps:
User: "Delete all steps"
Response:
{
  "reply": "⚠️ Warning: Deleting all steps would completely destroy the test case, leaving nothing to execute. This action cannot be undone and would make the test immediately fail.",
  "stepUpdates": [],
  "isWarning": true,
  "suggestions": [
    "Tell me which specific step(s) you want to remove (e.g. 'Delete step 4').",
    "If you want to start fresh, consider creating a new test case instead.",
    "I can help you restructure the existing steps — just describe what you need."
  ]
}

EXAMPLE 2 — Remove a required field:
User: "Remove the Account field from step 2"
Response:
{
  "reply": "⚠️ Warning: 'Account' is a required field for this test case. Removing it will very likely cause the test to fail during execution because the form cannot be submitted without it.",
  "stepUpdates": [],
  "isWarning": true,
  "suggestions": [
    "Keep the Account field and update its value to something valid (e.g. 'Acme Corp').",
    "If you want to test a negative scenario where Account is missing, I can create a separate negative test case for you.",
    "I can add an assertion after the Account step to verify the field is present and filled."
  ]
}

EXAMPLE 3 — Unsupported action:
User: "Add a DRAG_AND_DROP step to move the row"
Response:
{
  "reply": "⚠️ Warning: DRAG_AND_DROP is not a supported action type in AutoTest AI. Using it would cause a test execution error.",
  "stepUpdates": [],
  "isWarning": true,
  "suggestions": [
    "I can add a CLICK step to select the item and another CLICK step to drop it if the UI supports keyboard interactions.",
    "If the goal is to reorder rows, consider using a SELECT or TYPE step targeting a sort/order field.",
    "Let me know the exact UI interaction and I will design the best supported step sequence."
  ]
}

EXAMPLE 4 — Remove the first NAVIGATE step:
User: "Delete step 1"
Response (when step 1 is a NAVIGATE):
{
  "reply": "⚠️ Warning: Step 1 is a NAVIGATE step that opens the application URL. Removing it will break the entire test — the browser will have no URL to start from and every subsequent step will fail.",
  "stepUpdates": [],
  "isWarning": true,
  "suggestions": [
    "Keep step 1 but update the URL if it is pointing to the wrong page.",
    "If you want to change where the test begins, update the value of step 1 with the correct path.",
    "Tell me what you are trying to achieve and I will find the safest way to adjust the flow."
  ]
}

EXAMPLE 5 — Delete all at once with slight rephrasing:
User: "Clear the test steps"
Response:
{
  "reply": "⚠️ Warning: Clearing all test steps will make this test case empty and unable to execute. This is a destructive operation that cannot be reversed.",
  "stepUpdates": [],
  "isWarning": true,
  "suggestions": [
    "Tell me the specific step number(s) you want to remove.",
    "If you want a completely fresh test, I recommend creating a new test case.",
    "I can help you redesign the test flow — describe what the new flow should look like."
  ]
}

═══════════════════════════════════════════════════════════════════
OUTPUT FORMAT — respond with ONLY valid JSON (no markdown, no code fences)
═══════════════════════════════════════════════════════════════════

For a VALID request (normal change):
{
  "reply": "Short human-readable explanation (1-3 sentences)",
  "stepUpdates": [
    {
      "stepIndex": 0,
      "updatedStep": {
        "id": "<preserve exact id from input>",
        "action": "UPPERCASE_ACTION",
        "target": "locator",
        "value": "value",
        "locator_type": "label"
      }
    }
  ]
}

To DELETE a single step, include "deleted": true:
{
  "reply": "Step 6 has been deleted from the test case.",
  "stepUpdates": [
    {
      "stepIndex": 5,
      "deleted": true,
      "updatedStep": { "id": "<exact id of step to delete>", "action": "", "target": "", "value": "" }
    }
  ]
}

For a RISKY / BLOCKED request (isWarning = true):
{
  "reply": "⚠️ Warning: <clear explanation of the risk and impact>",
  "stepUpdates": [],
  "isWarning": true,
  "suggestions": [
    "<Safe alternative 1>",
    "<Safe alternative 2>",
    "<Safe alternative 3>"
  ]
}

For a question / explanation (no changes):
{
  "reply": "Your answer here",
  "stepUpdates": []
}

IMPORTANT: Output ONLY valid JSON. No explanations outside the JSON structure. Preserve the "id" field exactly.
`

// ─── LLM factory ──────────────────────────────────────────────────────────────

function buildLlm(): BaseChatModel {
  if (process.env.OPENAI_API_KEY) {
    return new ChatOpenAI({
      apiKey:      process.env.OPENAI_API_KEY,
      model:       'gpt-4o-mini',
      temperature: 0.3,
    })
  }
  return new ChatAnthropic({
    apiKey:    process.env.ANTHROPIC_API_KEY,
    model:     process.env.LLM_MODEL ?? 'claude-sonnet-4-5',
    maxTokens: 2048,
    temperature: 0.3,
  })
}

// ─── Core function ────────────────────────────────────────────────────────────

export async function nexusChat(req: NexusChatRequest): Promise<NexusChatResponse> {
  const { testCaseId, instruction, chatHistory } = req

  const testCase = await prisma.test_cases.findUnique({
    where:  { id: testCaseId },
    select: { id: true, name: true, steps: true },
  })
  if (!testCase) throw { statusCode: 404, message: 'Test case not found' }

  const steps = (testCase.steps as unknown as StepShape[]) ?? []

  const chatHistoryText = chatHistory
    .slice(-10)
    .map(m => `${m.role === 'user' ? 'User' : 'NEXUS'}: ${m.content}`)
    .join('\n')

  const systemPrompt = NEXUS_SYSTEM_PROMPT
    .replace('{all_steps}', JSON.stringify(
      steps.map((s, i) => ({ stepNumber: i + 1, ...s })),
      null, 2
    ))
    .replace('{test_case_name}', testCase.name ?? 'Untitled')
    .replace('{chat_history}', chatHistoryText || '(no prior messages)')

  const llm    = buildLlm()
  const parser = new StringOutputParser()

  const messages = [
    new SystemMessage(systemPrompt),
    new HumanMessage(
      `User: "${instruction}"\n\nIMPORTANT: Apply safety validation FIRST. Respond with ONLY valid JSON. No markdown.`
    ),
  ]

  let raw: string
  try {
    raw = await llm.pipe(parser).invoke(messages)
  } catch (err) {
    log.error({ err }, '[NEXUS] LLM call failed')
    throw { statusCode: 503, message: 'AI service unavailable. Please try again.' }
  }

  raw = raw.trim()
  if (raw.startsWith('```')) {
    raw = raw.split('\n').filter((l: string) => !l.trim().startsWith('```')).join('\n')
  }

  let parsed: NexusChatResponse
  try {
    parsed = JSON.parse(raw)
  } catch {
    log.warn({ raw }, '[NEXUS] Failed to parse LLM JSON')
    return { reply: 'I had trouble processing that. Could you rephrase?', stepUpdates: [] }
  }

  // ── Post-parse safety net ──────────────────────────────────────────────────
  // If the LLM somehow produced step deletions that would wipe out all steps,
  // override and block the response regardless of what the LLM decided.
  const stepUpdates = Array.isArray(parsed.stepUpdates) ? parsed.stepUpdates : []
  const deletedIndices = new Set(stepUpdates.filter(u => u.deleted).map(u => u.stepIndex))
  const remainingCount = steps.length - deletedIndices.size

  if (remainingCount <= 0 && steps.length > 0) {
    log.warn('[NEXUS] Safety net triggered: LLM attempted to delete all steps')
    return {
      reply: '⚠️ Warning: This request would delete all steps in the test case, leaving it empty and unable to run. NEXUS has blocked this action to protect the test.',
      stepUpdates: [],
      isWarning: true,
      suggestions: [
        'Tell me which specific step(s) you want to remove.',
        'If you want a fresh start, create a new test case instead.',
        'Describe what you want the test to do and I will redesign the steps safely.',
      ],
    }
  }

  return {
    reply:       parsed.reply || 'Done.',
    stepUpdates,
    isWarning:   parsed.isWarning === true ? true : undefined,
    suggestions: Array.isArray(parsed.suggestions) && parsed.suggestions.length
      ? parsed.suggestions
      : undefined,
  }
}

// ─── Apply multiple step updates atomically ───────────────────────────────────

export async function nexusApply(
  testCaseId: string,
  stepUpdates: StepUpdate[],
): Promise<{ success: boolean; updatedCount: number }> {
  const testCase = await prisma.test_cases.findUnique({
    where:  { id: testCaseId },
    select: { id: true, steps: true },
  })
  if (!testCase) throw { statusCode: 404, message: 'Test case not found' }

  const steps = (testCase.steps as unknown as StepShape[]) ?? []

  // Hard guard: block if the operation would delete all steps
  const deletedIndices = new Set(
    stepUpdates.filter(u => u.deleted).map(u => u.stepIndex)
  )
  if (steps.length > 0 && steps.length - deletedIndices.size <= 0) {
    throw { statusCode: 400, message: 'Cannot delete all steps. At least one step must remain.' }
  }

  const newSteps = steps
    .map((s, i) => {
      if (deletedIndices.has(i)) return null          // mark for removal
      const update = stepUpdates.find(u => u.stepIndex === i && !u.deleted)
      return update ? { ...s, ...update.updatedStep } : s
    })
    .filter((s): s is StepShape => s !== null)        // remove deleted steps

  await prisma.test_cases.update({
    where: { id: testCaseId },
    data:  { steps: newSteps as object[] },
  })

  const deletedCount = deletedIndices.size
  const updatedCount = stepUpdates.length - deletedCount
  log.info(`[NEXUS] Applied to testCase=${testCaseId}: ${updatedCount} update(s), ${deletedCount} deletion(s)`)
  return { success: true, updatedCount: stepUpdates.length }
}
