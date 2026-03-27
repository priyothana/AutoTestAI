/**
 * Salesforce Module — Routes
 *
 * Covers:
 *   • Legacy salesforce.py endpoints (connections, metadata-status, RAG)
 *   • MCP control endpoints (mcp.py)
 *   • NEW: Metadata query endpoints required by salesforce.service.ts
 *       GET /api/salesforce/metadata/:objectName
 *       GET /api/salesforce/fields/:objectName
 *       GET /api/salesforce/picklist/:objectName/:fieldName
 *
 * Every path here is prefixed with /api/v1 in index.ts (prefix: '/api/v1').
 * Frontend API contract: identical to Python FastAPI — zero frontend changes.
 */
import type { FastifyInstance } from 'fastify'
import {
  McpConnectSchema,
  McpQuerySchema,
  McpRecordSchema,
  McpSearchSchema,
  RagGenerateSchema,
} from './salesforce.schema.js'
import * as svc from './salesforce.service.js'

export async function salesforceRoutes(app: FastifyInstance) {

  // ─── NEW: Metadata Query Endpoints ─────────────────────────────
  //
  // These three routes are the cross-module public-facing HTTP surface.
  // All route params include a projectId so the service can resolve
  // the correct Salesforce org / credential set.
  //
  // Example: GET /api/v1/salesforce/metadata/Account?projectId=<uuid>
  //
  // Note: the SKILL.md spec shows the paths without /projectId/ in the
  // URL segment. We keep projectId as a query-string parameter so that
  // the path stays exactly as specified:
  //   /api/salesforce/metadata/:objectName
  //   /api/salesforce/fields/:objectName
  //   /api/salesforce/picklist/:objectName/:fieldName

  app.get('/salesforce/metadata/:objectName', async (request, reply) => {
    try {
      const { objectName } = request.params as { objectName: string }
      const { projectId }  = request.query as { projectId?: string }

      if (!projectId) {
        return reply.status(400).send({ detail: 'projectId query parameter is required' })
      }

      const result = await svc.getObjectMetadata(projectId, objectName)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  app.get('/salesforce/fields/:objectName', async (request, reply) => {
    try {
      const { objectName } = request.params as { objectName: string }
      const { projectId }  = request.query as { projectId?: string }

      if (!projectId) {
        return reply.status(400).send({ detail: 'projectId query parameter is required' })
      }

      const result = await svc.getFields(projectId, objectName)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  app.get('/salesforce/picklist/:objectName/:fieldName', async (request, reply) => {
    try {
      const { objectName, fieldName } = request.params as {
        objectName: string
        fieldName:  string
      }
      const { projectId } = request.query as { projectId?: string }

      if (!projectId) {
        return reply.status(400).send({ detail: 'projectId query parameter is required' })
      }

      const result = await svc.getPicklistValues(projectId, objectName, fieldName)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  // ─── Salesforce Connections (legacy) ───────────────────────────

  app.post('/salesforce/connections', async (request, reply) => {
    const body = request.body as any
    const conn = await svc.createConnection(body)
    return reply.status(201).send(conn)
  })

  app.get('/salesforce/connections/:projectId', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    const conns = await svc.getConnections(projectId)
    return reply.send(conns)
  })

  app.delete('/salesforce/connections/:connectionId', async (request, reply) => {
    const { connectionId } = request.params as { connectionId: string }
    await svc.deleteConnection(connectionId)
    return reply.status(204).send()
  })

  // ─── Metadata Status & RAG ────────────────────────────────────

  app.get('/salesforce/metadata-status/:projectId', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    const status = await svc.getMetadataStatus(projectId)
    return reply.send(status)
  })

  app.post('/salesforce/generate-with-rag', async (request, reply) => {
    try {
      const body   = RagGenerateSchema.parse(request.body)
      const result = await svc.ragGenerate(body)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  // ─── MCP Routes ───────────────────────────────────────────────

  app.post('/mcp/projects/:id/mcp-connect', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body   = McpConnectSchema.parse(request.body)
      const result = await svc.mcpConnect(id, body)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  app.post('/mcp/projects/:id/mcp/query', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body   = McpQuerySchema.parse(request.body)
      const result = await svc.mcpQuery(id, body)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  app.get('/mcp/projects/:id/mcp/records/:obj/:recId', async (request, reply) => {
    try {
      const { id, obj, recId } = request.params as { id: string; obj: string; recId: string }
      const result = await svc.mcpGetRecord(id, obj, recId)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  app.post('/mcp/projects/:id/mcp/records/:obj', async (request, reply) => {
    try {
      const { id, obj } = request.params as { id: string; obj: string }
      const body = McpRecordSchema.parse(request.body)
      const result = await svc.mcpCreateRecord(id, obj, body.data)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  app.put('/mcp/projects/:id/mcp/records/:obj/:recId', async (request, reply) => {
    try {
      const { id, obj, recId } = request.params as { id: string; obj: string; recId: string }
      const body = McpRecordSchema.parse(request.body)
      const result = await svc.mcpUpdateRecord(id, obj, recId, body.data)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  app.delete('/mcp/projects/:id/mcp/records/:obj/:recId', async (request, reply) => {
    try {
      const { id, obj, recId } = request.params as { id: string; obj: string; recId: string }
      await svc.mcpDeleteRecord(id, obj, recId)
      return reply.status(204).send()
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  app.get('/mcp/projects/:id/mcp/describe/:obj', async (request, reply) => {
    try {
      const { id, obj } = request.params as { id: string; obj: string }
      const result = await svc.mcpDescribe(id, obj)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  app.post('/mcp/projects/:id/mcp/search', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body   = McpSearchSchema.parse(request.body)
      const result = await svc.mcpSearch(id, body.search_query)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  app.get('/mcp/projects/:id/mcp/limits', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const result = await svc.mcpLimits(id)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  app.post('/mcp/projects/:id/mcp/sync-metadata', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const result = await svc.syncMetadata(id)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  // ─── Non-MCP Metadata Sync ────────────────────────────────────

  app.post('/projects/:id/sync-metadata', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const result = await svc.syncMetadata(id)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })
}
