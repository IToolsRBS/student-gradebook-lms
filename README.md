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
