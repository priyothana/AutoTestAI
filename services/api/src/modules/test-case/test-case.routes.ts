/**
 * Test-Case Module — Routes
 *
 * POST   /api/v1/tests/generate-test-steps
 * POST   /api/v1/tests/humanize-steps
 * POST   /api/v1/tests
 * GET    /api/v1/tests
 * GET    /api/v1/tests/:id
 * PUT    /api/v1/tests/:id
 * DELETE /api/v1/tests/:id
 * PATCH  /api/v1/tests/:id/steps
 * POST   /api/v1/ai/generate-test-steps (duplicate alias)
 * GET    /api/v1/ai/models
 */
import type { FastifyInstance } from 'fastify'
import {
  TestCaseCreateSchema,
  TestCaseUpdateSchema,
  StepsUpdateSchema,
  GenerateTestStepsSchema,
  HumanizeStepsSchema,
} from './test-case.schema.js'
import * as svc from './test-case.service.js'

export async function testCaseRoutes(app: FastifyInstance) {
  // ─── AI Generation ────────────────────────────────────────────

  app.post('/tests/generate-test-steps', async (request, reply) => {
    try {
      const body = GenerateTestStepsSchema.parse(request.body)
      const result = await svc.generateTestSteps(body)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  app.post('/tests/humanize-steps', async (request, reply) => {
    try {
      const body = HumanizeStepsSchema.parse(request.body)
      const result = await svc.humanizeSteps(body.steps)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

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

  // ─── AI Module Aliases ────────────────────────────────────────

  app.post('/ai/generate-test-steps', async (request, reply) => {
    try {
      const body = GenerateTestStepsSchema.parse(request.body)
      const result = await svc.generateTestSteps(body)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  app.get('/ai/models', async (_request, reply) => {
    // Match Python response
    return reply.send({
      models: [
        { id: 'claude-3-sonnet', name: 'Claude 3 Sonnet', provider: 'anthropic' },
        { id: 'claude-opus-4-5', name: 'Claude 3.5 Opus', provider: 'anthropic' },
        { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai' },
      ],
    })
  })
}
