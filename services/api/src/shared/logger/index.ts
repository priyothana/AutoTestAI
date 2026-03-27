/**
 * Application Logger — pino
 *
 * Replaces Python's loguru / logging.
 * All modules import `logger` from here for consistent formatting.
 */
import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
})

/**
 * Create a child logger scoped to a module name.
 * Usage: `const log = createModuleLogger('salesforce')`
 */
export function createModuleLogger(module: string) {
  return logger.child({ module })
}

export default logger
