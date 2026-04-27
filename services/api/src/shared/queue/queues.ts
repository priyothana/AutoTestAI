/**
 * Queue Name Constants
 *
 * Single source of truth for all BullMQ queue names.
 * Both producers (services) and consumers (workers) import from here.
 */
export const QUEUES = {
  /** Test execution — Playwright headless runs */
  EXECUTION: 'execution-queue',

  /** Self-healing — locator repair after test failure */
  HEALING: 'healing-queue',

  /** Notifications — Jira/Slack/Email dispatch */
  NOTIFICATION: 'notification-queue',

  /** WebApp crawling — Playwright DOM crawl for metadata */
  CRAWLER: 'crawler-queue',

  /** Salesforce metadata sync pipeline — Normalizer → Domain Builder → Embeddings */
  METADATA_SYNC: 'metadata-sync-queue',

  /** AI Test-Case Generation — async multi-source generation jobs */
  TEST_CASE_GENERATION: 'test-case-generation-queue',
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]
