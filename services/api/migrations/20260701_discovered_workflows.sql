-- ============================================================
-- Discovered Workflows table
-- Migration: 20260701_discovered_workflows.sql
--
-- Tracks workflows discovered for each project.
-- ============================================================

CREATE TABLE IF NOT EXISTS discovered_workflows (
  id                      UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id              UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_title          VARCHAR(255) NOT NULL,
  description             TEXT,
  generated_steps_summary TEXT,
  source                  VARCHAR(50) NOT NULL DEFAULT 'ai_discovery',
  discovered_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at            TIMESTAMPTZ
);

-- Indexes for fast lookup by project_id
CREATE INDEX IF NOT EXISTS idx_discovered_workflows_project_id ON discovered_workflows(project_id);
