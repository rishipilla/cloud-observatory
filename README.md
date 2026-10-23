# Cloud Observatory

A dark, animated cloud operations dashboard built with React, TypeScript, Vite, and Recharts, backed by a FastAPI monitoring API with persistent SQLAlchemy storage.

## Requirements

- Node.js 18+ and npm
- Python 3.11+

## Configure and run on Windows PowerShell

Open two PowerShell terminals in the project directory (`cloud-observatory`).

### Backend terminal

```powershell
cd backend
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
Copy-Item .env.example .env
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

The API is available at `http://127.0.0.1:8000`; interactive documentation is at `http://127.0.0.1:8000/docs`. The default SQLite database is `backend/cloud_observatory.db`. Its data survives API restarts.

If PowerShell blocks virtual-environment activation, run `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` in that terminal, then activate again.

### Frontend terminal

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Open the Vite URL printed in the terminal, usually `http://localhost:5173`. Set `VITE_API_BASE_URL` in the frontend `.env` to the backend URL if it differs from `http://127.0.0.1:8000`. Restart Vite after changing environment variables.

## Backend configuration

Copy `backend/.env.example` to `backend/.env` before starting the API. Settings:

- `DATABASE_URL`: SQLAlchemy URL. Defaults to `sqlite:///./cloud_observatory.db`; a PostgreSQL URL can be configured later (install a PostgreSQL DBAPI such as `psycopg` when using it).
- `CORS_ORIGINS`: comma-separated browser origins allowed to access the API.
- `CHECK_CONNECT_TIMEOUT_SECONDS` and `CHECK_TOTAL_TIMEOUT_SECONDS`: per-check connection and total request timeouts.
- `CHECK_MAX_REDIRECTS`: maximum redirects followed by a monitored HTTP check.

The frontend `.env.example` contains only the public API base URL. Never put secrets in a `VITE_*` variable.

### Provider API credentials

Optional credential placeholders are available in `backend/.env.example` and the local `backend/.env` for AWS, Google Cloud, Cloudflare account APIs, and one generic provider. Put credentials only in `backend/.env`:

- AWS: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN`, and `AWS_REGION`. Use a dedicated least-privilege IAM identity.
- Google Cloud: `GOOGLE_CLOUD_PROJECT_ID` and `GOOGLE_APPLICATION_CREDENTIALS`, the path to a service-account JSON file. Do not paste service-account JSON into an environment variable or chat.
- Cloudflare account API: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The existing public status integration does not need these credentials.
- Other APIs: `EXTERNAL_API_KEY` and `EXTERNAL_API_BASE_URL`.

`GET /api/providers/config` reports whether each credential set is present and never returns key values. These fields are configuration placeholders, not complete AWS/Google Cloud/Cloudflare account adapters; provide the specific service/API and required metrics before those adapters are implemented. Keep `backend/.env` private and never commit it.

## Monitoring and data integrity

- Endpoint checks make real backend HTTP requests and persist status, elapsed time, failures, and timestamps.
- Local, private, link-local, reserved, nonstandard-port, and credentialed URLs are rejected. DNS results and every redirect destination are validated; connections use validated resolved addresses and do not use environment proxies.
- Failures and recoveries are stored as monitoring events.
- Cloudflare public status is fetched and normalized by the backend. Google Cloud and AWS remain visibly unavailable until connected.
- CPU, memory, throughput, and the illustrative latency chart are not real telemetry. The chart remains explicitly labelled **DEMO DATA**.

## Tests and production build

Backend tests:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python -m pytest -q
```

Frontend type-check and production build:

```powershell
cd ..
npm run build
```

## API endpoints

- `GET /api/health`, `GET /api/ready`, `GET /api/overview`
- `GET`, `POST /api/endpoints`
- `PATCH`, `DELETE /api/endpoints/{id}`
- `POST /api/endpoints/{id}/check`
- `GET /api/endpoints/{id}/history`
- `GET /api/providers/cloudflare`
- `GET /api/events`

Errors use the consistent `{"error":{"code":"...","message":"..."}}` response shape.

## Troubleshooting

- **Dashboard says API disconnected:** ensure Uvicorn is running at the `VITE_API_BASE_URL`; confirm `/api/health` and `/api/ready` return success. Restart Vite after changing `.env`.
- **Browser reports a CORS error:** add the exact frontend origin, including scheme and port, to `CORS_ORIGINS` in `backend/.env`; restart Uvicorn.
- **An endpoint cannot be added:** only public HTTP/HTTPS URLs on standard ports are permitted. Localhost and private destinations are blocked to prevent SSRF.
- **Cloudflare shows unavailable:** verify the backend host has internet access and retry with Refresh data. Provider failure is shown as unavailable rather than healthy.
- **Database changes do not appear:** check that the backend starts from `backend` and that `DATABASE_URL` points to the intended file/database.
