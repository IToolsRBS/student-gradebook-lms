"""
Build Intake Summary workbook from warehouse gradebook marts.

Filters (CLI; empty / omitted = select all for that dimension):
  category (intake), programme.

Sheet:
  Intake Summary — one row per programme with:
    programme, active modules, students enrolled, suspended students,
    students who have not accessed the portal, students with zero past-due
    submissions (same rule as inactivity Never Submitted).

Prints the absolute output path as the last stdout line (for future frontend wiring).
"""

from __future__ import annotations

import argparse
import gc
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence

import duckdb
from openpyxl import Workbook
from openpyxl.worksheet.worksheet import Worksheet

from motherduck_client import (
    connect_motherduck,
    gradebook_schema,
    qualified_relation,
)
from populate_activity_completion import _normalize_filter_values
from populate_gradebook_from_warehouse import (
    COLUMN_WIDTH_SAMPLE_ROWS,
    DEFAULT_SCHEMA,
    FETCH_CHUNK_SIZE,
    MAX_COLUMN_WIDTH,
    TABLE_MODULE,
    TABLE_PROGRAMME,
    TABLE_STUDENT,
    _mart_columns,
    _pick_first_mart_column,
    _update_col_widths,
    append_data_row,
    count_suspended_students,
    finish_sheet,
    format_cell,
    normalize_row,
    pick,
    write_headers,
)
from populate_inactivity_report import (
    _inactivity_predicate_sql,
    _never_submitted_predicate,
    _student_dimension_where,
)

SUMMARY_HEADERS: list[str] = [
    "Programme",
    "Active Modules",
    "Students Enrolled",
    "Suspended Students",
    "Students Not Accessed Portal",
    "Students With Zero Submissions",
]


def _active_modules_by_programme(
    conn: duckdb.DuckDBPyConnection,
    schema: str,
    *,
    category_names: Sequence[str],
    programme_codes: Sequence[str],
) -> dict[str, int]:
    """Count modules per programme from module summary (fallback: programme summary)."""
    # Prefer counting distinct modules in gradebook_module_summary.
    try:
        mart_cols = _mart_columns(conn, schema, TABLE_MODULE)
    except duckdb.CatalogException:
        mart_cols = {}

    if mart_cols:
        programme_col = _pick_first_mart_column(
            mart_cols, ("programme", "program_code")
        )
        module_col = _pick_first_mart_column(
            mart_cols, ("module_code", "course_shortname", "module")
        )
        if programme_col and module_col:
            where_parts, params = _student_dimension_where(
                mart_cols,
                category_names=category_names,
                programme_codes=programme_codes,
            )
            # _student_dimension_where uses student-oriented candidates; reuse
            # category/programme filters with the same helper column names.
            base_where = " AND ".join(where_parts) if where_parts else "1=1"
            relation = qualified_relation(schema, TABLE_MODULE)
            query = f"""
                SELECT
                    UPPER(TRIM(CAST("{programme_col}" AS VARCHAR))) AS programme,
                    COUNT(DISTINCT TRIM(CAST("{module_col}" AS VARCHAR))) AS active_modules
                FROM {relation}
                WHERE {base_where}
                  AND TRIM(CAST("{module_col}" AS VARCHAR)) <> ''
                GROUP BY 1
            """
            try:
                rows = conn.execute(query, params).fetchall()
                return {
                    str(prog or "").strip().upper(): int(count or 0)
                    for prog, count in rows
                    if str(prog or "").strip()
                }
            except Exception:
                pass

    # Fallback: programme summary active_modules column.
    try:
        prog_cols = _mart_columns(conn, schema, TABLE_PROGRAMME)
    except duckdb.CatalogException:
        return {}
    programme_col = _pick_first_mart_column(
        prog_cols, ("programme", "program_code")
    )
    active_col = _pick_first_mart_column(
        prog_cols, ("active_modules", "modules", "module_count")
    )
    if not programme_col or not active_col:
        return {}
    where_parts, params = _student_dimension_where(
        prog_cols,
        category_names=category_names,
        programme_codes=programme_codes,
    )
    base_where = " AND ".join(where_parts) if where_parts else "1=1"
    relation = qualified_relation(schema, TABLE_PROGRAMME)
    query = f"""
        SELECT
            UPPER(TRIM(CAST("{programme_col}" AS VARCHAR))) AS programme,
            MAX(TRY_CAST("{active_col}" AS DOUBLE)) AS active_modules
        FROM {relation}
        WHERE {base_where}
        GROUP BY 1
    """
    try:
        rows = conn.execute(query, params).fetchall()
    except Exception:
        return {}
    return {
        str(prog or "").strip().upper(): int(count or 0)
        for prog, count in rows
        if str(prog or "").strip()
    }


