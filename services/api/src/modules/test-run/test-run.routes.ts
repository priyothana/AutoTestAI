/**
 * Test-Run Module — Routes
 *
 * POST   /api/v1/test-runs/    — Create + enqueue execution
 * GET    /api/v1/test-runs/:id — Get run details
 * GET    /api/v1/test-runs/    — List runs
 * DELETE /api/v1/test-runs/:id — Delete run
 */
import type { FastifyInstance } from 'fastify'
import { TestRunCreateSchema } from './test-run.schema.js'
import * as svc from './test-run.service.js'

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
    const query = request.query as { limit?: string }
    const limit = query.limit ? parseInt(query.limit, 10) : undefined
    const testRuns = await svc.listTestRuns(limit)
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
}
