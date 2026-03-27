/**
 * Analytics Module — Routes
 *
 * GET /api/v1/analytics/dashboard-stats
 * GET /api/v1/analytics/execution-distribution
 * GET /api/v1/analytics/reports/trend
 * GET /api/v1/analytics/reports/projects
 * GET /api/v1/analytics/reports/top-failed
 *
 * Exact contract match with Python: app/api/v1/endpoints/analytics.py
 */
import type { FastifyInstance } from 'fastify'
import {
  getDashboardStats,
  getExecutionDistribution,
  getExecutionTrend,
  getProjectExecutionSummary,
  getTopFailedTests,
} from './analytics.service.js'

export async function analyticsRoutes(app: FastifyInstance) {
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
}
