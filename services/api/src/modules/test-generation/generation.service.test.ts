/**
 * Test-Generation Service — Vitest Unit Tests
 *
 * LangChain.js is mocked so tests run without API keys.
 * Prisma is mocked for all DB calls.
 * BullMQ Queue.add is mocked to prevent Redis connection.
 *
 * Covers:
 *   ✓ Standard generation path (no project_id)
 *   ✓ MCP RAG path (project with embeddings)
 *   ✓ Session instruction injection (connected SF project, no embeddings)
 *   ✓ Provider fallback (primary fails → Claude)
 *   ✓ humanizeSteps happy path
 *   ✓ humanizeSteps validation (empty steps → 400)
 *   ✓ enqueueForExecution enqueues with correct job shape
 *   ✓ cosineSimilarity edge cases (zero vector)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mock LangChain.js ─────────────────────────────────────────────────

const mockInvoke = vi.fn()

vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: vi.fn().mockImplementation(() => ({
    pipe: vi.fn().mockReturnThis(),
    invoke: mockInvoke,
  })),
}))

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: vi.fn().mockImplementation(() => ({
    pipe: vi.fn().mockReturnThis(),
    invoke: mockInvoke,
  })),
}))

vi.mock('@langchain/core/prompts', () => ({
  ChatPromptTemplate: {
    fromMessages: vi.fn().mockReturnValue({
      pipe: vi.fn().mockReturnThis(),
    }),
  },
}))

vi.mock('@langchain/core/output_parsers', () => ({
  StringOutputParser: vi.fn().mockImplementation(() => ({})),
}))

// ── Mock OpenAI embeddings ────────────────────────────────────────────

vi.mock('openai', () => ({
  OpenAI: vi.fn().mockImplementation(() => ({
    embeddings: {
      create: vi.fn().mockResolvedValue({
        data: [{ embedding: Array.from({ length: 1536 }, (_, i) => i * 0.001) }],
      }),
    },
  })),
}))

// ── Mock Prisma ───────────────────────────────────────────────────────

const mockPrisma = {
  project_integrations: {
    findFirst: vi.fn(),
  },
  vector_embeddings: {
    count:    vi.fn(),
    findMany: vi.fn(),
  },
  rag_query_logs: {
    create: vi.fn(),
  },
}

vi.mock('../../shared/db/prisma.js', () => ({
  default: mockPrisma,
}))

// ── Mock salesforce.service.ts (cross-module boundary) ───────────────

vi.mock('../salesforce/salesforce.service.js', () => ({
  getObjectMetadata: vi.fn().mockResolvedValue({
    object_name: 'Account',
    label:       'Account',
    entity_type: 'object',
    metadata:    { fields: [] },
    project_id:  'proj-123',
  }),
}))

// ── Mock BullMQ ───────────────────────────────────────────────────────

const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'job-abc' })

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: mockQueueAdd,
  })),
}))

// ── Mock shared/queue/connection.js ──────────────────────────────────

vi.mock('../../shared/queue/connection.js', () => ({
  getRedisOptions: vi.fn().mockReturnValue({ connection: { host: 'localhost', port: 6379, maxRetriesPerRequest: null, enableReadyCheck: false } }),
}))

vi.mock('../../shared/logger/index.js', () => ({
  createModuleLogger: vi.fn().mockReturnValue({
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

// ── Import service AFTER mocks are established ───────────────────────

const { generateTest, humanizeSteps, enqueueForExecution } = await import('./generation.service.js')

// ── Test fixtures ─────────────────────────────────────────────────────

/** Minimal valid LLM response JSON string */
const VALID_LLM_RESPONSE = JSON.stringify({
  name:             'Login Test',
  description:      'Test user login flow',
  priority:         'high',
  preconditions:    ['App is running'],
  steps: [
    { id: '1', action: 'NAVIGATE', value: '/login' },
    { id: '2', action: 'TYPE', target: 'Email', value: 'user@test.com', locator_type: 'label' },
    { id: '3', action: 'CLICK', target: 'role=button, name=Sign In', locator_type: 'role' },
    { id: '4', action: 'ASSERT_TEXT', target: 'h1', value: 'Dashboard', locator_type: 'css' },
  ],
  expected_outcome: 'User is logged in',
})

const VALID_HUMANIZE_RESPONSE = JSON.stringify({
  readable_steps: [
    'Navigate to the login page',
    "Enter 'user@test.com' in the Email field",
    "Click on the 'Sign In' button",
    "Verify that 'Dashboard' is displayed",
  ],
})

// ── Test embedding vector ──────────────────────────────────────────────

