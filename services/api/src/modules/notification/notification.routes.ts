/**
 * Notification Module — Routes
 *
 * POST /api/v1/notifications/test
 *   Sends a one-off test notification to verify channel config.
 *   Body: { project_id, channel?, message? }
 *   Response: { success, channel, message }
 *
 * Registered in index.ts as:
 *   app.register(notificationRoutes, { prefix: '/api/v1' })
 *
 * SKILL.md cross-module rule: imports notification.service.ts only.
 */
import type { FastifyInstance } from 'fastify'
import { TestNotificationRequestSchema } from './notification.schema.js'
import { sendTestNotification }          from './notification.service.js'

export async function notificationRoutes(app: FastifyInstance) {
  /**
   * POST /api/v1/notifications/test
   *
   * Triggers a test notification for a project to verify the chosen
   * channel (Slack, Jira, or email) is correctly configured.
   *
   * Returns 200 { success, channel, message } — never 4xx/5xx for
   * channel-specific failures; those are surfaced in the `success` field
   * so the frontend can display the error inline.
   */
  app.post<{
    Body: {
      project_id: string
      channel?: 'jira' | 'slack' | 'email'
      message?: string
    }
  }>(
    '/notifications/test',
    async (request, reply) => {
      try {
        const body = TestNotificationRequestSchema.parse(request.body)
        const result = await sendTestNotification(
          body.project_id,
          body.channel,
          body.message,
        )
        return reply.status(200).send(result)
      } catch (err: unknown) {
        const e = err as { statusCode?: number; message?: string; issues?: unknown[] }
        // Zod validation error
        if (e.issues) {
          return reply.status(422).send({ detail: 'Validation error', issues: e.issues })
        }
        if (e.statusCode) {
          return reply.status(e.statusCode).send({ detail: e.message })
        }
        throw err
      }
    },
  )
}
