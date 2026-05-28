/**
 * Healing & Analyzer Agent — Phase 1, Agent 5
 *
 * Performs Root Cause Analysis (RCA) on failed executions and generates:
 * - Corrected test steps (suggestions only — never auto-applies)
 * - Structured failure analysis (failure type, confidence, learnings)
 * - Feedback for the Test Step Generator Agent (via agent_executions tags)
 *
 * LLM: OpenAI gpt-4o
 * Confidence threshold: auto-suggest above 0.75, else always HITL
 */
import { ChatOpenAI }                from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { StringOutputParser }         from '@langchain/core/output_parsers'
import { v4 as uuidv4 }               from 'uuid'

import { createModuleLogger }    from '../../shared/logger/index.js'
import { ragSearchTool }         from './tools/rag-search.tool.js'
import { buildFieldManifest }    from './tools/metadata-reader.tool.js'
import { logAgentExecution, getRecentFailedExecutions, saveAiSuggestions } from './tools/db-query.tool.js'
import { hitlTool }              from './tools/hitl.tool.js'
import prisma                    from '../../shared/db/prisma.js'
import type { StepData }         from '../../shared/queue/job-types.js'
import type { HITLInput }        from './agent.types.js'

const log = createModuleLogger('healing-agent')

// ── Types ──────────────────────────────────────────────────────────────────────

export type FailureType =
  | 'STALE_LOCATOR'
  | 'INVALID_FIELD'          // field doesn't exist on the entity form (hallucinated by LLM step gen)
  | 'MISSING_REQUIRED_FIELD'
  | 'DATA_TYPE_MISMATCH'
  | 'SESSION_EXPIRED'
  | 'APP_BUG'
  | 'UNKNOWN'

export interface FailureAnalysis {
  executionId:    string
  testCaseId:     string
  failureType:    FailureType
  analysis:       string     // one-sentence RCA
  correctedSteps: StepData[] // full corrected step array (suggestions)
  confidence:     number     // 0-1
  learnings:      string[]   // what to feed back to Step Generator Agent
  hitlInvoked:    boolean
}

// ── LLM ────────────────────────────────────────────────────────────────────────

function buildLlm() {
  return new ChatOpenAI({
    apiKey:      process.env.OPENAI_API_KEY,
    model:       process.env.HEALING_AGENT_MODEL ?? 'gpt-4o',
    temperature: 0.1,
    maxTokens:   3000,
  })
}

// ── System prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Healing & Analyzer Agent for AutoTestAI.

Your job: Analyze failed test executions and generate corrected steps.

IMPORTANT RULES:
- NEVER modify original test steps — only produce SUGGESTIONS
- Confidence < 0.75 → output confidence and set needsHitl: true
- If failure is APP_BUG → set needsHitl: true (human must investigate app)
- Use EXACT field labels from the FIELD MANIFEST
- Use EXACT URLs from the METADATA (never invent)

Failure classification:
- STALE_LOCATOR: element exists but CSS/role changed
- INVALID_FIELD: field does not exist on the entity form (hallucinated by step generator)
- MISSING_REQUIRED_FIELD: form rejected save due to empty required field
- DATA_TYPE_MISMATCH: wrong value format for field type
- SESSION_EXPIRED: auth challenge appeared mid-test
- APP_BUG: application returned unexpected error unrelated to test
- UNKNOWN: cannot determine root cause

