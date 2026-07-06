"""
Build Gradebook export workbook from warehouse dbt marts (moodle_processed.*).

Reads pre-built tables; does not sync Moodle or run dbt.
Prints the absolute output path as the last stdout line for frontend/server.js.
"""

from __future__ import annotations

import argparse
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable, Sequence

import duckdb
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.worksheet.worksheet import Worksheet

from motherduck_client import (
    connect_motherduck,
    gradebook_schema,
    qualified_relation,
    read_env_value,
)
from warehouse_export_fallback import build_workbook_offering_fallback

DEFAULT_SCHEMA = "moodle_processed"

# Mart table names (within WAREHOUSE_GRADEBOOK_SCHEMA)
TABLE_PROGRAMME = "gradebook_programme_summary"
TABLE_STUDENT = "gradebook_student_summary"
TABLE_MODULE = "gradebook_module_summary"
TABLE_TRENDS = "gradebook_submission_trends"
TABLE_ASSESSMENT = "gradebook_student_assessment_detail"
TABLE_MISSED = "gradebook_missed_assessments"
TABLE_UPCOMING = "gradebook_upcoming_deadlines"
TABLE_COURSE_NOTES = "gradebook_course_notes"
COURSE_NOTES_SHEET_TITLE = "Course Notes"
COURSE_NOTES_COLUMNS: tuple[str, ...] = (
    "user_full_name",
    "username",
    "course_display_name",
    "content",
    "timestamp",
    "staff_id",
)

NOTE_FIELD_MAP: list[tuple[str, tuple[str, ...]]] = [
    ("Latest note", ("latest_note_content",)),
    ("Note timestamp", ("latest_note_timestamp",)),
    ("Note created by", ("latest_note_staff_id",)),
    ("Note course", ("latest_note_course_display_name",)),
]

# Column headers for mart sheets (used when workbooks need empty placeholder tabs).
MART_SHEET_HEADERS: dict[str, list[str]] = {
    "Submission Trends": [
        "Programme",
        "Module Code",
        "Module",
        "Assessment",
        "Assessment Type",
        "Due Date",
        "Total Students",
        "Submitted Count",
        "Missed Count",
        "Late Submissions",
        "Submitted %",
        "Missed %",
        "Late %",
    ],
    "Missed Assessments": [
        "Student No",
        "Student",
        "Email",
        "Programme",
        "Module Code",
        "Module",
        "Assessment",
        "Assessment Type",
        "Due Date",
        "Effective Deadline",
        "Days Overdue",
        "Status",
        "Latest note",
        "Note timestamp",
        "Note created by",
        "Note course",
    ],
    "Upcoming Deadlines": [
        "Programme",
        "Module Code",
        "Module",
        "Assessment",
        "Assessment Type",
        "Effective Deadline",
        "Hours Until Due",
    ],
}

# Per-mart programme/category filter columns (warehouse schema).
# All gradebook marts are scoped by category_name (intake) + offering code.
# All marts filter on programme (dropdown value from gradebook_module_summary).
MART_FILTER: dict[str, dict[str, Any]] = {
    TABLE_PROGRAMME: {
        "programme_cols": ("programme", "program_code"),
        "category_cols": ("category_name",),
    },
    TABLE_STUDENT: {
        "programme_cols": ("programme", "program_code"),
        "category_cols": ("category_name",),
    },
    TABLE_MODULE: {
        "programme_cols": ("programme", "program_code"),
        "category_cols": ("category_name",),
    },
    TABLE_TRENDS: {
        "programme_cols": ("programme", "program_code"),
        "category_cols": ("category_name",),
    },
    TABLE_ASSESSMENT: {
        # programme when present; else course_prefix (not program_code — that is canonical).
        "programme_cols": ("programme", "course_prefix"),
        "category_cols": ("category_name",),
    },
    TABLE_MISSED: {
        "programme_cols": ("programme", "program_code"),
        "category_cols": ("category_name",),
    },
    TABLE_UPCOMING: {
        "programme_cols": ("programme",),
        "category_cols": ("category_name",),
    },
}


