# 🔦 Lighthouse Monitor

A self-hosted, containerized Lighthouse audit platform. Add websites, run audits on demand, and track performance trends — all in a clean dashboard.

## Stack

| Container    | Tech                            | Port   |
| ------------ | ------------------------------- | ------ |
| `gui`        | Node.js + Express + HTML        | `3000` |
| `lighthouse` | Node.js + Lighthouse + Chromium | `3001` |
| `db`         | PostgreSQL 15                   | `5432` |

---

## Quick Start

```bash
# Clone / enter the project
cd lighthouse-monitor

# Build and start all containers
docker compose up --build

# Open the dashboard
open http://localhost:2000
```

---

## How it works

```
Browser → GUI (3000) → POST /api/clients/:id/audit
                           ↓
                    Lighthouse service (3001)
                    GET /audit?url=...&client_id=...
                           ↓
                    Chromium runs Lighthouse
                           ↓
                    Results saved to PostgreSQL
                           ↓
                    GUI reads from DB and renders
```

---

## API Reference

### GUI Service (`:3000`)

| Method | Path                      | Description                            |
| ------ | ------------------------- | -------------------------------------- |
| GET    | `/api/clients`            | List all clients                       |
| POST   | `/api/clients`            | Add a client `{ name, url }`           |
| DELETE | `/api/clients/:id`        | Remove a client                        |
| GET    | `/api/clients/:id/audits` | Get audit history                      |
| POST   | `/api/clients/:id/audit`  | Trigger a new audit                    |
| GET    | `/api/dashboard`          | Summary of all clients + latest scores |

### Lighthouse Service (`:3001`)

| Method | Path                           | Description             |
| ------ | ------------------------------ | ----------------------- |
| GET    | `/audit?url=...&client_id=...` | Run Lighthouse on a URL |
| GET    | `/health`                      | Health check            |

---

## Development tips

```bash
# View logs
docker compose logs -f

# Restart just one service
docker compose restart gui

# Connect to the database
docker compose exec db psql -U lighthouse lighthouse_db

# Shell into lighthouse container
docker compose exec lighthouse sh
```

---

## Notes

- Audits can take **30–90 seconds** — Chromium needs time to fully load pages.
- The `--no-sandbox` flag is required for Chromium inside Docker. Only run this on trusted internal networks.
- Audit history is stored indefinitely. The UI shows the most recent 15 audits per client.
