/**
 * Analytics Module — Service Unit Tests
 *
 * Tests the 3 new project-scoped functions:
 *   - getProjectSummary()
 *   - getProjectFlakiness()
 *   - getProjectCoverage()
 *
 * Prisma is mocked so no DB connection is needed.
 * Run with: npm test (Vitest)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock Prisma ──────────────────────────────────────────────────
vi.mock('../../shared/db/prisma.js', () => ({
  default: {
    projects:    { findUnique: vi.fn(), count: vi.fn() },
    test_cases:  { findMany: vi.fn(), count: vi.fn() },
    test_runs:   { count: vi.fn(), findFirst: vi.fn() },
    $queryRaw:   vi.fn(),
  },
}))

import prisma from '../../shared/db/prisma.js'
import {
  getProjectSummary,
  getProjectFlakiness,
  getProjectCoverage,
} from './analytics.service.js'

const mockPrisma = prisma as unknown as {
  projects:   { findUnique: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> }
  test_cases: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> }
  test_runs:  { count: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> }
  $queryRaw:  ReturnType<typeof vi.fn>
}

const PROJECT_ID   = 'aaaaaaaa-0000-0000-0000-000000000001'
const PROJECT_NAME = 'Test Project Alpha'

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── getProjectSummary ────────────────────────────────────────────

describe('getProjectSummary()', () => {
  it('throws 404 when project does not exist', async () => {
    mockPrisma.projects.findUnique.mockResolvedValue(null)

    await expect(getProjectSummary(PROJECT_ID)).rejects.toMatchObject({
      statusCode: 404,
    })
  })

  it('returns zeroed stats when project has no test cases', async () => {
    mockPrisma.projects.findUnique.mockResolvedValue({ id: PROJECT_ID, name: PROJECT_NAME })
    mockPrisma.test_cases.findMany.mockResolvedValue([])

    const result = await getProjectSummary(PROJECT_ID)

    expect(result).toMatchObject({
      project_id:       PROJECT_ID,
      project_name:     PROJECT_NAME,
      total_test_cases: 0,
      total_runs:       0,
      passed:           0,
      failed:           0,
      pass_rate:        0,
      last_run_at:      null,
    })
  })

  it('calculates pass_rate correctly', async () => {
    mockPrisma.projects.findUnique.mockResolvedValue({ id: PROJECT_ID, name: PROJECT_NAME })
    mockPrisma.test_cases.findMany.mockResolvedValue([
      { id: 'tc-1' }, { id: 'tc-2' },
    ])
    // Promise.all order: [count total, count passed, findFirst last]
    mockPrisma.test_runs.count
      .mockResolvedValueOnce(10)  // total runs
      .mockResolvedValueOnce(8)   // passed runs
    mockPrisma.test_runs.findFirst.mockResolvedValue({
      created_at: new Date('2026-03-01T12:00:00Z'),
    })

    const result = await getProjectSummary(PROJECT_ID)

    expect(result.total_runs).toBe(10)
    expect(result.passed).toBe(8)
    expect(result.failed).toBe(2)
    expect(result.pass_rate).toBe(80)
    expect(result.last_run_at).toBe('2026-03-01T12:00:00.000Z')
  })

  it('sets pass_rate to 0 when totalRuns is 0 (avoids division by zero)', async () => {
    mockPrisma.projects.findUnique.mockResolvedValue({ id: PROJECT_ID, name: PROJECT_NAME })
    mockPrisma.test_cases.findMany.mockResolvedValue([{ id: 'tc-1' }])
    mockPrisma.test_runs.count.mockResolvedValue(0)
    mockPrisma.test_runs.findFirst.mockResolvedValue(null)

    const result = await getProjectSummary(PROJECT_ID)

    expect(result.pass_rate).toBe(0)
    expect(result.last_run_at).toBeNull()
  })
})

// ─── getProjectFlakiness ──────────────────────────────────────────

describe('getProjectFlakiness()', () => {
  it('throws 404 when project does not exist', async () => {
    mockPrisma.projects.findUnique.mockResolvedValue(null)

    await expect(getProjectFlakiness(PROJECT_ID)).rejects.toMatchObject({
      statusCode: 404,
    })
  })

  it('returns empty flaky list when no flaky tests', async () => {
    mockPrisma.projects.findUnique.mockResolvedValue({ id: PROJECT_ID })
    mockPrisma.$queryRaw.mockResolvedValue([])

    const result = await getProjectFlakiness(PROJECT_ID)

    expect(result.flaky_tests).toHaveLength(0)
    expect(result.total_flaky).toBe(0)
    expect(result.project_id).toBe(PROJECT_ID)
  })

  it('maps raw SQL rows to FlakinessItem correctly', async () => {
    mockPrisma.projects.findUnique.mockResolvedValue({ id: PROJECT_ID })
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        test_case_id:   'tc-1',
        test_case_name: 'Login flow',
        total_runs:     BigInt(10),
        pass_count:     BigInt(7),
        fail_count:     BigInt(3),
      },
    ])

    const result = await getProjectFlakiness(PROJECT_ID)

    expect(result.flaky_tests).toHaveLength(1)
    const item = result.flaky_tests[0]!
    expect(item.test_case_id).toBe('tc-1')
    expect(item.total_runs).toBe(10)
    expect(item.pass_count).toBe(7)
    expect(item.fail_count).toBe(3)
    // 3/10 = 0.3
    expect(item.flakiness_rate).toBe(0.3)
  })

  it('computes flakiness_rate as 0 when total_runs is 0', async () => {
    mockPrisma.projects.findUnique.mockResolvedValue({ id: PROJECT_ID })
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        test_case_id:   'tc-edge',
        test_case_name: 'Edge case',
        total_runs:     BigInt(0),
        pass_count:     BigInt(0),
        fail_count:     BigInt(0),
      },
    ])

    const result = await getProjectFlakiness(PROJECT_ID)
    expect(result.flaky_tests[0]!.flakiness_rate).toBe(0)
  })
})

// ─── getProjectCoverage ───────────────────────────────────────────

describe('getProjectCoverage()', () => {
  it('throws 404 when project does not exist', async () => {
    mockPrisma.projects.findUnique.mockResolvedValue(null)

    await expect(getProjectCoverage(PROJECT_ID)).rejects.toMatchObject({
      statusCode: 404,
    })
  })

  it('returns zeroed coverage when project has no test cases', async () => {
    mockPrisma.projects.findUnique.mockResolvedValue({ id: PROJECT_ID })
    mockPrisma.test_cases.count.mockResolvedValue(0)

    const result = await getProjectCoverage(PROJECT_ID)

    expect(result).toMatchObject({
      project_id:       PROJECT_ID,
      total_test_cases: 0,
      tested:           0,
      passing:          0,
      coverage_rate:    0,
    })
  })

  it('computes coverage_rate as passing / total_test_cases', async () => {
    mockPrisma.projects.findUnique.mockResolvedValue({ id: PROJECT_ID })
    mockPrisma.test_cases.count.mockResolvedValue(10)
    // 8 tested, 6 passing
    mockPrisma.$queryRaw.mockResolvedValue([
      { test_case_id: '1', has_pass: true },
      { test_case_id: '2', has_pass: true },
      { test_case_id: '3', has_pass: true },
      { test_case_id: '4', has_pass: true },
      { test_case_id: '5', has_pass: true },
      { test_case_id: '6', has_pass: true },
      { test_case_id: '7', has_pass: false },
      { test_case_id: '8', has_pass: false },
    ])

    const result = await getProjectCoverage(PROJECT_ID)

    expect(result.total_test_cases).toBe(10)
    expect(result.tested).toBe(8)
    expect(result.passing).toBe(6)
    // 6/10 = 0.6
    expect(result.coverage_rate).toBe(0.6)
  })

  it('sets coverage_rate to 0 when no tests pass', async () => {
    mockPrisma.projects.findUnique.mockResolvedValue({ id: PROJECT_ID })
    mockPrisma.test_cases.count.mockResolvedValue(5)
    mockPrisma.$queryRaw.mockResolvedValue([
      { test_case_id: 'tc-1', has_pass: false },
      { test_case_id: 'tc-2', has_pass: false },
    ])

    const result = await getProjectCoverage(PROJECT_ID)

    expect(result.passing).toBe(0)
    expect(result.coverage_rate).toBe(0)
  })
})
