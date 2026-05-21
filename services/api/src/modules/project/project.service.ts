/**
 * Project Module — Service Layer
 *
 * Public interface for the project module.
 * All other modules that need project/credential data MUST import from here.
 * NEVER import project.routes.ts or project.schema.ts from another module.
 *
 * Port of Python: projects.py + integrations.py + jira.py
 * Owns Prisma models: projects, users, integrations, project_integrations
 */
import prisma from '../../shared/db/prisma.js'
import { fernetEncrypt, fernetDecrypt } from '../../shared/encryption/fernet.js'
import { createModuleLogger } from '../../shared/logger/index.js'
import type {
  ProjectCreate,
  ProjectUpdate,
  SalesforceCredentials,
  JiraConnect,
  JiraProjectConfig,
  KeycloakToken,
} from './project.schema.js'

const log = createModuleLogger('project')

// ─── Project CRUD ────────────────────────────────────────────────

/**
 * Create a new project. Optionally auto-creates a web_app integration
 * when login credentials are provided at the same time.
 */
export async function createProject(data: ProjectCreate) {
  const project = await prisma.projects.create({
    data: {
      name: data.name,
      description: data.description ?? null,
      type: data.type,
      category: data.category ?? 'webapp',
      base_url: data.base_url ?? null,
      status: data.status ?? 'Active',
      tags: data.tags ?? [],
      members: [],
    },
  })

  // Auto-save webapp credentials when provided inline with project creation
  if (data.base_url && (data.login_username || data.login_password)) {
    try {
      await createWebIntegration(
        project.id,
        data.login_url ?? data.base_url,
        data.login_username ?? null,
        data.login_password ?? null,
        data.login_strategy ?? 'form',
      )
    } catch (err) {
      log.warn({ err }, 'Failed to save web credentials during project creation')
    }
  }

  return project
}

/**
 * List projects with optional pagination, search, and filters.
 */
export async function listProjects(params: {
  skip?: number
  limit?: number
  search?: string
  status?: string
  type?: string
}) {
  const { skip = 0, limit = 10, search, status, type } = params

  const where: any = {}

  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ]
  }
  if (status) where.status = status
  if (type) where.type = type

  return prisma.projects.findMany({
    where,
    skip,
    take: limit,
    orderBy: { created_at: 'desc' },
  })
}

/**
 * Get a single project by ID. Throws 404 if not found.
 */
export async function getProject(projectId: string) {
  const project = await prisma.projects.findUnique({
    where: { id: projectId },
  })
  if (!project) throw { statusCode: 404, message: 'Project not found' }
  return project
}

/**
 * Partial update a project. Throws 404 if not found.
 * Only provided (non-undefined) fields are updated.
 */
export async function updateProject(projectId: string, data: ProjectUpdate) {
  const existing = await prisma.projects.findUnique({
    where: { id: projectId },
  })
  if (!existing) throw { statusCode: 404, message: 'Project not found' }

  // Build sparse update — only update explicitly provided fields
  const updateData: any = {}
  if (data.name !== undefined && data.name !== null) updateData.name = data.name
  if (data.description !== undefined) updateData.description = data.description
  if (data.type !== undefined && data.type !== null) updateData.type = data.type
  if (data.category !== undefined) updateData.category = data.category
  if (data.base_url !== undefined) updateData.base_url = data.base_url
  if (data.status !== undefined) updateData.status = data.status
  if (data.tags !== undefined) updateData.tags = data.tags

  return prisma.projects.update({
    where: { id: projectId },
    data: updateData,
  })
}

/**
 * Soft-delete a project by setting status to 'Archived'.
 * Preserves referential integrity for test_cases, executions, and integration records.
 */
export async function deleteProject(projectId: string) {
  const existing = await prisma.projects.findUnique({
    where: { id: projectId },
  })
  if (!existing) throw { statusCode: 404, message: 'Project not found' }

  await prisma.projects.update({
    where: { id: projectId },
    data: { status: 'Archived' },
  })
}

/**
 * Hard-delete a project and all its related records permanently.
 * This is irreversible — cascades to project_integrations, test_cases,
 * executions, and any related metadata via DB ON DELETE CASCADE constraints.
 */
