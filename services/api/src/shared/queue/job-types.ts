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

  // Interactive (HITL) mode — runs headed Chrome; pauses on step failure for user intervention
  interactive?: boolean

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
  /** Playwright locator strategy: 'label' | 'placeholder' | 'text' | 'role' | 'testid' | 'css' (default) */
  locator_type?: string
  /**
   * SF Lightning field type — used by the execution worker to dispatch the
   * correct interaction handler when action is 'select'.
   * Values: 'picklist' | 'lookup' | 'lookup_advanced' | 'date' | 'dependent_picklist' | 'filtered_lookup'
   */
  sf_field_type?: string
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

/** Metadata-sync queue — consumed by metadata-sync.worker.ts */
export interface MetadataSyncJob {
  /** UUID of the project whose metadata should be synced */
  projectId: string
  /** Who triggered the sync — 'manual' from the UI, 'auto' from connection flow */
  triggeredBy: 'manual' | 'auto'
}
