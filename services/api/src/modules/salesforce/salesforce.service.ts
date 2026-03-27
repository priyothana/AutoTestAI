/**
 * Salesforce Module — Service Layer
 *
 * Public interface for Salesforce data access. This is the ONLY file any other
 * module may import for Salesforce functionality (SKILL.md cross-module rule).
 *
 * Architecture:
 *   • MCP session lifecycle is managed via @modelcontextprotocol/sdk Client.
 *     Uses StreamableHTTPClientTransport so the MCP server can run remotely.
 *     When SALESFORCE_MCP_SERVER_URL is unset, the SDK path is skipped.
 *   • jsforce v3 (already in package.json) handles all direct Salesforce REST
 *     API calls. Credentials come from project_integrations via project.service.ts
 *     (never queried directly — cross-module boundary rule).
 *   • All three public metadata functions fall back to Prisma tables
 *     (metadata_normalized, metadata_raw_store) when live calls fail, so
 *     the module stays functional without an active Salesforce session.
 *
 * Cross-module public interface (import ONLY these from other modules):
 *   getObjectMetadata(projectId, objectName)                → ObjectMetadataResponse
 *   getFields(projectId, objectName)                        → FieldsResponse
 *   getPicklistValues(projectId, objectName, fieldName)     → PicklistResponse
 */
import type { Connection as SfConnection } from 'jsforce'
import prisma from '../../shared/db/prisma.js'
import { fernetEncrypt } from '../../shared/encryption/fernet.js'
import { createModuleLogger } from '../../shared/logger/index.js'
import { getIntegrationByProject, getDecryptedTokens } from '../project/project.service.js'
import type {
  McpConnect,
  McpQuery,
  RagGenerate,
  ObjectMetadataResponse,
  FieldsResponse,
  PicklistResponse,
  FieldDescriptor,
  PicklistValue,
} from './salesforce.schema.js'

const log = createModuleLogger('salesforce')

// ─── MCP Session Cache ────────────────────────────────────────────
//
// Lightweight per-project cache: avoids re-initialising the SDK Client
// on every request in the same process lifetime.

interface McpSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any
  connectedAt: Date
}

const mcpSessions = new Map<string, McpSession>()

/**
 * Return (or lazily create) an MCP SDK Client for a project.
 * Returns null when SALESFORCE_MCP_SERVER_URL is not configured.
 */
async function getMcpSession(projectId: string): Promise<McpSession | null> {
  const serverUrl = process.env.SALESFORCE_MCP_SERVER_URL
  if (!serverUrl) return null

  const cached = mcpSessions.get(projectId)
  if (cached) return cached

  try {
    // Dynamic imports keep the module loadable even when the SDK is absent.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    )

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

// ─── jsforce connection helper ─────────────────────────────────────
//
// Uses username+password+security_token (MCP-style login).
// Credentials are fetched via project.service.ts — never from Prisma directly.

async function getSfConnection(projectId: string): Promise<SfConnection> {
  const integration = await getIntegrationByProject(projectId)
  if (!integration || integration.category !== 'salesforce') {
    throw { statusCode: 400, message: 'No Salesforce integration found for this project' }
  }
  if (!integration.mcp_connected) {
    throw {
      statusCode: 400,
      message: 'Salesforce MCP connection not established. Please connect first.',
    }
  }

  const tokens = await getDecryptedTokens(integration.id)
  const { username, password, security_token } = tokens

  if (!username || !password || !security_token) {
    throw { statusCode: 400, message: 'MCP credentials incomplete. Please reconnect via MCP.' }
  }

  const loginUrl =
    integration.salesforce_login_url?.includes('test.salesforce.com')
      ? 'https://test.salesforce.com'
      : 'https://login.salesforce.com'

  // Dynamic import avoids load-time failure when jsforce is not installed
  const { default: jsforce } = await import('jsforce')
  const conn = new jsforce.Connection({ loginUrl })
  await conn.login(username, `${password}${security_token}`)
  return conn
}

// ─── DB fallback helpers ───────────────────────────────────────────

async function _getRawMetadata(projectId: string, apiName: string) {
  return prisma.metadata_raw_store.findFirst({
    where:   { project_id: projectId, api_name: apiName },
    orderBy: { created_at: 'desc' },
  })
}

async function _getNormalizedMetadata(projectId: string, objectName: string) {
  return prisma.metadata_normalized.findFirst({
    where:   { project_id: projectId, object_name: objectName },
    orderBy: { created_at: 'desc' },
  })
}

/** Write-through cache: upsert a raw metadata record after a live describe call. */
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
        data:  { raw_json: rawJson, created_at: new Date() },
      })
    } else {
      await prisma.metadata_raw_store.create({
        data: {
          project_id:    projectId,
          metadata_type: metadataType,
          api_name:      apiName,
          raw_json:      rawJson,
        },
      })
    }
  } catch (err) {
    log.warn({ err }, '[salesforce] Failed to upsert raw metadata cache')
  }
}

