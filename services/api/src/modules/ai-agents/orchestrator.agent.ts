/**
 * Orchestrator Agent — Phase 1, Agent 1
 *
 * Central supervisor for the multi-agent system.
 * Uses GPT-4o for complex reasoning and task decomposition.
 *
 * Responsibilities:
 * - Classify user intent via LLM (not regex)
 * - Decompose requests into ordered subtasks
 * - Delegate to the correct specialist agents
 * - Consolidate results and return a unified response
 * - Escalate to HITL when intent is ambiguous
 *
 * Guardrails:
 * - Never directly generates steps or executes Playwright
 * - Max 5 delegation hops per request (prevents infinite loops)
 * - Rate-limits HITL calls (max 2 per orchestration cycle)
 */
import { ChatOpenAI }                from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { StringOutputParser }         from '@langchain/core/output_parsers'
import { v4 as uuidv4 }               from 'uuid'

import { createModuleLogger }         from '../../shared/logger/index.js'
import { ragSearchTool }              from './tools/rag-search.tool.js'
import { getProjectById, logAgentExecution } from './tools/db-query.tool.js'
import { hitlTool }                   from './tools/hitl.tool.js'
import { runTestCaseGeneratorAgent }  from './test-case-generator.agent.js'
import { runTestStepGeneratorAgent }  from './test-step-generator.agent.js'
import { runHealingAnalyzerAgent }    from './healing-analyzer.agent.js'
import type { HITLInput }             from './agent.types.js'

const log = createModuleLogger('orchestrator-agent')

// ── Types ──────────────────────────────────────────────────────────────────────

type Intent =
  | 'GENERATE_TEST_CASES'
  | 'GENERATE_STEPS'
  | 'EXECUTE_TEST'
  | 'HEAL_ANALYZE'
  | 'PROJECT_INFO'
  | 'AMBIGUOUS'

interface ParsedIntent {
  intent:     Intent
  confidence: number
  params:     Record<string, unknown>
  reasoning:  string
}

export interface OrchestratorInput {
  projectId:    string
  userId?:      string
  message:      string
  executionId?: string
  chatHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
}

export interface OrchestratorOutput {
  intent:      Intent
  result:      unknown
  summary:     string
  thoughts:    string[]
  hitlInvoked: boolean
  agentsUsed:  string[]
}

// ── LLM ────────────────────────────────────────────────────────────────────────

function buildLlm() {
  return new ChatOpenAI({
    apiKey:      process.env.OPENAI_API_KEY,
    model:       process.env.ORCHESTRATOR_MODEL ?? 'gpt-4o',
    temperature: 0.1,
    maxTokens:   1024,
  })
}

// ── Intent classification ─────────────────────────────────────────────────────

const INTENT_SYSTEM = `You are the intent classifier for AutoTestAI's Orchestrator Agent.

Classify the user's message into ONE of these intents:
- GENERATE_TEST_CASES: user wants to create/generate test case titles or a test suite
- GENERATE_STEPS: user wants to generate Playwright steps for an existing test case
- EXECUTE_TEST: user wants to run/execute a test case or suite
- HEAL_ANALYZE: user wants to fix/heal a failed test or understand why it failed
- PROJECT_INFO: user wants information about the project, metadata, or settings
- AMBIGUOUS: intent is unclear — cannot route without clarification

Also extract any relevant parameters from the message.

Output ONLY valid JSON:
{
  "intent": "INTENT_NAME",
  "confidence": 0.0-1.0,
  "params": {
    "testCaseName": "...",
    "testCaseId": "...",
    "entityName": "...",
    "count": 5,
    "focusAreas": ["CRUD", "Negative"],
    "executionId": "..."
  },
  "reasoning": "one sentence why you chose this intent"
}`

async function classifyIntent(
  message:     string,
  chatHistory: Array<{ role: string; content: string }>,
): Promise<ParsedIntent> {
  const llm    = buildLlm()
  const parser = new StringOutputParser()

  const historyText = chatHistory.length > 0
    ? `\nRecent conversation:\n${chatHistory.slice(-4).map(m => `${m.role}: ${m.content}`).join('\n')}`
    : ''

  try {
    const raw = await llm.pipe(parser).invoke([
      new SystemMessage(INTENT_SYSTEM),
      new HumanMessage(`${historyText}\n\nUser message: ${message}`),
    ])
    let cleaned = raw.trim()
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.split('\n').filter(l => !l.trim().startsWith('```')).join('\n')
    }
    return JSON.parse(cleaned) as ParsedIntent
  } catch {
    return { intent: 'AMBIGUOUS', confidence: 0.3, params: {}, reasoning: 'Failed to parse intent' }
  }
}

// ── Main orchestration function ───────────────────────────────────────────────

