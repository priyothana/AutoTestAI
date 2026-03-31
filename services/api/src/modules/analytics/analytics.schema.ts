/**
 * Analytics Module — Zod Schemas
 *
 * Maps from Python Pydantic: DashboardStats, StatusDistribution, DailyTrend, etc.
 * Includes project-scoped schemas for:
 *   GET /api/v1/analytics/projects/:id/summary
 *   GET /api/v1/analytics/projects/:id/flakiness
 *   GET /api/v1/analytics/projects/:id/coverage
 */
import { z } from 'zod'

// ─── Global dashboard schemas (existing routes) ───────────────────

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

// ─── Project-scoped schemas (skill-spec routes) ───────────────────

/**
 * GET /api/v1/analytics/projects/:id/summary
 * High-level execution stats for a specific project.
 */
export const ProjectSummarySchema = z.object({
  project_id: z.string(),
  project_name: z.string(),
  total_test_cases: z.number(),
  total_runs: z.number(),
  passed: z.number(),
  failed: z.number(),
  pass_rate: z.number(),  // percentage 0-100
  last_run_at: z.string().nullable(),
})

/**
 * GET /api/v1/analytics/projects/:id/flakiness
 * Flaky tests = ran ≥ 2 times and flipped between passed / failed at least once.
 */
export const FlakinessItemSchema = z.object({
  test_case_id: z.string(),
  test_case_name: z.string(),
  total_runs: z.number(),
  pass_count: z.number(),
  fail_count: z.number(),
  flakiness_rate: z.number(), // failed / total, 0-1
})

export const FlakinessReportSchema = z.object({
  project_id: z.string(),
  flaky_tests: z.array(FlakinessItemSchema),
  total_flaky: z.number(),
})

/**
 * GET /api/v1/analytics/projects/:id/coverage
 * Coverage = % of test_cases that have at least one passing run.
 */
export const CoverageReportSchema = z.object({
  project_id: z.string(),
  total_test_cases: z.number(),
  tested: z.number(),          // has ≥1 run
  passing: z.number(),         // has ≥1 passing run
  coverage_rate: z.number(),   // passing / total_test_cases, 0-1
})

export type ProjectSummary    = z.infer<typeof ProjectSummarySchema>
export type FlakinessItem     = z.infer<typeof FlakinessItemSchema>
export type FlakinessReport   = z.infer<typeof FlakinessReportSchema>
export type CoverageReport    = z.infer<typeof CoverageReportSchema>
