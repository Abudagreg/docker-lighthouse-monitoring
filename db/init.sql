-- Clients table
CREATE TABLE IF NOT EXISTS clients (
  id               SERIAL PRIMARY KEY,
  name             VARCHAR(255) NOT NULL,
  url              VARCHAR(500) NOT NULL UNIQUE,
  schedule         VARCHAR(100),
  schedule_enabled BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMP DEFAULT NOW()
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
  fcp_ms         NUMERIC(10,2),   -- First Contentful Paint (ms)
  lcp_ms         NUMERIC(10,2),   -- Largest Contentful Paint (ms)
  tbt_ms         NUMERIC(10,2),   -- Total Blocking Time (ms)
  si_ms          NUMERIC(10,2),   -- Speed Index (ms)
  tti_ms         NUMERIC(10,2),   -- Time to Interactive (ms)
  cls            NUMERIC(8,4),    -- Cumulative Layout Shift (score, e.g. 0.05)
  -- Full report
  report_json    JSONB,
  status         VARCHAR(20) DEFAULT 'completed',
  error_message  TEXT,
  audited_at     TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audits_client_id  ON audits(client_id);
CREATE INDEX IF NOT EXISTS idx_audits_audited_at ON audits(audited_at DESC);