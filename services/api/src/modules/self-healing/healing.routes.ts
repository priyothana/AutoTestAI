/**
 * Self-Healing Module — Routes
 *
 * Route: GET /api/v1/heal/:executionId
 *
 * This path is IDENTICAL to the Python FastAPI version:
 *   GET /api/v1/heal/{execution_id}
 *
 * Registered in index.ts as:
 *   app.register(healingRoutes, { prefix: '/api/v1' })
 *
 * The Next.js frontend calls this to display healing suggestions
 * after a failed test execution.
 */
import type { FastifyInstance } from 'fastify'
import { getHealingSuggestionsForExecution } from './healing.service.js'

export async function healingRoutes(app: FastifyInstance) {
  /**
   * GET /api/v1/heal/:executionId
   *
   * Returns all healing suggestions generated for an execution.
   * Response shape: { suggestions: HealingSuggestion[], total: number }
   */
  app.get<{ Params: { executionId: string } }>(
    '/heal/:executionId',
    async (request, reply) => {
      try {
        const { executionId } = request.params
        const result = await getHealingSuggestionsForExecution(executionId)
        return reply.send(result)
      } catch (err: unknown) {
        const e = err as { statusCode?: number; message?: string }
        if (e.statusCode) {
          return reply.status(e.statusCode).send({ detail: e.message })
        }
        throw err
      }
    },
  )
}
