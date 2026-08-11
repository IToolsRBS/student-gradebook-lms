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
   - `APP_ROLE_GRADEBOOK_ONLY_EMAILS` — optional comma-separated emails that only see **Full Gradebook Export** (nav, landing, and other report APIs are blocked). Everyone else keeps full access.

`BASE_URL` is optional on Render — `RENDER_EXTERNAL_URL` is used automatically.
