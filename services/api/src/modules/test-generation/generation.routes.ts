/**
 * Test-Generation Module — Routes
 *
 * Registers Fastify routes that match Python FastAPI paths exactly.
 * The Next.js frontend calls these paths — zero frontend changes allowed.
 *
 * Routes (exact Python parity):
 *   POST /api/v1/tests/generate-test-steps   — primary generation endpoint
 *   POST /api/v1/ai/generate-test-steps      — alias (same handler)
 *   POST /api/v1/tests/humanize-steps        — human-readable step descriptions
 *
 * Note: CRUD routes (POST /tests, GET /tests/:id, etc.) remain
 * in test-case.routes.ts — this module ONLY owns generation logic.
 */
import type { FastifyInstance } from 'fastify'
import { GenerateRequestSchema, HumanizeRequestSchema } from './generation.schema.js'
import { generateTest, humanizeSteps }                   from './generation.service.js'

export async function generationRoutes(app: FastifyInstance): Promise<void> {

  // ── POST /generate-test-steps ─────────────────────────────────────
  // Primary endpoint — called by the frontend test editor.
  // Accepts: { prompt, provider?, model?, project_id? }
  // Returns: { name, description, steps[], priority, preconditions[], expected_outcome }

  const generateHandler = async (request: { body: unknown }, reply: { send: (v: unknown) => void; status: (n: number) => { send: (v: unknown) => void } }) => {
    try {
      const body   = GenerateRequestSchema.parse(request.body)
      const result = await generateTest(body)
      return reply.send(result)
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'statusCode' in err) {
        const e = err as { statusCode: number; message: string }
        return reply.status(e.statusCode).send({ detail: e.message })
      }
      throw err
    }
  }

  app.post('/tests/generate-test-steps', generateHandler)

  // Alias used by the /ai/* module path (Python had a separate ai.py router)
  app.post('/ai/generate-test-steps', generateHandler)

  // ── GET /ai/models ────────────────────────────────────────────────
  // Returns supported model providers — matches Python's ai.py /models route.

  app.get('/ai/models', async (_req, reply) => {
    return reply.send({
      openai: {
        default_model: 'gpt-4o-mini',
        models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'],
      },
      claude: {
        default_model: 'claude-sonnet-4-20250514',
        models: [
          'claude-sonnet-4-20250514',
          'claude-3-7-sonnet-20250219',
          'claude-3-5-haiku-20241022',
        ],
      },
    })
  })

  // ── POST /humanize-steps ─────────────────────────────────────────
  // Converts technical steps to plain-English descriptions.
  // Accepts: { steps: StepModel[], provider?: string }
  // Returns: { readable_steps: string[] }

  app.post('/tests/humanize-steps', async (request, reply) => {
    try {
      const body   = HumanizeRequestSchema.parse(request.body)
      const result = await humanizeSteps(
        body.steps as Record<string, unknown>[],
        body.provider,
      )
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