def _mart_columns(
    conn: duckdb.DuckDBPyConnection, schema: str, table: str
) -> dict[str, str]:
    """Lowercase column name -> actual mart column name."""
    relation = qualified_relation(schema, table)
    df = conn.execute(f"SELECT * FROM {relation} LIMIT 0").fetchdf()
    return {str(col).lower(): str(col) for col in df.columns}


def _pick_first_mart_column(
    mart_cols: dict[str, str], candidates: Sequence[str]
) -> str | None:
    for candidate in candidates:
        actual = mart_cols.get(str(candidate).lower())
        if actual:
            return actual
    return None


def normalize_row(row: dict[str, Any]) -> dict[str, Any]:
    return {str(k).lower(): v for k, v in row.items()}


def pick(row: dict[str, Any], *keys: str) -> Any:
    """Return first non-empty value for any of the given column names."""
    for key in keys:
        value = row.get(key.lower())
        if value is None:
            continue
        try:
            import pandas as pd

            if pd.isna(value):
                continue
        except (TypeError, ValueError):
            pass
        if isinstance(value, str) and not value.strip():
            continue
        return value
    return ""


def _format_sequence(value: Any) -> str:
    if hasattr(value, "tolist") and not isinstance(value, (str, bytes)):
        try:
            value = value.tolist()
        except (TypeError, ValueError):
            pass
    if not isinstance(value, (list, tuple)):
        return str(value)
    parts: list[str] = []
    for item in value:
        if item is None:
            continue
        try:
            import pandas as pd

            if pd.isna(item):
                continue
        except (TypeError, ValueError):
            pass
        parts.append(str(item))
    return ", ".join(parts)


def format_cell(value: Any) -> Any:
    if value is None:
        return ""
    try:
        import pandas as pd

        if pd.isna(value):
            return ""
    except (TypeError, ValueError):
        pass
    if hasattr(value, "tolist") and not isinstance(value, (str, bytes, datetime, date)):
        return _format_sequence(value)
    if isinstance(value, (list, tuple)):
        return _format_sequence(value)
    if hasattr(value, "item") and hasattr(value, "dtype"):
        try:
            value = value.item()
        except (TypeError, ValueError):
            pass
        if value is None:
            return ""
        try:
            import pandas as pd

            if pd.isna(value):
                return ""
        except (TypeError, ValueError):
            pass
    if isinstance(value, datetime):
        try:
            t = value.time()
        except (ValueError, OSError):
            return ""
        if t.hour or t.minute or t.second:
            return value.strftime("%Y-%m-%d %H:%M:%S")
        return value.strftime("%Y-%m-%d")
    if isinstance(value, date):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, bool):
        return "Yes" if value else "No"
    return value


def format_percent_cell(value: Any) -> Any:
    """Format mart rate fields stored as decimals (e.g. 0.45) as percentages (45%)."""
    if value is None or value == "":
        return ""
    try:
        import pandas as pd

        if pd.isna(value):
            return ""
    except (TypeError, ValueError):
        pass
    try:
        number = float(value)
    except (TypeError, ValueError):
        return format_cell(value)
    if abs(number) <= 1:
        number *= 100
    if abs(number - round(number)) < 0.05:
        return f"{int(round(number))}%"
    return f"{number:.1f}%"


def prettify_sheet(ws: Worksheet) -> None:
    if ws.max_row < 1 or ws.max_column < 1:
        return
    header_fill = PatternFill(fill_type="solid", fgColor="1F4E78")
    header_font = Font(color="FFFFFF", bold=True)
    for cell in ws[1]:
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws.freeze_panes = "A2"
    if ws.max_row > 1:
        ws.auto_filter.ref = ws.dimensions
    for column_cells in ws.columns:
        max_len = 0
        col_letter = column_cells[0].column_letter
        for cell in column_cells:
            text = "" if cell.value is None else str(cell.value)
            max_len = max(max_len, len(text))
            if cell.row > 1:
                cell.alignment = Alignment(vertical="top", wrap_text=True)
        ws.column_dimensions[col_letter].width = min(max(12, max_len + 2), 45)


def write_headers(ws: Worksheet, headers: Sequence[str]) -> None:
    ws.append(list(headers))


def add_header_only_sheet(wb: Workbook, title: str, headers: Sequence[str]) -> None:
    """Create a mart sheet with column headers only (no data rows)."""
    ws = wb.create_sheet(title=title[:31])
    write_headers(ws, headers)
    prettify_sheet(ws)


