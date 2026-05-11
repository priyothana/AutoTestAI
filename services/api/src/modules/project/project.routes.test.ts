/**
 * Project Routes — Supertest Integration Tests
 *
 * Uses the real Fastify app (buildApp) but mocks project.service.ts
 * so tests run without a database connection.
 *
 * Run: cd services/api && npx vitest run src/modules/project/project.routes.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import supertest from 'supertest'
import type { FastifyInstance } from 'fastify'

// ─── Mock the entire service layer ───────────────────────────────
vi.mock('./project.service.js', () => ({
  createProject: vi.fn(),
  listProjects: vi.fn(),
  getProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  createIntegration: vi.fn(),
  getProjectIntegrations: vi.fn(),
  createWebIntegration: vi.fn(),
  createApiIntegration: vi.fn(),
  deleteIntegration: vi.fn(),
  getIntegrationStatus: vi.fn(),
  saveSfCredentials: vi.fn(),
  jiraConnect: vi.fn(),
  jiraBoards: vi.fn(),
  jiraBoardIssues: vi.fn(),
  saveJiraConfig: vi.fn(),
  getJiraConfig: vi.fn(),
  getJiraStories: vi.fn(),
}))

// Mock shared deps the app registers
vi.mock('../../shared/db/prisma.js', () => ({ default: {} }))
vi.mock('../../shared/logger/index.js', () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))
vi.mock('../../shared/auth/jwt.js', () => ({
  registerJwt: vi.fn(),
}))
vi.mock('@fastify/static', () => ({ default: vi.fn().mockResolvedValue(undefined) }))

import * as svc from './project.service.js'

// ─── Fixtures ────────────────────────────────────────────────────

const now = new Date().toISOString()
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
  created_at: now,
  updated_at: now,
}

const fakeIntegration = {
  id: INTEGRATION_ID,
  project_id: PROJECT_ID,
  category: 'web_app',
  status: 'connected',
  base_url: 'https://example.com',
  created_at: now,
  updated_at: now,
}

const fakeStatus = {
  id: INTEGRATION_ID,
  project_id: PROJECT_ID,
  category: 'web_app',
  status: 'connected',
  base_url: 'https://example.com',
  sync_counts: { raw_count: 0, normalized_count: 0, domain_model_count: 0, embedding_count: 0 },
  ui_session: { active: false, last_created_at: null, source: null },
  created_at: now,
  updated_at: now,
}

// ─── Build app once ──────────────────────────────────────────────

let app: FastifyInstance
let st: ReturnType<typeof supertest>

beforeAll(async () => {
  // Build a minimal Fastify app with only projectRoutes registered
  const { default: Fastify } = await import('fastify')
  const { default: cors } = await import('@fastify/cors')
  const { projectRoutes } = await import('./project.routes.js')

  app = Fastify({ logger: false })
  await app.register(cors, { origin: '*' })
  await app.register(projectRoutes, { prefix: '/api/v1' })
  await app.ready()

  st = supertest(app.server)
})

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── POST /api/v1/projects/ ──────────────────────────────────────

describe('POST /api/v1/projects/', () => {
  it('201 + project on valid body', async () => {
    vi.mocked(svc.createProject).mockResolvedValue(fakeProject as any)

    const res = await st.post('/api/v1/projects/').send({ name: 'My App', type: 'webapp' })

    expect(res.status).toBe(201)
    expect(res.body.id).toBe(PROJECT_ID)
    expect(svc.createProject).toHaveBeenCalledOnce()
  })

  it('400 when name is missing (Zod validation)', async () => {
    const res = await st.post('/api/v1/projects/').send({ type: 'webapp' })
    // Zod throws; Fastify returns 400
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(svc.createProject).not.toHaveBeenCalled()
  })

  it('forwards service error statusCode', async () => {
    vi.mocked(svc.createProject).mockRejectedValue({ statusCode: 409, message: 'Duplicate name' })

    const res = await st.post('/api/v1/projects/').send({ name: 'Dup', type: 'webapp' })
    expect(res.status).toBe(409)
  })
})

// ─── GET /api/v1/projects/ ───────────────────────────────────────

describe('GET /api/v1/projects/', () => {
  it('200 + project array', async () => {
    vi.mocked(svc.listProjects).mockResolvedValue([fakeProject] as any)

    const res = await st.get('/api/v1/projects/')

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].name).toBe('My App')
  })

  it('passes pagination params to service', async () => {
    vi.mocked(svc.listProjects).mockResolvedValue([])

    await st.get('/api/v1/projects/?skip=5&limit=20&search=invoice')

    expect(svc.listProjects).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 5, limit: 20, search: 'invoice' }),
    )
  })
})

// ─── GET /api/v1/projects/:id ────────────────────────────────────

describe('GET /api/v1/projects/:id', () => {
  it('200 + project when found', async () => {
    vi.mocked(svc.getProject).mockResolvedValue(fakeProject as any)

    const res = await st.get(`/api/v1/projects/${PROJECT_ID}`)
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(PROJECT_ID)
  })

  it('404 when not found', async () => {
    vi.mocked(svc.getProject).mockRejectedValue({ statusCode: 404, message: 'Project not found' })

    const res = await st.get('/api/v1/projects/nonexistent')
    expect(res.status).toBe(404)
    expect(res.body.detail).toBe('Project not found')
  })
})

// ─── PUT /api/v1/projects/:id ────────────────────────────────────

describe('PUT /api/v1/projects/:id', () => {
  it('200 + updated project', async () => {
    vi.mocked(svc.updateProject).mockResolvedValue({ ...fakeProject, name: 'Updated' } as any)

    const res = await st
      .put(`/api/v1/projects/${PROJECT_ID}`)
      .send({ name: 'Updated' })

    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Updated')
    expect(svc.updateProject).toHaveBeenCalledWith(PROJECT_ID, expect.objectContaining({ name: 'Updated' }))
  })

  it('404 when project does not exist', async () => {
    vi.mocked(svc.updateProject).mockRejectedValue({ statusCode: 404, message: 'Project not found' })

    const res = await st.put('/api/v1/projects/bad-id').send({ name: 'X' })
    expect(res.status).toBe(404)
  })
})

// ─── DELETE /api/v1/projects/:id ─────────────────────────────────

describe('DELETE /api/v1/projects/:id', () => {
  it('204 on success', async () => {
    vi.mocked(svc.deleteProject).mockResolvedValue(undefined as any)

    const res = await st.delete(`/api/v1/projects/${PROJECT_ID}`)
    expect(res.status).toBe(204)
  })

  it('404 when project does not exist', async () => {
    vi.mocked(svc.deleteProject).mockRejectedValue({ statusCode: 404, message: 'Project not found' })

    const res = await st.delete('/api/v1/projects/bad-id')
    expect(res.status).toBe(404)
  })
})

// ─── POST /api/v1/projects/:id/integrations ──────────────────────

describe('POST /api/v1/projects/:id/integrations', () => {
  it('201 + integration envelope on success', async () => {
    vi.mocked(svc.createIntegration).mockResolvedValue(fakeIntegration as any)

    const res = await st
      .post(`/api/v1/projects/${PROJECT_ID}/integrations`)
      .send({ category: 'web_app', base_url: 'https://app.com' })

    expect(res.status).toBe(201)
    expect(res.body.status).toBe('connected')
    expect(res.body.integration_id).toBe(INTEGRATION_ID)
  })

  it('400 when category missing (Zod)', async () => {
    const res = await st
      .post(`/api/v1/projects/${PROJECT_ID}/integrations`)
      .send({ base_url: 'https://app.com' })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it('forwards 400 from service', async () => {
    vi.mocked(svc.createIntegration).mockRejectedValue({
      statusCode: 400,
      message: 'base_url is required for web_app',
    })

    const res = await st
      .post(`/api/v1/projects/${PROJECT_ID}/integrations`)
      .send({ category: 'web_app' })
    expect(res.status).toBe(400)
    expect(res.body.detail).toContain('base_url')
  })
})

// ─── GET /api/v1/projects/:id/integrations ───────────────────────

describe('GET /api/v1/projects/:id/integrations', () => {
  it('200 + integration array', async () => {
    vi.mocked(svc.getProjectIntegrations).mockResolvedValue([fakeIntegration] as any)

    const res = await st.get(`/api/v1/projects/${PROJECT_ID}/integrations`)
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].category).toBe('web_app')
  })

  it('404 when project not found', async () => {
    vi.mocked(svc.getProjectIntegrations).mockRejectedValue({
      statusCode: 404,
      message: 'Project not found',
    })

    const res = await st.get('/api/v1/projects/bad-id/integrations')
    expect(res.status).toBe(404)
  })
})

// ─── GET /api/v1/projects/:id/integration-status ─────────────────

describe('GET /api/v1/projects/:id/integration-status', () => {
  it('200 + status object', async () => {
    vi.mocked(svc.getIntegrationStatus).mockResolvedValue(fakeStatus as any)

    const res = await st.get(`/api/v1/projects/${PROJECT_ID}/integration-status`)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('connected')
    expect(res.body.sync_counts).toBeDefined()
  })

  it('returns disconnected status when no integration', async () => {
    vi.mocked(svc.getIntegrationStatus).mockResolvedValue({
      status: 'disconnected',
      category: null,
      message: 'No integration configured for this project',
      sync_counts: null,
      ui_session: { active: false, last_created_at: null, source: null },
    } as any)

    const res = await st.get(`/api/v1/projects/${PROJECT_ID}/integration-status`)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('disconnected')
  })
})

// ─── POST /api/v1/projects/:id/connect ───────────────────────────

describe('POST /api/v1/projects/:id/connect', () => {
  it('200 + connected for web_app', async () => {
    vi.mocked(svc.createWebIntegration).mockResolvedValue(fakeIntegration as any)

    const res = await st
      .post(`/api/v1/projects/${PROJECT_ID}/connect`)
      .send({ category: 'web_app', base_url: 'https://app.com' })

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('connected')
  })

  it('400 for web_app without base_url', async () => {
    const res = await st
      .post(`/api/v1/projects/${PROJECT_ID}/connect`)
      .send({ category: 'web_app' })

    expect(res.status).toBe(400)
    expect(res.body.detail).toContain('base_url')
  })

  it('200 + pending_oauth for salesforce', async () => {
    const res = await st
      .post(`/api/v1/projects/${PROJECT_ID}/connect`)
      .send({ category: 'salesforce' })

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('pending_oauth')
  })

  it('200 + connected for api category', async () => {
    vi.mocked(svc.createApiIntegration).mockResolvedValue(fakeIntegration as any)

    const res = await st
      .post(`/api/v1/projects/${PROJECT_ID}/connect`)
      .send({ category: 'api', api_key: 'key123' })

    expect(res.status).toBe(200)
    expect(res.body.category).toBe('api')
  })

  it('400 for unsupported category', async () => {
    const res = await st
      .post(`/api/v1/projects/${PROJECT_ID}/connect`)
      .send({ category: 'ftp' })

    expect(res.status).toBe(400)
  })
})

// ─── DELETE /api/v1/projects/:id/disconnect ──────────────────────

describe('DELETE /api/v1/projects/:id/disconnect', () => {
  it('204 when deleted', async () => {
    vi.mocked(svc.deleteIntegration).mockResolvedValue(true)

    const res = await st.delete(`/api/v1/projects/${PROJECT_ID}/disconnect`)
    expect(res.status).toBe(204)
  })

  it('404 when no integration found', async () => {
    vi.mocked(svc.deleteIntegration).mockResolvedValue(false)

    const res = await st.delete('/api/v1/projects/bad-id/disconnect')
    expect(res.status).toBe(404)
  })
})

// ─── POST /api/v1/projects/:id/save-sf-credentials ───────────────

describe('POST /api/v1/projects/:id/save-sf-credentials', () => {
  it('200 + credentials_saved', async () => {
    vi.mocked(svc.saveSfCredentials).mockResolvedValue({
      ...fakeIntegration,
      salesforce_redirect_uri: 'http://localhost:4000/api/v1/integrations/salesforce/callback',
      salesforce_login_url: 'https://login.salesforce.com',
    } as any)

    const res = await st
      .post(`/api/v1/projects/${PROJECT_ID}/save-sf-credentials`)
      .send({ client_id: 'cid', client_secret: 'csec' })

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('credentials_saved')
    expect(res.body.redirect_uri).toBeDefined()
  })

  it('400 when client_id missing', async () => {
    const res = await st
      .post(`/api/v1/projects/${PROJECT_ID}/save-sf-credentials`)
      .send({ client_secret: 'csec' })

    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})

// ─── POST /api/v1/jira/connect ───────────────────────────────────

describe('POST /api/v1/jira/connect', () => {
  it('200 + {connected: true} on success', async () => {
    vi.mocked(svc.jiraConnect).mockResolvedValue({ connected: true, user: { accountId: 'abc' } })

    const res = await st.post('/api/v1/jira/connect').send({
      jira_domain: 'mysite.atlassian.net',
      jira_email: 'alice@example.com',
      jira_token: 'tok',
    })

    expect(res.status).toBe(200)
    expect(res.body.connected).toBe(true)
  })

  it('400 on invalid domain', async () => {
    vi.mocked(svc.jiraConnect).mockRejectedValue({
      statusCode: 400,
      message: 'Jira domain must be a valid Atlassian URL',
    })

    const res = await st.post('/api/v1/jira/connect').send({
      jira_domain: 'https://home.atlassian.com/invalid',
      jira_email: 'x@x.com',
      jira_token: 'tok',
    })

    expect(res.status).toBe(400)
  })
})

// ─── POST /api/v1/jira/boards ────────────────────────────────────

describe('POST /api/v1/jira/boards', () => {
  it('200 + boards array', async () => {
    vi.mocked(svc.jiraBoards).mockResolvedValue([{ id: 1, name: 'Sprint Board' }])

    const res = await st.post('/api/v1/jira/boards').send({
      jira_domain: 'mysite.atlassian.net',
      jira_email: 'alice@example.com',
      jira_token: 'tok',
    })

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
  })
})

// ─── POST /api/v1/jira/projects/:id/config ───────────────────────

describe('POST /api/v1/jira/projects/:id/config', () => {
  it('200 + {status: configured}', async () => {
    vi.mocked(svc.saveJiraConfig).mockResolvedValue(fakeIntegration as any)

    const res = await st.post(`/api/v1/jira/projects/${PROJECT_ID}/config`).send({
      jira_domain: 'mysite.atlassian.net',
      jira_email: 'alice@example.com',
      jira_token: 'tok',
      board_id: '1',
    })

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('configured')
  })
})

// ─── GET /api/v1/jira/projects/:id/config ────────────────────────

describe('GET /api/v1/jira/projects/:id/config', () => {
  it('200 + config when configured', async () => {
    vi.mocked(svc.getJiraConfig).mockResolvedValue({
      jira_domain: 'mysite.atlassian.net',
      jira_email: 'alice@example.com',
      jira_board_id: '1',
      jira_board_name: 'Sprint',
      configured: true,
    })

    const res = await st.get(`/api/v1/jira/projects/${PROJECT_ID}/config`)
    expect(res.status).toBe(200)
    expect(res.body.configured).toBe(true)
  })

  it('200 + {configured: false} when not set up', async () => {
    vi.mocked(svc.getJiraConfig).mockResolvedValue(null)

    const res = await st.get(`/api/v1/jira/projects/${PROJECT_ID}/config`)
    expect(res.status).toBe(200)
    expect(res.body.configured).toBe(false)
  })
})

// ─── GET /api/v1/jira/projects/:id/stories ───────────────────────

describe('GET /api/v1/jira/projects/:id/stories', () => {
  it('200 + stories object', async () => {
    vi.mocked(svc.getJiraStories).mockResolvedValue({
      board_id: '1',
      board_name: 'Sprint Board',
      issues: [{ id: 'PROJ-1', key: 'PROJ-1', summary: 'Summary', description: '', status: '', issue_type: '', priority: '' }],
    })

    const res = await st.get(`/api/v1/jira/projects/${PROJECT_ID}/stories`)
    expect(res.status).toBe(200)
    expect(res.body.issues).toHaveLength(1)
  })

  it('404 when Jira not configured', async () => {
    vi.mocked(svc.getJiraStories).mockRejectedValue({
      statusCode: 404,
      message: 'Jira not configured for this project',
    })

    const res = await st.get(`/api/v1/jira/projects/${PROJECT_ID}/stories`)
    expect(res.status).toBe(404)
  })
})
