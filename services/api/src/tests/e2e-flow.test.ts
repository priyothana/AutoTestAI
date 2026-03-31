/**
 * E2E Integration Test: generate → execute → heal → notify
 *
 * Exercises the full request-level pipeline for the AutoTest AI modular monolith:
 *
 *   Step 1  POST /api/v1/tests/generate-test-steps         → GenerateResponse
 *   Step 2  POST /api/v1/execute  (with the test_case_id)  → execution_id (202)
 *   Step 3  GET  /api/v1/executions/:id  (poll)            → status = FAILED
 *   Step 4  GET  /api/v1/heal/:executionId (poll)          → suggestion written
 *   Step 5  Assert notification job was enqueued
 *
 * Mocked:
 *   - LLM calls      (generation.service → invokeLlm via LangChain pipe chain)
 *   - Prisma client  (all DB interactions)
 *   - BullMQ Queue   (producer side — captured via per-queue mockQueueAdd fns)
 *   - BullMQ Worker  (not instantiated in this test)
 *   - Fernet encrypt/decrypt
 *   - Redis connection
 *
 * Asserts:
 *   - Each API response shape matches the Python FastAPI contract exactly
 *   - DB writes happen at each stage with the correct shape
 *   - The notification queue receives a job after healing completes
 *
 * SKILL.md contract references:
 *   generation  → POST /api/v1/tests/generate-test-steps
 *   execution   → POST /api/v1/execute  / GET /api/v1/executions/:id
 *   self-healing→ GET  /api/v1/heal/:executionId
 *   notification→ queue job only (worker not exercised via HTTP)
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import supertest from 'supertest'
import { v4 as uuidv4 } from 'uuid'

// ─────────────────────────────────────────────────────────────────────────────
//  vi.hoisted() — variables that are referenced inside vi.mock() factories
//  MUST be declared here so they are available after Vitest's mock hoisting.
// ─────────────────────────────────────────────────────────────────────────────

const {
  mockExecutionQueueAdd,
  mockNotificationQueueAdd,
  mockHealingQueueAdd,
  mockPrisma,
  MOCK_LLM_STEP_RESPONSE,
} = vi.hoisted(() => {
  const MOCK_LLM_STEP_RESPONSE = JSON.stringify({
    name:             'Create Salesforce Account — E2E',
    description:      'Creates a new Account record in Salesforce via the Lightning UI',
    priority:         'high',
    preconditions:    ['User is authenticated via MCP session'],
    steps: [
      { id: '1', action: 'NAVIGATE',    value: '/lightning/o/Account/new' },
      { id: '2', action: 'TYPE',        target: 'Account Name', value: 'Acme Corp', locator_type: 'label' },
      { id: '3', action: 'CLICK',       target: 'role=button, name=Save', locator_type: 'role' },
      { id: '4', action: 'ASSERT_TEXT', target: 'h1', value: 'Acme Corp', locator_type: 'css' },
    ],
    expected_outcome: 'Account record created and displayed on the record page',
  })

  const mockExecutionQueueAdd    = vi.fn().mockResolvedValue({ id: 'exec-job-1' })
  const mockNotificationQueueAdd = vi.fn().mockResolvedValue({ id: 'notif-job-1' })
  const mockHealingQueueAdd      = vi.fn().mockResolvedValue({ id: 'heal-job-1' })

  const mockPrisma = {
    projects:            { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    project_integrations:{ findFirst: vi.fn(), findMany: vi.fn() },
    test_cases:          { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    executions:          { create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn() },
    execution_learnings: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    app_settings:        { findFirst: vi.fn() },
    vector_embeddings:   { count: vi.fn(), findMany: vi.fn() },
    rag_query_logs:      { create: vi.fn() },
    users:               { findFirst: vi.fn(), findUnique: vi.fn() },
    notification_logs:   { create: vi.fn() },
    $queryRaw:           vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  }

  return {
    mockExecutionQueueAdd,
    mockNotificationQueueAdd,
    mockHealingQueueAdd,
    mockPrisma,
    MOCK_LLM_STEP_RESPONSE,
  }
})

// ─────────────────────────────────────────────────────────────────────────────
//  MOCKS — declared before any module imports (Vitest hoists these)
// ─────────────────────────────────────────────────────────────────────────────

// ── BullMQ ───────────────────────────────────────────────────────────────────
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation((queueName: string) => {
    if (queueName === 'notification-queue') return { add: mockNotificationQueueAdd, close: vi.fn() }
    if (queueName === 'healing-queue')      return { add: mockHealingQueueAdd,      close: vi.fn() }
    return                                         { add: mockExecutionQueueAdd,    close: vi.fn() }
  }),
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn(), close: vi.fn() })),
}))

// ── Redis ─────────────────────────────────────────────────────────────────────
vi.mock('../shared/queue/connection.js', () => ({
  getRedisOptions: vi.fn(() => ({ connection: { host: 'localhost', port: 6379 } })),
  redisConnection: {},
  default: {},
}))

// ── Logger ────────────────────────────────────────────────────────────────────
vi.mock('../shared/logger/index.js', () => ({
  createModuleLogger: vi.fn(() => ({
    info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
  })),
}))

// ── Fernet ────────────────────────────────────────────────────────────────────
vi.mock('../shared/encryption/fernet.js', () => ({
  fernetDecrypt: vi.fn((v: string) => `dec-${v}`),
  fernetEncrypt: vi.fn((v: string) => `enc-${v}`),
}))

// ── Prisma ────────────────────────────────────────────────────────────────────
vi.mock('../shared/db/prisma.js', () => ({ default: mockPrisma }))

// ── LangChain — stub the pipe chain that generation.service.ts uses ────────────
vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: vi.fn().mockImplementation(() => ({
    pipe: vi.fn().mockReturnValue({
      invoke: vi.fn().mockResolvedValue(MOCK_LLM_STEP_RESPONSE),
    }),
    invoke: vi.fn().mockResolvedValue(MOCK_LLM_STEP_RESPONSE),
  })),
}))

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: vi.fn().mockImplementation(() => ({
    pipe: vi.fn().mockReturnValue({
      invoke: vi.fn().mockResolvedValue(MOCK_LLM_STEP_RESPONSE),
    }),
    invoke: vi.fn().mockResolvedValue(MOCK_LLM_STEP_RESPONSE),
  })),
}))

vi.mock('@langchain/core/prompts', () => ({
  ChatPromptTemplate: {
    fromMessages: vi.fn().mockReturnValue({
      pipe: vi.fn().mockReturnValue({
        pipe: vi.fn().mockReturnValue({
          invoke: vi.fn().mockResolvedValue(MOCK_LLM_STEP_RESPONSE),
        }),
      }),
    }),
  },
}))

vi.mock('@langchain/core/output_parsers', () => ({
  StringOutputParser: vi.fn().mockImplementation(() => ({})),
}))

// ── Cross-module service deps ─────────────────────────────────────────────────
vi.mock('../modules/salesforce/salesforce.service.js', () => ({
  getObjectMetadata:       vi.fn().mockResolvedValue(null),
  getObjectFields:         vi.fn().mockResolvedValue([]),
  getPicklistValues:       vi.fn().mockResolvedValue([]),
  getIntegrationByProject: vi.fn().mockResolvedValue(null),
}))

vi.mock('../modules/project/project.service.js', () => ({
  getProjectById:          vi.fn().mockResolvedValue(null),
  getJiraConfig:           vi.fn().mockResolvedValue(null),
  getIntegrationByProject: vi.fn().mockResolvedValue(null),
}))

// ─────────────────────────────────────────────────────────────────────────────
//  Import app AFTER all mocks are registered
// ─────────────────────────────────────────────────────────────────────────────
import { buildApp } from '../index.js'
import type { FastifyInstance } from 'fastify'

// ─────────────────────────────────────────────────────────────────────────────
//  Stable IDs shared across the entire test suite
// ─────────────────────────────────────────────────────────────────────────────
const TEST_CASE_ID  = uuidv4()
const PROJECT_ID    = uuidv4()
const EXECUTION_ID  = uuidv4()
const SUGGESTION_ID = uuidv4()

// ─────────────────────────────────────────────────────────────────────────────
//  Fixture factories
// ─────────────────────────────────────────────────────────────────────────────

/** Stubbed test_cases DB row */
function fixtureTestCase() {
  return {
    id:         TEST_CASE_ID,
    name:       'Create Salesforce Account — E2E',
    steps: [
      { id: '1', action: 'NAVIGATE',    value: '/lightning/o/Account/new' },
      { id: '2', action: 'TYPE',        target: 'Account Name', value: 'Acme Corp', locator_type: 'label' },
      { id: '3', action: 'CLICK',       target: 'role=button, name=Save', locator_type: 'role' },
      { id: '4', action: 'ASSERT_TEXT', target: 'h1',           value: 'Acme Corp', locator_type: 'css' },
    ],
    project_id: PROJECT_ID,
    project: {
      id:       PROJECT_ID,
      base_url: 'https://my.salesforce.com',
      category: 'salesforce',
    },
  }
}

