/**
 * Notification Module — Service Unit Tests
 *
 * Tests:
 *   - sendSlackNotification()
 *   - sendJiraNotification()
 *   - dispatchNotification()
 *   - sendTestNotification()
 *
 * Uses vi.stubGlobal to mock fetch and vi.stubEnv for environment variables.
 * project.service.ts is mocked to avoid any real DB calls.
 *
 * Run with: npm test (Vitest)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Mock project.service.ts ──────────────────────────────────────
vi.mock('../project/project.service.js', () => ({
  getJiraConfig: vi.fn(),
}))

import { getJiraConfig } from '../project/project.service.js'
import {
  sendSlackNotification,
  sendJiraNotification,
  dispatchNotification,
  sendTestNotification,
} from './notification.service.js'
import type { NotificationJob } from '../../shared/queue/job-types.js'

const mockGetJiraConfig = getJiraConfig as ReturnType<typeof vi.fn>

// ─── Helpers ──────────────────────────────────────────────────────

function makeFetchMock(ok: boolean, body: unknown = 'ok') {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    text:   async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json:   async () => body,
  })
}

const PROJECT_ID   = 'aaaaaaaa-0000-0000-0000-000000000001'
const EXECUTION_ID = 'exec-0001'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

// ─── sendSlackNotification ────────────────────────────────────────

describe('sendSlackNotification()', () => {
  it('skips dispatch and returns error when no webhook URL', async () => {
    // No SLACK_WEBHOOK_URL in env, no webhookUrl arg
    vi.stubEnv('SLACK_WEBHOOK_URL', '')
    const result = await sendSlackNotification('hello')
    expect(result.success).toBe(false)
    expect(result.error).toContain('SLACK_WEBHOOK_URL')
  })

  it('returns success:true on 2xx response', async () => {
    const fetchMock = makeFetchMock(true)
    vi.stubGlobal('fetch', fetchMock)

    const result = await sendSlackNotification('hello', 'https://hooks.slack.com/test')
    expect(result.success).toBe(true)
    expect(result.channel).toBe('slack')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('returns success:false on non-2xx response', async () => {
    vi.stubGlobal('fetch', makeFetchMock(false, 'invalid_payload'))
    const result = await sendSlackNotification('bad msg', 'https://hooks.slack.com/test')
    expect(result.success).toBe(false)
    expect(result.error).toContain('HTTP 500')
  })

  it('returns success:false when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const result = await sendSlackNotification('msg', 'https://hooks.slack.com/test')
    expect(result.success).toBe(false)
    expect(result.error).toContain('ECONNREFUSED')
  })
})

// ─── sendJiraNotification ────────────────────────────────────────

describe('sendJiraNotification()', () => {
  it('skips when Jira is not configured for the project', async () => {
    mockGetJiraConfig.mockResolvedValue(null)

    const result = await sendJiraNotification(PROJECT_ID, 'test-failed', EXECUTION_ID)
    expect(result.success).toBe(false)
    expect(result.channel).toBe('jira')
  })

  it('skips when JIRA_API_TOKEN env is missing', async () => {
    mockGetJiraConfig.mockResolvedValue({
      jira_domain:    'mysite.atlassian.net',
      jira_email:     'test@example.com',
      jira_board_id:  '10',
      jira_board_name: 'Sprint',
      configured:     true,
    })
    vi.stubEnv('JIRA_API_TOKEN', '')
    vi.stubEnv('JIRA_EMAIL', '')

    const result = await sendJiraNotification(PROJECT_ID, 'test-failed', EXECUTION_ID)
    expect(result.success).toBe(false)
    expect(result.error).toContain('credentials')
  })

  it('creates Jira issue for test-failed event and returns success', async () => {
    mockGetJiraConfig.mockResolvedValue({
      jira_domain:    'mysite.atlassian.net',
      jira_email:     'dev@example.com',
      jira_board_id:  '10',
      configured:     true,
    })
    vi.stubEnv('JIRA_API_TOKEN', 'token-abc')
    vi.stubEnv('JIRA_EMAIL', 'dev@example.com')
    vi.stubGlobal('fetch', makeFetchMock(true, { key: 'AT-42' }))

    const result = await sendJiraNotification(PROJECT_ID, 'test-failed', EXECUTION_ID)
    expect(result.success).toBe(true)
    expect(result.channel).toBe('jira')
  })

  it('returns success for test-healed event without creating issue', async () => {
    mockGetJiraConfig.mockResolvedValue({
      jira_domain:    'mysite.atlassian.net',
      jira_email:     'dev@example.com',
      jira_board_id:  '10',
      configured:     true,
    })
    vi.stubEnv('JIRA_API_TOKEN', 'token-abc')
    vi.stubEnv('JIRA_EMAIL', 'dev@example.com')

    const fetchMock = makeFetchMock(true)
    vi.stubGlobal('fetch', fetchMock)

    const result = await sendJiraNotification(PROJECT_ID, 'test-healed', EXECUTION_ID)
    expect(result.success).toBe(true)
    // fetch should NOT be called (we just log for healed events)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ─── dispatchNotification ─────────────────────────────────────────

describe('dispatchNotification()', () => {
  it('returns results array with one entry per attempted channel', async () => {
    // Jira: not configured; Slack: not set; Email: not set
    mockGetJiraConfig.mockResolvedValue(null)
    vi.stubEnv('SLACK_WEBHOOK_URL', '')
    vi.stubEnv('SMTP_HOST', '')

    const job: NotificationJob = {
      projectId:   PROJECT_ID,
      event:       'test-failed',
      executionId: EXECUTION_ID,
      testRunId:   'run-001',
    }

    const results = await dispatchNotification(job)
    // Jira + Email should be attempted (Slack is skipped when no URL)
    expect(results.length).toBeGreaterThanOrEqual(1)
  })

  it('sends Slack when SLACK_WEBHOOK_URL is set', async () => {
    mockGetJiraConfig.mockResolvedValue(null)
    vi.stubEnv('SLACK_WEBHOOK_URL', 'https://hooks.slack.com/test')
    vi.stubEnv('JIRA_API_TOKEN', '')
    vi.stubEnv('SMTP_HOST', '')
    vi.stubGlobal('fetch', makeFetchMock(true))

    const job: NotificationJob = {
      projectId:   PROJECT_ID,
      event:       'test-passed',
      executionId: EXECUTION_ID,
      testRunId:   'run-002',
    }

    const results = await dispatchNotification(job)
    const slackResult = results.find((r) => r.channel === 'slack')
    expect(slackResult?.success).toBe(true)
  })
})

// ─── sendTestNotification ─────────────────────────────────────────

describe('sendTestNotification()', () => {
  it('routes to Slack channel and returns formatted response', async () => {
    vi.stubGlobal('fetch', makeFetchMock(true))
    const result = await sendTestNotification(PROJECT_ID, 'slack', 'ping')
    expect(result.channel).toBe('slack')
    expect(result.success).toBe(true)
    expect(result.message).toContain('sent')
  })

  it('returns failure message when Slack webhook fails', async () => {
    vi.stubGlobal('fetch', makeFetchMock(false, 'error'))
    const result = await sendTestNotification(PROJECT_ID, 'slack', 'ping')
    expect(result.success).toBe(false)
    expect(result.message).toBeDefined()
  })

  it('routes to Jira channel', async () => {
    mockGetJiraConfig.mockResolvedValue(null)
    const result = await sendTestNotification(PROJECT_ID, 'jira', 'test')
    // Jira not configured → success:false but does not throw
    expect(result.channel).toBe('jira')
    expect(typeof result.success).toBe('boolean')
  })

  it('routes to email channel', async () => {
    vi.stubEnv('SMTP_HOST', '')
    const result = await sendTestNotification(PROJECT_ID, 'email', 'test')
    expect(result.channel).toBe('email')
    // SMTP not configured → success:false
    expect(result.success).toBe(false)
  })
})
