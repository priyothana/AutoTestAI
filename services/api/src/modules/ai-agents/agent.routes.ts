/**
 * AI Agents API Routes
 * Base path: /api/v1/agents
 *
 * Routes:
 *   POST /orchestrate               — Orchestrator: natural language → agent delegation
 *   POST /generate-test-cases       — Test Case Generator Agent (direct)
 *   POST /generate-steps            — Test Step Generator Agent (direct)
 *   POST /analyze-failure           — Healing & Analyzer Agent (direct)
 *   GET  /hitl-context/:executionId — Get pending HITL context for SSE / frontend
 *   GET  /status/:jobId             — Job status (future async support)
 */
import type { FastifyInstance } from 'fastify'
import { z }                    from 'zod'

import { runOrchestratorAgent }       from './orchestrator.agent.js'
import { runTestCaseGeneratorAgent }  from './test-case-generator.agent.js'
import { runTestStepGeneratorAgent }  from './test-step-generator.agent.js'
import { runHealingAnalyzerAgent }    from './healing-analyzer.agent.js'
import { getHitlContext }             from './tools/hitl.tool.js'
import { createModuleLogger }         from '../../shared/logger/index.js'

const log = createModuleLogger('agent-routes')

// ── Zod schemas ────────────────────────────────────────────────────────────────

const OrchestrateSchema = z.object({
  projectId:   z.string().uuid(),
  message:     z.string().min(3).max(1000),
  executionId: z.string().uuid().optional(),
  chatHistory: z.array(z.object({
    role:    z.enum(['user', 'assistant']),
    content: z.string(),
  })).optional(),
})

const GenerateTestCasesSchema = z.object({
  projectId:      z.string().uuid(),
  count:          z.number().int().min(1).max(20).default(5),
  focusAreas:     z.array(z.string()).optional(),
  selectedModule: z.string().optional(),
  brdContent:     z.string().optional(),
  executionId:    z.string().uuid().optional(),
})

const GenerateStepsSchema = z.object({
  projectId:    z.string().uuid(),
  testCaseId:   z.string().uuid().optional(),
  testName:     z.string().min(3),
  description:  z.string().optional(),
  entityFilter: z.string().optional(),
  executionId:  z.string().uuid().optional(),
})

const AnalyzeFailureSchema = z.object({
  executionId:     z.string().uuid(),
  testRunId:       z.string().uuid(),
  testCaseId:      z.string().uuid(),
  projectId:       z.string().uuid(),
  failedStepId:    z.string(),
  failedStepError: z.string(),
  screenshot:      z.string().optional(),
  logs:            z.array(z.string()).optional(),
})

// ── Route handler ─────────────────────────────────────────────────────────────

export async function agentRoutes(app: FastifyInstance) {
  // ── POST /orchestrate ────────────────────────────────────────────────────
  app.post('/orchestrate', async (req, reply) => {
    const body = OrchestrateSchema.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid request', details: body.error.flatten() })
    }
    try {
      const result = await runOrchestratorAgent({
        projectId:   body.data.projectId,
        userId:      (req as any).user?.id,
        message:     body.data.message,
        executionId: body.data.executionId,
        chatHistory: body.data.chatHistory,
      })
      return reply.send({ success: true, data: result })
    } catch (err) {
      log.error({ err }, '[AGENT-ROUTE] /orchestrate error')
      return reply.status(500).send({ error: 'Orchestration failed', message: String(err) })
    }
  })

  // ── POST /generate-test-cases ────────────────────────────────────────────
  app.post('/generate-test-cases', async (req, reply) => {
    const body = GenerateTestCasesSchema.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid request', details: body.error.flatten() })
    }
    try {
      const result = await runTestCaseGeneratorAgent(body.data)
      return reply.send({ success: true, data: result })
    } catch (err) {
      log.error({ err }, '[AGENT-ROUTE] /generate-test-cases error')
      return reply.status(500).send({ error: 'Test case generation failed', message: String(err) })
    }
  })

  // ── POST /generate-steps ─────────────────────────────────────────────────
  app.post('/generate-steps', async (req, reply) => {
    const body = GenerateStepsSchema.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid request', details: body.error.flatten() })
    }
    try {
      const result = await runTestStepGeneratorAgent(body.data)
      return reply.send({ success: true, data: result })
    } catch (err) {
      log.error({ err }, '[AGENT-ROUTE] /generate-steps error')
      return reply.status(500).send({ error: 'Step generation failed', message: String(err) })
    }
  })

  // ── POST /analyze-failure ────────────────────────────────────────────────
  app.post('/analyze-failure', async (req, reply) => {
    const body = AnalyzeFailureSchema.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid request', details: body.error.flatten() })
    }

    const { failedStepId, failedStepError, screenshot, logs, ...ids } = body.data

    // Load the test case steps from DB
    const { getTestCaseById } = await import('./tools/db-query.tool.js')
    const testCase = await getTestCaseById(ids.testCaseId)
    if (!testCase) {
      return reply.status(404).send({ error: 'Test case not found' })
    }
    const allSteps = (testCase.steps as any[]) ?? []
    const failedStep = allSteps.find((s: any) => s.id === failedStepId) ?? allSteps[0]

    try {
      const result = await runHealingAnalyzerAgent({
        ...ids,
        failedStep,
        failedStepError,
        allSteps,
        passedStepCount: allSteps.indexOf(failedStep),
        screenshot,
        logs,
      })
      return reply.send({ success: true, data: result })
    } catch (err) {
      log.error({ err }, '[AGENT-ROUTE] /analyze-failure error')
      return reply.status(500).send({ error: 'Failure analysis failed', message: String(err) })
    }
  })

  // ── GET /hitl-context/:executionId ───────────────────────────────────────
  // Frontend polls this to show the HITL pause banner with context
  app.get('/hitl-context/:executionId', async (req, reply) => {
    const { executionId } = req.params as { executionId: string }
    const ctx = getHitlContext(executionId)
    if (!ctx) {
      return reply.status(204).send()  // no pause pending
    }
    return reply.send({ success: true, data: ctx })
  })

  log.info('[AGENT-ROUTES] Registered: /api/v1/agents/*')
}