// ─── Field / Picklist mapping helpers ─────────────────────────────

function _mapField(raw: Record<string, unknown>): FieldDescriptor {
  return {
    name:      String(raw['name'] ?? ''),
    label:     raw['label'] != null ? String(raw['label']) : null,
    type:      raw['type'] != null ? String(raw['type']) : null,
    length:    typeof raw['length'] === 'number' ? raw['length'] : null,
    required:  typeof raw['nillable'] === 'boolean' ? !raw['nillable'] : null,
    updateable: typeof raw['updateable'] === 'boolean' ? raw['updateable'] : null,
    createable: typeof raw['createable'] === 'boolean' ? raw['createable'] : null,
    picklistValues: Array.isArray(raw['picklistValues'])
      ? (raw['picklistValues'] as Record<string, unknown>[]).map(_mapPicklist)
      : undefined,
  }
}

function _mapPicklist(raw: Record<string, unknown>): PicklistValue {
  return {
    value:        String(raw['value'] ?? raw['label'] ?? ''),
    label:        String(raw['label'] ?? raw['value'] ?? ''),
    active:       typeof raw['active'] === 'boolean' ? raw['active'] : true,
    defaultValue: typeof raw['defaultValue'] === 'boolean' ? raw['defaultValue'] : undefined,
  }
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC API — getObjectMetadata
// ═══════════════════════════════════════════════════════════════════

/**
 * Return full describe metadata for a Salesforce object.
 *
 * Lookup order:
 *  1. Live jsforce describe() call
 *  2. metadata_normalized Prisma table (populated by Python pipeline or syncMetadata)
 *  3. metadata_raw_store
 *
 * @param projectId   UUID of the project whose SF integration to use
 * @param objectName  Salesforce API name, e.g. "Account" or "Invoice__c"
 */
export async function getObjectMetadata(
  projectId: string,
  objectName: string,
): Promise<ObjectMetadataResponse> {
  // 1 — live jsforce call
  try {
    const conn     = await getSfConnection(projectId)
    const describe = await conn.describe(objectName)
    const raw      = describe as unknown as Record<string, unknown>

    // Write-through cache
    await _upsertRaw(projectId, 'object', objectName, raw)

    return {
      object_name: objectName,
      label:       (raw['label'] as string) ?? null,
      entity_type: 'object',
      metadata:    raw,
      project_id:  projectId,
    }
  } catch (liveErr: unknown) {
    const msg = liveErr instanceof Error ? liveErr.message : String(liveErr)
    log.warn({ err: msg }, `[salesforce] Live describe failed for ${objectName} — falling back to DB`)
  }

  // 2 — metadata_normalized
  const normalized = await _getNormalizedMetadata(projectId, objectName)
  if (normalized) {
    return {
      object_name: normalized.object_name,
      label:       normalized.label ?? null,
      entity_type: normalized.entity_type,
      metadata:    (normalized.structured_json ?? {}) as Record<string, unknown>,
      project_id:  projectId,
    }
  }

  // 3 — metadata_raw_store
  const raw = await _getRawMetadata(projectId, objectName)
  if (raw) {
    const rawJson = (raw.raw_json ?? {}) as Record<string, unknown>
    return {
      object_name: objectName,
      label:       (rawJson['label'] as string) ?? null,
      entity_type: raw.metadata_type,
      metadata:    rawJson,
      project_id:  projectId,
    }
  }

  throw { statusCode: 404, message: `No metadata found for object '${objectName}'` }
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC API — getFields
// ═══════════════════════════════════════════════════════════════════

/**
 * Return field descriptors for a Salesforce object.
 *
 * Lookup order:
 *  1. Live jsforce describe().fields
 *  2. metadata_raw_store field records (api_name like "Account.Name")
 *  3. Parent object raw record's embedded fields array
 */
export async function getFields(
  projectId: string,
  objectName: string,
): Promise<FieldsResponse> {
  // 1 — live jsforce call
  try {
    const conn     = await getSfConnection(projectId)
    const describe = await conn.describe(objectName)
    const fields   = ((describe as unknown as Record<string, unknown>)['fields'] ?? []) as Record<string, unknown>[]

    // Cache the full describe
    await _upsertRaw(projectId, 'object', objectName, describe as unknown as Record<string, unknown>)

    return {
      object_name: objectName,
      project_id:  projectId,
      fields:      fields.map(_mapField),
    }
  } catch (liveErr: unknown) {
    const msg = liveErr instanceof Error ? liveErr.message : String(liveErr)
    log.warn({ err: msg }, `[salesforce] Live fields call failed for ${objectName} — falling back to DB`)
  }

  // 2 — field records in metadata_raw_store
  const rawFields = await prisma.metadata_raw_store.findMany({
    where: {
      project_id:    projectId,
      metadata_type: 'field',
      api_name:      { startsWith: `${objectName}.` },
    },
    orderBy: { api_name: 'asc' },
  })

  if (rawFields.length > 0) {
    return {
      object_name: objectName,
      project_id:  projectId,
      fields: rawFields.map((r) => {
        const j = (r.raw_json ?? {}) as Record<string, unknown>
        // api_name is "Account.Name" — extract the field name part
        const fieldName = r.api_name.includes('.') ? r.api_name.split('.').pop()! : r.api_name
        return _mapField({ name: fieldName, ...j })
      }),
    }
  }

  // 3 — embedded fields in parent object raw record
  const objRaw = await _getRawMetadata(projectId, objectName)
  if (objRaw) {
    const j      = (objRaw.raw_json ?? {}) as Record<string, unknown>
    const fields = (j['fields'] ?? []) as Record<string, unknown>[]
    return { object_name: objectName, project_id: projectId, fields: fields.map(_mapField) }
  }

  throw { statusCode: 404, message: `No field data found for object '${objectName}'` }
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC API — getPicklistValues
// ═══════════════════════════════════════════════════════════════════

/**
 * Return active (and inactive) picklist values for a specific field.
 *
 * Lookup order:
 *  1. Live jsforce describe().fields[fieldName].picklistValues
 *  2. metadata_raw_store field record (api_name = "ObjectName.FieldName")
 *  3. Parent object raw record's embedded field descriptor
 */
export async function getPicklistValues(
  projectId: string,
  objectName: string,
  fieldName: string,
): Promise<PicklistResponse> {
  const fieldNameLower = fieldName.toLowerCase()

  // 1 — live jsforce call
  try {
    const conn     = await getSfConnection(projectId)
    const describe = await conn.describe(objectName)
    const fields   = ((describe as unknown as Record<string, unknown>)['fields'] ?? []) as Record<string, unknown>[]
    const field    = fields.find(
      (f) => String(f['name'] ?? '').toLowerCase() === fieldNameLower,
    )

    if (!field) {
      throw { statusCode: 404, message: `Field '${fieldName}' not found on '${objectName}'` }
    }

    const plv = (field['picklistValues'] ?? []) as Record<string, unknown>[]
    return {
      object_name: objectName,
      field_name:  fieldName,
      project_id:  projectId,
      values:      plv.map(_mapPicklist),
    }
  } catch (liveErr: unknown) {
    // Propagate real 404s (field not found on object)
    if (typeof liveErr === 'object' && liveErr !== null && (liveErr as { statusCode?: number }).statusCode === 404) {
      throw liveErr
    }
    const msg = liveErr instanceof Error ? liveErr.message : String(liveErr)
    log.warn(
      { err: msg },
      `[salesforce] Live picklist call failed for ${objectName}.${fieldName} — falling back to DB`,
    )
  }

  // 2 — field record in metadata_raw_store
  const rawField = await prisma.metadata_raw_store.findFirst({
    where: {
      project_id:    projectId,
      metadata_type: 'field',
      api_name:      `${objectName}.${fieldName}`,
    },
  })

  if (rawField) {
    const j   = (rawField.raw_json ?? {}) as Record<string, unknown>
    const plv = (j['picklistValues'] ?? []) as Record<string, unknown>[]
    return {
      object_name: objectName,
      field_name:  fieldName,
      project_id:  projectId,
      values:      plv.map(_mapPicklist),
    }
  }

  // 3 — embedded in parent object raw record
  const objRaw = await _getRawMetadata(projectId, objectName)
  if (objRaw) {
    const j      = (objRaw.raw_json ?? {}) as Record<string, unknown>
    const fields = (j['fields'] ?? []) as Record<string, unknown>[]
    const field  = fields.find(
      (f) => String(f['name'] ?? '').toLowerCase() === fieldNameLower,
    )
    if (field) {
      const plv = (field['picklistValues'] ?? []) as Record<string, unknown>[]
      return {
        object_name: objectName,
        field_name:  fieldName,
        project_id:  projectId,
        values:      plv.map(_mapPicklist),
      }
    }
  }

  throw {
    statusCode: 404,
    message: `No picklist data found for field '${objectName}.${fieldName}'`,
  }
}

// ═══════════════════════════════════════════════════════════════════
// MCP Connection
// ═══════════════════════════════════════════════════════════════════

export async function mcpConnect(projectId: string, data: McpConnect): Promise<{
  status: string
  category: string
  connection_type: string
  instance_url: string
  org_id: string
  message: string
}> {
  log.info(`[MCP] Connecting project ${projectId}`)

  // Validate credentials before storing — fail fast with a clear 400
  let instanceUrl = ''
  let orgId       = ''
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
    orgId       = (info as unknown as { organizationId?: string }).organizationId ?? ''
    log.info(`[MCP] Credential validation OK — instanceUrl=${instanceUrl}`)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw { statusCode: 400, message: `Salesforce login failed: ${msg}` }
  }

  const encUsername = fernetEncrypt(data.sf_username)
  const encPassword = fernetEncrypt(data.sf_password)
  const encToken    = fernetEncrypt(data.sf_security_token)
  const loginUrl    =
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
        category:             'salesforce',
        status:               'connected',
        username:             encUsername,
        password:             encPassword,
        security_token:       encToken,
        mcp_connected:        true,
        salesforce_login_url: loginUrl,
        instance_url:         instanceUrl,
        org_id:               orgId || null,
      },
    })
  } else {
    await prisma.project_integrations.create({
      data: {
        project_id:           projectId,
        category:             'salesforce',
        status:               'connected',
        username:             encUsername,
        password:             encPassword,
        security_token:       encToken,
        mcp_connected:        true,
        salesforce_login_url: loginUrl,
        instance_url:         instanceUrl,
        org_id:               orgId || null,
      },
    })
  }

  // Reset any stale MCP SDK session
  await closeMcpSession(projectId)

  return {
    status:          'connected',
    category:        'salesforce',
    connection_type: 'mcp',
    instance_url:    instanceUrl,
    org_id:          orgId,
    message:         'Salesforce MCP connection established successfully',
  }
}

