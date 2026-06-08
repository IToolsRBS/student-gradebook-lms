"""
Warehouse dropdown queries.

Primary source (after dbt run): moodle_processed.bridge_category_programmes
  — one row per (category, course shortname prefix), e.g. BCOMHR under 2026 January Semester.

Fallback: join stg_moodle_categories + dim_courses + int_moodle_program_codes.
"""

from __future__ import annotations

from typing import Any, Sequence

import duckdb

from motherduck_client import (
    courses_schema,
    dim_schema,
    gradebook_schema,
    qualified_relation,
    read_env_value,
    staging_schema,
)

INT_PROGRAM_CODES_TABLE = "int_moodle_program_codes"
BRIDGE_CATEGORY_PROGRAMMES_TABLE = "bridge_category_programmes"


def _table_columns(conn: duckdb.DuckDBPyConnection, qualified: str) -> set[str]:
    df = conn.execute(f"SELECT * FROM {qualified} LIMIT 0").fetchdf()
    return set(df.columns)


def _coalesce_sql(
    conn: duckdb.DuckDBPyConnection,
    qualified: str,
    alias: str,
    candidates: tuple[str, ...],
) -> str:
    """Build alias.col or COALESCE(alias.a, alias.b) using only columns that exist."""
    cols = _table_columns(conn, qualified)
    present = [c for c in candidates if c in cols]
    if not present:
        raise RuntimeError(
            f"{qualified} has none of {candidates}; found: {sorted(cols)}"
        )
    if len(present) == 1:
        return f"{alias}.{present[0]}"
    return "COALESCE(" + ", ".join(f"{alias}.{c}" for c in present) + ")"


def bridge_category_programmes_relation(
    conn: duckdb.DuckDBPyConnection,
) -> str | None:
    """Qualified bridge_category_programmes when deployed in MotherDuck."""
    override = read_env_value("WAREHOUSE_BRIDGE_SCHEMA")
    schemas: list[str] = []
    if override:
        schemas.append(override)
    schemas.extend([dim_schema(), gradebook_schema()])
    seen: set[str] = set()
    for schema in schemas:
        if schema in seen:
            continue
        seen.add(schema)
        qualified = qualified_relation(schema, BRIDGE_CATEGORY_PROGRAMMES_TABLE)
        try:
            conn.execute(f"SELECT 1 FROM {qualified} LIMIT 1")
            return qualified
        except duckdb.CatalogException:
            continue
    return None


def int_program_codes_relation(conn: duckdb.DuckDBPyConnection) -> str | None:
    """Qualified int_moodle_program_codes table (staging or dim schema)."""
    override = read_env_value("WAREHOUSE_INT_PROGRAM_CODES_SCHEMA")
    schemas: list[str] = []
    if override:
        schemas.append(override)
    schemas.extend([staging_schema(), dim_schema()])
    seen: set[str] = set()
    for schema in schemas:
        if schema in seen:
            continue
        seen.add(schema)
        qualified = qualified_relation(schema, INT_PROGRAM_CODES_TABLE)
        try:
            conn.execute(f"SELECT 1 FROM {qualified} LIMIT 1")
            return qualified
        except duckdb.CatalogException:
            continue
    return None


def _category_course_join(
    conn: duckdb.DuckDBPyConnection, courses: str, categories: str
) -> dict[str, str]:
    return {
        "dc_course_id": _coalesce_sql(
            conn, courses, "dc", ("course_id", "id", "moodle_course_id")
        ),
        "dc_shortname": _coalesce_sql(
            conn, courses, "dc", ("course_shortname", "shortname", "module_shortname")
        ),
        "dc_category_id": _coalesce_sql(
            conn, courses, "dc", ("category_id", "moodle_category_id")
        ),
        "cat_category_id": _coalesce_sql(
            conn, categories, "cat", ("category_id", "id", "moodle_category_id")
        ),
    }


