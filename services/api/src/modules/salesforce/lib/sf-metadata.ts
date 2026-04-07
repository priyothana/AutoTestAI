/**
 * Salesforce Module — Metadata Fetchers with Cache Layer
 *
 * All metadata fetch functions using the cached connection from sf-connection.ts.
 * Results are cached in-process with a configurable TTL (default 10 minutes).
 *
 * Cache features (Session 2):
 *   • Generic CacheEntry<T> interface with data + cachedAt + ttl
 *   • TTL configurable via SF_METADATA_CACHE_TTL_MS env var
 *   • invalidateCache(projectId, objectName?) for targeted invalidation
 *
 * Functions:
 *   describeObject     — full describe result (with field + recordType + child data)
 *   getFields          — field descriptors for an object
 *   getPicklistValues  — picklist values for a specific field
 *   listObjects        — global describe (all queryable objects)
 *   getRecordTypes     — record type infos for an object
 *   invalidateCache    — targeted cache invalidation (exported for route use)
 */
import { executeWithRetry } from './sf-connection.js'
import { createModuleLogger } from '../../../shared/logger/index.js'
import type {
  ObjectMetadata,
  FieldMetadata,
  PicklistValue,
  GlobalObjectSummary,
  RecordTypeInfo,
} from './sf-types.js'

const log = createModuleLogger('salesforce:metadata')

// ─── Cache interfaces & constants ─────────────────────────────────

/** Generic cache entry — stores data alongside its creation timestamp and TTL */
interface CacheEntry<T> {
  data: T
  cachedAt: number   // Date.now() at time of insert
  ttl: number        // how long this entry lives in milliseconds
}

/**
 * TTL for describe results — configurable via env var.
 * Defaults to 10 minutes (600 000 ms).
 */
const DEFAULT_CACHE_TTL_MS = 600_000

