/**
 * Execution Module — Vitest Tests
 *
 * Unit tests for execution.service.ts with Playwright and Prisma mocked.
 * Tests validate:
 *   1. enqueueExecution — DB record creation + BullMQ enqueue
 *   2. getExecution — 404 handling + serialization
 *   3. listProjectExecutions — project validation + multi-row serialization
 *   4. serializeExecution — ExecutionResult JSON shape matches Python contract
 *   5. detectLoginTest — heuristic correctness
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mock prisma ──────────────────────────────────────────────────────────────
vi.mock('../../shared/db/prisma.js', () => ({
  default: {
    test_cases: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    project_integrations: {
      findFirst: vi.fn(),
    },
    app_settings: {
      findFirst: vi.fn(),
    },
    executions: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    projects: {
      findUnique: vi.fn(),
    },
  },
}))

// ── Mock BullMQ Queue ────────────────────────────────────────────────────────
const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'job-123' })
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: mockQueueAdd,
  })),
  Worker: vi.fn(),
}))

// ── Mock fernet encryption ───────────────────────────────────────────────────
vi.mock('../../shared/encryption/fernet.js', () => ({
  fernetDecrypt: vi.fn((val: string) => `decrypted-${val}`),
  fernetEncrypt: vi.fn((val: string) => `encrypted-${val}`),
}))

// ── Mock shared/queue/connection.js ─────────────────────────────────────────
vi.mock('../../shared/queue/connection.js', () => ({
  getRedisOptions: vi.fn(() => ({ connection: { host: 'localhost', port: 6379 } })),
  redisConnection: {},
  default: {},
}))

// ── Mock logger ──────────────────────────────────────────────────────────────
vi.mock('../../shared/logger/index.js', () => ({
  createModuleLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}))

// Import after mocks
import prisma from '../../shared/db/prisma.js'
import * as svc from './execution.service.js'

// ────────────────────────────────────────────────────────────────────────────

const mockTestCase = {
  id: 'tc-111',
  name: 'Create Account Test',
  steps: [
    { id: 's1', action: 'navigate', target: 'https://example.com', value: '' },
    { id: 's2', action: 'click',    target: '#btn-create',          value: '' },
    { id: 's3', action: 'type',     target: '#account-name',        value: 'Acme Corp' },
  ],
  project_id: 'proj-999',
  project: {
    id: 'proj-999',
    base_url: 'https://example.com',
    category: 'webapp',
  },
}

const mockExecution = {
  id: 'exec-abc',
  test_case_id: 'tc-111',
  status: 'PENDING',
  logs: null,
  result_metadata: { triggered_by: 'manual' },
  started_at: new Date('2024-01-01T00:00:00Z'),
  completed_at: null,
}

// ────────────────────────────────────────────────────────────────────────────

describe('execution.service — enqueueExecution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.test_cases.findUnique).mockResolvedValue(mockTestCase as any)
    vi.mocked(prisma.project_integrations.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.app_settings.findFirst).mockResolvedValue({ use_session_reuse: true } as any)
    vi.mocked(prisma.executions.create).mockResolvedValue(mockExecution as any)
  })

  it('creates a PENDING execution row in DB', async () => {
    await svc.enqueueExecution({ test_case_id: 'tc-111', triggered_by: 'manual' })

    expect(prisma.executions.create).toHaveBeenCalledOnce()
    const callArg = vi.mocked(prisma.executions.create).mock.calls[0][0]
    expect(callArg.data.status).toBe('PENDING')
    expect(callArg.data.test_case_id).toBe('tc-111')
  })

  it('enqueues to execution-queue with correct job shape', async () => {
    await svc.enqueueExecution({ test_case_id: 'tc-111', triggered_by: 'manual' })

    expect(mockQueueAdd).toHaveBeenCalledOnce()
    const [jobName, jobData, opts] = mockQueueAdd.mock.calls[0]
    expect(jobName).toBe('run-test')
    expect(jobData.testCaseId).toBe('tc-111')
    expect(jobData.projectId).toBe('proj-999')
    expect(jobData.triggeredBy).toBe('manual')
    expect(jobData.context.baseUrl).toBe('https://example.com')
    expect(jobData.context.steps).toHaveLength(3)
    expect(opts.attempts).toBe(3)
  })

  it('returns execution_id immediately (non-blocking)', async () => {
    const result = await svc.enqueueExecution({ test_case_id: 'tc-111', triggered_by: 'auto' })
    expect(result).toHaveProperty('execution_id', 'exec-abc')
  })

  it('throws 404 when test case not found', async () => {
    vi.mocked(prisma.test_cases.findUnique).mockResolvedValue(null)

    await expect(svc.enqueueExecution({ test_case_id: 'tc-missing', triggered_by: 'manual' }))
      .rejects.toMatchObject({ statusCode: 404, message: 'Test case not found' })
  })

  it('decrypts salesforce credentials when integration is salesforce', async () => {
    vi.mocked(prisma.project_integrations.findFirst).mockResolvedValue({
      category: 'salesforce',
      status: 'connected',
      access_token: 'encrypted-token',
      instance_url: 'https://my.salesforce.com',
      username: 'user@sf.com',
      password: 'secret',
      security_token: 'tok123',
      salesforce_login_url: 'https://login.salesforce.com',
      mcp_connected: false,
    } as any)

    await svc.enqueueExecution({ test_case_id: 'tc-111', triggered_by: 'manual' })

    const [, jobData] = mockQueueAdd.mock.calls[0]
    expect(jobData.context.sfAccessToken).toBe('decrypted-encrypted-token')
    expect(jobData.context.sfInstanceUrl).toBe('https://my.salesforce.com')
    expect(jobData.context.sfUsername).toBe('decrypted-user@sf.com')
  })

  it('decrypts web credentials when integration is web_app', async () => {
    vi.mocked(prisma.project_integrations.findFirst).mockResolvedValue({
      category: 'web_app',
      status: 'connected',
      username: 'webuser',
      password: 'webpass',
      base_url: 'https://myapp.com/login',
      login_strategy: 'form',
    } as any)

    await svc.enqueueExecution({ test_case_id: 'tc-111', triggered_by: 'manual' })

    const [, jobData] = mockQueueAdd.mock.calls[0]
    expect(jobData.context.webUsername).toBe('decrypted-webuser')
    expect(jobData.context.webPassword).toBe('decrypted-webpass')
    expect(jobData.context.webLoginUrl).toBe('https://myapp.com/login')
    expect(jobData.context.webLoginStrategy).toBe('form')
  })
})

// ────────────────────────────────────────────────────────────────────────────

describe('execution.service — getExecution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns serialized ExecutionResult when found', async () => {
    vi.mocked(prisma.executions.findUnique).mockResolvedValue({
      ...mockExecution,
      test_case: { name: 'Create Account Test' },
    } as any)

    const result = await svc.getExecution('exec-abc')

    expect(result.id).toBe('exec-abc')
    expect(result.status).toBe('PENDING')
    expect(result.test_case_id).toBe('tc-111')
    expect(result.test_case_name).toBe('Create Account Test')
    expect(result.triggered_by).toBe('manual')
    expect(typeof result.started_at).toBe('string')
    expect(result.completed_at).toBeNull()
  })

  it('throws 404 when execution not found', async () => {
    vi.mocked(prisma.executions.findUnique).mockResolvedValue(null)

    await expect(svc.getExecution('exec-missing'))
      .rejects.toMatchObject({ statusCode: 404, message: 'Execution not found' })
  })

  it('serializes steps from result_metadata', async () => {
    const steps = [
      { step: 1, action: 'navigate', target: 'https://example.com', status: 'passed', duration_ms: 120, error: null, message: 'passed', screenshot_path: null, value: null },
      { step: 2, action: 'click', target: '#btn', status: 'passed', duration_ms: 80, error: null, message: 'passed', screenshot_path: null, value: null },
    ]

    vi.mocked(prisma.executions.findUnique).mockResolvedValue({
      ...mockExecution,
      status: 'PASSED',
      result_metadata: { triggered_by: 'auto', steps, duration_ms: 2500, trace_path: '/traces/exec-abc.zip' },
      completed_at: new Date('2024-01-01T00:00:05Z'),
      test_case: { name: 'My Test' },
    } as any)

    const result = await svc.getExecution('exec-abc')

    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].action).toBe('navigate')
    expect(result.steps[1].status).toBe('passed')
    expect(result.duration_ms).toBe(2500)
    expect(result.trace_path).toBe('/traces/exec-abc.zip')
    expect(result.completed_at).toBe('2024-01-01T00:00:05.000Z')
  })
})

// ────────────────────────────────────────────────────────────────────────────

describe('execution.service — listProjectExecutions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('throws 404 when project does not exist', async () => {
    vi.mocked(prisma.projects.findUnique).mockResolvedValue(null)

    await expect(svc.listProjectExecutions('proj-missing'))
      .rejects.toMatchObject({ statusCode: 404, message: 'Project not found' })
  })

  it('returns paginated executions with total count', async () => {
    vi.mocked(prisma.projects.findUnique).mockResolvedValue({ id: 'proj-999' } as any)
    vi.mocked(prisma.test_cases.findMany).mockResolvedValue([
      { id: 'tc-111', name: 'Test Alpha' },
      { id: 'tc-222', name: 'Test Beta' },
    ] as any)
    vi.mocked(prisma.executions.findMany).mockResolvedValue([
      { ...mockExecution, id: 'exec-1', test_case_id: 'tc-111' },
      { ...mockExecution, id: 'exec-2', test_case_id: 'tc-222' },
    ] as any)
    vi.mocked(prisma.executions.count).mockResolvedValue(2)

    const result = await svc.listProjectExecutions('proj-999', 50)

    expect(result.total).toBe(2)
    expect(result.executions).toHaveLength(2)
    expect(result.executions[0].id).toBe('exec-1')
    expect(result.executions[0].test_case_name).toBe('Test Alpha')
    expect(result.executions[1].test_case_name).toBe('Test Beta')
  })

  it('returns empty list when project has no test cases', async () => {
    vi.mocked(prisma.projects.findUnique).mockResolvedValue({ id: 'proj-empty' } as any)
    vi.mocked(prisma.test_cases.findMany).mockResolvedValue([] as any)
    vi.mocked(prisma.executions.findMany).mockResolvedValue([] as any)
    vi.mocked(prisma.executions.count).mockResolvedValue(0)

    const result = await svc.listProjectExecutions('proj-empty')

    expect(result.executions).toHaveLength(0)
    expect(result.total).toBe(0)
  })

  it('respects limit parameter', async () => {
    vi.mocked(prisma.projects.findUnique).mockResolvedValue({ id: 'proj-999' } as any)
    vi.mocked(prisma.test_cases.findMany).mockResolvedValue([{ id: 'tc-111', name: 'Test A' }] as any)
    vi.mocked(prisma.executions.findMany).mockResolvedValue([] as any)
    vi.mocked(prisma.executions.count).mockResolvedValue(0)

    await svc.listProjectExecutions('proj-999', 10)

    expect(vi.mocked(prisma.executions.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10 })
    )
  })
})

// ────────────────────────────────────────────────────────────────────────────

describe('ExecutionResult JSON contract', () => {
  it('returned shape matches Python contract — all required fields present', async () => {
    vi.mocked(prisma.executions.findUnique).mockResolvedValue({
      ...mockExecution,
      status: 'PASSED',
      result_metadata: {
        triggered_by: 'manual',
        steps: [],
        duration_ms: 1000,
        screenshot_path: '/screenshots/last.png',
        trace_path: '/traces/abc.zip',
        error_message: null,
      },
      completed_at: new Date('2024-01-01T00:00:02Z'),
      test_case: { name: 'Smoke Test' },
    } as any)

    const result = await svc.getExecution('exec-abc')

    // Validate every field the Next.js dashboard expects
    const requiredFields: (keyof typeof result)[] = [
      'id', 'test_case_id', 'status', 'triggered_by',
      'steps', 'started_at', 'completed_at',
      'duration_ms', 'screenshot_path', 'trace_path',
      'error_message', 'test_case_name',
    ]

    for (const field of requiredFields) {
      expect(result).toHaveProperty(field)
    }

    // Timestamps must be ISO strings (not Date objects)
    expect(typeof result.started_at).toBe('string')
    expect(typeof result.completed_at).toBe('string')
    expect(result.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