def _programmes_sql(
    conn: duckdb.DuckDBPyConnection,
    *,
    include_int: bool,
    courses: str,
    categories: str,
    programs: str,
    program_codes_tbl: str,
) -> str:
    """
    Programme codes for dropdown/export.

    Course shortnames often use a Moodle prefix (e.g. HCACC_…) while gradebook marts
    store the canonical code from int_moodle_program_codes (e.g. BCOM). Prefer the
    int mapping per course when present.
    """
    join = _category_course_join(conn, courses, categories)
    p_program_code = _coalesce_sql(
        conn, programs, "p", ("program_code", "programme_code")
    )
    p_program_name = _coalesce_sql(
        conn, programs, "p", ("program_name", "programme_name")
    )

    short_prefix = "UPPER(TRIM(split_part(cc.shortname, '_', 1)))"
    if include_int:
        ipc_course_id = _coalesce_sql(
            conn, program_codes_tbl, "ipc", ("course_id", "moodle_course_id")
        )
        ipc_program_code = _coalesce_sql(
            conn, program_codes_tbl, "ipc", ("program_code", "programme_code")
        )
        canonical_expr = f"""
        COALESCE(
            NULLIF(UPPER(TRIM({ipc_program_code})), ''),
            {short_prefix}
        )
        """
        int_join = f"""
    LEFT JOIN {program_codes_tbl} AS ipc
        ON CAST({ipc_course_id} AS BIGINT) = cc.course_id
"""
    else:
        canonical_expr = short_prefix
        int_join = ""

    return f"""
WITH category_courses AS (
    SELECT
        CAST({join["dc_course_id"]} AS BIGINT) AS course_id,
        TRIM(COALESCE({join["dc_shortname"]}, '')) AS shortname
    FROM {courses} AS dc
    INNER JOIN {categories} AS cat
        ON CAST({join["dc_category_id"]} AS BIGINT)
         = CAST({join["cat_category_id"]} AS BIGINT)
    WHERE TRIM(cat.category_name) = ?
),
canonical_codes AS (
    SELECT DISTINCT
        {canonical_expr} AS program_code
    FROM category_courses AS cc
    {int_join}
    WHERE cc.shortname <> ''
      AND TRIM(split_part(cc.shortname, '_', 1)) <> ''
      AND {canonical_expr} IS NOT NULL
      AND TRIM(CAST({canonical_expr} AS VARCHAR)) <> ''
)
SELECT DISTINCT
    cc.program_code AS programme_code,
    COALESCE(
        NULLIF(TRIM({p_program_name}), ''),
        cc.program_code
    ) AS program_name
FROM canonical_codes AS cc
LEFT JOIN {programs} AS p
    ON UPPER(TRIM(COALESCE({p_program_code}, ''))) = cc.program_code
WHERE cc.program_code IS NOT NULL
  AND cc.program_code <> ''
ORDER BY program_name
"""