def write_mapped_rows(
    ws: Worksheet,
    rows: Iterable[dict[str, Any]],
    headers: Sequence[str],
    field_map: Sequence[tuple[str, tuple[str, ...]]],
    percent_labels: frozenset[str] | None = None,
) -> None:
    write_headers(ws, headers)
    for raw in rows:
        row = normalize_row(raw)
        values: list[Any] = []
        for label, aliases in field_map:
            raw_value = pick(row, *aliases)
            if percent_labels and label in percent_labels:
                values.append(format_percent_cell(raw_value))
            else:
                values.append(format_cell(raw_value))
        ws.append(values)


def fetch_mart_rows(
    conn: duckdb.DuckDBPyConnection,
    schema: str,
    table: str,
    programme_codes: Sequence[str],
    category_name: str | None,
    order_columns: Sequence[str] | None = None,
) -> list[dict[str, Any]]:
    """Filter rows using mart-specific programme/category columns."""
    codes = [
        str(c).strip().upper()
        for c in programme_codes
        if str(c).strip()
    ]
    if not codes:
        return []

    spec = MART_FILTER.get(table, {"programme_cols": ("programme",), "category_cols": ()})
    programme_candidates: tuple[str, ...] = tuple(
        spec.get("programme_cols", ("programme",))
    )
    category_candidates: tuple[str, ...] = tuple(spec.get("category_cols", ()))
    programme_ilike: bool = bool(spec.get("programme_ilike"))
    programme_array: bool = bool(spec.get("programme_array"))

    relation = qualified_relation(schema, table)
    try:
        mart_cols = _mart_columns(conn, schema, table)
    except duckdb.CatalogException:
        return []
    programme_col = _pick_first_mart_column(mart_cols, programme_candidates)
    if not programme_col:
        return []

    where_parts: list[str] = []
    params: list[Any] = []

    for programme_code in codes:
        if programme_array:
            where_parts.append(
                f'EXISTS (SELECT 1 FROM unnest("{programme_col}") AS _md_prog(prog) '
                f'WHERE UPPER(TRIM(CAST(_md_prog.prog AS VARCHAR))) = UPPER(TRIM(?)))'
            )
            params.append(programme_code)
        elif programme_ilike:
            where_parts.append(f'CAST("{programme_col}" AS VARCHAR) ILIKE ?')
            params.append(f"%{programme_code}%")
        else:
            where_parts.append(
                f'UPPER(TRIM(CAST("{programme_col}" AS VARCHAR))) = UPPER(TRIM(?))'
            )
            params.append(programme_code)

    programme_clause = (
        where_parts[0] if len(where_parts) == 1 else "(" + " OR ".join(where_parts) + ")"
    )
    query = f"SELECT * FROM {relation} WHERE {programme_clause}"
    if category_name and category_candidates:
        category_col = _pick_first_mart_column(mart_cols, category_candidates)
        if category_col:
            query += f' AND TRIM(CAST("{category_col}" AS VARCHAR)) = TRIM(?)'
            params.append(category_name)
    if order_columns:
        order = ", ".join(f'"{col}"' for col in order_columns)
        query += f" ORDER BY {order}"
    else:
        query += " ORDER BY 1"

    df = conn.execute(query, params).fetchdf()
    return [normalize_row(dict(r)) for r in df.to_dict("records")]


def count_suspended_students(
    conn: duckdb.DuckDBPyConnection,
    schema: str,
    programme_codes: Sequence[str],
    category_name: str | None,
) -> int:
    rows = fetch_mart_rows(
        conn,
        schema,
        TABLE_STUDENT,
        programme_codes,
        category_name,
    )
    count = 0
    for raw in rows:
        status = str(pick(normalize_row(raw), "status")).strip().lower()
        if status == "suspended":
            count += 1
    return count


def _course_notes_table_columns(
    conn: duckdb.DuckDBPyConnection, schema: str
) -> list[str]:
    try:
        relation = qualified_relation(schema, TABLE_COURSE_NOTES)
        columns = list(conn.execute(f"SELECT * FROM {relation} LIMIT 0").fetchdf().columns)
        if columns:
            return [str(col) for col in columns]
    except Exception:
        pass
    return list(COURSE_NOTES_COLUMNS)


