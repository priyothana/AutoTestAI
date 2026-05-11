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
  // 'webapp' is the legacy value; DB stores 'web_app' — both must be accepted
  projectCategory: 'webapp' | 'web_app' | 'salesforce' | 'api' | 'other'
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

/**
 * Crawl state persisted in auth_config.crawl_state between incremental BullMQ runs.
 * Allows the crawler to resume across multiple 50-page job batches.
 */
export interface CrawlState {
  /** Fully visited + extracted URLs (do not revisit unless thin-metadata) */
  visitedUrls: string[]
  /** Discovered but not-yet-visited URLs — consumed in the next run */
  pendingUrls: string[]
  /** Total unique URLs discovered across all runs (visited + pending) */
  totalDiscoveredPages: number
  /** ISO timestamp of the last completed run */
  lastRunAt: string
  /** How many incremental runs have completed */
  runCount: number
}

/** Test-Case Generation queue — consumed by test-case-generator.worker.ts */
export interface TestCaseGenerationJob {
  /** UUID of the project to generate test cases for */
  projectId: string
  /** User-supplied name for the generated test suite (default: auto-timestamp) */
  suiteName?: string
  /** Max number of test cases to generate */
  count: number
  /** Optional focus areas e.g. ['CRUD', 'Edge Cases', 'Negative Testing'] */
  focusAreas: string[]
  /** Optional selected module to focus generation on */
  selectedModule?: string
  /** Base64-encoded BRD / Functional Spec document content (optional) */
  brdContent?: string
  /** Base64-encoded existing test cases document content (optional) */
  existingTestsContent?: string
  /** Auto-fetched previously executed test cases context for the project */
  executedTestCasesContext?: string
  /** Whether to pull Jira stories from the connected board */
  useJira: boolean
  /** Job status — updated by the worker */
  status?: 'queued' | 'running' | 'completed' | 'failed'
  /** Error message if failed */
  errorMessage?: string
}

/** Metadata-sync queue — consumed by metadata-sync.worker.ts */
export interface MetadataSyncJob {
  /** UUID of the project whose metadata should be synced */
  projectId: string
  /** Who triggered the sync — 'manual' from the UI, 'auto' from connection flow */
  triggeredBy: 'manual' | 'auto'
  /**
   * Integration category — routes the worker to the correct pipeline branch.
   * 'salesforce' → JSforce extraction → normalize → domain → embed
   * 'web_app'    → Playwright crawler → normalize → domain → embed
   * Omitting defaults to 'salesforce' for backward compatibility.
   */
  category?: 'salesforce' | 'web_app'
  /**
   * Set to true by the worker when auto-re-enqueueing a continuation crawl run.
   * When true, only Stage 1 (crawl) runs — stages 2-4 are deferred until the
   * crawl is fully complete (pendingUrls is empty).
   */
  isContinuation?: boolean
}
