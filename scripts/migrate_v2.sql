-- ==========================================
-- Migration V2: Multi-App + Per-Project OAuth
-- Run this on existing databases that already
-- have the Phase 1 schema.
-- ==========================================

-- 1. Add 'category' column to projects table
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS category VARCHAR(20) DEFAULT 'webapp';

-- Migrate existing type values into category
UPDATE projects SET category = 'salesforce' WHERE LOWER(type) = 'salesforce' AND (category IS NULL OR category = 'webapp');
UPDATE projects SET category = 'api' WHERE LOWER(type) = 'api' AND (category IS NULL OR category = 'webapp');

-- 2. Add per-project Salesforce columns to project_integrations
ALTER TABLE project_integrations
    ADD COLUMN IF NOT EXISTS salesforce_redirect_uri TEXT;

ALTER TABLE project_integrations
    ADD COLUMN IF NOT EXISTS salesforce_login_url TEXT DEFAULT 'https://login.salesforce.com';

ALTER TABLE project_integrations
    ADD COLUMN IF NOT EXISTS org_id TEXT;

ALTER TABLE project_integrations
    ADD COLUMN IF NOT EXISTS auth_config JSONB;

-- Done
SELECT 'Migration V2 completed successfully' AS result;
