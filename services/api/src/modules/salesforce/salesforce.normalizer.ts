/**
 * Salesforce Metadata Normalizer
 *
 * Port of Python: backend/app/services/metadata_normalizer.py
 *
 * Reads raw rows from `metadata_raw_store` and produces structured,
 * normalized records in `metadata_normalized`.
 *
 * Groups: objects (with their fields + validation rules), flows, LWC.
 *
 * Called from: metadata-sync.worker.ts (stage 2 of 4)
 */
import prisma from '../../shared/db/prisma.js'
import { createModuleLogger } from '../../shared/logger/index.js'

const log = createModuleLogger('sf-normalizer')

// ─── Internal types ───────────────────────────────────────────────────────────

interface FieldInfo {
  api: string
  label: string
  type: string
  required: boolean
  createable: boolean
  length?: number | null
  picklistValues: { label: string; value: string; active: boolean }[]
  referenceTo: string[]
  unique: boolean
  externalId: boolean
  controllerName: string
  dependentPicklist: boolean
  filteredLookupInfo: unknown
  relationshipName: string
  ui_label?: string
}

interface ValidationRuleInfo {
  name: string
  error_message: string
  formula: string
  active: boolean
}

interface ObjectInfo {
  label: string
  custom: boolean
  createable: boolean
  updateable: boolean
  deletable: boolean
  queryable: boolean
}

interface FlowInfo {
  api_name: string
  label: string
  process_type: string
  status: string
}

interface LwcInfo {
  developer_name: string
  label: string
  description: string
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Normalize all raw metadata for a project.
 * Clears existing normalized rows first (full re-build).
 * Returns the count of normalized records created.
 */
export async function normalizeMetadata(projectId: string): Promise<number> {
  log.info(`[NORMALIZER] Starting normalization for project ${projectId}`)

  // Clear existing normalized data for clean rebuild
  await prisma.metadata_normalized.deleteMany({ where: { project_id: projectId } })

  // Fetch all raw records
  const rawRecords = await prisma.metadata_raw_store.findMany({
    where: { project_id: projectId },
  })

  // ── Group by type ───────────────────────────────────────────────────────
  const objectsMap = new Map<string, ObjectInfo>()
  const fieldsMap  = new Map<string, FieldInfo[]>()
  const validationRulesMap = new Map<string, ValidationRuleInfo[]>()
  const flows: FlowInfo[] = []
  const lwcComponents: LwcInfo[] = []

  for (const raw of rawRecords) {
    const data = (raw.raw_json ?? {}) as Record<string, unknown>

    if (raw.metadata_type === 'object') {
      objectsMap.set(raw.api_name, {
        label:      String(data['label']      ?? raw.api_name),
        custom:     Boolean(data['custom']    ?? false),
        createable: Boolean(data['createable'] ?? false),
        updateable: Boolean(data['updateable'] ?? false),
        deletable:  Boolean(data['deletable']  ?? false),
        queryable:  Boolean(data['queryable']  ?? false),
      })

    } else if (raw.metadata_type === 'field') {
      // api_name is "ObjectName.FieldName"
      const parts   = raw.api_name.split('.', 2)
      const objName = parts.length > 1 ? parts[0] : 'Unknown'
      const fldName = parts.length > 1 ? parts[1] : raw.api_name

      const picklistValues = (
        Array.isArray(data['picklistValues']) ? data['picklistValues'] : []
      ) as Record<string, unknown>[]

      const field: FieldInfo = {
        api:        fldName,
        label:      String(data['label']    ?? fldName),
        type:       String(data['type']     ?? 'string'),
        required:   !Boolean(data['nillable'] ?? true) && !Boolean(data['defaultedOnCreate'] ?? false),
        createable: Boolean(data['createable'] ?? true),
        length:     typeof data['length'] === 'number' ? data['length'] : null,
        picklistValues: picklistValues.map((pv) => ({
          label:  String(pv['label']  ?? ''),
          value:  String(pv['value']  ?? ''),
          active: Boolean(pv['active'] ?? true),
        })),
        referenceTo:       Array.isArray(data['referenceTo']) ? data['referenceTo'] as string[] : [],
        unique:            Boolean(data['unique']            ?? false),
        externalId:        Boolean(data['externalId']        ?? false),
        controllerName:    String(data['controllerName']     ?? ''),
        dependentPicklist: Boolean(data['dependentPicklist'] ?? false),
        filteredLookupInfo: data['filteredLookupInfo'] ?? null,
        relationshipName:  String(data['relationshipName']   ?? ''),
      }

      // Reference fields: store ui_label (strip " ID" suffix → " Name")
      if (data['type'] === 'reference') {
        const rawLabel = field.label
        field.ui_label = rawLabel.endsWith(' ID')
          ? rawLabel.slice(0, -3) + ' Name'
          : rawLabel
      }

      if (!fieldsMap.has(objName)) fieldsMap.set(objName, [])
      fieldsMap.get(objName)!.push(field)

    } else if (raw.metadata_type === 'validation_rule') {
      const parts   = raw.api_name.split('.', 2)
      const objName = parts.length > 1 ? parts[0] : 'Unknown'
      const ruleName = parts.length > 1 ? parts[1] : raw.api_name

      const vr: ValidationRuleInfo = {
        name:          ruleName,
        error_message: String(data['ErrorMessage']          ?? ''),
        formula:       String(data['ErrorConditionFormula'] ?? ''),
        active:        Boolean(data['Active']               ?? true),
      }

      if (!validationRulesMap.has(objName)) validationRulesMap.set(objName, [])
      validationRulesMap.get(objName)!.push(vr)

    } else if (raw.metadata_type === 'flow') {
      flows.push({
        api_name:     raw.api_name,
        label:        String(data['Label']       ?? raw.api_name),
        process_type: String(data['ProcessType'] ?? ''),
        status:       String(data['Status']      ?? ''),
      })

    } else if (raw.metadata_type === 'lwc') {
      lwcComponents.push({
        developer_name: raw.api_name,
        label:          String(data['MasterLabel'] ?? raw.api_name),
        description:    String(data['Description'] ?? ''),
      })
    }
  }

  // ── Write normalized records ──────────────────────────────────────────────
  let count = 0

  // Objects (with embedded fields + validation rules)
  for (const [objName, objInfo] of objectsMap) {
    const structured = {
      object:           objName,
      ...objInfo,
      fields:           fieldsMap.get(objName)           ?? [],
      validation_rules: validationRulesMap.get(objName) ?? [],
    }

    await prisma.metadata_normalized.create({
      data: {
        project_id:      projectId,
        object_name:     objName,
        entity_type:     'object',
        label:           objInfo.label,
        structured_json: structured as object,
      },
    })
    count++
  }

  // Flows
  for (const flow of flows) {
    await prisma.metadata_normalized.create({
      data: {
        project_id:      projectId,
        object_name:     flow.api_name,
        entity_type:     'flow',
        label:           flow.label,
        structured_json: flow as object,
      },
    })
    count++
  }

  // LWC
  for (const lwc of lwcComponents) {
    await prisma.metadata_normalized.create({
      data: {
        project_id:      projectId,
        object_name:     lwc.developer_name,
        entity_type:     'lwc',
        label:           lwc.label,
        structured_json: lwc as object,
      },
    })
    count++
  }

  log.info(`[NORMALIZER] Normalized ${count} records for project ${projectId}`)
  return count
}
