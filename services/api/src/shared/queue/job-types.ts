/**
 * BullMQ Job Type Interfaces
 *
 * Typed contracts for all queue jobs.
 * Both producer and consumer import from here — never duplicate the shape.
 */

/** Execution queue — consumed by execution.worker.ts */
export interface ExecutionJob {
  testRunId: string
  testCaseId: string
  projectId: string
  triggeredBy: 'manual' | 'auto'
  context: ExecutionContext
}

/** The flattened execution context (replaces Python's 20+ function params) */
export interface ExecutionContext {
  baseUrl: string
  steps: StepData[]

  // Project
  projectCategory: 'webapp' | 'salesforce' | 'api' | 'other'
  integrationStatus: 'connected' | 'disconnected' | 'error' | 'syncing'

  // Session
  useSessionReuse: boolean
  isLoginTest: boolean

  // Salesforce (optional — only for SF projects)
  sfAccessToken?: string
  sfInstanceUrl?: string
  sfUsername?: string
  sfPassword?: string
  sfLoginUrl?: string
  sfSecurityToken?: string
  sfSessionId?: string
  mcpConnected?: boolean

  // Web App (optional — only for webapp projects)
  webUsername?: string
  webPassword?: string
  webLoginUrl?: string
  webLoginStrategy?: 'form' | 'basic_auth' | 'sso' | 'none'
}

/** Individual test step — matches frontend/backend JSON shape */
export interface StepData {
  id: string
  action: string
  target?: string
  value?: string
}

/** Healing queue — consumed by healing.worker.ts */
export interface HealingJob {
  executionId: string
  testRunId: string
  testCaseId: string
  projectId: string
  failedLocator: string
  screenshotBase64: string
  htmlSnippet: string
  logs: Record<string, unknown>[]
  steps: StepData[]
}

/** Notification queue — consumed by notification.worker.ts */
export interface NotificationJob {
  projectId: string
  event: 'test-failed' | 'test-healed' | 'test-passed'
  executionId: string
  testRunId: string
  details?: Record<string, unknown>
}

/** Crawler queue — consumed by crawler.worker.ts */
export interface CrawlerJob {
  projectId: string
  baseUrl: string
  maxPages: number
  authSessionPath?: string
  targetObject?: string
  credentials?: {
    username: string
    password: string
  }
}
