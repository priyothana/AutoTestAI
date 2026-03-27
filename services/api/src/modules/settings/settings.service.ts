/**
 * Settings Module — Service Layer
 *
 * Port of Python: app/api/v1/endpoints/settings.py
 */
import prisma from '../../shared/db/prisma.js'
import type { AppSettingsUpdate } from './settings.schema.js'

/**
 * Get current app settings. Creates default if none exist.
 */
export async function getSettings() {
  let settings = await prisma.app_settings.findFirst()

  if (!settings) {
    settings = await prisma.app_settings.create({
      data: {
        default_timeout: 30000,
        browser: 'chromium',
        device: 'desktop',
      },
    })
  }

  return settings
}

/**
 * Update app settings (upsert pattern).
 */
export async function updateSettings(data: AppSettingsUpdate) {
  let settings = await prisma.app_settings.findFirst()

  if (!settings) {
    settings = await prisma.app_settings.create({
      data: {
        default_timeout: data.default_timeout,
        parallel_execution: data.parallel_execution,
        retry_count: data.retry_count,
        screenshot_mode: data.screenshot_mode,
        use_session_reuse: data.use_session_reuse,
        base_url: data.base_url ?? null,
        browser: data.browser,
        device: data.device,
        variables: data.variables as any,
        slack_webhook: data.slack_webhook ?? null,
        email_notifications: data.email_notifications,
        webhook_callback: data.webhook_callback ?? null,
      },
    })
  } else {
    settings = await prisma.app_settings.update({
      where: { id: settings.id },
      data: {
        default_timeout: data.default_timeout,
        parallel_execution: data.parallel_execution,
        retry_count: data.retry_count,
        screenshot_mode: data.screenshot_mode,
        use_session_reuse: data.use_session_reuse,
        base_url: data.base_url ?? null,
        browser: data.browser,
        device: data.device,
        variables: data.variables as any,
        slack_webhook: data.slack_webhook ?? null,
        email_notifications: data.email_notifications,
        webhook_callback: data.webhook_callback ?? null,
      },
    })
  }

  return settings
}