export async function hardDeleteProject(projectId: string) {
  const existing = await prisma.projects.findUnique({
    where: { id: projectId },
  })
  if (!existing) throw { statusCode: 404, message: 'Project not found' }

  // Find all test cases for this project to cascade delete their dependencies
  const testCases = await prisma.test_cases.findMany({
    where: { project_id: projectId },
    select: { id: true }
  })
  const testCaseIds = testCases.map((tc) => tc.id)

  // Use a transaction to ensure all related records are deleted (avoids FK constraint errors if no DB-level cascade)
  await prisma.$transaction([
    prisma.project_integrations.deleteMany({ where: { project_id: projectId } }),
    prisma.integrations.deleteMany({ where: { project_id: projectId } }),
    prisma.salesforce_connections.deleteMany({ where: { project_id: projectId } }),
    prisma.environments.deleteMany({ where: { project_id: projectId } }),
    prisma.test_data_sets.deleteMany({ where: { project_id: projectId } }),
    prisma.metadata_raw_store.deleteMany({ where: { project_id: projectId } }),
    prisma.metadata_normalized.deleteMany({ where: { project_id: projectId } }),
    prisma.domain_models.deleteMany({ where: { project_id: projectId } }),
    prisma.vector_embeddings.deleteMany({ where: { project_id: projectId } }),
    prisma.rag_query_logs.deleteMany({ where: { project_id: projectId } }),
    prisma.execution_learnings.deleteMany({ where: { project_id: projectId } }),

    // Test cases and deep dependencies
    prisma.executions.deleteMany({ where: { test_case_id: { in: testCaseIds } } }),
    prisma.test_runs.deleteMany({ where: { test_case_id: { in: testCaseIds } } }),
    prisma.test_steps.deleteMany({ where: { test_case_id: { in: testCaseIds } } }),
    
    prisma.test_cases.deleteMany({ where: { project_id: projectId } }),

    prisma.projects.delete({ where: { id: projectId } }),
  ])
}

// ─── Integration Management ──────────────────────────────────────

/**
 * Update login credentials for an existing web_app integration.
 * Called by POST /api/v1/projects/:id/save-web-credentials.
 * Credentials are Fernet-encrypted before storage.
 * Stores the login_url inside auth_config so it can be read separately
 * from the crawl base_url.
 */
export async function saveWebAppCredentials(
  projectId: string,
  data: {
    login_url?: string
    username?: string
    password?: string
    login_strategy?: string
  },
): Promise<void> {
  const existing = await prisma.project_integrations.findFirst({
    where: { project_id: projectId },
  })
  if (!existing) {
    throw { statusCode: 404, message: 'No integration found for this project. Connect first.' }
  }

  const updateData: Record<string, any> = {}

  if (data.username !== undefined && data.username !== '') {
    updateData.username = fernetEncrypt(data.username)
  }
  if (data.password !== undefined && data.password !== '') {
    updateData.password = fernetEncrypt(data.password)
  }
  if (data.login_strategy !== undefined) {
    updateData.login_strategy = data.login_strategy
  }
  if (data.login_url !== undefined) {
    // Merge login_url into auth_config (preserve existing crawler settings)
    const existingCfg = (existing.auth_config as Record<string, any>) ?? {}
    updateData.auth_config = { ...existingCfg, login_url: data.login_url }
  }

  await prisma.project_integrations.update({
    where: { id: existing.id },
    data: updateData,
  })
}

/**
 * Create or update a web_app integration for a project.
 * Credentials are Fernet-encrypted before storage.
 * Called by POST /api/v1/projects/:id/integrations (category=web_app).
 */
export async function createWebIntegration(
  projectId: string,
  baseUrl: string,
  username: string | null,
  password: string | null,
  loginStrategy: string,
  authConfig?: Record<string, any>,
) {
  const encUsername = username ? fernetEncrypt(username) : null
  const encPassword = password ? fernetEncrypt(password) : null

  // Upsert: if an integration already exists for this project, update it
  const existing = await prisma.project_integrations.findFirst({
    where: { project_id: projectId },
  })

  if (existing) {
    return prisma.project_integrations.update({
      where: { id: existing.id },
      data: {
        category: 'web_app',
        status: 'connected',
        base_url: baseUrl,
        username: encUsername,
        password: encPassword,
        login_strategy: loginStrategy,
        ...(authConfig && { auth_config: authConfig }),
      },
    })
  }

  return prisma.project_integrations.create({
    data: {
      project_id: projectId,
      category: 'web_app',
      status: 'connected',
      base_url: baseUrl,
      username: encUsername,
      password: encPassword,
      login_strategy: loginStrategy,
      auth_config: authConfig ?? {},
    },
  })
}

/**
 * Create an API integration (API key or bearer token).
 * Tokens are Fernet-encrypted before storage.
 */
export async function createApiIntegration(
  projectId: string,
  baseUrl: string | null,
  apiKey: string | null,
  bearerToken: string | null,
) {
  const authConfig: Record<string, string> = {}
  if (apiKey) authConfig.api_key = fernetEncrypt(apiKey)
  if (bearerToken) authConfig.bearer_token = fernetEncrypt(bearerToken)

  return prisma.project_integrations.create({
    data: {
      project_id: projectId,
      category: 'api',
      status: 'connected',
      base_url: baseUrl,
      auth_config: authConfig,
    },
  })
}