def fetch_course_note_rows(
    conn: duckdb.DuckDBPyConnection,
    schema: str,
    programme_codes: Sequence[str],
    category_name: str | None,
) -> list[dict[str, Any]]:
    """Course notes for students in the selected category/programme offering."""
    students = fetch_mart_rows(
        conn,
        schema,
        TABLE_STUDENT,
        programme_codes,
        category_name,
        order_columns=["student_no"],
    )
    student_nos = list(
        {
            str(pick(normalize_row(row), "student_no")).strip()
            for row in students
            if pick(normalize_row(row), "student_no")
        }
    )
    if not student_nos:
        return []

    try:
        relation = qualified_relation(schema, TABLE_COURSE_NOTES)
        placeholders = ", ".join("?" for _ in student_nos)
        df = conn.execute(
            f"""
            SELECT *
            FROM {relation}
            WHERE TRIM(CAST(username AS VARCHAR)) IN ({placeholders})
            ORDER BY timestamp DESC, username, course_display_name
            """,
            student_nos,
        ).fetchdf()
        return [dict(r) for r in df.to_dict("records")]
    except Exception:
        return []


def write_programme_summary(
    ws: Worksheet,
    conn: duckdb.DuckDBPyConnection,
    schema: str,
    programme_codes: Sequence[str],
    category_name: str | None,
    display_programme_code: str = "",
) -> None:
    rows = fetch_mart_rows(
        conn, schema, TABLE_PROGRAMME, programme_codes, category_name
    )
    write_headers(ws, ["Metric", "Value"])
    summary = rows[0] if rows else {}
    metrics: list[tuple[str, tuple[str, ...]]] = [
        ("Programme", ("programme",)),
        ("Students", ("students",)),
        ("Suspended Students", ("suspended_students", "suspended_student_count")),
        ("Active Modules", ("active_modules",)),
        ("Submitted Assessments", ("submitted_assessments",)),
        ("Missed Assessments", ("missed_assessments",)),
        ("Late Submissions", ("late_submissions",)),
        ("Upcoming Deadlines (14 Days)", ("upcoming_deadlines_14_days",)),
        ("Students With Missed Assessments", ("students_with_missed_assessments",)),
    ]
    for label, aliases in metrics:
        value = pick(summary, *aliases)
        if label == "Suspended Students" and value == "":
            value = count_suspended_students(
                conn, schema, programme_codes, category_name
            )
        if label == "Programme" and not value:
            value = display_programme_code or (programme_codes[0] if programme_codes else "")
        ws.append([label, format_cell(value)])


def write_student_summary(
    ws: Worksheet,
    conn: duckdb.DuckDBPyConnection,
    schema: str,
    programme_codes: Sequence[str],
    category_name: str | None,
) -> None:
    headers = [
        "Student No",
        "Student",
        "Email",
        "Status",
        "Programme",
        "Modules",
        "Missed Submissions",
        "Late Submissions",
        "Upcoming Submissions",
        "Last Moodle Access",
        "Days Since Access",
        *[label for label, _ in NOTE_FIELD_MAP],
    ]
    field_map: list[tuple[str, tuple[str, ...]]] = [
        ("Student No", ("student_no",)),
        ("Student", ("student",)),
        ("Email", ("email",)),
        ("Status", ("status",)),
        ("Programme", ("programme",)),
        ("Modules", ("total_modules", "modules")),
        ("Missed Submissions", ("missed_submissions", "missed")),
        ("Late Submissions", ("late_submissions", "late")),
        ("Upcoming Submissions", ("upcoming_submissions", "upcoming")),
        ("Last Moodle Access", ("last_moodle_access",)),
        ("Days Since Access", ("days_since_access",)),
        *NOTE_FIELD_MAP,
    ]
    rows = fetch_mart_rows(
        conn,
        schema,
        TABLE_STUDENT,
        programme_codes,
        category_name,
        order_columns=["student_no"],
    )
    write_mapped_rows(ws, rows, headers, field_map)


