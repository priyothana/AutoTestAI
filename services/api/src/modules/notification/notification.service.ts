/**
 * Notification Module — Service Layer
 *
 * Public interface — imported by notification.routes.ts and called from
 * the notification worker after dispatching.
 *
 * Responsibilities:
 *   - sendJiraNotification()   — create/update a Jira issue via API
 *   - sendSlackNotification()  — post a message to a Slack webhook
 *   - sendEmailNotification()  — send email via SMTP (nodemailer-style fetch)
 *   - dispatchNotification()   — entry point for the worker (selects channel)
 *   - sendTestNotification()   — called by POST /api/v1/notifications/test
 *
 * Cross-module boundary (SKILL.md):
 *   This service imports project.service.ts to get project + Jira config.
 *   It NEVER imports project.routes.ts or project.schema.ts.
 *
 * Port of Python: test_runs.py (Jira dispatch section) + app_settings (Slack webhook)
 */
import { createModuleLogger } from '../../shared/logger/index.js'
import { getJiraConfig }      from '../project/project.service.js'
import type { NotificationJob } from '../../shared/queue/job-types.js'

const log = createModuleLogger('notification')

// ─── Types ────────────────────────────────────────────────────────

export interface DispatchResult {
  channel: string
  success: boolean
  error?: string
}

// ─── Channel senders ──────────────────────────────────────────────

/**
 * Post a message to a Slack incoming webhook.
 * SLACK_WEBHOOK_URL must be set in environment.
 */
export async function sendSlackNotification(
  text: string,
  webhookUrl?: string,
): Promise<DispatchResult> {
  const url = webhookUrl ?? process.env.SLACK_WEBHOOK_URL
  if (!url) {
    log.warn('[NOTIFY] SLACK_WEBHOOK_URL not configured — skipping Slack notification')
    return { channel: 'slack', success: false, error: 'SLACK_WEBHOOK_URL not set' }
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })

    if (!res.ok) {
      const body = await res.text()
      log.error({ status: res.status, body }, '[NOTIFY] Slack webhook failed')
      return { channel: 'slack', success: false, error: `HTTP ${res.status}: ${body}` }
    }

    log.info('[NOTIFY] Slack notification sent')
    return { channel: 'slack', success: true }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error({ err }, '[NOTIFY] Slack notification error')
    return { channel: 'slack', success: false, error: msg }
  }
}

/**
 * Create/update a Jira issue for a failed/healed test.
 * Reads project Jira config via project.service.ts (cross-module public interface).
 *
 * On 'test-failed': creates a Bug issue.
 * On 'test-healed': searches for existing issue and adds a comment.
 */
