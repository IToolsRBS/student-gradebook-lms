# Gradebook Export Frontend (MotherDuck)

Staff select a **category** and **programme**, then export an Excel workbook from warehouse gradebook marts. All data access uses **MotherDuck** (same auth as dbt) — no Moodle API, no Postgres connection string.

## Architecture

```
Browser (app.js)
  → Express (server.js)
  → Python (warehouse_list.py / populate_gradebook_from_warehouse.py)
  → DuckDB → MotherDuck (md:regent_data_platform_prod)
  → stg_moodle_categories, dim_programs, gradebook_* marts
  → .xlsx download
```

## Prerequisites

- Python 3.11+ with `duckdb` and `openpyxl`
- Node.js 18+
- MotherDuck token (same as dbt `profiles.yml`)

## Environment

Create `.env` in the repo root:

```env
MOTHERDUCK_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9....   # full token, one line, no quotes
MOTHERDUCK_DATABASE=regent_data_platform_prod
WAREHOUSE_STAGING_SCHEMA=moodle_staging
WAREHOUSE_DIM_SCHEMA=moodle_processed
WAREHOUSE_GRADEBOOK_SCHEMA=moodle_processed
PORT=3000
```

Copy the **entire** access token from MotherDuck → **Settings → Access Tokens**. It may start with `eyJ` or `md_eyJ` (both work). Do not wrap the value in quotes.

| Schema | Tables |
|--------|--------|
| `moodle_staging` | `stg_moodle_categories` |
| `moodle_processed` | `dim_courses`, `dim_programs`, `gradebook_*` |
| `moodle_staging` | `int_moodle_program_codes` (maps course → canonical program code for export) |

**Category → programme relationship (via courses):**

```
stg_moodle_categories  ──category_id──►  dim_courses
                                              │
                                              ▼
                               int_moodle_program_codes
                                              │
                                              ▼
                                        dim_programs
```

Dropdowns: `category_name` from staging; `program_name` from `dim_programs` for courses in that category.
Export still filters gradebook marts by `program_code` + `category_name`.

This matches the dbt profile pattern:

```yaml
type: duckdb
path: "md:regent_data_platform_prod"
token: "{{ env_var('MOTHERDUCK_TOKEN') }}"
```

Do **not** use `WAREHOUSE_CONNECTION_STRING` or Postgres URLs for this app.

## Install and run

```bash
pip install -r requirements.txt
cd frontend
npm install
npm run dev
```

Open http://localhost:3000 → select category/programme → **Export to Excel**.

## CLI

**Dropdown data (JSON):**

```bash
python warehouse_list.py categories
python warehouse_list.py programmes --category-id 123
```

**Export:**

```bash
python populate_gradebook_from_warehouse.py \
  --programme-code PDEML \
  --category-name "2026 January Semester"
```

## Shared Python modules

| Module | Role |
|--------|------|
| `motherduck_client.py` | `connect_motherduck()` via `md:{database}?motherduck_token=...` |
| `warehouse_metadata.py` | Dropdowns from `bridge_category_programmes` (~40+ offerings/category). Restart Node after code changes; use `?refresh=true` on `/api/programmes` to bypass 60s cache. |
| `warehouse_list.py` | JSON CLI for Express dropdowns |
| `populate_gradebook_from_warehouse.py` | Builds 8-sheet Excel from `gradebook_*` marts |
