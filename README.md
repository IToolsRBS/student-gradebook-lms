# Gradebook Export Frontend

Express + static UI for exporting Student Support gradebooks from **MotherDuck** warehouse marts.

```
Frontend → Express → Python (DuckDB) → MotherDuck → Excel
```

- Dropdowns: `stg_moodle_categories`, `dim_programs`
- Export: `moodle_processed.gradebook_*`
- Auth: `MOTHERDUCK_TOKEN` + `MOTHERDUCK_DATABASE` (same as dbt)

See [LOCAL_RUN_SETUP.md](LOCAL_RUN_SETUP.md).

## Deploy on Render

1. Push this folder to GitHub/GitLab (repo root = this directory).
2. In [Render](https://render.com), **New → Blueprint** and connect the repo (`render.yaml` is included).
3. Set **MOTHERDUCK_TOKEN** when prompted (or in Environment after deploy).
4. Open the service URL → `/api/health` should return `{"ok":true,...}`.

Or **New → Web Service → Docker**, point at this repo, and set the same env vars from `.env.example`.

### Microsoft sign-in (production)

Auth is **required** when `NODE_ENV=production`. Register an app in [Microsoft Entra ID](https://entra.microsoft.com):

1. **App registrations** → New registration → Web redirect URI:  
   `https://<your-render-url>/auth/callback`
2. Create a **client secret** under Certificates & secrets.
3. Set on Render:
   - `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`
   - `SESSION_SECRET` (random 32+ character string)
   - `AZURE_ALLOWED_EMAILS` — comma-separated allowlist, e.g. `you@regent.ac.za,colleague@regent.ac.za`
   - `AZURE_ALLOWED_DOMAIN=regent.ac.za` (optional fallback when no allowlist is set)
   - `APP_ROLE_GRADEBOOK_ONLY_EMAILS` — optional comma-separated emails limited to **Full Gradebook Export** and **Intake Summary** (other reports stay hidden and their APIs are blocked). Everyone else keeps full access.
   - `APP_ROLE_ADMIN_EMAILS` — comma-separated admin emails. Admins get every report **plus** the **Export Audit Log** page (`/audit-log`). Non-admins cannot open that page or its APIs.

### Export audit log

Every export is recorded against the signed-in Microsoft email:

- Events: `export_started`, `export_completed`, `export_failed`, `export_downloaded`
- Each row is tagged with **`app_env`** (`prod` / `dev`) and optional **`app_url`** so shared Neon history can distinguish the two Render services.
- **Durable store (recommended):** Neon Postgres via `AUDIT_DATABASE_URL` or `NEON_DATABASE_URL` (also accepts `DATABASE_URL`). Table `grab_export_audit` is created on startup. History survives Render redeploys.
- **Local mirror:** append-only JSONL under `AUDIT_LOG_DIR` (defaults to `EXPORT_OUTPUT_DIR/audit`, typically `/tmp` on Render) — wiped on redeploy; used as fallback if Neon is unset or unreachable.
- Also emitted to server logs as `[audit] ...`
- **Admins only:** browse the log at `/audit-log` (table + filters) and download Excel-compatible CSV via **Export to Excel**

#### Neon setup (Render)

1. In the [Neon Console](https://console.neon.tech) → your project → **Dashboard** → **Connection details**.
2. Copy the connection string (include SSL; Neon URLs usually end with `?sslmode=require`). For this long-running Express app, either the **direct** or **pooled** connection string is fine.
3. On Render → your web service → **Environment**, set one of:
   - `NEON_DATABASE_URL` (matches `render.yaml`), or
   - `AUDIT_DATABASE_URL` (preferred name in docs)
4. On **each** Render service set `APP_ENV=prod` or `APP_ENV=dev` (also accepted: `AUDIT_APP_ENV`). If unset, the app infers from `BASE_URL` / `RENDER_EXTERNAL_URL` when the hostname contains `dev`/`staging`/`prod`.
5. Redeploy. Logs should show `Audit durable store: Neon Postgres` and `Audit app env: prod` (or `dev`). The audit table is created automatically — no manual SQL needed.

`BASE_URL` is optional on Render — `RENDER_EXTERNAL_URL` is used automatically.
