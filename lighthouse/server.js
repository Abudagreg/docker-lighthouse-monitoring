const express = require("express");
const { Pool } = require("pg");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPORTS_DIR = process.env.REPORTS_DIR || "/app/reports";
const WORKER_PATH = path.join(__dirname, "audit-worker.js");
const AUDIT_TIMEOUT_MS = parseInt(process.env.AUDIT_TIMEOUT_MS || "180000"); // 3 min per audit

if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3001;

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5432"),
  user: process.env.DB_USER || "lighthouse",
  password: process.env.DB_PASSWORD || "lighthouse_pass",
  database: process.env.DB_NAME || "lighthouse_db",
});

// ── Audit queue — one Chrome at a time ───────────────────────────
// Concurrent Chrome instances crash each other in a container.
// All requests go into this queue and are processed serially.
let queueRunning = false;
const auditQueue = [];

function enqueue(task) {
  return new Promise((resolve, reject) => {
    auditQueue.push({ task, resolve, reject });
    drainQueue();
  });
}

async function drainQueue() {
  if (queueRunning || auditQueue.length === 0) return;
  queueRunning = true;
  const { task, resolve, reject } = auditQueue.shift();
  console.log(`📋 Queue: running audit (${auditQueue.length} remaining)`);
  try {
    resolve(await task());
  } catch (err) {
    reject(err);
  } finally {
    queueRunning = false;
    // Brief pause between audits to let Chrome fully clean up before next spawn
    await new Promise((r) => setTimeout(r, 1000));
    drainQueue(); // process next
  }
}

