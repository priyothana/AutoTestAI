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
 *   GET    /api/v1/projects/:id/integration-status
 *   GET    /api/v1/integrations/salesforce/auth-url
 *   GET    /api/v1/integrations/salesforce/callback
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
        const integration = await svc.createWebIntegration(
          id,
          body.base_url,
          body.username ?? null,
          body.password ?? null,
          body.login_strategy ?? 'form',
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

  // POST /api/v1/projects/:id/save-sf-credentials  →  200 + {status, redirect_uri, login_url}
  app.post('/projects/:id/save-sf-credentials', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = SalesforceCredentialsSchema.parse(request.body)
      const integration = await svc.saveSfCredentials(id, body)
      return reply.send({
        status: 'credentials_saved',
        integration_id: integration.id,
        message: 'Connected App credentials saved. You can now initiate OAuth.',
        redirect_uri: integration.salesforce_redirect_uri,
        login_url: integration.salesforce_login_url,
      })
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