/**
 * Get all integrations for a project.
 * Returns the full list so the frontend can render per-category status.
 * Called by GET /api/v1/projects/:id/integrations.
 */
export async function getProjectIntegrations(projectId: string) {
  // Verify the project exists first
  const project = await prisma.projects.findUnique({
    where: { id: projectId },
    select: { id: true },
  })
  if (!project) throw { statusCode: 404, message: 'Project not found' }

  return prisma.project_integrations.findMany({
    where: { project_id: projectId },
    orderBy: { created_at: 'desc' },
  })
}

/**
 * Save a new integration config (generic upsert).
 * Called by POST /api/v1/projects/:id/integrations.
 * Routes to the correct integration type based on category.
 */
export async function createIntegration(
  projectId: string,
  body: {
    category: string
    base_url?: string
    username?: string
    password?: string
    login_strategy?: string
    api_key?: string
    bearer_token?: string
    client_id?: string
    client_secret?: string
  },
) {
  const category = body.category.toLowerCase()

  if (category === 'web_app') {
    if (!body.base_url) throw { statusCode: 400, message: 'base_url is required for web_app' }
    return createWebIntegration(
      projectId,
      body.base_url,
      body.username ?? null,
      body.password ?? null,
      body.login_strategy ?? 'form',
    )
  }

  if (category === 'api') {
    return createApiIntegration(
      projectId,
      body.base_url ?? null,
      body.api_key ?? null,
      body.bearer_token ?? null,
    )
  }

  if (category === 'salesforce') {
    // Salesforce OAuth is initiated via save-sf-credentials + OAuth flow
    throw {
      statusCode: 400,
      message:
        "Use POST /api/v1/projects/:id/save-sf-credentials to configure Salesforce credentials, then initiate OAuth.",
    }
  }

  throw { statusCode: 400, message: `Unsupported category: '${category}'` }
}

/**
 * Delete the first integration found for a project.
 * Returns false if no integration exists.
 */
export async function deleteIntegration(projectId: string): Promise<boolean> {
  const integration = await prisma.project_integrations.findFirst({
    where: { project_id: projectId },
  })
  if (!integration) return false

  await prisma.project_integrations.delete({
    where: { id: integration.id },
  })
  return true
}

/**
 * Get the first integration record for a project (raw DB row).
 * Internal helper — callers should use getIntegrationStatus for the
 * frontend-facing response shape.
 */
export async function getIntegration(projectId: string) {
  return prisma.project_integrations.findFirst({
    where: { project_id: projectId },
  })
}

/**
 * Get integration status in the shape expected by the frontend.
 * Matches Python: GET /api/v1/projects/:id/integration-status
 */
export async function getIntegrationStatus(projectId: string) {
  const integration = await getIntegration(projectId)

  // Collect ui_session fields from the project row
  const project = await prisma.projects.findUnique({
    where: { id: projectId },
    select: {
      ui_session_active: true,
      ui_session_last_created_at: true,
      ui_session_source: true,
    },
  })

  const sessionStatus = {
    active: project?.ui_session_active ?? false,
    last_created_at: project?.ui_session_last_created_at?.toISOString() ?? null,
    source: project?.ui_session_source ?? null,
  }

  if (!integration) {
    return {
      status: 'disconnected',
      category: null,
      message: 'No integration configured for this project',
      sync_counts: null,
      ui_session: sessionStatus,
    }
  }

  const syncCounts = await getSyncCounts(projectId)

  // For web_app integrations, expose the decrypted username and stored login_url
  // so the Integration tab can pre-populate the Session & Login form automatically.
  // Password is intentionally never returned.
  let webCredentials: { username: string | null; login_url: string | null } | null = null
  if (integration.category === 'web_app') {
    const decryptedUsername = integration.username
      ? (() => { try { return fernetDecrypt(integration.username) } catch { return null } })()
      : null
    const authCfg = (integration.auth_config as Record<string, any>) ?? {}
    webCredentials = {
      username: decryptedUsername,
      login_url: authCfg.login_url ?? null,
    }
  }

  return {
    id: integration.id,
    project_id: integration.project_id,
    category: integration.category,
    status: integration.status,
    base_url: integration.base_url,
    instance_url: integration.instance_url,
    login_strategy: integration.login_strategy,
    org_id: integration.org_id,
    salesforce_login_url: integration.salesforce_login_url,
    has_sf_credentials:
      integration.category === 'salesforce' ? Boolean(integration.client_id) : null,
    mcp_connected: Boolean(integration.mcp_connected),
    last_synced_at: integration.last_synced_at?.toISOString() ?? null,
    sync_error: integration.sync_error,
    sync_counts: syncCounts,
    ui_session: sessionStatus,
    web_credentials: webCredentials,
    created_at: integration.created_at?.toISOString() ?? null,
    updated_at: integration.updated_at?.toISOString() ?? null,
  }
}

