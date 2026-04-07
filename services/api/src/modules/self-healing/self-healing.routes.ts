/**
 * Self-Healing Module — Routes
 *
 * POST /api/v1/test-runs/:id/heal — AI Fix Assistant (chat + edit mode)
 *
 * Body:  { message, chat_history, current_corrected_steps }
 * Reply: { reply, corrected_steps }
 */
import type { FastifyInstance } from 'fastify'
import { HealRequestSchema }    from './self-healing.schema.js'
import { healTestRun }          from './self-healing.service.js'

export async function selfHealingRoutes(app: FastifyInstance) {
  app.post('/test-runs/:id/heal', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body   = HealRequestSchema.parse(request.body)
      const result = await healTestRun(id, body)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })
}
