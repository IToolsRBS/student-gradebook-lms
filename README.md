# Gradebook Export Frontend

Express + static UI for exporting Student Support gradebooks from **MotherDuck** warehouse marts.

```
Frontend → Express → Python (DuckDB) → MotherDuck → Excel
```

- Dropdowns: `stg_moodle_categories`, `dim_programs`
- Export: `moodle_processed.gradebook_*`
- Auth: `MOTHERDUCK_TOKEN` + `MOTHERDUCK_DATABASE` (same as dbt)

See [LOCAL_RUN_SETUP.md](LOCAL_RUN_SETUP.md).
