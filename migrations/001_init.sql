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

CREATE TABLE IF NOT EXISTS project_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  method TEXT DEFAULT 'GET',
  url TEXT NOT NULL,
  headers_json TEXT DEFAULT '{}',
  auth_type TEXT DEFAULT 'none',
  auth_header_name TEXT,
  auth_value_enc TEXT,
  params_json TEXT DEFAULT '[]',
  body_template TEXT,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_skills_project ON project_skills(project_id);

-- Dedicated embeddings key — required when the agent's main LLM provider is
-- Anthropic (no native embeddings API), optional override when it's OpenAI
-- (defaults to reusing the main OpenAI key if this is left blank).
ALTER TABLE project_llm_config ADD COLUMN IF NOT EXISTS embedding_api_key_enc TEXT;
ALTER TABLE project_llm_config ADD COLUMN IF NOT EXISTS embedding_model TEXT DEFAULT 'text-embedding-3-small';

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- 'file' | 'website'
  name TEXT NOT NULL, -- filename, or the root URL for website sources
  status TEXT DEFAULT 'pending', -- pending | indexing | ready | error
  error_message TEXT,
  chunk_count INTEGER DEFAULT 0,
  pages_indexed INTEGER DEFAULT 0, -- website sources only
  last_indexed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_project ON knowledge_sources(project_id);

-- Embeddings stored as JSONB float arrays rather than a native vector column
-- (pgvector isn't guaranteed available on every hosting provider) — cosine
-- similarity is computed in-app. Fine for realistic knowledge-base sizes
-- (hundreds to low thousands of chunks); revisit with pgvector for scale.
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  source_id UUID REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  source_name TEXT,
  content TEXT NOT NULL,
  embedding JSONB NOT NULL,
  chunk_index INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_project ON knowledge_chunks(project_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_source ON knowledge_chunks(source_id);

CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);
