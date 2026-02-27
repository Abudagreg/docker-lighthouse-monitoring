-- Clients table: sites/URLs to monitor
CREATE TABLE IF NOT EXISTS clients (
  id               SERIAL PRIMARY KEY,
  name             VARCHAR(255) NOT NULL,
  url              VARCHAR(500) NOT NULL UNIQUE,
  schedule         VARCHAR(100),
  schedule_enabled BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMP DEFAULT NOW()
);

-- Audits table: results per client
CREATE TABLE IF NOT EXISTS audits (
  id             SERIAL PRIMARY KEY,
  client_id      INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  form_factor    VARCHAR(10) DEFAULT 'mobile',
  performance    NUMERIC(5,2),
  accessibility  NUMERIC(5,2),
  best_practices NUMERIC(5,2),
  seo            NUMERIC(5,2),
  pwa            NUMERIC(5,2),
  report_json    JSONB,
  status         VARCHAR(20) DEFAULT 'completed',
  error_message  TEXT,
  audited_at     TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audits_client_id ON audits(client_id);
CREATE INDEX IF NOT EXISTS idx_audits_audited_at ON audits(audited_at DESC);