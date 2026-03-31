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
