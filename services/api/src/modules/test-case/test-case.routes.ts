/**
 * Test-Case Module — Routes
 *
 * Owns ONLY the CRUD surface for test case resources:
 *   POST   /api/v1/tests
 *   GET    /api/v1/tests
 *   GET    /api/v1/tests/:id
 *   PUT    /api/v1/tests/:id
 *   DELETE /api/v1/tests/:id
 *   PATCH  /api/v1/tests/:id/steps
 *
 * NOTE: generate-test-steps and humanize-steps are owned by
 * generation.routes.ts — do NOT register them here.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  TestCaseCreateSchema,
  TestCaseUpdateSchema,
  StepsUpdateSchema,
} from './test-case.schema.js'
import * as svc from './test-case.service.js'
import { reviewStep, applyStepUpdate } from './step-review.service.js'
import { nexusChat, nexusApply } from './nexus.service.js'
import prisma from '../../shared/db/prisma.js'

export async function testCaseRoutes(app: FastifyInstance) {
  // ─── CRUD ─────────────────────────────────────────────────────

  app.post('/tests', async (request, reply) => {
    try {
      const body = TestCaseCreateSchema.parse(request.body)
      const testCase = await svc.createTestCase(body)
      return reply.status(201).send(testCase)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  app.get('/tests', async (_request, reply) => {
    const testCases = await svc.listTestCases()
    return reply.send(testCases)
  })

  app.get('/tests/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const testCase = await svc.getTestCase(id)
      return reply.send(testCase)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  app.put('/tests/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = TestCaseUpdateSchema.parse(request.body)
      const testCase = await svc.updateTestCase(id, body)
      return reply.send(testCase)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  app.delete('/tests/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      await svc.deleteTestCase(id)
      return reply.status(204).send()
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  // ── POST /tests/bulk-delete  ──────────────────────────────────────────────
  // Deletes multiple test cases by their IDs in one request.
  // Used by the generation review panel to discard unchosen test cases.
  // Body: { ids: string[] }
  app.post('/tests/bulk-delete', async (request, reply) => {
    try {
      const { ids } = request.body as { ids: string[] }
      if (!Array.isArray(ids) || ids.length === 0) {
        return reply.status(400).send({ detail: 'ids must be a non-empty array' })
      }
      await prisma.test_cases.deleteMany({ where: { id: { in: ids } } })
      return reply.send({ deleted: ids.length })
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  // ── POST /tests/bulk-fetch  ───────────────────────────────────────────────
  // Returns full test case details for a list of IDs.
  // Body: { ids: string[] }
  app.post('/tests/bulk-fetch', async (request, reply) => {
    try {
      const { ids } = request.body as { ids: string[] }
      if (!Array.isArray(ids) || ids.length === 0) {
        return reply.send([])
      }
      const testCases = await prisma.test_cases.findMany({
        where: { id: { in: ids } },
        orderBy: { created_at: 'asc' },
      })
      return reply.send(testCases)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  app.patch('/tests/:id/steps', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = StepsUpdateSchema.parse(request.body)
      const testCase = await svc.updateTestSteps(id, body.steps)
      return reply.send(testCase)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  /**
   * POST /api/v1/tests/:id/steps/:stepIndex/review
   *
   * NLP-based single step editing.
   * Body: { instruction: string, chat_history: ChatMessage[], apply?: boolean }
   * Returns: { reply, updatedStep, applied }
   */
  const StepReviewBodySchema = z.object({
    instruction:  z.string().min(1),
    chat_history: z.array(
      z.object({ role: z.enum(['user', 'assistant']), content: z.string() })
    ).default([]),
    apply: z.boolean().default(false),
  })

  /**
   * POST /api/v1/tests/:id/steps/:stepIndex/apply
   *
   * Directly apply a pre-computed updated step to the DB.
   * Called by the frontend chatbot after user clicks "Apply Change".
   * Body: { updatedStep: StepShape }
   * Returns: { success: true, updatedStepCount: 1 }
   */
  const StepApplyBodySchema = z.object({
    updatedStep: z.object({
      id:           z.string(),
      action:       z.string(),
      target:       z.string().default(''),
      value:        z.string().default(''),
      locator_type: z.string().optional(),
    }).passthrough(),
  })

  app.post<{
    Params: { id: string; stepIndex: string }
  }>('/tests/:id/steps/:stepIndex/apply', async (request, reply) => {
    try {
      const { id, stepIndex } = request.params
      const idx = parseInt(stepIndex, 10)
      if (isNaN(idx) || idx < 0) {
        return reply.status(400).send({ detail: 'stepIndex must be a non-negative integer' })
      }
      const body   = StepApplyBodySchema.parse(request.body)
      const result = await applyStepUpdate(id, idx, body.updatedStep as any)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  app.post<{
    Params: { id: string; stepIndex: string }
  }>('/tests/:id/steps/:stepIndex/review', async (request, reply) => {
    try {
      const { id, stepIndex } = request.params
      const idx = parseInt(stepIndex, 10)
      if (isNaN(idx) || idx < 0) {
        return reply.status(400).send({ detail: 'stepIndex must be a non-negative integer' })
      }

      const body = StepReviewBodySchema.parse(request.body)

      // Step 1: Ask LLM to interpret the instruction
      const result = await reviewStep({
        testCaseId:  id,
        stepIndex:   idx,
        instruction: body.instruction,
        chatHistory: body.chat_history,
      })

      // Step 2 (optional): If apply=true and LLM returned an updated step, persist it
      if (body.apply && result.updatedStep) {
        await applyStepUpdate(id, idx, result.updatedStep)
        result.applied = true
      }

      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  // ── POST /api/v1/tests/:id/nexus/chat ─────────────────────────────────────
  // NEXUS general chatbot — can reference ANY step by number
  // Body: { instruction: string, chat_history: ChatMsg[] }
  const NexusChatSchema = z.object({
    instruction:  z.string().min(1),
    chat_history: z.array(
      z.object({ role: z.enum(['user', 'assistant']), content: z.string() })
    ).default([]),
  })

  app.post<{ Params: { id: string } }>(
    '/tests/:id/nexus/chat',
    async (request, reply) => {
      try {
        const { id } = request.params
        const body = NexusChatSchema.parse(request.body)
        const result = await nexusChat({
          testCaseId:  id,
          instruction: body.instruction,
          chatHistory: body.chat_history,
        })
        return reply.send(result)
      } catch (err: any) {
        if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
        throw err
      }
    }
  )

  // ── POST /api/v1/tests/:id/nexus/apply ────────────────────────────────────
  // Apply one or more step updates returned by NEXUS
  // Body: { stepUpdates: Array<{ stepIndex: number, updatedStep: StepShape }> }
  const NexusApplySchema = z.object({
    stepUpdates: z.array(z.object({
      stepIndex:   z.number().int().min(0),
      updatedStep: z.object({
        id:           z.string(),
        action:       z.string(),
        target:       z.string().default(''),
        value:        z.string().default(''),
        locator_type: z.string().optional(),
      }).passthrough(),
    })),
  })

  app.post<{ Params: { id: string } }>(
    '/tests/:id/nexus/apply',
    async (request, reply) => {
      try {
        const { id } = request.params
        const body = NexusApplySchema.parse(request.body)
        const result = await nexusApply(id, body.stepUpdates as any)
        return reply.send(result)
      } catch (err: any) {
        if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
        throw err
      }
    }
  )
}
