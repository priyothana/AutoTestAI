/**
 * Project Module — Routes (Fastify Plugin)
 *
 * Registered in index.ts as: app.register(projectRoutes, { prefix: '/api/v1' })
 *
 * Core task-spec routes (POST/GET/PUT/DELETE projects + integrations):
 *   POST   /api/v1/projects/
 *   GET    /api/v1/projects/
 *   GET    /api/v1/projects/:id
 *   PUT    /api/v1/projects/:id
 *   DELETE /api/v1/projects/:id
 *   POST   /api/v1/projects/:id/integrations   ← task-spec canonical route
 *   GET    /api/v1/projects/:id/integrations   ← task-spec canonical route
 *
 * Additional routes (Python parity — frontend uses these):
 *   POST   /api/v1/projects/:id/connect
 *   DELETE /api/v1/projects/:id/disconnect
 *   POST   /api/v1/projects/:id/save-sf-credentials
 *   POST   /api/v1/projects/:id/save-web-credentials
 *   GET    /api/v1/projects/:id/integration-status
 *   GET    /api/v1/integrations/salesforce/auth-url
 *   GET    /api/v1/integrations/salesforce/callback
 *
 * Web App Metadata Sync:
 *   POST   /api/v1/projects/:id/sync-webapp-metadata  ← Playwright crawler pipeline
 *   GET    /api/v1/projects/:id/sync-status           ← Live progress polling for UI
 *
 * Jira:
 *   POST   /api/v1/jira/connect
 *   POST   /api/v1/jira/boards
 *   POST   /api/v1/jira/board-issues
 *   POST   /api/v1/jira/projects/:id/config
 *   GET    /api/v1/jira/projects/:id/config
 *   GET    /api/v1/jira/projects/:id/stories
 */
import type { FastifyInstance } from 'fastify'
import {
  ProjectCreateSchema,
  ProjectUpdateSchema,
  ConnectProjectSchema,
  SalesforceCredentialsSchema,
  JiraConnectSchema,
  JiraBoardsSchema,
  JiraBoardIssuesSchema,
  JiraProjectConfigSchema,
  KeycloakTokenSchema,
  RepoConnectionSchema,
} from './project.schema.js'
import * as svc from './project.service.js'
import {
  generateBusinessFlows,
  workflowRefinementChat,
  filterTestCasesChat,
  generateTestSuite,
} from './workflow-chat.service.js'
import { syncWebappMetadata } from '../webapp/webapp.service.js'
import {
  extractTestData,
  storeUploadedTestData,
  getTestData,
  clearTestData,
  deleteTestDataEntity,
} from '../webapp/webapp-test-data.service.js'
import {
  saveRepoConnection,
  getRepoConnection,
  deleteRepoConnection,
  syncRepoMetadata,
  hasRepoConnection,
} from '../webapp/repository-metadata-extractor.service.js'
import prisma from '../../shared/db/prisma.js'
import { createModuleLogger } from '../../shared/logger/index.js'

const log = createModuleLogger('project-routes')

/** Tiny helper — re-throw platform errors as Fastify HTTP replies */

