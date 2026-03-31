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
import {
  TestCaseCreateSchema,
  TestCaseUpdateSchema,
  StepsUpdateSchema,
} from './test-case.schema.js'
import * as svc from './test-case.service.js'

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
}