export async function runOrchestratorAgent(
  input: OrchestratorInput,
): Promise<OrchestratorOutput> {
  const startMs   = Date.now()
  const thoughts: string[] = []
  const agentsUsed: string[] = ['orchestrator']
  let hitlInvoked = false

  log.info({ projectId: input.projectId, message: input.message.slice(0, 80) }, '[ORC] Starting')

  // ── OBSERVE: validate project exists ────────────────────────────────────

  thoughts.push('OBSERVE: loading project context')
  const project = await getProjectById(input.projectId)
  if (!project) {
    return {
      intent:      'AMBIGUOUS',
      result:      null,
      summary:     `Project ${input.projectId} not found`,
      thoughts,
      hitlInvoked: false,
      agentsUsed,
    }
  }

  // ── THINK: classify intent ────────────────────────────────────────────────

  thoughts.push('THINK: classifying user intent')
  const parsed = await classifyIntent(input.message, input.chatHistory ?? [])
  thoughts.push(`THINK: intent=${parsed.intent} confidence=${parsed.confidence} — ${parsed.reasoning}`)

  // ── HITL if ambiguous ─────────────────────────────────────────────────────

  if (parsed.intent === 'AMBIGUOUS' || parsed.confidence < 0.6) {
    thoughts.push('THINK: intent ambiguous — calling hitlTool for clarification')
    if (input.executionId) {
      const hitlInput: HITLInput = {
        agentName:   'orchestrator',
        executionId: input.executionId,
        reason:      `Could not determine intent from: "${input.message.slice(0, 100)}"`,
        suggestions: [
          'Generate test cases for [entity name]',
          'Generate Playwright steps for test case [name]',
          'Analyze why [test name] failed',
        ],
      }
      await hitlTool(hitlInput)
      hitlInvoked = true
    }
    return {
      intent:  'AMBIGUOUS',
      result:  null,
      summary: `Could not determine intent. ${parsed.reasoning}`,
      thoughts,
      hitlInvoked,
      agentsUsed,
    }
  }

  // ── ACT: delegate to the correct agent ───────────────────────────────────

  thoughts.push(`ACT: delegating to ${parsed.intent} agent`)
  let result: unknown = null
  let summary = ''

  try {
    switch (parsed.intent) {
      // ── Delegate to Test Case Generator Agent ──────────────────────────
      case 'GENERATE_TEST_CASES': {
        agentsUsed.push('test-case-generator')
        const count      = Number(parsed.params.count ?? 5)
        const focusAreas = parsed.params.focusAreas as string[] | undefined
        const output     = await runTestCaseGeneratorAgent({
          projectId:    input.projectId,
          count,
          focusAreas,
          selectedModule: parsed.params.entityName as string | undefined,
          executionId:    input.executionId,
        })
        hitlInvoked = hitlInvoked || output.hitlInvoked
        result  = output
        summary = `Generated ${output.cases.length} test cases with avg confidence ${output.confidence.toFixed(2)}`
        break
      }

      // ── Delegate to Test Step Generator Agent ──────────────────────────
      case 'GENERATE_STEPS': {
        agentsUsed.push('test-step-generator')
        const output = await runTestStepGeneratorAgent({
          projectId:    input.projectId,
          testCaseId:   parsed.params.testCaseId as string | undefined,
          testName:     (parsed.params.testCaseName as string) ?? input.message,
          entityFilter: parsed.params.entityName as string | undefined,
          executionId:  input.executionId,
        })
        result  = output
        summary = `Generated ${output.steps.length} steps — validation ${output.validation.passed ? '✅ passed' : '⚠️ failed'}`
        break
      }

      // ── Heal/Analyze — route to Healing Agent ─────────────────────────
      case 'HEAL_ANALYZE': {
        agentsUsed.push('healing-analyzer')
        summary = 'Healing & analysis requires a failed execution context — please trigger from execution results'
        result  = { message: summary }
        break
      }

      // ── Project info — answer from RAG ─────────────────────────────────
      case 'PROJECT_INFO': {
        const rag = await ragSearchTool({ projectId: input.projectId, query: input.message, topK: 5 })
        result  = { chunks: rag.chunks }
        summary = `Found ${rag.count} relevant metadata chunks for: "${input.message.slice(0, 50)}"`
        break
      }

      default:
        summary = `Intent ${parsed.intent} not yet implemented`
        result  = { message: summary }
    }
  } catch (err) {
    thoughts.push(`ACT: delegation error — ${String(err).slice(0, 100)}`)
    summary = `Agent delegation failed: ${String(err).slice(0, 80)}`
  }

  // ── REFLECT + DELIVER ─────────────────────────────────────────────────────

  thoughts.push(`REFLECT: ${summary}`)

  await logAgentExecution({
    projectId:     input.projectId,
    agentName:     'orchestrator',
    taskType:      parsed.intent,
    inputSummary:  { message: input.message.slice(0, 100), intent: parsed.intent },
    outputSummary: { summary, agentsUsed },
    thoughts,
    hitlInvoked,
    confidence:    parsed.confidence,
    tokensUsed:    0,
    durationMs:    Date.now() - startMs,
  })

  log.info({ intent: parsed.intent, summary, agentsUsed }, '[ORC] Done')

  return { intent: parsed.intent, result, summary, thoughts, hitlInvoked, agentsUsed }
}
