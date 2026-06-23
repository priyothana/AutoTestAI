/**
 * Repository Metadata Extractor Service
 *
 * Makes repository source code the PRIMARY metadata input for test generation.
 * Priority: Repository (highest) → Knowledge Graph → Playwright Crawler (fallback)
 *
 * Flow:
 *   1. Save repo connection (Fernet-encrypted token) in repo_connections table
 *   2. On sync: fetch file tree from GitHub/GitLab/Bitbucket API
 *   3. Index: *.tsx, *.jsx, *.vue, *.ts, *.js in src/, app/, pages/, components/, routes/
 *             + routes/**, app/api/**, schemas/**, constants/**
 *   4. Parse each file for: form fields, button names, route paths, Zod/Yup schemas
 *   5. Write into metadata_normalized (entity_type='repository_crawl')
 *      and metadata_canonical with source='repository'
 *
 * No Prisma migration needed — uses runtime DDL (same pattern as canonical-builder.service.ts).
 */
import prisma from '../../shared/db/prisma.js'
import { fernetEncrypt, fernetDecrypt } from '../../shared/encryption/fernet.js'
import { createModuleLogger } from '../../shared/logger/index.js'
import { applyRequiredFieldOverrides } from '../ai-agents/tools/metadata-reader.tool.js'

const log = createModuleLogger('repo-extractor')

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RepoConnectionRow {
  id: string
  project_id: string
  repo_url: string
  branch: string
  provider: 'github' | 'gitlab' | 'bitbucket'
  status: 'connected' | 'disconnected' | 'syncing' | 'error'
  last_synced_at: string | null
  sync_error: string | null
}

export interface RepoSyncResult {
  success: boolean
  files_indexed: number
  entities_extracted: number
  message: string
  warning?: string
}

interface ParsedField {
  label: string
  type: 'input' | 'select' | 'lookup' | 'checkbox' | 'textarea'
  required: boolean
  options?: string[]
  locator_type: 'label'
}

interface ParsedEntity {
  name: string
  entityType: 'form' | 'web_page'
  pageUrl?: string
  fields: ParsedField[]
  buttons: string[]
  routes: string[]
}

// ─── Runtime DDL ──────────────────────────────────────────────────────────────

let tableEnsured = false

