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
- **Durable store:** MotherDuck table `grab_app.export_audit_log` (created automatically). This survives Render redeploys.
- Local JSONL under `AUDIT_LOG_DIR` is only a short-lived cache (`/tmp` is wiped on redeploy).
- Also emitted to server logs as `[audit] ...`
- **Admins only:** browse the log at `/audit-log` (table + filters) and download Excel-compatible CSV via **Export to Excel**

Optional overrides: `AUDIT_WAREHOUSE_SCHEMA` (default `grab_app`), `AUDIT_WAREHOUSE_TABLE` (default `export_audit_log`).

> Note: `audit_warehouse.py` must be included in the Docker image (it is listed in the Dockerfile). Without it, Render falls back to `/tmp` and redeploys wipe the log.

`BASE_URL` is optional on Render — `RENDER_EXTERNAL_URL` is used automatically.
