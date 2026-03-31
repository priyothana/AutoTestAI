/**
 * Execution Module — Routes
 *
 * Registers Fastify routes matching Python FastAPI paths exactly.
 * The Next.js frontend calls these paths — zero frontend changes allowed.
 *
 * Routes (exact Python parity):
 *   POST /api/v1/execute                    — trigger a new execution
 *   GET  /api/v1/executions/:id             — poll / view result
 *   GET  /api/v1/projects/:id/executions    — list executions for project
 */
import type { FastifyInstance } from 'fastify'
import { ExecuteRequestSchema } from './execution.schema.js'
import * as svc from './execution.service.js'

export async function executionRoutes(app: FastifyInstance): Promise<void> {

  // ── POST /execute ──────────────────────────────────────────────────
  // Trigger a test run. Returns execution_id immediately (async).
  // Identical to Python's POST /api/v1/execute.
  app.post('/execute', async (request, reply) => {
    try {
      const body = ExecuteRequestSchema.parse(request.body)
      const result = await svc.enqueueExecution(body)
      return reply.status(202).send({
        execution_id: result.execution_id,
        status: 'queued',
        message: 'Execution queued successfully',
      })
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'statusCode' in err) {
        const e = err as { statusCode: number; message: string }
        return reply.status(e.statusCode).send({ detail: e.message })
      }
      throw err
    }
  })

  // ── GET /executions/:id ────────────────────────────────────────────
  // Fetch a single execution result (frontend polls this for status).
  // Identical to Python's GET /api/v1/executions/{execution_id}.
  app.get('/executions/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const execution = await svc.getExecution(id)
      return reply.send(execution)
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'statusCode' in err) {
        const e = err as { statusCode: number; message: string }
        return reply.status(e.statusCode).send({ detail: e.message })
      }
      throw err
    }
  })

  // ── GET /projects/:id/executions ───────────────────────────────────
  // List all executions for a project (newest-first).
  // Identical to Python's GET /api/v1/projects/{project_id}/executions.
  app.get('/projects/:id/executions', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const query = request.query as { limit?: string }
      const limit = query.limit ? parseInt(query.limit, 10) : 50
      const result = await svc.listProjectExecutions(id, limit)
      return reply.send(result)
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'statusCode' in err) {
        const e = err as { statusCode: number; message: string }
        return reply.status(e.statusCode).send({ detail: e.message })
      }
      throw err
    }
  })
}
