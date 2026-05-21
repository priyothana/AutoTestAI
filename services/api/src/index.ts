/**
 * AutoTest AI — Fastify Entry Point
 *
 * Single Node.js backend on port 4000.
 * Registers all module routes under /api/v1 — identical paths to Python FastAPI.
 *
 * Stage 3 additions:
 *   - TASK 2: Rich /health endpoint (db + redis + per-queue waiting counts)
 *   - TASK 3: pino-http structured request logging → stdout + logs/node.log (50MB rotation)
 */
import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import fastifyStatic from '@fastify/static'
import { registerJwt } from './shared/auth/jwt.js'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, statSync, renameSync, createWriteStream } from 'fs'
import pino from 'pino'
import { randomUUID } from 'crypto'
import { Queue } from 'bullmq'
import type { IncomingMessage, ServerResponse } from 'http'
// pino-http is CJS-only; use createRequire for type-safe compat
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pinoHttp: (...args: any[]) => any = (() => {
  const _r = createRequire(import.meta.url)
  const m = _r('pino-http')
  return typeof m === 'function' ? m : m.default ?? m.pinoHttp
})()

// Module route imports
import { authRoutes } from './modules/auth/auth.routes.js'
import { projectRoutes } from './modules/project/project.routes.js'
import { testCaseRoutes } from './modules/test-case/test-case.routes.js'
import { testRunRoutes } from './modules/test-run/test-run.routes.js'
import { analyticsRoutes } from './modules/analytics/analytics.routes.js'
import { settingsRoutes } from './modules/settings/settings.routes.js'
import { salesforceRoutes } from './modules/salesforce/salesforce.routes.js'
import { healingRoutes }     from './modules/self-healing/healing.routes.js'
import { selfHealingRoutes } from './modules/self-healing/self-healing.routes.js'
import { generationRoutes }  from './modules/test-generation/generation.routes.js'
import { executionRoutes }   from './modules/execution/execution.routes.js'
import { notificationRoutes } from './modules/notification/notification.routes.js'
import { testCaseGeneratorRoutes } from './modules/test-case-generator/test-case-generator.routes.js'
import { agentRoutes }             from './modules/ai-agents/agent.routes.js'
import { startTestCaseGenerationWorker } from './modules/test-case-generator/test-case-generator.service.js'
import prisma from './shared/db/prisma.js'
import { redisConnection, getRedisOptions } from './shared/queue/connection.js'
import { QUEUES } from './shared/queue/queues.js'

// ─── Read package version once ───────────────────────────────────────────────
import { createRequire } from 'module'
const require = createRequire(import.meta.url) // shared require for CJS interop
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkgVersion: string = (() => {
  try { return (require('../package.json') as { version: string }).version } catch { return 'unknown' }
})()

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
const screenshotsDir = join(staticDir, 'screenshots')
try {
  mkdirSync(join(staticDir, 'test-runs'), { recursive: true })
  mkdirSync(screenshotsDir, { recursive: true })
} catch (e) {
  console.warn('[WARN] Could not create static dirs:', e)
}

// ─── TASK 3: Log file setup with 50MB rotation ───────────────────────────────
const logsDir = join(staticDir, 'logs')
const logFilePath = join(logsDir, 'node.log')
const LOG_MAX_BYTES = 50 * 1024 * 1024 // 50 MB

