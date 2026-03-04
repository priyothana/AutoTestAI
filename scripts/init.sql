-- Database Initialization Script for AutoTest AI

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Table: users
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(255) UNIQUE,
    full_name VARCHAR(255),
    hashed_password VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    role VARCHAR(50) DEFAULT 'tester',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Table: projects
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    type VARCHAR(50) NOT NULL,
    category VARCHAR(20) DEFAULT 'webapp',
    base_url VARCHAR(255),
    status VARCHAR(50) DEFAULT 'Active',
    tags JSONB DEFAULT '[]'::jsonb,
    members JSONB DEFAULT '[]'::jsonb,
    owner_id INTEGER REFERENCES users(id),
    ui_session_active BOOLEAN DEFAULT FALSE,
    ui_session_last_created_at TIMESTAMP WITH TIME ZONE,
    ui_session_source VARCHAR(20),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Table: environments
CREATE TABLE IF NOT EXISTS environments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    base_url VARCHAR(255),
    variables JSONB DEFAULT '{}'::jsonb,
    browser VARCHAR(50),
    os VARCHAR(50),
    device VARCHAR(50),
    project_id UUID REFERENCES projects(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Table: test_cases
CREATE TABLE IF NOT EXISTS test_cases (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    steps JSONB DEFAULT '[]'::jsonb NOT NULL,
    expected_result TEXT,
    priority VARCHAR(20) DEFAULT 'medium',
    status VARCHAR(20) DEFAULT 'draft',
    project_id UUID REFERENCES projects(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Table: test_steps
CREATE TABLE IF NOT EXISTS test_steps (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    test_case_id UUID REFERENCES test_cases(id) ON DELETE CASCADE,
    step_number INTEGER NOT NULL,
    action_type VARCHAR(50) NOT NULL,
    locator VARCHAR(255),
    value TEXT,
    expected TEXT,
    timeout_ms INTEGER DEFAULT 5000,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Table: test_runs
CREATE TABLE IF NOT EXISTS test_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    test_case_id UUID REFERENCES test_cases(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending',
    logs JSONB DEFAULT '[]'::jsonb,
    result VARCHAR(50),
    duration FLOAT,
    screenshot_path VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Table: test_data_sets
CREATE TABLE IF NOT EXISTS test_data_sets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    data JSONB DEFAULT '{}'::jsonb NOT NULL,
    project_id UUID REFERENCES projects(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Table: integrations
CREATE TABLE IF NOT EXISTS integrations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type VARCHAR(50) NOT NULL,
    config JSONB DEFAULT '{}'::jsonb NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    project_id UUID REFERENCES projects(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Table: app_settings
CREATE TABLE IF NOT EXISTS app_settings (
    id SERIAL PRIMARY KEY,
    default_timeout INTEGER DEFAULT 30000,
    parallel_execution BOOLEAN DEFAULT FALSE,
    retry_count INTEGER DEFAULT 0,
    screenshot_mode VARCHAR(50) DEFAULT 'on-failure',
    use_session_reuse BOOLEAN DEFAULT TRUE,
    base_url VARCHAR(255),
    browser VARCHAR(50) DEFAULT 'chromium',
    device VARCHAR(50) DEFAULT 'desktop',
    variables JSONB DEFAULT '{}'::jsonb,
    slack_webhook VARCHAR(255),
    email_notifications BOOLEAN DEFAULT FALSE,
    webhook_callback VARCHAR(255)
);

-- =============================================
-- Salesforce RAG Feature Tables
-- =============================================

-- Table: salesforce_connections
CREATE TABLE IF NOT EXISTS salesforce_connections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID REFERENCES projects(id) NOT NULL,
    instance_url VARCHAR(255) NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    org_name VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Table: metadata_raw_store
CREATE TABLE IF NOT EXISTS metadata_raw_store (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID REFERENCES projects(id) NOT NULL,
    metadata_type VARCHAR(50) NOT NULL,
    api_name VARCHAR(255) NOT NULL,
    raw_json JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Table: metadata_normalized
CREATE TABLE IF NOT EXISTS metadata_normalized (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID REFERENCES projects(id) NOT NULL,
    object_name VARCHAR(255) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    label VARCHAR(255),
    structured_json JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Table: domain_models
CREATE TABLE IF NOT EXISTS domain_models (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID REFERENCES projects(id) NOT NULL,
    entity_name VARCHAR(255) NOT NULL,
    actions JSONB DEFAULT '[]'::jsonb,
    testing_rules JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Table: vector_embeddings
CREATE TABLE IF NOT EXISTS vector_embeddings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID REFERENCES projects(id) NOT NULL,
    source_type VARCHAR(50) NOT NULL,
    source_id UUID NOT NULL,
    embedding_vector JSONB NOT NULL,
    text_chunk TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Table: rag_query_logs
CREATE TABLE IF NOT EXISTS rag_query_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID REFERENCES projects(id) NOT NULL,
    test_case_id UUID REFERENCES test_cases(id),
    query_text TEXT NOT NULL,
    retrieved_chunks JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Initial Seed Data

-- Default User (password: 'password') - NOTE: In a real app, this should be a properly hashed password.
-- ==========================================
-- Phase 1: Project Integrations
-- ==========================================

CREATE TABLE IF NOT EXISTS project_integrations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID REFERENCES projects(id) NOT NULL,
    category VARCHAR(20) NOT NULL,
    status VARCHAR(20) DEFAULT 'disconnected',
    base_url TEXT,
    login_strategy VARCHAR(50),
    username TEXT,
    password TEXT,
    instance_url TEXT,
    client_id TEXT,
    client_secret TEXT,
    access_token TEXT,
    refresh_token TEXT,
    token_expiry TIMESTAMP WITH TIME ZONE,
    salesforce_redirect_uri TEXT,
    salesforce_login_url TEXT DEFAULT 'https://login.salesforce.com',
    org_id TEXT,
    security_token TEXT,
    mcp_connected BOOLEAN DEFAULT FALSE,
    auth_config JSONB,
    last_synced_at TIMESTAMP WITH TIME ZONE,
    sync_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- ==========================================
-- Seed Data
-- ==========================================

-- Since I don't know the exact hashing algorithm used by FastAPI's pwd_context, 
-- this is a placeholder. If the user has a registration flow, they can create a real one.
INSERT INTO users (email, username, full_name, hashed_password, role)
VALUES ('admin@autotest.ai', 'admin', 'Administrator', '$2b$12$EixZaYVK1fsbw1ZfbX3OXePaWxn96p36WQoeG6Lruj3vjPGga31lW', 'admin')
ON CONFLICT (email) DO NOTHING;

-- Default Settings
INSERT INTO app_settings (default_timeout, browser, device)
VALUES (30000, 'chromium', 'desktop')
ON CONFLICT DO NOTHING;
