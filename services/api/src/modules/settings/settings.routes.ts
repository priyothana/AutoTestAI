/**
 * Settings Module — Routes
 *
 * GET  /api/v1/settings/ — Get current settings
 * POST /api/v1/settings/ — Update settings
 *
 * Exact contract match with Python: app/api/v1/endpoints/settings.py
 */
import type { FastifyInstance } from 'fastify'
import { AppSettingsUpdateSchema } from './settings.schema.js'
import { getSettings, updateSettings } from './settings.service.js'

export async function settingsRoutes(app: FastifyInstance) {
  /**
   * GET /api/v1/settings/
   */
  app.get('/', async (_request, reply) => {
    const settings = await getSettings()
    return reply.send(settings)
  })

  /**
   * POST /api/v1/settings/
   */
  app.post('/', async (request, reply) => {
    const body = AppSettingsUpdateSchema.parse(request.body)
    const settings = await updateSettings(body)
    return reply.send(settings)
  })
}