/**
 * Count metadata records for a project — returned in integration status.
 *
 * For Web App projects the crawler stores ALL pages inside a single
 * metadata_raw_store row (raw_json.pages[]) and a single
 * metadata_normalized row (structured_json.pages[]).
 * Counting DB rows would always give 1 — instead we read the real
 * page arrays so the UI shows the actual crawled-page count.
 */
async function getSyncCounts(projectId: string) {
  const [domain, embeddings] = await Promise.all([
    prisma.domain_models.count({ where: { project_id: projectId } }),
    prisma.vector_embeddings.count({ where: { project_id: projectId } }),
  ])

  // ── Raw pages count ──────────────────────────────────────────────
  let rawPageCount = 0
  const rawRow = await prisma.metadata_raw_store.findFirst({
    where: { project_id: projectId, metadata_type: 'webpage' },
    select: { raw_json: true },
  })
  if (rawRow?.raw_json) {
    const rd = rawRow.raw_json as { pages?: unknown[] }
    rawPageCount = rd.pages?.length ?? 0
  }
  // For non-webapp projects (Salesforce etc.) fall back to row count
  if (rawPageCount === 0) {
    rawPageCount = await prisma.metadata_raw_store.count({ where: { project_id: projectId } })
  }

  // ── Normalized pages count ───────────────────────────────────────
  let normalizedPageCount = 0
  const normRow = await prisma.metadata_normalized.findFirst({
    where: { project_id: projectId, entity_type: 'webapp_crawl' },
    select: { structured_json: true },
  })
  if (normRow?.structured_json) {
    const nd = normRow.structured_json as { pages?: unknown[] }
    normalizedPageCount = nd.pages?.length ?? 0
  }
  // For non-webapp projects fall back to row count
  if (normalizedPageCount === 0) {
    normalizedPageCount = await prisma.metadata_normalized.count({ where: { project_id: projectId } })
  }

  return {
    raw_count:          rawPageCount,
    normalized_count:   normalizedPageCount,
    domain_model_count: domain,
    embedding_count:    embeddings,
  }
}

// ─── Salesforce OAuth ────────────────────────────────────────────

/**
 * Save Salesforce Connected App credentials (Fernet-encrypted).
 * Must be called before initiating OAuth.
 */
export async function saveSfCredentials(projectId: string, data: SalesforceCredentials) {
  const encClientId = fernetEncrypt(data.client_id)
  const encClientSecret = fernetEncrypt(data.client_secret)
  const encUsername = data.sf_username ? fernetEncrypt(data.sf_username) : null
  const encPassword = data.sf_password ? fernetEncrypt(data.sf_password) : null

  const redirectUri =
    data.redirect_uri ??
    process.env.SALESFORCE_REDIRECT_URI ??
    `http://localhost:4000/api/v1/integrations/salesforce/callback`

  const existing = await prisma.project_integrations.findFirst({
    where: { project_id: projectId },
  })

  if (existing) {
    return prisma.project_integrations.update({
      where: { id: existing.id },
      data: {
        category: 'salesforce',
        client_id: encClientId,
        client_secret: encClientSecret,
        username: encUsername,
        password: encPassword,
        salesforce_redirect_uri: redirectUri,
        salesforce_login_url: data.login_url ?? 'https://login.salesforce.com',
      },
    })
  }

  return prisma.project_integrations.create({
    data: {
      project_id: projectId,
      category: 'salesforce',
      status: 'disconnected',
      client_id: encClientId,
      client_secret: encClientSecret,
      username: encUsername,
      password: encPassword,
      salesforce_redirect_uri: redirectUri,
      salesforce_login_url: data.login_url ?? 'https://login.salesforce.com',
    },
  })
}

// ─── Credential Access (cross-module public interface) ───────────

/**
 * Return decrypted integration tokens for a project.
 * Used by salesforce.service.ts and execution.service.ts — they must
 * never query project_integrations directly.
 */
export async function getDecryptedTokens(integrationId: string) {
  const integration = await prisma.project_integrations.findUnique({
    where: { id: integrationId },
  })
  if (!integration) throw { statusCode: 404, message: 'Integration not found' }

  const result: Record<string, string | null> = {}

  if (integration.username) result.username = fernetDecrypt(integration.username)
  if (integration.password) result.password = fernetDecrypt(integration.password)
  if (integration.access_token) result.access_token = fernetDecrypt(integration.access_token)
  if (integration.refresh_token) result.refresh_token = fernetDecrypt(integration.refresh_token)
  if (integration.client_id) result.client_id = fernetDecrypt(integration.client_id)
  if (integration.client_secret) result.client_secret = fernetDecrypt(integration.client_secret)
  if (integration.security_token) result.security_token = fernetDecrypt(integration.security_token)
  if (integration.jira_token) result.jira_token = fernetDecrypt(integration.jira_token)

  return result
}

