/**
 * Prisma Client Singleton
 *
 * All modules import the Prisma client from here — never instantiate directly.
 * Prevents multiple client instances in development (hot-reload safe).
 */
import { PrismaClient } from '../../../node_modules/.prisma/client/index.js'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['warn', 'error']  // removed 'query' — too noisy during dev
        : ['warn', 'error'],
    // Short connection timeout so DB routes fail fast instead of hanging
    datasources: {
      db: {
        url: process.env.DATABASE_URL,
      },
    },
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

export default prisma
