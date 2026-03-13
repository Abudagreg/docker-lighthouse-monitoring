const express = require("express");
const path = require("path");
const fs = require("fs");
const fetch = require("node-fetch");
const cron = require("node-cron");
const { Pool } = require("pg");
const archiver = require("archiver");
const unzipper = require("unzipper");
const multer = require("multer");

const REPORTS_DIR = process.env.REPORTS_DIR || "/app/reports";
const BACKUPS_DIR = process.env.BACKUPS_DIR || "/app/backups";
const BACKUP_KEEP = parseInt(process.env.BACKUP_KEEP || "7");

if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

const app = express();
const PORT = process.env.PORT || 2000;
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

// Resolve which form factor to actually run for a client based on its platform setting
function resolveFormFactor(clientPlatform, requestedFormFactor = "mobile") {
  if (clientPlatform === "mobile") return "mobile";
  if (clientPlatform === "desktop") return "desktop";
  return requestedFormFactor; // 'both' → honour what the user picked
}

async function runAuditForClient(clientId, requestedFormFactor = "mobile") {
  const clientResult = await pool.query("SELECT * FROM clients WHERE id = $1", [
    clientId,
  ]);
  if (!clientResult.rows.length) throw new Error("Client not found");
  const { url, platform } = clientResult.rows[0];
  const formFactor = resolveFormFactor(platform, requestedFormFactor);
  const endpoint = `${LIGHTHOUSE_URL}/audit?url=${encodeURIComponent(url)}&client_id=${clientId}&form_factor=${formFactor}`;
  const response = await fetch(endpoint, { timeout: 180000 });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Audit failed");
  return data;
}

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

