const express = require("express");
const path = require("path");
const fetch = require("node-fetch");
const cron = require("node-cron");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const LIGHTHOUSE_URL =
  process.env.LIGHTHOUSE_SERVICE_URL || "http://lighthouse:3001";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5432"),
  user: process.env.DB_USER || "lighthouse",
  password: process.env.DB_PASSWORD || "lighthouse_pass",
  database: process.env.DB_NAME || "lighthouse_db",
});

// ─── Cron job registry ───────────────────────────────────────────
const activeJobs = new Map();

async function waitForDb(retries = 10, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query("SELECT 1");
      console.log("✅ Database connected");
      return;
    } catch {
      console.log(`⏳ Waiting for DB... (${i + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Could not connect to database");
}

// ─── Core audit runner ───────────────────────────────────────────
async function runAuditForClient(clientId, formFactor = "mobile") {
  const clientResult = await pool.query("SELECT * FROM clients WHERE id = $1", [
    clientId,
  ]);
  if (!clientResult.rows.length) throw new Error("Client not found");

  const { url } = clientResult.rows[0];
  const endpoint = `${LIGHTHOUSE_URL}/audit?url=${encodeURIComponent(url)}&client_id=${clientId}&form_factor=${formFactor}`;
  const response = await fetch(endpoint, { timeout: 180000 });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Audit failed");
  return data;
}

// ─── Scheduler ───────────────────────────────────────────────────
function stopJob(clientId) {
  const existing = activeJobs.get(clientId);
  if (existing) {
    existing.stop();
    activeJobs.delete(clientId);
  }
}

function startJob(clientId, expression) {
  stopJob(clientId);
  if (!cron.validate(expression))
    throw new Error(`Invalid cron expression: "${expression}"`);
  const task = cron.schedule(expression, async () => {
    console.log(`⏰ Scheduled audit firing for client ${clientId}`);
    try {
      await runAuditForClient(clientId);
    } catch (err) {
      console.error(
        `❌ Scheduled audit failed for client ${clientId}:`,
        err.message,
      );
    }
  });
  activeJobs.set(clientId, task);
  console.log(`📅 Scheduled client ${clientId} — "${expression}"`);
}

async function initSchedules() {
  try {
    const result = await pool.query(
      `SELECT id, schedule FROM clients WHERE schedule IS NOT NULL AND schedule_enabled = TRUE`,
    );
    for (const row of result.rows) {
      try {
        startJob(row.id, row.schedule);
      } catch (err) {
        console.warn(`⚠️  Bad schedule for client ${row.id}: ${err.message}`);
      }
    }
    console.log(`📅 Restored ${result.rows.length} scheduled job(s)`);
  } catch (err) {
    console.error("Failed to restore schedules:", err.message);
  }
}

// ─── Clients ──────────────────────────────────────────────────────
app.get("/api/clients", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*,
              (SELECT audited_at   FROM audits WHERE client_id = c.id ORDER BY audited_at DESC LIMIT 1) AS last_audited,
              (SELECT performance  FROM audits WHERE client_id = c.id ORDER BY audited_at DESC LIMIT 1) AS last_performance
       FROM clients c ORDER BY c.created_at DESC`,
    );
    res.json(
      result.rows.map((r) => ({ ...r, job_active: activeJobs.has(r.id) })),
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/clients", async (req, res) => {
  const { name, url } = req.body;
  if (!name || !url)
    return res.status(400).json({ error: "name and url required" });
  try {
    new URL(url);
    const result = await pool.query(
      "INSERT INTO clients (name, url) VALUES ($1, $2) RETURNING *",
      [name, url],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505")
      return res.status(409).json({ error: "URL already exists" });
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/clients/:id", async (req, res) => {
  try {
    stopJob(parseInt(req.params.id));
    await pool.query("DELETE FROM clients WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Audits ───────────────────────────────────────────────────────
app.get("/api/clients/:id/audits", async (req, res) => {
  try {
    // Exclude report_json from list — too large; fetched separately
    const result = await pool.query(
      `SELECT id, client_id, form_factor, performance, accessibility,
              best_practices, seo, pwa, status, error_message, audited_at
       FROM audits WHERE client_id = $1 ORDER BY audited_at DESC LIMIT 20`,
      [req.params.id],
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/clients/:id/audit", async (req, res) => {
  const formFactor = req.body?.form_factor === "desktop" ? "desktop" : "mobile";
  try {
    const data = await runAuditForClient(parseInt(req.params.id), formFactor);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET full Lighthouse JSON report for a specific audit
app.get("/api/audits/:id/report", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT report_json FROM audits WHERE id = $1`,
      [req.params.id],
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Audit not found" });
    if (!result.rows[0].report_json)
      return res.status(404).json({ error: "No report saved for this audit" });
    res.json(result.rows[0].report_json);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Schedule management ──────────────────────────────────────────
app.put("/api/clients/:id/schedule", async (req, res) => {
  const clientId = parseInt(req.params.id);
  const { expression, enabled = true } = req.body;
  if (!expression)
    return res.status(400).json({ error: "expression is required" });
  if (!cron.validate(expression))
    return res
      .status(400)
      .json({ error: `Invalid cron expression: "${expression}"` });
  try {
    await pool.query(
      `UPDATE clients SET schedule = $1, schedule_enabled = $2 WHERE id = $3`,
      [expression, enabled, clientId],
    );
    if (enabled) startJob(clientId, expression);
    else stopJob(clientId);
    res.json({
      success: true,
      clientId,
      expression,
      enabled,
      job_active: activeJobs.has(clientId),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/clients/:id/schedule", async (req, res) => {
  const clientId = parseInt(req.params.id);
  try {
    stopJob(clientId);
    await pool.query(
      `UPDATE clients SET schedule = NULL, schedule_enabled = FALSE WHERE id = $1`,
      [clientId],
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/clients/:id/schedule/toggle", async (req, res) => {
  const clientId = parseInt(req.params.id);
  try {
    const result = await pool.query(
      `SELECT schedule, schedule_enabled FROM clients WHERE id = $1`,
      [clientId],
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Client not found" });
    const { schedule, schedule_enabled } = result.rows[0];
    if (!schedule) return res.status(400).json({ error: "No schedule set" });
    const newEnabled = !schedule_enabled;
    await pool.query(`UPDATE clients SET schedule_enabled = $1 WHERE id = $2`, [
      newEnabled,
      clientId,
    ]);
    if (newEnabled) startJob(clientId, schedule);
    else stopJob(clientId);
    res.json({
      success: true,
      enabled: newEnabled,
      job_active: activeJobs.has(clientId),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/schedules", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, url, schedule, schedule_enabled FROM clients WHERE schedule IS NOT NULL ORDER BY name`,
    );
    res.json(
      result.rows.map((r) => ({ ...r, job_active: activeJobs.has(r.id) })),
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Dashboard ────────────────────────────────────────────────────
app.get("/api/dashboard", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.id, c.name, c.url, c.schedule, c.schedule_enabled,
             a.performance, a.accessibility, a.best_practices, a.seo, a.pwa,
             a.status, a.audited_at
      FROM clients c
      LEFT JOIN LATERAL (
        SELECT * FROM audits WHERE client_id = c.id ORDER BY audited_at DESC LIMIT 1
      ) a ON true
      ORDER BY c.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Boot ─────────────────────────────────────────────────────────
(async () => {
  await waitForDb();
  await initSchedules();
  app.listen(PORT, () =>
    console.log(`🖥️  GUI running at http://localhost:${PORT}`),
  );
})();