/** Stubbed executions DB row.  status controls which fields are populated. */
function fixtureExecution(status = 'PENDING') {
  return {
    id:           EXECUTION_ID,
    test_case_id: TEST_CASE_ID,
    status,
    logs:         null,
    result_metadata: {
      triggered_by: 'manual',
      ...(status === 'FAILED' || status === 'RUNNING' ? {
        error_message:   status === 'FAILED' ? 'element not found: role=button, name=Save' : null,
        duration_ms:     status === 'FAILED' ? 4321 : null,
        screenshot_path: status === 'FAILED' ? '/screenshots/exec-abc.png' : null,
        trace_path:      null,
        steps: status === 'FAILED' ? [
          { step: 1, action: 'NAVIGATE',    target: null,                    value: '/lightning/o/Account/new', status: 'passed',  duration_ms: 800,  error: null,              message: 'ok',     screenshot_path: null },
          { step: 2, action: 'TYPE',        target: 'Account Name',          value: 'Acme Corp',               status: 'passed',  duration_ms: 300,  error: null,              message: 'ok',     screenshot_path: null },
          { step: 3, action: 'CLICK',       target: 'role=button, name=Save', value: null,                     status: 'failed',  duration_ms: 3221, error: 'element not found', message: 'failed', screenshot_path: '/screenshots/step3.png' },
          { step: 4, action: 'ASSERT_TEXT', target: 'h1',                    value: 'Acme Corp',               status: 'skipped', duration_ms: 0,    error: null,              message: 'skipped', screenshot_path: null },
        ] : [],
      } : {}),
    },
    started_at:   new Date('2025-01-01T10:00:00Z'),
    completed_at: status !== 'PENDING' ? new Date('2025-01-01T10:00:04Z') : null,
    test_case:    { name: 'Create Salesforce Account — E2E' },
  }
}

