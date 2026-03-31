/**
 * AutoTest AI — Fastify Entry Point
 *
 * Single Node.js backend on port 4000.
 * Registers all module routes under /api/v1 — identical paths to Python FastAPI.
 */
import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import fastifyStatic from '@fastify/static'
import { registerJwt } from './shared/auth/jwt.js'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync } from 'fs'

// Module route imports
import { authRoutes } from './modules/auth/auth.routes.js'
import { projectRoutes } from './modules/project/project.routes.js'
import { testCaseRoutes } from './modules/test-case/test-case.routes.js'
import { testRunRoutes } from './modules/test-run/test-run.routes.js'
import { analyticsRoutes } from './modules/analytics/analytics.routes.js'
import { settingsRoutes } from './modules/settings/settings.routes.js'
import { salesforceRoutes } from './modules/salesforce/salesforce.routes.js'
import { healingRoutes } from './modules/self-healing/healing.routes.js'
import { generationRoutes } from './modules/test-generation/generation.routes.js'
import { executionRoutes } from './modules/execution/execution.routes.js'
import { notificationRoutes } from './modules/notification/notification.routes.js'
import prisma from './shared/db/prisma.js'

// ─── Global crash handlers — print everything to stdout for docker logs ──
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.message)
  console.error(err.stack)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Rejection:', String(reason))
  process.exit(1)
})

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Prepare static dirs ─────────────────────────────────────────────────────
const staticDir = join(__dirname, '..', 'static')
const screenshotsDir = join(__dirname, '..', 'screenshots')
try {
  mkdirSync(join(staticDir, 'test-runs'), { recursive: true })
  mkdirSync(screenshotsDir, { recursive: true })
} catch (e) {
  console.warn('[WARN] Could not create static dirs:', e)
}

// ─── Build Fastify app ───────────────────────────────────────────────────────
export async function buildApp() {
  const app = Fastify({ logger: false, ignoreTrailingSlash: true })

  await app.register(cors, {
    origin: [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:3001',
      'http://localhost:3002',
      'http://127.0.0.1:3002',
      'http://localhost:4000',
      'http://127.0.0.1:4000',
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })

  await app.register(helmet, { contentSecurityPolicy: false })
  await registerJwt(app)

  // Static file serving
  try {
    await app.register(fastifyStatic, { root: staticDir, prefix: '/static/', decorateReply: false })
    await app.register(fastifyStatic, { root: screenshotsDir, prefix: '/screenshots/', decorateReply: false })
  } catch (e) {
    console.warn('[WARN] Static serving unavailable:', e)
  }

  // ─── Register each module with individual error reporting ────────────────
  const modules: Array<{ name: string; fn: (app: typeof app, opts: object) => Promise<void>; prefix: string }> = [
    { name: 'auth',         fn: authRoutes as never,         prefix: '/api/v1/users' },
    { name: 'project',      fn: projectRoutes as never,      prefix: '/api/v1' },
    { name: 'test-case',    fn: testCaseRoutes as never,     prefix: '/api/v1' },
    { name: 'test-run',     fn: testRunRoutes as never,      prefix: '/api/v1/test-runs' },
    { name: 'analytics',    fn: analyticsRoutes as never,    prefix: '/api/v1/analytics' },
    { name: 'settings',     fn: settingsRoutes as never,     prefix: '/api/v1/settings' },
    { name: 'salesforce',   fn: salesforceRoutes as never,   prefix: '/api/v1' },
    { name: 'healing',      fn: healingRoutes as never,      prefix: '/api/v1' },
    { name: 'generation',   fn: generationRoutes as never,   prefix: '/api/v1' },
    { name: 'execution',    fn: executionRoutes as never,    prefix: '/api/v1' },
    { name: 'notification', fn: notificationRoutes as never, prefix: '/api/v1' },
  ]

  for (const mod of modules) {
    try {
      await app.register(mod.fn, { prefix: mod.prefix })
      console.log(`[STARTUP] ✓ ${mod.name} routes registered`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[STARTUP] ✗ FAILED to register ${mod.name}: ${msg}`)
      throw err
    }
  }

  // Health endpoints
  app.get('/', async () => ({ message: 'AutoTest AI API', status: 'ok', port: 4000 }))
  app.get('/health', async () => ({ status: 'ok', service: 'autotest-ai-api', timestamp: new Date().toISOString() }))

  return app
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const port = parseInt(process.env.PORT ?? '4000', 10)

  console.log('[STARTUP] ========================================')
  console.log(`[STARTUP] AutoTest AI API starting on port ${port}`)
  console.log(`[STARTUP] NODE_ENV    = ${process.env.NODE_ENV ?? 'not set'}`)
  console.log(`[STARTUP] DATABASE_URL= ${(process.env.DATABASE_URL ?? 'not set').replace(/:\/\/[^@]+@/, '://<redacted>@')}`)
  console.log(`[STARTUP] REDIS_URL   = ${process.env.REDIS_URL ?? 'not set'}`)
  console.log('[STARTUP] ========================================')

  let app: Awaited<ReturnType<typeof buildApp>>
  try {
    app = await buildApp()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[FATAL] buildApp() failed: ${msg}`)
    if (err instanceof Error && err.stack) console.error(err.stack)
    process.exit(1)
  }

  try {
    await app.listen({ port, host: '0.0.0.0' })
    console.log(`[STARTUP] 🚀 Server running → http://0.0.0.0:${port}`)
    console.log(`[STARTUP] 🏥 Health     → http://localhost:${port}/health`)
    console.log(`[STARTUP] 📍 API        → http://localhost:${port}/api/v1`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[FATAL] listen() failed: ${msg}`)
    process.exit(1)
  }

  // Non-blocking DB check
  prisma.$queryRaw`SELECT 1`
    .then(() => console.log('[STARTUP] ✅ Database connected'))
    .catch((e: Error) => console.warn('[STARTUP] ⚠️  Database unreachable:', e.message))
}

main()
