/**
 * Salesforce Module — Service Layer (Public Interface)
 *
 * This is the ONLY file any other module may import for Salesforce
 * functionality (SKILL.md cross-module rule).
 *
 * Architecture:
 *   • lib/sf-connection.ts — JSforce connection pool
 *   • lib/sf-metadata.ts   — metadata fetch + in-process cache
 *   • lib/sf-dependent-picklist.ts — bitmap-based dependent picklist resolution
 *
 * The Python :8001 HTTP proxy has been fully REMOVED.
 * All metadata functions now call lib/ directly via JSforce.
 *
 * Public interface (other modules import ONLY these):
 *   getObjectMetadata(projectId, objectName)
 *   getFields(projectId, objectName)
 *   getPicklistValues(projectId, objectName, fieldName)
 *   getDependentPicklistValues(projectId, objectName, controller, dependent)
 *   listObjects(projectId)
 *   getRecordTypes(projectId, objectName)
 *
 * Legacy public interface (existing callers unchanged):
 *   mcpConnect, mcpQuery, mcpGetRecord, mcpCreateRecord,
 *   mcpUpdateRecord, mcpDeleteRecord, mcpDescribe, mcpSearch,
 *   mcpLimits, syncMetadata, createConnection, getConnections,
 *   deleteConnection, ragGenerate, getMetadataStatus
 */
import prisma from '../../shared/db/prisma.js'
import { fernetEncrypt } from '../../shared/encryption/fernet.js'
import { createModuleLogger } from '../../shared/logger/index.js'
import { getIntegrationByProject, getDecryptedTokens } from '../project/project.service.js'

// ─── lib/ imports ─────────────────────────────────────────────────
import * as sfMetadata from './lib/sf-metadata.js'
import { getDependentPicklistValues as _getDependentPicklistValues } from './lib/sf-dependent-picklist.js'
import { executeWithRetry, wrapJsforceError } from './lib/sf-connection.js'
import { SalesforceError } from './lib/sf-types.js'

// ─── Schema types (keep existing imports for MCP shapes) ──────────
import type {
  McpConnect,
  McpQuery,
  RagGenerate,
  ObjectMetadataResponse,
  FieldsResponse,
  PicklistResponse,
  FieldDescriptor,
  PicklistValue as SchemaPicklistValue,
} from './salesforce.schema.js'

// ─── New lib types (public re-exports for callers that need types) ─
export type {
  ObjectMetadata,
  FieldMetadata,
  GlobalObjectSummary,
  RecordTypeInfo,
  DependentPicklistMap,
} from './lib/sf-types.js'

const log = createModuleLogger('salesforce')

// ═══════════════════════════════════════════════════════════════════
// NEW: JSforce-based public API (replaces Python :8001 proxy)
// ═══════════════════════════════════════════════════════════════════

/**
 * Return full describe metadata for a Salesforce object.
 * Lookup order: JSforce live call (cached 10 min) → DB fallback
 */
export async function getObjectMetadata(
  projectId: string,
  objectName: string,
): Promise<ObjectMetadataResponse> {
  // 1 — live JSforce call (via lib/sf-metadata)
  try {
    const meta = await sfMetadata.describeObject(projectId, objectName)

    // Write-through: upsert raw into DB cache for offline fallback
    await _upsertRaw(projectId, 'object', objectName, meta as unknown as Record<string, unknown>)

    return {
      object_name: objectName,
      label: meta.label ?? null,
      entity_type: 'object',
      metadata: meta as unknown as Record<string, unknown>,
      project_id: projectId,
    }
  } catch (liveErr: unknown) {
    // fall through so the DB fallback can serve cached data.
    if (
      liveErr instanceof SalesforceError &&
      liveErr.statusCode === 400 &&
      liveErr.errorCode !== 'NO_INTEGRATION' &&
      liveErr.errorCode !== 'INVALID_LOGIN' &&
      !liveErr.message.includes('INVALID_LOGIN')
    ) throw liveErr
    const msg = liveErr instanceof Error ? liveErr.message : String(liveErr)
    log.warn({ err: msg }, `[salesforce] Live describe failed for ${objectName} — DB fallback`)
  }

  // 2 — metadata_normalized
  const normalized = await _getNormalizedMetadata(projectId, objectName)
  if (normalized) {
    return {
      object_name: normalized.object_name,
      label: normalized.label ?? null,
      entity_type: normalized.entity_type,
      metadata: (normalized.structured_json ?? {}) as Record<string, unknown>,
      project_id: projectId,
    }
  }

  // 3 — metadata_raw_store
  const raw = await _getRawMetadata(projectId, objectName)
  if (raw) {
    const rawJson = (raw.raw_json ?? {}) as Record<string, unknown>
    return {
      object_name: objectName,
      label: (rawJson['label'] as string) ?? null,
      entity_type: raw.metadata_type,
      metadata: rawJson,
      project_id: projectId,
    }
  }

  throw { statusCode: 404, message: `No metadata found for object '${objectName}'` }
}

