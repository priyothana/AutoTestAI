/**
 * Test-Run Module — Routes
 *
 * POST   /api/v1/test-runs/                — Create + enqueue execution
 * POST   /api/v1/test-runs/:id/resume      — Resume a paused HITL run (with optional step patch)
 * POST   /api/v1/test-runs/:id/hitl/analyze — HITL AI: initial error analysis
 * POST   /api/v1/test-runs/:id/hitl/chat   — HITL AI: multi-turn conversation
 * GET    /api/v1/test-runs/:id             — Get run details
 * GET    /api/v1/test-runs/               — List runs
 * DELETE /api/v1/test-runs/:id             — Delete run
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { TestRunCreateSchema } from './test-run.schema.js'
import * as svc from './test-run.service.js'
import { resolvePause, isPaused } from '../../shared/execution/pause-gate.js'
import prisma from '../../shared/db/prisma.js'
import { hitlAnalyze, hitlChat } from './hitl.service.js'
import { saveHitlLearning } from './hitl-learning.service.js'
import { createModuleLogger } from '../../shared/logger/index.js'

const routeLog = createModuleLogger('test-run-routes')

/**
 * Optional step override — passed when the user selects an AI option or types
 * a custom fix in the HITL chatbot and clicks "Apply & Resume".
 */
const StepOverrideSchema = z.object({
  action:       z.string().optional(),
  target:       z.string().optional(),
  value:        z.string().optional(),
  locator_type: z.string().optional(),
}).optional()

/** New step to insert before the paused step */
const InsertStepSchema = z.object({
  action: z.string(),
  target: z.string().default(''),
  value:  z.string().default(''),
}).optional()

const ResumeSchema = z.object({
  action:           z.enum(['resume', 'skip', 'stop']),
  /** The user's chosen instruction from the chatbot (for learning) */
  user_instruction: z.string().optional(),
  /** Structured step override — when provided, patches the DB step before resuming */
  step_override:    StepOverrideSchema,
  /** New step to INSERT before the paused step — used by Add Step & Resume */
  insert_step:      InsertStepSchema,
  /** If true, the paused step will be deleted from the test case before resuming */
  delete_step:      z.boolean().optional(),
  /** 1-based step index to patch */
  paused_step:      z.number().int().min(1).optional(),
  /** test case ID for patching */
  test_case_id:     z.string().optional(),
  /** AI suggestion text (for learning) */
  ai_suggestion:    z.string().optional(),
})

