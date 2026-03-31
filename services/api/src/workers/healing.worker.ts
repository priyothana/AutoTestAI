/**
 * Healing Worker — BullMQ Consumer
 *
 * Consumes jobs from `healing-queue`.
 * Producer: execution.worker.ts (enqueues on test step failure)
 * Consumer: this file
 *
 * Pipeline per job:
 *   1. Build a LangChain.js vision chain with screenshot + HTML context
 *   2. Invoke LLM → parse { suggestedLocator, confidence, reasoning }
 *   3. Write HealingSuggestion to DB via healing.service.ts
 *   4. If confidence >= HEALING_THRESHOLD → auto-apply fix to test steps
 *   5. Enqueue to QUEUES.NOTIFICATION on completion
 *
 * LangChain.js uses the multimodal message format:
 *   - System: healing prompt
 *   - Human:  [image_url (base64), text (htmlSnippet + failedLocator)]
 *
 * This is the same chain pattern as Python test_healing_service.py.
 */
import 'dotenv/config'
import { Worker, Job, Queue } from 'bullmq'

import { ChatAnthropic }     from '@langchain/anthropic'
import { ChatOpenAI }         from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { StringOutputParser } from '@langchain/core/output_parsers'

import { QUEUES }             from '../shared/queue/queues.js'
import { getRedisOptions }    from '../shared/queue/connection.js'
import { createModuleLogger } from '../shared/logger/index.js'
import type { HealingJob, NotificationJob } from '../shared/queue/job-types.js'

// Cross-module import: only .service.ts (SKILL.md boundary rule)
import {
  saveHealingSuggestion,
  applyHealingSuggestion,
} from '../modules/self-healing/healing.service.js'

const log = createModuleLogger('healing-worker')

// ── Notification queue producer ───────────────────────────────────────────────
const notificationQueue = new Queue<NotificationJob>(
  QUEUES.NOTIFICATION,
  getRedisOptions(),
)