def write_module_summary(
    ws: Worksheet,
    conn: duckdb.DuckDBPyConnection,
    schema: str,
    programme_codes: Sequence[str],
    category_name: str | None,
) -> None:
    headers = [
        "Programme",
        "Module Code",
        "Module",
        "Students",
        "Submitted",
        "Missed Submissions",
        "Late Submissions",
        "Upcoming",
        "Submission Rate %",
        "Missed Rate %",
        "Late Rate %",
    ]
    field_map = [
        ("Programme", ("programme",)),
        ("Module Code", ("module_code",)),
        ("Module", ("module",)),
        ("Students", ("students",)),
        ("Submitted", ("total_submissions", "submitted")),
        ("Missed Submissions", ("missed_submissions", "missed")),
        ("Late Submissions", ("late_submissions", "late")),
        ("Upcoming", ("upcoming_assessments", "upcoming")),
        ("Submission Rate %", ("submission_rate_pct",)),
        ("Missed Rate %", ("missed_rate_pct",)),
        ("Late Rate %", ("late_rate_pct", "late_pct")),
    ]
    rows = fetch_mart_rows(
        conn,
        schema,
        TABLE_MODULE,
        programme_codes,
        category_name,
        order_columns=["module_code", "module"],
    )
    write_mapped_rows(
        ws,
        rows,
        headers,
        field_map,
        percent_labels=frozenset(
            {"Submission Rate %", "Missed Rate %", "Late Rate %"}
        ),
    )


def write_submission_trends(
    ws: Worksheet,
    conn: duckdb.DuckDBPyConnection,
    schema: str,
    programme_codes: Sequence[str],
    category_name: str | None,
) -> None:
    headers = [
        "Programme",
        "Module Code",
        "Module",
        "Assessment",
        "Assessment Type",
        "Due Date",
        "Total Students",
        "Submitted Count",
        "Missed Count",
        "Late Submissions",
        "Submitted %",
        "Missed %",
        "Late %",
    ]
    field_map = [
        ("Programme", ("programme",)),
        ("Module Code", ("module_code",)),
        ("Module", ("module",)),
        ("Assessment", ("assessment",)),
        ("Assessment Type", ("assessment_type",)),
        ("Due Date", ("effective_deadline_at", "due_date")),
        ("Total Students", ("total_students",)),
        ("Submitted Count", ("submitted_count",)),
        ("Missed Count", ("missed_count",)),
        ("Late Submissions", ("late_count", "late_submissions")),
        ("Submitted %", ("submitted_pct",)),
        ("Missed %", ("missed_pct",)),
        ("Late %", ("late_pct", "late_rate_pct")),
    ]
    rows = fetch_mart_rows(
        conn,
        schema,
        TABLE_TRENDS,
        programme_codes,
        category_name,
        order_columns=["module_code", "assessment"],
    )
    write_mapped_rows(
        ws,
        rows,
        headers,
        field_map,
        percent_labels=frozenset({"Submitted %", "Missed %", "Late %"}),
    )


def write_student_assessment_detail(
    ws: Worksheet,
    conn: duckdb.DuckDBPyConnection,
    schema: str,
    programme_codes: Sequence[str],
    category_name: str | None,
) -> None:
    headers = [
        "Student No",
        "Student",
        "Email",
        "Programme",
        "Module Code",
        "Module",
        "Assessment",
        "Assessment Type",
        "Due Date",
        "Submitted Date",
        "Status",
        "Mark",
        "Max Grade",
        *[label for label, _ in NOTE_FIELD_MAP],
    ]
    rows = fetch_mart_rows(
        conn,
        schema,
        TABLE_ASSESSMENT,
        programme_codes,
        category_name,
        order_columns=["course_shortname", "assessment_name", "user_idnumber"],
    )
    write_headers(ws, headers)
    for raw in rows:
        row = normalize_row(raw)
        submitted = pick(row, "grade_submitted_at", "last_attempt_at")
        is_submitted = row.get("is_submitted")
        if is_submitted not in (True, 1) and str(is_submitted).lower() not in {
            "true",
            "t",
            "1",
            "yes",
        }:
            submitted = ""
        ws.append(
            [
                format_cell(pick(row, "user_idnumber")),
                format_cell(pick(row, "user_fullname")),
                format_cell(pick(row, "user_email")),
                format_cell(pick(row, "program_code")),
                format_cell(pick(row, "course_shortname")),
                format_cell(pick(row, "course_fullname")),
                format_cell(pick(row, "assessment_name")),
                format_cell(pick(row, "assessment_type")),
                format_cell(pick(row, "due_at", "effective_deadline_at")),
                format_cell(submitted),
                format_cell(pick(row, "status")),
                format_cell(pick(row, "grade_raw")),
                format_cell(pick(row, "max_grade")),
                *[format_cell(pick(row, *aliases)) for _, aliases in NOTE_FIELD_MAP],
            ]
        )