function handleErr(err: any, reply: any) {
  if (err?.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
  throw err
}

export async function projectRoutes(app: FastifyInstance) {
  // ─── Project CRUD ───────────────────────────────────────────────

  // POST /api/v1/projects/  →  201 + project
  app.post('/projects', async (request, reply) => {
    try {
      const body = ProjectCreateSchema.parse(request.body)
      const project = await svc.createProject(body)
      return reply.status(201).send(project)
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // GET /api/v1/projects/  →  200 + project[]
  app.get('/projects', async (request, reply) => {
    const q = request.query as any
    const projects = await svc.listProjects({
      skip: q.skip ? parseInt(q.skip, 10) : 0,
      limit: q.limit ? parseInt(q.limit, 10) : 10,
      search: q.search ?? undefined,
      status: q.status ?? undefined,
      type: q.type ?? undefined,
    })
    return reply.send(projects)
  })

  // GET /api/v1/projects/:id  →  200 + project | 404
  app.get('/projects/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const project = await svc.getProject(id)
      return reply.send(project)
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // PUT /api/v1/projects/:id  →  200 + project | 404
  app.put('/projects/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = ProjectUpdateSchema.parse(request.body)
      const project = await svc.updateProject(id, body)
      return reply.send(project)
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // DELETE /api/v1/projects/:id  →  204 | 404  (soft-delete → Archived)
  app.delete('/projects/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      await svc.deleteProject(id)
      return reply.status(204).send()
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // DELETE /api/v1/projects/:id/permanent  →  204 | 404  (hard-delete — irreversible)
  app.delete('/projects/:id/permanent', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      await svc.hardDeleteProject(id)
      return reply.status(204).send()
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // ─── Task-Spec Integration Routes ───────────────────────────────
  // POST /api/v1/projects/:id/integrations  →  201 + integration
  app.post('/projects/:id/integrations', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = ConnectProjectSchema.parse(request.body)
      const integration = await svc.createIntegration(id, body)
      return reply.status(201).send({
        status: 'connected',
        category: body.category,
        integration_id: integration.id,
        message: `${body.category} integration created successfully`,
      })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // GET /api/v1/projects/:id/integrations  →  200 + integration[]
  app.get('/projects/:id/integrations', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const integrations = await svc.getProjectIntegrations(id)
      return reply.send(integrations)
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // ─── Legacy Integration Routes (Python parity) ──────────────────

  // POST /api/v1/projects/:id/connect  →  200 + {status, category, integration_id}
  app.post('/projects/:id/connect', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = ConnectProjectSchema.parse(request.body)
      const category = body.category.toLowerCase()

      if (category === 'web_app') {
        if (!body.base_url) {
          return reply.status(400).send({ detail: 'base_url is required for web_app' })
        }
        const authConfig = {
          sitemap_url: body.sitemap_url ?? null,
          max_crawl_pages: body.max_crawl_pages ?? 30,
          key_routes: body.key_routes ?? [],
          enable_deep_crawl: body.enable_deep_crawl ?? false,
        }

        const integration = await svc.createWebIntegration(
          id,
          body.base_url,
          body.username ?? null,
          body.password ?? null,
          body.login_strategy ?? 'form',
          authConfig
        )
        return reply.send({
          status: 'connected',
          category: 'web_app',
          integration_id: integration.id,
          message: 'Web application connected successfully',
        })
      }

      if (category === 'salesforce') {
        return reply.send({
          status: 'pending_oauth',
          category: 'salesforce',
          auth_url: '',
          message: 'Redirect user to auth_url to complete Salesforce OAuth',
        })
      }

      if (category === 'api') {
        const integration = await svc.createApiIntegration(
          id,
          body.base_url ?? null,
          body.api_key ?? null,
          body.bearer_token ?? null,
        )
        return reply.send({
          status: 'connected',
          category: 'api',
          integration_id: integration.id,
          message: 'API integration connected successfully',
        })
      }

      return reply.status(400).send({
        detail: `Unsupported category: '${category}'. Use 'web_app', 'salesforce', or 'api'.`,
      })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // DELETE /api/v1/projects/:id/disconnect  →  204 | 404
  app.delete('/projects/:id/disconnect', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const deleted = await svc.deleteIntegration(id)
      if (!deleted) {
        return reply.status(404).send({ detail: 'No integration found for this project' })
      }
      return reply.status(204).send()
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // ── Web App Metadata Sync ─────────────────────────────────────────────────
  // POST /api/v1/projects/:id/sync-webapp-metadata
  //
  // Priority chain:
  //   1. Repository extractor (highest priority) — if a repo is connected
  //   2. Playwright crawler (always runs as safety-net fallback)
  //
  // Returns immediately with combined results from both sources.
  app.post('/projects/:id/sync-webapp-metadata', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }

      let repoResult: { success: boolean; files_indexed: number; entities_extracted: number; message: string; warning?: string } | null = null

      // ── Priority 1: Repository sync ────────────────────────────────────────
      const repoConnected = await hasRepoConnection(id)
      if (repoConnected) {
        log.info({ projectId: id }, '[SYNC] Repository connected — running repo extractor first')
        repoResult = await syncRepoMetadata(id)
        if (repoResult.success) {
          log.info({ projectId: id, ...repoResult }, '[SYNC] Repository sync succeeded')
        } else {
          log.warn({ projectId: id, message: repoResult.message }, '[SYNC] Repository sync failed — continuing with crawler')
        }
      }

      // ── Priority 2: Playwright crawler (always runs) ───────────────────────
      const crawlerResult = await syncWebappMetadata(id)

      // Combine results
      return reply.send({
        ...crawlerResult,
        repo_sync: repoResult ?? null,
      })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // GET /api/v1/projects/:id/sync-status
  // Lightweight polling endpoint used by the frontend to track live metadata
  // sync progress. Returns current DB counts for all 4 pipeline stages plus
  // an inferred "active_stage", crawl progress info, and last_synced_at.
  app.get('/projects/:id/sync-status', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }

      const [rawCount, normalizedCount, domainCount, embeddingCount, integration] = await Promise.all([
        prisma.metadata_raw_store.count({ where: { project_id: id } }),
        prisma.metadata_normalized.count({ where: { project_id: id } }),
        prisma.domain_models.count({ where: { project_id: id } }),
        prisma.vector_embeddings.count({ where: { project_id: id } }),
        prisma.project_integrations.findFirst({ where: { project_id: id } }),
      ])

      // ── Crawl state (incremental progress) ──────────────────────────────────────────
      let has_more_pages = false
      let crawled_so_far = 0
      let total_discovered = 0
      let progress_message: string | null = null

      if (integration?.auth_config && typeof integration.auth_config === 'object') {
        const conf = integration.auth_config as Record<string, any>
        const crawlState = conf.crawl_state as {
          visitedUrls?: string[]
          pendingUrls?: string[]
          totalDiscoveredPages?: number
          runCount?: number
        } | null | undefined

        if (crawlState && typeof crawlState === 'object') {
          crawled_so_far    = crawlState.visitedUrls?.length ?? 0
          const pending     = crawlState.pendingUrls?.length ?? 0
          total_discovered  = crawlState.totalDiscoveredPages ?? (crawled_so_far + pending)
          has_more_pages    = pending > 0

          if (has_more_pages) {
            progress_message = `Crawled ${crawled_so_far} of ${total_discovered} pages — continuing automatically…`
          } else if (crawled_so_far > 0) {
            progress_message = `Crawl complete — ${crawled_so_far} pages discovered and extracted`
          }
        }
      }

      // ── Actual page counts (from JSON arrays, not DB row counts) ──────────────────
      // For web-app projects, raw_store and metadata_normalized each hold ONE DB row
      // that contains an array of pages inside raw_json / structured_json.
      // The UI should show the page counts (array lengths), not the DB row count (always 1).
      let pages_crawled      = 0
      let normalized_pages   = 0

      if (rawCount > 0) {
        const rawRow = await prisma.metadata_raw_store.findFirst({
          where: { project_id: id, metadata_type: 'webpage' },
          select: { raw_json: true },
        })
        if (rawRow?.raw_json) {
          const rd = rawRow.raw_json as { pages?: unknown[] }
          pages_crawled = rd.pages?.length ?? 0
        }
      }

      if (normalizedCount > 0) {
        // Prefer webapp_crawl normalized row; fall back to counting rows for non-webapp projects
        const normRow = await prisma.metadata_normalized.findFirst({
          where: { project_id: id, entity_type: 'webapp_crawl' },
          select: { structured_json: true },
        })
        if (normRow?.structured_json) {
          const nd = normRow.structured_json as { pages?: unknown[] }
          normalized_pages = nd.pages?.length ?? 0
        }
        // Non-webapp (Salesforce etc.): fall back to row count
        if (normalized_pages === 0) normalized_pages = normalizedCount
      }

      // crawled_so_far: prefer raw_json.pages count over crawl_state.visitedUrls
      // (visitedUrls only tracks the CURRENT run, not cumulative across continuation runs)
      if (pages_crawled > 0) crawled_so_far = pages_crawled
      else if (crawled_so_far === 0 && rawCount > 0) crawled_so_far = rawCount

      // ── Active stage inference ───────────────────────────────────────────────────────
      // IMPORTANT: if has_more_pages is true the crawl is still running (stage 1).
      // Stale embeddings from a previous sync must NOT make it appear complete.
      let active_stage: number | null = null
      if (has_more_pages) {
        active_stage = 1             // crawl still in progress
      } else if (embeddingCount > 0 && normalized_pages > 0) {
        active_stage = null          // all stages done
      } else if (domainCount > 0) {
        active_stage = 4             // generating embeddings
      } else if (normalized_pages > 0) {
        active_stage = 3             // building domain models
      } else if (rawCount > 0) {
        active_stage = 2             // normalizing
      } else {
        active_stage = 1             // crawling (nothing in DB yet)
      }

      return reply.send({
        raw_count:          rawCount,
        pages_crawled,          // ← actual page count (from raw_json.pages.length)
        normalized_count:   normalized_pages,   // ← actual normalized page count
        domain_model_count: domainCount,
        embedding_count:    embeddingCount,
        active_stage,
        last_synced_at:     integration?.last_synced_at?.toISOString() ?? null,
        sync_error:         integration?.sync_error ?? null,
        // ── Crawl progress ────────────────────────────────
        has_more_pages,
        crawled_so_far,
        total_discovered,
        progress_message,
      })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // ── Phase 2: Test Data Routes ────────────────────────────────────────────────

  // GET /api/v1/projects/:id/test-data
  // Returns all test-data entities for the project (name, count, source, sample records)
  app.get('/projects/:id/test-data', async (request, reply) => {
    try {
      const { id }  = request.params as { id: string }
      const entities = await getTestData(id)
      return reply.send({ entities })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // POST /api/v1/projects/:id/test-data/extract
  // Triggers OpenAPI probe (Tier 1) + Playwright UI scraping (Tier 2).
  // Returns 202 immediately — Playwright takes 30-60s so we run it in background.
  // Poll GET /test-data for results.
  app.post('/projects/:id/test-data/extract', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const log    = request.log

      // Fire extraction as background task so HTTP response is immediate
      setImmediate(async () => {
        try {
          log.info(`[EXTRACT] Background extraction started for project ${id}`)
          const count = await extractTestData(id)
          log.info(`[EXTRACT] Background extraction complete — ${count} entities for project ${id}`)
        } catch (bgErr) {
          log.error({ err: bgErr }, `[EXTRACT] Background extraction failed for project ${id}`)
        }
      })

      return reply.status(202).send({
        success: true,
        status:  'started',
        message: 'Extraction started — scraping your app in the background. Check back in 30-60 seconds.',
        polling_hint: `GET /api/v1/projects/${id}/test-data`,
      })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // DELETE /api/v1/projects/:id/test-data
  // Clears ALL test-data entities for a project.
  // Useful to remove stale/wrong entities (e.g. Salesforce CRM entities on a web app project).
  app.delete('/projects/:id/test-data', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const deleted = await clearTestData(id)
      return reply.send({ success: true, deleted_count: deleted, message: `Cleared ${deleted} test data entities` })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // DELETE /api/v1/projects/:id/test-data/:entityName
  // Deletes a single test-data entity by name for a project.
  app.delete('/projects/:id/test-data/:entityName', async (request, reply) => {
    try {
      const { id, entityName } = request.params as { id: string; entityName: string }
      const deleted = await deleteTestDataEntity(id, decodeURIComponent(entityName))
      if (!deleted) {
        return reply.status(404).send({ detail: `Entity '${entityName}' not found for this project` })
      }
      return reply.send({ success: true, message: `Entity '${entityName}' deleted` })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // POST /api/v1/projects/:id/test-data/upload
  // Accepts { data: { Entity: [records…] } } and upserts with source='user_upload'.
  // User-uploaded records always win over scraped data.
  app.post('/projects/:id/test-data/upload', async (request, reply) => {
    try {
      const { id }  = request.params as { id: string }
      const body    = request.body as { data?: Record<string, Record<string, unknown>[]> }

      if (!body?.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
        return reply.status(400).send({
          detail: 'Invalid payload. Expected: { "data": { "EntityName": [{ field: value,… }] } }',
        })
      }

      const result = await storeUploadedTestData(id, body.data)
      return reply.send({
        success:         true,
        entities_stored: result.entitiesStored,
        total_records:   result.totalRecords,
        preview:         result.preview,
        message:         `Uploaded ${result.entitiesStored} entities with ${result.totalRecords} total records`,
      })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // POST /api/v1/projects/:id/save-sf-credentials  →  200 + {success, environmentId, message}
  app.post('/projects/:id/save-sf-credentials', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }

      // ── TASK 1: Zod input validation ──────────────────────────
      let body: ReturnType<typeof SalesforceCredentialsSchema.parse>
      try {
        body = SalesforceCredentialsSchema.parse(request.body)
      } catch (zodErr: any) {
        // Map Zod issues to field-level error messages
        const fields: Record<string, string> = {}
        for (const issue of zodErr?.issues ?? []) {
          const field = issue.path[0] as string | undefined
          if (field) fields[field] = issue.message
        }
        return reply.status(400).send({
          success: false,
          error: 'VALIDATION_ERROR',
          fields,
        })
      }

      // ── Save credentials (Fernet-encrypted) to DB ─────────────
      const integration = await svc.saveSfCredentials(id, body)

      // ── TASK 2: Test credentialed JSforce login ────────────────
      // Only attempt if sf_username + sf_password were provided; Connected
      // App credentials alone are valid for OAuth but cannot be verified
      // via jsforce.login() — skip the live test in that case.
      if (body.sf_username && body.sf_password) {
        try {
          const { default: jsforce } = await import('jsforce')
          const loginUrl = body.login_url ?? 'https://login.salesforce.com'
          const conn = new jsforce.Connection({ loginUrl })

          // JSForce requires password = password + securityToken (concatenated, no separator)
          const securityToken: string = body.sf_security_token ?? ''
          const passwordWithToken = body.sf_password + securityToken

          await conn.login(body.sf_username, passwordWithToken)
        } catch (jsErr: any) {
          const msg: string = (jsErr?.message ?? String(jsErr)).toLowerCase()

          let errorCode = 'CONNECTION_FAILED'
          if (msg.includes('invalid_client') || msg.includes('invalid client')) {
            errorCode = 'INVALID_CLIENT'
          } else if (
            msg.includes('authentication failure') ||
            msg.includes('invalid password') ||
            msg.includes('invalid credentials') ||
            msg.includes('login failed')
          ) {
            errorCode = 'INVALID_CREDENTIALS'
          } else if (
            msg.includes('timeout') ||
            msg.includes('econnrefused') ||
            msg.includes('enotfound')
          ) {
            errorCode = 'CONNECTION_TIMEOUT'
          } else if (
            msg.includes('invalid login url') ||
            msg.includes('invalid url') ||
            msg.includes('invalid_login_url')
          ) {
            errorCode = 'INVALID_URL'
          }

          return reply.status(401).send({ success: false, error: errorCode })
        }
      }

      // ── TASK 3: Success — always include environmentId ─────────
      return reply.send({
        success: true,
        environmentId: integration.id,
        message: 'Connected successfully',
        // Legacy fields (kept so existing callers are unbroken)
        status: 'credentials_saved',
        integration_id: integration.id,
        redirect_uri: integration.salesforce_redirect_uri,
        login_url: integration.salesforce_login_url,
      })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // POST /api/v1/projects/:id/save-web-credentials  →  200 + {success, message}
  // Saves/updates login credentials for a web_app integration without full reconnect.
  app.post('/projects/:id/save-web-credentials', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as {
        login_url?: string
        username?: string
        password?: string
        login_strategy?: string
      }
      await svc.saveWebAppCredentials(id, {
        login_url: body.login_url,
        username: body.username,
        password: body.password,
        login_strategy: body.login_strategy,
      })
      return reply.send({ success: true, message: 'Web app credentials saved successfully' })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // GET /api/v1/projects/:id/integration-status  →  200 + IntegrationStatusResponse
  app.get('/projects/:id/integration-status', async (request, reply) => {
    const { id } = request.params as { id: string }
    const status = await svc.getIntegrationStatus(id)
    return reply.send(status)
  })

  // ─── Salesforce OAuth Endpoints ─────────────────────────────────

  // GET /api/v1/integrations/salesforce/auth-url
  app.get('/integrations/salesforce/auth-url', async (request, reply) => {
    // Salesforce OAuth URL generation is handled in the salesforce module.
    // This route acts as a pass-through stub maintaining Python parity.
    const query = request.query as { project_id?: string }
    return reply.send({ auth_url: '' })
  })

  // GET /api/v1/integrations/salesforce/callback
  app.get('/integrations/salesforce/callback', async (request, reply) => {
    const query = request.query as { state?: string; code?: string; error?: string }
    // After OAuth, redirect back to the project page in the frontend
    return reply.redirect(
      `http://localhost:3000/dashboard/projects/${query.state ?? ''}`,
    )
  })

  // ─── Jira Routes ────────────────────────────────────────────────

  // POST /api/v1/jira/connect  →  200 + {connected, user}
  app.post('/jira/connect', async (request, reply) => {
    try {
      const body = JiraConnectSchema.parse(request.body)
      const result = await svc.jiraConnect(body)
      return reply.send(result)
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // POST /api/v1/jira/boards  →  200 + { boards: board[] }
  app.post('/jira/boards', async (request, reply) => {
    try {
      const body = JiraBoardsSchema.parse(request.body)
      const boards = await svc.jiraBoards(body)
      // Wrap in { boards: [...] } to match Python FastAPI contract
      return reply.send({ boards })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // POST /api/v1/jira/board-issues  →  200 + issue[]
  app.post('/jira/board-issues', async (request, reply) => {
    try {
      const body = JiraBoardIssuesSchema.parse(request.body)
      const issues = await svc.jiraBoardIssues(
        body.jira_domain,
        body.jira_email,
        body.jira_token,
        body.board_id,
      )
      return reply.send(issues)
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // POST /api/v1/jira/projects/:id/config  →  200 + {status, config}
  app.post('/jira/projects/:id/config', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = JiraProjectConfigSchema.parse(request.body)
      const config = await svc.saveJiraConfig(id, body)
      return reply.send({
        status: 'configured',
        message: 'Jira configuration saved successfully',
        config,
      })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // GET /api/v1/jira/projects/:id/config  →  200 + config | {configured: false}
  app.get('/jira/projects/:id/config', async (request, reply) => {
    const { id } = request.params as { id: string }
    const config = await svc.getJiraConfig(id)
    return reply.send(config ?? { configured: false })
  })

  // GET /api/v1/jira/projects/:id/stories  →  200 + issue[]
  app.get('/jira/projects/:id/stories', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const stories = await svc.getJiraStories(id)
      return reply.send(stories)
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // ─── BRD Persistence Routes ──────────────────────────────────────

  // POST /api/v1/projects/:id/brd  →  200 + {success}
  // Body: { filename: string, content: string }
  app.post('/projects/:id/brd', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { filename?: string; content?: string }

      if (!body?.filename || !body?.content) {
        return reply.status(400).send({ detail: 'filename and content are required' })
      }

      await svc.saveBrd(id, body.filename, body.content)
      return reply.send({ success: true, filename: body.filename, bytes: Buffer.byteLength(body.content, 'utf8') })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // GET /api/v1/projects/:id/brd  →  200 + {filename, content, bytes} | 200 + {attached: false}
  app.get('/projects/:id/brd', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const brd = await svc.getBrd(id)
      if (!brd) return reply.send({ attached: false })
      return reply.send({ attached: true, ...brd })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })


  // DELETE /api/v1/projects/:id/brd  →  200 + {success}
  app.delete('/projects/:id/brd', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      await svc.deleteBrd(id)
      return reply.send({ success: true })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // ─── Existing Tests Persistence Routes ───────────────────────────

  // POST /api/v1/projects/:id/existing-tests  →  200 + {success}
  // Body: { filename: string, content: string }
  app.post('/projects/:id/existing-tests', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { filename?: string; content?: string }

      if (!body?.filename || !body?.content) {
        return reply.status(400).send({ detail: 'filename and content are required' })
      }

      await svc.saveExistingTests(id, body.filename, body.content)
      return reply.send({ success: true, filename: body.filename, bytes: Buffer.byteLength(body.content, 'utf8') })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // GET /api/v1/projects/:id/existing-tests  →  200 + {filename, content, bytes} | {attached: false}
  app.get('/projects/:id/existing-tests', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const doc = await svc.getExistingTests(id)
      if (!doc) return reply.send({ attached: false })
      return reply.send({ attached: true, ...doc })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // DELETE /api/v1/projects/:id/existing-tests  →  200 + {success}
  app.delete('/projects/:id/existing-tests', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      await svc.deleteExistingTests(id)
      return reply.send({ success: true })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })
  // ─── AI Workflow Chat Endpoints ──────────────────────────────────────────────

  // POST /api/v1/projects/:id/generate-workflows
  // Generates a list of business flow / end-to-end journey options from metadata + BRD.
  // Body: { brdContent?: string }
  app.post('/projects/:id/generate-workflows', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { brdContent?: string; existingTestsContent?: string }
      const result = await generateBusinessFlows(id, body.brdContent, body.existingTestsContent)
      return reply.send(result)
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // POST /api/v1/projects/:id/workflow-chat
  // Conversational refinement — AI asks clarifying questions about the selected business flow.
  // Body: { flow, history, userMessage, brdContent? }
  app.post('/projects/:id/workflow-chat', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as {
        flow:        string
        history:     { role: 'user' | 'assistant'; content: string }[]
        userMessage: string
        brdContent?: string
        existingTestsContent?: string
      }
      const result = await workflowRefinementChat({
        projectId:   id,
        flow:        body.flow,
        history:     body.history ?? [],
        userMessage: body.userMessage,
        brdContent:  body.brdContent,
        existingTestsContent: body.existingTestsContent,
      })
      return reply.send(result)
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // POST /api/v1/projects/:id/filter-test-cases-chat
  // Natural-language filtering of generated test cases.
  // Body: { instruction, history, testCases, currentSelectedIds }
  app.post('/projects/:id/filter-test-cases-chat', async (request, reply) => {
    try {
      const body = request.body as {
        instruction:        string
        history:            { role: 'user' | 'assistant'; content: string }[]
        testCases:          { id: string; name: string; priority: string; description?: string | null }[]
        currentSelectedIds: string[]
      }
      const result = await filterTestCasesChat({
        instruction:        body.instruction,
        history:            body.history ?? [],
        testCases:          body.testCases ?? [],
        currentSelectedIds: body.currentSelectedIds ?? [],
      })
      return reply.send(result)
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // POST /api/v1/projects/:id/generate-test-suite
  // Multi-flow test suite generation: generates & persists TCs for all selected flows,
  // returns grouped + AI-ordered FlowGroup[] ready for the full-page wizard review.
  // Body: { flows: string[], brdContent?: string }
  app.post('/projects/:id/generate-test-suite', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { flows: string[]; brdContent?: string; existingTestsContent?: string }
      if (!Array.isArray(body.flows) || body.flows.length === 0) {
        return reply.status(400).send({ error: 'flows array is required' })
      }
      const result = await generateTestSuite({
        projectId:  id,
        flows:      body.flows,
        brdContent: body.brdContent,
        existingTestsContent: body.existingTestsContent,
      })
      return reply.send(result)
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // ─── Keycloak / OAuth Custom Token Routes ──────────────────────────────

  /**
   * POST /api/v1/projects/:id/save-keycloak-tokens
   *
   * Accepts the HMAC-signed auth_token and Keycloak id_token that were
   * captured after a successful Keycloak SSO login, Fernet-encrypts them,
   * and stores them in auth_config alongside an expiry timestamp.
   *
   * Body: { auth_token, id_token?, refresh_url?, expires_at? }
   *
   * This is the main ingestion endpoint — called either:
   *  a) Manually from the project Integration tab UI, or
   *  b) Programmatically by the DS Logistics backend after Keycloak login.
   */
  app.post('/projects/:id/save-keycloak-tokens', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      let body: ReturnType<typeof KeycloakTokenSchema.parse>
      try {
        body = KeycloakTokenSchema.parse(request.body)
      } catch (zodErr: any) {
        const fields: Record<string, string> = {}
        for (const issue of zodErr?.issues ?? []) {
          const field = issue.path[0] as string | undefined
          if (field) fields[field] = issue.message
        }
        return reply.status(400).send({ success: false, error: 'VALIDATION_ERROR', fields })
      }

      await svc.saveKeycloakTokens(id, body)
      return reply.send({
        success: true,
        message: 'Keycloak tokens saved. Session is ready for test execution.',
        login_strategy: 'keycloak',
        expires_at: body.expires_at ?? (Date.now() + 24 * 60 * 60 * 1000),
      })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  /**
   * GET /api/v1/projects/:id/keycloak-session
   *
   * Returns the current Keycloak session status for the project:
   *  - Whether tokens are stored
   *  - Whether the token is still valid or near/past expiry
   *  - The token expiry timestamp
   *  - The configured refresh URL
   *
   * Does NOT return the raw token value (security — tokens are server-side only).
   */
  app.get('/projects/:id/keycloak-session', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const session = await svc.getKeycloakSession(id)

      if (!session) {
        return reply.send({
          configured: false,
          message: 'No Keycloak tokens stored for this project.',
        })
      }

      const now = Date.now()
      const msRemaining = session.expires_at - now
      const isExpired = msRemaining <= 0
      const isNearExpiry = !isExpired && msRemaining < 5 * 60 * 1000

      return reply.send({
        configured: true,
        is_expired: isExpired,
        is_near_expiry: isNearExpiry,
        expires_at: session.expires_at,
        expires_at_iso: new Date(session.expires_at).toISOString(),
        ms_remaining: Math.max(0, msRemaining),
        has_id_token: !!session.id_token,
        refresh_url: session.refresh_url,
        status: isExpired ? 'expired' : isNearExpiry ? 'expiring_soon' : 'valid',
      })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  /**
   * DELETE /api/v1/projects/:id/keycloak-session
   *
   * Clears the stored Keycloak tokens and resets login_strategy back to 'form'.
   * Use this when tokens are revoked or the project no longer uses Keycloak.
   */
  app.delete('/projects/:id/keycloak-session', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      await svc.clearKeycloakSession(id)
      return reply.send({
        success: true,
        message: 'Keycloak session cleared. Login strategy reset to form-based.',
      })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  // ─── Repository Connection ─────────────────────────────────────────────────

  /**
   * POST /api/v1/projects/:id/repo-connect
   * Save or update repository connection credentials.
   * Access token is Fernet-encrypted before storage.
   */
  app.post('/projects/:id/repo-connect', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = RepoConnectionSchema.parse(request.body)
      await saveRepoConnection(id, {
        repo_url:     body.repo_url,
        branch:       body.branch,
        access_token: body.access_token ?? null,
        provider:     body.provider,
      })
      return reply.status(201).send({
        success: true,
        message: 'Repository connected successfully. Run "Sync Metadata" to index source files.',
      })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  /**
   * GET /api/v1/projects/:id/repo-status
   * Return current repository connection status (without the encrypted token).
   */
  app.get('/projects/:id/repo-status', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const conn = await getRepoConnection(id)
      if (!conn) {
        return reply.send({ connected: false, repo_url: null, branch: null, provider: null, status: 'disconnected' })
      }
      return reply.send({
        connected: conn.status === 'connected' || conn.status === 'syncing',
        repo_url:       conn.repo_url,
        branch:         conn.branch,
        provider:       conn.provider,
        status:         conn.status,
        last_synced_at: conn.last_synced_at,
        sync_error:     conn.sync_error,
      })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  /**
   * DELETE /api/v1/projects/:id/repo-disconnect
   * Remove the repository connection and all repo-sourced metadata.
   */
  app.delete('/projects/:id/repo-disconnect', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      await deleteRepoConnection(id)
      return reply.send({ success: true, message: 'Repository disconnected and repo metadata removed.' })
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })

  /**
   * POST /api/v1/projects/:id/sync-repo-metadata
   * Trigger a standalone repository sync (without running the Playwright crawler).
   * Useful for quick re-syncs when only the source code has changed.
   */
  app.post('/projects/:id/sync-repo-metadata', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const result = await syncRepoMetadata(id)
      return reply.status(result.success ? 200 : 500).send(result)
    } catch (err: any) {
      return handleErr(err, reply)
    }
  })
}