// ── Config ────────────────────────────────────────────────────────────────────
const HEALING_THRESHOLD = parseFloat(process.env.HEALING_THRESHOLD ?? '0.85')
const LLM_PROVIDER      = (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase()
const LLM_MODEL         = process.env.LLM_MODEL ?? 'claude-opus-4-5'

// ── System prompt (mirrors Python test_healing_service.py) ────────────────────
const HEALING_SYSTEM_PROMPT = `
You are an expert Playwright test automation engineer specialising in self-healing locators.

A Playwright test step failed because the element locator is no longer valid.
You are given:
  1. A screenshot of the page at the time of failure (base64-encoded image)
  2. The HTML snippet around the failed element
  3. The original failed locator expression

Your task is to identify the correct, stable locator that:
  - Matches the intended element on the page
  - Uses the BEST locator strategy (prefer: role > label > text > css)
  - Will survive minor UI changes (avoid nth-child, generated IDs, or class hashes)

OUTPUT RULES:
  1. Respond with ONLY valid JSON — no markdown, no explanations.
  2. Confidence must be a number between 0.0 and 1.0.
  3. If you cannot determine a better locator, return the original with confidence 0.0.

OUTPUT FORMAT:
{
  "suggestedLocator": "getByRole('button', { name: 'Save' })",
  "confidence": 0.92,
  "reasoning": "The Save button is visible in the screenshot with aria-label 'Save'. Using getByRole is more stable than the original CSS selector."
}
`.trim()

// ── LLM factory ───────────────────────────────────────────────────────────────

function buildLlm(): BaseChatModel {
  if (LLM_PROVIDER === 'openai') {
    return new ChatOpenAI({
      apiKey:      process.env.OPENAI_API_KEY,
      model:       process.env.LLM_MODEL ?? 'gpt-4o',
      temperature: 0.2,
      maxTokens:   1024,
    })
  }

  // Default: Anthropic Claude (supports vision)
  return new ChatAnthropic({
    apiKey:      process.env.ANTHROPIC_API_KEY,
    model:       LLM_MODEL,
    maxTokens:   1024,
    temperature: 0.2,
  })
}

// ── Vision chain invocation ───────────────────────────────────────────────────

interface LlmHealResult {
  suggestedLocator: string
  confidence:       number
  reasoning:        string
}

async function invokeHealingChain(
  failedLocator:    string,
  screenshotBase64: string,
  htmlSnippet:      string,
): Promise<LlmHealResult> {
  const llm    = buildLlm()
  const parser = new StringOutputParser()

  // Determine the image MIME type (most screenshots are PNG)
  // Claude and GPT-4o both accept base64 image_url content blocks
  const imageMediaType = 'image/png'

  const humanMessage = new HumanMessage({
    content: [
      // Vision: screenshot
      {
        type:      'image_url',
        image_url: {
          url:    `data:${imageMediaType};base64,${screenshotBase64}`,
          detail: 'high',
        },
      } as { type: string; image_url: { url: string; detail: string } },
      // Text context
      {
        type: 'text',
        text: [
          `Failed locator: ${failedLocator}`,
          '',
          '=== HTML Snippet (element context) ===',
          htmlSnippet,
          '',
          'Provide the correct locator in the JSON format described in your system prompt.',
        ].join('\n'),
      } as { type: string; text: string },
    ],
  })

  const systemMessage = new SystemMessage(HEALING_SYSTEM_PROMPT)

  // Pipe: [system, human messages] → LLM → parser
  const chain = llm.pipe(parser)
  let raw = await chain.invoke([systemMessage, humanMessage])

  // Strip markdown fences if model wraps response
  raw = raw.trim()
  if (raw.startsWith('```')) {
    raw = raw
      .split('\n')
      .filter((l: string) => !l.trim().startsWith('```'))
      .join('\n')
  }

  const parsed = JSON.parse(raw) as LlmHealResult

  // Validate required fields
  if (
    typeof parsed.suggestedLocator !== 'string' ||
    typeof parsed.confidence !== 'number' ||
    typeof parsed.reasoning !== 'string'
  ) {
    throw new Error(`Invalid LLM response shape: ${JSON.stringify(parsed)}`)
  }

  // Clamp confidence to [0, 1]
  parsed.confidence = Math.max(0, Math.min(1, parsed.confidence))

  return parsed
}

// ── Main job processor ────────────────────────────────────────────────────────

async function processHealing(job: Job<HealingJob>): Promise<void> {
  const {
    executionId,
    testCaseId,   // used as testScriptId
    projectId,
    failedLocator,
    screenshotBase64,
    htmlSnippet,
  } = job.data

  log.info(
    `[HEAL] Job ${job.id} — execution=${executionId} testCase=${testCaseId} ` +
    `failedLocator="${failedLocator.substring(0, 80)}"`,
  )

  // ── Step 1: Invoke LLM vision chain ──────────────────────────────────
  let healResult: LlmHealResult

  try {
    healResult = await invokeHealingChain(failedLocator, screenshotBase64, htmlSnippet)
    log.info(
      `[HEAL] LLM result: confidence=${healResult.confidence} ` +
      `suggested="${healResult.suggestedLocator.substring(0, 80)}"`,
    )
  } catch (err) {
    log.error({ err }, '[HEAL] LLM vision chain failed')
    // Save a zero-confidence fallback entry so the execution has a record
    healResult = {
      suggestedLocator: failedLocator, // return original — no change
      confidence:       0,
      reasoning:        `LLM chain failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // ── Step 2: Persist to DB ─────────────────────────────────────────────
  const willAutoApply =
    healResult.confidence >= HEALING_THRESHOLD &&
    healResult.suggestedLocator !== failedLocator

  await saveHealingSuggestion({
    executionId,
    testScriptId:     testCaseId,
    projectId,
    failedLocator,
    suggestedLocator: healResult.suggestedLocator,
    confidence:       healResult.confidence,
    reasoning:        healResult.reasoning,
    autoApplied:      willAutoApply,
  })

  // ── Step 3: Auto-apply if confidence >= threshold ─────────────────────
  if (willAutoApply) {
    try {
      const { applied, updatedStepCount } = await applyHealingSuggestion(
        testCaseId,
        failedLocator,
        healResult.suggestedLocator,
      )

      if (applied) {
        log.info(
          `[HEAL] Auto-applied: updated ${updatedStepCount} step(s) in testCase=${testCaseId}`,
        )
      } else {
        log.warn(
          `[HEAL] Auto-apply skipped — no matching step for locator="${failedLocator}"`,
        )
      }
    } catch (applyErr) {
      log.error({ err: applyErr }, '[HEAL] Auto-apply failed — suggestion saved but not applied')
    }
  } else {
    log.info(
      `[HEAL] Confidence ${healResult.confidence} < threshold ${HEALING_THRESHOLD} ` +
      '— suggestion saved but not auto-applied',
    )
  }

  // ── Step 4: Enqueue notification ──────────────────────────────────────
  try {
    const notificationJob: NotificationJob = {
      projectId,
      event:       willAutoApply ? 'test-healed' : 'test-failed',
      executionId,
      testRunId:   executionId,
      details: {
        failedLocator,
        suggestedLocator:  healResult.suggestedLocator,
        confidence:        healResult.confidence,
        autoApplied:       willAutoApply,
      },
    }

    await notificationQueue.add('healing-complete', notificationJob, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    })

    log.info(`[HEAL] Notification enqueued for execution=${executionId}`)
  } catch (notifyErr) {
    log.warn({ err: notifyErr }, '[HEAL] Failed to enqueue notification — non-fatal')
  }
}

// ── Worker bootstrap ──────────────────────────────────────────────────────────

const worker = new Worker<HealingJob>(
  QUEUES.HEALING,
  processHealing,
  {
    ...getRedisOptions(),
    concurrency: 2,
  },
)

worker.on('completed', (job) =>
  log.info(`[HEAL] ✅ Job ${job.id} completed`),
)

worker.on('failed', (job, err) =>
  log.error({ err }, `[HEAL] ❌ Job ${job?.id} failed`),
)

worker.on('error', (err) =>
  log.error({ err }, '[HEAL] Worker error'),
)

log.info('🩹 Healing worker started')
log.info(`   Provider:  ${LLM_PROVIDER} / ${LLM_MODEL}`)
log.info(`   Threshold: ${HEALING_THRESHOLD}`)