// ── Clients ───────────────────────────────────────────────────────
app.get("/api/clients", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*,
              (SELECT audited_at  FROM audits WHERE client_id = c.id ORDER BY audited_at DESC LIMIT 1) AS last_audited,
              (SELECT performance FROM audits WHERE client_id = c.id ORDER BY audited_at DESC LIMIT 1) AS last_performance
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
  const { name, url, platform = "both" } = req.body;
  if (!name || !url)
    return res.status(400).json({ error: "name and url required" });
  if (!["mobile", "desktop", "both"].includes(platform)) {
    return res
      .status(400)
      .json({ error: "platform must be mobile, desktop, or both" });
  }
  try {
    new URL(url); // validate
    const result = await pool.query(
      "INSERT INTO clients (name, url, platform) VALUES ($1, $2, $3) RETURNING *",
      [name, url, platform],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      // Which constraint fired?
      if (err.constraint === "clients_name_unique") {
        return res.status(409).json({
          error: `A client named "${name}" already exists. Please use a different name.`,
        });
      }
      if (err.constraint === "clients_url_platform_unique") {
        return res.status(409).json({
          error: `A ${platform} client for this URL already exists. You can still add it with a different platform.`,
        });
      }
      return res.status(409).json({ error: "Duplicate client" });
    }
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/clients/:id", async (req, res) => {
  const { name, url } = req.body;
  if (!name && !url)
    return res.status(400).json({ error: "name or url required" });
  try {
    if (url) new URL(url); // validate URL format
    const fields = [],
      vals = [];
    if (name) {
      fields.push(`name=$${fields.length + 1}`);
      vals.push(name);
    }
    if (url) {
      fields.push(`url=$${fields.length + 1}`);
      vals.push(url);
    }
    vals.push(req.params.id);
    const result = await pool.query(
      `UPDATE clients SET ${fields.join(",")} WHERE id=$${vals.length} RETURNING *`,
      vals,
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Client not found" });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505")
      return res
        .status(409)
        .json({ error: "A client with that name or URL already exists." });
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

// ── Audits ────────────────────────────────────────────────────────
app.get("/api/clients/:id/audits", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, client_id, form_factor,
              performance, accessibility, best_practices, seo, pwa,
              fcp_ms, lcp_ms, tbt_ms, si_ms, tti_ms, cls,
              status, error_message, audited_at
       FROM audits WHERE client_id = $1 ORDER BY audited_at DESC LIMIT 50`,
      [req.params.id],
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/clients/:id/audit", async (req, res) => {
  const requestedFF =
    req.body?.form_factor === "desktop" ? "desktop" : "mobile";
  try {
    const data = await runAuditForClient(parseInt(req.params.id), requestedFF);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/audits/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM audits WHERE id = $1 RETURNING id",
      [req.params.id],
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Audit not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/audits/:id/report", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT report_json, report_path FROM audits WHERE id = $1`,
      [req.params.id],
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Audit not found" });
    const { report_json, report_path } = result.rows[0];
    // Prefer file on volume, fall back to DB blob for old audits
    if (report_path && fs.existsSync(report_path)) {
      const data = JSON.parse(fs.readFileSync(report_path, "utf8"));
      return res.json(data);
    }
    if (report_json) return res.json(report_json);
    return res.status(404).json({ error: "No report saved for this audit" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Schedule management ───────────────────────────────────────────
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
      `SELECT id, name, url, platform, schedule, schedule_enabled FROM clients WHERE schedule IS NOT NULL ORDER BY name`,
    );
    res.json(
      result.rows.map((r) => ({ ...r, job_active: activeJobs.has(r.id) })),
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/dashboard", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.id, c.name, c.url, c.platform, c.schedule, c.schedule_enabled,
             a.performance, a.accessibility, a.best_practices, a.seo, a.pwa,
             a.status, a.audited_at
      FROM clients c
      LEFT JOIN LATERAL (SELECT * FROM audits WHERE client_id = c.id ORDER BY audited_at DESC LIMIT 1) a ON true
      ORDER BY c.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Backup helpers ───────────────────────────────────────────────
async function exportBackup(res) {
  const clients = await pool.query("SELECT * FROM clients ORDER BY id");
  const audits = await pool.query(
    "SELECT id,client_id,form_factor,performance,accessibility,best_practices,seo," +
      "fcp_ms,lcp_ms,tbt_ms,si_ms,tti_ms,cls,report_path,status,error_message,audited_at FROM audits ORDER BY id",
  );

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `lh-backup-${timestamp}.zip`;

  if (res) {
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  }

  const archive = archiver("zip", { zlib: { level: 6 } });
  if (res) archive.pipe(res);

  // DB snapshot as JSON
  const dbSnapshot = JSON.stringify(
    { clients: clients.rows, audits: audits.rows },
    null,
    2,
  );
  archive.append(dbSnapshot, { name: "db.json" });

  // Report files
  if (fs.existsSync(REPORTS_DIR)) {
    const files = fs
      .readdirSync(REPORTS_DIR)
      .filter((f) => f.endsWith(".json"));
    for (const file of files) {
      archive.file(path.join(REPORTS_DIR, file), { name: `reports/${file}` });
    }
  }

  await archive.finalize();
  return { filename, archive };
}

async function saveAutoBackup() {
  try {
    const clients = await pool.query("SELECT * FROM clients ORDER BY id");
    const audits = await pool.query(
      "SELECT id,client_id,form_factor,performance,accessibility,best_practices,seo," +
        "fcp_ms,lcp_ms,tbt_ms,si_ms,tti_ms,cls,report_path,status,error_message,audited_at FROM audits ORDER BY id",
    );

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const filename = `lh-backup-${timestamp}.zip`;
    const filepath = path.join(BACKUPS_DIR, filename);

    const output = fs.createWriteStream(filepath);
    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.pipe(output);

    const dbSnapshot = JSON.stringify(
      { clients: clients.rows, audits: audits.rows },
      null,
      2,
    );
    archive.append(dbSnapshot, { name: "db.json" });

    if (fs.existsSync(REPORTS_DIR)) {
      const files = fs
        .readdirSync(REPORTS_DIR)
        .filter((f) => f.endsWith(".json"));
      for (const file of files) {
        archive.file(path.join(REPORTS_DIR, file), { name: `reports/${file}` });
      }
    }

    await new Promise((resolve, reject) => {
      output.on("close", resolve);
      archive.on("error", reject);
      archive.finalize();
    });

    console.log(`💾 Auto-backup saved: ${filename}`);

    // Prune old backups — keep only BACKUP_KEEP most recent
    const allBackups = fs
      .readdirSync(BACKUPS_DIR)
      .filter((f) => f.startsWith("lh-backup-") && f.endsWith(".zip"))
      .sort();
    const toDelete = allBackups.slice(
      0,
      Math.max(0, allBackups.length - BACKUP_KEEP),
    );
    for (const f of toDelete) {
      fs.unlinkSync(path.join(BACKUPS_DIR, f));
      console.log(`🗑  Pruned old backup: ${f}`);
    }
  } catch (err) {
    console.error("❌ Auto-backup failed:", err.message);
  }
}

// ── Backup API ────────────────────────────────────────────────────
// GET /api/backup/export — stream zip download
app.get("/api/backup/export", async (req, res) => {
  try {
    await exportBackup(res);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// GET /api/backup/list — list saved auto-backups
app.get("/api/backup/list", (req, res) => {
  try {
    if (!fs.existsSync(BACKUPS_DIR)) return res.json([]);
    const files = fs
      .readdirSync(BACKUPS_DIR)
      .filter((f) => f.startsWith("lh-backup-") && f.endsWith(".zip"))
      .sort()
      .reverse()
      .map((f) => {
        const stat = fs.statSync(path.join(BACKUPS_DIR, f));
        return { name: f, size: stat.size, created: stat.mtime };
      });
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/backup/download/:name — download a specific saved backup
app.get("/api/backup/download/:name", (req, res) => {
  const name = path.basename(req.params.name); // prevent path traversal
  if (!name.startsWith("lh-backup-") || !name.endsWith(".zip"))
    return res.status(400).json({ error: "Invalid backup name" });
  const filepath = path.join(BACKUPS_DIR, name);
  if (!fs.existsSync(filepath))
    return res.status(404).json({ error: "Backup not found" });
  res.download(filepath, name);
});

// DELETE /api/backup/:name — delete a saved backup
app.delete("/api/backup/:name", (req, res) => {
  const name = path.basename(req.params.name);
  if (!name.startsWith("lh-backup-") || !name.endsWith(".zip"))
    return res.status(400).json({ error: "Invalid backup name" });
  const filepath = path.join(BACKUPS_DIR, name);
  if (!fs.existsSync(filepath))
    return res.status(404).json({ error: "Backup not found" });
  fs.unlinkSync(filepath);
  res.json({ success: true });
});

// POST /api/backup/trigger — manually trigger an auto-backup (saved to disk)
app.post("/api/backup/trigger", async (req, res) => {
  try {
    await saveAutoBackup();
    res.json({ success: true, message: "Backup saved to backups/ folder" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/backup/import — restore from uploaded zip
app.post("/api/backup/import", upload.single("backup"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const results = { clients: 0, audits: 0, reports: 0, errors: [] };
  try {
    const zip = await unzipper.Open.buffer(req.file.buffer);

    // ── Restore DB ──────────────────────────────────────────────
    const dbFile = zip.files.find((f) => f.path === "db.json");
    if (!dbFile)
      return res
        .status(400)
        .json({ error: "Invalid backup: db.json not found" });

    const dbRaw = await dbFile.buffer();
    const { clients: clientRows, audits: auditRows } = JSON.parse(
      dbRaw.toString(),
    );

    // Restore clients (upsert by id)
    for (const c of clientRows || []) {
      try {
        await pool.query(
          `INSERT INTO clients (id, name, url, platform, schedule, schedule_enabled, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (id) DO UPDATE SET
             name=$2, url=$3, platform=$4, schedule=$5, schedule_enabled=$6`,
          [
            c.id,
            c.name,
            c.url,
            c.platform || "both",
            c.schedule || null,
            c.schedule_enabled || false,
            c.created_at,
          ],
        );
        results.clients++;
      } catch (e) {
        results.errors.push(`client ${c.id}: ${e.message}`);
      }
    }

    // Restore audits (upsert by id)
    for (const a of auditRows || []) {
      try {
        await pool.query(
          `INSERT INTO audits
             (id,client_id,form_factor,performance,accessibility,best_practices,seo,
              fcp_ms,lcp_ms,tbt_ms,si_ms,tti_ms,cls,report_path,status,error_message,audited_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (id) DO NOTHING`,
          [
            a.id,
            a.client_id,
            a.form_factor || "mobile",
            a.performance,
            a.accessibility,
            a.best_practices,
            a.seo,
            a.fcp_ms,
            a.lcp_ms,
            a.tbt_ms,
            a.si_ms,
            a.tti_ms,
            a.cls,
            a.report_path || null,
            a.status || "completed",
            a.error_message || null,
            a.audited_at,
          ],
        );
        results.audits++;
      } catch (e) {
        results.errors.push(`audit ${a.id}: ${e.message}`);
      }
    }

    // Sync postgres sequences so new inserts don't collide
    await pool.query(
      `SELECT setval('clients_id_seq', COALESCE((SELECT MAX(id) FROM clients), 1))`,
    );
    await pool.query(
      `SELECT setval('audits_id_seq',  COALESCE((SELECT MAX(id) FROM audits),  1))`,
    );

    // ── Restore report files ────────────────────────────────────
    if (!fs.existsSync(REPORTS_DIR))
      fs.mkdirSync(REPORTS_DIR, { recursive: true });
    for (const file of zip.files) {
      if (
        file.path.startsWith("reports/") &&
        file.path.endsWith(".json") &&
        !file.path.endsWith("/")
      ) {
        const name = path.basename(file.path);
        const dest = path.join(REPORTS_DIR, name);
        const content = await file.buffer();
        fs.writeFileSync(dest, content);
        results.reports++;
      }
    }

    res.json({ success: true, restored: results });
  } catch (err) {
    res.status(500).json({ error: err.message, partial: results });
  }
});

(async () => {
  await waitForDb();
  await initSchedules();

  // Auto-backup: daily at 02:00
  const backupCron = process.env.BACKUP_CRON || "0 2 * * *";
  cron.schedule(backupCron, () => {
    console.log("⏰ Auto-backup starting…");
    saveAutoBackup();
  });
  console.log(
    `💾 Auto-backup scheduled: ${backupCron} (keeps last ${BACKUP_KEEP})`,
  );

  app.listen(PORT, () =>
    console.log(`🖥️  GUI running at http://localhost:${PORT}`),
  );
})();