/**
 * Return field descriptors for a Salesforce object.
 * Uses JSforce via lib/sf-metadata (cached).
 */
export async function getFields(
  projectId: string,
  objectName: string,
): Promise<FieldsResponse> {
  try {
    const fields = await sfMetadata.getFields(projectId, objectName)

    // Cache the parent object raw for offline fallback
    const meta = await sfMetadata.describeObject(projectId, objectName)
    await _upsertRaw(projectId, 'object', objectName, meta as unknown as Record<string, unknown>)

    return {
      object_name: objectName,
      project_id: projectId,
      fields: fields.map(_mapToSchemaField),
    }
  } catch (liveErr: unknown) {
    // Allow NO_INTEGRATION and INVALID_LOGIN to fall through so DB caches can serve the response
    if (
      liveErr instanceof SalesforceError &&
      liveErr.statusCode === 400 &&
      liveErr.errorCode !== 'NO_INTEGRATION' &&
      liveErr.errorCode !== 'INVALID_LOGIN' &&
      !liveErr.message.includes('INVALID_LOGIN')
    ) throw liveErr
    const msg = liveErr instanceof Error ? liveErr.message : String(liveErr)
    log.warn({ err: msg }, `[salesforce] Live fields failed for ${objectName} — DB fallback`)
  }

  // DB fallback: field records in metadata_raw_store
  const rawFields = await prisma.metadata_raw_store.findMany({
    where: {
      project_id: projectId,
      metadata_type: 'field',
      api_name: { startsWith: `${objectName}.` },
    },
    orderBy: { api_name: 'asc' },
  })

  if (rawFields.length > 0) {
    return {
      object_name: objectName,
      project_id: projectId,
      fields: rawFields.map((r) => {
        const j = (r.raw_json ?? {}) as Record<string, unknown>
        const fieldName = r.api_name.includes('.') ? r.api_name.split('.').pop()! : r.api_name
        return _mapRawField({ name: fieldName, ...j })
      }),
    }
  }

  // Embedded in parent object raw record
  const objRaw = await _getRawMetadata(projectId, objectName)
  if (objRaw) {
    const j = (objRaw.raw_json ?? {}) as Record<string, unknown>
    const fields = (j['fields'] ?? []) as Record<string, unknown>[]
    return { object_name: objectName, project_id: projectId, fields: fields.map(_mapRawField) }
  }

  throw { statusCode: 404, message: `No field data found for object '${objectName}'` }
}

/**
 * Return picklist values for a specific field on an object.
 * Uses JSforce via lib/sf-metadata (cached).
 */
