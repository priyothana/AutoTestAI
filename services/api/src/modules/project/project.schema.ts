/**
 * Project Module — Zod Schemas
 *
 * Maps from Python Pydantic:
 *   ProjectCreate, ProjectUpdate, ProjectResponse
 *   IntegrationStatusResponse, SalesforceCredentialsRequest,
 *   JiraConnectRequest, JiraProjectConfig
 *
 * API contract: response shapes must match Python FastAPI exactly so that
 * the Next.js frontend requires zero changes.
 */
import { z } from 'zod'

// ─── Project CRUD ────────────────────────────────────────────────

export const ProjectCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  type: z.string().min(1),
  category: z.string().default('webapp').optional(),
  base_url: z.string().optional().nullable(),
  status: z.string().default('Active').optional(),
  tags: z.array(z.string()).default([]).optional(),
  // Web App login credentials (optional — auto-creates web integration)
  login_url: z.string().optional().nullable(),
  login_username: z.string().optional().nullable(),
  login_password: z.string().optional().nullable(),
  login_strategy: z.string().default('form').optional(),
})

export const ProjectUpdateSchema = z.object({
  name: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  type: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  base_url: z.string().optional().nullable(),
  status: z.string().optional().nullable(),
  tags: z.array(z.string()).optional().nullable(),
})

/** Shape returned by GET /api/v1/projects/:id and POST /api/v1/projects */
export const ProjectResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  type: z.string(),
  category: z.string(),
  base_url: z.string().nullable(),
  status: z.string(),
  tags: z.any(), // JSON array
  members: z.any(), // JSON array
  owner_id: z.number().nullable(),
  ui_session_active: z.boolean(),
  ui_session_last_created_at: z.string().nullable(),
  ui_session_source: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

// ─── Integrations ────────────────────────────────────────────────

export const ConnectProjectSchema = z.object({
  category: z.string().min(1),
  base_url: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  login_strategy: z.string().default('form').optional(),
  
  // Web App Metadata Sync Config
  sitemap_url: z.string().optional(),
  max_crawl_pages: z.number().optional(),
  key_routes: z.array(z.string()).optional(),
  enable_deep_crawl: z.boolean().optional(),
  
  // API authentication
  api_key: z.string().optional(),
  bearer_token: z.string().optional(),
  // Salesforce (OAuth)
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
})

export const SalesforceCredentialsSchema = z.object({
  client_id: z.string().min(1, 'Client ID is required'),
  client_secret: z.string().min(1, 'Client Secret is required'),
  redirect_uri: z.string().optional().nullable(),
  login_url: z.string().url('Instance URL must be a valid URL').default('https://login.salesforce.com').optional(),
  sf_username: z.string().optional().nullable(),
  sf_password: z.string().optional().nullable(),
  sf_security_token: z.string().optional().nullable(),
})

/** Matches Python: IntegrationStatusResponse */
export const IntegrationStatusResponseSchema = z.object({
  id: z.string().uuid().optional(),
  project_id: z.string().uuid().optional(),
  category: z.string().nullable(),
  status: z.string(),
  base_url: z.string().nullable().optional(),
  instance_url: z.string().nullable().optional(),
  login_strategy: z.string().nullable().optional(),
  org_id: z.string().nullable().optional(),
  salesforce_login_url: z.string().nullable().optional(),
  has_sf_credentials: z.boolean().nullable().optional(),
  mcp_connected: z.boolean().optional(),
  last_synced_at: z.string().nullable().optional(),
  sync_error: z.string().nullable().optional(),
  sync_counts: z
    .object({
      raw_count: z.number(),
      normalized_count: z.number(),
      domain_model_count: z.number(),
      embedding_count: z.number(),
    })
    .nullable()
    .optional(),
  ui_session: z
    .object({
      active: z.boolean(),
      last_created_at: z.string().nullable(),
      source: z.string().nullable(),
    })
    .optional(),
  message: z.string().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
})

// ─── Jira ────────────────────────────────────────────────────────

export const JiraConnectSchema = z.object({
  jira_domain: z.string().min(1),
  jira_email: z.string().min(1),
  jira_token: z.string().min(1),
})

export const JiraBoardsSchema = z.object({
  jira_domain: z.string().min(1),
  jira_email: z.string().min(1),
  jira_token: z.string().min(1),
})

export const JiraBoardIssuesSchema = z.object({
  jira_domain: z.string().min(1),
  jira_email: z.string().min(1),
  jira_token: z.string().min(1),
  board_id: z.union([z.string(), z.number()]),
})

export const JiraProjectConfigSchema = z.object({
  jira_domain: z.string().min(1),
  jira_email: z.string().min(1),
  jira_token: z.string().min(1),
  board_id: z.union([z.string(), z.number()]),
  board_name: z.string().optional(),
})

// ─── Type Exports ────────────────────────────────────────────────

export type ProjectCreate = z.infer<typeof ProjectCreateSchema>
export type ProjectUpdate = z.infer<typeof ProjectUpdateSchema>
export type ProjectResponse = z.infer<typeof ProjectResponseSchema>
export type ConnectProject = z.infer<typeof ConnectProjectSchema>
export type SalesforceCredentials = z.infer<typeof SalesforceCredentialsSchema>
export type IntegrationStatusResponse = z.infer<typeof IntegrationStatusResponseSchema>
export type JiraConnect = z.infer<typeof JiraConnectSchema>
export type JiraProjectConfig = z.infer<typeof JiraProjectConfigSchema>
