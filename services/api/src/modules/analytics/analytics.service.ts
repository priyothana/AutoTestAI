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
  ProjectSummary,
  FlakinessReport,
  CoverageReport,
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

// ─── Project-scoped analytics ────────────────────────────────────

/**
 * GET /api/v1/analytics/projects/:id/summary
 * High-level execution counts + pass rate for a single project.
 */
export async function getProjectSummary(projectId: string): Promise<ProjectSummary> {
  const project = await prisma.projects.findUnique({
    where: { id: projectId },
    select: { id: true, name: true },
  })
  if (!project) throw { statusCode: 404, message: 'Project not found' }

  const testCases = await prisma.test_cases.findMany({
    where: { project_id: projectId },
    select: { id: true },
  })
  const testCaseIds = testCases.map((tc) => tc.id)
  const totalTestCases = testCaseIds.length

  if (totalTestCases === 0) {
    return {
      project_id: projectId,
      project_name: project.name,
      total_test_cases: 0,
      total_runs: 0,
      passed: 0,
      failed: 0,
      pass_rate: 0,
      last_run_at: null,
    }
  }

  const [totalRuns, passedRuns, lastRun] = await Promise.all([
    prisma.test_runs.count({ where: { test_case_id: { in: testCaseIds } } }),
    prisma.test_runs.count({ where: { test_case_id: { in: testCaseIds }, result: 'passed' } }),
    prisma.test_runs.findFirst({
      where: { test_case_id: { in: testCaseIds } },
      orderBy: { created_at: 'desc' },
      select: { created_at: true },
    }),
  ])

  const failedRuns = totalRuns - passedRuns
  const passRate = totalRuns > 0 ? Math.round((passedRuns / totalRuns) * 10000) / 100 : 0

  return {
    project_id: projectId,
    project_name: project.name,
    total_test_cases: totalTestCases,
    total_runs: totalRuns,
    passed: passedRuns,
    failed: failedRuns,
    pass_rate: passRate,
    last_run_at: lastRun?.created_at.toISOString() ?? null,
  }
}

/**
 * GET /api/v1/analytics/projects/:id/flakiness
 * Returns tests that have both passed and failed — indicating flakiness.
 * A test is flaky if it has ≥1 passing run AND ≥1 failing run.
 */
export async function getProjectFlakiness(projectId: string): Promise<FlakinessReport> {
  const project = await prisma.projects.findUnique({
    where: { id: projectId },
    select: { id: true },
  })
  if (!project) throw { statusCode: 404, message: 'Project not found' }

  const results = await prisma.$queryRaw<
    {
      test_case_id: string
      test_case_name: string
      total_runs: bigint
      pass_count: bigint
      fail_count: bigint
    }[]
  >`
    SELECT
      tc.id        AS test_case_id,
      tc.name      AS test_case_name,
      COUNT(tr.id) AS total_runs,
      SUM(CASE WHEN tr.result = 'passed' THEN 1 ELSE 0 END) AS pass_count,
      SUM(CASE WHEN tr.result = 'failed' THEN 1 ELSE 0 END) AS fail_count
    FROM test_cases tc
    JOIN test_runs tr ON tc.id = tr.test_case_id
    WHERE tc.project_id = ${projectId}::uuid
    GROUP BY tc.id, tc.name
    HAVING
      SUM(CASE WHEN tr.result = 'passed' THEN 1 ELSE 0 END) > 0
      AND SUM(CASE WHEN tr.result = 'failed' THEN 1 ELSE 0 END) > 0
    ORDER BY fail_count DESC
  `

  const flakyTests = results.map((r) => {
    const total = Number(r.total_runs)
    const failed = Number(r.fail_count)
    return {
      test_case_id: r.test_case_id,
      test_case_name: r.test_case_name,
      total_runs: total,
      pass_count: Number(r.pass_count),
      fail_count: failed,
      flakiness_rate: total > 0 ? Math.round((failed / total) * 10000) / 10000 : 0,
    }
  })

  return {
    project_id: projectId,
    flaky_tests: flakyTests,
    total_flaky: flakyTests.length,
  }
}

/**
 * GET /api/v1/analytics/projects/:id/coverage
 * Coverage = percentage of test cases that have at least one passing run.
 */
export async function getProjectCoverage(projectId: string): Promise<CoverageReport> {
  const project = await prisma.projects.findUnique({
    where: { id: projectId },
    select: { id: true },
  })
  if (!project) throw { statusCode: 404, message: 'Project not found' }

  // Count all test cases for this project
  const totalTestCases = await prisma.test_cases.count({
    where: { project_id: projectId },
  })

  if (totalTestCases === 0) {
    return { project_id: projectId, total_test_cases: 0, tested: 0, passing: 0, coverage_rate: 0 }
  }

  // IDs of test cases with ≥1 run (tested) and ≥1 passing run (passing)
  const testedResult = await prisma.$queryRaw<{ test_case_id: string; has_pass: boolean }[]>`
    SELECT
      tc.id    AS test_case_id,
      BOOL_OR(tr.result = 'passed') AS has_pass
    FROM test_cases tc
    JOIN test_runs tr ON tc.id = tr.test_case_id
    WHERE tc.project_id = ${projectId}::uuid
    GROUP BY tc.id
  `

  const tested = testedResult.length
  const passing = testedResult.filter((r) => r.has_pass).length
  const coverageRate = totalTestCases > 0 ? Math.round((passing / totalTestCases) * 10000) / 10000 : 0

  return {
    project_id: projectId,
    total_test_cases: totalTestCases,
    tested,
    passing,
    coverage_rate: coverageRate,
  }
}
