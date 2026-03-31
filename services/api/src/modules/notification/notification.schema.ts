/**
 * Notification Module — Zod Schemas
 *
 * Covers:
 *   POST /api/v1/notifications/test — send a test notification for a project
 *
 * The notification worker consumes NotificationJob from notification-queue
 * (types defined in shared/queue/job-types.ts — not duplicated here).
 */
import { z } from 'zod'

// ─── Request schemas ──────────────────────────────────────────────

/**
 * Body for POST /api/v1/notifications/test
 * Triggers a one-off test notification for the given project.
 */
export const TestNotificationRequestSchema = z.object({
  project_id: z.string().uuid(),
  channel: z.enum(['jira', 'slack', 'email']).optional().default('slack'),
  message: z.string().optional().default('AutoTest AI — test notification'),
})

// ─── Response schemas ──────────────────────────────────────────────

export const TestNotificationResponseSchema = z.object({
  success: z.boolean(),
  channel: z.string(),
  message: z.string(),
})

export const NotificationLogSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  event: z.string(),
  channel: z.string(),
  status: z.string(),    // 'sent' | 'failed' | 'skipped'
  error: z.string().nullable(),
  created_at: z.string(),
})

// ─── TypeScript types ─────────────────────────────────────────────

export type TestNotificationRequest  = z.infer<typeof TestNotificationRequestSchema>
export type TestNotificationResponse = z.infer<typeof TestNotificationResponseSchema>
export type NotificationLog          = z.infer<typeof NotificationLogSchema>