def write_intake_summary(
    ws: Worksheet,
    conn: duckdb.DuckDBPyConnection,
    schema: str,
    *,
    category_names: Sequence[str],
    programme_codes: Sequence[str],
) -> int:
    write_headers(ws, SUMMARY_HEADERS)
    widths = [max(12, min(len(h) + 2, MAX_COLUMN_WIDTH)) for h in SUMMARY_HEADERS]
    sample_remaining = [COLUMN_WIDTH_SAMPLE_ROWS]

    try:
        student_cols = _mart_columns(conn, schema, TABLE_STUDENT)
    except duckdb.CatalogException:
        finish_sheet(ws, len(SUMMARY_HEADERS), 0, widths)
        return 0

    programme_col = _pick_first_mart_column(
        student_cols, ("programme", "program_code", "course_prefix")
    )
    if not programme_col:
        finish_sheet(ws, len(SUMMARY_HEADERS), 0, widths)
        return 0

    never_accessed = _inactivity_predicate_sql(student_cols, "never")
    zero_submissions = _never_submitted_predicate(conn, schema, student_cols)
    status_col = _pick_first_mart_column(student_cols, ("status",))

    where_parts, params = _student_dimension_where(
        student_cols,
        category_names=category_names,
        programme_codes=programme_codes,
    )
    base_where = " AND ".join(where_parts) if where_parts else "1=1"
    relation = qualified_relation(schema, TABLE_STUDENT)

    never_accessed_expr = (
        f"SUM(CASE WHEN ({never_accessed}) THEN 1 ELSE 0 END)"
        if never_accessed
        else "0"
    )

    # Same rule as inactivity "Never Submitted": no submissions/late, and every
    # past-due assessment is status missed (future assessments ignored).
    zero_sub_expr = "0"
    if zero_submissions:
        zero_sql, zero_params = zero_submissions
        zero_sub_expr = f"SUM(CASE WHEN ({zero_sql}) THEN 1 ELSE 0 END)"
        params = list(params) + list(zero_params)

    suspended_expr = "0"
    if status_col:
        suspended_expr = (
            f"SUM(CASE WHEN LOWER(TRIM(CAST(s.\"{status_col}\" AS VARCHAR))) "
            f"= 'suspended' THEN 1 ELSE 0 END)"
        )

    select_parts = [
        f's."{programme_col}" AS programme',
        "COUNT(*) AS students_enrolled",
        f"{suspended_expr} AS suspended_students",
        f"{never_accessed_expr} AS not_accessed",
        f"{zero_sub_expr} AS zero_submissions",
    ]
    query = f"""
        SELECT {', '.join(select_parts)}
        FROM {relation} AS s
        WHERE {base_where}
        GROUP BY s."{programme_col}"
        ORDER BY s."{programme_col}"
    """

    active_modules = _active_modules_by_programme(
        conn,
        schema,
        category_names=category_names,
        programme_codes=programme_codes,
    )

    try:
        result = conn.execute(query, params)
    except Exception:
        # Retry without zero-submissions predicate if detail join fails.
        select_parts[-1] = "0 AS zero_submissions"
        query = f"""
            SELECT {', '.join(select_parts)}
            FROM {relation} AS s
            WHERE {base_where}
            GROUP BY s."{programme_col}"
            ORDER BY s."{programme_col}"
        """
        dim_params = _student_dimension_where(
            student_cols,
            category_names=category_names,
            programme_codes=programme_codes,
        )[1]
        result = conn.execute(query, dim_params)

    columns = [str(desc[0]).lower() for desc in result.description]
    count = 0
    while True:
        batch = result.fetchmany(FETCH_CHUNK_SIZE)
        if not batch:
            break
        for tup in batch:
            row = normalize_row(dict(zip(columns, tup)))
            programme = str(pick(row, "programme") or "").strip().upper()
            suspended = pick(row, "suspended_students")
            if suspended == "" or suspended is None:
                suspended = count_suspended_students(
                    conn,
                    schema,
                    [programme] if programme else programme_codes,
                    category_names[0] if len(category_names) == 1 else None,
                )
            values = [
                format_cell(pick(row, "programme")),
                format_cell(active_modules.get(programme, 0)),
                format_cell(pick(row, "students_enrolled")),
                format_cell(suspended if suspended != "" else 0),
                format_cell(pick(row, "not_accessed")),
                format_cell(pick(row, "zero_submissions")),
            ]
            _update_col_widths(widths, values, sample_remaining)
            append_data_row(ws, values)
            count += 1

    finish_sheet(ws, len(SUMMARY_HEADERS), count, widths)
    return count