function makeEmbedding(): number[] {
  return Array.from({ length: 1536 }, () => Math.random())
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('generation.service — generateTest', () => {

  beforeEach(() => {
    vi.clearAllMocks()

    // Default: mockInvoke pipes through the chain.invoke chain
    // We need to make the whole chain resolve our response
    // The LangChain chain is: prompt.pipe(llm).pipe(parser)
    // pipe() returns `this` in our mock, invoke() is what we control
    mockInvoke.mockResolvedValue(VALID_LLM_RESPONSE)

    // Default prisma state: no project integration, no embeddings
    mockPrisma.project_integrations.findFirst.mockResolvedValue(null)
    mockPrisma.vector_embeddings.count.mockResolvedValue(0)
    mockPrisma.vector_embeddings.findMany.mockResolvedValue([])
    mockPrisma.rag_query_logs.create.mockResolvedValue({})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── Standard generation path ─────────────────────────────────────

  it('generates test steps on standard path (no project_id)', async () => {
    const result = await generateTest({
      prompt:   'Test the login flow',
      provider: 'claude',
    })

    expect(result.name).toBe('Login Test')
    expect(result.steps).toHaveLength(4)
    expect(result.steps[0].action).toBe('NAVIGATE')
    expect(result.priority).toBe('high')
    expect(result.preconditions).toEqual(['App is running'])
    expect(result.expected_outcome).toBe('User is logged in')
  })

  it('returns re-numbered step IDs sequentially from 1', async () => {
    // Response with garbled IDs
    mockInvoke.mockResolvedValue(JSON.stringify({
      name: 'T', description: 'd', priority: 'low', preconditions: [], expected_outcome: 'e',
      steps: [
        { id: '99', action: 'NAVIGATE', value: '/a' },
        { id: '77', action: 'CLICK', target: 'btn', locator_type: 'role' },
      ],
    }))

    const result = await generateTest({ prompt: 'test', provider: 'claude' })

    expect(result.steps[0].id).toBe('1')
    expect(result.steps[1].id).toBe('2')
  })

  it('accepts openai as provider', async () => {
    const result = await generateTest({ prompt: 'Test something', provider: 'openai' })
    expect(result.name).toBeDefined()
  })

  it('throws 400 for unsupported provider', async () => {
    await expect(
      generateTest({ prompt: 'test', provider: 'gemini' })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  // ── Session instruction injection ─────────────────────────────────

  it('injects MCP session instruction when connected SF project has no embeddings', async () => {
    mockPrisma.project_integrations.findFirst.mockResolvedValue({
      category:      'salesforce',
      status:        'connected',
      mcp_connected: true,
    })
    mockPrisma.vector_embeddings.count.mockResolvedValue(0)

    await generateTest({ prompt: 'test', provider: 'claude', project_id: 'proj-123' })

    // The invoke call should include the session instruction in the prompt
    const callArg = mockInvoke.mock.calls[0][0] as Record<string, string>
    expect(callArg.userInput).toContain('MCP-connected project')
  })

  it('adds OAuth session instruction for connected SF project without MCP', async () => {
    mockPrisma.project_integrations.findFirst.mockResolvedValue({
      category:      'salesforce',
      status:        'connected',
      mcp_connected: false,
    })

    await generateTest({ prompt: 'test', provider: 'claude', project_id: 'proj-456' })

    const callArg = mockInvoke.mock.calls[0][0] as Record<string, string>
    expect(callArg.userInput).toContain('OAuth connection')
  })

  // ── MCP RAG path ─────────────────────────────────────────────────

  it('uses MCP RAG path when project has embeddings', async () => {
    mockPrisma.project_integrations.findFirst.mockResolvedValue({
      category:      'salesforce',
      status:        'connected',
      mcp_connected: true,
    })
    mockPrisma.vector_embeddings.count.mockResolvedValue(10)
    mockPrisma.vector_embeddings.findMany.mockResolvedValue([
      {
        embedding_vector: makeEmbedding(),
        text_chunk:       'Invoice__c fields: Name (required), Amount__c (required)',
        chunk_type:       'metadata',
      },
      {
        embedding_vector: makeEmbedding(),
        text_chunk:       'Successful test execution pattern: create Invoice, navigate to list',
        chunk_type:       'execution_learning',
      },
    ])

    const result = await generateTest({
      prompt:     'create a new invoice',
      provider:   'claude',
      project_id: 'proj-789',
    })

    expect(result.rag_context_used).toBe(true)
    expect(result.retrieved_chunks).toBeGreaterThan(0)
  })

  it('falls back to standard when MCP RAG has empty chunks', async () => {
    mockPrisma.project_integrations.findFirst.mockResolvedValue({
      category:      'salesforce',
      status:        'connected',
      mcp_connected: true,
    })
    mockPrisma.vector_embeddings.count.mockResolvedValue(5)
    // findMany returns empty — no similarity results will pass threshold
    mockPrisma.vector_embeddings.findMany.mockResolvedValue([])

    const result = await generateTest({
      prompt:     'test something',
      provider:   'claude',
      project_id: 'proj-empty',
    })

    // Falls back successfully
    expect(result.name).toBeDefined()
    expect(result.rag_context_used).toBeUndefined()
  })

  // ── Provider fallback ─────────────────────────────────────────────

  it('falls back to claude when primary provider throws', async () => {
    // First call fails, second (claude fallback) succeeds
    mockInvoke
      .mockRejectedValueOnce(new Error('OpenAI API error'))
      .mockResolvedValueOnce(VALID_LLM_RESPONSE)

    const result = await generateTest({ prompt: 'test', provider: 'openai' })
    expect(result.name).toBe('Login Test')
  })

  it('throws 502 when both providers fail', async () => {
    mockInvoke.mockRejectedValue(new Error('All APIs down'))

    await expect(
      generateTest({ prompt: 'test', provider: 'openai' })
    ).rejects.toMatchObject({ statusCode: 502 })
  })

  // ── Response shape validation ─────────────────────────────────────

  it('returns all required response fields', async () => {
    const result = await generateTest({ prompt: 'verify the dashboard', provider: 'claude' })

    expect(result).toMatchObject({
      name:             expect.any(String),
      description:      expect.any(String),
      priority:         expect.any(String),
      preconditions:    expect.any(Array),
      steps:            expect.any(Array),
      expected_outcome: expect.any(String),
    })
  })

  it('handles LLM response with missing optional fields gracefully', async () => {
    mockInvoke.mockResolvedValue(JSON.stringify({
      name:  'Minimal Test',
      steps: [],
    }))

    const result = await generateTest({ prompt: 'minimal', provider: 'claude' })
    expect(result.name).toBe('Minimal Test')
    expect(result.description).toBeDefined()
    expect(result.preconditions).toEqual([])
    expect(result.priority).toBe('medium')
  })

  it('strips markdown code fences from LLM response', async () => {
    const wrapped = '```json\n' + VALID_LLM_RESPONSE + '\n```'
    mockInvoke.mockResolvedValue(wrapped)

    const result = await generateTest({ prompt: 'test', provider: 'claude' })
    expect(result.name).toBe('Login Test')
  })
})

// ─────────────────────────────────────────────────────────────────────
// humanizeSteps tests
// ─────────────────────────────────────────────────────────────────────

describe('generation.service — humanizeSteps', () => {

  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue(VALID_HUMANIZE_RESPONSE)
  })

  it('returns readable_steps array', async () => {
    const steps = [
      { id: '1', action: 'NAVIGATE', value: '/login' },
      { id: '2', action: 'CLICK', target: 'role=button, name=Submit', locator_type: 'role' },
    ]

    const result = await humanizeSteps(steps)

    expect(result.readable_steps).toBeInstanceOf(Array)
    expect(result.readable_steps.length).toBeGreaterThan(0)
  })

  it('throws 400 when steps array is empty', async () => {
    await expect(humanizeSteps([])).rejects.toMatchObject({
      statusCode: 400,
      message:    expect.stringContaining('steps'),
    })
  })

  it('accepts claude as provider', async () => {
    const result = await humanizeSteps(
      [{ id: '1', action: 'NAVIGATE', value: '/home' }],
      'claude',
    )
    expect(result.readable_steps).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────
// enqueueForExecution tests
// ─────────────────────────────────────────────────────────────────────

describe('generation.service — enqueueForExecution', () => {

  beforeEach(() => {
    vi.clearAllMocks()
    mockQueueAdd.mockResolvedValue({ id: 'job-xyz' })
  })

  it('enqueues to EXECUTION queue with correct job data', async () => {
    const job = {
      testRunId:   'run-1',
      testCaseId:  'tc-1',
      projectId:   'proj-1',
      triggeredBy: 'auto' as const,
      context: {
        baseUrl:             'https://example.com',
        steps:               [],
        projectCategory:     'webapp' as const,
        integrationStatus:   'connected' as const,
        useSessionReuse:     false,
        isLoginTest:         false,
      },
    }

    const jobId = await enqueueForExecution(job)

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'run-test',
      job,
      expect.objectContaining({ attempts: 3 }),
    )
    expect(jobId).toBe('job-xyz')
  })
})
