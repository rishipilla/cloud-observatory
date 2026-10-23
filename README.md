# Cloud Observatory

Cloud Observatory is a responsive React, TypeScript, and Vite dashboard for endpoint health and Cloudflare public service status. Its FastAPI backend performs on-demand HTTP checks and persists endpoint configuration, check history, and failure/recovery events using SQLAlchemy and SQLite.

## Features and data integrity

- Live API/database connection state, refresh progress, last successful refresh time, partial/stale data notices, and manual refresh.
- Endpoint create, edit, delete, immediate check, and history controls. Search, health filters, and name/status/response-time sorting operate on loaded endpoint data.
- Cloudflare's public Statuspage summary is fetched through the backend, normalized, runtime-validated in the frontend, and shown as unavailable on errors. Public status does not require an API key.
- AWS and Google Cloud are explicitly unavailable until their monitoring adapters are implemented. The API can report whether credentials are present, but credential presence does not indicate integration health.
- The response-time scatter chart plots saved backend HTTP check durations only. Its 1h, 6h, and 24h ranges contain persisted measurements; empty ranges show an empty state.
- CPU, memory, request counts, and network throughput are not measured by this project and remain unavailable.
- Dashboard appearance and automatic data-refresh interval (30 seconds, 1 minute, or 5 minutes) are saved in browser local storage.
- Monitored destinations are restricted by the backend to public HTTP/HTTPS destinations. Private/local/reserved IPs, unsafe DNS results, nonstandard ports, credentials in URLs, and unsafe redirects are blocked.

Endpoint checks are **on demand** using “Check now”; saved endpoint intervals are configuration values only and do not schedule background checks yet. The dashboard refresh interval refreshes API data and does not execute endpoint checks.

## Requirements

- Node.js 20+ and npm (the test runner requires Node.js 20+)
- Python 3.11+

## Run on Windows PowerShell

Open two PowerShell terminals in the project directory.

### 1. Install and start the backend

```powershell
Set-Location -LiteralPath .\backend
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

The API is at `http://127.0.0.1:8000`; API documentation is at `http://127.0.0.1:8000/docs`. SQLite data is written to `backend/cloud_observatory.db` and survives restarts. If PowerShell blocks virtual-environment activation, run `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` and activate again.

### 2. Install and start the frontend

In the other terminal, from the project root:

```powershell
Set-Location -LiteralPath .
npm install
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm run dev
```

Open the Vite URL (usually `http://localhost:5173`). The frontend API URL is `VITE_API_BASE_URL` in the root `.env` and defaults to `http://127.0.0.1:8000`. Restart Vite after changing it.

## Configuration and secrets

Backend configuration is in `backend/.env`; its documented template is `backend/.env.example`. Available settings include:

- `DATABASE_URL` (SQLite by default; SQLAlchemy URL can be changed for a future PostgreSQL setup)
- `CORS_ORIGINS` (comma-separated browser origins)
- Connection/total monitoring timeouts and redirect limit
- Optional backend-only credential placeholders for AWS, Google Cloud, Cloudflare account APIs, and a generic provider

Keep all keys in `backend/.env`. Never put secrets in the frontend `.env` or any `VITE_*` variable. Google Cloud credentials should be supplied as a local service-account file path, not pasted into source files. `GET /api/providers/config` reports configuration presence without revealing secret values. AWS/Google Cloud/Cloudflare account adapters are not implemented by those placeholders.

## Architecture

```text
src/
  App.tsx                 Dashboard layout and interactions
  api.ts                  Typed frontend API client, timeouts, Cloudflare parsing
  components/ui.tsx       Reusable Button, Card, Badge, loading, and empty states
  preferences.ts          Validated browser-persisted preferences
  styles.css              Dashboard theme and responsive layout
  *.test.ts(x)            API, component, and dashboard interaction tests
backend/
  app/main.py             FastAPI app, CORS, normalized errors
  app/config.py           Environment-backed settings
  app/database.py         SQLAlchemy engine and database session
  app/models.py           Endpoint, check, and monitoring-event tables
  app/schemas.py          Pydantic request/response schemas
  app/routes.py           API routes
  app/services/monitoring.py  SSRF-conscious HTTP checks and DNS validation
  tests/                  Backend API and monitoring tests
package.json              Development, test, and production-build scripts
```

## API

- `GET /api/health`, `GET /api/ready`, `GET /api/overview`
- `GET /api/endpoints`, `POST /api/endpoints`
- `PATCH /api/endpoints/{id}`, `DELETE /api/endpoints/{id}`
- `POST /api/endpoints/{id}/check`, `GET /api/endpoints/{id}/history`
- `GET /api/providers/cloudflare`, `GET /api/providers/config`
- `GET /api/events`

API errors use `{"error":{"code":"...","message":"..."}}`.

## Tests and production build

Frontend tests, including API parsing/errors and dashboard interactions:

```powershell
npm test
```

Frontend TypeScript validation and production bundle:

```powershell
npm run build
```

Backend tests:

```powershell
Set-Location -LiteralPath .\backend
.\.venv\Scripts\Activate.ps1
python -m pytest -q
```

## Screenshots

Run the dashboard and backend locally, add an endpoint you are authorized to monitor, and run a check. Capture the browser at desktop and narrow/mobile widths. Save reviewed screenshots under `docs/screenshots/` (for example, `docs/screenshots/dashboard-desktop.png` and `docs/screenshots/dashboard-mobile.png`) and link them here when added. Do not include credentials, private endpoint URLs, or sensitive monitoring results in screenshots.

## Troubleshooting

- **API disconnected:** start Uvicorn and check `http://127.0.0.1:8000/api/health` and `/api/ready`; verify `VITE_API_BASE_URL`, then restart Vite.
- **CORS error:** add the exact frontend origin (scheme and port) to `CORS_ORIGINS` in `backend/.env`, then restart Uvicorn.
- **Endpoint rejected:** only standard-port public HTTP/HTTPS destinations are permitted. Private, local, reserved, credentialed, or disallowed redirect targets are rejected intentionally.
- **Cloudflare unavailable:** check backend outbound internet access and refresh. Provider errors are shown as unavailable; no healthy status is fabricated.
- **No chart points:** run one or more endpoint checks and select a range that includes their saved timestamps.
- **Settings reset:** theme and dashboard refresh interval use this browser's local storage. Clearing site data resets the preferences.
- **Database seems empty:** the SQLite path is relative to the backend working directory. Start Uvicorn from `backend` and check `DATABASE_URL`.
