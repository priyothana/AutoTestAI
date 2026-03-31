/**
 * Salesforce Module — Dependent Picklist Resolution
 *
 * Gap 1 from parity analysis: JSforce returns a raw base64 bitmap in
 * `field.picklistValues[n].validFor` which encodes which controller field
 * values the dependent option is valid for.
 *
 * This module decodes that bitmap and builds a structured mapping:
 *   controllerValue → PicklistValue[]
 *
 * The output is byte-for-byte compatible with what the Python engine
 * produced — the parity test verifies this.
 */
import { describeObject } from './sf-metadata.js'
import type { DependentPicklistMap, PicklistValue } from './sf-types.js'
import { SalesforceError } from './sf-types.js'
import { createModuleLogger } from '../../../shared/logger/index.js'

const log = createModuleLogger('salesforce:dependent-picklist')

// ─── Bitmap decoder ───────────────────────────────────────────────

/**
 * Decode the base64 `validFor` string in a dependent picklist value.
 *
 * Each bit position `i` maps to one controller value (by index).
 * If the bit is set → this dependent value is valid when the controller
 * field equals the value at index `i`.
 *
 * Bit layout (MSB first within each byte):
 *   Byte 0: bits 7,6,5,4,3,2,1,0  (controller indices 0–7)
 *   Byte 1: bits 15,14,...,8       (controller indices 8–15)
 *   ...
 *
 * @param validFor  Base64 string from JSforce field descriptor
 * @returns         Array of controller value indices this option is valid for
 */
export function decodeBitmap(validFor: string): number[] {
  if (!validFor) return []

  const bitmap = Buffer.from(validFor, 'base64')
  const validIndices: number[] = []

  for (let i = 0; i < bitmap.length * 8; i++) {
    const byte = Math.floor(i / 8)
    const bit = 7 - (i % 8)
    if (bitmap[byte] & (1 << bit)) {
      validIndices.push(i)
    }
  }

  return validIndices
}

// ─── Dependent picklist resolution ────────────────────────────────

/**
 * Build a complete dependent picklist mapping for a pair of controller +
 * dependent fields on a Salesforce object.
 *
 * Steps:
 *  1. Call describeObject to get both fields (reuses the metadata cache)
 *  2. Get controller field picklist values (with their array indices)
 *  3. Get dependent field picklist values (with validFor bitmaps)
 *  4. For each dependent value: decode bitmap → controller indices
 *  5. Build mapping: controllerValue → dependent values[]
 *
 * @param projectId           Project whose Salesforce org to query
 * @param objectName          Salesforce API name (e.g. "Opportunity")
 * @param controllerFieldName API name of the controlling field (e.g. "Type")
 * @param dependentFieldName  API name of the dependent field (e.g. "StageName")
 */