Output ONLY valid JSON (no markdown fences):
{
  "failureType": "STALE_LOCATOR|INVALID_FIELD|MISSING_REQUIRED_FIELD|DATA_TYPE_MISMATCH|SESSION_EXPIRED|APP_BUG|UNKNOWN",
  "analysis": "one sentence root cause",
  "correctedSteps": [...step array...],
  "confidence": 0.0-1.0,
  "needsHitl": true|false,
  "learnings": ["...","..."]
}`

// ── Deterministic heuristics (fast, no LLM) ────────────────────────────────────

function detectHeuristicFailure(
  failedStepError: string,
  logs:            string[],
  failedStep?:     StepData,
): FailureType | null {
  const all = [failedStepError, ...logs].join(' ').toLowerCase()

  // INVALID_FIELD: detect when a field-type step (TYPE/SELECT/LOOKUP/CHECKBOX)
  // fails with locator-not-found — this is likely a hallucinated field, not a
  // stale locator. Differentiated from STALE_LOCATOR by the step action type.
  if (failedStep) {
    const FIELD_ACTIONS = new Set(['TYPE', 'SELECT', 'LOOKUP', 'CHECKBOX', 'MULTI_SELECT'])
    const stepAction = ((failedStep as any).action ?? '').toUpperCase()
    if (
      FIELD_ACTIONS.has(stepAction) &&
      /locator|selector|could not find|no element|not.*found/i.test(all)
    ) {
      // This is a field-type step that can't find its target — likely INVALID_FIELD
      // (will be confirmed by manifest check in the main function)
      return 'INVALID_FIELD'
    }
  }

  if (/locator|selector|could not find|no element/i.test(all)) return 'STALE_LOCATOR'
  if (/required|cannot be blank|is mandatory|validation.*error/i.test(all)) return 'MISSING_REQUIRED_FIELD'
  if (/format|invalid.*date|not.*valid.*email|phone/i.test(all)) return 'DATA_TYPE_MISMATCH'
  if (/session.*expired|login.*required|401|403/i.test(all)) return 'SESSION_EXPIRED'
  if (/server.*error|500|internal.*error|application.*error/i.test(all)) return 'APP_BUG'
  return null
}

// ── Main function ─────────────────────────────────────────────────────────────

export interface HealingInput {
  executionId:      string
  testRunId:        string
  testCaseId:       string
  projectId:        string
  failedStep:       StepData
  failedStepError:  string
  allSteps:         StepData[]
  passedStepCount:  number
  screenshot?:      string   // base64
  logs?:            string[]
}

export async function runHealingAnalyzerAgent(
  input: HealingInput,
): Promise<FailureAnalysis> {
  const startMs  = Date.now()
  const thoughts: string[] = []

  log.info(
    { executionId: input.executionId, failedStepId: input.failedStep.id },
    '[HEAL-AGENT] Starting RCA',
  )

  // ── OBSERVE: heuristic fast-path ─────────────────────────────────────────

  thoughts.push('OBSERVE: running heuristic failure detector')
  const heuristicType = detectHeuristicFailure(input.failedStepError, input.logs ?? [], input.failedStep)

  // ── OBSERVE: retrieve field manifest + similar past failures ─────────────

  thoughts.push('OBSERVE: loading field manifest and past failure patterns')
  const [manifest, ragResult] = await Promise.all([
    buildFieldManifest(input.projectId),
    ragSearchTool({
      projectId: input.projectId,
      query:     `${input.failedStepError} ${input.failedStep.target ?? ''}`,
      topK:      5,
    }),
  ])

  // ── THINK: decide if LLM needed ──────────────────────────────────────────

  if (heuristicType === 'SESSION_EXPIRED') {
    thoughts.push('THINK: session expired — fast path, no LLM needed')
    const result: FailureAnalysis = {
      executionId:    input.executionId,
      testCaseId:     input.testCaseId,
      failureType:    'SESSION_EXPIRED',
      analysis:       'Session expired mid-test — re-authentication required before retrying',
      correctedSteps: input.allSteps,  // steps unchanged — just need re-auth
      confidence:     0.95,
      learnings:      ['Add session validation before first step'],
      hitlInvoked:    false,
    }
    await saveAiSuggestions(input.testRunId, result)
    return result
  }

  // ── Fast path: INVALID_FIELD → strip the hallucinated step, no LLM needed ─
  if (heuristicType === 'INVALID_FIELD' && manifest && manifest.fields.length > 0) {
    const knownFields = new Set(manifest.fields.map(f => f.label.toLowerCase().trim()))
    const failedTarget = ((input.failedStep as any).target ?? '').trim()
    const isInvalid = failedTarget && !knownFields.has(failedTarget.toLowerCase())

    if (isInvalid) {
      thoughts.push(`THINK: INVALID_FIELD confirmed — "${failedTarget}" not in manifest (${manifest.fields.length} known fields)`)
      // Build corrected steps with the hallucinated field step REMOVED
      const correctedSteps = input.allSteps.filter(s =>
        s.id !== input.failedStep.id
      ).map((s, i) => ({ ...s, id: String(i + 1) }))

      const availableFields = manifest.fields.map(f => f.label).slice(0, 10)
      const result: FailureAnalysis = {
        executionId:    input.executionId,
        testCaseId:     input.testCaseId,
        failureType:    'INVALID_FIELD',
        analysis:       `Field "${failedTarget}" does not exist on the ${manifest.entityName} form. ` +
                        `This field was hallucinated by the AI step generator and should be removed. ` +
                        `Available fields: ${availableFields.join(', ')}`,
        correctedSteps,
        confidence:     0.95,
        learnings:      [
          `NEVER generate a step for field "${failedTarget}" on entity "${manifest.entityName}" — it does not exist`,
          `Valid fields for ${manifest.entityName}: ${availableFields.join(', ')}`,
        ],
        hitlInvoked:    false,
      }
      await saveAiSuggestions(input.testRunId, result)

      log.info(
        { executionId: input.executionId, invalidField: failedTarget, entity: manifest.entityName },
        '[HEAL-AGENT] INVALID_FIELD fast path — hallucinated field step removed from suggestions',
      )
      return result
    }
  }

  // ── ACT: LLM-based RCA ───────────────────────────────────────────────────

  thoughts.push('ACT: calling LLM for root cause analysis and step correction')

  const context = [
    `Failed step: ${JSON.stringify(input.failedStep)}`,
    `Error: ${input.failedStepError}`,
    `Steps passed before failure: ${input.passedStepCount}/${input.allSteps.length}`,
    `Heuristic type hint: ${heuristicType ?? 'UNKNOWN'}`,
    '',
    manifest
      ? `=== CURRENT FIELD MANIFEST ===\n${JSON.stringify(manifest.fields.slice(0, 15), null, 2)}`
      : '(no field manifest available)',
    '',
    ragResult.chunks.length > 0
      ? `=== SIMILAR PAST FAILURES ===\n${ragResult.chunks.slice(0, 3).join('\n---\n')}`
      : '',
    '',
    `=== ALL TEST STEPS (for reference) ===\n${JSON.stringify(input.allSteps, null, 2)}`,
  ].join('\n')

  let llmResult: {
    failureType:    FailureType
    analysis:       string
    correctedSteps: StepData[]
    confidence:     number
    needsHitl:      boolean
    learnings:      string[]
  } = {
    failureType:    'UNKNOWN',
    analysis:       'Could not complete analysis',
    correctedSteps: input.allSteps,
    confidence:     0.3,
    needsHitl:      true,
    learnings:      [],
  }

  try {
    const llm    = buildLlm()
    const parser = new StringOutputParser()
    const raw    = await llm.pipe(parser).invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(context),
    ])

    let cleaned = raw.trim()
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.split('\n').filter(l => !l.trim().startsWith('```')).join('\n')
    }
    llmResult = JSON.parse(cleaned)
  } catch (err) {
    thoughts.push(`ACT: LLM/parse error — ${String(err).slice(0, 80)}`)
    llmResult.needsHitl = true
  }

  // ── REFLECT: confidence check ─────────────────────────────────────────────

  thoughts.push(`REFLECT: confidence=${llmResult.confidence}, needsHitl=${llmResult.needsHitl}`)

  let hitlInvoked = false
  if (llmResult.needsHitl || llmResult.confidence < 0.75) {
    thoughts.push('REFLECT: confidence < 0.75 — calling hitlTool for human review')
    const hitlInput: HITLInput = {
      agentName:    'healing-analyzer',
      executionId:  input.executionId,
      reason:       `RCA confidence ${llmResult.confidence.toFixed(2)}: ${llmResult.analysis}`,
      failedStep:   input.failedStep as unknown as Record<string, unknown>,
      errorMessage: input.failedStepError,
      screenshot:   input.screenshot,
      suggestions: [
        `Failure type detected: ${llmResult.failureType}`,
        `Suggested fix: ${llmResult.analysis}`,
        'Review and approve the corrected steps, or reject and edit manually',
      ],
      metadata: { projectId: input.projectId, testCaseId: input.testCaseId },
    }
    await hitlTool(hitlInput)
    hitlInvoked = true
  }

  // ── DELIVER ────────────────────────────────────────────────────────────────

  const result: FailureAnalysis = {
    executionId:    input.executionId,
    testCaseId:     input.testCaseId,
    failureType:    llmResult.failureType,
    analysis:       llmResult.analysis,
    correctedSteps: llmResult.correctedSteps,
    confidence:     llmResult.confidence,
    learnings:      llmResult.learnings,
    hitlInvoked,
  }

  thoughts.push(`DELIVER: ${result.failureType}, confidence=${result.confidence}`)

  // Save to test_runs.ai_suggestions
  await saveAiSuggestions(input.testRunId, result)

  // Log to agent_executions audit table
  await logAgentExecution({
    projectId:     input.projectId,
    agentName:     'healing-analyzer',
    taskType:      'rca_and_heal',
    inputSummary:  { executionId: input.executionId, failedStepId: input.failedStep.id },
    outputSummary: { failureType: result.failureType, confidence: result.confidence },
    thoughts,
    hitlInvoked,
    confidence:    result.confidence,
    tokensUsed:    0,
    durationMs:    Date.now() - startMs,
  })

  log.info(
    { executionId: input.executionId, failureType: result.failureType, confidence: result.confidence },
    '[HEAL-AGENT] RCA complete',
  )

  return result
}