def resolve_export_program_codes(
    conn: duckdb.DuckDBPyConnection,
    category_name: str,
    programme_code: str,
    dim_schema_name: str | None = None,
    staging_schema_name: str | None = None,
) -> list[str]:
    """
    Map a dropdown/CLI programme code to the code(s) used in gradebook_* marts.

    Accepts a course_prefix from bridge_category_programmes (e.g. BCOMHR) or an
    already-canonical program code (e.g. BCOM).
    """
    programme_code = programme_code.strip().upper()
    category_name = category_name.strip()
    if not programme_code:
        return []

    bridge = bridge_category_programmes_relation(conn)
    if bridge:
        df = conn.execute(
            f"""
            SELECT DISTINCT
                UPPER(TRIM(COALESCE(
                    NULLIF(TRIM(program_code), ''),
                    course_prefix
                ))) AS program_code
            FROM {bridge}
            WHERE TRIM(category_name) = ?
              AND (
                  UPPER(TRIM(course_prefix)) = ?
                  OR UPPER(TRIM(COALESCE(program_code, ''))) = ?
              )
            ORDER BY program_code
            """,
            [category_name, programme_code, programme_code],
        ).fetchdf()
        codes = [
            str(row.get("program_code") or "").strip().upper()
            for row in df.to_dict("records")
            if str(row.get("program_code") or "").strip()
        ]
        if codes:
            return codes

    dim = dim_schema_name or dim_schema()
    staging = staging_schema_name or staging_schema()
    categories = qualified_relation(staging, "stg_moodle_categories")
    courses = qualified_relation(courses_schema(), "dim_courses")
    program_codes_tbl = int_program_codes_relation(conn)
    join = _category_course_join(conn, courses, categories)
    short_prefix = "UPPER(TRIM(split_part(cc.shortname, '_', 1)))"

    if program_codes_tbl:
        ipc_course_id = _coalesce_sql(
            conn, program_codes_tbl, "ipc", ("course_id", "moodle_course_id")
        )
        ipc_program_code = _coalesce_sql(
            conn, program_codes_tbl, "ipc", ("program_code", "programme_code")
        )
        canonical_expr = f"""
        COALESCE(
            NULLIF(UPPER(TRIM({ipc_program_code})), ''),
            {short_prefix}
        )
        """
        int_join = f"""
        LEFT JOIN {program_codes_tbl} AS ipc
            ON CAST({ipc_course_id} AS BIGINT) = cc.course_id
        """
    else:
        canonical_expr = short_prefix
        int_join = ""

    df = conn.execute(
        f"""
        WITH category_courses AS (
            SELECT
                CAST({join["dc_course_id"]} AS BIGINT) AS course_id,
                TRIM(COALESCE({join["dc_shortname"]}, '')) AS shortname
            FROM {courses} AS dc
            INNER JOIN {categories} AS cat
                ON CAST({join["dc_category_id"]} AS BIGINT)
                 = CAST({join["cat_category_id"]} AS BIGINT)
            WHERE TRIM(cat.category_name) = ?
        ),
        mapped AS (
            SELECT DISTINCT
                {short_prefix} AS short_prefix,
                {canonical_expr} AS canonical_code
            FROM category_courses AS cc
            {int_join}
            WHERE cc.shortname <> ''
              AND TRIM(split_part(cc.shortname, '_', 1)) <> ''
        )
        SELECT DISTINCT canonical_code AS program_code
        FROM mapped
        WHERE canonical_code IS NOT NULL
          AND TRIM(CAST(canonical_code AS VARCHAR)) <> ''
          AND (
              short_prefix = ?
              OR canonical_code = ?
          )
        ORDER BY program_code
        """,
        [category_name, programme_code, programme_code],
    ).fetchdf()

    codes = [
        str(row.get("program_code") or "").strip().upper()
        for row in df.to_dict("records")
        if str(row.get("program_code") or "").strip()
    ]
    return codes or [programme_code]


def course_ids_for_offering(
    conn: duckdb.DuckDBPyConnection,
    category_name: str,
    course_prefix: str,
) -> list[int]:
    """Moodle course IDs for a category + shortname prefix (e.g. 2025 January + PDEML)."""
    category_name = category_name.strip()
    course_prefix = course_prefix.strip().upper()
    if not category_name or not course_prefix:
        return []

    courses = qualified_relation(courses_schema(), "dim_courses")
    dc_course_id = _coalesce_sql(
        conn, courses, "dc", ("course_id", "id", "moodle_course_id")
    )
    dc_shortname = _coalesce_sql(
        conn, courses, "dc", ("course_shortname", "shortname", "module_shortname")
    )
    cols = _table_columns(conn, courses)
    if "category_name" in cols:
        df = conn.execute(
            f"""
            SELECT DISTINCT CAST({dc_course_id} AS BIGINT) AS course_id
            FROM {courses} AS dc
            WHERE TRIM(dc.category_name) = ?
              AND UPPER(TRIM(split_part({dc_shortname}, '_', 1))) = ?
            ORDER BY course_id
            """,
            [category_name, course_prefix],
        ).fetchdf()
    else:
        categories = qualified_relation(
            staging_schema(), "stg_moodle_categories"
        )
        cat_join = _category_course_join(conn, courses, categories)
        df = conn.execute(
            f"""
            SELECT DISTINCT CAST({cat_join["dc_course_id"]} AS BIGINT) AS course_id
            FROM {courses} AS dc
            INNER JOIN {categories} AS cat
                ON CAST({cat_join["dc_category_id"]} AS BIGINT)
                 = CAST({cat_join["cat_category_id"]} AS BIGINT)
            WHERE TRIM(cat.category_name) = ?
              AND UPPER(TRIM(split_part({cat_join["dc_shortname"]}, '_', 1))) = ?
            ORDER BY course_id
            """,
            [category_name, course_prefix],
        ).fetchdf()

    return [
        int(row["course_id"])
        for row in df.to_dict("records")
        if row.get("course_id") is not None
    ]