async function ensureRepoTable(): Promise<void> {
  if (tableEnsured) return
  try {
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS repo_connections (
        id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id      UUID         NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        repo_url        TEXT         NOT NULL,
        branch          TEXT         NOT NULL DEFAULT 'main',
        access_token    TEXT,
        provider        TEXT         NOT NULL DEFAULT 'github',
        status          TEXT         NOT NULL DEFAULT 'disconnected',
        last_synced_at  TIMESTAMPTZ,
        sync_error      TEXT,
        UNIQUE(project_id)
      )
    `
    tableEnsured = true
    log.info('[REPO] repo_connections table ensured')
  } catch (err) {
    log.warn({ err }, '[REPO] ensureRepoTable — table may already exist')
    tableEnsured = true
  }

  // Add source column to metadata_canonical for priority tracking
  try {
    await prisma.$executeRaw`
      ALTER TABLE metadata_canonical ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'crawler'
    `
    log.info('[REPO] source column ensured on metadata_canonical')
  } catch { /* already exists */ }
}

// ─── Repo Connection CRUD ─────────────────────────────────────────────────────

export async function saveRepoConnection(
  projectId: string,
  data: { repo_url: string; branch: string; access_token?: string | null; provider: string },
): Promise<void> {
  await ensureRepoTable()
  const encToken = data.access_token ? fernetEncrypt(data.access_token) : null

  await prisma.$executeRaw`
    INSERT INTO repo_connections (project_id, repo_url, branch, access_token, provider, status)
    VALUES (${projectId}::uuid, ${data.repo_url}, ${data.branch}, ${encToken}, ${data.provider}, 'connected')
    ON CONFLICT (project_id) DO UPDATE SET
      repo_url     = EXCLUDED.repo_url,
      branch       = EXCLUDED.branch,
      access_token = EXCLUDED.access_token,
      provider     = EXCLUDED.provider,
      status       = 'connected',
      sync_error   = NULL
  `
  log.info({ projectId, repo_url: data.repo_url }, '[REPO] Connection saved')
}

export async function getRepoConnection(projectId: string): Promise<RepoConnectionRow | null> {
  await ensureRepoTable()
  const rows = await prisma.$queryRaw<RepoConnectionRow[]>`
    SELECT id, project_id, repo_url, branch, provider, status,
           last_synced_at, sync_error
    FROM repo_connections
    WHERE project_id = ${projectId}::uuid
    LIMIT 1
  `
  return rows[0] ?? null
}

export async function deleteRepoConnection(projectId: string): Promise<void> {
  await ensureRepoTable()
  await prisma.$executeRaw`
    DELETE FROM repo_connections WHERE project_id = ${projectId}::uuid
  `

  // Also remove repository-sourced metadata
  await prisma.metadata_normalized.deleteMany({
    where: { project_id: projectId, entity_type: 'repository_crawl' },
  })

  log.info({ projectId }, '[REPO] Connection and repo metadata removed')
}

// ─── File Pattern Config ──────────────────────────────────────────────────────

const HIGH_PRIORITY_PATHS = [
  'src/', 'app/', 'pages/', 'components/', 'routes/', 'views/',
  'features/', 'modules/', 'screens/', 'containers/',
]

const INCLUDE_EXTENSIONS = ['.tsx', '.jsx', '.vue', '.ts', '.js']

const OPTIONAL_PATHS = [
  '__tests__/', '.test.', 'schemas/', 'constants/', 'types/', 'interfaces/',
]

const MAX_FILES_PER_SYNC = 200  // cap to avoid runaway API calls

// ─── GitHub / GitLab / Bitbucket API Clients ─────────────────────────────────

interface RepoFile {
  path: string
  download_url: string | null
  size: number
}

async function fetchGitHubTree(
  repoUrl: string,
  branch: string,
  token: string | null,
): Promise<RepoFile[]> {
  // Parse owner/repo from https://github.com/owner/repo
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (!match) throw new Error(`Cannot parse GitHub URL: ${repoUrl}`)
  const [, owner, repo] = match

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`
  const res = await fetch(treeUrl, { headers })

  if (res.status === 404) throw new Error(`Repository not found or branch "${branch}" does not exist`)
  if (res.status === 401) throw new Error('GitHub: Invalid or missing access token for private repository')
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub API error ${res.status}: ${body.slice(0, 200)}`)
  }

  const data = await res.json() as { tree: Array<{ path: string; type: string; size?: number }> }
  const files: RepoFile[] = []

  for (const item of data.tree ?? []) {
    if (item.type !== 'blob') continue
    const ext = '.' + (item.path.split('.').pop() ?? '')
    if (!INCLUDE_EXTENSIONS.includes(ext)) continue

    const isHighPriority = HIGH_PRIORITY_PATHS.some(p => item.path.includes(p))
    const isOptional = OPTIONAL_PATHS.some(p => item.path.includes(p))
    if (!isHighPriority && !isOptional) continue

    files.push({
      path: item.path,
      download_url: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${item.path}`,
      size: item.size ?? 0,
    })
  }

  return files.slice(0, MAX_FILES_PER_SYNC)
}

