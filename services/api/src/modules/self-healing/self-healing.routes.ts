/**
 * Self-Healing Module — Routes
 *
 * POST /api/v1/test-runs/:id/heal — AI Fix Assistant
 */
import type { FastifyInstance } from 'fastify'
import { HealRequestSchema } from './self-healing.schema.js'
import * as svc from './self-healing.service.js'

export async function selfHealingRoutes(app: FastifyInstance) {
  app.post('/test-runs/:id/heal', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = HealRequestSchema.parse(request.body)
      const result = await svc.healTestRun(id, body.messages)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })
}
