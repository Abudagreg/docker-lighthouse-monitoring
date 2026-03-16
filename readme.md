# 🔦 Lighthouse Monitor

A self-hosted, containerised Lighthouse audit platform. Add websites, schedule recurring audits, and track performance trends — all in a clean dark-mode dashboard with no external dependencies.

---

## Stack

| Container    | Tech                                | Port              |
| ------------ | ----------------------------------- | ----------------- |
| `gui`        | Node.js + Express + HTML/CSS/JS     | `2000`            |
| `lighthouse` | Node.js + Lighthouse v13 + Chromium | `3001`            |
| `db`         | PostgreSQL 15                       | `5432` (internal) |

---

## Quick Start

```bash
# 1. Clone the repo
git clone <your-repo-url>
cd docker-lighthouse-monitoring

# 2. Create local data folders
mkdir reports backups

# 3. Build and start all containers
docker compose up --build -d

# 4. Open the dashboard
http://localhost:2000
```

**First time only** — run the DB migration (if upgrading from an older version):

```bash
docker compose exec db psql -U lighthouse lighthouse_db -c "ALTER TABLE audits ADD COLUMN IF NOT EXISTS report_path TEXT;"
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser                                                     │
│  http://localhost:2000                                       │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTP
┌──────────────────────▼──────────────────────────────────────┐
│  gui container  (port 2000)                                  │
│  • Serves the single-page HTML dashboard                     │
│  • REST API for clients, audits, schedules, backup           │
│  • Manages cron jobs (node-cron) for scheduled audits        │
│  • Reads/writes PostgreSQL                                   │
│  • Reads report files from ./reports/ volume                 │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTP GET /audit?url=...
┌──────────────────────▼──────────────────────────────────────┐
│  lighthouse container  (port 3001)                           │
│  • FIFO audit queue — one audit at a time                    │
│  • For each audit: spawns audit-worker.js as child process   │
│  • Writes scores + report_path to PostgreSQL                 │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  audit-worker.js  (child process, one per audit)    │    │
│  │  • Launches Chromium                                │    │
│  │  • Runs Lighthouse (performance/a11y/seo/bp)        │    │
│  │  • Writes report JSON to ./reports/                 │    │
│  │  • Sends scores back to parent via stdout           │    │
│  │  • Exits — OS reclaims ALL memory                   │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│  db container  (PostgreSQL 15)                               │
│  • clients table — monitored sites + schedule config         │
│  • audits table  — scores, metrics, report_path per audit    │
└─────────────────────────────────────────────────────────────┘

Host machine bind mounts:
  ./reports/  ←→  /app/reports   (Lighthouse JSON report files)
  ./backups/  ←→  /app/backups   (auto-backup zip files)
  pg_data Docker volume          (PostgreSQL data)
```

---

## The Worker Architecture (why it exists)

Lighthouse is memory-heavy. Each audit loads a full Chromium browser, runs dozens of network and JS analysis passes, and builds a report object that can be 10–20 MB in memory. In a standard setup where all audits run in the same Node.js process, heap memory accumulates — each audit adds pressure that the garbage collector cannot fully clear before the next one starts. With 20+ URLs this reliably crashes the process around audit 14–15 with an out-of-memory error.

**The solution: one child process per audit.**

```
Before (broken for large queues):
  Node process → audit 1 (heap +200MB) → audit 2 (heap +400MB) → ... → OOM crash at audit 14

After (scales to any queue size):
  Node parent (tiny, ~50MB, just manages the queue)
    ├── spawns worker → audit 1 → exits → OS reclaims 100% of memory
    ├── spawns worker → audit 2 → exits → OS reclaims 100% of memory
    ├── spawns worker → audit 3 → exits → OS reclaims 100% of memory
    └── ... same clean slate every time, no matter how many audits
```

**How the worker communicates:**

1. Parent spawns `audit-worker.js` via `child_process.spawn`, passing the URL and config via environment variables
2. Worker launches Chrome, runs Lighthouse, writes the report JSON to `./reports/`, then prints one line of JSON to stdout:
   `{"success":true,"scores":{...},"metrics":{...},"reportPath":"..."}`
3. Worker exits — OS reclaims all memory instantly, no GC required
4. Parent reads the stdout JSON line, updates the DB, waits 1 second, then processes the next queue item

**Memory budget:**

- Parent server: `--max-old-space-size=256` MB
- Each worker: `--max-old-space-size=1024` MB (freed completely on exit)
- Container limit: `2GB` (covers parent + one active worker + Chrome overhead)

---

## Features

### Dashboard

- **Score cards** — Performance, Accessibility, Best Practices, SEO averaged across the selected date range
- **Historical trend chart** — line chart per category over time
- **Core Web Vitals** — FCP, LCP, TBT, SI, TTI, CLS with sparklines (Performance only)
- **Insights panel** — full toggleable audit details from the latest report, split into Opportunities, Diagnostics, Manual Checks, and Passed — mirrors the Lighthouse report format including tables with URL, size, and duration columns
- **Audit history** — paginated table (7-day default) with per-row delete and Lighthouse Viewer link
- **Date range filter** — 1D / 7D / 30D / All / Custom calendar picker

### Monitored Sites

- Search by name or URL with live highlight
- Filter by platform: All / Mobile / Desktop / Both
- Inline edit of client name and URL (✎ button on hover)

### Scheduling

