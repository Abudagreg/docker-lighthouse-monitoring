-- Clients table
CREATE TABLE IF NOT EXISTS clients (
  id               SERIAL PRIMARY KEY,
  name             VARCHAR(255) NOT NULL,
  url              VARCHAR(500) NOT NULL,
  platform         VARCHAR(10)  NOT NULL DEFAULT 'both',  -- 'mobile' | 'desktop' | 'both'
  schedule         VARCHAR(100),
  schedule_enabled BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMP DEFAULT NOW(),
  CONSTRAINT clients_name_unique        UNIQUE (name),
  CONSTRAINT clients_url_platform_unique UNIQUE (url, platform)
);

-- Audits table
CREATE TABLE IF NOT EXISTS audits (
  id             SERIAL PRIMARY KEY,
  client_id      INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  form_factor    VARCHAR(10) DEFAULT 'mobile',
  -- Category scores (0-100)
  performance    NUMERIC(5,2),
  accessibility  NUMERIC(5,2),
  best_practices NUMERIC(5,2),
  seo            NUMERIC(5,2),
  pwa            NUMERIC(5,2),
  -- Performance sub-metrics
  fcp_ms         NUMERIC(10,2),
  lcp_ms         NUMERIC(10,2),
  tbt_ms         NUMERIC(10,2),
  si_ms          NUMERIC(10,2),
  tti_ms         NUMERIC(10,2),
  cls            NUMERIC(8,4),
  -- Full report
  report_json    JSONB,
  status         VARCHAR(20) DEFAULT 'completed',
  error_message  TEXT,
  audited_at     TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audits_client_id  ON audits(client_id);
CREATE INDEX IF NOT EXISTS idx_audits_audited_at ON audits(audited_at DESC);