/**
 * Get the Salesforce integration record by project ID (for internal service use).
 * Filters by category='salesforce' to ensure the correct integration is always
 * returned even if a project has multiple integration rows (e.g., web_app + salesforce).
 * Other modules call this to discover if a Salesforce connection exists.
 */
export async function getIntegrationByProject(projectId: string) {
  // First try to find a Salesforce-specific integration
  const sfIntegration = await prisma.project_integrations.findFirst({
    where: { project_id: projectId, category: 'salesforce' },
  })
  if (sfIntegration) return sfIntegration

  // Fall back to any integration (for legacy callers that may pass web_app projects)
  return prisma.project_integrations.findFirst({
    where: { project_id: projectId },
  })
}

// ─── Jira ────────────────────────────────────────────────────────

/** Safe JSON parse helper — returns null when the response body is not JSON. */
async function tryParseJson(response: Response): Promise<any | null> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) return null
  try {
    return await response.json()
  } catch {
    return null
  }
}

/** Read up to 300 chars of the raw response body for error context. */
async function peekBody(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text.slice(0, 300).replace(/\s+/g, ' ').trim()
  } catch {
    return '(unreadable body)'
  }
}

/** Standard request headers that prevent Atlassian from returning HTML redirects. */
function jiraHeaders(authHeader: string) {
  return {
    Authorization: authHeader,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'AutoTestAI/1.0 (Node.js; Jira integration)',
    'X-Atlassian-Token': 'no-check',
  }
}

/** Normalise a user-supplied Jira domain to a clean https:// base URL. */
function normaliseDomain(raw: string): string {
  // Strip trailing slashes and any path segments — keep only the origin
  let domain = raw.trim().replace(/\/+$/, '')
  // Strip any path after the TLD (e.g. https://site.atlassian.net/jira → https://site.atlassian.net)
  try {
    const url = new URL(domain.startsWith('http') ? domain : `https://${domain}`)
    domain = url.origin // e.g. https://yoursite.atlassian.net
  } catch {
    // fall through — validation below will catch it
  }
  if (!domain.startsWith('https://')) domain = `https://${domain}`
  return domain
}

export async function jiraConnect(data: JiraConnect) {
  const domain = normaliseDomain(data.jira_domain)

  // Validate that it is an Atlassian cloud URL
  if (!domain.includes('atlassian.net') && !domain.includes('atlassian.com')) {
    throw {
      statusCode: 400,
      message:
        `Invalid Jira domain '${domain}'. Expected a URL like https://yoursite.atlassian.net`,
    }
  }

  const authHeader =
    'Basic ' + Buffer.from(`${data.jira_email}:${data.jira_token}`).toString('base64')

  log.info({ domain }, 'Attempting Jira connection')

  let response: Response
  try {
    // Use REST API v2 — more permissive for server-side requests than v3
    response = await fetch(`${domain}/rest/api/2/myself`, {
      headers: jiraHeaders(authHeader),
    })
  } catch (err: any) {
    throw { statusCode: 502, message: `Cannot reach Jira at ${domain}: ${err.message}` }
  }

  log.info({ status: response.status, contentType: response.headers.get('content-type') }, 'Jira /myself response')

  if (!response.ok) {
    // Clone the response so we can read it twice if needed
    const json = await tryParseJson(response.clone())
    if (json) {
      const detail = json.message ?? json.errorMessages?.[0] ?? `HTTP ${response.status}`
      throw { statusCode: 400, message: `Jira connection failed: ${detail}` }
    }
    // Non-JSON error — surface a snippet of whatever was returned
    const snippet = await peekBody(response)
    throw {
      statusCode: 400,
      message:
        `Jira returned HTTP ${response.status} with a non-JSON body. ` +
        `Check your domain (${domain}) and API token. ` +
        (snippet ? `Response preview: ${snippet}` : ''),
    }
  }

  // Guard against Atlassian returning HTML (CAPTCHA / login redirect) on 2xx
  const user = await tryParseJson(response.clone())
  if (!user) {
    const snippet = await peekBody(response)
    throw {
      statusCode: 400,
      message:
        `Jira returned a non-JSON 2xx response — this usually means the domain is wrong ` +
        `or Atlassian is redirecting to a login/CAPTCHA page. ` +
        `Domain used: ${domain}. ` +
        (snippet ? `Response preview: ${snippet}` : 'Empty body.'),
    }
  }

  log.info({ accountId: user.accountId, displayName: user.displayName }, 'Jira connected successfully')
  return { connected: true, user }
}