export async function testRunRoutes(app: FastifyInstance) {
  app.post('/', async (request, reply) => {
    try {
      const body = TestRunCreateSchema.parse(request.body)
      const testRun = await svc.createTestRun(body)
      return reply.status(201).send(testRun)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  // ── HITL: Resume a paused step ──────────────────────────────────────────
  app.post('/:id/resume', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = ResumeSchema.parse(request.body)
      const {
        action, user_instruction, step_override, insert_step, delete_step,
        paused_step, test_case_id, ai_suggestion,
      } = body

      if (!isPaused(id)) {
        return reply.status(409).send({ detail: 'This run is not currently paused.' })
      }

      // ── INSERT new step before/replace the paused step ────────────────────
      if (action === 'resume' && insert_step && test_case_id && paused_step != null) {
        try {
          const tc = await prisma.test_cases.findUnique({ where: { id: test_case_id } })
          if (tc) {
            const steps = (tc.steps as unknown as Record<string, unknown>[]) ?? []
            const insertIdx = paused_step - 1  // insert BEFORE this 0-based index
            const newStep = {
              id:     `hitl-${Date.now()}`,
              action: insert_step.action.toUpperCase(),
              target: insert_step.target ?? '',
              value:  insert_step.value  ?? '',
            }
            const patched = delete_step
              ? [
                  ...steps.slice(0, insertIdx),
                  newStep,
                  ...steps.slice(insertIdx + 1),
                ]
              : [
                  ...steps.slice(0, insertIdx),
                  newStep,
                  ...steps.slice(insertIdx),
                ]
            await prisma.test_cases.update({
              where: { id: test_case_id },
              data:  { steps: patched as any },
            })
            routeLog.info(
              `[HITL-RESUME] ${delete_step ? 'Replaced' : 'Inserted'} new step ${JSON.stringify(newStep)} ` +
              `at position ${paused_step} in test case ${test_case_id}`,
            )
          }
        } catch (insertErr) {
          routeLog.warn({ insertErr }, '[HITL-RESUME] Step insert failed (non-fatal)')
        }
      }

      // ── DELETE the paused step ────────────────────────────────────────────
      if (action === 'resume' && delete_step && !insert_step && test_case_id && paused_step != null) {
        try {
          const tc = await prisma.test_cases.findUnique({ where: { id: test_case_id } })
          if (tc) {
            const steps = (tc.steps as unknown as Record<string, unknown>[]) ?? []
            const deleteIdx = paused_step - 1
            const patched = steps.filter((_, idx) => idx !== deleteIdx)
            await prisma.test_cases.update({
              where: { id: test_case_id },
              data:  { steps: patched as any },
            })
            routeLog.info(`[HITL-RESUME] Deleted step ${paused_step} from test case ${test_case_id}`)
          }
        } catch (deleteErr) {
          routeLog.warn({ deleteErr }, '[HITL-RESUME] Step delete failed (non-fatal)')
        }
      }

      // ── Patch DB step if user provided a step_override (Update & Resume) ──
      if (action === 'resume' && step_override && test_case_id && paused_step != null) {
        try {
          const tc = await prisma.test_cases.findUnique({ where: { id: test_case_id } })
          if (tc) {
            const steps = (tc.steps as unknown as Record<string, unknown>[]) ?? []
            const stepIdx = paused_step - 1
            const patched = steps.map((s, idx) => {
              if (idx === stepIdx) {
                return {
                  ...s,
                  ...(step_override.action       ? { action:       step_override.action.toUpperCase() } : {}),
                  ...(step_override.target !== undefined ? { target: step_override.target } : {}),
                  ...(step_override.value  !== undefined ? { value:  step_override.value  } : {}),
                  ...(step_override.locator_type ? { locator_type: step_override.locator_type } : {}),
                }
              }
              return s
            })
            await prisma.test_cases.update({
              where: { id: test_case_id },
              data:  { steps: patched as any },
            })
            routeLog.info(`[HITL-RESUME] Patched step ${paused_step} in test case ${test_case_id}`)
          }
        } catch (patchErr) {
          routeLog.warn({ patchErr }, '[HITL-RESUME] Step patch failed (non-fatal)')
        }

        // Save learning record for the user's Apply decision
        try {
          const tc = await prisma.test_cases.findUnique({
            where: { id: test_case_id },
            select: { project_id: true, steps: true },
          })
          if (tc) {
            const steps = (tc.steps as unknown as Record<string, unknown>[]) ?? []
            const originalStep = steps[paused_step - 1] as any ?? {}
            await saveHitlLearning({
              projectId:    tc.project_id ?? '',
              testCaseId:   test_case_id,
              testRunId:    id,
              stepNum:      paused_step,
              errorMessage: null,
              originalStep: {
                action:       originalStep.action ?? '',
                target:       originalStep.target ?? '',
                value:        originalStep.value  ?? '',
                locator_type: originalStep.locator_type ?? '',
              },
              aiSuggestion:  ai_suggestion || undefined,
              decision:      user_instruction ? 'custom' : 'accept',
              userInput:     user_instruction || undefined,
              updatedStep:   step_override as any,
              outcome:       'resume',
            })
          }
        } catch (learningErr) {
          routeLog.warn({ learningErr }, '[HITL-RESUME] Learning save failed (non-fatal)')
        }
      }

      // For stop: mark DB status as 'stopped' before resolving the gate
      if (action === 'stop') {
        await prisma.test_runs.update({
          where: { id },
          data: { status: 'failed' },
        }).catch(() => { /* non-fatal */ })
      } else {
        // Flip DB status back to running before resolving the gate
        await prisma.test_runs.update({
          where: { id },
          data: { status: 'running' },
        }).catch(() => { /* non-fatal — worker will update status itself */ })
      }

      const resolved = resolvePause(id, action)
      if (!resolved) {
        return reply.status(409).send({ detail: 'Pause gate already resolved or expired.' })
      }

      return reply.send({ ok: true, action })
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  // ── HITL: Stop a paused test (close browser, abort run) ─────────────────
  app.post('/:id/stop', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }

      // Mark as failed immediately in DB
      await prisma.test_runs.update({
        where: { id },
        data: { status: 'failed' },
      }).catch(() => { /* non-fatal */ })

      // If paused, resolve the gate with 'stop' so the worker exits
      if (isPaused(id)) {
        resolvePause(id, 'stop')
      }

      return reply.send({ ok: true, action: 'stop' })
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  app.get('/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const testRun = await svc.getTestRun(id)
      return reply.send(testRun)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  app.get('/', async (request, reply) => {
    const query = request.query as { limit?: string; test_case_id?: string }
    const limit = query.limit ? parseInt(query.limit, 10) : undefined
    const testCaseId = query.test_case_id || undefined
    const testRuns = await svc.listTestRuns(limit, testCaseId)
    return reply.send(testRuns)
  })

  app.delete('/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      await svc.deleteTestRun(id)
      return reply.status(204).send()
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  // ── HITL AI: Initial error analysis (auto-called when panel opens) ───────
  // Body: { test_case_id, paused_step, error_message }
  const HitlAnalyzeSchema = z.object({
    test_case_id:  z.string(),
    paused_step:   z.number().int().min(1).nullable().default(null),
    error_message: z.string().nullable().default(null),
  })

  app.post('/:id/hitl/analyze', async (request, reply) => {
    try {
      const { id: runId } = request.params as { id: string }
      const body = HitlAnalyzeSchema.parse(request.body)
      const result = await hitlAnalyze({
        runId,
        testCaseId:   body.test_case_id,
        pausedStep:   body.paused_step,
        errorMessage: body.error_message,
      })
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  // ── HITL AI: Multi-turn conversation while test is paused ────────────────
  // Body: { test_case_id, paused_step, error_message, instruction, chat_history }
  const HitlChatSchema = z.object({
    test_case_id:  z.string(),
    paused_step:   z.number().int().min(1).nullable().default(null),
    error_message: z.string().nullable().default(null),
    instruction:   z.string().min(1),
    chat_history:  z.array(
      z.object({ role: z.enum(['user', 'assistant']), content: z.string() })
    ).default([]),
  })

  app.post('/:id/hitl/chat', async (request, reply) => {
    try {
      const { id: runId } = request.params as { id: string }
      const body = HitlChatSchema.parse(request.body)
      const result = await hitlChat({
        runId,
        testCaseId:   body.test_case_id,
        pausedStep:   body.paused_step,
        errorMessage: body.error_message,
        instruction:  body.instruction,
        chatHistory:  body.chat_history,
      })
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })
}