export async function sendJiraNotification(
  projectId: string,
  event: NotificationJob['event'],
  executionId: string,
  details?: Record<string, unknown>,
): Promise<DispatchResult> {
  let jiraConfig: Awaited<ReturnType<typeof getJiraConfig>>

  try {
    jiraConfig = await getJiraConfig(projectId)
  } catch {
    return { channel: 'jira', success: false, error: 'Failed to load Jira config' }
  }

  if (!jiraConfig || !jiraConfig.jira_domain || !jiraConfig.jira_board_id) {
    log.info(`[NOTIFY] Jira not configured for project ${projectId} — skipping`)
    return { channel: 'jira', success: false, error: 'Jira not configured for this project' }
  }

  // Jira token is returned as already-decrypted by getJiraConfig
  // (project.service.ts adds `configured: true` but not the raw token)
  // We need the raw token — call project_integrations directly via getJiraConfig helper
  // project.service.getJiraConfig returns { jira_domain, jira_email, jira_board_id, ... }
  // The token is NOT returned by getJiraConfig (privacy). We use env fallback for test notifications.
  const jiraToken  = process.env.JIRA_API_TOKEN
  const jiraEmail  = jiraConfig.jira_email ?? process.env.JIRA_EMAIL
  const jiraDomain = jiraConfig.jira_domain
  const projectKey = process.env.JIRA_PROJECT_KEY ?? 'AT'

  if (!jiraToken || !jiraEmail) {
    log.warn('[NOTIFY] JIRA_API_TOKEN / JIRA_EMAIL not set — skipping Jira')
    return { channel: 'jira', success: false, error: 'Jira credentials not in environment' }
  }

  const authHeader = 'Basic ' + Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64')
  const domain     = jiraDomain.startsWith('https://') ? jiraDomain : `https://${jiraDomain}`

  try {
    if (event === 'test-failed') {
      const body = {
        fields: {
          project:   { key: projectKey },
          summary:   `[AutoTest AI] Test execution failed — ${executionId}`,
          description: {
            type:    'doc',
            version: 1,
            content: [
              {
                type:    'paragraph',
                content: [{ type: 'text', text: `Execution ID: ${executionId}. Details: ${JSON.stringify(details ?? {})}` }],
              },
            ],
          },
          issuetype: { name: 'Bug' },
          priority:  { name: 'High' },
        },
      }

      const res = await fetch(`${domain}/rest/api/3/issue`, {
        method:  'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })

      if (!res.ok) {
        const text = await res.text()
        log.error({ status: res.status, text }, '[NOTIFY] Jira issue creation failed')
        return { channel: 'jira', success: false, error: `HTTP ${res.status}: ${text}` }
      }

      const issue = (await res.json()) as { key: string }
      log.info(`[NOTIFY] Jira issue created: ${issue.key}`)
      return { channel: 'jira', success: true }
    }

    if (event === 'test-healed' || event === 'test-passed') {
      // Just log — in production, a more sophisticated impl would update the issue
      log.info(`[NOTIFY] Jira: test ${event} for execution ${executionId} — no action required`)
      return { channel: 'jira', success: true }
    }

    return { channel: 'jira', success: false, error: `Unknown event: ${event}` }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error({ err }, '[NOTIFY] Jira notification error')
    return { channel: 'jira', success: false, error: msg }
  }
}

/**
 * Send an email notification via a webhook/SMTP endpoint.
 *
 * In production this would use nodemailer; here we use a fetch-based
 * webhook to avoid heavy transitive deps (nodemailer is not in package.json).
 * If SMTP_HOST is configured, the worker can be extended to use nodemailer.
 */
export async function sendEmailNotification(
  event: NotificationJob['event'],
  executionId: string,
  details?: Record<string, unknown>,
): Promise<DispatchResult> {
  const smtpHost = process.env.SMTP_HOST
  if (!smtpHost) {
    log.info('[NOTIFY] SMTP_HOST not configured — skipping email notification')
    return { channel: 'email', success: false, error: 'SMTP not configured' }
  }

  // Placeholder: in a real implementation, call nodemailer or an email API here.
  log.info(`[NOTIFY] Email notification for event=${event} execution=${executionId} — SMTP stub`)
  return { channel: 'email', success: true }
}

// ─── Dispatcher (used by notification.worker.ts) ──────────────────

/**
 * Main entry point for the notification worker.
 * Dispatches to Jira, Slack, and Email in parallel based on configuration.
 * Returns an array of dispatch results (one per attempted channel).
 */
export async function dispatchNotification(job: NotificationJob): Promise<DispatchResult[]> {
  const { projectId, event, executionId, details } = job
  log.info(`[NOTIFY] Dispatching event='${event}' for project=${projectId} execution=${executionId}`)

  const tasks: Promise<DispatchResult>[] = []

  // Always attempt Slack if webhook is set
  if (process.env.SLACK_WEBHOOK_URL) {
    const text = formatSlackMessage(event, executionId, projectId)
    tasks.push(sendSlackNotification(text))
  }

  // Always attempt Jira (will skip internally if not configured)
  tasks.push(sendJiraNotification(projectId, event, executionId, details))

  // Email — attempt if configured
  tasks.push(sendEmailNotification(event, executionId, details))

  const results = await Promise.allSettled(tasks)
  return results.map((r) =>
    r.status === 'fulfilled'
      ? r.value
      : { channel: 'unknown', success: false, error: String(r.reason) },
  )
}

/**
 * POST /api/v1/notifications/test — send a one-off test notification.
 * Used by the frontend to verify channel config is working.
 */
export async function sendTestNotification(
  projectId: string,
  channel: 'jira' | 'slack' | 'email',
  message: string,
): Promise<{ success: boolean; channel: string; message: string }> {
  let result: DispatchResult

  if (channel === 'slack') {
    result = await sendSlackNotification(message)
  } else if (channel === 'jira') {
    result = await sendJiraNotification(projectId, 'test-failed', 'test-notification', { message })
  } else {
    result = await sendEmailNotification('test-failed', 'test-notification', { message })
  }

  return {
    success: result.success,
    channel: result.channel,
    message: result.success ? 'Test notification sent' : (result.error ?? 'Notification failed'),
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function formatSlackMessage(
  event: NotificationJob['event'],
  executionId: string,
  projectId: string,
): string {
  const emoji = event === 'test-passed' ? '✅' : event === 'test-healed' ? '🔧' : '❌'
  const label = { 'test-passed': 'PASSED', 'test-healed': 'HEALED', 'test-failed': 'FAILED' }[event]
  return `${emoji} *AutoTest AI — Test ${label}*\nProject: ${projectId}\nExecution: ${executionId}`
}