async function fetchGitLabTree(
  repoUrl: string,
  branch: string,
  token: string | null,
): Promise<RepoFile[]> {
  // Parse from https://gitlab.com/owner/repo or self-hosted
  const urlObj = new URL(repoUrl)
  const projectPath = urlObj.pathname.replace(/^\/|\.git$/g, '').replace(/\//g, '%2F')
  const baseUrl = `${urlObj.protocol}//${urlObj.host}`

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['PRIVATE-TOKEN'] = token

  const treeUrl = `${baseUrl}/api/v4/projects/${projectPath}/repository/tree?recursive=true&ref=${branch}&per_page=100`
  const res = await fetch(treeUrl, { headers })

  if (!res.ok) {
    if (res.status === 401) throw new Error('GitLab: Invalid or missing access token for private repository')
    throw new Error(`GitLab API error ${res.status}`)
  }

  const items = await res.json() as Array<{ path: string; type: string }>
  const files: RepoFile[] = []

  for (const item of items) {
    if (item.type !== 'blob') continue
    const ext = '.' + (item.path.split('.').pop() ?? '')
    if (!INCLUDE_EXTENSIONS.includes(ext)) continue

    const isHighPriority = HIGH_PRIORITY_PATHS.some(p => item.path.includes(p))
    if (!isHighPriority) continue

    const encodedPath = encodeURIComponent(item.path)
    files.push({
      path: item.path,
      download_url: `${baseUrl}/api/v4/projects/${projectPath}/repository/files/${encodedPath}/raw?ref=${branch}`,
      size: 0,
    })
  }

  return files.slice(0, MAX_FILES_PER_SYNC)
}

async function fetchBitbucketTree(
  repoUrl: string,
  branch: string,
  token: string | null,
): Promise<RepoFile[]> {
  const match = repoUrl.match(/bitbucket\.org\/([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (!match) throw new Error(`Cannot parse Bitbucket URL: ${repoUrl}`)
  const [, workspace, repoSlug] = match

  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`

  const listUrl = `https://api.bitbucket.org/2.0/repositories/${workspace}/${repoSlug}/src/${branch}/?pagelen=100&q=mimetype="text%2Fplain"&fields=values.path,values.size`
  const res = await fetch(listUrl, { headers })

  if (!res.ok) {
    if (res.status === 401) throw new Error('Bitbucket: Invalid or missing token for private repository')
    throw new Error(`Bitbucket API error ${res.status}`)
  }

  const data = await res.json() as { values: Array<{ path: string; size: number }> }
  const files: RepoFile[] = []

  for (const item of data.values ?? []) {
    const ext = '.' + (item.path.split('.').pop() ?? '')
    if (!INCLUDE_EXTENSIONS.includes(ext)) continue

    const isHighPriority = HIGH_PRIORITY_PATHS.some(p => item.path.includes(p))
    if (!isHighPriority) continue

    files.push({
      path: item.path,
      download_url: `https://api.bitbucket.org/2.0/repositories/${workspace}/${repoSlug}/src/${branch}/${item.path}`,
      size: item.size ?? 0,
    })
  }

  return files.slice(0, MAX_FILES_PER_SYNC)
}

async function fetchFileContent(url: string, token: string | null, provider: string): Promise<string> {
  const headers: Record<string, string> = {}
  if (token) {
    if (provider === 'github')    headers['Authorization'] = `Bearer ${token}`
    if (provider === 'gitlab')    headers['PRIVATE-TOKEN'] = token
    if (provider === 'bitbucket') headers['Authorization'] = `Bearer ${token}`
  }
  const res = await fetch(url, { headers })
  if (!res.ok) return ''
  return res.text()
}

// ─── Source Code Parser ───────────────────────────────────────────────────────

/**
 * Parse a single source file and extract form fields, button names, and route paths.
 * Uses regex-based parsing (no AST) — fast and dependency-free.
 */
function parseSourceFile(content: string, filePath: string): ParsedEntity | null {
  const fields: ParsedField[] = []
  const buttons: string[] = []
  const routes: string[] = []

  // ── Extract form fields from JSX/TSX ──────────────────────────────────────
  // Patterns: <input label="X" />, <Input name="X" />, <TextField label="X" />,
  //           <FormField name="X" />, label="..." combined with required
  const inputPatterns = [
    // HTML input with label attribute
    /<(?:input|Input|TextField|FormInput|Field|FormField)\b[^>]*label=["']([^"']+)["'][^>]*>/gi,
    // Input with placeholder that looks like a label
    /<(?:input|Input|TextField)\b[^>]*placeholder=["']([^"']{3,50})["'][^>]*/gi,
    // Label elements immediately before input
    /<(?:label|Label)\b[^>]*>([^<]{2,60})<\/(?:label|Label)>/gi,
  ]

  for (const pattern of inputPatterns) {
    let m: RegExpExecArray | null
    while ((m = pattern.exec(content)) !== null) {
      const rawLabel = m[1].trim().replace(/\s+/g, ' ')
      if (rawLabel.length < 2 || rawLabel.length > 80) continue
      // Skip obvious non-field labels
      if (/^(search|filter|copyright|powered by|version|\d+)$/i.test(rawLabel)) continue

      const required = /required\s*=\s*\{?true\}?|required\b/i.test(
        content.slice(Math.max(0, m.index - 50), m.index + m[0].length + 50)
      )

      // Determine field type
      let type: ParsedField['type'] = 'input'
      const context = m[0].toLowerCase()
      if (/textarea|multiline|rows=/i.test(context)) type = 'textarea'
      else if (/checkbox|toggle|switch/i.test(context)) type = 'checkbox'
      else if (/select|dropdown|combobox|autocomplete/i.test(context)) type = 'select'
      else if (/lookup|reference|relation/i.test(context)) type = 'lookup'

      if (!fields.some(f => f.label.toLowerCase() === rawLabel.toLowerCase())) {
        fields.push({ label: rawLabel, type, required, locator_type: 'label' })
      }
    }
  }

  // ── Extract Zod/Yup schema field names ────────────────────────────────────
  // z.object({ fieldName: z.string().min(1) }) → required text field
  // z.object({ fieldName: z.string().optional() }) → optional text field
  const zodFieldRe = /(\w+)\s*:\s*z\.(?:(string|number|boolean|enum|date|object|array))\s*\(([^)]*)\)\s*(?:\.([a-zA-Z]+))?/g
  let zm: RegExpExecArray | null
  while ((zm = zodFieldRe.exec(content)) !== null) {
    const fieldName = zm[1]
    const zodType = zm[2]
    const modifiers = zm[4] ?? ''

    if (/^(id|created_at|updated_at|__typename)$/.test(fieldName)) continue

    // Convert camelCase/snake_case to Title Case label
    const label = fieldName
      .replace(/_/g, ' ')
      .replace(/([A-Z])/g, ' $1')
      .trim()
      .replace(/\b\w/g, c => c.toUpperCase())

    const required = !modifiers.includes('optional') && !modifiers.includes('nullable')
    let type: ParsedField['type'] = 'input'
    if (zodType === 'boolean') type = 'checkbox'
    else if (zodType === 'enum') type = 'select'
    else if (fieldName.toLowerCase().includes('description') || fieldName.toLowerCase().includes('notes')) type = 'textarea'
    else if (/accountId|contactId|userId|ownerId|parentId/i.test(fieldName)) type = 'lookup'

    if (!fields.some(f => f.label.toLowerCase() === label.toLowerCase())) {
      fields.push({ label, type, required, locator_type: 'label' })
    }
  }

  // ── Extract button names ───────────────────────────────────────────────────
  // <Button>Create Opportunity</Button>, <button>Save Contact</button>
  const buttonRe = /<(?:button|Button)\b[^>]*>([^<]{2,60})<\/(?:button|Button)>/gi
  let bm: RegExpExecArray | null
  while ((bm = buttonRe.exec(content)) !== null) {
    const btnText = bm[1].trim().replace(/\s+/g, ' ')
    if (btnText.length < 2 || btnText.length > 60) continue
    if (/^(\{|<|undefined|null|\d+)/.test(btnText)) continue
    if (!buttons.includes(btnText)) buttons.push(btnText)
  }

  // Also extract from onClick handlers: onClick={() => handleCreate()} → "Create"
  const onClickLabelRe = /onClick\s*=\s*\{[^}]*handle(Create|Save|Submit|Add|Delete|Update|Cancel)\b/gi
  let om: RegExpExecArray | null
  while ((om = onClickLabelRe.exec(content)) !== null) {
    const verb = om[1]
    if (!buttons.includes(verb)) buttons.push(verb)
  }

  // ── Extract route paths ────────────────────────────────────────────────────
  // Next.js app dir: export default function Page() in app/foo/bar/page.tsx → /foo/bar
  // React Router: path="/opportunities/new"
  // Express: router.get('/accounts', ...) → /accounts
  const routeRe = /(?:path|href|to)\s*=\s*["'](\/?[a-z][a-z0-9/_-]{1,80})["']/gi
  let rm: RegExpExecArray | null
  while ((rm = routeRe.exec(content)) !== null) {
    const route = rm[1].startsWith('/') ? rm[1] : `/${rm[1]}`
    if (!routes.includes(route)) routes.push(route)
  }

  // Derive entity name from file path
  // e.g., src/components/OpportunityForm.tsx → "Opportunity"
  //        app/leads/page.tsx → "Lead"
  const fileName = filePath.split('/').pop() ?? ''
  const entityFromFile = fileName
    .replace(/\.(tsx?|jsx?|vue)$/, '')
    .replace(/Form|Page|View|Component|Container|Screen|Modal|Dialog|Panel$/i, '')
    .replace(/([A-Z])/g, ' $1')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase())

  // Determine if this looks like a form file
  const isForm = /form|create|edit|new|add/i.test(filePath) || fields.length > 2
  const entityType: 'form' | 'web_page' = isForm ? 'form' : 'web_page'

  if (fields.length === 0 && buttons.length === 0 && routes.length === 0) return null

  return {
    name: entityFromFile || 'Unknown',
    entityType,
    fields,
    buttons,
    routes,
  }
}

// ─── Merge entities from multiple files ───────────────────────────────────────

function mergeEntities(entities: ParsedEntity[]): Map<string, ParsedEntity> {
  const merged = new Map<string, ParsedEntity>()

  for (const entity of entities) {
    const key = entity.name.toLowerCase().trim()
    if (!merged.has(key)) {
      merged.set(key, { ...entity, fields: [...entity.fields], buttons: [...entity.buttons], routes: [...entity.routes] })
      continue
    }

    const existing = merged.get(key)!
    // Merge fields — deduplicate by label
    for (const f of entity.fields) {
      if (!existing.fields.some(ef => ef.label.toLowerCase() === f.label.toLowerCase())) {
        existing.fields.push(f)
      }
    }
    // Merge buttons — deduplicate
    for (const b of entity.buttons) {
      if (!existing.buttons.includes(b)) existing.buttons.push(b)
    }
    // Merge routes — deduplicate
    for (const r of entity.routes) {
      if (!existing.routes.includes(r)) existing.routes.push(r)
    }
    // Upgrade to 'form' if any file indicates it's a form
    if (entity.entityType === 'form') existing.entityType = 'form'
  }

  return merged
}

// ─── Write results into metadata pipeline ────────────────────────────────────

async function writeRepoMetadata(projectId: string, entities: Map<string, ParsedEntity>): Promise<number> {
  let written = 0

  for (const [, entity] of entities) {
    if (entity.fields.length === 0 && entity.buttons.length === 0) continue

    // Apply required-field overrides from the global override map
    const patchedFields = applyRequiredFieldOverrides(
      entity.fields.map(f => ({ ...f, locatorType: f.locator_type })),
      entity.name,
    )

    // Determine submit button (first "create/save" button matching the entity)
    const entityLower = entity.name.toLowerCase()
    const submitButton = entity.buttons.find(b => {
      const n = b.toLowerCase()
      return (n.includes('create') || n.includes('save') || n.includes('submit') || n.includes('add'))
        && (n.includes(entityLower) || entityLower.length < 4)
    }) ?? entity.buttons.find(b => {
      const n = b.toLowerCase()
      return n.includes('create') || n.includes('save') || n.includes('submit')
    })

    const openButton = entity.buttons.find(b => {
      const n = b.toLowerCase()
      return (n.includes('new') || n.startsWith('+')) && n.includes(entityLower)
    }) ?? `+New ${entity.name}`

    const entityPlural = entityLower.endsWith('s') ? entityLower : entityLower.endsWith('y') ? entityLower.slice(0, -1) + 'ies' : entityLower + 's'

    // Build structured_json compatible with canonical-builder expectations
    const structuredJson = {
      pages: [{
        path: entity.routes[0] ?? `/${entityPlural}`,
        title: entity.name,
        inputs: patchedFields
          .filter(f => f.type === 'input' || f.type === 'textarea' || f.type === 'lookup')
          .map(f => ({ locator: f.label, required: f.required, type: f.type })),
        selects: patchedFields
          .filter(f => f.type === 'select' || f.type === 'checkbox')
          .map(f => ({ locator: f.label, required: f.required, options: f.options ?? [] })),
        buttons: entity.buttons.map(b => ({ name: b })),
      }],
      source: 'repository',
      parsed_at: new Date().toISOString(),
    }

    // Write to metadata_normalized
    const objectName = entity.name
    await prisma.metadata_normalized.upsert({
      where: {
        // There's no unique constraint on (project_id, entity_type, object_name)
        // so we do a custom lookup
        id: (await prisma.metadata_normalized.findFirst({
          where: { project_id: projectId, entity_type: 'repository_crawl', object_name: objectName },
          select: { id: true },
        }))?.id ?? '00000000-0000-0000-0000-000000000000',
      },
      create: {
        project_id:      projectId,
        object_name:     objectName,
        entity_type:     'repository_crawl',
        label:           entity.name,
        structured_json: structuredJson as any,
      },
      update: {
        structured_json: structuredJson as any,
        label:           entity.name,
      },
    })

    // Write to metadata_canonical with source='repository' (highest priority)
    const requiredFields = patchedFields.filter(f => f.required).map(f => ({ label: f.label, type: f.type }))
    const optionalFields = patchedFields.filter(f => !f.required).map(f => ({ label: f.label, type: f.type }))
    const formFields = patchedFields.map(f => ({
      label: f.label,
      type: f.type,
      required: f.required,
      locator_type: 'label',
      options: f.options,
    }))

    try {
      await prisma.$executeRaw`
        INSERT INTO metadata_canonical (
          project_id, entity_name, entity_type, page_url,
          required_fields, optional_fields, form_fields,
          primary_action_button, all_buttons, source, last_synced_at, version
        )
        VALUES (
          ${projectId}::uuid, ${entity.name}, ${entity.entityType},
          ${entity.routes[0] ?? null},
          ${JSON.stringify(requiredFields)}::jsonb,
          ${JSON.stringify(optionalFields)}::jsonb,
          ${JSON.stringify(formFields)}::jsonb,
          ${submitButton ?? null},
          ${JSON.stringify(entity.buttons)}::jsonb,
          'repository',
          NOW(), 1
        )
        ON CONFLICT (project_id, entity_name) DO UPDATE SET
          entity_type           = EXCLUDED.entity_type,
          page_url              = COALESCE(EXCLUDED.page_url, metadata_canonical.page_url),
          required_fields       = CASE
            WHEN metadata_canonical.source = 'repository' THEN EXCLUDED.required_fields
            ELSE EXCLUDED.required_fields
          END,
          optional_fields       = EXCLUDED.optional_fields,
          form_fields           = EXCLUDED.form_fields,
          primary_action_button = COALESCE(EXCLUDED.primary_action_button, metadata_canonical.primary_action_button),
          all_buttons           = CASE
            WHEN jsonb_array_length(EXCLUDED.all_buttons) > 0 THEN EXCLUDED.all_buttons
            ELSE metadata_canonical.all_buttons
          END,
          source                = 'repository',
          last_synced_at        = NOW(),
          version               = metadata_canonical.version + 1
      `
    } catch (err) {
      log.warn({ err, entity: entity.name }, '[REPO] Failed to write canonical record (non-fatal)')
    }

    written++
    log.info(
      { entity: entity.name, fields: patchedFields.length, buttons: entity.buttons.length },
      '[REPO] Entity written to metadata pipeline',
    )
  }

  return written
}

// ─── Main Sync Function ───────────────────────────────────────────────────────

export async function syncRepoMetadata(projectId: string): Promise<RepoSyncResult> {
  await ensureRepoTable()

  // Get connection record
  const connection = await getRepoConnection(projectId)
  if (!connection) {
    return { success: false, files_indexed: 0, entities_extracted: 0, message: 'No repository connected' }
  }

  // Mark as syncing
  await prisma.$executeRaw`
    UPDATE repo_connections SET status = 'syncing', sync_error = NULL
    WHERE project_id = ${projectId}::uuid
  `

  let warning: string | undefined

  try {
    // Decrypt token
    const encToken = await prisma.$queryRaw<Array<{ access_token: string | null }>>`
      SELECT access_token FROM repo_connections WHERE project_id = ${projectId}::uuid LIMIT 1
    `
    const rawToken = encToken[0]?.access_token
    const token = rawToken ? fernetDecrypt(rawToken) : null

    if (!token && !connection.repo_url.includes('github.com')) {
      warning = 'No access token provided — only public repositories can be indexed without a token'
    }
    if (!token && connection.repo_url.includes('github.com')) {
      warning = 'No access token provided — if this is a private repository, the sync may fail. Set up an access token to avoid this.'
    }

    // Fetch file tree
    let files: RepoFile[] = []
    const provider = connection.provider
    log.info({ projectId, provider, repo: connection.repo_url, branch: connection.branch }, '[REPO] Fetching file tree')

    if (provider === 'github') {
      files = await fetchGitHubTree(connection.repo_url, connection.branch, token)
    } else if (provider === 'gitlab') {
      files = await fetchGitLabTree(connection.repo_url, connection.branch, token)
    } else if (provider === 'bitbucket') {
      files = await fetchBitbucketTree(connection.repo_url, connection.branch, token)
    } else {
      throw new Error(`Unsupported provider: ${provider}`)
    }

    log.info({ projectId, fileCount: files.length }, '[REPO] Files fetched — starting parse')

    // Parse files in batches of 20 (avoid rate limiting)
    const allEntities: ParsedEntity[] = []
    const BATCH_SIZE = 20

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE)
      await Promise.all(batch.map(async file => {
        if (!file.download_url) return
        try {
          const content = await fetchFileContent(file.download_url, token, provider)
          if (!content || content.length < 50) return
          const parsed = parseSourceFile(content, file.path)
          if (parsed) allEntities.push(parsed)
        } catch (err) {
          log.warn({ file: file.path, err }, '[REPO] Failed to parse file (non-fatal)')
        }
      }))
    }

    // Merge entities from multiple files
    const mergedEntities = mergeEntities(allEntities)
    log.info({ projectId, entityCount: mergedEntities.size }, '[REPO] Entities merged')

    // Write to metadata pipeline
    const entitiesWritten = await writeRepoMetadata(projectId, mergedEntities)

    // Update sync status
    await prisma.$executeRaw`
      UPDATE repo_connections
      SET status = 'connected', last_synced_at = NOW(), sync_error = NULL
      WHERE project_id = ${projectId}::uuid
    `

    const result: RepoSyncResult = {
      success: true,
      files_indexed: files.length,
      entities_extracted: entitiesWritten,
      message: `Repository sync complete: ${files.length} files indexed, ${entitiesWritten} entities extracted`,
    }
    if (warning) result.warning = warning

    log.info({ projectId, ...result }, '[REPO] Sync complete')
    return result

  } catch (err: any) {
    const errMsg = err?.message ?? String(err)
    log.error({ projectId, err }, '[REPO] Sync failed')

    // Mark as error
    await prisma.$executeRaw`
      UPDATE repo_connections
      SET status = 'error', sync_error = ${errMsg}
      WHERE project_id = ${projectId}::uuid
    `

    return {
      success: false,
      files_indexed: 0,
      entities_extracted: 0,
      message: `Repository sync failed: ${errMsg}`,
    }
  }
}

/**
 * Check whether a project has a connected repository.
 * Used by the sync route to decide whether to attempt repo sync first.
 */
export async function hasRepoConnection(projectId: string): Promise<boolean> {
  await ensureRepoTable()
  const rows = await prisma.$queryRaw<Array<{ status: string }>>`
    SELECT status FROM repo_connections
    WHERE project_id = ${projectId}::uuid AND status IN ('connected', 'syncing')
    LIMIT 1
  `
  return rows.length > 0
}