- Per-client cron schedules via the ⚙ Schedule popup (next to Remove button)
- Quick presets: Every hour, 6h, 12h, Daily 9am, Daily midnight, Weekly Mon
- Custom cron expression with validation
- Pause / Resume / Clear per client
- Timezone displayed in schedule popup so cron times are unambiguous
- Schedules restored automatically on container restart — missed runs fire immediately on startup

### Platform Support

- **Mobile** — Moto G Power throttling, 360×640, 4× CPU slowdown
- **Desktop** — Fast cable, 1350×940, no slowdown
- **Both** — runs two separate audits queued serially (mobile first, then desktop)

### Backup & Restore

- **💾 Backup button** in the navbar opens a side panel
- **Download backup** — streams a `.zip` to your browser: `db.json` (all clients + audit records) + `reports/` folder (all Lighthouse JSON files)
- **Save to disk** — saves the zip to `./backups/` on the host machine
- **Auto-backup** — daily at 2:00 AM, keeps last 7 backups, prunes older ones automatically
- **Import / Restore** — drag & drop a backup zip; existing records are preserved (upsert, no data is wiped)

### Report Storage

Report JSON files are written to `./reports/` (a bind mount visible in File Explorer on Windows). The DB stores the file path. Old audits that have `report_json` in the DB column continue to work as a fallback. Never commit the `reports/` folder to Git.

---

## File Layout

```
docker-lighthouse-monitoring/
├── docker-compose.yml
├── deploy.sh                    # git pull + docker compose up --build -d
├── .env.example
├── .gitignore
│
├── backups/                     # auto-backup zips (bind mount, add to .gitignore)
├── reports/                     # Lighthouse JSON reports (bind mount, add to .gitignore)
│
├── db/
│   └── init.sql                 # schema — runs once on first boot
│
├── gui/
│   ├── Dockerfile
│   ├── package.json             # express, node-cron, archiver, unzipper, multer
│   ├── server.js                # REST API + schedule manager + backup endpoints
│   └── public/
│       └── index.html           # entire frontend (single file, no build step)
│
└── lighthouse/
    ├── Dockerfile
    ├── package.json             # lighthouse ^13, chrome-launcher
    ├── server.js                # queue manager + DB writer (spawns workers)
    └── audit-worker.js          # child process — runs one audit then exits
```

---

## API Reference

### GUI Service (`:2000`)

| Method | Path                               | Description                             |
| ------ | ---------------------------------- | --------------------------------------- |
| GET    | `/api/clients`                     | List all clients with last audit scores |
| POST   | `/api/clients`                     | Add a client `{ name, url, platform }`  |
| PATCH  | `/api/clients/:id`                 | Edit name/url `{ name?, url? }`         |
| DELETE | `/api/clients/:id`                 | Remove client and all history           |
| GET    | `/api/clients/:id/audits`          | Audit history                           |
| POST   | `/api/clients/:id/audit`           | Trigger audit `{ form_factor }`         |
| DELETE | `/api/audits/:id`                  | Delete a single audit record            |
| GET    | `/api/audits/:id/report`           | Full Lighthouse JSON report             |
| PUT    | `/api/clients/:id/schedule`        | Set schedule `{ expression, enabled }`  |
| DELETE | `/api/clients/:id/schedule`        | Remove schedule                         |
| PATCH  | `/api/clients/:id/schedule/toggle` | Pause or resume                         |
| GET    | `/api/schedules`                   | List all scheduled clients              |
| GET    | `/api/backup/export`               | Stream backup zip download              |
| GET    | `/api/backup/list`                 | List saved backups                      |
| GET    | `/api/backup/download/:name`       | Download a saved backup                 |
| DELETE | `/api/backup/:name`                | Delete a saved backup                   |
| POST   | `/api/backup/trigger`              | Save a backup to disk now               |
| POST   | `/api/backup/import`               | Restore from uploaded zip               |

### Lighthouse Service (`:3001`)

| Method | Path                                  | Description                 |
| ------ | ------------------------------------- | --------------------------- |
| GET    | `/audit?url=&client_id=&form_factor=` | Queue and run an audit      |
| GET    | `/health`                             | Health check + queue status |

---

## Deployment

```bash
# Update to latest
git pull
docker compose up --build -d

# Or use the deploy script
./deploy.sh

# View logs
docker compose logs -f lighthouse
docker compose logs -f gui

# Restart one service without rebuild
docker compose restart gui

# Shell into a container
docker compose exec lighthouse sh
docker compose exec db psql -U lighthouse lighthouse_db
```

### Environment Variables

| Variable           | Default        | Description                              |
| ------------------ | -------------- | ---------------------------------------- |
| `REPORTS_DIR`      | `/app/reports` | Where report JSON files are stored       |
| `BACKUPS_DIR`      | `/app/backups` | Where auto-backup zips are stored        |
| `BACKUP_KEEP`      | `7`            | Number of auto-backups to retain         |
| `BACKUP_CRON`      | `0 2 * * *`    | When auto-backup runs (daily 2am)        |
| `AUDIT_TIMEOUT_MS` | `180000`       | Max ms per audit before worker is killed |

---

## Notes

- Audits take **30–120 seconds** depending on page complexity and throttling settings
- The `--no-sandbox` Chrome flag is required inside Docker — only expose the service on trusted networks
- The audit queue is **FIFO and serial** — one Chrome instance runs at a time to prevent resource exhaustion
- `docker compose down` is safe — data persists in the `pg_data` volume and `./reports/` bind mount
- `docker compose down -v` **deletes the database** — always run a backup first
- Add `reports/` and `backups/` to `.gitignore` to avoid committing large files to your repo
