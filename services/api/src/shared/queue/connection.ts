/**
 * Redis / BullMQ Connection
 *
 * Shared Redis connection used by all BullMQ queues and workers.
 * Replaces Celery broker (redis://redis:6379/0).
 */
import { Redis } from 'ioredis'
import { createModuleLogger } from '../logger/index.js'

const log = createModuleLogger('queue')

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'

/**
 * Shared Redis connection instance.
 * Both Queue and Worker instances should use getRedisOptions() for BullMQ.
 */
export const redisConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck: false,
  lazyConnect: true,
})

redisConnection.on('connect', () => {
  log.info(`Redis connected: ${redisUrl}`)
})

redisConnection.on('error', (err: Error) => {
  log.error({ err }, 'Redis connection error')
})

/**
 * Get BullMQ-compatible connection options (host/port object).
 * BullMQ recommends separate connections for Queue vs Worker.
 */
export function getRedisOptions() {
  const parsed = new URL(redisUrl)
  return {
    connection: {
      host: parsed.hostname || 'localhost',
      port: parseInt(parsed.port || '6379', 10),
      maxRetriesPerRequest: null as null,
      enableReadyCheck: false,
    },
  }
}

export default redisConnection