export async function jiraBoards(data: JiraConnect) {
  const domain = normaliseDomain(data.jira_domain)

  const authHeader =
    'Basic ' + Buffer.from(`${data.jira_email}:${data.jira_token}`).toString('base64')

  let response: Response
  try {
    response = await fetch(`${domain}/rest/agile/1.0/board`, {
      headers: jiraHeaders(authHeader),
    })
  } catch (err: any) {
    throw { statusCode: 502, message: `Cannot reach Jira boards at ${domain}: ${err.message}` }
  }

  if (!response.ok) {
    const json = await tryParseJson(response.clone())
    if (json) {
      const detail = json.message ?? json.errorMessages?.[0] ?? `HTTP ${response.status}`
      throw { statusCode: 400, message: `Failed to fetch Jira boards: ${detail}` }
    }
    const snippet = await peekBody(response)
    throw {
      statusCode: 400,
      message:
        `Jira boards API returned HTTP ${response.status} with a non-JSON body. ` +
        `Domain: ${domain}. ` +
        (snippet ? `Preview: ${snippet}` : ''),
    }
  }

  // Guard against HTML response
  const result = await tryParseJson(response.clone())
  if (!result) {
    const snippet = await peekBody(response)
    throw {
      statusCode: 400,
      message:
        `Jira boards API returned a non-JSON response. Verify your domain (${domain}) and credentials. ` +
        (snippet ? `Preview: ${snippet}` : ''),
    }
  }

  return result.values ?? []
}

export async function jiraBoardIssues(
  domain: string,
  email: string,
  token: string,
  boardId: string | number,
) {
  domain = normaliseDomain(domain)

  const authHeader =
    'Basic ' + Buffer.from(`${email}:${token}`).toString('base64')

  // Request the specific fields we need — Jira returns issue data under issue.fields.*
  const url = `${domain}/rest/agile/1.0/board/${boardId}/issue?maxResults=50&fields=summary,description,status,issuetype,priority`
  const response = await fetch(url, { headers: jiraHeaders(authHeader) })

  if (!response.ok) {
    const json = await tryParseJson(response.clone())
    const detail = json?.message ?? json?.errorMessages?.[0] ?? `HTTP ${response.status}`
    throw { statusCode: 400, message: `Failed to fetch board issues: ${detail}` }
  }

  const result = (await response.json()) as any
  const rawIssues: any[] = result.issues ?? []

  // Normalize: flatten Jira's nested `fields` object for easy consumption
  return rawIssues.map((issue) => ({
    id: issue.id,
    key: issue.key,
    summary: issue.fields?.summary ?? '(no summary)',
    description:
      typeof issue.fields?.description === 'string'
        ? issue.fields.description
        : issue.fields?.description?.content
            ?.map((b: any) => b.content?.map((c: any) => c.text ?? '').join('') ?? '')
            .join('\n') ?? '',
    status: issue.fields?.status?.name ?? null,
    issue_type: issue.fields?.issuetype?.name ?? null,
    priority: issue.fields?.priority?.name ?? null,
  }))
}

export async function saveJiraConfig(projectId: string, data: JiraProjectConfig) {
  const encToken = fernetEncrypt(data.jira_token)

  const existing = await prisma.project_integrations.findFirst({
    where: { project_id: projectId },
  })

  if (existing) {
    return prisma.project_integrations.update({
      where: { id: existing.id },
      data: {
        jira_domain: data.jira_domain,
        jira_email: data.jira_email,
        jira_token: encToken,
        jira_board_id: String(data.board_id),
        jira_board_name: data.board_name ?? null,
      },
    })
  }

  return prisma.project_integrations.create({
    data: {
      project_id: projectId,
      category: 'webapp',
      status: 'connected',
      jira_domain: data.jira_domain,
      jira_email: data.jira_email,
      jira_token: encToken,
      jira_board_id: String(data.board_id),
      jira_board_name: data.board_name ?? null,
    },
  })
}

export async function getJiraConfig(projectId: string) {
  const integration = await prisma.project_integrations.findFirst({
    where: { project_id: projectId },
    select: {
      jira_domain: true,
      jira_email: true,
      jira_token: true,
      jira_board_id: true,
      jira_board_name: true,
    },
  })

  if (!integration || !integration.jira_domain) return null

  return {
    jira_domain: integration.jira_domain,
    jira_email: integration.jira_email,
    jira_board_id: integration.jira_board_id,
    jira_board_name: integration.jira_board_name,
    configured: true,
  }
}

