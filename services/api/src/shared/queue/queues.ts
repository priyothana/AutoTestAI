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
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]