def write_missed_assessments(
    ws: Worksheet,
    conn: duckdb.DuckDBPyConnection,
    schema: str,
    programme_codes: Sequence[str],
    category_name: str | None,
) -> None:
    headers = [
        "Student No",
        "Student",
        "Email",
        "Programme",
        "Module Code",
        "Module",
        "Assessment",
        "Assessment Type",
        "Due Date",
        "Effective Deadline",
        "Days Overdue",
        "Status",
        *[label for label, _ in NOTE_FIELD_MAP],
    ]
    field_map = [
        ("Student No", ("student_no",)),
        ("Student", ("student",)),
        ("Email", ("email",)),
        ("Programme", ("programme",)),
        ("Module Code", ("module_code",)),
        ("Module", ("module",)),
        ("Assessment", ("assessment",)),
        ("Assessment Type", ("assessment_type",)),
        ("Due Date", ("due_date", "effective_deadline_at")),
        ("Effective Deadline", ("effective_deadline_at", "due_date")),
        ("Days Overdue", ("days_overdue",)),
        ("Status", ("status",)),
        *NOTE_FIELD_MAP,
    ]
    rows = fetch_mart_rows(
        conn,
        schema,
        TABLE_MISSED,
        programme_codes,
        category_name,
        order_columns=["days_overdue", "student_no"],
    )
    write_mapped_rows(ws, rows, headers, field_map)


def write_gradebook_course_notes(
    ws: Worksheet,
    conn: duckdb.DuckDBPyConnection,
    schema: str,
    programme_codes: Sequence[str],
    category_name: str | None,
) -> None:
    columns = _course_notes_table_columns(conn, schema)
    rows = fetch_course_note_rows(
        conn, schema, programme_codes, category_name
    )
    write_headers(ws, columns)
    for raw in rows:
        ws.append([format_cell(raw.get(col)) for col in columns])


def write_upcoming_deadlines(
    ws: Worksheet,
    conn: duckdb.DuckDBPyConnection,
    schema: str,
    programme_codes: Sequence[str],
    category_name: str | None,
) -> None:
    headers = [
        "Programme",
        "Module Code",
        "Module",
        "Assessment",
        "Assessment Type",
        "Effective Deadline",
        "Hours Until Due",
    ]
    field_map = [
        ("Programme", ("programme",)),
        ("Module Code", ("module_code",)),
        ("Module", ("module",)),
        ("Assessment", ("assessment",)),
        ("Assessment Type", ("assessment_type",)),
        ("Effective Deadline", ("effective_deadline_at",)),
        ("Hours Until Due", ("hours_until_due",)),
    ]
    rows = fetch_mart_rows(
        conn,
        schema,
        TABLE_UPCOMING,
        programme_codes,
        category_name,
        order_columns=["hours_until_due", "effective_deadline_at"],
    )
    write_mapped_rows(ws, rows, headers, field_map)


def _export_codes_for_check(
    programme_codes: Sequence[str],
    display_programme_code: str,
) -> list[str]:
    """Codes to probe marts — include dropdown prefix when mapping differs from mart grain."""
    seen: set[str] = set()
    codes: list[str] = []
    for raw in (*programme_codes, display_programme_code):
        code = str(raw).strip().upper()
        if code and code not in seen:
            seen.add(code)
            codes.append(code)
    return codes


def _export_fallback_enabled() -> bool:
    flag = (read_env_value("WAREHOUSE_EXPORT_FALLBACK") or "true").lower()
    return flag not in ("0", "false", "no", "off")


