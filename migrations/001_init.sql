-- Run automatically on server boot (see src/db.js). Safe to re-run (IF NOT EXISTS everywhere).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  agent_type TEXT DEFAULT 'custom',
  has_data_source BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Safe to re-run against an existing table from an earlier version of this platform.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS agent_type TEXT DEFAULT 'custom';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS has_data_source BOOLEAN DEFAULT true;

CREATE TABLE IF NOT EXISTS project_sheet_config (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  google_sheet_id TEXT,
  google_sheet_range TEXT DEFAULT 'Sheet1',
  service_account_json_enc TEXT,        -- encrypted; if NULL, falls back to the server-wide
                                         -- GOOGLE_SERVICE_ACCOUNT_KEY_PATH secret file
  catalog_refresh_ms INTEGER DEFAULT 300000,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_llm_config (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT DEFAULT 'none',         -- 'none' | 'openai' | 'anthropic'
  api_key_enc TEXT,                     -- encrypted
  model TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_guardrails (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  system_instructions TEXT DEFAULT '',
  blocked_terms TEXT[] DEFAULT '{}',
  min_price NUMERIC,
  max_price NUMERIC,
  max_recommendations INTEGER DEFAULT 3,
  off_topic_message TEXT DEFAULT 'Sorry, I can only help with product recommendations for this store.',
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd NUMERIC(12,6),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_logs_project ON usage_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_created ON usage_logs(created_at);

CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);