def fetch_categories(
    conn: duckdb.DuckDBPyConnection, staging_schema_name: str | None = None
) -> list[dict[str, Any]]:
    """Categories that have at least one programme offering (bridge mart preferred)."""
    bridge = bridge_category_programmes_relation(conn)
    if bridge:
        df = conn.execute(
            f"""
            SELECT DISTINCT
                category_id,
                TRIM(category_name) AS category_name
            FROM {bridge}
            WHERE category_name IS NOT NULL
              AND TRIM(category_name) <> ''
              AND course_count > 0
            ORDER BY category_name
            """
        ).fetchdf()
    else:
        staging = staging_schema_name or staging_schema()
        categories = qualified_relation(staging, "stg_moodle_categories")
        courses = qualified_relation(courses_schema(), "dim_courses")
        join = _category_course_join(conn, courses, categories)
        df = conn.execute(
            f"""
            SELECT DISTINCT
                CAST({join["cat_category_id"]} AS BIGINT) AS category_id,
                TRIM(cat.category_name) AS category_name
            FROM {categories} AS cat
            INNER JOIN {courses} AS dc
                ON CAST({join["dc_category_id"]} AS BIGINT)
                 = CAST({join["cat_category_id"]} AS BIGINT)
            WHERE cat.category_name IS NOT NULL
              AND TRIM(cat.category_name) <> ''
            ORDER BY category_name
            """
        ).fetchdf()

    return [
        {
            "category_id": int(row["category_id"])
            if row.get("category_id") is not None
            else None,
            "category_name": str(row.get("category_name") or "").strip(),
        }
        for row in df.to_dict("records")
        if str(row.get("category_name") or "").strip()
    ]


def _programme_codes_with_gradebook_rows(
    conn: duckdb.DuckDBPyConnection, programme_codes: Sequence[str]
) -> set[str]:
    """Programme codes that have at least one row in gradebook marts."""
    codes = sorted({str(c).strip().upper() for c in programme_codes if str(c).strip()})
    if not codes:
        return set()
    schema = gradebook_schema()
    rel = qualified_relation(schema, "gradebook_student_summary")
    placeholders = ", ".join("?" for _ in codes)
    df = conn.execute(
        f"""
        SELECT DISTINCT UPPER(TRIM(CAST(programme AS VARCHAR))) AS programme_code
        FROM {rel}
        WHERE UPPER(TRIM(CAST(programme AS VARCHAR))) IN ({placeholders})
        """,
        codes,
    ).fetchdf()
    return {
        str(row.get("programme_code") or "").strip().upper()
        for row in df.to_dict("records")
        if str(row.get("programme_code") or "").strip()
    }


def _rows_to_programmes(df) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for row in df.to_dict("records"):
        code = str(row.get("programme_code") or "").strip()
        if not code or code.lower() == "nan":
            continue
        name = str(row.get("program_name") or "").strip()
        if not name or name.lower() == "nan":
            name = code
        entry: dict[str, Any] = {
            "programme_code": code,
            "program_name": name,
        }
        raw_canonical = row.get("program_code")
        if raw_canonical is not None and str(raw_canonical).strip():
            canonical = str(raw_canonical).strip()
            if canonical.lower() != "nan":
                entry["program_code"] = canonical
        rows.append(entry)
    return rows


def _programmes_require_gradebook() -> bool:
    """When true, dropdown only lists offerings with gradebook mart rows (legacy behaviour)."""
    flag = (read_env_value("WAREHOUSE_PROGRAMMES_REQUIRE_GRADEBOOK") or "").lower()
    return flag in ("1", "true", "yes", "on")


def _fetch_programmes_from_bridge(
    conn: duckdb.DuckDBPyConnection, bridge: str, category_name: str
) -> list[dict[str, Any]]:
    df = conn.execute(
        f"""
        SELECT
            UPPER(TRIM(course_prefix)) AS programme_code,
            TRIM(programme_name) AS program_name,
            NULLIF(TRIM(program_code), '') AS program_code
        FROM {bridge}
        WHERE TRIM(category_name) = ?
          AND course_prefix IS NOT NULL
          AND TRIM(course_prefix) <> ''
        ORDER BY programme_name, programme_code
        """,
        [category_name],
    ).fetchdf()
    return _rows_to_programmes(df)


