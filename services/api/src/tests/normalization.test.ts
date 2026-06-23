import { describe, it, expect, vi, beforeEach } from 'vitest'

// Use vi.hoisted to declare variables before any module imports are resolved
const { mockPrisma } = vi.hoisted(() => {
  const mockPrisma = {
    metadata_canonical: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    project_integrations: {
      findFirst: vi.fn(),
    },
  }
  return { mockPrisma }
})

// Mock prisma database client
vi.mock('../shared/db/prisma.js', () => ({
  default: mockPrisma,
}))

// Mock logger
vi.mock('../shared/logger/index.js', () => ({
  createModuleLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}))

import { extractLabelFromTarget } from '../workers/execution.worker.js'
import { validateSteps } from '../modules/ai-agents/test-step-generator.agent.js'
import { autoCorrectButtonNames, buildFieldManifest } from '../modules/ai-agents/tools/metadata-reader.tool.js'

describe('Lookup Label Normalization (extractLabelFromTarget)', () => {
  it('should clean verbose search and select lookup targets', () => {
    expect(extractLabelFromTarget('Search and select account...')).toBe('Account')
    expect(extractLabelFromTarget('Search and select Contact lookup')).toBe('Contact')
    expect(extractLabelFromTarget('Search Account')).toBe('Account')
    expect(extractLabelFromTarget('Search...')).toBe('Search')
  })

  it('should extract label from playwright locators and then normalize', () => {
    expect(extractLabelFromTarget("getByLabel('Search and select account...')")).toBe('Account')
    expect(extractLabelFromTarget("getByPlaceholder('Search Account')")).toBe('Account')
    expect(extractLabelFromTarget("getByRole('combobox', { name: 'Search and select account...' })")).toBe('Account')
  })
})

describe('Test Step Generator Validation (validateSteps)', () => {
  const sampleSteps = [
    { id: '1', action: 'NAVIGATE', value: '/contacts' },
    { id: '2', action: 'CLICK', target: 'Delete Contact' },
    { id: '3', action: 'CLICK', target: 'Confirm' },
    { id: '4', action: 'ASSERT_URL', value: '/contacts' }
  ]

  const manifestFields = [
    { label: 'Full Name', required: true, type: 'text' },
    { label: 'Email', required: true, type: 'email' },
    { label: 'Account', required: true, type: 'lookup' }
  ]

  it('should NOT fail required field validation for Delete operations', () => {
    const result = validateSteps(
      sampleSteps as any,
      3, // requiredCount
      ['/contacts'], // verifiedPaths
      'Save', // submitButton
      ['Save', 'Delete', 'Confirm', 'Cancel'], // allButtons
      manifestFields as any,
      'delete Contact' // testEntityHint
    )
    expect(result.passed).toBe(true)
    expect(result.issues).toHaveLength(0)
  })

  it('should NOT fail required field validation for View operations', () => {
    const result = validateSteps(
      sampleSteps as any,
      3,
      ['/contacts'],
      'Save',
      ['Save', 'Delete', 'Confirm', 'Cancel'],
      manifestFields as any,
      'view Contact'
    )
    expect(result.passed).toBe(true)
    expect(result.issues).toHaveLength(0)
  })

  it('should fail required field validation for Create/Add operations if fields are missing', () => {
    const result = validateSteps(
      sampleSteps as any,
      3,
      ['/contacts'],
      'Save',
      ['Save', 'Delete', 'Confirm', 'Cancel'],
      manifestFields as any,
      'create Contact'
    )
    expect(result.passed).toBe(false)
    expect(result.issues.some(issue => issue.includes('Missing required fields'))).toBe(true)
  })
})

describe('Button Auto-Correction (autoCorrectButtonNames)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should NOT auto-correct delete or confirmation buttons', async () => {
    // Setup metadata mock
    mockPrisma.metadata_canonical.findFirst.mockResolvedValue({
      primary_action_button: 'Save Contact',
      all_buttons: ['Save Contact', 'Delete Contact', 'Cancel'],
      fields_json: '[]',
    })

    const steps = [
      { action: 'CLICK', target: 'Delete' },
      { action: 'CLICK', target: 'Confirm' },
      { action: 'CLICK', target: 'Cancel' }
    ]

    const corrected = await autoCorrectButtonNames(steps, 'project-123', 'Contact')
    
    expect(corrected[0].target).toBe('Delete')
    expect(corrected[1].target).toBe('Confirm')
    expect(corrected[2].target).toBe('Cancel')
  })

  it('should auto-correct generic save buttons to the canonical primary button', async () => {
    mockPrisma.metadata_canonical.findFirst.mockResolvedValue({
      primary_action_button: 'Save Contact',
      all_buttons: ['Save Contact', 'Delete Contact', 'Cancel'],
      fields_json: '[]',
    })

    const steps = [
      { action: 'CLICK', target: 'Save' }
    ]

    const corrected = await autoCorrectButtonNames(steps, 'project-123', 'Contact')
    expect(corrected[0].target).toBe('Save Contact')
  })
})

describe('Canonical Manifest Resolution (buildFieldManifest & tryCanonicalManifest)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ENABLE_CANONICAL_METADATA = 'true'
  })

  it('should resolve canonical metadata with exact matches', async () => {
    mockPrisma.metadata_canonical.findMany.mockResolvedValue([
      {
        entity_name: 'Sku',
        entity_type: 'list_page',
        page_url: '/skus',
        source: 'crawler',
        primary_action_button: 'Create Sku',
        form_fields: [],
        required_fields: [],
        optional_fields: [],
      }
    ])

    const manifest = await buildFieldManifest('project-123', 'Sku')
    expect(manifest).not.toBeNull()
    expect(manifest?.entityName).toBe('Sku')
    expect(manifest?.createUrl).toBe('/skus')
  })

  it('should resolve canonical metadata via substring matching when raw filter is noisy', async () => {
    mockPrisma.metadata_canonical.findMany.mockResolvedValue([
      {
        entity_name: 'Sku',
        entity_type: 'list_page',
        page_url: '/skus',
        source: 'crawler',
        primary_action_button: 'Create Sku',
        form_fields: [],
        required_fields: [],
        optional_fields: [],
      },
      {
        entity_name: 'Account',
        entity_type: 'form',
        page_url: '/accounts',
        source: 'crawler',
        primary_action_button: 'Create Account',
        form_fields: [],
        required_fields: [],
        optional_fields: [],
      }
    ])

    const manifest = await buildFieldManifest('project-123', 'Sku Weight And Dimensions')
    expect(manifest).not.toBeNull()
    expect(manifest?.entityName).toBe('Sku')
    expect(manifest?.createUrl).toBe('/skus')
  })

  it('should return null when there is no matching canonical record', async () => {
    mockPrisma.metadata_canonical.findMany.mockResolvedValue([
      {
        entity_name: 'Account',
        entity_type: 'form',
        page_url: '/accounts',
        source: 'crawler',
        form_fields: [],
        required_fields: [],
        optional_fields: [],
      }
    ])

    const manifest = await buildFieldManifest('project-123', 'NonExistentObject')
    expect(manifest).toBeNull()
  })
})