export async function getDependentPicklistValues(
  projectId: string,
  objectName: string,
  controllerFieldName: string,
  dependentFieldName: string,
): Promise<DependentPicklistMap> {
  log.info(
    `[dependent-picklist] Resolving ${objectName}.${controllerFieldName} → ${dependentFieldName}`,
  )

  // Step 1: describe the object (cached after first call)
  const metadata = await describeObject(projectId, objectName)

  const controllerLower = controllerFieldName.toLowerCase()
  const dependentLower = dependentFieldName.toLowerCase()

  // Step 2: find the controller field
  const controllerField = metadata.fields.find(
    (f) => f.name.toLowerCase() === controllerLower,
  )

  if (!controllerField) {
    throw new SalesforceError({
      message: `Controller field '${controllerFieldName}' not found on '${objectName}'`,
      errorCode: 'FIELD_NOT_FOUND',
      statusCode: 404,
      objectName,
    })
  }

  // Step 3: find the dependent field (raw — we need the validFor bitmaps)
  const dependentField = metadata.fields.find(
    (f) => f.name.toLowerCase() === dependentLower,
  )

  if (!dependentField) {
    throw new SalesforceError({
      message: `Dependent field '${dependentFieldName}' not found on '${objectName}'`,
      errorCode: 'FIELD_NOT_FOUND',
      statusCode: 404,
      objectName,
    })
  }

  // Controller values indexed by their position in the picklist values array.
  // The bitmap bit position corresponds to this index array.
  const controllerValues = controllerField.picklistValues

  if (controllerValues.length === 0) {
    log.warn(
      `[dependent-picklist] Controller field '${controllerFieldName}' has no picklist values`,
    )
  }

  // Step 4 + 5: build the mapping
  // We need the raw validFor from JSforce, but our FieldMetadata only stores
  // the already-mapped PicklistValue shape. We need to re-fetch the raw data.
  // Solution: re-fetch the raw describe to get the validFor bitmaps.
  const rawDependentValues = await getRawDependentValues(
    projectId,
    objectName,
    dependentFieldName,
  )

  const mapping: { [controllerValue: string]: PicklistValue[] } = {}

  // Initialise empty arrays for every controller value
  for (const cv of controllerValues) {
    mapping[cv.value] = []
  }

  // Decode each dependent value's bitmap
  for (const raw of rawDependentValues) {
    const validFor: string = raw.validFor ?? ''
    if (!validFor) {
      // If no validFor, the value is valid for ALL controller values
      const mappedValue: PicklistValue = {
        label: raw.label,
        value: raw.value,
        active: raw.active ?? true,
        defaultValue: raw.defaultValue ?? false,
      }
      for (const cv of controllerValues) {
        mapping[cv.value] = mapping[cv.value] ?? []
        mapping[cv.value].push(mappedValue)
      }
      continue
    }

    const validIndices = decodeBitmap(validFor)

    const mappedValue: PicklistValue = {
      label: raw.label,
      value: raw.value,
      active: raw.active ?? true,
      defaultValue: raw.defaultValue ?? false,
    }

    for (const idx of validIndices) {
      const cv = controllerValues[idx]
      if (cv) {
        mapping[cv.value] = mapping[cv.value] ?? []
        mapping[cv.value].push(mappedValue)
      }
    }
  }

  return {
    controllerField: controllerFieldName,
    dependentField: dependentFieldName,
    mapping,
  }
}

// ─── Raw describe (for validFor bitmap access) ────────────────────

/**
 * Fetch the raw JSforce picklist values for a dependent field so we have
 * access to the `validFor` bitmap strings before our mapper strips them.
 *
 * We go directly to JSforce here (not through the metadata helper) because
 * the FieldMetadata type doesn't carry validFor — it's internal to this
 * resolution algorithm only.
 */
interface RawPicklistEntry {
  label: string
  value: string
  active: boolean
  defaultValue: boolean
  validFor: string
}

async function getRawDependentValues(
  projectId: string,
  objectName: string,
  fieldName: string,
): Promise<RawPicklistEntry[]> {
  const { executeWithRetry } = await import('./sf-connection.js')

  const fieldNameLower = fieldName.toLowerCase()

  const raw = await executeWithRetry(projectId, async (conn) => {
    const d = await conn.describe(objectName)
    const fields = (d as unknown as Record<string, unknown>)['fields']
    if (!Array.isArray(fields)) return []
    return fields as Record<string, unknown>[]
  })

  const fieldRaw = raw.find(
    (f) => String(f['name'] ?? '').toLowerCase() === fieldNameLower,
  )

  if (!fieldRaw) return []

  const plv = fieldRaw['picklistValues']
  if (!Array.isArray(plv)) return []

  return plv.map((v: Record<string, unknown>) => ({
    label: String(v['label'] ?? ''),
    value: String(v['value'] ?? ''),
    active: typeof v['active'] === 'boolean' ? v['active'] : true,
    defaultValue: typeof v['defaultValue'] === 'boolean' ? v['defaultValue'] : false,
    validFor: String(v['validFor'] ?? ''),
  }))
}