export async function getPicklistValues(
  projectId: string,
  objectName: string,
  fieldName: string,
): Promise<PicklistResponse> {
  try {
    const values = await sfMetadata.getPicklistValues(projectId, objectName, fieldName)
    return {
      object_name: objectName,
      field_name: fieldName,
      project_id: projectId,
      values: values.map((v) => ({
        value: v.value,
        label: v.label,
        active: v.active,
        defaultValue: v.defaultValue,
      })),
    }
  } catch (liveErr: unknown) {
    if (liveErr instanceof SalesforceError && liveErr.statusCode === 404) throw liveErr
    // Allow NO_INTEGRATION and INVALID_LOGIN to fall through so DB caches can serve the response
    if (
      liveErr instanceof SalesforceError &&
      liveErr.statusCode === 400 &&
      liveErr.errorCode !== 'NO_INTEGRATION' &&
      liveErr.errorCode !== 'INVALID_LOGIN' &&
      !liveErr.message.includes('INVALID_LOGIN')
    ) throw liveErr
    const msg = liveErr instanceof Error ? liveErr.message : String(liveErr)
    log.warn(
      { err: msg },
      `[salesforce] Live picklist failed for ${objectName}.${fieldName} — DB fallback`,
    )
  }

  const fieldNameLower = fieldName.toLowerCase()

  // DB fallback: field record in metadata_raw_store
  const rawField = await prisma.metadata_raw_store.findFirst({
    where: {
      project_id: projectId,
      metadata_type: 'field',
      api_name: `${objectName}.${fieldName}`,
    },
  })

  if (rawField) {
    const j = (rawField.raw_json ?? {}) as Record<string, unknown>
    const plv = (j['picklistValues'] ?? []) as Record<string, unknown>[]
    return {
      object_name: objectName,
      field_name: fieldName,
      project_id: projectId,
      values: plv.map(_mapSchemaPicklist),
    }
  }

  // Embedded in parent object raw record
  const objRaw = await _getRawMetadata(projectId, objectName)
  if (objRaw) {
    const j = (objRaw.raw_json ?? {}) as Record<string, unknown>
    const fields = (j['fields'] ?? []) as Record<string, unknown>[]
    const field = fields.find((f) => String(f['name'] ?? '').toLowerCase() === fieldNameLower)
    if (field) {
      const plv = (field['picklistValues'] ?? []) as Record<string, unknown>[]
      return {
        object_name: objectName,
        field_name: fieldName,
        project_id: projectId,
        values: plv.map(_mapSchemaPicklist),
      }
    }
  }

  throw {
    statusCode: 404,
    message: `No picklist data found for field '${objectName}.${fieldName}'`,
  }
}

/**
 * Return a structured dependent picklist mapping.
 * This is Gap 1 — new capability not in the old HTTP proxy.
 */
export async function getDependentPicklistValues(
  projectId: string,
  objectName: string,
  controllerFieldName: string,
  dependentFieldName: string,
) {
  try {
    return await _getDependentPicklistValues(
      projectId,
      objectName,
      controllerFieldName,
      dependentFieldName,
    )
  } catch (err: unknown) {
    if (err instanceof SalesforceError) {
      throw { statusCode: err.statusCode, message: err.message }
    }
    throw wrapJsforceError(err, objectName)
  }
}

/**
 * List all queryable Salesforce objects for a project (global describe).
 */
export async function listObjects(projectId: string) {
  try {
    return await sfMetadata.listObjects(projectId)
  } catch (err: unknown) {
    const isOffline = err instanceof SalesforceError && (
      err.errorCode === 'NO_INTEGRATION' || 
      err.errorCode === 'INVALID_LOGIN' || 
      err.message.includes('INVALID_LOGIN')
    );

    if (isOffline) {
      log.warn({ err }, `[salesforce] Live listObjects failed for project ${projectId} — DB fallback`);
      const raw = await prisma.metadata_raw_store.findMany({
        where: { project_id: projectId, metadata_type: 'object' },
        select: { api_name: true, raw_json: true }
      });
      if (raw.length > 0) {
        return raw.map(r => ({
          name: r.api_name,
          label: (r.raw_json as any)?.label ? String((r.raw_json as any).label) : r.api_name,
          queryable: true,
          createable: true,
          updateable: true
        }));
      }
      return [];
    }

    if (err instanceof SalesforceError) {
      throw { statusCode: err.statusCode, message: err.message }
    }
    throw wrapJsforceError(err, undefined)
  }
}

/**
 * Return record type infos for a Salesforce object.
 */
export async function getRecordTypes(projectId: string, objectName: string) {
  try {
    return await sfMetadata.getRecordTypes(projectId, objectName)
  } catch (err: unknown) {
    const isOffline = err instanceof SalesforceError && (
      err.errorCode === 'NO_INTEGRATION' || 
      err.errorCode === 'INVALID_LOGIN' || 
      err.message.includes('INVALID_LOGIN')
    );
    if (isOffline) {
      log.warn({ err }, `[salesforce] Live getRecordTypes failed for ${objectName} — generic fallback`);
      return [];
    }

    if (err instanceof SalesforceError) {
      throw { statusCode: err.statusCode, message: err.message }
    }
    throw wrapJsforceError(err, objectName)
  }
}

// ═══════════════════════════════════════════════════════════════════
// LEGACY: MCP Connection (unchanged public signature)
// ═══════════════════════════════════════════════════════════════════

// MCP session cache (SDK client lifecycle)
interface McpSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any
  connectedAt: Date
}