def build_workbook(
    conn: duckdb.DuckDBPyConnection,
    schema: str,
    output_dir: Path,
    *,
    category_names: Sequence[str],
    programme_codes: Sequence[str],
) -> Path:
    wb = Workbook(write_only=True)
    ws = wb.create_sheet(title="Intake Summary"[:31])
    write_intake_summary(
        ws,
        conn,
        schema,
        category_names=category_names,
        programme_codes=programme_codes,
    )
    gc.collect()

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    if len(category_names) == 1:
        intake_part = category_names[0].replace(" ", "_")[:40]
    elif category_names:
        intake_part = f"batch_{len(category_names)}cat"
    else:
        intake_part = "all_intakes"
    if len(programme_codes) == 1:
        prog_part = programme_codes[0]
    elif programme_codes:
        prog_part = f"{len(programme_codes)}prog"
    else:
        prog_part = "all_programmes"
    out_path = (
        output_dir / f"intake_summary_{intake_part}_{prog_part}_{timestamp}.xlsx"
    )
    wb.save(out_path)
    return out_path.resolve()


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Export Intake Summary Excel from warehouse marts. "
            "Omit category/programme for select-all."
        )
    )
    parser.add_argument(
        "--category-name",
        action="append",
        dest="category_names",
        default=None,
        help="Category / intake name (repeatable; omit = all)",
    )
    parser.add_argument(
        "--programme-code",
        action="append",
        dest="programme_codes",
        default=None,
        help="Programme code (repeatable; omit = all)",
    )
    parser.add_argument(
        "--warehouse-schema",
        default=None,
        help="Schema for gradebook marts (default: moodle_processed)",
    )
    parser.add_argument(
        "--output-dir",
        default=".",
        help="Directory for the generated workbook",
    )
    args = parser.parse_args()

    category_names = _normalize_filter_values(args.category_names)
    programme_codes = [
        c.strip().upper() for c in _normalize_filter_values(args.programme_codes)
    ]

    schema = args.warehouse_schema or gradebook_schema() or DEFAULT_SCHEMA
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    conn = connect_motherduck()
    try:
        out_path = build_workbook(
            conn,
            schema,
            output_dir,
            category_names=category_names,
            programme_codes=programme_codes,
        )
    except Exception:
        import traceback

        traceback.print_exc()
        raise
    finally:
        conn.close()

    print(out_path)


if __name__ == "__main__":
    main()