def _fetch_programmes_fallback(
    conn: duckdb.DuckDBPyConnection,
    category_name: str,
    dim_schema_name: str | None = None,
    staging_schema_name: str | None = None,
) -> list[dict[str, Any]]:
    """
    Same grain as bridge_category_programmes: distinct raw_prefix per category.
    Used when the bridge mart has not been deployed to MotherDuck yet.
    """
    dim = dim_schema_name or dim_schema()
    staging = staging_schema_name or staging_schema()
    categories = qualified_relation(staging, "stg_moodle_categories")
    courses = qualified_relation(courses_schema(), "dim_courses")
    programs = qualified_relation(dim, "dim_programs")
    program_codes_tbl = int_program_codes_relation(conn)
    join = _category_course_join(conn, courses, categories)

    if program_codes_tbl:
        ipc_cols = _table_columns(conn, program_codes_tbl)
        if "raw_prefix" in ipc_cols:
            ipc_course_id = _coalesce_sql(
                conn, program_codes_tbl, "ipc", ("course_id", "moodle_course_id")
            )
            ipc_raw_prefix = _coalesce_sql(
                conn, program_codes_tbl, "ipc", ("raw_prefix",)
            )
            ipc_program_code = _coalesce_sql(
                conn, program_codes_tbl, "ipc", ("program_code", "programme_code")
            )
            p_program_name = _coalesce_sql(
                conn, programs, "p", ("program_name", "programme_name")
            )
            p_program_code = _coalesce_sql(
                conn, programs, "p", ("program_code", "programme_code")
            )
            sql = f"""
            SELECT DISTINCT
                UPPER(TRIM({ipc_raw_prefix})) AS programme_code,
                COALESCE(
                    NULLIF(TRIM({p_program_name}), ''),
                    UPPER(TRIM({ipc_raw_prefix}))
                ) AS program_name,
                NULLIF(TRIM({ipc_program_code}), '') AS program_code
            FROM {courses} AS dc
            INNER JOIN {categories} AS cat
                ON CAST({join["dc_category_id"]} AS BIGINT)
                 = CAST({join["cat_category_id"]} AS BIGINT)
            INNER JOIN {program_codes_tbl} AS ipc
                ON CAST({ipc_course_id} AS BIGINT)
                 = CAST({join["dc_course_id"]} AS BIGINT)
            LEFT JOIN {programs} AS p
                ON UPPER(TRIM(COALESCE({p_program_code}, '')))
                 = UPPER(TRIM(COALESCE({ipc_program_code}, '')))
            WHERE TRIM(cat.category_name) = ?
              AND {ipc_raw_prefix} IS NOT NULL
              AND TRIM(CAST({ipc_raw_prefix} AS VARCHAR)) <> ''
            ORDER BY program_name, programme_code
            """
            return _rows_to_programmes(conn.execute(sql, [category_name]).fetchdf())

    sql = _programmes_sql(
        conn,
        include_int=False,
        courses=courses,
        categories=categories,
        programs=programs,
        program_codes_tbl="",
    )
    return _rows_to_programmes(conn.execute(sql, [category_name]).fetchdf())


def fetch_programmes(
    conn: duckdb.DuckDBPyConnection,
    category_name: str,
    dim_schema_name: str | None = None,
    staging_schema_name: str | None = None,
) -> list[dict[str, Any]]:
    """
    All programme offerings for the selected category (course_prefix / raw_prefix grain).

    Uses bridge_category_programmes when deployed; otherwise int_moodle_program_codes.
    Returns every offering in the category — not limited to gradebook marts (BCOM/MBA/BBA).
    Set WAREHOUSE_PROGRAMMES_REQUIRE_GRADEBOOK=true to restore the old filtered list.
    """
    category_name = category_name.strip()
    bridge = bridge_category_programmes_relation(conn)
    if bridge:
        rows = _fetch_programmes_from_bridge(conn, bridge, category_name)
    else:
        rows = _fetch_programmes_fallback(
            conn,
            category_name,
            dim_schema_name=dim_schema_name,
            staging_schema_name=staging_schema_name,
        )

    if not rows:
        return []

    if _programmes_require_gradebook():
        return _filter_programmes_with_gradebook(
            conn,
            category_name,
            rows,
            dim_schema_name,
            staging_schema_name,
        )
    return rows


