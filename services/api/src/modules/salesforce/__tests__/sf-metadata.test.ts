/**
 * sf-metadata.test.ts
 *
 * Unit tests for lib/sf-metadata.ts
 * jsforce.Connection is fully mocked via vi.mock('jsforce').
 * No live network calls are made.
 *
 * Run: cd services/api && npx vitest run src/modules/salesforce/__tests__/sf-metadata.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Mock jsforce ─────────────────────────────────────────────────

const mockConnInstance = {
  instanceUrl: 'https://test.my.salesforce.com',
  login: vi.fn().mockResolvedValue({ organizationId: 'ORG001' }),
  identity: vi.fn().mockResolvedValue({ id: 'user-id' }),
  describe: vi.fn(),
  describeGlobal: vi.fn(),
  logout: vi.fn().mockResolvedValue(undefined),
}

vi.mock('jsforce', () => ({
  default: {
    Connection: vi.fn().mockImplementation(() => mockConnInstance),
  },
}))

// ─── Mock project.service.ts ──────────────────────────────────────

vi.mock('../../project/project.service.js', () => ({
  getIntegrationByProject: vi.fn().mockResolvedValue({
    id: 'intg-0001',
    project_id: 'proj-0001',
    category: 'salesforce',
    status: 'connected',
    salesforce_login_url: 'https://login.salesforce.com',
    instance_url: 'https://test.my.salesforce.com',
  }),
  getDecryptedTokens: vi.fn().mockResolvedValue({
    username: 'user@example.com',
    password: 'secret',
    security_token: 'TOKEN',
  }),
}))

// ─── Mock logger ──────────────────────────────────────────────────

vi.mock('../../../shared/logger/index.js', () => ({
  createModuleLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

// ─── Module under test ────────────────────────────────────────────
import {
  describeObject,
  getFields,
  getPicklistValues,
  listObjects,
  getRecordTypes,
  invalidateCache,
} from '../lib/sf-metadata.js'

// ─────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-0001'

const OPPORTUNITY_DESCRIBE = {
  name: 'Opportunity',
  label: 'Opportunity',
  fields: [
    {
      name: 'Id',
      label: 'Opportunity ID',
      type: 'id',
      nillable: false,
      updateable: false,
      createable: false,
      length: 18,
      picklistValues: [],
      referenceTo: [],
    },
    {
      name: 'Name',
      label: 'Opportunity Name',
      type: 'string',
      nillable: false,
      updateable: true,
      createable: true,
      length: 120,
      picklistValues: [],
      referenceTo: [],
    },
    {
      name: 'StageName',
      label: 'Stage',
      type: 'picklist',
      nillable: false,
      updateable: true,
      createable: true,
      length: 40,
      picklistValues: [
        { value: 'Prospecting', label: 'Prospecting', active: true, defaultValue: false },
        { value: 'Qualification', label: 'Qualification', active: true, defaultValue: false },
        { value: 'Closed Won', label: 'Closed Won', active: true, defaultValue: false },
        { value: 'Closed Lost', label: 'Closed Lost', active: false, defaultValue: false },
      ],
      referenceTo: [],
    },
    {
      name: 'Description',
      label: 'Description',
      type: 'textarea',
      nillable: true,
      updateable: true,
      createable: true,
      length: 32000,
      picklistValues: [],
      referenceTo: [],
    },
  ],
  recordTypeInfos: [
    {
      recordTypeId: '012000000000000AAA',
      name: 'Master',
      developerName: 'Master',
      available: true,
      master: true,
    },
    {
      recordTypeId: '012000000000001BBB',
      name: 'Enterprise',
      developerName: 'Enterprise',
      available: true,
      master: false,
    },
  ],
  childRelationships: [
    { childSObject: 'OpportunityLineItem', field: 'OpportunityId', relationshipName: 'OpportunityLineItems' },
  ],
}

const GLOBAL_DESCRIBE = {
  sobjects: [
    { name: 'Account', label: 'Account', queryable: true, createable: true, updateable: true },
    { name: 'Opportunity', label: 'Opportunity', queryable: true, createable: true, updateable: true },
    { name: 'AggregateResult', label: 'AggregateResult', queryable: true, createable: false, updateable: false },
    { name: 'ActivityHistory', label: 'Activity History', queryable: false, createable: false, updateable: false },
  ],
}

// ─────────────────────────────────────────────────────────────────
// Setup/Teardown
// ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  // Invalidate cache between tests so each test gets a fresh call
  invalidateCache(PROJECT_ID)
  mockConnInstance.describe.mockResolvedValue(OPPORTUNITY_DESCRIBE)
  mockConnInstance.describeGlobal.mockResolvedValue(GLOBAL_DESCRIBE)
})

afterEach(() => {
  // Ensure cache is cleared after each test
  invalidateCache(PROJECT_ID)
})

// ═════════════════════════════════════════════════════════════════
// getFields()
// ═════════════════════════════════════════════════════════════════

describe('getFields', () => {
  it('returns typed FieldMetadata array from describe result', async () => {
    const fields = await getFields(PROJECT_ID, 'Opportunity')

    expect(fields).toBeInstanceOf(Array)
    expect(fields.length).toBe(4)

    const stageName = fields.find((f) => f.name === 'StageName')
    expect(stageName).toBeDefined()
    expect(stageName?.type).toBe('picklist')
    expect(stageName?.label).toBe('Stage')
    expect(stageName?.required).toBe(true) // nillable: false
    expect(stageName?.updateable).toBe(true)
    expect(stageName?.createable).toBe(true)
  })

  it('maps nillable=false to required=true and nillable=true to required=false', async () => {
    const fields = await getFields(PROJECT_ID, 'Opportunity')

    const nameField = fields.find((f) => f.name === 'Name')
    expect(nameField?.required).toBe(true) // nillable: false

    const descField = fields.find((f) => f.name === 'Description')
    expect(descField?.required).toBe(false) // nillable: true
  })

  it('uses cache on second call — describe not called twice', async () => {
    // First call — hits JSforce
    await getFields(PROJECT_ID, 'Opportunity')
    expect(mockConnInstance.describe).toHaveBeenCalledTimes(1)

    // Second call — should use cache
    await getFields(PROJECT_ID, 'Opportunity')
    expect(mockConnInstance.describe).toHaveBeenCalledTimes(1) // still 1
  })

  it('re-fetches after TTL expires', async () => {
    // Set a very short TTL so the cache expires immediately
    process.env['SF_METADATA_CACHE_TTL_MS'] = '1'

    // Invalidate to clear previous cache with old TTL
    invalidateCache(PROJECT_ID)

    // First call
    await getFields(PROJECT_ID, 'Opportunity')
    expect(mockConnInstance.describe).toHaveBeenCalledTimes(1)

    // Wait 5ms for TTL to expire
    await new Promise<void>((resolve) => setTimeout(resolve, 5))

    // Second call after expiry — should re-fetch
    await getFields(PROJECT_ID, 'Opportunity')
    expect(mockConnInstance.describe).toHaveBeenCalledTimes(2)

    // Restore default TTL
    delete process.env['SF_METADATA_CACHE_TTL_MS']
  })
})

// ═════════════════════════════════════════════════════════════════
// getPicklistValues()
// ═════════════════════════════════════════════════════════════════

describe('getPicklistValues', () => {
  it('returns correct picklist values for a standard field', async () => {
    const values = await getPicklistValues(PROJECT_ID, 'Opportunity', 'StageName')

    expect(values).toBeInstanceOf(Array)
    expect(values.length).toBe(4)

    const prospecting = values.find((v) => v.value === 'Prospecting')
    expect(prospecting?.label).toBe('Prospecting')
    expect(prospecting?.active).toBe(true)
    expect(prospecting?.defaultValue).toBe(false)

    // Closed Lost is inactive
    const closedLost = values.find((v) => v.value === 'Closed Lost')
    expect(closedLost?.active).toBe(false)
  })

  it('returns empty array for non-picklist field — no error thrown', async () => {
    // Description is a textarea — picklistValues is []
    const values = await getPicklistValues(PROJECT_ID, 'Opportunity', 'Description')
    expect(values).toBeInstanceOf(Array)
    expect(values.length).toBe(0)
  })

  it('throws 404 when field does not exist on the object', async () => {
    await expect(
      getPicklistValues(PROJECT_ID, 'Opportunity', 'NonExistentField'),
    ).rejects.toMatchObject({
      statusCode: 404,
      errorCode: 'FIELD_NOT_FOUND',
    })
  })

  it('matches field name case-insensitively', async () => {
    const values = await getPicklistValues(PROJECT_ID, 'Opportunity', 'stagename')
    expect(values.length).toBe(4)
  })
})

// ═════════════════════════════════════════════════════════════════
// getDependentPicklistValues() — via sf-dependent-picklist module
// (full tests in sf-connection.test.ts; here we just confirm the
//  Stage → ForecastCategory mapping flow works end-to-end)
// ═════════════════════════════════════════════════════════════════

describe('getDependentPicklistValues (integration via dependent-picklist module)', () => {
  it('correctly maps Stage → ForecastCategory for Opportunity', async () => {
    // Set up a describe with a dependent ForecastCategoryName field
    // validFor bitmaps: 'gAAA' → controller index [1, 2], 'AABA' → [14]
    // For this test we use a simplified 2-value controller and 2-value dependent
    const oppWithDependent = {
      name: 'Opportunity',
      label: 'Opportunity',
      fields: [
        {
          name: 'StageName',
          label: 'Stage',
          type: 'picklist',
          nillable: false,
          updateable: true,
          createable: true,
          picklistValues: [
            { value: 'Prospecting',   label: 'Prospecting',   active: true, defaultValue: false, validFor: '' },
            { value: 'Qualification', label: 'Qualification', active: true, defaultValue: false, validFor: '' },
            { value: 'Closed Won',    label: 'Closed Won',    active: true, defaultValue: false, validFor: '' },
          ],
          referenceTo: [],
        },
        {
          name: 'ForecastCategoryName',
          label: 'Forecast Category',
          type: 'picklist',
          nillable: true,
          updateable: true,
          createable: true,
          // 'gAAA' → binary 10000000 00000000 00000000
          //           bit 7 = index 0 (Prospecting), but MSB-first means bit 7 of byte 0 = index 0
          // Adjusted: 'gAAA' = 0x80 0x00 0x00 → bit 7 of byte 0 = index 0
          // 'YAAAA' — we use explicit bitmaps per the decodeBitmap logic:
          // Controller idx 1 (Qualification) and 2 (Closed Won) → we synthesize 'YAAAA' → binary 01100000
          // More precisely: first byte MSB first:
          //   bit 7 = idx 0, bit 6 = idx 1, bit 5 = idx 2, bit 4 = idx 3 ...
          //   0x60 = 0110 0000 → indices 1 and 2 (Qualification, Closed Won)
          //   base64 of 0x60 0x00 0x00 = 'YAAA'
          picklistValues: [
            { value: 'Pipeline',   label: 'Pipeline',   active: true, defaultValue: false, validFor: 'gAAA' },  // 0x80 → index 0 (Prospecting)
            { value: 'BestCase',   label: 'Best Case',  active: true, defaultValue: false, validFor: 'YAAA' },  // 0x60 → indices 1,2 (Qualification, Closed Won)
            { value: 'ClosedWon',  label: 'Closed Won', active: true, defaultValue: false, validFor: 'IAAA' },  // 0x20 → index 2 (Closed Won)
          ],
          referenceTo: [],
        },
      ],
      recordTypeInfos: [],
      childRelationships: [],
    }
    mockConnInstance.describe.mockResolvedValue(oppWithDependent)
    invalidateCache(PROJECT_ID)

    const { getDependentPicklistValues } = await import('../lib/sf-dependent-picklist.js')
    const result = await getDependentPicklistValues(
      PROJECT_ID,
      'Opportunity',
      'StageName',
      'ForecastCategoryName',
    )

    expect(result.controllerField).toBe('StageName')
    expect(result.dependentField).toBe('ForecastCategoryName')
    expect(result.mapping).toBeDefined()

    // Prospecting (idx 0) → Pipeline (validFor 0x80)
    expect(result.mapping['Prospecting']).toContainEqual(
      expect.objectContaining({ value: 'Pipeline' })
    )
    // Qualification (idx 1) → BestCase (validFor 0x60)
    expect(result.mapping['Qualification']).toContainEqual(
      expect.objectContaining({ value: 'BestCase' })
    )
  })

  it('handles a field with no dependent values gracefully', async () => {
    const oppNoDeps = {
      name: 'Opportunity',
      label: 'Opportunity',
      fields: [
        {
          name: 'StageName',
          label: 'Stage',
          type: 'picklist',
          nillable: false,
          updateable: true,
          createable: true,
          picklistValues: [
            { value: 'Open', label: 'Open', active: true, defaultValue: false, validFor: '' },
          ],
          referenceTo: [],
        },
        {
          name: 'EmptyDependent',
          label: 'Empty',
          type: 'picklist',
          nillable: true,
          updateable: true,
          createable: true,
          picklistValues: [], // No dependent values at all
          referenceTo: [],
        },
      ],
      recordTypeInfos: [],
      childRelationships: [],
    }
    mockConnInstance.describe.mockResolvedValue(oppNoDeps)
    invalidateCache(PROJECT_ID)

    const { getDependentPicklistValues } = await import('../lib/sf-dependent-picklist.js')
    const result = await getDependentPicklistValues(
      PROJECT_ID,
      'Opportunity',
      'StageName',
      'EmptyDependent',
    )

    expect(result.mapping['Open']).toBeInstanceOf(Array)
    expect(result.mapping['Open'].length).toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════
// listObjects()
// ═════════════════════════════════════════════════════════════════

describe('listObjects', () => {
  it('returns GlobalObjectSummary[] from describeGlobal', async () => {
    const objects = await listObjects(PROJECT_ID)

    expect(objects).toBeInstanceOf(Array)
    expect(objects.length).toBe(4)

    const account = objects.find((o) => o.name === 'Account')
    expect(account?.label).toBe('Account')
    expect(account?.queryable).toBe(true)
    expect(account?.createable).toBe(true)
  })

  it('filters out non-queryable objects when queryableOnly=true', async () => {
    const objects = await listObjects(PROJECT_ID, true)

    // ActivityHistory is not queryable
    const activityHistory = objects.find((o) => o.name === 'ActivityHistory')
    expect(activityHistory).toBeUndefined()

    // All returned objects should be queryable
    for (const obj of objects) {
      expect(obj.queryable).toBe(true)
    }
  })

  it('uses cache on second call', async () => {
    await listObjects(PROJECT_ID)
    await listObjects(PROJECT_ID)
    expect(mockConnInstance.describeGlobal).toHaveBeenCalledTimes(1)
  })
})

// ═════════════════════════════════════════════════════════════════
// invalidateCache()
// ═════════════════════════════════════════════════════════════════

describe('invalidateCache', () => {
  it('forces re-fetch after invalidating specific object', async () => {
    await describeObject(PROJECT_ID, 'Opportunity')
    expect(mockConnInstance.describe).toHaveBeenCalledTimes(1)

    invalidateCache(PROJECT_ID, 'Opportunity')

    await describeObject(PROJECT_ID, 'Opportunity')
    expect(mockConnInstance.describe).toHaveBeenCalledTimes(2)
  })

  it('forces re-fetch after invalidating all objects for a project', async () => {
    await describeObject(PROJECT_ID, 'Opportunity')
    expect(mockConnInstance.describe).toHaveBeenCalledTimes(1)

    invalidateCache(PROJECT_ID) // no objectName → clear all

    await describeObject(PROJECT_ID, 'Opportunity')
    expect(mockConnInstance.describe).toHaveBeenCalledTimes(2)
  })

  it('does not invalidate other projects', async () => {
    const OTHER_PROJECT = 'other-proj-9999'

    // Warm up cache for PROJECT_ID
    await describeObject(PROJECT_ID, 'Opportunity')
    // Warm up cache for OTHER_PROJECT separately
    await describeObject(OTHER_PROJECT, 'Opportunity')

    const callCountBefore = mockConnInstance.describe.mock.calls.length

    // Invalidate only PROJECT_ID
    invalidateCache(PROJECT_ID)

    // PROJECT_ID: re-fetches (1 more call)
    await describeObject(PROJECT_ID, 'Opportunity')
    // OTHER_PROJECT: still cached (no extra call)
    await describeObject(OTHER_PROJECT, 'Opportunity')

    expect(mockConnInstance.describe.mock.calls.length).toBe(callCountBefore + 1)

    // Cleanup
    invalidateCache(OTHER_PROJECT)
  })
})

// ═════════════════════════════════════════════════════════════════
// getRecordTypes()
// ═════════════════════════════════════════════════════════════════

describe('getRecordTypes', () => {
  it('returns record type infos from describe result', async () => {
    const rts = await getRecordTypes(PROJECT_ID, 'Opportunity')

    expect(rts).toBeInstanceOf(Array)
    expect(rts.length).toBe(2)

    const master = rts.find((r) => r.developerName === 'Master')
    expect(master?.master).toBe(true)
    expect(master?.available).toBe(true)

    const enterprise = rts.find((r) => r.developerName === 'Enterprise')
    expect(enterprise?.master).toBe(false)
  })
})
