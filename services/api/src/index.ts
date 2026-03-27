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
import { createModuleLogger } from './shared/logger/index.js'
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
import { selfHealingRoutes } from './modules/self-healing/self-healing.routes.js'
import prisma from './shared/db/prisma.js'

const log = createModuleLogger('server')
const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Prepare static dirs ─────────────────────────────────────────
const staticDir = join(__dirname, '..', 'static')
const screenshotsDir = join(__dirname, '..', 'screenshots')
mkdirSync(join(staticDir, 'test-runs'), { recursive: true })
mkdirSync(screenshotsDir, { recursive: true })

// ─── Build app ───────────────────────────────────────────────────
export async function buildApp() {
  const app = Fastify({ logger: false })

  // CORS — match Python's allow_origins
  await app.register(cors, {
    origin: [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:3001',
      'http://localhost:4000',
      'http://127.0.0.1:4000',
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })

  await app.register(helmet, { contentSecurityPolicy: false })

  // JWT
  await registerJwt(app)

  // Static file serving (test run screenshots + assets)
  await app.register(fastifyStatic, {
    root: staticDir,
    prefix: '/static/',
    decorateReply: false,
  })

  await app.register(fastifyStatic, {
    root: screenshotsDir,
    prefix: '/screenshots/',
    decorateReply: false,
  })

  // ─── Module Registration ────────────────────────────────────────
  // Every path must match Python FastAPI's /api/v1/<resource> exactly

  await app.register(authRoutes,      { prefix: '/api/v1/users' })
  await app.register(projectRoutes,   { prefix: '/api/v1' })
  await app.register(testCaseRoutes,  { prefix: '/api/v1' })
  await app.register(testRunRoutes,   { prefix: '/api/v1/test-runs' })
  await app.register(analyticsRoutes, { prefix: '/api/v1/analytics' })
  await app.register(settingsRoutes,  { prefix: '/api/v1/settings' })
  await app.register(salesforceRoutes,  { prefix: '/api/v1' })
  await app.register(selfHealingRoutes, { prefix: '/api/v1' })

  // Root health check (no DB dependency — always responds)
  app.get('/', async () => ({ message: 'AutoTest AI API', status: 'ok', port: 4000 }))

  // /health — liveness probe
  app.get('/health', async () => ({
    status: 'ok',
    service: 'autotest-ai-api',
    timestamp: new Date().toISOString(),
  }))

  return app
}

// ─── Start Server ────────────────────────────────────────────────
const port = parseInt(process.env.PORT ?? '4000', 10)

const app = await buildApp()

try {
  await app.listen({ port, host: '0.0.0.0' })
  log.info(`🚀 AutoTest AI API running on http://localhost:${port}`)
  log.info(`📍 API prefix: /api/v1`)
} catch (err) {
  log.error(err)
  process.exit(1)
}

// Non-blocking DB connectivity check — warns if Postgres is unreachable
prisma.$queryRaw`SELECT 1`
  .then(() => log.info('✅ Database connected'))
  .catch((err: Error) => log.warn({ msg: err.message }, '⚠️  Database unreachable — DB routes will fail until Postgres is available'))

export default app
