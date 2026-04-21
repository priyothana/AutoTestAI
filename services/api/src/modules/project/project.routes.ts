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
} from './project.schema.js'
import * as svc from './project.service.js'
import { syncWebappMetadata } from '../webapp/webapp.service.js'
import {
  extractTestData,
  storeUploadedTestData,
  getTestData,
} from '../webapp/webapp-test-data.service.js'
import prisma from '../../shared/db/prisma.js'

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
  // Enqueues a Playwright crawl + normalize + domain-build + embed job on the
  // metadata-sync-queue (same worker, different pipeline branch).
  // Returns immediately with status='queued' or 'completed' (inline fallback).
  app.post('/projects/:id/sync-webapp-metadata', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const result = await syncWebappMetadata(id)
      return reply.send(result)
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

      // Infer which stage is active based on which counts have non-zero values.
      // Stage progresses: 1 (crawl) → 2 (normalize) → 3 (domain) → 4 (embed) → done
      let active_stage: number | null = null
      if (embeddingCount > 0) active_stage = null   // all done
      else if (domainCount > 0) active_stage = 4     // generating embeddings
      else if (normalizedCount > 0) active_stage = 3 // building domain models
      else if (rawCount > 0) active_stage = 2        // normalizing
      else active_stage = 1                          // crawling (nothing in DB yet)

      // ── Crawl state (incremental progress) ──────────────────────────────────
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

      // Fall back to raw_count from DB if crawl_state hasn't been set yet
      if (crawled_so_far === 0 && rawCount > 0) {
        // Approximate from the raw store page count
        const rawRow = await prisma.metadata_raw_store.findFirst({
          where: { project_id: id, metadata_type: 'webpage' },
          select: { raw_json: true },
        })
        if (rawRow?.raw_json) {
          const rd = rawRow.raw_json as { pages?: unknown[] }
          crawled_so_far = rd.pages?.length ?? 0
        }
      }

      return reply.send({
        raw_count:          rawCount,
        normalized_count:   normalizedCount,
        domain_model_count: domainCount,
        embedding_count:    embeddingCount,
        active_stage,
        last_synced_at:     integration?.last_synced_at?.toISOString() ?? null,
        sync_error:         integration?.sync_error ?? null,
        // ── Crawl progress ──────────────────────────────────────
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
}
