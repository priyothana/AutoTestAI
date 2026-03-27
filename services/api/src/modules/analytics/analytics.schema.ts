/**
 * Analytics Module — Zod Schemas
 *
 * Maps from Python Pydantic: DashboardStats, StatusDistribution, DailyTrend, etc.
 */
import { z } from 'zod'

export const DashboardStatsSchema = z.object({
  total_projects: z.number(),
  total_test_cases: z.number(),
  total_executions: z.number(),
  pass_rate: z.number(),
})

export const StatusDistributionSchema = z.object({
  result: z.string(),
  count: z.number(),
})

export const DailyTrendSchema = z.object({
  date: z.string(), // ISO date string
  passed: z.number(),
  failed: z.number(),
})

export const ProjectExecutionSummarySchema = z.object({
  project_name: z.string(),
  total_runs: z.number(),
  passed: z.number(),
  failed: z.number(),
})

export const TopFailedTestCaseSchema = z.object({
  name: z.string(),
  fail_count: z.number(),
})

export type DashboardStats = z.infer<typeof DashboardStatsSchema>
export type StatusDistribution = z.infer<typeof StatusDistributionSchema>
export type DailyTrend = z.infer<typeof DailyTrendSchema>
export type ProjectExecutionSummary = z.infer<typeof ProjectExecutionSummarySchema>
export type TopFailedTestCase = z.infer<typeof TopFailedTestCaseSchema>
