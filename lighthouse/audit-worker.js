"use strict";
/**
 * audit-worker.js
 * Spawned as a child process for each audit.
 * Runs exactly one Lighthouse audit, writes the report to disk,
 * sends the result JSON to stdout, then exits.
 * When this process exits the OS reclaims ALL memory — no GC pressure on the parent.
 */

const fs = require("fs");
const path = require("path");

// Args passed via environment variables (safer than argv for long URLs)
const {
  AUDIT_URL,
  AUDIT_FORM_FACTOR,
  AUDIT_CLIENT_ID,
  REPORTS_DIR = "/app/reports",
} = process.env;

if (!AUDIT_URL) {
  process.stderr.write("audit-worker: AUDIT_URL not set\n");
  process.exit(1);
}

async function run() {
  const chromeLauncher = require("chrome-launcher");

  // Lazy-import Lighthouse (ESM)
  const mod = await import("lighthouse");
  const lighthouse = mod.default ?? mod.lighthouse ?? mod;

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

  const formFactor = AUDIT_FORM_FACTOR === "desktop" ? "desktop" : "mobile";
  let chrome = null;

  try {
    chrome = await chromeLauncher.launch({
      chromePath: process.env.CHROME_PATH || "/usr/bin/chromium",
      chromeFlags: [
        "--headless=new",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--hide-scrollbars",
        "--mute-audio",
        "--user-data-dir=/tmp/chrome-profile",
        "--disable-extensions",
        "--disable-background-networking",
      ],
    });

    const runnerResult = await lighthouse(
      AUDIT_URL,
      {
        logLevel: "error",
        output: "json",
        port: chrome.port,
        onlyCategories: [
          "performance",
          "accessibility",
          "best-practices",
          "seo",
        ],
        disableFullPageScreenshot: true,
      },
      {
        extends: "lighthouse:default",
        settings: getLighthouseConfig(formFactor),
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
    };

    const metrics = {
      fcp_ms: auditVal(lhr, "first-contentful-paint"),
      lcp_ms: auditVal(lhr, "largest-contentful-paint"),
      tbt_ms: auditVal(lhr, "total-blocking-time"),
      si_ms: auditVal(lhr, "speed-index"),
      tti_ms: auditVal(lhr, "interactive"),
      cls: auditVal(lhr, "cumulative-layout-shift"),
    };

    // Write pre-serialised report string directly to disk
    let reportPath = null;
    try {
      if (!fs.existsSync(REPORTS_DIR))
        fs.mkdirSync(REPORTS_DIR, { recursive: true });
      const fileName = `audit_${AUDIT_CLIENT_ID || "anon"}_${Date.now()}.json`;
      reportPath = path.join(REPORTS_DIR, fileName);
      await fs.promises.writeFile(reportPath, runnerResult.report, "utf8");
    } catch (fsErr) {
      process.stderr.write(
        `audit-worker: report write failed: ${fsErr.message}\n`,
      );
    }

    // Send result to parent via stdout as a single JSON line
    const result = { success: true, scores, metrics, reportPath, formFactor };
    process.stdout.write(JSON.stringify(result) + "\n");

    await chrome.kill();
    process.exit(0);
  } catch (err) {
    if (chrome) {
      try {
        await chrome.kill();
      } catch {}
    }
    const result = { success: false, error: err.message };
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(1);
  }
}

run();
