/**
 * Salesforce Module — Zod Schemas
 *
 * Covers every request/response shape used by salesforce.routes.ts.
 * New in Phase 5: metadata lookup types used by getObjectMetadata(),
 * getFields(), and getPicklistValues() — the cross-module public API.
 */
import { z } from 'zod'

// ─── MCP Connect ─────────────────────────────────────────────────

export const McpConnectSchema = z.object({
  sf_username:      z.string().min(1),
  sf_password:      z.string().min(1),
  sf_security_token: z.string().min(1),
  domain:           z.string().default('login').optional(),
})

// ─── MCP Query ───────────────────────────────────────────────────

export const McpQuerySchema = z.object({
  query:           z.string().min(1),
  include_deleted: z.boolean().default(false).optional(),
})

// ─── MCP Record ──────────────────────────────────────────────────

export const McpRecordSchema = z.object({
  data: z.record(z.unknown()),
})

// ─── MCP Search ──────────────────────────────────────────────────

export const McpSearchSchema = z.object({
  search_query: z.string().min(1),
})

// ─── Metadata Extract ────────────────────────────────────────────

export const MetadataExtractSchema = z.object({
  project_id:    z.string().uuid(),
  force_refresh: z.boolean().default(false).optional(),
})

// ─── RAG Generate ────────────────────────────────────────────────

export const RagGenerateSchema = z.object({
  project_id:  z.string().uuid(),
  prompt:      z.string().min(1),
  test_case_id: z.string().uuid().optional().nullable(),
  top_k:       z.number().int().default(5).optional(),
  provider:    z.string().default('claude').optional(),
  model:       z.string().optional().nullable(),
})

// ─── NEW: Salesforce metadata query schemas ───────────────────────
//
// These three schemas are used by the cross-module public API:
//   getObjectMetadata()  →  GET /api/salesforce/metadata/:objectName
//   getFields()          →  GET /api/salesforce/fields/:objectName
//   getPicklistValues()  →  GET /api/salesforce/picklist/:objectName/:fieldName

export const ObjectNameParamSchema = z.object({
  objectName: z.string().min(1),
})

export const PicklistParamsSchema = z.object({
  objectName: z.string().min(1),
  fieldName:  z.string().min(1),
})

// Response: full object metadata (label + structured_json from metadata_normalized)
export const ObjectMetadataResponseSchema = z.object({
  object_name: z.string(),
  label:        z.string().nullable(),
  entity_type:  z.string(),
  metadata:     z.record(z.unknown()),
  project_id:   z.string(),
})

// One field descriptor returned by getFields()
export const FieldDescriptorSchema = z.object({
  name:          z.string(),
  label:         z.string().nullable(),
  type:          z.string().nullable(),
  length:        z.number().nullable().optional(),
  required:      z.boolean().nullable().optional(),
  updateable:    z.boolean().nullable().optional(),
  createable:    z.boolean().nullable().optional(),
  picklistValues: z.array(z.object({
    value:  z.string(),
    label:  z.string(),
    active: z.boolean(),
  })).optional(),
})

export const FieldsResponseSchema = z.object({
  object_name: z.string(),
  project_id:  z.string(),
  fields:      z.array(FieldDescriptorSchema),
})

// One picklist entry returned by getPicklistValues()
export const PicklistValueSchema = z.object({
  value:  z.string(),
  label:  z.string(),
  active: z.boolean(),
  defaultValue: z.boolean().optional(),
})

export const PicklistResponseSchema = z.object({
  object_name: z.string(),
  field_name:  z.string(),
  project_id:  z.string(),
  values:      z.array(PicklistValueSchema),
})

// ─── Inferred TypeScript types ────────────────────────────────────

export type McpConnect      = z.infer<typeof McpConnectSchema>
export type McpQuery        = z.infer<typeof McpQuerySchema>
export type RagGenerate     = z.infer<typeof RagGenerateSchema>
export type ObjectNameParam = z.infer<typeof ObjectNameParamSchema>
export type PicklistParams  = z.infer<typeof PicklistParamsSchema>
export type ObjectMetadataResponse = z.infer<typeof ObjectMetadataResponseSchema>
export type FieldDescriptor        = z.infer<typeof FieldDescriptorSchema>
export type FieldsResponse         = z.infer<typeof FieldsResponseSchema>
export type PicklistValue          = z.infer<typeof PicklistValueSchema>
export type PicklistResponse       = z.infer<typeof PicklistResponseSchema>
