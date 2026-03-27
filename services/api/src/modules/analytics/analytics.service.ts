/**
 * Analytics Module — Service Layer
 *
 * Pure read-only Prisma queries. No writes.
 * Port of Python: app/api/v1/endpoints/analytics.py
 */
import prisma from '../../shared/db/prisma.js'
import type {
  DashboardStats,
  StatusDistribution,
  DailyTrend,
  ProjectExecutionSummary,
  TopFailedTestCase,
} from './analytics.schema.js'

/**
 * Dashboard stats: total projects, test cases, executions, pass rate.
 */
export async function getDashboardStats(): Promise<DashboardStats> {
  const [totalProjects, totalTestCases, totalExecutions, totalPassed] =
    await Promise.all([
      prisma.projects.count(),
      prisma.test_cases.count(),
      prisma.test_runs.count(),
      prisma.test_runs.count({ where: { result: 'passed' } }),
    ])

  const passRate =
    totalExecutions > 0
      ? Math.round((totalPassed / totalExecutions) * 10000) / 100
      : 0

  return {
    total_projects: totalProjects,
    total_test_cases: totalTestCases,
    total_executions: totalExecutions,
    pass_rate: passRate,
  }
}

/**
 * Execution result distribution (passed, failed, error, etc.)
 */
export async function getExecutionDistribution(): Promise<StatusDistribution[]> {
  const results = await prisma.test_runs.groupBy({
    by: ['result'],
    _count: { id: true },
  })

  return results.map((r) => ({
    result: r.result ?? 'unknown',
    count: r._count.id,
  }))
}

/**
 * Daily execution trend (last 7 days).
 */
export async function getExecutionTrend(): Promise<DailyTrend[]> {
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

  // Use raw query for date grouping (Prisma doesn't support DATE cast in groupBy)
  const results = await prisma.$queryRaw<
    { date: Date; passed: bigint; failed: bigint }[]
  >`
    SELECT
      DATE(created_at) as date,
      SUM(CASE WHEN result = 'passed' THEN 1 ELSE 0 END) as passed,
      SUM(CASE WHEN result = 'failed' THEN 1 ELSE 0 END) as failed
    FROM test_runs
    WHERE created_at >= ${sevenDaysAgo}
    GROUP BY DATE(created_at)
    ORDER BY date
  `

  return results.map((r) => ({
    date: r.date.toISOString().split('T')[0]!,
    passed: Number(r.passed),
    failed: Number(r.failed),
  }))
}

/**
 * Per-project execution summary.
 */
export async function getProjectExecutionSummary(): Promise<ProjectExecutionSummary[]> {
  const results = await prisma.$queryRaw<
    { project_name: string; total_runs: bigint; passed: bigint; failed: bigint }[]
  >`
    SELECT
      p.name as project_name,
      COUNT(tr.id) as total_runs,
      SUM(CASE WHEN tr.result = 'passed' THEN 1 ELSE 0 END) as passed,
      SUM(CASE WHEN tr.result = 'failed' THEN 1 ELSE 0 END) as failed
    FROM projects p
    JOIN test_cases tc ON p.id = tc.project_id
    JOIN test_runs tr ON tc.id = tr.test_case_id
    GROUP BY p.name
  `

  return results.map((r) => ({
    project_name: r.project_name,
    total_runs: Number(r.total_runs),
    passed: Number(r.passed),
    failed: Number(r.failed),
  }))
}

/**
 * Top 5 most-failed test cases.
 */
export async function getTopFailedTests(): Promise<TopFailedTestCase[]> {
  const results = await prisma.$queryRaw<
    { name: string; fail_count: bigint }[]
  >`
    SELECT
      tc.name,
      COUNT(tr.id) as fail_count
    FROM test_cases tc
    JOIN test_runs tr ON tc.id = tr.test_case_id
    WHERE tr.result = 'failed'
    GROUP BY tc.name
    ORDER BY fail_count DESC
    LIMIT 5
  `

  return results.map((r) => ({
    name: r.name,
    fail_count: Number(r.fail_count),
  }))
}
