/**
 * Test-Run Module — Routes
 *
 * POST   /api/v1/test-runs/                — Create + enqueue execution
 * POST   /api/v1/test-runs/:id/resume      — Resume a paused HITL run
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

const ResumeSchema = z.object({
  action: z.enum(['resume', 'skip', 'stop']),
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
      const { action } = ResumeSchema.parse(request.body)

      if (!isPaused(id)) {
        return reply.status(409).send({ detail: 'This run is not currently paused.' })
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
