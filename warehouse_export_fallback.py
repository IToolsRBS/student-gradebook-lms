"""
Export fallback when gradebook marts have no rows (inactive / non-visible-recent courses).

Uses dim_courses + stg_moodle_enrollments + stg_moodle_grades for the selected
category and course shortname prefix (e.g. 2025 January + PDEML).
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Sequence

import duckdb
from openpyxl import Workbook
from openpyxl.worksheet.worksheet import Worksheet

from motherduck_client import (
    courses_schema,
    qualified_relation,
    staging_schema,
)
from warehouse_metadata import course_ids_for_offering

def _course_id_filter(course_ids: Sequence[int]) -> tuple[str, list[Any]]:
    placeholders = ", ".join("?" for _ in course_ids)
    return f"CAST(dc.course_id AS BIGINT) IN ({placeholders})", list(course_ids)


def _fetch_enrollment_student_summary(
    conn: duckdb.DuckDBPyConnection,
    course_ids: Sequence[int],
    display_programme: str,
) -> list[dict[str, Any]]:
    if not course_ids:
        return []
    courses = qualified_relation(courses_schema(), "dim_courses")
    enrollments = qualified_relation(staging_schema(), "stg_moodle_enrollments")
    clause, params = _course_id_filter(course_ids)
    df = conn.execute(
        f"""
        SELECT
            TRIM(e.user_idnumber) AS student_no,
            TRIM(e.user_fullname) AS student,
            TRIM(e.user_email) AS email,
            ? AS programme,
            COUNT(DISTINCT e.course_id) AS modules
        FROM {enrollments} AS e
        INNER JOIN {courses} AS dc ON dc.course_id = e.course_id
        WHERE {clause}
          AND e.primary_role = 'student'
          AND COALESCE(e.is_suspended, false) = false
          AND TRIM(COALESCE(e.user_idnumber, '')) <> ''
        GROUP BY 1, 2, 3, 4
        ORDER BY student
        """,
        [display_programme, *params],
    ).fetchdf()
    return [dict(r) for r in df.to_dict("records")]


def _fetch_module_summary(
    conn: duckdb.DuckDBPyConnection,
    course_ids: Sequence[int],
    display_programme: str,
) -> list[dict[str, Any]]:
    if not course_ids:
        return []
    courses = qualified_relation(courses_schema(), "dim_courses")
    enrollments = qualified_relation(staging_schema(), "stg_moodle_enrollments")
    clause, params = _course_id_filter(course_ids)
    df = conn.execute(
        f"""
        SELECT
            ? AS programme,
            TRIM(dc.course_shortname) AS module_code,
            TRIM(dc.course_fullname) AS module,
            COUNT(DISTINCT e.user_id) AS students
        FROM {courses} AS dc
        LEFT JOIN {enrollments} AS e
            ON e.course_id = dc.course_id
           AND e.primary_role = 'student'
           AND COALESCE(e.is_suspended, false) = false
        WHERE {clause}
        GROUP BY dc.course_id, dc.course_shortname, dc.course_fullname
        ORDER BY module_code
        """,
        [display_programme, *params],
    ).fetchdf()
    return [dict(r) for r in df.to_dict("records")]


def _fetch_grade_rows(
    conn: duckdb.DuckDBPyConnection,
    course_ids: Sequence[int],
    display_programme: str,
) -> list[dict[str, Any]]:
    if not course_ids:
        return []
    courses = qualified_relation(courses_schema(), "dim_courses")
    grades = qualified_relation(staging_schema(), "stg_moodle_grades")
    items = qualified_relation(staging_schema(), "stg_moodle_grade_items")
    clause, params = _course_id_filter(course_ids)
    df = conn.execute(
        f"""
        SELECT
            TRIM(g.user_idnumber) AS student_no,
            TRIM(g.user_fullname) AS student,
            ? AS programme,
            TRIM(dc.course_shortname) AS module_code,
            TRIM(dc.course_fullname) AS module,
            TRIM(gi.grade_item_name) AS assessment,
            g.grade_raw,
            g.grade_percentage,
            g.submitted_at,
            g.graded_at
        FROM {grades} AS g
        INNER JOIN {courses} AS dc ON dc.course_id = g.course_id
        LEFT JOIN {items} AS gi
            ON gi.course_id = g.course_id AND gi.grade_item_id = g.grade_item_id
        WHERE {clause}
          AND TRIM(COALESCE(g.user_idnumber, '')) <> ''
        ORDER BY student, module_code, assessment
        """,
        [display_programme, *params],
    ).fetchdf()
    return [dict(r) for r in df.to_dict("records")]


def build_workbook_offering_fallback(
    conn: duckdb.DuckDBPyConnection,
    category_name: str,
    course_prefix: str,
    output_dir: Path,
    display_programme_code: str,
    *,
    schema: str | None = None,
    programme_codes: Sequence[str] | None = None,
) -> Path:
    """Excel export for offerings with no gradebook mart rows."""
    from populate_gradebook_from_warehouse import (
        MART_SHEET_HEADERS,
        add_header_only_sheet,
        format_cell,
        prettify_sheet,
        write_missed_assessments,
        write_student_activity,
        write_submission_trends,
        write_upcoming_deadlines,
    )

    course_ids = course_ids_for_offering(conn, category_name, course_prefix)
    display = display_programme_code.strip().upper() or course_prefix.strip().upper()

    students = _fetch_enrollment_student_summary(conn, course_ids, display)
    modules = _fetch_module_summary(conn, course_ids, display)
    grades = _fetch_grade_rows(conn, course_ids, display)

    wb = Workbook()
    default = wb.active
    wb.remove(default)

    ws_prog = wb.create_sheet(title="Programme Summary"[:31])
    ws_prog.append(["Metric", "Value"])
    ws_prog.append(["Programme", display])
    ws_prog.append(["Students", len(students)])
    ws_prog.append(["Modules", len(modules)])
    ws_prog.append(["Grade records", len(grades)])
    prettify_sheet(ws_prog)

    ws_stu = wb.create_sheet(title="Student Summary"[:31])
    ws_stu.append(
        ["Student No", "Student", "Email", "Programme", "Modules"]
    )
    for row in students:
        ws_stu.append(
            [
                format_cell(row.get("student_no")),
                format_cell(row.get("student")),
                format_cell(row.get("email")),
                format_cell(row.get("programme")),
                format_cell(row.get("modules")),
            ]
        )
    prettify_sheet(ws_stu)

    ws_mod = wb.create_sheet(title="Module Summary"[:31])
    ws_mod.append(["Programme", "Module Code", "Module", "Students"])
    for row in modules:
        ws_mod.append(
            [
                format_cell(row.get("programme")),
                format_cell(row.get("module_code")),
                format_cell(row.get("module")),
                format_cell(row.get("students")),
            ]
        )
    prettify_sheet(ws_mod)

    mart_codes = list(programme_codes or [])
    mart_schema = schema

    def _mart_sheet(title: str, writer, header_key: str) -> None:
        if mart_schema and mart_codes:
            ws = wb.create_sheet(title=title[:31])
            writer(ws, conn, mart_schema, mart_codes, category_name)
            prettify_sheet(ws)
        else:
            add_header_only_sheet(wb, title, MART_SHEET_HEADERS[header_key])

    _mart_sheet("Submission Trends", write_submission_trends, "Submission Trends")

    ws_det = wb.create_sheet(title="Student Assessment Detail"[:31])
    ws_det.append(
        [
            "Student No",
            "Student",
            "Programme",
            "Module Code",
            "Module",
            "Assessment",
            "Grade",
            "Grade %",
            "Submitted At",
            "Graded At",
        ]
    )
    for row in grades:
        ws_det.append(
            [
                format_cell(row.get("student_no")),
                format_cell(row.get("student")),
                format_cell(row.get("programme")),
                format_cell(row.get("module_code")),
                format_cell(row.get("module")),
                format_cell(row.get("assessment")),
                format_cell(row.get("grade_raw")),
                format_cell(row.get("grade_percentage")),
                format_cell(row.get("submitted_at")),
                format_cell(row.get("graded_at")),
            ]
        )
    prettify_sheet(ws_det)

    _mart_sheet("Missed Assessments", write_missed_assessments, "Missed Assessments")
    _mart_sheet("Upcoming Deadlines", write_upcoming_deadlines, "Upcoming Deadlines")
    _mart_sheet("Student Activity", write_student_activity, "Student Activity")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_code = display.replace(" ", "_")
    out_path = output_dir / f"gradebook_{safe_code}_{timestamp}.xlsx"
    wb.save(out_path)
    return out_path.resolve()
