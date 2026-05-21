-- ============================================================
-- AI Agents — Execution Audit Log Table
-- Migration: 20260519_agent_executions.sql
--
-- Run this once against your PostgreSQL database.
-- Tracks every ReAct loop decision, tool call, and HITL event
-- for observability, debugging, and continuous improvement.
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_executions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID        REFERENCES projects(id) ON DELETE SET NULL,

  -- Agent identity
  agent_name    TEXT        NOT NULL,  -- 'orchestrator' | 'test-case-generator' | etc.
  task_type     TEXT        NOT NULL,  -- 'generate_steps' | 'rca_and_heal' | etc.

  -- Inputs / Outputs
  input_summary  JSONB       NOT NULL DEFAULT '{}',
  output_summary JSONB       NOT NULL DEFAULT '{}',

  -- ReAct trace (array of thought strings)
  thoughts       TEXT[]      NOT NULL DEFAULT '{}',

  -- Tool calls (array of {tool, input, output})
  tool_calls     JSONB[]     NOT NULL DEFAULT '{}',

  -- Metrics
  hitl_invoked   BOOLEAN     NOT NULL DEFAULT false,
  confidence     FLOAT,
  tokens_used    INTEGER,
  duration_ms    INTEGER,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_agent_executions_project_id  ON agent_executions(project_id);
CREATE INDEX IF NOT EXISTS idx_agent_executions_agent_name  ON agent_executions(agent_name);
CREATE INDEX IF NOT EXISTS idx_agent_executions_created_at  ON agent_executions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_executions_hitl        ON agent_executions(hitl_invoked) WHERE hitl_invoked = true;

-- ============================================================
-- Comments
-- ============================================================
COMMENT ON TABLE  agent_executions IS 'Audit log for all AI agent executions — ReAct loops, tool calls, and HITL events';
COMMENT ON COLUMN agent_executions.agent_name    IS 'orchestrator | test-case-generator | test-step-generator | execution | healing-analyzer';
COMMENT ON COLUMN agent_executions.task_type     IS 'generate_steps | generate_test_cases | execute_test | rca_and_heal | hitl_invoked';
COMMENT ON COLUMN agent_executions.thoughts      IS 'Ordered ReAct reasoning trace: OBSERVE → THINK → ACT → REFLECT → DELIVER';
COMMENT ON COLUMN agent_executions.hitl_invoked  IS 'True if the agent called hitlTool during this execution';
COMMENT ON COLUMN agent_executions.confidence    IS 'Agent self-reported confidence score 0.0-1.0 at DELIVER phase';