function setupLogFile(): ReturnType<typeof createWriteStream> {
  mkdirSync(logsDir, { recursive: true })
  try {
    const stat = statSync(logFilePath)
    if (stat.size >= LOG_MAX_BYTES) {
      const rotated = join(logsDir, 'node.log.1')
      renameSync(logFilePath, rotated)
      console.log(`[STARTUP] 📦 Log rotated: node.log → node.log.1 (was ${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
    }
  } catch {
    // File does not exist yet — that's fine
  }
  return createWriteStream(logFilePath, { flags: 'a' })
}

const logFileStream = setupLogFile()

// ─── Pino logger: fan-out to stdout + log file ───────────────────────────────
const logger = pino(
  {
    level: 'info',
    base: { backend: 'node' },
    timestamp: pino.stdTimeFunctions.epochTime, // unix ms
  },
  pino.multistream([
    { stream: process.stdout },
    { stream: logFileStream },
  ]),
)

// ─── pino-http middleware factory ─────────────────────────────────────────────
const httpLogger = pinoHttp({
  logger,
  genReqId: () => randomUUID(),
  customAttributeKeys: { reqId: 'reqId' },
  serializers: {
    req(req: IncomingMessage & { id?: string }) {
      return {
        method: (req as { method?: string }).method,
        url: (req as { url?: string }).url,
        reqId: req.id,
      }
    },
    res(res: ServerResponse) {
      return { statusCode: res.statusCode }
    },
  },
  customSuccessMessage(_req: IncomingMessage, res: ServerResponse) {
    return `${res.statusCode}`
  },
  customErrorMessage(_req: IncomingMessage, res: ServerResponse) {
    return `${res.statusCode}`
  },
})

// ─── Build Fastify app ───────────────────────────────────────────────────────
export async function buildApp() {
  const app = Fastify({
    logger: false,
    ignoreTrailingSlash: true,
    // Raise body limit to 10 MB to allow BRD / existing-tests document uploads.
    // Default is 1 MB which silently 413s large document payloads.
    bodyLimit: 10 * 1024 * 1024,  // 10 MB
  })

  // Attach pino-http as a global hook
  app.addHook('onRequest', (req, reply, done) => {
    httpLogger(req.raw, reply.raw)
    done()
  })

  await app.register(cors, {
    origin: (origin, cb) => {
      // Allow requests from the AutoTest frontend origins, localhost variants,
      // AND from direct API calls / Playwright in-browser overlays (null or undefined origin).
      const allowedOrigins = [
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://localhost:3001',
        'http://localhost:3002',
        'http://127.0.0.1:3002',
        'http://localhost:4000',
        'http://127.0.0.1:4000',
      ]
      // Allow null origin (Playwright in-browser fetch, file:// pages, etc.)
      // and undefined (same-origin / direct server calls)
      if (!origin || origin === 'null' || allowedOrigins.includes(origin)) {
        cb(null, true)
      } else {
        cb(null, false)
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })


  await app.register(helmet, { 
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false 
  })
  await registerJwt(app)

  // Static file serving
  try {
    await app.register(fastifyStatic, { root: staticDir, prefix: '/static/', decorateReply: false })
    await app.register(fastifyStatic, { root: screenshotsDir, prefix: '/screenshots/', decorateReply: false })
  } catch (e) {
    console.warn('[WARN] Static serving unavailable:', e)
  }

  // ─── Register each module with individual error reporting ────────────────
  type ModuleEntry = { name: string; fn: (a: ReturnType<typeof Fastify>, opts: object) => Promise<void>; prefix: string }
  const modules: ModuleEntry[] = [
    { name: 'auth',         fn: authRoutes as never,         prefix: '/api/v1/users' },
    { name: 'project',      fn: projectRoutes as never,      prefix: '/api/v1' },
    { name: 'test-case',    fn: testCaseRoutes as never,     prefix: '/api/v1' },
    { name: 'test-run',     fn: testRunRoutes as never,      prefix: '/api/v1/test-runs' },
    { name: 'analytics',    fn: analyticsRoutes as never,    prefix: '/api/v1/analytics' },
    { name: 'settings',     fn: settingsRoutes as never,     prefix: '/api/v1/settings' },
    { name: 'salesforce',   fn: salesforceRoutes as never,   prefix: '/api/v1' },
    { name: 'healing',      fn: healingRoutes as never,      prefix: '/api/v1' },
    { name: 'self-healing', fn: selfHealingRoutes as never,  prefix: '/api/v1' },
    { name: 'generation',           fn: generationRoutes as never,           prefix: '/api/v1' },
    { name: 'execution',            fn: executionRoutes as never,            prefix: '/api/v1' },
    { name: 'notification',         fn: notificationRoutes as never,         prefix: '/api/v1' },
    { name: 'test-case-generator',  fn: testCaseGeneratorRoutes as never,    prefix: '/api/v1' },
    { name: 'ai-agents',            fn: agentRoutes as never,               prefix: '/api/v1/agents' },
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

  // ─── TASK 2: Root ping ────────────────────────────────────────────────────
  app.get('/', async () => ({ message: 'AutoTest AI API', status: 'ok', backend: 'node', port: 4000 }))

  // ─── TASK 2: Rich /health endpoint ───────────────────────────────────────
  app.get('/health', async (_req, reply) => {
    const startCheck = Date.now()

    // DB check
    let dbStatus: 'ok' | 'error' = 'error'
    try {
      await prisma.$queryRaw`SELECT 1`
      dbStatus = 'ok'
    } catch { /* stays 'error' */ }

    // Redis check via shared connection
    let redisStatus: 'ok' | 'error' = 'error'
    try {
      await redisConnection.ping()
      redisStatus = 'ok'
    } catch { /* stays 'error' */ }

    // Queue waiting counts
    const connOpts = getRedisOptions()
    const executionQueue  = new Queue(QUEUES.EXECUTION,    { ...connOpts })
    const healingQueue    = new Queue(QUEUES.HEALING,      { ...connOpts })
    const notificationQueue = new Queue(QUEUES.NOTIFICATION, { ...connOpts })

    let executionWaiting  = -1
    let healingWaiting    = -1
    let notificationWaiting = -1

    try { executionWaiting    = await executionQueue.getWaitingCount()    } catch { /* skip */ }
    try { healingWaiting      = await healingQueue.getWaitingCount()      } catch { /* skip */ }
    try { notificationWaiting = await notificationQueue.getWaitingCount() } catch { /* skip */ }

    // Cleanup throwaway Queue instances (don't close the shared connection)
    await executionQueue.close().catch(() => {})
    await healingQueue.close().catch(() => {})
    await notificationQueue.close().catch(() => {})

    const overallOk = dbStatus === 'ok' && redisStatus === 'ok'
    const httpStatus = overallOk ? 200 : 503

    logger.info({ event: 'health_check', db: dbStatus, redis: redisStatus, durationMs: Date.now() - startCheck })

    return reply.status(httpStatus).send({
      status:    overallOk ? 'ok' : 'error',
      backend:   'node',
      version:   pkgVersion,
      timestamp: new Date().toISOString(),
      uptime:    process.uptime(),
      modules: {
        db:    dbStatus,
        redis: redisStatus,
        queues: {
          execution:    executionWaiting,
          healing:      healingWaiting,
          notification: notificationWaiting,
        },
      },
    })
  })

  return app
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const port = parseInt(process.env.PORT ?? '4000', 10)

  logger.info({ event: 'startup', port, nodeEnv: process.env.NODE_ENV ?? 'not set', version: pkgVersion },
    'AutoTest AI API starting')
  console.log('[STARTUP] ========================================')
  console.log(`[STARTUP] AutoTest AI API starting on port ${port}`)
  console.log(`[STARTUP] NODE_ENV    = ${process.env.NODE_ENV ?? 'not set'}`)
  console.log(`[STARTUP] DATABASE_URL= ${(process.env.DATABASE_URL ?? 'not set').replace(/:\/\/[^@]+@/, '://<redacted>@')}`)
  console.log(`[STARTUP] REDIS_URL   = ${process.env.REDIS_URL ?? 'not set'}`)
  console.log(`[STARTUP] Log file    = ${logFilePath}`)
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

  // ── Auto-start the metadata-sync worker (4-stage Salesforce pipeline) ──────
  // Import is non-blocking — if Redis is unavailable the worker logs a warning
  // but the API server continues to serve requests normally.
  import('./workers/metadata-sync.worker.js')
    .then(() => console.log('[STARTUP] ✅ Metadata-sync worker started'))
    .catch((e: Error) => console.warn('[STARTUP] ⚠️  Metadata-sync worker failed to start:', e.message))

  // ── Auto-start the execution worker (Playwright test runner) ─────────────
  // This worker consumes from execution-queue and runs Playwright headlessly.
  // Must be running for "Run Test" to work — it is the ONLY place Playwright runs.
  import('./workers/execution.worker.js')
    .then(() => console.log('[STARTUP] ✅ Execution worker started (Playwright runner active)'))
    .catch((e: Error) => console.warn('[STARTUP] ⚠️  Execution worker failed to start:', e.message))

  // ── Auto-start the healing worker (AI self-healing) ──────────────────────
  import('./workers/healing.worker.js')
    .then(() => console.log('[STARTUP] ✅ Healing worker started'))
    .catch((e: Error) => console.warn('[STARTUP] ⚠️  Healing worker failed to start:', e.message))

  // ── Auto-start the notification worker ───────────────────────────────────────
  import('./workers/notification.worker.js')
    .then(() => console.log('[STARTUP] ✅ Notification worker started'))
    .catch((e: Error) => console.warn('[STARTUP] ⚠️  Notification worker failed to start:', e.message))

  // ── Auto-start the test-case-generation worker ───────────────────────────────────────
  try {
    startTestCaseGenerationWorker()
    console.log('[STARTUP] ✅ Test-case-generation worker started')
  } catch (e) {
    console.warn('[STARTUP] ⚠️  Test-case-generation worker failed to start:', (e as Error).message)
  }
}

main()