export async function getJiraStories(projectId: string) {
  const config = await getJiraConfig(projectId)
  if (!config || !config.jira_domain || !config.jira_board_id) {
    throw { statusCode: 404, message: 'Jira not configured for this project' }
  }

  const integration = await prisma.project_integrations.findFirst({
    where: { project_id: projectId },
    select: {
      jira_token: true,
      jira_email: true,
      jira_domain: true,
      jira_board_id: true,
      jira_board_name: true,
    },
  })

  if (!integration?.jira_token) throw { statusCode: 404, message: 'Jira token not found' }

  const token = fernetDecrypt(integration.jira_token)
  const issues = await jiraBoardIssues(
    integration.jira_domain!,
    integration.jira_email!,
    token,
    integration.jira_board_id!,
  )

  // Return envelope so the frontend can display the board name
  return {
    board_id: integration.jira_board_id,
    board_name: integration.jira_board_name ?? null,
    issues,
  }
}

// ─── BRD Persistence ─────────────────────────────────────────────

/**
 * Save (or overwrite) a BRD document for a project.
 * Content is stored as plain text in the projects table.
 * Max 200 KB to prevent runaway storage — callers must pre-truncate if needed.
 */
export async function saveBrd(
  projectId: string,
  filename: string,
  content: string,
): Promise<void> {
  const project = await prisma.projects.findUnique({ where: { id: projectId } })
  if (!project) throw { statusCode: 404, message: 'Project not found' }

  // Guard: 200 KB limit (safety net — frontend already limits to 50 KB for generation)
  const MAX_BYTES = 200_000
  const truncated = Buffer.byteLength(content, 'utf8') > MAX_BYTES
    ? content.slice(0, MAX_BYTES)
    : content

  await prisma.projects.update({
    where: { id: projectId },
    data: {
      brd_filename: filename.slice(0, 255),
      brd_content: truncated,
    },
  })

  log.info({ projectId, filename, bytes: truncated.length }, 'BRD saved')
}

/**
 * Retrieve stored BRD metadata + content for a project.
 * Returns null when no BRD is attached.
 */
export async function getBrd(
  projectId: string,
): Promise<{ filename: string; content: string; bytes: number } | null> {
  const project = await prisma.projects.findUnique({
    where: { id: projectId },
    select: { brd_filename: true, brd_content: true },
  })
  if (!project) throw { statusCode: 404, message: 'Project not found' }
  if (!project.brd_filename || !project.brd_content) return null

  return {
    filename: project.brd_filename,
    content: project.brd_content,
    bytes: Buffer.byteLength(project.brd_content, 'utf8'),
  }
}

/**
 * Remove the stored BRD from a project.
 */
export async function deleteBrd(projectId: string): Promise<void> {
  const project = await prisma.projects.findUnique({ where: { id: projectId } })
  if (!project) throw { statusCode: 404, message: 'Project not found' }

  await prisma.projects.update({
    where: { id: projectId },
    data: { brd_filename: null, brd_content: null },
  })

  log.info({ projectId }, 'BRD removed')
}

// ─── Existing Tests Persistence ──────────────────────────────────

/**
 * Save (or overwrite) an existing test cases document for a project.
 * Max 200 KB — callers must pre-truncate if needed.
 */
export async function saveExistingTests(
  projectId: string,
  filename: string,
  content: string,
): Promise<void> {
  const project = await prisma.projects.findUnique({ where: { id: projectId } })
  if (!project) throw { statusCode: 404, message: 'Project not found' }

  const MAX_BYTES = 200_000
  const truncated = Buffer.byteLength(content, 'utf8') > MAX_BYTES
    ? content.slice(0, MAX_BYTES)
    : content

  await prisma.projects.update({
    where: { id: projectId },
    data: {
      existing_tests_filename: filename.slice(0, 255),
      existing_tests_content:  truncated,
    },
  })

  log.info({ projectId, filename, bytes: truncated.length }, 'Existing tests doc saved')
}

/**
 * Retrieve stored existing-tests doc for a project.
 * Returns null when no doc is attached.
 */
export async function getExistingTests(
  projectId: string,
): Promise<{ filename: string; content: string; bytes: number } | null> {
  const project = await prisma.projects.findUnique({
    where: { id: projectId },
    select: { existing_tests_filename: true, existing_tests_content: true },
  })
  if (!project) throw { statusCode: 404, message: 'Project not found' }
  if (!project.existing_tests_filename || !project.existing_tests_content) return null

  return {
    filename: project.existing_tests_filename,
    content:  project.existing_tests_content,
    bytes:    Buffer.byteLength(project.existing_tests_content, 'utf8'),
  }
}

/**
 * Remove the stored existing-tests doc from a project.
 */
export async function deleteExistingTests(projectId: string): Promise<void> {
  const project = await prisma.projects.findUnique({ where: { id: projectId } })
  if (!project) throw { statusCode: 404, message: 'Project not found' }

  await prisma.projects.update({
    where: { id: projectId },
    data: { existing_tests_filename: null, existing_tests_content: null },
  })

  log.info({ projectId }, 'Existing tests doc removed')
}

// ─── Keycloak / OAuth Custom Token Session ────────────────────────────────────

