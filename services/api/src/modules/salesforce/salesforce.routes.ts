/**
 * Salesforce Module — Routes
 *
 * All routes prefixed with /api/v1 in index.ts (prefix: '/api/v1').
 * Frontend API contract: identical to Python FastAPI — zero frontend changes.
 *
 * Metadata query routes (JSforce-backed, Gap 1 resolved):
 *   GET /api/salesforce/metadata/:objectName
 *   GET /api/salesforce/fields/:objectName
 *   GET /api/salesforce/picklist/:objectName/:fieldName
 *   GET /api/salesforce/picklist-dependent/:objectName/:controller/:dependent  ← NEW
 *   GET /api/salesforce/objects                                                 ← NEW
 *   GET /api/salesforce/record-types/:objectName                               ← NEW
 *
 * Legacy routes (unchanged paths):
 *   POST   /salesforce/connections
 *   GET    /salesforce/connections/:projectId
 *   DELETE /salesforce/connections/:connectionId
 *   GET    /salesforce/metadata-status/:projectId
 *   POST   /salesforce/generate-with-rag
 *   POST   /mcp/projects/:id/mcp-connect
 *   POST   /mcp/projects/:id/mcp/query
 *   GET    /mcp/projects/:id/mcp/records/:obj/:recId
 *   POST   /mcp/projects/:id/mcp/records/:obj
 *   PUT    /mcp/projects/:id/mcp/records/:obj/:recId
 *   DELETE /mcp/projects/:id/mcp/records/:obj/:recId
 *   GET    /mcp/projects/:id/mcp/describe/:obj
 *   POST   /mcp/projects/:id/mcp/search
 *   GET    /mcp/projects/:id/mcp/limits
 *   POST   /mcp/projects/:id/mcp/sync-metadata
 *   POST   /projects/:id/sync-metadata
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
import { invalidateCache } from './lib/sf-metadata.js'

export async function salesforceRoutes(app: FastifyInstance) {

  // ─── NEW: Metadata Query Endpoints (JSforce-backed) ────────────

  // GET /api/salesforce/metadata/:objectName?projectId=<uuid>
  app.get('/salesforce/metadata/:objectName', async (request, reply) => {
    try {
      const { objectName } = request.params as { objectName: string }
      const { projectId } = request.query as { projectId?: string }

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

  // GET /api/salesforce/fields/:objectName?projectId=<uuid>
  app.get('/salesforce/fields/:objectName', async (request, reply) => {
    try {
      const { objectName } = request.params as { objectName: string }
      const { projectId } = request.query as { projectId?: string }

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

  // GET /api/salesforce/picklist/:objectName/:fieldName?projectId=<uuid>
  app.get('/salesforce/picklist/:objectName/:fieldName', async (request, reply) => {
    try {
      const { objectName, fieldName } = request.params as {
        objectName: string
        fieldName: string
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

  // GET /api/salesforce/picklist-dependent/:objectName/:controller/:dependent?projectId=<uuid>
  // NEW: Dependent picklist resolution (Gap 1 from parity analysis)
  app.get(
    '/salesforce/picklist-dependent/:objectName/:controller/:dependent',
    async (request, reply) => {
      try {
        const { objectName, controller, dependent } = request.params as {
          objectName: string
          controller: string
          dependent: string
        }
        const { projectId } = request.query as { projectId?: string }

        if (!projectId) {
          return reply.status(400).send({ detail: 'projectId query parameter is required' })
        }

        const result = await svc.getDependentPicklistValues(
          projectId,
          objectName,
          controller,
          dependent,
        )
        return reply.send(result)
      } catch (err: any) {
        if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
        throw err
      }
    },
  )

  // GET /api/salesforce/objects?projectId=<uuid>
  // NEW: List all queryable Salesforce objects (global describe)
  app.get('/salesforce/objects', async (request, reply) => {
    try {
      const { projectId } = request.query as { projectId?: string }

      if (!projectId) {
        return reply.status(400).send({ detail: 'projectId query parameter is required' })
      }

      const result = await svc.listObjects(projectId)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  // GET /api/salesforce/record-types/:objectName?projectId=<uuid>
  // NEW: Record type infos for an object
  app.get('/salesforce/record-types/:objectName', async (request, reply) => {
    try {
      const { objectName } = request.params as { objectName: string }
      const { projectId } = request.query as { projectId?: string }

      if (!projectId) {
        return reply.status(400).send({ detail: 'projectId query parameter is required' })
      }

      const result = await svc.getRecordTypes(projectId, objectName)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  // POST /api/salesforce/cache/invalidate
  // Invalidate the in-process metadata cache for a project (or specific object).
  // Auth: requires valid JWT.
  app.post('/salesforce/cache/invalidate', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    try {
      const body = request.body as { projectId?: string; objectName?: string }

      if (!body?.projectId) {
        return reply.status(400).send({ detail: 'projectId is required' })
      }

      invalidateCache(body.projectId, body.objectName)

      return reply.send({
        ok: true,
        projectId: body.projectId,
        objectName: body.objectName ?? null,
        message: body.objectName
          ? `Cache invalidated for ${body.projectId}:${body.objectName}`
          : `All caches invalidated for project ${body.projectId}`,
      })
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  // ─── Salesforce Connections (legacy — unchanged) ────────────────


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

  // ─── Metadata Status & RAG ─────────────────────────────────────

  app.get('/salesforce/metadata-status/:projectId', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    const status = await svc.getMetadataStatus(projectId)
    return reply.send(status)
  })

  app.post('/salesforce/generate-with-rag', async (request, reply) => {
    try {
      const body = RagGenerateSchema.parse(request.body)
      const result = await svc.ragGenerate(body)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
      throw err
    }
  })

  // ─── MCP Routes (legacy — unchanged paths) ─────────────────────

  app.post('/mcp/projects/:id/mcp-connect', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = McpConnectSchema.parse(request.body)
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
      const body = McpQuerySchema.parse(request.body)
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
      const body = McpSearchSchema.parse(request.body)
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

  // ─── Non-MCP Metadata Sync ─────────────────────────────────────

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