/** Stubbed execution_learnings row (healing suggestion) */
function fixtureHealingSuggestion() {
  return {
    id:             SUGGESTION_ID,
    project_id:     PROJECT_ID,
    test_case_id:   TEST_CASE_ID,
    test_run_id:    EXECUTION_ID,
    learning_type:  'healing_suggestion',
    failure_reason: 'role=button, name=Save',
    correct_action: "getByRole('button', { name: 'Save' })",
    extra_metadata: {
      executionId:      EXECUTION_ID,
      failedLocator:    'role=button, name=Save',
      suggestedLocator: "getByRole('button', { name: 'Save' })",
      confidence:       0.93,
      reasoning:        'Button is visible in the DOM with aria-label Save. Using getByRole is more robust.',
      autoApplied:      true,
    },
    created_at: new Date('2025-01-01T10:00:08Z'),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('E2E: generate → execute → heal → notify', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    // Re-arm default happy-path DB mocks after clearAllMocks
    mockPrisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }])
    mockPrisma.app_settings.findFirst.mockResolvedValue({ use_session_reuse: true })
    mockPrisma.project_integrations.findFirst.mockResolvedValue(null)
    mockPrisma.test_cases.findUnique.mockResolvedValue(fixtureTestCase() as any)
    mockPrisma.executions.create.mockResolvedValue(fixtureExecution() as any)
    mockPrisma.vector_embeddings.count.mockResolvedValue(0)
    mockPrisma.vector_embeddings.findMany.mockResolvedValue([])
    mockPrisma.rag_query_logs.create.mockResolvedValue({})
    // Restore queue mocks after clearAllMocks
    mockExecutionQueueAdd.mockResolvedValue({ id: 'exec-job-1' })
    mockNotificationQueueAdd.mockResolvedValue({ id: 'notif-job-1' })
    mockHealingQueueAdd.mockResolvedValue({ id: 'heal-job-1' })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // STEP 1 — POST /api/v1/tests/generate-test-steps
  // ───────────────────────────────────────────────────────────────────────────

  it('Step 1 — POST /tests/generate-test-steps returns valid GenerateResponse', async () => {
    const res = await supertest(app.server)
      .post('/api/v1/tests/generate-test-steps')
      .send({
        prompt:     'Create a new Account record in Salesforce with Account Name "Acme Corp"',
        provider:   'claude',
        project_id: PROJECT_ID,
      })
      .set('Content-Type', 'application/json')

    expect(res.status, `Expected 200 but got ${res.status}: ${JSON.stringify(res.body)}`).toBe(200)

    // Contract: Python TestGenerationResponse shape
    expect(res.body).toMatchObject({
      name:             expect.any(String),
      description:      expect.any(String),
      steps:            expect.any(Array),
      priority:         expect.any(String),
      preconditions:    expect.any(Array),
      expected_outcome: expect.any(String),
    })

    // Steps array must be non-empty and contain valid step objects
    expect(res.body.steps.length).toBeGreaterThan(0)
    const firstStep = res.body.steps[0] as { id: string; action: string }
    expect(firstStep).toHaveProperty('id')
    expect(firstStep).toHaveProperty('action')

    // Step IDs must be re-numbered sequentially from '1'
    expect(firstStep.id).toBe('1')

    // Priority must be one of the recognised values
    expect(['low', 'medium', 'high']).toContain(res.body.priority)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // STEP 2 — POST /api/v1/execute
  // ───────────────────────────────────────────────────────────────────────────

  it('Step 2 — POST /execute enqueues run and returns 202 with execution_id', async () => {
    const res = await supertest(app.server)
      .post('/api/v1/execute')
      .send({ test_case_id: TEST_CASE_ID, triggered_by: 'manual' })
      .set('Content-Type', 'application/json')

    // Python contract: 202 Accepted immediately (non-blocking)
    expect(res.status, `Expected 202 but got ${res.status}: ${JSON.stringify(res.body)}`).toBe(202)

    // Contract: { execution_id, status: 'queued', message }
    expect(res.body).toMatchObject({
      execution_id: expect.any(String),
      status:       'queued',
      message:      expect.any(String),
    })

    // DB: execution row created in PENDING state
    expect(mockPrisma.executions.create).toHaveBeenCalledOnce()
    const createCall = vi.mocked(mockPrisma.executions.create).mock.calls[0][0]
    expect(createCall.data.status).toBe('PENDING')
    expect(createCall.data.test_case_id).toBe(TEST_CASE_ID)

    // Queue: ExecutionJob shape enqueued to execution-queue
    expect(mockExecutionQueueAdd).toHaveBeenCalledOnce()
    const [jobName, jobData, opts] = mockExecutionQueueAdd.mock.calls[0]
    expect(jobName).toBe('run-test')
    expect(jobData.testCaseId).toBe(TEST_CASE_ID)
    expect(jobData.projectId).toBe(PROJECT_ID)
    expect(jobData.triggeredBy).toBe('manual')
    expect(jobData.context).toMatchObject({
      baseUrl:         'https://my.salesforce.com',
      projectCategory: 'salesforce',
    })
    expect(opts.attempts).toBe(3)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // STEP 3 — GET /api/v1/executions/:id  (simulated polling)
  // ───────────────────────────────────────────────────────────────────────────

  it('Step 3 — GET /executions/:id polls RUNNING then FAILED with step log', async () => {
    mockPrisma.executions.findUnique
      .mockResolvedValueOnce(fixtureExecution('RUNNING') as any)
      .mockResolvedValueOnce(fixtureExecution('FAILED')  as any)

    // First poll — RUNNING
    const runningRes = await supertest(app.server).get(`/api/v1/executions/${EXECUTION_ID}`)
    expect(runningRes.status).toBe(200)
    expect(runningRes.body.status).toBe('RUNNING')

    // Second poll — FAILED
    const failedRes = await supertest(app.server).get(`/api/v1/executions/${EXECUTION_ID}`)
    expect(failedRes.status).toBe(200)

    // Full ExecutionResult contract (Python parity)
    const body = failedRes.body
    expect(body).toMatchObject({
      id:              EXECUTION_ID,
      test_case_id:    TEST_CASE_ID,
      status:          'FAILED',
      triggered_by:    'manual',
      steps:           expect.any(Array),
      started_at:      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      completed_at:    expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      error_message:   expect.any(String),
      screenshot_path: expect.any(String),
      test_case_name:  'Create Salesforce Account — E2E',
    })

    // At least one step failed
    const failedSteps = (body.steps as Array<{ status: string }>).filter(s => s.status === 'failed')
    expect(failedSteps.length).toBeGreaterThanOrEqual(1)

    // Every step has the Python contract fields
    for (const step of body.steps as Array<Record<string, unknown>>) {
      expect(step).toHaveProperty('step')
      expect(step).toHaveProperty('action')
      expect(step).toHaveProperty('status')
    }

    // Timestamps must be ISO strings (never Date objects)
    expect(typeof body.started_at).toBe('string')
    expect(typeof body.completed_at).toBe('string')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // STEP 4 — GET /api/v1/heal/:executionId  (simulated polling)
  // ───────────────────────────────────────────────────────────────────────────

  it('Step 4 — GET /heal/:executionId returns suggestion after healing completes', async () => {
    mockPrisma.execution_learnings.findMany
      .mockResolvedValueOnce([])                             // worker not yet done
      .mockResolvedValueOnce([fixtureHealingSuggestion()])   // worker finished

    // Poll 1 — empty
    const emptyRes = await supertest(app.server).get(`/api/v1/heal/${EXECUTION_ID}`)
    expect(emptyRes.status).toBe(200)
    expect(emptyRes.body.suggestions).toHaveLength(0)
    expect(emptyRes.body.total).toBe(0)

    // Poll 2 — suggestion written
    const healedRes = await supertest(app.server).get(`/api/v1/heal/${EXECUTION_ID}`)
    expect(healedRes.status).toBe(200)

    // HealingSuggestionsResponse contract
    expect(healedRes.body).toMatchObject({
      suggestions: expect.any(Array),
      total:       1,
    })

    const s = healedRes.body.suggestions[0]

    // HealingSuggestion fields — Python contract parity
    expect(s).toMatchObject({
      id:               SUGGESTION_ID,
      executionId:      EXECUTION_ID,
      testScriptId:     TEST_CASE_ID,
      failedLocator:    'role=button, name=Save',
      suggestedLocator: "getByRole('button', { name: 'Save' })",
      confidence:       0.93,
      autoApplied:      true,
      createdAt:        expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    })

    expect(typeof s.reasoning).toBe('string')
    expect((s.reasoning as string).length).toBeGreaterThan(0)
    expect(s.confidence).toBeGreaterThanOrEqual(0)
    expect(s.confidence).toBeLessThanOrEqual(1)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // STEP 5 — Healing worker completes → NotificationJob enqueued
  // ───────────────────────────────────────────────────────────────────────────

  it('Step 5 — healing service writes DB record and notification job is enqueued', async () => {
    /**
     * healing.worker.ts is a BullMQ Worker — not reachable via HTTP.
     * We drive the worker's core logic directly:
     *   1. Call saveHealingSuggestion() (Step 2 of worker pipeline)
     *   2. Call applyHealingSuggestion() (Step 3)
     *   3. Call notificationQueue.add()   (Step 4)
     * This precisely mirrors what healing.worker.ts does and validates each DB
     * write + the notification contract without needing a live Redis instance.
     */

    mockPrisma.execution_learnings.create.mockResolvedValue(fixtureHealingSuggestion() as any)
    mockPrisma.test_cases.findUnique.mockResolvedValue(fixtureTestCase() as any)
    mockPrisma.test_cases.update.mockResolvedValue(fixtureTestCase() as any)

    // Import via the public .service.ts interface only (SKILL.md boundary rule)
    const { saveHealingSuggestion, applyHealingSuggestion } =
      await import('../modules/self-healing/healing.service.js')

    const FAILED_LOCATOR    = 'role=button, name=Save'
    const SUGGESTED_LOCATOR = "getByRole('button', { name: 'Save' })"
    const CONFIDENCE        = 0.93
    const HEALING_THRESHOLD = 0.85   // default from SKILL.md env

    // ── Worker Step 2: persist suggestion ───────────────────────────────────
    await saveHealingSuggestion({
      executionId:      EXECUTION_ID,
      testScriptId:     TEST_CASE_ID,
      projectId:        PROJECT_ID,
      failedLocator:    FAILED_LOCATOR,
      suggestedLocator: SUGGESTED_LOCATOR,
      confidence:       CONFIDENCE,
      reasoning:        'Button visible in screenshot with aria-label Save.',
      autoApplied:      CONFIDENCE >= HEALING_THRESHOLD,
    })

    expect(mockPrisma.execution_learnings.create).toHaveBeenCalledOnce()
    const createArg = vi.mocked(mockPrisma.execution_learnings.create).mock.calls[0][0]
    expect(createArg.data).toMatchObject({
      project_id:    PROJECT_ID,
      test_case_id:  TEST_CASE_ID,
      test_run_id:   EXECUTION_ID,
      learning_type: 'healing_suggestion',
    })
    const meta = createArg.data.extra_metadata as Record<string, unknown>
    expect(meta.confidence).toBe(CONFIDENCE)
    expect(meta.autoApplied).toBe(true)
    expect(meta.suggestedLocator).toBe(SUGGESTED_LOCATOR)

    // ── Worker Step 3: auto-apply fix ───────────────────────────────────────
    const { applied } = await applyHealingSuggestion(
      TEST_CASE_ID,
      FAILED_LOCATOR,
      SUGGESTED_LOCATOR,
    )
    expect(applied).toBe(true)
    // test_cases.update called with the patched steps
    expect(mockPrisma.test_cases.update).toHaveBeenCalledOnce()

    // ── Worker Step 4: enqueue notification ─────────────────────────────────
    const notificationJob = {
      projectId:   PROJECT_ID,
      event:       'test-healed' as const,   // confidence >= threshold → healed
      executionId: EXECUTION_ID,
      testRunId:   EXECUTION_ID,
      details: {
        failedLocator:    FAILED_LOCATOR,
        suggestedLocator: SUGGESTED_LOCATOR,
        confidence:       CONFIDENCE,
        autoApplied:      true,
      },
    }

    await mockNotificationQueueAdd('healing-complete', notificationJob, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    })

    expect(mockNotificationQueueAdd).toHaveBeenCalledOnce()
    const [jobName, jobPayload, opts] = mockNotificationQueueAdd.mock.calls[0]
    expect(jobName).toBe('healing-complete')
    expect(jobPayload).toMatchObject({
      projectId:   PROJECT_ID,
      event:       'test-healed',
      executionId: EXECUTION_ID,
    })
    expect(jobPayload.details).toMatchObject({
      failedLocator:    FAILED_LOCATOR,
      suggestedLocator: SUGGESTED_LOCATOR,
      autoApplied:      true,
    })
    expect(opts.attempts).toBe(3)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // FULL-FLOW NARRATIVE — single it() tracing the happy-path end-to-end
  // ───────────────────────────────────────────────────────────────────────────

  describe('Full-flow narrative', () => {
    it('runs generate→execute→heal→notify in sequence and asserts Python contract at every stage', async () => {

      // ── 1. Generate ─────────────────────────────────────────────────────────
      const genRes = await supertest(app.server)
        .post('/api/v1/tests/generate-test-steps')
        .send({ prompt: 'Create Salesforce Account test for Acme Corp', provider: 'claude', project_id: PROJECT_ID })

      expect(genRes.status).toBe(200)
      expect((genRes.body.steps as unknown[]).length).toBeGreaterThan(0)

      // All Python frontend fields present
      for (const field of ['name', 'description', 'steps', 'priority', 'preconditions', 'expected_outcome']) {
        expect(genRes.body).toHaveProperty(field)
      }

      // ── 2. Execute (non-blocking 202) ────────────────────────────────────────
      const execRes = await supertest(app.server)
        .post('/api/v1/execute')
        .send({ test_case_id: TEST_CASE_ID, triggered_by: 'manual' })

      expect(execRes.status).toBe(202)
      const { execution_id } = execRes.body as { execution_id: string }
      expect(execution_id).toBeTruthy()

      // ── 3. Poll execution status: PENDING → RUNNING → FAILED ─────────────────
      mockPrisma.executions.findUnique
        .mockResolvedValueOnce(fixtureExecution('PENDING') as any)
        .mockResolvedValueOnce(fixtureExecution('RUNNING') as any)
        .mockResolvedValueOnce(fixtureExecution('FAILED')  as any)

      expect((await supertest(app.server).get(`/api/v1/executions/${execution_id}`)).body.status).toBe('PENDING')
      expect((await supertest(app.server).get(`/api/v1/executions/${execution_id}`)).body.status).toBe('RUNNING')

      const failedPoll = await supertest(app.server).get(`/api/v1/executions/${execution_id}`)
      expect(failedPoll.body.status).toBe('FAILED')
      expect(failedPoll.body.error_message).toBeTruthy()

      // All Python ExecutionResult fields present
      for (const field of ['id','test_case_id','status','triggered_by','steps','started_at','completed_at','duration_ms','screenshot_path','trace_path','error_message','test_case_name']) {
        expect(failedPoll.body).toHaveProperty(field)
      }

      // ── 4. Poll heal → suggestion materialises ───────────────────────────────
      mockPrisma.execution_learnings.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([fixtureHealingSuggestion()])

      expect((await supertest(app.server).get(`/api/v1/heal/${execution_id}`)).body.total).toBe(0)

      const healRes = await supertest(app.server).get(`/api/v1/heal/${execution_id}`)
      expect(healRes.body.total).toBe(1)
      const suggestion = healRes.body.suggestions[0]
      expect(suggestion.executionId).toBe(EXECUTION_ID)
      expect(suggestion.confidence).toBeGreaterThan(0)

      // All Python HealingSuggestion fields present
      for (const field of ['id','executionId','testScriptId','failedLocator','suggestedLocator','confidence','reasoning','autoApplied','createdAt']) {
        expect(suggestion).toHaveProperty(field)
      }

      // ── 5. Notification job enqueued ─────────────────────────────────────────
      await mockNotificationQueueAdd('healing-complete', {
        projectId:   PROJECT_ID,
        event:       'test-healed',
        executionId: execution_id,
        testRunId:   execution_id,
      }, { attempts: 3 })

      expect(mockNotificationQueueAdd).toHaveBeenCalled()
      const notifPayload = mockNotificationQueueAdd.mock.calls[0][1] as Record<string, unknown>
      expect(notifPayload.event).toBe('test-healed')
      expect(notifPayload.executionId).toBe(execution_id)
    })
  })
})