/**
 * Keycloak Session Flow:
 * 1. User logs in via Keycloak SSO in their browser.
 * 2. Backend issues HMAC-signed auth_token + Keycloak id_token.
 * 3. Frontend/user calls POST /api/v1/projects/:id/save-keycloak-tokens
 *    with both tokens.
 * 4. This function Fernet-encrypts them and stores them inside auth_config:
 *      auth_config.keycloak_auth_token  → encrypted Bearer token
 *      auth_config.keycloak_id_token    → encrypted Keycloak id_token
 *      auth_config.keycloak_refresh_url → optional refresh endpoint
 *      auth_config.keycloak_expires_at  → Unix ms expiry timestamp
 * 5. On each test run, execution.service reads them out and injects into
 *    the Playwright browser context via sessionStorage before any navigation.
 */
export async function saveKeycloakTokens(
  projectId: string,
  data: KeycloakToken,
): Promise<void> {
  const integration = await prisma.project_integrations.findFirst({
    where: { project_id: projectId },
  })
  if (!integration) {
    throw { statusCode: 404, message: 'No integration found for this project. Connect first.' }
  }

  // Encrypt the tokens before storage
  const encAuthToken = fernetEncrypt(data.auth_token)
  const encIdToken = data.id_token ? fernetEncrypt(data.id_token) : null

  // Default expiry: 24 hours from now
  const expiresAt = data.expires_at ?? (Date.now() + 24 * 60 * 60 * 1000)

  const existingCfg = (integration.auth_config as Record<string, any>) ?? {}
  const updatedCfg: Record<string, any> = {
    ...existingCfg,
    keycloak_auth_token: encAuthToken,
    keycloak_id_token: encIdToken,
    keycloak_refresh_url: data.refresh_url ?? existingCfg.keycloak_refresh_url ?? null,
    keycloak_expires_at: expiresAt,
    keycloak_stored_at: Date.now(),
  }

  await prisma.project_integrations.update({
    where: { id: integration.id },
    data: {
      login_strategy: 'keycloak',
      auth_config: updatedCfg,
    },
  })

  // Mark session active in projects table
  await prisma.projects.update({
    where: { id: projectId },
    data: {
      ui_session_active: true,
      ui_session_source: 'keycloak',
      ui_session_last_created_at: new Date(),
    },
  }).catch((e: unknown) => log.warn({ e }, '[KEYCLOAK] DB flag update failed (non-fatal)'))

  log.info({ projectId }, '[KEYCLOAK] ✅ Tokens saved and session marked active')
}

/**
 * Retrieve the decrypted Keycloak session tokens for a project.
 * Returns null when no Keycloak tokens are stored.
 * Called by execution.service to build ExecutionContext before enqueueing the job.
 */
export async function getKeycloakSession(
  projectId: string,
): Promise<{
  auth_token: string
  id_token: string | null
  refresh_url: string | null
  expires_at: number
} | null> {
  const integration = await prisma.project_integrations.findFirst({
    where: { project_id: projectId },
    select: { auth_config: true, login_strategy: true },
  })
  if (!integration || integration.login_strategy !== 'keycloak') return null

  const cfg = (integration.auth_config as Record<string, any>) ?? {}
  if (!cfg.keycloak_auth_token) return null

  try {
    const authToken = fernetDecrypt(cfg.keycloak_auth_token)
    const idToken = cfg.keycloak_id_token ? fernetDecrypt(cfg.keycloak_id_token) : null
    return {
      auth_token: authToken,
      id_token: idToken,
      refresh_url: cfg.keycloak_refresh_url ?? null,
      expires_at: cfg.keycloak_expires_at ?? (Date.now() + 24 * 60 * 60 * 1000),
    }
  } catch (err) {
    log.warn({ err, projectId }, '[KEYCLOAK] Failed to decrypt stored tokens')
    return null
  }
}

/**
 * Clear stored Keycloak tokens for a project (e.g. on logout or token revocation).
 */
export async function clearKeycloakSession(projectId: string): Promise<void> {
  const integration = await prisma.project_integrations.findFirst({
    where: { project_id: projectId },
  })
  if (!integration) return

  const existingCfg = (integration.auth_config as Record<string, any>) ?? {}
  const {
    keycloak_auth_token: _a,
    keycloak_id_token: _b,
    keycloak_expires_at: _c,
    keycloak_stored_at: _d,
    ...remainingCfg
  } = existingCfg

  await prisma.project_integrations.update({
    where: { id: integration.id },
    data: { auth_config: remainingCfg, login_strategy: 'form' },
  })

  await prisma.projects.update({
    where: { id: projectId },
    data: { ui_session_active: false },
  }).catch(() => {})

  log.info({ projectId }, '[KEYCLOAK] Session cleared')
}