const mcpSessions = new Map<string, McpSession>()

async function getMcpSession(projectId: string): Promise<McpSession | null> {
  const serverUrl = process.env.SALESFORCE_MCP_SERVER_URL
  if (!serverUrl) return null

  const cached = mcpSessions.get(projectId)
  if (cached) return cached

  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — MCP SDK types may not be installed; dynamic import is intentional
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js') // eslint-disable-line
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — same reason
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js') // eslint-disable-line

    const client = new Client({ name: 'autotest-ai', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${serverUrl}/mcp`)),
    )

    const session: McpSession = { client, connectedAt: new Date() }
    mcpSessions.set(projectId, session)
    log.info(`[MCP] Session opened for project ${projectId}`)
    return session
  } catch (err) {
    log.warn({ err }, '[MCP] Failed to initialise SDK session — using DB fallback')
    return null
  }
}

async function closeMcpSession(projectId: string): Promise<void> {
  const session = mcpSessions.get(projectId)
  if (session) {
    try { await session.client.close?.() } catch { /* ignore */ }
    mcpSessions.delete(projectId)
    log.info(`[MCP] Session closed for project ${projectId}`)
  }
}

// ─── getSfConnection (legacy helper — used by MCP ops + sync) ─────
//
// The lib/sf-connection pool is now the canonical implementation.
// This thin wrapper delegates to executeWithRetry so all existing
// MCP-style callers continue to work without any change.

async function getSfConnection(projectId: string) {
  // Return a proxy object that calls through executeWithRetry for each op.
  // This matches the shape expected by mcpQuery, mcpGetRecord, etc.
  let _conn: import('jsforce').Connection | null = null

  const { getConnection } = await import('./lib/sf-connection.js')
  _conn = await getConnection(projectId)
  return _conn
}

export async function mcpConnect(projectId: string, data: McpConnect): Promise<{
  status: string
  category: string
  connection_type: string
  instance_url: string
  org_id: string
  message: string
}> {
  log.info(`[MCP] Connecting project ${projectId}`)

  let instanceUrl = ''
  let orgId = ''
  try {
    const { default: jsforce } = await import('jsforce')
    const loginUrl =
      data.domain === 'test'
        ? 'https://test.salesforce.com'
        : 'https://login.salesforce.com'

    const conn = new jsforce.Connection({ loginUrl })
    const info = await conn.login(
      data.sf_username,
      `${data.sf_password}${data.sf_security_token}`,
    )
    instanceUrl = conn.instanceUrl ?? ''
    orgId = (info as unknown as { organizationId?: string }).organizationId ?? ''
    log.info(`[MCP] Credential validation OK — instanceUrl=${instanceUrl}`)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw { statusCode: 400, message: `Salesforce login failed: ${msg}` }
  }

  const encUsername = fernetEncrypt(data.sf_username)
  const encPassword = fernetEncrypt(data.sf_password)
  const encToken = fernetEncrypt(data.sf_security_token)
  const loginUrl =
    data.domain === 'test'
      ? 'https://test.salesforce.com'
      : 'https://login.salesforce.com'

  const existing = await prisma.project_integrations.findFirst({
    where: { project_id: projectId },
  })

  if (existing) {
    await prisma.project_integrations.update({
      where: { id: existing.id },
      data: {
        category: 'salesforce',
        status: 'connected',
        username: encUsername,
        password: encPassword,
        security_token: encToken,
        mcp_connected: true,
        salesforce_login_url: loginUrl,
        instance_url: instanceUrl,
        org_id: orgId || null,
      },
    })
  } else {
    await prisma.project_integrations.create({
      data: {
        project_id: projectId,
        category: 'salesforce',
        status: 'connected',
        username: encUsername,
        password: encPassword,
        security_token: encToken,
        mcp_connected: true,
        salesforce_login_url: loginUrl,
        instance_url: instanceUrl,
        org_id: orgId || null,
      },
    })
  }

  // Invalidate the connection pool so next access re-authenticates
  const { invalidateConnection } = await import('./lib/sf-connection.js')
  invalidateConnection(projectId)
  await closeMcpSession(projectId)

  return {
    status: 'connected',
    category: 'salesforce',
    connection_type: 'mcp',
    instance_url: instanceUrl,
    org_id: orgId,
    message: 'Salesforce MCP connection established successfully',
  }
}

export async function mcpQuery(projectId: string, data: McpQuery) {
  log.info(`[MCP] Query for project ${projectId}`)
  try {
    const conn = await getSfConnection(projectId)
    if (data.include_deleted) {
      const result = await (conn as unknown as {
        queryAll: (soql: string) => Promise<unknown>
      }).queryAll(data.query).catch(() => conn.query(data.query))
      return result
    }
    return await conn.query(data.query)
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && (err as { statusCode?: number }).statusCode) {
      throw err
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw { statusCode: 500, message: `SOQL query failed: ${msg}` }
  }
}

export async function mcpGetRecord(projectId: string, objectName: string, recordId: string) {
  const conn = await getSfConnection(projectId)
  return conn.retrieve(objectName as never, recordId)
}

export async function mcpCreateRecord(
  projectId: string,
  objectName: string,
  data: Record<string, unknown>,
) {
  const conn = await getSfConnection(projectId)
  return conn.create(objectName as never, data as never)
}

export async function mcpUpdateRecord(
  projectId: string,
  objectName: string,
  recordId: string,
  data: Record<string, unknown>,
) {
  const conn = await getSfConnection(projectId)
  return conn.update(objectName as never, { Id: recordId, ...data } as never)
}

export async function mcpDeleteRecord(projectId: string, objectName: string, recordId: string) {
  const conn = await getSfConnection(projectId)
  return conn.destroy(objectName as never, recordId)
}

export async function mcpDescribe(projectId: string, objectName: string) {
  const conn = await getSfConnection(projectId)
  return conn.describe(objectName)
}

export async function mcpSearch(projectId: string, searchQuery: string) {
  const conn = await getSfConnection(projectId)
  return conn.search(searchQuery)
}

export async function mcpLimits(projectId: string) {
  const conn = await getSfConnection(projectId)
  return conn.limits()
}

// ═══════════════════════════════════════════════════════════════════
// Metadata Sync
// ═══════════════════════════════════════════════════════════════════

/**
 * Stage 1 of the metadata pipeline: JSforce raw extraction only.
 * Exported so metadata-sync.worker.ts can call it directly.
 * Returns the count of object-level records upserted.
 */
export async function syncMetadataRaw(projectId: string): Promise<number> {
  log.info(`[METADATA] Raw extraction started for project ${projectId}`)

  let rawCount = 0
  try {
    const conn = await getSfConnection(projectId)
    const global = await conn.describeGlobal()
    const stdNames = new Set(['Account', 'Contact', 'Opportunity', 'Lead', 'Case'])
    const targets = global.sobjects.filter((s) => s.custom || stdNames.has(s.name))

    for (const sobj of targets) {
      try {
        const desc = await conn.describe(sobj.name)
        const raw = desc as unknown as Record<string, unknown>
        await _upsertRaw(projectId, 'object', sobj.name, raw)
        rawCount++

        const fields = (raw['fields'] ?? []) as Record<string, unknown>[]
        for (const field of fields) {
          await _upsertRaw(
            projectId,
            'field',
            `${sobj.name}.${String(field['name'])}`,
            field,
          )
        }
      } catch (innerErr) {
        log.warn({ err: innerErr }, `[METADATA] Failed to describe ${sobj.name}`)
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error({ err }, '[METADATA] Raw extraction failed')
    throw new Error(`Metadata extraction failed: ${msg}`)
  }

  // Invalidate describe cache so next live call re-fetches from Salesforce
  const { invalidateDescribeCache } = await import('./lib/sf-metadata.js')
  invalidateDescribeCache(projectId)

  log.info(`[METADATA] Raw extraction done — ${rawCount} objects upserted`)
  return rawCount
}

/**
 * Public sync endpoint handler.
 *
 * Enqueues a MetadataSyncJob on the metadata-sync-queue and returns
 * immediately with status='queued'. The BullMQ worker runs the full
 * 4-stage pipeline in the background (raw → normalize → domain → embed).
 *
 * The frontend's fetchIntegration() re-fetches integration-status after
 * the sync call, and the tile counts will refresh once the worker finishes.
 */
export async function syncMetadata(projectId: string) {
  log.info(`[METADATA] Sync queued for project ${projectId}`)

  try {
    // Lazy import to avoid circular dependency at module load time
    const { metadataSyncQueue } = await import('../../workers/metadata-sync.worker.js')

    await metadataSyncQueue.add(
      'sync',
      { projectId, triggeredBy: 'manual' },
      {
        attempts: 2,
        backoff: { type: 'fixed', delay: 5000 },
        removeOnComplete: { count: 10 },
        removeOnFail:     { count: 20 },
      },
    )
  } catch (queueErr: unknown) {
    // If Redis/BullMQ is unavailable, fall back to a synchronous in-process run
    // so the sync still works in environments without Redis configured.
    log.warn({ err: queueErr }, '[METADATA] Queue unavailable — running pipeline inline')
    try {
      const { normalizeMetadata }  = await import('./salesforce.normalizer.js')
      const { buildDomainModels }  = await import('./salesforce.domain-builder.js')
      const { generateEmbeddings } = await import('./salesforce.embeddings.js')

      const rawCount        = await syncMetadataRaw(projectId)
      const normalizedCount = await normalizeMetadata(projectId)
      const domainCount     = await buildDomainModels(projectId)
      const embeddingCount  = await generateEmbeddings(projectId)

      await prisma.project_integrations.updateMany({
        where: { project_id: projectId },
        data:  { last_synced_at: new Date(), sync_error: null },
      })

      return {
        status: 'completed',
        message: 'Metadata sync completed (inline fallback)',
        raw_count:          rawCount,
        normalized_count:   normalizedCount,
        domain_model_count: domainCount,
        embedding_count:    embeddingCount,
      }
    } catch (inlineErr: unknown) {
      const msg = inlineErr instanceof Error ? inlineErr.message : String(inlineErr)
      throw { statusCode: 500, message: `Metadata sync failed: ${msg}` }
    }
  }

  // Return current DB counts (worker will update them asynchronously)
  const [raw, normalized, domain, embeddings] = await Promise.all([
    prisma.metadata_raw_store.count({ where: { project_id: projectId } }),
    prisma.metadata_normalized.count({ where: { project_id: projectId } }),
    prisma.domain_models.count({ where: { project_id: projectId } }),
    prisma.vector_embeddings.count({ where: { project_id: projectId } }),
  ])

  return {
    status: 'queued',
    message: 'Metadata sync queued — pipeline running in background',
    raw_count:          raw,
    normalized_count:   normalized,
    domain_model_count: domain,
    embedding_count:    embeddings,
  }
}

// ═══════════════════════════════════════════════════════════════════
// Salesforce Connections (legacy routes from Python salesforce.py)
// ═══════════════════════════════════════════════════════════════════

export async function createConnection(data: {
  project_id: string
  instance_url: string
  access_token: string
  refresh_token?: string
  org_name?: string
}) {
  return prisma.salesforce_connections.create({
    data: {
      project_id: data.project_id,
      instance_url: data.instance_url,
      access_token: fernetEncrypt(data.access_token),
      refresh_token: data.refresh_token ? fernetEncrypt(data.refresh_token) : null,
      org_name: data.org_name ?? null,
    },
  })
}

export async function getConnections(projectId: string) {
  // Python's /connections/:projectId returns the project_integrations record
  // (category=salesforce), not the oauth salesforce_connections table.
  // We map org_id → org_name to match the legacy Python API contract exactly.
  const integrations = await prisma.project_integrations.findMany({
    where: { project_id: projectId, category: 'salesforce' },
    select: {
      id:           true,
      project_id:   true,
      instance_url: true,
      org_id:       true,
      created_at:   true,
    },
  })

  return integrations.map((intg) => ({
    id:           intg.id,
    project_id:   intg.project_id,
    instance_url: intg.instance_url ?? null,
    org_name:     intg.org_id ?? null,   // Python exposes org_id as org_name
    created_at:   intg.created_at,
  }))
}

export async function deleteConnection(connectionId: string) {
  return prisma.salesforce_connections.delete({ where: { id: connectionId } })
}

// ═══════════════════════════════════════════════════════════════════
// RAG Generate (stub — full implementation in test-generation module)
// ═══════════════════════════════════════════════════════════════════

export async function ragGenerate(data: RagGenerate) {
  log.info(`[RAG] Generate request for project ${data.project_id}`)
  return {
    name: `Test: ${data.prompt.substring(0, 40)}`,
    description: data.prompt,
    steps: [] as unknown[],
    priority: 'medium',
    preconditions: [] as unknown[],
    expected_outcome: '',
    rag_context_used: false,
    retrieved_chunks: [] as unknown[],
    model_provider: data.provider ?? 'claude',
  }
}

// ═══════════════════════════════════════════════════════════════════
// Metadata Status
// ═══════════════════════════════════════════════════════════════════

export async function getMetadataStatus(projectId: string) {
  const [raw, normalized, domain, embeddings] = await Promise.all([
    prisma.metadata_raw_store.count({ where: { project_id: projectId } }),
    prisma.metadata_normalized.count({ where: { project_id: projectId } }),
    prisma.domain_models.count({ where: { project_id: projectId } }),
    prisma.vector_embeddings.count({ where: { project_id: projectId } }),
  ])

  const lastRaw = await prisma.metadata_raw_store.findFirst({
    where: { project_id: projectId },
    orderBy: { created_at: 'desc' },
    select: { created_at: true },
  })

  return {
    project_id: projectId,
    has_metadata: raw > 0,
    raw_count: raw,
    normalized_count: normalized,
    domain_model_count: domain,
    embedding_count: embeddings,
    last_extracted_at: lastRaw?.created_at?.toISOString() ?? null,
  }
}

// ═══════════════════════════════════════════════════════════════════
// Private DB helpers (unchanged — used by fallback paths above)
// ═══════════════════════════════════════════════════════════════════

async function _getRawMetadata(projectId: string, apiName: string) {
  return prisma.metadata_raw_store.findFirst({
    where: { project_id: projectId, api_name: apiName },
    orderBy: { created_at: 'desc' },
  })
}

async function _getNormalizedMetadata(projectId: string, objectName: string) {
  return prisma.metadata_normalized.findFirst({
    where: { project_id: projectId, object_name: objectName },
    orderBy: { created_at: 'desc' },
  })
}

async function _upsertRaw(
  projectId: string,
  metadataType: string,
  apiName: string,
  rawJson: Record<string, unknown>,
): Promise<void> {
  try {
    const existing = await prisma.metadata_raw_store.findFirst({
      where: { project_id: projectId, metadata_type: metadataType, api_name: apiName },
    })
    if (existing) {
      await prisma.metadata_raw_store.update({
        where: { id: existing.id },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { raw_json: rawJson as any, created_at: new Date() },
      })
    } else {
      await prisma.metadata_raw_store.create({
        data: {
          project_id: projectId,
          metadata_type: metadataType,
          api_name: apiName,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          raw_json: rawJson as any,
        },
      })
    }
  } catch (err) {
    log.warn({ err }, '[salesforce] Failed to upsert raw metadata cache')
  }
}

// ─── Field mapping helpers (for DB fallback paths) ────────────────

function _mapToSchemaField(f: import('./lib/sf-types.js').FieldMetadata): FieldDescriptor {
  return {
    name: f.name,
    label: f.label ?? null,
    type: f.type ?? null,
    length: f.length ?? null,
    required: f.required ?? null,
    updateable: f.updateable ?? null,
    createable: f.createable ?? null,
    picklistValues: f.picklistValues.map((v) => ({
      value: v.value,
      label: v.label,
      active: v.active,
    })),
  }
}

function _mapRawField(raw: Record<string, unknown>): FieldDescriptor {
  return {
    name: String(raw['name'] ?? ''),
    label: raw['label'] != null ? String(raw['label']) : null,
    type: raw['type'] != null ? String(raw['type']) : null,
    length: typeof raw['length'] === 'number' ? raw['length'] : null,
    required: typeof raw['nillable'] === 'boolean' ? !raw['nillable'] : null,
    updateable: typeof raw['updateable'] === 'boolean' ? raw['updateable'] : null,
    createable: typeof raw['createable'] === 'boolean' ? raw['createable'] : null,
    picklistValues: Array.isArray(raw['picklistValues'])
      ? (raw['picklistValues'] as Record<string, unknown>[]).map(_mapSchemaPicklist)
      : undefined,
  }
}

function _mapSchemaPicklist(raw: Record<string, unknown>): SchemaPicklistValue {
  return {
    value: String(raw['value'] ?? raw['label'] ?? ''),
    label: String(raw['label'] ?? raw['value'] ?? ''),
    active: typeof raw['active'] === 'boolean' ? raw['active'] : true,
    defaultValue: typeof raw['defaultValue'] === 'boolean' ? raw['defaultValue'] : undefined,
  }
}