// ── DB helpers ────────────────────────────────────────────────────
async function waitForDb(retries = 10, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query("SELECT 1");
      console.log("✅ Database connected");
      return;
    } catch (err) {
      console.log(`⏳ Waiting for DB... (${i + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Could not connect to database");
}

// ── Lighthouse config per form factor ─────────────────────────────
function getLighthouseConfig(formFactor) {
  if (formFactor === "desktop") {
    return {
      formFactor: "desktop",
      throttling: {
        rttMs: 40,
        throughputKbps: 10240,
        cpuSlowdownMultiplier: 1,
        requestLatencyMs: 0,
        downloadThroughputKbps: 0,
        uploadThroughputKbps: 0,
      },
      screenEmulation: {
        mobile: false,
        width: 1350,
        height: 940,
        deviceScaleFactor: 1,
        disabled: false,
      },
      emulatedUserAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };
  }
  return {
    formFactor: "mobile",
    throttling: {
      rttMs: 150,
      throughputKbps: 1638.4,
      cpuSlowdownMultiplier: 4,
      requestLatencyMs: 562.5,
      downloadThroughputKbps: 1474.56,
      uploadThroughputKbps: 675,
    },
    screenEmulation: {
      mobile: true,
      width: 360,
      height: 640,
      deviceScaleFactor: 2.625,
      disabled: false,
    },
    emulatedUserAgent:
      "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  };
}

function auditVal(lhr, key) {
  const v = lhr.audits?.[key]?.numericValue;
  return v !== undefined && v !== null && !isNaN(v) ? v : null;
}

// ── Spawn one audit worker process per audit ─────────────────────
// Each audit gets its own V8 heap. When it exits the OS reclaims all
// memory instantly — no GC pressure accumulates across audits.
function spawnAuditWorker(url, formFactor, clientId) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      AUDIT_URL: url,
      AUDIT_FORM_FACTOR: formFactor,
      AUDIT_CLIENT_ID: String(clientId || ""),
      REPORTS_DIR,
    };

    const child = spawn(
      process.execPath,
      ["--max-old-space-size=1024", WORKER_PATH],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`Audit worker timed out after ${AUDIT_TIMEOUT_MS / 1000}s`),
      );
    }, AUDIT_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (stderr) process.stderr.write(`[worker] ${stderr}`);
      try {
        const line = stdout.trim().split("\n").pop(); // last line = result JSON
        const result = JSON.parse(line);
        if (result.success) resolve(result);
        else reject(new Error(result.error || "Worker audit failed"));
      } catch {
        reject(
          new Error(
            `Worker exited ${code} with unparseable output: ${stdout.slice(0, 200)}`,
          ),
        );
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── Core audit function (runs inside the queue) ───────────────────
async function runAudit(url, formFactor, client_id) {
  let auditId = null;

  // Create a pending audit row
  if (client_id) {
    try {
      const result = await pool.query(
        `INSERT INTO audits (client_id, form_factor, status) VALUES ($1, $2, 'running') RETURNING id`,
        [client_id, formFactor],
      );
      auditId = result.rows[0].id;
    } catch (err) {
      console.error("Failed to create audit record:", err.message);
    }
  }

  try {
    console.log(`🔍 Auditing [${formFactor}]: ${url}`);

    // Run in isolated child process — full memory cleanup on exit
    const { scores, metrics, reportPath } = await spawnAuditWorker(
      url,
      formFactor,
      client_id,
    );

    if (auditId) {
      await pool.query(
        `UPDATE audits SET
           performance=$1, accessibility=$2, best_practices=$3, seo=$4,
           fcp_ms=$5, lcp_ms=$6, tbt_ms=$7, si_ms=$8, tti_ms=$9, cls=$10,
           report_path=$11, status='completed', audited_at=NOW()
         WHERE id=$12`,
        [
          scores.performance,
          scores.accessibility,
          scores.best_practices,
          scores.seo,
          metrics.fcp_ms,
          metrics.lcp_ms,
          metrics.tbt_ms,
          metrics.si_ms,
          metrics.tti_ms,
          metrics.cls,
          reportPath,
          auditId,
        ],
      );
    } else if (client_id) {
      const ins = await pool.query(
        `INSERT INTO audits
           (client_id, form_factor, performance, accessibility, best_practices, seo,
            fcp_ms, lcp_ms, tbt_ms, si_ms, tti_ms, cls, report_path, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'completed') RETURNING id`,
        [
          client_id,
          formFactor,
          scores.performance,
          scores.accessibility,
          scores.best_practices,
          scores.seo,
          metrics.fcp_ms,
          metrics.lcp_ms,
          metrics.tbt_ms,
          metrics.si_ms,
          metrics.tti_ms,
          metrics.cls,
          reportPath,
        ],
      );
      auditId = ins.rows[0].id;
    }

    console.log(`✅ Audit complete [${formFactor}] for ${url}:`, scores);
    return {
      success: true,
      url,
      form_factor: formFactor,
      scores,
      metrics,
      audit_id: auditId,
    };
  } catch (err) {
    console.error(`❌ Audit failed for ${url}:`, err.message);
    if (auditId) {
      await pool
        .query(
          `UPDATE audits SET status='failed', error_message=$1 WHERE id=$2`,
          [err.message, auditId],
        )
        .catch(() => {});
    }
    throw err;
  }
}

// ── Health ─────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "lighthouse",
    queue_length: auditQueue.length,
    queue_running: queueRunning,
  });
});

// ── Audit endpoint — immediately enqueues, returns when done ───────
app.get("/audit", async (req, res) => {
  const { url, client_id } = req.query;
  const formFactor = req.query.form_factor === "desktop" ? "desktop" : "mobile";

  if (!url)
    return res.status(400).json({ error: "`url` query param is required" });
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL format" });
  }

  const position = auditQueue.length + (queueRunning ? 1 : 0);
  if (position > 0) {
    console.log(`📋 Queuing [${formFactor}] ${url} — position ${position + 1}`);
  }

  try {
    const result = await enqueue(() => runAudit(url, formFactor, client_id));
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

(async () => {
  await waitForDb();

  app.listen(PORT, () =>
    console.log(`🚀 Lighthouse service running on port ${PORT}`),
  );
})();