function getCacheTtl(): number {
  const envVal = process.env['SF_METADATA_CACHE_TTL_MS']
  if (envVal) {
    const parsed = parseInt(envVal, 10)
    if (!Number.isNaN(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_CACHE_TTL_MS
}

// ─── In-process cache stores ──────────────────────────────────────

/** Cache key format: `${projectId}:${objectName}` */
const metadataCache = new Map<string, CacheEntry<unknown>>()

// ─── Cache helpers ────────────────────────────────────────────────

function buildCacheKey(projectId: string, objectName: string): string {
  return `${projectId}:${objectName}`
}

/** Retrieve a cached entry if it has not yet expired. */
function getCached<T>(key: string): T | null {
  const entry = metadataCache.get(key) as CacheEntry<T> | undefined
  if (!entry) return null
  if (Date.now() > entry.cachedAt + entry.ttl) {
    metadataCache.delete(key)
    return null
  }
  return entry.data
}

/** Store a value in the cache with the current timestamp and configured TTL. */
function setCached<T>(key: string, data: T): void {
  const entry: CacheEntry<T> = {
    data,
    cachedAt: Date.now(),
    ttl: getCacheTtl(),
  }
  metadataCache.set(key, entry as CacheEntry<unknown>)
}

// ─── Public cache invalidation ────────────────────────────────────

/**
 * Invalidate cache entries for a project.
 *
 * @param projectId   The project to invalidate
 * @param objectName  If provided, only that specific object key is deleted.
 *                    If omitted, ALL keys for this project are purged.
 */
export function invalidateCache(projectId: string, objectName?: string): void {
  if (objectName) {
    const key = buildCacheKey(projectId, objectName)
    metadataCache.delete(key)
    log.info(`[metadata] Cache invalidated: ${key}`)
  } else {
    const prefix = `${projectId}:`
    let deleted = 0
    for (const key of metadataCache.keys()) {
      if (key.startsWith(prefix)) {
        metadataCache.delete(key)
        deleted++
      }
    }
    log.info(`[metadata] All caches invalidated for project ${projectId} (${deleted} entries removed)`)
  }
}

/**
 * @deprecated Use invalidateCache() — old name kept for backward-compat inside this module.
 */
export function invalidateDescribeCache(projectId: string, objectName?: string): void {
  invalidateCache(projectId, objectName)
}

// ─── Mapping helpers ──────────────────────────────────────────────

function mapPicklistValue(raw: Record<string, unknown>): PicklistValue {
  return {
    label: String(raw['label'] ?? raw['value'] ?? ''),
    value: String(raw['value'] ?? raw['label'] ?? ''),
    active: typeof raw['active'] === 'boolean' ? raw['active'] : true,
    defaultValue: typeof raw['defaultValue'] === 'boolean' ? raw['defaultValue'] : false,
  }
}

function mapField(raw: Record<string, unknown>): FieldMetadata {
  const plv = Array.isArray(raw['picklistValues'])
    ? (raw['picklistValues'] as Record<string, unknown>[]).map(mapPicklistValue)
    : []

  const refs = Array.isArray(raw['referenceTo'])
    ? (raw['referenceTo'] as unknown[]).map(String)
    : []

  return {
    name: String(raw['name'] ?? ''),
    label: String(raw['label'] ?? ''),
    type: String(raw['type'] ?? 'string'),
    required: raw['nillable'] === false || raw['required'] === true,
    updateable: Boolean(raw['updateable']),
    createable: Boolean(raw['createable']),
    length: typeof raw['length'] === 'number' ? raw['length'] : undefined,
    picklistValues: plv,
    referenceTo: refs,
    relationshipName:
      raw['relationshipName'] != null ? String(raw['relationshipName']) : null,
  }
}

function mapRecordTypeInfo(raw: Record<string, unknown>): RecordTypeInfo {
  return {
    recordTypeId: String(raw['recordTypeId'] ?? ''),
    name: String(raw['name'] ?? ''),
    developerName: String(raw['developerName'] ?? ''),
    available: Boolean(raw['available']),
    master: Boolean(raw['master']),
  }
}

// ─── Core functions ───────────────────────────────────────────────

/**
 * Describe a Salesforce object — results are cached per SF_METADATA_CACHE_TTL_MS.
 * Uses the connection pool from sf-connection.ts (with session-expiry retry).
 */
export async function describeObject(
  projectId: string,
  objectName: string,
): Promise<ObjectMetadata> {
  const key = buildCacheKey(projectId, objectName)
  const cached = getCached<ObjectMetadata>(key)
  if (cached) {
    log.debug(`[metadata] Cache hit: ${key}`)
    return cached
  }

  log.info(`[metadata] Describing ${objectName} for project ${projectId}`)

  const result = await executeWithRetry(projectId, async (conn) => {
    const d = await conn.describe(objectName)
    return d as unknown as Record<string, unknown>
  })

  const fields = (Array.isArray(result['fields'])
    ? result['fields']
    : []) as Record<string, unknown>[]

  const recordTypeInfos = (Array.isArray(result['recordTypeInfos'])
    ? result['recordTypeInfos']
    : []) as Record<string, unknown>[]

  const childRelationships = (Array.isArray(result['childRelationships'])
    ? result['childRelationships']
    : []) as Record<string, unknown>[]

  const metadata: ObjectMetadata = {
    name: String(result['name'] ?? objectName),
    label: String(result['label'] ?? objectName),
    fields: fields.map(mapField),
    recordTypeInfos: recordTypeInfos.map(mapRecordTypeInfo),
    childRelationships: childRelationships.map((cr) => ({
      childSObject: String(cr['childSObject'] ?? ''),
      field: String(cr['field'] ?? ''),
      relationshipName: cr['relationshipName'] != null ? String(cr['relationshipName']) : null,
    })),
  }

  setCached(key, metadata)
  return metadata
}

/**
 * Return field descriptors for a Salesforce object.
 * Reuses the describe cache — no extra API call if already cached.
 */
export async function getFields(
  projectId: string,
  objectName: string,
): Promise<FieldMetadata[]> {
  const metadata = await describeObject(projectId, objectName)
  return metadata.fields
}

/**
 * Return picklist values for a single field on an object.
 * Returns an empty array (not an error) for non-picklist fields.
 * Reuses the describe cache.
 */
export async function getPicklistValues(
  projectId: string,
  objectName: string,
  fieldName: string,
): Promise<PicklistValue[]> {
  const metadata = await describeObject(projectId, objectName)
  const fieldNameLower = fieldName.toLowerCase()
  const field = metadata.fields.find((f) => f.name.toLowerCase() === fieldNameLower)

  if (!field) {
    // Import SalesforceError at runtime to avoid circular dependency
    const { SalesforceError } = await import('./sf-types.js')
    throw new SalesforceError({
      message: `Field '${fieldName}' not found on object '${objectName}'`,
      errorCode: 'FIELD_NOT_FOUND',
      statusCode: 404,
      objectName,
    })
  }

  // Non-picklist fields return an empty array (not an error)
  return field.picklistValues
}

/**
 * List all Salesforce objects (global describe).
 * Cached per project with a configurable TTL.
 */
export async function listObjects(
  projectId: string,
  queryableOnly = false,
): Promise<GlobalObjectSummary[]> {
  const cacheKey = buildCacheKey(projectId, '__global__')
  const cached = getCached<GlobalObjectSummary[]>(cacheKey)
  if (cached) {
    log.debug(`[metadata] Global describe cache hit for project ${projectId}`)
    const result = cached
    return queryableOnly ? result.filter((o) => o.queryable) : result
  }

  log.info(`[metadata] Global describe for project ${projectId}`)

  const sobjects = await executeWithRetry(projectId, async (conn) => {
    const result = await conn.describeGlobal()
    return result.sobjects as Record<string, unknown>[]
  })

  const summaries: GlobalObjectSummary[] = sobjects.map((s) => ({
    name: String(s['name'] ?? ''),
    label: String(s['label'] ?? ''),
    queryable: Boolean(s['queryable']),
    createable: Boolean(s['createable']),
    updateable: Boolean(s['updateable']),
  }))

  setCached(cacheKey, summaries)
  return queryableOnly ? summaries.filter((o) => o.queryable) : summaries
}

/**
 * Return record type infos for a Salesforce object.
 * Reuses the describe cache.
 */
export async function getRecordTypes(
  projectId: string,
  objectName: string,
): Promise<RecordTypeInfo[]> {
  const metadata = await describeObject(projectId, objectName)
  return metadata.recordTypeInfos
}

/**
 * Fetch the set of field API names that appear on a page layout for an object.
 * Uses the JSForce Metadata API (conn.metadata.list + conn.metadata.read).
 * Returns null if layouts cannot be fetched (caller should fall back to schema fields).
 *
 * @param preferredRecordTypeName — when provided, try to find the layout assigned to
 *   that specific record type (e.g. 'Damage'). Salesforce names RT layouts as
 *   'ObjectName-<RecordTypeName> Layout' or similar. Falls back to first layout if
 *   no RT-specific match is found.
 *
 * Result is cached per (objectName, recordTypeName) with the same TTL as other metadata.
 */
export async function getPageLayoutFields(
  projectId: string,
  objectName: string,
  preferredRecordTypeName?: string,
): Promise<Set<string> | null> {
  const cacheKey = buildCacheKey(
    projectId,
    `${objectName}:layout-fields:${(preferredRecordTypeName ?? 'default').toLowerCase()}`,
  )
  const cached = getCached<string[]>(cacheKey)
  if (cached) {
    log.debug(`[metadata] Layout fields cache hit: ${objectName} (RT: ${preferredRecordTypeName ?? 'default'})`)
    return new Set(cached)
  }

  try {
    const layoutFieldNames = await executeWithRetry(projectId, async (conn) => {
      // List all layouts — filter to this object
      const allLayouts = await (conn as unknown as {
        metadata: {
          list: (types: { type: string }[], apiVersion?: string) => Promise<{ fullName: string }[]>
          read: (type: string, fullNames: string | string[]) => Promise<unknown>
        }
      }).metadata.list([{ type: 'Layout' }])

      const objectLayouts = allLayouts.filter(
        (l) => l.fullName.startsWith(`${objectName}-`),
      )
      if (objectLayouts.length === 0) return null

      // Select the best matching layout for the requested record type.
      // SF names RT layouts as: "ObjectName-<RecordTypeName> Layout"
      // e.g. "Inventory__c-Damage Layout", "Inventory__c-Standard Layout"
      let targetLayout = objectLayouts[0]
      if (preferredRecordTypeName && objectLayouts.length > 1) {
        const rtNorm = preferredRecordTypeName.toLowerCase().replace(/[\s_-]+/g, '')

        // Score each layout: does its name (after the object prefix) contain the RT name?
        const scored = objectLayouts.map((l) => {
          const namePart = l.fullName
            .slice(objectName.length + 1)       // strip "ObjectName-"
            .toLowerCase()
            .replace(/[\s_-]+/g, '')
          let score = 0
          if (namePart === rtNorm)               score = 3  // exact
          else if (namePart.startsWith(rtNorm))  score = 2  // prefix
          else if (namePart.includes(rtNorm))    score = 1  // contains
          return { layout: l, score }
        })

        scored.sort((a, b) => b.score - a.score)
        if (scored[0].score > 0) {
          targetLayout = scored[0].layout
          log.info(`[metadata] RT-specific layout selected: ${targetLayout.fullName} (RT: ${preferredRecordTypeName})`)
        } else {
          log.info(`[metadata] No layout matched RT "${preferredRecordTypeName}" — using first: ${targetLayout.fullName}`)
        }
      }

      // Read the selected layout
      const layoutData = await (conn as unknown as {
        metadata: { read: (type: string, name: string) => Promise<unknown> }
      }).metadata.read('Layout', targetLayout.fullName)

      // Extract field API names from layout sections
      const fieldNames = new Set<string>()
      const layout = layoutData as Record<string, unknown>
      const sections = layout['layoutSections'] as Record<string, unknown>[] | undefined
      if (!sections) return null

      // Extract EDITABLE field API names from layout sections.
      // Each layoutItem has a 'behavior' property:
      //   "Edit"     — user can fill it in (normal field)
      //   "Required" — user must fill it in (enforced by layout)
      //   "Readonly" — displayed for reference only (auto-number, formula, system fields)
      // We EXCLUDE Readonly fields so they never appear in the manifest and the LLM
      // won't try to interact with them (e.g. auto-generated Record Numbers).
      const readonlyFields: string[] = []
      for (const section of sections) {
        const columns = (section['layoutColumns'] ?? []) as Record<string, unknown>[]
        for (const col of columns) {
          const items = (col['layoutItems'] ?? []) as Record<string, unknown>[]
          for (const item of items) {
            const field = item['field']
            const behavior = item['behavior']   // 'Edit' | 'Required' | 'Readonly' | undefined
            if (typeof field !== 'string' || !field) continue

            if (typeof behavior === 'string' && behavior.toLowerCase() === 'readonly') {
              readonlyFields.push(field)
              continue   // skip — display only, not interactable
            }

            fieldNames.add(field)
          }
        }
      }
      if (readonlyFields.length > 0) {
        log.info(`[metadata] Excluded ${readonlyFields.length} Readonly layout fields: ${readonlyFields.join(', ')}`)
      }

      return Array.from(fieldNames)
    })

    if (!layoutFieldNames) return null

    setCached(cacheKey, layoutFieldNames)
    log.info(`[metadata] Fetched ${layoutFieldNames.length} layout fields for ${objectName} (RT: ${preferredRecordTypeName ?? 'default'})`)
    return new Set(layoutFieldNames)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn({ err: msg }, `[metadata] Could not fetch page layout for ${objectName} — will use schema fields`)
    return null
  }
}
