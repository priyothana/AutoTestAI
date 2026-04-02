/**
 * Salesforce Domain Model Builder
 *
 * Port of Python: backend/app/services/domain_model_builder.py
 *
 * Reads `metadata_normalized` and produces testing-oriented `domain_models`.
 * Maps field types → testing semantics (CRUD actions, validation rules, etc.)
 *
 * Called from: metadata-sync.worker.ts (stage 3 of 4)
 */
import prisma from '../../shared/db/prisma.js'
import { createModuleLogger } from '../../shared/logger/index.js'

const log = createModuleLogger('sf-domain-builder')

// ─── Field-type → test-type mapping (mirrors Python FIELD_TYPE_TEST_MAPPING) ─

const FIELD_TYPE_TEST_MAPPING: Record<string, string> = {
  string:         'text_input_test',
  textarea:       'text_area_test',
  email:          'email_validation_test',
  phone:          'phone_format_test',
  url:            'url_validation_test',
  currency:       'currency_input_test',
  double:         'numeric_input_test',
  int:            'integer_input_test',
  percent:        'percentage_input_test',
  date:           'date_picker_test',
  datetime:       'datetime_picker_test',
  boolean:        'checkbox_test',
  picklist:       'dropdown_selection_test',
  multipicklist:  'multi_select_test',
  reference:      'lookup_field_test',
  id:             'record_id_test',
}

// ─── Internal builders ────────────────────────────────────────────────────────

interface TestingRule { [key: string]: unknown }

function buildObjectDomain(
  data: Record<string, unknown>,
): { actions: string[]; testingRules: TestingRule[] } {
  const actions: string[]        = []
  const testingRules: TestingRule[] = []

  if (data['createable']) actions.push('create')
  if (data['updateable']) actions.push('edit')
  if (data['deletable'])  actions.push('delete')
  if (data['queryable'])  { actions.push('view'); actions.push('search') }

  const fields = (Array.isArray(data['fields']) ? data['fields'] : []) as Record<string, unknown>[]

  for (const field of fields) {
    const fieldApi  = String(field['api']  ?? '')
    const fieldType = String(field['type'] ?? 'string').toLowerCase()

    if (field['required']) {
      testingRules.push({
        type:        'mandatory_field_test',
        field:       fieldApi,
        description: `Verify ${fieldApi} is required and cannot be left empty`,
      })
    }

    if (fieldType === 'picklist') {
      const plvs = (Array.isArray(field['picklistValues']) ? field['picklistValues'] : []) as Record<string, unknown>[]
      if (plvs.length > 0) {
        testingRules.push({
          type:        'dropdown_selection_test',
          field:       fieldApi,
          values:      plvs.filter((v) => v['active']).map((v) => v['value']),
          description: `Verify ${fieldApi} dropdown shows correct options`,
        })
      }
    }

    const testType = FIELD_TYPE_TEST_MAPPING[fieldType]
    if (testType) {
      testingRules.push({
        type:        testType,
        field:       fieldApi,
        description: `Verify ${fieldApi} accepts valid ${fieldType} input`,
      })
    }

    if (field['unique']) {
      testingRules.push({
        type:        'uniqueness_test',
        field:       fieldApi,
        description: `Verify ${fieldApi} rejects duplicate values`,
      })
    }
  }

  const vrs = (Array.isArray(data['validation_rules']) ? data['validation_rules'] : []) as Record<string, unknown>[]
  for (const vr of vrs) {
    actions.push(`validate_${String(vr['name'] ?? 'rule')}`)
    testingRules.push({
      type:          'negative_test',
      rule:          String(vr['name']          ?? ''),
      formula:       String(vr['formula']        ?? ''),
      error_message: String(vr['error_message']  ?? ''),
      description:   `Verify validation rule '${String(vr['name'] ?? '')}' fires correctly`,
    })
  }

  return { actions, testingRules }
}

function buildFlowDomain(
  data: Record<string, unknown>,
): { actions: string[]; testingRules: TestingRule[] } {
  const flowName    = String(data['api_name'] ?? data['label'] ?? 'Unknown')
  const processType = String(data['process_type'] ?? '')

  const actions: string[] = ['trigger_flow', 'complete_flow', 'verify_flow_outcome']
  const testingRules: TestingRule[] = [
    {
      type:         'business_process_test',
      flow:         flowName,
      process_type: processType,
      description:  `Verify flow '${flowName}' executes successfully end-to-end`,
    },
  ]

  if (processType === 'Workflow' || processType === 'AutoLaunchedFlow') {
    testingRules.push({
      type:        'automated_process_test',
      description: `Verify automated flow '${flowName}' triggers on correct conditions`,
    })
  } else if (processType === 'Flow') {
    testingRules.push({
      type:        'screen_flow_test',
      description: `Verify screen flow '${flowName}' UI renders and submits correctly`,
    })
  }

  return { actions, testingRules }
}

function buildLwcDomain(
  data: Record<string, unknown>,
): { actions: string[]; testingRules: TestingRule[] } {
  const lwcName = String(data['developer_name'] ?? 'Unknown')

  return {
    actions: ['render_component', 'interact_with_component', 'verify_component_output'],
    testingRules: [
      {
        type:        'ui_interaction_test',
        component:   lwcName,
        description: `Verify LWC '${lwcName}' renders correctly and responds to user interaction`,
      },
      {
        type:        'component_visibility_test',
        component:   lwcName,
        description: `Verify LWC '${lwcName}' is visible on the page`,
      },
    ],
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build domain models for all normalized metadata in a project.
 * Clears existing domain models before rebuilding (full refresh).
 * Returns the count of domain models created.
 */
export async function buildDomainModels(projectId: string): Promise<number> {
  log.info(`[DOMAIN-BUILDER] Starting domain model build for project ${projectId}`)

  // Clear existing models (full rebuild)
  await prisma.domain_models.deleteMany({ where: { project_id: projectId } })

  const normalized = await prisma.metadata_normalized.findMany({
    where: { project_id: projectId },
  })

  let count = 0

  for (const record of normalized) {
    const data        = (record.structured_json ?? {}) as Record<string, unknown>
    const entityType  = record.entity_type

    let result: { actions: string[]; testingRules: TestingRule[] }

    if (entityType === 'object') {
      result = buildObjectDomain(data)
    } else if (entityType === 'flow') {
      result = buildFlowDomain(data)
    } else if (entityType === 'lwc') {
      result = buildLwcDomain(data)
    } else {
      continue // skip unknown types
    }

    await prisma.domain_models.create({
      data: {
        project_id:    projectId,
        entity_name:   record.object_name,
        actions:       result.actions       as object,
        testing_rules: result.testingRules  as object,
      },
    })

    count++
  }

  log.info(`[DOMAIN-BUILDER] Built ${count} domain models for project ${projectId}`)
  return count
}
