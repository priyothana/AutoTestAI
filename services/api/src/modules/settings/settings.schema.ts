/**
 * Settings Module — Zod Schemas
 *
 * Maps from Python Pydantic: AppSettingsUpdate, AppSettingsResponse
 */
import { z } from 'zod'

export const AppSettingsUpdateSchema = z.object({
  default_timeout: z.number().int().default(30000),
  parallel_execution: z.boolean().default(false),
  retry_count: z.number().int().default(0),
  screenshot_mode: z.string().default('on-failure'),
  use_session_reuse: z.boolean().optional(),
  base_url: z.string().nullable().optional(),
  browser: z.string().default('chromium'),
  device: z.string().default('desktop'),
  variables: z.record(z.unknown()).default({}),
  slack_webhook: z.string().nullable().optional(),
  email_notifications: z.boolean().default(false),
  webhook_callback: z.string().nullable().optional(),
})

export const AppSettingsResponseSchema = AppSettingsUpdateSchema.extend({
  id: z.number(),
})

export type AppSettingsUpdate = z.infer<typeof AppSettingsUpdateSchema>
export type AppSettingsResponse = z.infer<typeof AppSettingsResponseSchema>
