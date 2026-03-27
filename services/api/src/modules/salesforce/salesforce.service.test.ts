/**
 * Salesforce Module — Vitest Unit Tests
 *
 * @modelcontextprotocol/sdk and jsforce are fully mocked via vi.mock().
 * Only service-layer logic (data mapping, DB fallbacks, error handling) is tested.
 * No live network calls are made.
 *
 * Run:  cd services/api && npx vitest run src/modules/salesforce
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock jsforce (dynamic import in service) ─────────────────────
//
// The service does `await import('jsforce')` at runtime — Vitest
// intercepts this because we mock the module id 'jsforce' below.
// The mock must expose a `default.Connection` constructor.

const mockConnInstance = {
  instanceUrl: 'https://test.my.salesforce.com',
  login:       vi.fn().mockResolvedValue({ organizationId: 'ORG001' }),
  query:       vi.fn(),
  queryAll:    vi.fn(),
  search:      vi.fn(),
  describe:    vi.fn(),
  describeGlobal: vi.fn(),
  retrieve:    vi.fn(),
  create:      vi.fn(),
  update:      vi.fn(),
  destroy:     vi.fn(),
  limits:      vi.fn(),
}

vi.mock('jsforce', () => ({
  default: {
    Connection: vi.fn().mockImplementation(() => mockConnInstance),
  },
}))

// ─── Mock @modelcontextprotocol/sdk ──────────────────────────────
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect:  vi.fn().mockResolvedValue(undefined),
    close:    vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
  })),
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({})),
}))

// ─── Mock Prisma ─────────────────────────────────────────────────
const mockPrisma = {
  metadata_raw_store: {
    findFirst: vi.fn(),
    findMany:  vi.fn().mockResolvedValue([]),
    create:    vi.fn().mockResolvedValue({}),
    update:    vi.fn().mockResolvedValue({}),
    count:     vi.fn().mockResolvedValue(0),
  },
  metadata_normalized: {
    findFirst: vi.fn().mockResolvedValue(null),
    count:     vi.fn().mockResolvedValue(0),
  },
  domain_models: {
    count: vi.fn().mockResolvedValue(0),
  },
  vector_embeddings: {
    count: vi.fn().mockResolvedValue(0),
  },
  project_integrations: {
    findFirst:  vi.fn(),
    findUnique: vi.fn(),
    create:     vi.fn().mockResolvedValue({ id: 'new-intg' }),
    update:     vi.fn().mockResolvedValue({ id: 'existing-intg' }),
  },
  salesforce_connections: {
    create:   vi.fn().mockResolvedValue({ id: 'conn-1' }),
    findMany: vi.fn().mockResolvedValue([]),
    delete:   vi.fn().mockResolvedValue({}),
  },
}

vi.mock('../../shared/db/prisma.js', () => ({ default: mockPrisma }))

// ─── Mock project.service.ts (cross-module boundary) ─────────────
vi.mock('../project/project.service.js', () => ({
  getIntegrationByProject: vi.fn(),
  getDecryptedTokens:      vi.fn(),
}))

// ─── Stub encryption & logger ────────────────────────────────────
vi.mock('../../shared/encryption/fernet.js', () => ({
  fernetEncrypt: vi.fn((v: string) => `enc(${v})`),
  fernetDecrypt: vi.fn((v: string) => v.replace(/^enc\(/, '').replace(/\)$/, '')),
}))
vi.mock('../../shared/logger/index.js', () => ({
  createModuleLogger: () => ({
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
  }),
}))

// ─── Service under test ───────────────────────────────────────────
import {
  getObjectMetadata,
  getFields,
  getPicklistValues,
  mcpConnect,
  mcpQuery,
  getMetadataStatus,
} from './salesforce.service.js'

import {
  getIntegrationByProject,
  getDecryptedTokens,
} from '../project/project.service.js'

// ─────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────

const PROJECT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const SF_INTEGRATION = {
  id:                   'intg-0001-0000-0000-000000000000',
  project_id:           PROJECT_ID,
  category:             'salesforce',
  status:               'connected',
  mcp_connected:        true,
  salesforce_login_url: 'https://login.salesforce.com',
  instance_url:         'https://test.my.salesforce.com',
  org_id:               'ORG001',
}

const DECRYPTED_TOKENS = {
  username:       'user@example.com',
  password:       'secret',
  security_token: 'TOKEN123',
}

const ACCOUNT_DESCRIBE = {
  name:  'Account',
  label: 'Account',
  fields: [
    {
      name:        'Name',
      label:       'Account Name',
      type:        'string',
      length:      255,
      nillable:    false,
      updateable:  true,
      createable:  true,
      picklistValues: [],
    },
    {
      name:        'Industry',
      label:       'Industry',
      type:        'picklist',
      length:      0,
      nillable:    true,
      updateable:  true,
      createable:  true,
      picklistValues: [
        { value: 'Banking',    label: 'Banking',    active: true,  defaultValue: false },
        { value: 'Technology', label: 'Technology', active: true,  defaultValue: false },
        { value: 'Healthcare', label: 'Healthcare', active: false, defaultValue: false },
      ],
    },
  ],
}

// ─────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()

  // Integration + tokens — valid by default
  vi.mocked(getIntegrationByProject).mockResolvedValue(SF_INTEGRATION as never)
  vi.mocked(getDecryptedTokens).mockResolvedValue(DECRYPTED_TOKENS as never)

  // jsforce describe returns Account fixture
  mockConnInstance.login.mockResolvedValue({ organizationId: 'ORG001' })
  mockConnInstance.describe.mockResolvedValue(ACCOUNT_DESCRIBE)

  // Prisma: no cached data by default
  mockPrisma.metadata_raw_store.findFirst.mockResolvedValue(null)
  mockPrisma.metadata_raw_store.findMany.mockResolvedValue([])
  mockPrisma.metadata_normalized.findFirst.mockResolvedValue(null)
})

// ═════════════════════════════════════════════════════════════════
// getObjectMetadata()
// ═════════════════════════════════════════════════════════════════

describe('getObjectMetadata()', () => {
  it('returns metadata from a live jsforce describe call', async () => {
    const result = await getObjectMetadata(PROJECT_ID, 'Account')

    expect(result.object_name).toBe('Account')
    expect(result.label).toBe('Account')
    expect(result.entity_type).toBe('object')
    expect(result.project_id).toBe(PROJECT_ID)
    expect(result.metadata).toHaveProperty('fields')
  })

  it('writes through to metadata_raw_store after a live call', async () => {
    await getObjectMetadata(PROJECT_ID, 'Account')
    // upsert path: findFirst returns null → create is called
    expect(mockPrisma.metadata_raw_store.create).toHaveBeenCalled()
  })

  it('falls back to metadata_normalized when jsforce fails', async () => {
    vi.mocked(getIntegrationByProject).mockResolvedValue(null)  // no integration → SF error
    mockPrisma.metadata_normalized.findFirst.mockResolvedValue({
      object_name:     'Account',
      label:           'Account (cached)',
      entity_type:     'object',
      structured_json: { fields: [] },
      project_id:      PROJECT_ID,
    })

    const result = await getObjectMetadata(PROJECT_ID, 'Account')

    expect(result.label).toBe('Account (cached)')
    expect(result.entity_type).toBe('object')
  })

  it('falls back to metadata_raw_store when normalized is missing', async () => {
    vi.mocked(getIntegrationByProject).mockResolvedValue(null)
    mockPrisma.metadata_normalized.findFirst.mockResolvedValue(null)
    mockPrisma.metadata_raw_store.findFirst.mockResolvedValue({
      api_name:      'Account',
      metadata_type: 'object',
      raw_json:      { label: 'Account (raw)', fields: [] },
    })

    const result = await getObjectMetadata(PROJECT_ID, 'Account')

    expect(result.label).toBe('Account (raw)')
    expect(result.entity_type).toBe('object')
  })

  it('throws 404 when no data exists anywhere', async () => {
    vi.mocked(getIntegrationByProject).mockResolvedValue(null)
    mockPrisma.metadata_normalized.findFirst.mockResolvedValue(null)
    mockPrisma.metadata_raw_store.findFirst.mockResolvedValue(null)

    await expect(getObjectMetadata(PROJECT_ID, 'Ghost')).rejects.toMatchObject({
      statusCode: 404,
    })
  })
})

// ═════════════════════════════════════════════════════════════════
// getFields()
// ═════════════════════════════════════════════════════════════════

describe('getFields()', () => {
  it('returns mapped field list from live describe', async () => {
    const result = await getFields(PROJECT_ID, 'Account')

    expect(result.object_name).toBe('Account')
    expect(result.project_id).toBe(PROJECT_ID)
    expect(result.fields).toHaveLength(2)
  })

  it('maps nillable=false to required=true', async () => {
    const result    = await getFields(PROJECT_ID, 'Account')
    const nameField = result.fields.find((f) => f.name === 'Name')

    expect(nameField?.required).toBe(true)
    expect(nameField?.label).toBe('Account Name')
    expect(nameField?.type).toBe('string')
  })

  it('includes picklistValues for picklist fields', async () => {
    const result   = await getFields(PROJECT_ID, 'Account')
    const industry = result.fields.find((f) => f.name === 'Industry')

    expect(industry?.picklistValues).toHaveLength(3)
    expect(industry?.picklistValues?.[0]).toMatchObject({
      value: 'Banking', label: 'Banking', active: true,
    })
  })

  it('falls back to field records in metadata_raw_store when jsforce fails', async () => {
    vi.mocked(getIntegrationByProject).mockResolvedValue(null)
    mockPrisma.metadata_raw_store.findMany.mockResolvedValue([
      {
        api_name:      'Account.Name',
        metadata_type: 'field',
        raw_json:      { name: 'Name', label: 'Account Name', type: 'string', nillable: false },
      },
    ])

    const result = await getFields(PROJECT_ID, 'Account')
    expect(result.fields).toHaveLength(1)
    expect(result.fields[0]?.name).toBe('Name')
  })

  it('falls back to embedded fields in parent object raw record', async () => {
    vi.mocked(getIntegrationByProject).mockResolvedValue(null)
    mockPrisma.metadata_raw_store.findMany.mockResolvedValue([])
    mockPrisma.metadata_raw_store.findFirst.mockResolvedValue({
      api_name:      'Account',
      metadata_type: 'object',
      raw_json:      ACCOUNT_DESCRIBE,
    })

    const result = await getFields(PROJECT_ID, 'Account')
    expect(result.fields.length).toBeGreaterThan(0)
  })

  it('throws 404 when no field data found', async () => {
    vi.mocked(getIntegrationByProject).mockResolvedValue(null)
    mockPrisma.metadata_raw_store.findMany.mockResolvedValue([])
    mockPrisma.metadata_raw_store.findFirst.mockResolvedValue(null)

    await expect(getFields(PROJECT_ID, 'Ghost')).rejects.toMatchObject({ statusCode: 404 })
  })
})

// ═════════════════════════════════════════════════════════════════
// getPicklistValues()
// ═════════════════════════════════════════════════════════════════

describe('getPicklistValues()', () => {
  it('returns all picklist values from live describe (active + inactive)', async () => {
    const result = await getPicklistValues(PROJECT_ID, 'Account', 'Industry')

    expect(result.object_name).toBe('Account')
    expect(result.field_name).toBe('Industry')
    expect(result.project_id).toBe(PROJECT_ID)
    expect(result.values).toHaveLength(3)
  })

  it('matches fieldName case-insensitively', async () => {
    const result = await getPicklistValues(PROJECT_ID, 'Account', 'industry')
    expect(result.values.length).toBeGreaterThan(0)
  })

  it('marks correct active/inactive flags', async () => {
    const result     = await getPicklistValues(PROJECT_ID, 'Account', 'Industry')
    const banking    = result.values.find((v) => v.value === 'Banking')
    const healthcare = result.values.find((v) => v.value === 'Healthcare')

    expect(banking?.active).toBe(true)
    expect(healthcare?.active).toBe(false)
  })

  it('falls back to metadata_raw_store field record when jsforce fails', async () => {
    vi.mocked(getIntegrationByProject).mockResolvedValue(null)
    mockPrisma.metadata_raw_store.findFirst.mockResolvedValue({
      api_name:      'Account.Industry',
      metadata_type: 'field',
      raw_json:      {
        picklistValues: [
          { value: 'Banking', label: 'Banking', active: true },
        ],
      },
    })

    const result = await getPicklistValues(PROJECT_ID, 'Account', 'Industry')
    expect(result.values).toHaveLength(1)
    expect(result.values[0]?.value).toBe('Banking')
  })

  it('falls back to parent object raw record', async () => {
    vi.mocked(getIntegrationByProject).mockResolvedValue(null)
    mockPrisma.metadata_raw_store.findFirst
      .mockResolvedValueOnce(null)          // field record missing
      .mockResolvedValueOnce({             // parent object found
        api_name:      'Account',
        metadata_type: 'object',
        raw_json:      ACCOUNT_DESCRIBE,
      })

    const result = await getPicklistValues(PROJECT_ID, 'Account', 'Industry')
    expect(result.values.length).toBeGreaterThan(0)
  })

  it('throws 404 when field does not exist on the describe result', async () => {
    mockConnInstance.describe.mockResolvedValue({
      name:   'Account',
      label:  'Account',
      fields: [{ name: 'Name', label: 'Name', type: 'string', picklistValues: [] }],
    })

    await expect(
      getPicklistValues(PROJECT_ID, 'Account', 'NonExistent'),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('throws 404 when no picklist data found anywhere', async () => {
    vi.mocked(getIntegrationByProject).mockResolvedValue(null)
    mockPrisma.metadata_raw_store.findFirst.mockResolvedValue(null)

    await expect(
      getPicklistValues(PROJECT_ID, 'Account', 'Industry'),
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})

// ═════════════════════════════════════════════════════════════════
// mcpConnect()
// ═════════════════════════════════════════════════════════════════

describe('mcpConnect()', () => {
  const connectPayload = {
    sf_username:       'user@example.com',
    sf_password:       'secret',
    sf_security_token: 'TOKEN123',
    domain:            'login' as const,
  }

  it('returns connected status with instance_url and org_id', async () => {
    mockPrisma.project_integrations.findFirst.mockResolvedValue(null)

    const result = await mcpConnect(PROJECT_ID, connectPayload)

    expect(result.status).toBe('connected')
    expect(result.connection_type).toBe('mcp')
    expect(result.instance_url).toBeDefined()
  })

  it('encrypts all credential fields before storage', async () => {
    mockPrisma.project_integrations.findFirst.mockResolvedValue(null)

    await mcpConnect(PROJECT_ID, connectPayload)

    const createdData = mockPrisma.project_integrations.create.mock.calls[0]![0]!.data!
    expect(createdData.username).toBe('enc(user@example.com)')
    expect(createdData.password).toBe('enc(secret)')
    expect(createdData.security_token).toBe('enc(TOKEN123)')
  })

  it('creates a new integration when none exists', async () => {
    mockPrisma.project_integrations.findFirst.mockResolvedValue(null)

    await mcpConnect(PROJECT_ID, connectPayload)

    expect(mockPrisma.project_integrations.create).toHaveBeenCalledOnce()
    expect(mockPrisma.project_integrations.update).not.toHaveBeenCalled()
  })

  it('updates existing integration when one is already present', async () => {
    mockPrisma.project_integrations.findFirst.mockResolvedValue({ id: 'existing-id' })

    await mcpConnect(PROJECT_ID, connectPayload)

    expect(mockPrisma.project_integrations.update).toHaveBeenCalledOnce()
    expect(mockPrisma.project_integrations.create).not.toHaveBeenCalled()
  })

  it('sets test loginUrl when domain is "test"', async () => {
    mockPrisma.project_integrations.findFirst.mockResolvedValue(null)

    await mcpConnect(PROJECT_ID, { ...connectPayload, domain: 'test' })

    const createdData = mockPrisma.project_integrations.create.mock.calls[0]![0]!.data!
    expect(createdData.salesforce_login_url).toBe('https://test.salesforce.com')
    expect(createdData.mcp_connected).toBe(true)
  })

  it('throws 400 when jsforce login rejects', async () => {
    mockConnInstance.login.mockRejectedValue(new Error('INVALID_LOGIN'))

    await expect(mcpConnect(PROJECT_ID, connectPayload)).rejects.toMatchObject({
      statusCode: 400,
      message:    expect.stringContaining('INVALID_LOGIN'),
    })
  })
})

// ═════════════════════════════════════════════════════════════════
// mcpQuery()
// ═════════════════════════════════════════════════════════════════

describe('mcpQuery()', () => {
  it('calls conn.query() for standard SOQL', async () => {
    mockConnInstance.query.mockResolvedValue({ totalSize: 1, records: [{ Id: '001' }], done: true })

    const result = await mcpQuery(PROJECT_ID, {
      query: 'SELECT Id FROM Account',
      include_deleted: false,
    })

    expect(mockConnInstance.query).toHaveBeenCalledWith('SELECT Id FROM Account')
    expect(result).toMatchObject({ totalSize: 1 })
  })

  it('throws 500 when the query fails', async () => {
    mockConnInstance.query.mockRejectedValue(new Error('MALFORMED_QUERY'))

    await expect(
      mcpQuery(PROJECT_ID, { query: 'BAD SOQL', include_deleted: false }),
    ).rejects.toMatchObject({ statusCode: 500 })
  })
})

// ═════════════════════════════════════════════════════════════════
// getMetadataStatus()
// ═════════════════════════════════════════════════════════════════

describe('getMetadataStatus()', () => {
  it('returns all-zero counts when no metadata exists', async () => {
    mockPrisma.metadata_raw_store.count.mockResolvedValue(0)
    mockPrisma.metadata_normalized.count.mockResolvedValue(0)
    mockPrisma.domain_models.count.mockResolvedValue(0)
    mockPrisma.vector_embeddings.count.mockResolvedValue(0)
    mockPrisma.metadata_raw_store.findFirst.mockResolvedValue(null)

    const result = await getMetadataStatus(PROJECT_ID)

    expect(result.has_metadata).toBe(false)
    expect(result.raw_count).toBe(0)
    expect(result.last_extracted_at).toBeNull()
  })

  it('returns has_metadata=true and correct counts when data exists', async () => {
    mockPrisma.metadata_raw_store.count.mockResolvedValue(42)
    mockPrisma.metadata_normalized.count.mockResolvedValue(10)
    mockPrisma.domain_models.count.mockResolvedValue(5)
    mockPrisma.vector_embeddings.count.mockResolvedValue(8)
    const ts = new Date('2024-01-15T12:00:00Z')
    mockPrisma.metadata_raw_store.findFirst.mockResolvedValue({ created_at: ts })

    const result = await getMetadataStatus(PROJECT_ID)

    expect(result.has_metadata).toBe(true)
    expect(result.raw_count).toBe(42)
    expect(result.normalized_count).toBe(10)
    expect(result.domain_model_count).toBe(5)
    expect(result.embedding_count).toBe(8)
    expect(result.last_extracted_at).toBe(ts.toISOString())
  })

  it('includes project_id in the response', async () => {
    mockPrisma.metadata_raw_store.findFirst.mockResolvedValue(null)
    const result = await getMetadataStatus(PROJECT_ID)
    expect(result.project_id).toBe(PROJECT_ID)
  })
})
