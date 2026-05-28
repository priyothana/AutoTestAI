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
        default_model: 'gpt-4o',
        models: ['gpt-4o', 'gpt-4-turbo'],
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

  // ── GET /tests/debug-manifest/:projectId/:objectName ──────────────
  // DEBUG ENDPOINT — shows the raw field manifest that the LLM receives.
  // Usage: GET /api/v1/tests/debug-manifest/<project-uuid>/Contact
  // Returns: { objectName, fieldsCount, layoutAvailable, layoutRequired, manifest }

  app.get('/tests/debug-manifest/:projectId/:objectName', async (request, reply) => {
    const { projectId, objectName } = request.params as { projectId: string; objectName: string }
    try {
      const { getObjectMetadata, getPageLayoutFields } = await import('../salesforce/salesforce.service.js')
      const { buildFieldManifest } = await import('./generation.service.js')

      const sfMeta = await getObjectMetadata(projectId, objectName).catch(() => null)
      if (!sfMeta?.metadata) {
        return reply.status(404).send({ error: `No metadata found for ${objectName} in project ${projectId}` })
      }

      const layoutResult = await getPageLayoutFields(projectId, objectName).catch(() => null)

      const fields = (sfMeta.metadata['fields'] ?? []) as Record<string, unknown>[]

      // Show which fields are nillable, required, createable for debugging
      const fieldDebug = fields
        .filter(f => Boolean(f['createable']))
        .map(f => ({
          name: f['name'],
          label: f['label'],
          type: f['type'],
          nillable: f['nillable'],
          required: f['required'],
          defaultedOnCreate: f['defaultedOnCreate'],
          inLayout: layoutResult?.available?.has(String(f['name'] ?? '')) ?? 'no_layout',
          layoutRequired: layoutResult?.layoutRequired?.has(String(f['name'] ?? '')) ?? 'no_layout',
        }))

      const manifest = buildFieldManifest(sfMeta.metadata, layoutResult, 'Create ' + objectName)

      return reply.send({
        objectName: sfMeta.object_name,
        label: sfMeta.label,
        totalFields: fields.length,
        createableFields: fieldDebug.length,
        layoutAvailableCount: layoutResult?.available?.size ?? 'null (layout fetch failed)',
        layoutRequiredCount: layoutResult?.layoutRequired?.size ?? 'null (layout fetch failed)',
        layoutAvailableFields: layoutResult ? Array.from(layoutResult.available) : null,
        layoutRequiredFields: layoutResult ? Array.from(layoutResult.layoutRequired) : null,
        fieldDebug,
        manifest,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.status(500).send({ error: msg })
    }
  })
}