def offering_has_gradebook_rows(
    conn: duckdb.DuckDBPyConnection,
    schema: str,
    programme_codes: Sequence[str],
    category_name: str | None,
    display_programme_code: str = "",
) -> bool:
    """
    True when any gradebook mart has rows for this offering.

    Previously only gradebook_student_summary was checked, so offerings like PDEML
    could fall back to enrollments even when other marts (module, assessment, etc.)
    already had data after dbt updates.
    """
    codes = _export_codes_for_check(programme_codes, display_programme_code)
    if not codes:
        return False

    probes: tuple[tuple[str, tuple[str, ...] | None], ...] = (
        (TABLE_STUDENT, ("student_no",)),
        (TABLE_MODULE, ("module_code",)),
        (TABLE_PROGRAMME, None),
        (TABLE_TRENDS, ("module_code",)),
        (TABLE_ASSESSMENT, ("user_idnumber",)),
        (TABLE_MISSED, ("student_no",)),
        (TABLE_UPCOMING, ("student_no",)),
        (TABLE_COURSE_NOTES, None),
    )
    for table, order_columns in probes:
        if table == TABLE_COURSE_NOTES:
            rows = fetch_course_note_rows(conn, schema, codes, category_name)
        else:
            rows = fetch_mart_rows(
                conn,
                schema,
                table,
                codes,
                category_name,
                order_columns=order_columns,
            )
        if rows:
            return True
    return False


def build_workbook(
    conn: duckdb.DuckDBPyConnection,
    schema: str,
    programme_codes: Sequence[str],
    category_name: str | None,
    output_dir: Path,
    display_programme_code: str = "",
) -> Path:
    if (
        _export_fallback_enabled()
        and category_name
        and display_programme_code
        and not offering_has_gradebook_rows(
            conn,
            schema,
            programme_codes,
            category_name,
            display_programme_code=display_programme_code,
        )
    ):
        return build_workbook_offering_fallback(
            conn,
            category_name,
            display_programme_code,
            output_dir,
            display_programme_code,
            schema=schema,
            programme_codes=programme_codes,
        )

    export_codes = (
        [display_programme_code.strip().upper()]
        if display_programme_code
        else list(programme_codes)
    )

    wb = Workbook()
    default = wb.active
    wb.remove(default)

    sheets: list[tuple[str, Any]] = [
        ("Programme Summary", write_programme_summary),
        ("Student Summary", write_student_summary),
        ("Module Summary", write_module_summary),
        ("Submission Trends", write_submission_trends),
        ("Student Assessment Detail", write_student_assessment_detail),
        ("Missed Assessments", write_missed_assessments),
        ("Upcoming Deadlines", write_upcoming_deadlines),
        (COURSE_NOTES_SHEET_TITLE, write_gradebook_course_notes),
    ]

    for title, writer in sheets:
        ws = wb.create_sheet(title=title[:31])
        if writer is write_programme_summary:
            writer(
                ws,
                conn,
                schema,
                export_codes,
                category_name,
                display_programme_code=display_programme_code,
            )
        else:
            writer(ws, conn, schema, export_codes, category_name)
        prettify_sheet(ws)

    if COURSE_NOTES_SHEET_TITLE[:31] not in wb.sheetnames:
        ws = wb.create_sheet(title=COURSE_NOTES_SHEET_TITLE[:31])
        write_gradebook_course_notes(
            ws, conn, schema, export_codes, category_name
        )
        prettify_sheet(ws)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    file_code = display_programme_code or (
        programme_codes[0] if programme_codes else "export"
    )
    safe_code = file_code.replace(" ", "_")
    out_path = output_dir / f"gradebook_{safe_code}_{timestamp}.xlsx"
    wb.save(out_path)
    return out_path.resolve()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Export gradebook Excel from warehouse moodle_processed marts"
    )
    parser.add_argument("--programme-code", required=True)
    parser.add_argument(
        "--category-name",
        default="",
        help="Moodle category label (intake); required to scope export to one category",
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

    programme_code = str(args.programme_code).strip().upper()
    category_name = str(args.category_name or "").strip() or None
    schema = args.warehouse_schema or gradebook_schema() or DEFAULT_SCHEMA
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    conn = connect_motherduck()
    try:
        programme_codes = [programme_code]
        out_path = build_workbook(
            conn,
            schema,
            programme_codes,
            category_name,
            output_dir,
            display_programme_code=programme_code,
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
