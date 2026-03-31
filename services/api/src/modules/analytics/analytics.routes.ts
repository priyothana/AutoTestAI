/**
 * Analytics Module — Routes
 *
 * Global dashboard routes (existing — frontend uses these):
 *   GET /api/v1/analytics/dashboard-stats
 *   GET /api/v1/analytics/execution-distribution
 *   GET /api/v1/analytics/reports/trend
 *   GET /api/v1/analytics/reports/projects
 *   GET /api/v1/analytics/reports/top-failed
 *
 * Project-scoped routes (skill spec):
 *   GET /api/v1/analytics/projects/:id/summary
 *   GET /api/v1/analytics/projects/:id/flakiness
 *   GET /api/v1/analytics/projects/:id/coverage
 *
 * Registered in index.ts as:
 *   app.register(analyticsRoutes, { prefix: '/api/v1/analytics' })
 */
import type { FastifyInstance } from 'fastify'
import {
  getDashboardStats,
  getExecutionDistribution,
  getExecutionTrend,
  getProjectExecutionSummary,
  getTopFailedTests,
  getProjectSummary,
  getProjectFlakiness,
  getProjectCoverage,
} from './analytics.service.js'

export async function analyticsRoutes(app: FastifyInstance) {
  // ─── Global dashboard routes ──────────────────────────────────────
  app.get('/dashboard-stats', async (_request, reply) => {
    const stats = await getDashboardStats()
    return reply.send(stats)
  })

  app.get('/execution-distribution', async (_request, reply) => {
    const dist = await getExecutionDistribution()
    return reply.send(dist)
  })

  app.get('/reports/trend', async (_request, reply) => {
    const trend = await getExecutionTrend()
    return reply.send(trend)
  })

  app.get('/reports/projects', async (_request, reply) => {
    const summary = await getProjectExecutionSummary()
    return reply.send(summary)
  })

  app.get('/reports/top-failed', async (_request, reply) => {
    const topFailed = await getTopFailedTests()
    return reply.send(topFailed)
  })

  // ─── Project-scoped routes (skill spec) ──────────────────────────

  /**
   * GET /api/v1/analytics/projects/:id/summary
   * Returns total runs, pass/fail counts, pass rate, and last run time for a project.
   */
  app.get<{ Params: { id: string } }>(
    '/projects/:id/summary',
    async (request, reply) => {
      try {
        const result = await getProjectSummary(request.params.id)
        return reply.send(result)
      } catch (err: unknown) {
        const e = err as { statusCode?: number; message?: string }
        if (e.statusCode) return reply.status(e.statusCode).send({ detail: e.message })
        throw err
      }
    },
  )

  /**
   * GET /api/v1/analytics/projects/:id/flakiness
   * Returns test cases that have both passed and failed — indicating flakiness.
   */
  app.get<{ Params: { id: string } }>(
    '/projects/:id/flakiness',
    async (request, reply) => {
      try {
        const result = await getProjectFlakiness(request.params.id)
        return reply.send(result)
      } catch (err: unknown) {
        const e = err as { statusCode?: number; message?: string }
        if (e.statusCode) return reply.status(e.statusCode).send({ detail: e.message })
        throw err
      }
    },
  )

  /**
   * GET /api/v1/analytics/projects/:id/coverage
   * Returns what % of test cases have at least one passing run.
   */
  app.get<{ Params: { id: string } }>(
    '/projects/:id/coverage',
    async (request, reply) => {
      try {
        const result = await getProjectCoverage(request.params.id)
        return reply.send(result)
      } catch (err: unknown) {
        const e = err as { statusCode?: number; message?: string }
        if (e.statusCode) return reply.status(e.statusCode).send({ detail: e.message })
        throw err
      }
    },
  )
}
