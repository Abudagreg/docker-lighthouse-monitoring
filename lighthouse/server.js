const express = require("express");
const chromeLauncher = require("chrome-launcher");
const { Pool } = require("pg");

// Lighthouse v12+ is ESM-only; dynamic import bridges CJS → ESM
let lighthouseFn;
async function getLighthouse() {
  if (!lighthouseFn) {
    const mod = await import("lighthouse");
    lighthouseFn = mod.default ?? mod.lighthouse ?? mod;
  }
  return lighthouseFn;
}

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

// ── Lighthouse configs per form factor ──────────────────────────

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
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };
  }

  // Mobile (default)
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
      "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  };
}

// ── Health ───────────────────────────────────────────────────────
app.get("/health", (req, res) =>
  res.json({ status: "ok", service: "lighthouse" }),
);

// ── Audit ────────────────────────────────────────────────────────
/**
 * GET /audit?url=https://example.com&client_id=1&form_factor=desktop
 */
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

  let chrome;
  let auditId = null;

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

    chrome = await chromeLauncher.launch({
      chromePath: process.env.CHROME_PATH || "/usr/bin/chromium",
      chromeFlags: [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-setuid-sandbox",
        "--no-zygote",
      ],
    });

    const lighthouseConfig = getLighthouseConfig(formFactor);
    const lighthouse = await getLighthouse();

    const runnerResult = await lighthouse(
      url,
      {
        logLevel: "error",
        output: "json",
        port: chrome.port,
        onlyCategories: [
          "performance",
          "accessibility",
          "best-practices",
          "seo",
          "pwa",
        ],
      },
      {
        extends: "lighthouse:default",
        settings: lighthouseConfig,
      },
    );

    const lhr = runnerResult.lhr;
    const { categories } = lhr;

    const scores = {
      performance: Math.round((categories.performance?.score || 0) * 100),
      accessibility: Math.round((categories.accessibility?.score || 0) * 100),
      best_practices: Math.round(
        (categories["best-practices"]?.score || 0) * 100,
      ),
      seo: Math.round((categories.seo?.score || 0) * 100),
      pwa: Math.round((categories.pwa?.score || 0) * 100),
    };

    // Save scores + full report JSON
    if (auditId) {
      await pool.query(
        `UPDATE audits SET
          performance=$1, accessibility=$2, best_practices=$3,
          seo=$4, pwa=$5, report_json=$6, status='completed', audited_at=NOW()
         WHERE id=$7`,
        [
          scores.performance,
          scores.accessibility,
          scores.best_practices,
          scores.seo,
          scores.pwa,
          JSON.stringify(lhr),
          auditId,
        ],
      );
    } else if (client_id) {
      const ins = await pool.query(
        `INSERT INTO audits
           (client_id, form_factor, performance, accessibility, best_practices, seo, pwa, report_json, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'completed') RETURNING id`,
        [
          client_id,
          formFactor,
          scores.performance,
          scores.accessibility,
          scores.best_practices,
          scores.seo,
          scores.pwa,
          JSON.stringify(lhr),
        ],
      );
      auditId = ins.rows[0].id;
    }

    console.log(`✅ Audit complete [${formFactor}] for ${url}:`, scores);
    res.json({
      success: true,
      url,
      form_factor: formFactor,
      scores,
      audit_id: auditId,
    });
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
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (chrome && typeof chrome.kill === "function") {
      await chrome.kill().catch(() => {});
    }
  }
});

(async () => {
  await waitForDb();
  app.listen(PORT, () =>
    console.log(`🚀 Lighthouse service running on port ${PORT}`),
  );
})();
