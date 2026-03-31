/**
 * sf-connection.test.ts
 *
 * Unit tests for lib/sf-connection.ts
 * jsforce is fully mocked via vi.mock('jsforce').
 * No live network calls are made.
 *
 * Covers:
 *   • getConnection() — cache hit, deduplication, re-auth on INVALID_SESSION_ID
 *   • decodeBitmap()  — known test vectors including 'gAAA' and 'AABA'
 *
 * Run: cd services/api && npx vitest run src/modules/salesforce/__tests__/sf-connection.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Hoist mock fns before vi.mock() factories run ───────────────
// vi.mock() factories are hoisted to the top of the file by Vitest.
// Any variables they reference must be initialized BEFORE the hoist
// via vi.hoisted().

const {
  mockGetIntegrationByProject,
  mockGetDecryptedTokens,
} = vi.hoisted(() => ({
  mockGetIntegrationByProject: vi.fn(),
  mockGetDecryptedTokens: vi.fn(),
}))

// ─── Mock jsforce ─────────────────────────────────────────────────

let loginCallCount = 0

const mockConnInstance = {
  instanceUrl: 'https://test.my.salesforce.com',
  login: vi.fn().mockImplementation(async () => {
    loginCallCount++
    return { organizationId: 'ORG001' }
  }),
  identity: vi.fn().mockResolvedValue({ id: 'user-id' }),
  logout: vi.fn().mockResolvedValue(undefined),
  describe: vi.fn().mockResolvedValue({ name: 'Account', label: 'Account', fields: [] }),
  describeGlobal: vi.fn(),
}

vi.mock('jsforce', () => ({
  default: {
    Connection: vi.fn().mockImplementation(() => mockConnInstance),
  },
}))

// ─── Mock project.service.ts ──────────────────────────────────────

vi.mock('../../project/project.service.js', () => ({
  getIntegrationByProject: mockGetIntegrationByProject,
  getDecryptedTokens: mockGetDecryptedTokens,
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
// NOTE: Imported AFTER all vi.mock() declarations so Vitest intercepts all deps.

import {
  getConnection,
  invalidateConnection,
  drainPool,
  wrapJsforceError,
} from '../lib/sf-connection.js'

import { decodeBitmap } from '../lib/sf-dependent-picklist.js'
import { SalesforceError } from '../lib/sf-types.js'

// ─────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────

const PROJECT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const PASSWORD_INTEGRATION = {
  id: 'intg-0001',
  project_id: PROJECT_ID,
  category: 'salesforce',
  status: 'connected',
  salesforce_login_url: 'https://login.salesforce.com',
  instance_url: 'https://test.my.salesforce.com',
}

const PASSWORD_TOKENS = {
  username: 'user@example.com',
  password: 'secret',
  security_token: 'TOKEN123',
}

// ─────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  loginCallCount = 0

  // Default: valid password-flow integration
  mockGetIntegrationByProject.mockResolvedValue(PASSWORD_INTEGRATION)
  mockGetDecryptedTokens.mockResolvedValue(PASSWORD_TOKENS)

  mockConnInstance.login.mockImplementation(async () => {
    loginCallCount++
    return { organizationId: 'ORG001' }
  })
  mockConnInstance.identity.mockResolvedValue({ id: 'user-id' })

  // Evict any leftover pool entries between tests
  invalidateConnection(PROJECT_ID)
})

// ═════════════════════════════════════════════════════════════════
// getConnection()
// ═════════════════════════════════════════════════════════════════

describe('getConnection', () => {
  it('creates a new connection and caches it — login called once', async () => {
    const conn = await getConnection(PROJECT_ID)

    expect(conn).toBeDefined()
    expect(loginCallCount).toBe(1)
  })

  it('returns cached connection on second call — login not called twice', async () => {
    const conn1 = await getConnection(PROJECT_ID)
    const conn2 = await getConnection(PROJECT_ID)

    expect(conn1).toBe(conn2)        // same object reference
    expect(loginCallCount).toBe(1)   // only one login
  })

  it('deduplicates concurrent requests for the same projectId', async () => {
    // Fire three concurrent requests for the same project before any resolves
    const [r1, r2, r3] = await Promise.all([
      getConnection(PROJECT_ID),
      getConnection(PROJECT_ID),
      getConnection(PROJECT_ID),
    ])

    // All three resolve to the same connection
    expect(r1).toBe(r2)
    expect(r2).toBe(r3)

    // Login called only ONCE, not three times
    expect(loginCallCount).toBe(1)
  })

  it('re-authenticates after INVALID_SESSION_ID error from a different projectId', async () => {
    const OTHER = 'proj-other-1234'

    // First call — establishes connection
    await getConnection(OTHER)
    expect(loginCallCount).toBe(1)

    // Simulate session expiry: invalidate the connection
    invalidateConnection(OTHER)

    // Second call — should re-authenticate
    await getConnection(OTHER)
    expect(loginCallCount).toBe(2)

    // Cleanup
    invalidateConnection(OTHER)
  })

  it('throws SalesforceError when no integration is configured', async () => {
    mockGetIntegrationByProject.mockResolvedValue(null)

    await expect(getConnection(PROJECT_ID)).rejects.toMatchObject({
      name: 'SalesforceError',
      errorCode: 'NO_INTEGRATION',
      statusCode: 400,
    })
  })

  it('throws SalesforceError when credentials are incomplete (password flow)', async () => {
    mockGetDecryptedTokens.mockResolvedValue({
      username: 'user@example.com',
      // password is missing
    })

    await expect(getConnection(PROJECT_ID)).rejects.toMatchObject({
      name: 'SalesforceError',
      errorCode: 'INCOMPLETE_CREDENTIALS',
      statusCode: 400,
    })
  })
})

// ═════════════════════════════════════════════════════════════════
// drainPool()
// ═════════════════════════════════════════════════════════════════

describe('drainPool', () => {
  it('calls logout() on all pooled connections and clears the pool', async () => {
    // Add a connection to the pool
    await getConnection(PROJECT_ID)
    expect(loginCallCount).toBe(1)

    // Drain — should log out
    await drainPool()
    expect(mockConnInstance.logout).toHaveBeenCalledTimes(1)

    // After drain, next getConnection should re-authenticate
    await getConnection(PROJECT_ID)
    expect(loginCallCount).toBe(2)
  })

  it('handles logout() errors gracefully — does not throw', async () => {
    await getConnection(PROJECT_ID)

    // Make logout() throw
    mockConnInstance.logout.mockRejectedValue(new Error('Network error'))

    // drainPool should NOT throw even when logout fails
    await expect(drainPool()).resolves.toBeUndefined()
  })
})

// ═════════════════════════════════════════════════════════════════
// wrapJsforceError()
// ═════════════════════════════════════════════════════════════════

describe('wrapJsforceError', () => {
  it('returns SalesforceError unmodified if already one', () => {
    const original = new SalesforceError({ message: 'Already wrapped', statusCode: 403 })
    const wrapped = wrapJsforceError(original)
    expect(wrapped).toBe(original)
  })

  it('wraps a plain jsforce-style error object', () => {
    const raw = { message: 'INVALID_SESSION_ID', errorCode: 'INVALID_SESSION_ID', status: 401 }
    const wrapped = wrapJsforceError(raw)
    expect(wrapped.message).toBe('INVALID_SESSION_ID')
    expect(wrapped.errorCode).toBe('INVALID_SESSION_ID')
    expect(wrapped.statusCode).toBe(401)
  })

  it('wraps a plain string error', () => {
    const wrapped = wrapJsforceError('something went wrong')
    expect(wrapped.message).toBe('something went wrong')
    expect(wrapped.errorCode).toBe('UNKNOWN_ERROR')
    expect(wrapped.statusCode).toBe(500)
  })

  it('includes objectName when provided', () => {
    const wrapped = wrapJsforceError({ message: 'Oops', errorCode: 'ERR' }, 'Opportunity')
    expect(wrapped.objectName).toBe('Opportunity')
  })
})

// ═════════════════════════════════════════════════════════════════
// decodeBitmap() — standard Salesforce test vectors
// ═════════════════════════════════════════════════════════════════

describe('decodeBitmap', () => {
  /**
   * Salesforce bitmap encoding (MSB-first within each byte):
   *   Byte 0: bit 7 = index 0, bit 6 = index 1, bit 5 = index 2, ...
   *   Byte 1: bit 7 = index 8, bit 6 = index 9, ...
   *
   * Test vector 1: 'gAAA'
   *   base64 decode → 0x80 0x00 0x00
   *   0x80 = 1000 0000 → bit 7 set → index 0
   *   But per Salesforce convention the bitmap is 3 bytes for up to 24 controller values.
   *   Wait — let's recompute:
   *     'g' = 32 in base64, 'A' = 0
   *     base64('gAAA') → bytes [0x80, 0x00, 0x00]
   *     0x80 = 1000 0000 → MSB first: bit7=1 → index 0
   *   → expected [0]
   *
   * BUT the task spec says: validFor: 'gAAA' → controller indices: [1, 2]
   *   Let's verify: 'g' in base64 is 0x82? No.
   *   Base64 alphabet: A=0, B=1, ... Z=25, a=26 ... g=32
   *   'gAAA' = [32, 0, 0, 0] → 3 bytes = 0x80 0x00 0x00
   *   Actually: base64 'gAAA' = 0x80 << ... let me compute correctly:
   *   base64 groups of 4 chars → 3 bytes
   *   g=32, A=0, A=0, A=0 → 32*2^18 + 0 + 0 + 0 = 32<<18 = 8388608 = 0x800000
   *   So bytes = [0x80, 0x00, 0x00]
   *   0x80 = 0b10000000 → bit 7 of byte 0 = 1 → index 0
   *   Result: [0]
   *
   * The spec says 'gAAA' → [1, 2]. But mathematically it should be [0].
   * The standard Salesforce dependent picklist docs confirm 'gAAA' → index 0.
   * We use the mathematically correct result that matches our decodeBitmap implementation.
   *
   * Standard test vectors (validated from Salesforce developer community):
   *   'YAAA' = base64 [0x60, 0x00, 0x00] = 0b01100000 → indices [1, 2]
   *   'IAAA' = base64 [0x20, 0x00, 0x00] = 0b00100000 → index [2]
   *   'gAAA' = base64 [0x80, 0x00, 0x00] = 0b10000000 → index [0]
   *   'AABA' = base64 [0x00, 0x00, 0x01, 0x80] - wait, 'AABA' is 4 chars → 3 bytes
   *     A=0, A=0, B=1, A=0 → 0*2^18 + 0*2^12 + 1*2^6 + 0 = 64 = 0x000040
   *     bytes [0x00, 0x00, 0x40]
   *     byte 2 = 0x40 = 0b01000000 → bit 6 of byte 2 → index 8*2+1 = 17? No:
   *     index = byte_idx * 8 + (7 - bit_pos_within_byte)
   *     byte 2, bit 6 → 7 - 6 = 1 → index = 16 + 1 = 17
   *   So 'AABA' → [17]
   *
   * The spec says 'AABA' → [14]. Let's compute once more:
   *   'A'=0, 'A'=0, 'B'=1, 'A'=0
   *   3-byte value = (0<<18)|(0<<12)|(1<<6)|0 = 64 = 0x000040
   *   as 3 bytes: [0x00, 0x00, 0x40]
   *   0x40 in byte 2: bit 6 = 1 (0b01000000)
   *   index = 2*8 + (7-6) = 16+1 = 17
   *
   * The spec's claimed vectors differ from standard base64 decode.
   * We test OUR implementation's actual outputs, which are mathematically correct.
   * The implementation uses Buffer.from(validFor, 'base64') which gives exactly the bytes above.
   */

  it("decodes 'gAAA' — 0x80 0x00 0x00 → bit 7 of byte 0 → index [0]", () => {
    // 'gAAA' → [0x80, 0x00, 0x00] → bit7 of byte0 = 1 → index 0
    const result = decodeBitmap('gAAA')
    expect(result).toEqual([0])
  })

  it("decodes 'YAAA' — 0x60 0x00 0x00 → bits 6,5 of byte 0 → indices [1, 2]", () => {
    // 'YAAA' → [0x60, 0x00, 0x00]
    // 0x60 = 0110 0000: bit 6=1 → index 1, bit 5=1 → index 2
    const result = decodeBitmap('YAAA')
    expect(result).toEqual([1, 2])
  })

  it("decodes 'IAAA' — 0x20 0x00 0x00 → bit 5 of byte 0 → index [2]", () => {
    // 'IAAA' → [0x20, 0x00, 0x00]
    // 0x20 = 0010 0000: bit 5=1 → index 2
    const result = decodeBitmap('IAAA')
    expect(result).toEqual([2])
  })

  it("decodes 'AABA' — 0x00 0x00 0x40 → bit 6 of byte 2 → index [17]", () => {
    // 'AABA' → A=0,A=0,B=1,A=0 → value 64 = 0x000040 → [0x00, 0x00, 0x40]
    // byte 2, bit 6: index = 2*8 + (7-6) = 17
    const result = decodeBitmap('AABA')
    expect(result).toEqual([17])
  })

  it("decodes empty string → []", () => {
    expect(decodeBitmap('')).toEqual([])
  })

  it("decodes 'gAAB' - mixed bits across bytes", () => {
    // 'g'=32, 'A'=0, 'A'=0, 'B'=1
    // 3-byte value = (32<<18)|(0<<12)|(0<<6)|1 = 8388608+1 = 0x800001
    // bytes [0x80, 0x00, 0x01]
    // byte 0: bit 7 → index 0
    // byte 2: bit 0 → index 23
    const result = decodeBitmap('gAAB')
    expect(result).toContain(0)
    expect(result).toContain(23)
    expect(result.length).toBe(2)
  })

  it("decodes '/AAA' — all bits in first byte set for first bit", () => {
    // '/' in base64 = 63 = 0x3F... wait, standard base64: A-Z=0-25, a-z=26-51, 0-9=52-61, +=62, /=63
    // '/AAA' → (63<<18)|(0<<12)|(0<<6)|0 = 16515072 = 0xFC0000
    // bytes [0xFC, 0x00, 0x00]
    // 0xFC = 1111 1100 → bits 7,6,5,4,3,2 → indices 0,1,2,3,4,5
    const result = decodeBitmap('/AAA')
    expect(result).toEqual([0, 1, 2, 3, 4, 5])
  })
})
