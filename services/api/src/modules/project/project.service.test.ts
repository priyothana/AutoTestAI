/**
 * Project Service — Vitest Unit Tests
 *
 * All Prisma calls and Fernet encryption are mocked so tests run
 * without a live database or encryption key.
 *
 * Run: cd services/api && npx vitest run src/modules/project/project.service.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock Prisma client ───────────────────────────────────────────
const mockPrisma = {
  projects: {
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  project_integrations: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  metadata_raw_store: { count: vi.fn().mockResolvedValue(0) },
  metadata_normalized: { count: vi.fn().mockResolvedValue(0) },
  domain_models: { count: vi.fn().mockResolvedValue(0) },
  vector_embeddings: { count: vi.fn().mockResolvedValue(0) },
}

vi.mock('../../shared/db/prisma.js', () => ({ default: mockPrisma }))

// ─── Mock Fernet ──────────────────────────────────────────────────
vi.mock('../../shared/encryption/fernet.js', () => ({
  fernetEncrypt: (v: string) => `enc:${v}`,
  fernetDecrypt: (v: string) => v.replace(/^enc:/, ''),
}))

// ─── Mock logger ──────────────────────────────────────────────────
vi.mock('../../shared/logger/index.js', () => ({
  createModuleLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

// ─── Import service AFTER mocks are set up ────────────────────────
import {
  createProject,
  listProjects,
  getProject,
  updateProject,
  deleteProject,
  createWebIntegration,
  createApiIntegration,
  createIntegration,
  getProjectIntegrations,
  deleteIntegration,
  getIntegrationStatus,
  saveSfCredentials,
  getDecryptedTokens,
  jiraConnect,
  saveJiraConfig,
  getJiraConfig,
} from './project.service.js'

// ─── Shared fixtures ─────────────────────────────────────────────

const PROJECT_ID = 'aaaa-bbbb-cccc-dddd'
const INTEGRATION_ID = 'iiii-jjjj-kkkk-llll'

const fakeProject = {
  id: PROJECT_ID,
  name: 'My App',
  description: null,
  type: 'webapp',
  category: 'webapp',
  base_url: 'https://example.com',
  status: 'Active',
  tags: [],
  members: [],
  owner_id: null,
  ui_session_active: false,
  ui_session_last_created_at: null,
  ui_session_source: null,
  created_at: new Date(),
  updated_at: new Date(),
}

const fakeIntegration = {
  id: INTEGRATION_ID,
  project_id: PROJECT_ID,
  category: 'web_app',
  status: 'connected',
  base_url: 'https://example.com',
  username: 'enc:user',
  password: 'enc:pass',
  login_strategy: 'form',
  instance_url: null,
  org_id: null,
  salesforce_login_url: null,
  salesforce_redirect_uri: null,
  client_id: null,
  client_secret: null,
  access_token: null,
  refresh_token: null,
  security_token: null,
  jira_token: null,
  jira_domain: null,
  jira_email: null,
  jira_board_id: null,
  jira_board_name: null,
  token_expiry: null,
  mcp_connected: false,
  auth_config: null,
  last_synced_at: null,
  sync_error: null,
  created_at: new Date(),
  updated_at: new Date(),
}

// ─── Reset mocks before each test ────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── createProject ───────────────────────────────────────────────

describe('createProject', () => {
  it('creates a project with required fields', async () => {
    mockPrisma.projects.create.mockResolvedValue(fakeProject)

    const result = await createProject({
      name: 'My App',
      type: 'webapp',
    })

    expect(mockPrisma.projects.create).toHaveBeenCalledOnce()
    const createCall = mockPrisma.projects.create.mock.calls[0][0]
    expect(createCall.data.name).toBe('My App')
    expect(createCall.data.status).toBe('Active')
    expect(createCall.data.tags).toEqual([])
    expect(result.id).toBe(PROJECT_ID)
  })

  it('auto-creates web integration when login credentials are provided', async () => {
    mockPrisma.projects.create.mockResolvedValue({ ...fakeProject, base_url: 'https://app.com' })
    mockPrisma.project_integrations.findFirst.mockResolvedValue(null)
    mockPrisma.project_integrations.create.mockResolvedValue(fakeIntegration)

    await createProject({
      name: 'My App',
      type: 'webapp',
      base_url: 'https://app.com',
      login_username: 'admin',
      login_password: 'secret',
    })

    expect(mockPrisma.project_integrations.create).toHaveBeenCalledOnce()
    const createCall = mockPrisma.project_integrations.create.mock.calls[0][0]
    expect(createCall.data.username).toBe('enc:admin')
    expect(createCall.data.password).toBe('enc:secret')
  })

  it('does NOT create integration if no credentials supplied', async () => {
    mockPrisma.projects.create.mockResolvedValue(fakeProject)

    await createProject({ name: 'Bare', type: 'webapp' })

    expect(mockPrisma.project_integrations.create).not.toHaveBeenCalled()
  })
})

// ─── listProjects ────────────────────────────────────────────────

describe('listProjects', () => {
  it('calls findMany with default pagination', async () => {
    mockPrisma.projects.findMany.mockResolvedValue([fakeProject])

    const result = await listProjects({})

    expect(mockPrisma.projects.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 10 }),
    )
    expect(result).toHaveLength(1)
  })

  it('applies search filter with OR clause', async () => {
    mockPrisma.projects.findMany.mockResolvedValue([])

    await listProjects({ search: 'invoice' })

    const call = mockPrisma.projects.findMany.mock.calls[0][0]
    expect(call.where.OR).toBeDefined()
    expect(call.where.OR[0].name.contains).toBe('invoice')
  })

  it('applies status and type filters', async () => {
    mockPrisma.projects.findMany.mockResolvedValue([])

    await listProjects({ status: 'Active', type: 'webapp' })

    const where = mockPrisma.projects.findMany.mock.calls[0][0].where
    expect(where.status).toBe('Active')
    expect(where.type).toBe('webapp')
  })
})

// ─── getProject ──────────────────────────────────────────────────

describe('getProject', () => {
  it('returns the project when found', async () => {
    mockPrisma.projects.findUnique.mockResolvedValue(fakeProject)

    const result = await getProject(PROJECT_ID)
    expect(result.id).toBe(PROJECT_ID)
  })

  it('throws 404 when not found', async () => {
    mockPrisma.projects.findUnique.mockResolvedValue(null)

    await expect(getProject('nonexistent')).rejects.toMatchObject({ statusCode: 404 })
  })
})

// ─── updateProject ───────────────────────────────────────────────

describe('updateProject', () => {
  it('performs sparse update — only provided fields', async () => {
    mockPrisma.projects.findUnique.mockResolvedValue(fakeProject)
    mockPrisma.projects.update.mockResolvedValue({ ...fakeProject, name: 'Updated' })

    const result = await updateProject(PROJECT_ID, { name: 'Updated' })

    const updateCall = mockPrisma.projects.update.mock.calls[0][0]
    expect(updateCall.data.name).toBe('Updated')
    // Fields not provided should NOT appear in the update payload
    expect(updateCall.data.type).toBeUndefined()
    expect(result.name).toBe('Updated')
  })

  it('throws 404 for missing project', async () => {
    mockPrisma.projects.findUnique.mockResolvedValue(null)

    await expect(updateProject('bad-id', { name: 'X' })).rejects.toMatchObject({ statusCode: 404 })
    expect(mockPrisma.projects.update).not.toHaveBeenCalled()
  })
})

// ─── deleteProject ───────────────────────────────────────────────

describe('deleteProject', () => {
  it('soft-deletes by setting status to Archived', async () => {
    mockPrisma.projects.findUnique.mockResolvedValue(fakeProject)
    mockPrisma.projects.update.mockResolvedValue({ ...fakeProject, status: 'Archived' })

    await deleteProject(PROJECT_ID)

    const updateCall = mockPrisma.projects.update.mock.calls[0][0]
    expect(updateCall.data.status).toBe('Archived')
  })

  it('throws 404 for missing project', async () => {
    mockPrisma.projects.findUnique.mockResolvedValue(null)

    await expect(deleteProject('bad-id')).rejects.toMatchObject({ statusCode: 404 })
    expect(mockPrisma.projects.update).not.toHaveBeenCalled()
  })
})

// ─── createWebIntegration ────────────────────────────────────────

describe('createWebIntegration', () => {
  it('encrypts credentials and creates integration', async () => {
    mockPrisma.project_integrations.findFirst.mockResolvedValue(null)
    mockPrisma.project_integrations.create.mockResolvedValue(fakeIntegration)

    await createWebIntegration(PROJECT_ID, 'https://app.com', 'user', 'pass', 'form')

    const createCall = mockPrisma.project_integrations.create.mock.calls[0][0]
    expect(createCall.data.username).toBe('enc:user')
    expect(createCall.data.password).toBe('enc:pass')
    expect(createCall.data.category).toBe('web_app')
    expect(createCall.data.status).toBe('connected')
  })

  it('upserts when integration already exists', async () => {
    mockPrisma.project_integrations.findFirst.mockResolvedValue(fakeIntegration)
    mockPrisma.project_integrations.update.mockResolvedValue(fakeIntegration)

    await createWebIntegration(PROJECT_ID, 'https://app.com', 'user2', 'pass2', 'form')

    expect(mockPrisma.project_integrations.update).toHaveBeenCalledOnce()
    expect(mockPrisma.project_integrations.create).not.toHaveBeenCalled()
  })

  it('stores null when credentials are absent', async () => {
    mockPrisma.project_integrations.findFirst.mockResolvedValue(null)
    mockPrisma.project_integrations.create.mockResolvedValue(fakeIntegration)

    await createWebIntegration(PROJECT_ID, 'https://app.com', null, null, 'form')

    const createCall = mockPrisma.project_integrations.create.mock.calls[0][0]
    expect(createCall.data.username).toBeNull()
    expect(createCall.data.password).toBeNull()
  })
})

// ─── createApiIntegration ────────────────────────────────────────

describe('createApiIntegration', () => {
  it('encrypts api_key into auth_config', async () => {
    mockPrisma.project_integrations.create.mockResolvedValue(fakeIntegration)

    await createApiIntegration(PROJECT_ID, 'https://api.com', 'mykey', null)

    const createCall = mockPrisma.project_integrations.create.mock.calls[0][0]
    expect(createCall.data.auth_config.api_key).toBe('enc:mykey')
    expect(createCall.data.category).toBe('api')
  })
})

// ─── createIntegration (generic dispatcher) ──────────────────────

describe('createIntegration', () => {
  it('routes to web_app path', async () => {
    mockPrisma.project_integrations.findFirst.mockResolvedValue(null)
    mockPrisma.project_integrations.create.mockResolvedValue(fakeIntegration)

    await createIntegration(PROJECT_ID, { category: 'web_app', base_url: 'https://app.com' })

    const createCall = mockPrisma.project_integrations.create.mock.calls[0][0]
    expect(createCall.data.category).toBe('web_app')
  })

  it('routes to api path', async () => {
    mockPrisma.project_integrations.create.mockResolvedValue(fakeIntegration)

    await createIntegration(PROJECT_ID, {
      category: 'api',
      base_url: 'https://api.example.com',
      api_key: 'key123',
    })

    const createCall = mockPrisma.project_integrations.create.mock.calls[0][0]
    expect(createCall.data.category).toBe('api')
  })

  it('throws 400 missing base_url for web_app', async () => {
    await expect(
      createIntegration(PROJECT_ID, { category: 'web_app' }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('throws 400 for salesforce (must use save-sf-credentials)', async () => {
    await expect(
      createIntegration(PROJECT_ID, { category: 'salesforce' }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('throws 400 for unknown category', async () => {
    await expect(
      createIntegration(PROJECT_ID, { category: 'ftp' }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

// ─── getProjectIntegrations ──────────────────────────────────────

describe('getProjectIntegrations', () => {
  it('returns integration list for a valid project', async () => {
    mockPrisma.projects.findUnique.mockResolvedValue(fakeProject)
    mockPrisma.project_integrations.findMany.mockResolvedValue([fakeIntegration])

    const result = await getProjectIntegrations(PROJECT_ID)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(INTEGRATION_ID)
  })

  it('throws 404 when project does not exist', async () => {
    mockPrisma.projects.findUnique.mockResolvedValue(null)

    await expect(getProjectIntegrations('bad-id')).rejects.toMatchObject({ statusCode: 404 })
    expect(mockPrisma.project_integrations.findMany).not.toHaveBeenCalled()
  })
})

// ─── deleteIntegration ───────────────────────────────────────────

describe('deleteIntegration', () => {
  it('returns true when integration deleted', async () => {
    mockPrisma.project_integrations.findFirst.mockResolvedValue(fakeIntegration)
    mockPrisma.project_integrations.delete.mockResolvedValue(fakeIntegration)

    const result = await deleteIntegration(PROJECT_ID)
    expect(result).toBe(true)
    expect(mockPrisma.project_integrations.delete).toHaveBeenCalledWith({
      where: { id: INTEGRATION_ID },
    })
  })

  it('returns false when no integration exists', async () => {
    mockPrisma.project_integrations.findFirst.mockResolvedValue(null)

    const result = await deleteIntegration(PROJECT_ID)
    expect(result).toBe(false)
    expect(mockPrisma.project_integrations.delete).not.toHaveBeenCalled()
  })
})

// ─── getIntegrationStatus ────────────────────────────────────────

describe('getIntegrationStatus', () => {
  it('returns disconnected shape when no integration', async () => {
    mockPrisma.project_integrations.findFirst.mockResolvedValue(null)
    mockPrisma.projects.findUnique.mockResolvedValue(fakeProject)

    const result = await getIntegrationStatus(PROJECT_ID)
    expect(result.status).toBe('disconnected')
    expect(result.category).toBeNull()
    expect(result.ui_session).toBeDefined()
  })

  it('returns full status when integration exists', async () => {
    mockPrisma.project_integrations.findFirst.mockResolvedValue(fakeIntegration)
    mockPrisma.projects.findUnique.mockResolvedValue(fakeProject)
    // sync count mocks already return 0

    const result = await getIntegrationStatus(PROJECT_ID) as any
    expect(result.id).toBe(INTEGRATION_ID)
    expect(result.category).toBe('web_app')
    expect(result.sync_counts).toEqual({
      raw_count: 0,
      normalized_count: 0,
      domain_model_count: 0,
      embedding_count: 0,
    })
    expect(result.has_sf_credentials).toBeNull() // not salesforce category
  })

  it('sets has_sf_credentials=true for salesforce with client_id', async () => {
    const sfIntegration = { ...fakeIntegration, category: 'salesforce', client_id: 'enc:id' }
    mockPrisma.project_integrations.findFirst.mockResolvedValue(sfIntegration)
    mockPrisma.projects.findUnique.mockResolvedValue(fakeProject)

    const result = await getIntegrationStatus(PROJECT_ID) as any
    expect(result.has_sf_credentials).toBe(true)
  })
})

// ─── saveSfCredentials ───────────────────────────────────────────

describe('saveSfCredentials', () => {
  it('encrypts client_id and client_secret', async () => {
    mockPrisma.project_integrations.findFirst.mockResolvedValue(null)
    mockPrisma.project_integrations.create.mockResolvedValue(fakeIntegration)

    await saveSfCredentials(PROJECT_ID, {
      client_id: 'cid123',
      client_secret: 'csecret456',
    })

    const createCall = mockPrisma.project_integrations.create.mock.calls[0][0]
    expect(createCall.data.client_id).toBe('enc:cid123')
    expect(createCall.data.client_secret).toBe('enc:csecret456')
    expect(createCall.data.category).toBe('salesforce')
  })

  it('updates when integration already exists', async () => {
    mockPrisma.project_integrations.findFirst.mockResolvedValue(fakeIntegration)
    mockPrisma.project_integrations.update.mockResolvedValue(fakeIntegration)

    await saveSfCredentials(PROJECT_ID, { client_id: 'cid', client_secret: 'csec' })

    expect(mockPrisma.project_integrations.update).toHaveBeenCalledOnce()
    expect(mockPrisma.project_integrations.create).not.toHaveBeenCalled()
  })
})

// ─── getDecryptedTokens ──────────────────────────────────────────

describe('getDecryptedTokens', () => {
  it('decrypts all present credential fields', async () => {
    const encRow = {
      ...fakeIntegration,
      username: 'enc:myuser',
      password: 'enc:mypass',
    }
    mockPrisma.project_integrations.findUnique.mockResolvedValue(encRow)

    const tokens = await getDecryptedTokens(INTEGRATION_ID)
    expect(tokens.username).toBe('myuser')
    expect(tokens.password).toBe('mypass')
  })

  it('throws 404 when integration not found', async () => {
    mockPrisma.project_integrations.findUnique.mockResolvedValue(null)

    await expect(getDecryptedTokens('bad-id')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('omits absent (null) fields from the result', async () => {
    mockPrisma.project_integrations.findUnique.mockResolvedValue(fakeIntegration)

    const tokens = await getDecryptedTokens(INTEGRATION_ID)
    expect('access_token' in tokens).toBe(false)
    expect('jira_token' in tokens).toBe(false)
  })
})

// ─── jiraConnect ─────────────────────────────────────────────────

describe('jiraConnect', () => {
  it('throws 400 for invalid Jira domain', async () => {
    await expect(
      jiraConnect({
        jira_domain: 'https://home.atlassian.com/invalid',
        jira_email: 'user@example.com',
        jira_token: 'token',
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('atlassian.net') })
  })

  it('returns connected + user on successful fetch', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accountId: 'abc', displayName: 'Alice' }),
    } as any)

    const result = await jiraConnect({
      jira_domain: 'mysite.atlassian.net',
      jira_email: 'alice@example.com',
      jira_token: 'tok',
    })

    expect(result.connected).toBe(true)
    expect(result.user.displayName).toBe('Alice')
  })

  it('throws 400 when Jira API returns error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      text: async () => 'Unauthorized',
    } as any)

    await expect(
      jiraConnect({
        jira_domain: 'mysite.atlassian.net',
        jira_email: 'x@x.com',
        jira_token: 'bad',
      }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

// ─── saveJiraConfig ──────────────────────────────────────────────

describe('saveJiraConfig', () => {
  it('encrypts token and saves config', async () => {
    mockPrisma.project_integrations.findFirst.mockResolvedValue(null)
    mockPrisma.project_integrations.create.mockResolvedValue({
      ...fakeIntegration,
      jira_domain: 'mysite.atlassian.net',
    })

    await saveJiraConfig(PROJECT_ID, {
      jira_domain: 'mysite.atlassian.net',
      jira_email: 'alice@example.com',
      jira_token: 'tok123',
      board_id: '42',
      board_name: 'Sprint Board',
    })

    const createCall = mockPrisma.project_integrations.create.mock.calls[0][0]
    expect(createCall.data.jira_token).toBe('enc:tok123')
    expect(createCall.data.jira_board_id).toBe('42')
  })
})

// ─── getJiraConfig ───────────────────────────────────────────────

describe('getJiraConfig', () => {
  it('returns null when jira is not configured', async () => {
    mockPrisma.project_integrations.findFirst.mockResolvedValue({
      ...fakeIntegration,
      jira_domain: null,
    })

    const result = await getJiraConfig(PROJECT_ID)
    expect(result).toBeNull()
  })

  it('returns config object when jira is configured', async () => {
    mockPrisma.project_integrations.findFirst.mockResolvedValue({
      jira_domain: 'mysite.atlassian.net',
      jira_email: 'alice@example.com',
      jira_token: 'enc:tok',
      jira_board_id: '1',
      jira_board_name: 'My Board',
    })

    const result = await getJiraConfig(PROJECT_ID)
    expect(result?.configured).toBe(true)
    expect(result?.jira_domain).toBe('mysite.atlassian.net')
  })
})