// ═══════════════════════════════════════════════════════════════════
// MCP SOQL Query
// ═══════════════════════════════════════════════════════════════════

export async function mcpQuery(projectId: string, data: McpQuery) {
  log.info(`[MCP] Query for project ${projectId}`)
  try {
    const conn = await getSfConnection(projectId)
    // jsforce v3: query() returns a Query object that is also a Promise
    if (data.include_deleted) {
      // queryAll is not in the v3 type definitions — use query with ALL_ROWS option
      const result = await (conn as unknown as {
        queryAll: (soql: string) => Promise<unknown>
      }).queryAll(data.query).catch(() =>
        // Fallback: standard query if queryAll not available at runtime
        conn.query(data.query),
      )
      return result
    }
    return conn.query(data.query)
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && (err as { statusCode?: number }).statusCode) {
      throw err
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw { statusCode: 500, message: `SOQL query failed: ${msg}` }
  }
}

// ═══════════════════════════════════════════════════════════════════
// MCP Record Operations
// ═══════════════════════════════════════════════════════════════════

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

/** Full metadata sync: Extract → cache raw records in metadata_raw_store */
export async function syncMetadata(projectId: string) {
  log.info(`[METADATA] Sync triggered for project ${projectId}`)

  let rawCount = 0
  try {
    const conn      = await getSfConnection(projectId)
    const global    = await conn.describeGlobal()
    const stdNames  = new Set(['Account', 'Contact', 'Opportunity', 'Lead', 'Case'])
    const targets   = global.sobjects.filter((s) => s.custom || stdNames.has(s.name))

    for (const sobj of targets) {
      try {
        const desc = await conn.describe(sobj.name)
        const raw  = desc as unknown as Record<string, unknown>
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
    log.error({ err }, '[METADATA] Sync extraction failed')
    throw { statusCode: 500, message: `Metadata sync failed: ${msg}` }
  }

  const [normalized, domain, embeddings] = await Promise.all([
    prisma.metadata_normalized.count({ where: { project_id: projectId } }),
    prisma.domain_models.count({ where: { project_id: projectId } }),
    prisma.vector_embeddings.count({ where: { project_id: projectId } }),
  ])

  return {
    status:             'completed',
    message:            'Metadata sync completed',
    raw_count:          rawCount,
    normalized_count:   normalized,
    domain_model_count: domain,
    embedding_count:    embeddings,
  }
}

// ═══════════════════════════════════════════════════════════════════
// Salesforce Connections (legacy routes from Python salesforce.py)
// ═══════════════════════════════════════════════════════════════════

export async function createConnection(data: {
  project_id:    string
  instance_url:  string
  access_token:  string
  refresh_token?: string
  org_name?:      string
}) {
  return prisma.salesforce_connections.create({
    data: {
      project_id:    data.project_id,
      instance_url:  data.instance_url,
      access_token:  fernetEncrypt(data.access_token),
      refresh_token: data.refresh_token ? fernetEncrypt(data.refresh_token) : null,
      org_name:      data.org_name ?? null,
    },
  })
}

export async function getConnections(projectId: string) {
  return prisma.salesforce_connections.findMany({
    where: { project_id: projectId },
  })
}

export async function deleteConnection(connectionId: string) {
  return prisma.salesforce_connections.delete({ where: { id: connectionId } })
}

// ═══════════════════════════════════════════════════════════════════
// RAG Generate (stub — full impl in test-generation module, Phase 5)
// ═══════════════════════════════════════════════════════════════════

export async function ragGenerate(data: RagGenerate) {
  log.info(`[RAG] Generate request for project ${data.project_id}`)
  return {
    name:             `Test: ${data.prompt.substring(0, 40)}`,
    description:      data.prompt,
    steps:            [] as unknown[],
    priority:         'medium',
    preconditions:    [] as unknown[],
    expected_outcome: '',
    rag_context_used: false,
    retrieved_chunks: [] as unknown[],
    model_provider:   data.provider ?? 'claude',
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
    where:   { project_id: projectId },
    orderBy: { created_at: 'desc' },
    select:  { created_at: true },
  })

  return {
    project_id:         projectId,
    has_metadata:       raw > 0,
    raw_count:          raw,
    normalized_count:   normalized,
    domain_model_count: domain,
    embedding_count:    embeddings,
    last_extracted_at:  lastRaw?.created_at?.toISOString() ?? null,
  }
}