def _filter_programmes_with_gradebook(
    conn: duckdb.DuckDBPyConnection,
    category_name: str,
    rows: list[dict[str, Any]],
    dim_schema_name: str | None,
    staging_schema_name: str | None,
) -> list[dict[str, Any]]:
    export_candidates: list[str] = []
    for row in rows:
        export_candidates.extend(
            resolve_export_program_codes(
                conn,
                category_name,
                row["programme_code"],
                dim_schema_name=dim_schema_name,
                staging_schema_name=staging_schema_name,
            )
        )
    with_data = _programme_codes_with_gradebook_rows(conn, export_candidates)
    if not with_data:
        return []
    filtered: list[dict[str, Any]] = []
    for row in rows:
        export_codes = resolve_export_program_codes(
            conn,
            category_name,
            row["programme_code"],
            dim_schema_name=dim_schema_name,
            staging_schema_name=staging_schema_name,
        )
        if set(export_codes) & with_data:
            filtered.append(row)
    return filtered


def debug_programme_chain(
    conn: duckdb.DuckDBPyConnection,
    category_name: str,
) -> dict[str, Any]:
    """Row counts at each step — run via warehouse_debug.py for troubleshooting."""
    staging = staging_schema()
    dim = dim_schema()
    categories = qualified_relation(staging, "stg_moodle_categories")
    courses = qualified_relation(courses_schema(), "dim_courses")
    category_name = category_name.strip()
    join = _category_course_join(conn, courses, categories)

    def count(sql: str, params: list[Any] | None = None) -> int:
        if params:
            return int(conn.execute(sql, params).fetchone()[0])
        return int(conn.execute(sql).fetchone()[0])

    out: dict[str, Any] = {"category_name": category_name}
    bridge = bridge_category_programmes_relation(conn)
    if bridge:
        out["bridge_table"] = bridge
        out["bridge_programmes"] = count(
            f"""
            SELECT COUNT(*)
            FROM {bridge}
            WHERE TRIM(category_name) = ?
            """,
            [category_name],
        )
    else:
        out["bridge_table"] = "unavailable: bridge_category_programmes not found"

    out["categories_total"] = count(f"SELECT COUNT(*) FROM {categories}")
    out["courses_total"] = count(f"SELECT COUNT(*) FROM {courses}")
    out["category_courses"] = count(
        f"""
        SELECT COUNT(*)
        FROM {courses} dc
        INNER JOIN {categories} cat
            ON CAST({join["dc_category_id"]} AS BIGINT)
             = CAST({join["cat_category_id"]} AS BIGINT)
        WHERE TRIM(cat.category_name) = ?
        """,
        [category_name],
    )
    out["shortname_codes"] = count(
        f"""
        WITH cc AS (
            SELECT TRIM(COALESCE({join["dc_shortname"]}, '')) AS shortname
            FROM {courses} dc
            INNER JOIN {categories} cat
                ON CAST({join["dc_category_id"]} AS BIGINT)
                 = CAST({join["cat_category_id"]} AS BIGINT)
            WHERE TRIM(cat.category_name) = ?
        )
        SELECT COUNT(DISTINCT UPPER(TRIM(split_part(shortname, '_', 1)))
        FROM cc
        WHERE shortname <> ''
        """,
        [category_name],
    )
    ipc = int_program_codes_relation(conn)
    if ipc:
        ipc_course_id = _coalesce_sql(
            conn, ipc, "ipc", ("course_id", "moodle_course_id")
        )
        ipc_program_code = _coalesce_sql(
            conn, ipc, "ipc", ("program_code", "programme_code")
        )
        out["int_codes_joined"] = count(
            f"""
            WITH cc AS (
                SELECT CAST({join["dc_course_id"]} AS BIGINT) AS course_id
                FROM {courses} dc
                INNER JOIN {categories} cat
                    ON CAST({join["dc_category_id"]} AS BIGINT)
                     = CAST({join["cat_category_id"]} AS BIGINT)
                WHERE TRIM(cat.category_name) = ?
            )
            SELECT COUNT(DISTINCT UPPER(TRIM({ipc_program_code})))
            FROM {ipc} ipc
            INNER JOIN cc ON CAST({ipc_course_id} AS BIGINT) = cc.course_id
            """,
            [category_name],
        )
    else:
        out["int_codes_joined"] = "unavailable: int_moodle_program_codes not found"

    out["programmes_returned"] = len(fetch_programmes(conn, category_name))
    return out
