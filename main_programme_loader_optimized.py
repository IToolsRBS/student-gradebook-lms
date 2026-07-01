import argparse
import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import threading
import time
from typing import Any
from urllib.parse import urlencode
from urllib.request import urlopen

import psycopg

from sync_moodle_discovery import (
    fetch_users_by_ids,
    get_or_create_assessment_type_id,
    parse_numeric,
    upsert_student,
)


ENV_FILE = Path(".env")
BASE_URL = "https://regentonline.ac.za/webservice/rest/server.php"


def log(message: str) -> None:
    print(message, flush=True)


FLOW_STEPS = [
    "01) Seed student discovery from seed module",
    "02) Discover candidate modules from seed student overview",
    "03) Fetch course metadata and filter by programme/category",
    "04) Resolve category metadata for kept modules",
    "05) Create sync run and upsert programme/module cache",
    "06) Fetch module gradebooks (parallel)",
    "07) Fetch due dates (parallel)",
    "08) Enrich student profiles",
    "09) Load assessments and marks into DB",
    "10) Optional course-total pass",
    "11) Finalize sync run",
]


FLOW_STEP_WHY = {
    1: "Why: establishes a valid student anchor from the known seed module.",
    2: "Why: uses the seed student to discover candidate module course IDs quickly.",
    3: "Why: validates candidates and keeps only modules for the target programme/category.",
    4: "Why: enriches selected modules with authoritative Moodle category metadata.",
    5: "Why: initializes run tracking and ensures programme/module dimensions exist.",
    6: "Why: collects the core mark source (all users + grade items per module).",
    7: "Why: adds activity due dates so marks can be contextualized by deadlines.",
    8: "Why: enriches raw student IDs with profile fields used in analytics/reporting.",
    9: "Why: persists normalized assessment entities and student mark facts to the DB.",
    10: "Why: captures per-course overall grades as Course Total analytics rows.",
    11: "Why: closes run status for observability, auditing, and failure tracking.",
}


def log_flow_plan() -> None:
    log("")
    log("=== API DATA FLOW (REAL-TIME) ===")
    for step in FLOW_STEPS:
        log(f"  {step}")
    log("=================================")
    log("")


def log_step(step_no: int, title: str, status: str) -> None:
    log(f"[flow][{step_no:02d}][{status}] {title}")
    if status == "start":
        why = FLOW_STEP_WHY.get(step_no)
        if why:
            log(f"[flow][{step_no:02d}][why] {why}")


def log_api_use(wsfunction: str, params: dict[str, Any], keeps: str) -> None:
    log(f"[api-flow] {wsfunction} params={params}")
    log(f"[api-flow] keeps -> {keeps}")


def log_run_config(args: argparse.Namespace, programme_name: str) -> None:
    log("=== RUN CONFIG ===")
    log(
        f"programme_name={programme_name} | seed_courseid={args.seed_courseid} | "
        f"category_id={args.category_id} | workers={args.workers}"
    )
    log(
        f"max_students={args.max_students} | skip_finals={args.skip_finals} | "
        f"db_batch_size={args.db_batch_size} | reset={args.reset}"
    )
    log("==================")


def read_env_value(target_key: str) -> str | None:
    direct = os.getenv(target_key)
    if direct:
        return direct.strip().strip('"').strip("'")
    if not ENV_FILE.exists():
        return None
    for raw_line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        left, right = line.split("=", 1)
        key = left.strip().strip('"').strip("'")
        value = right.strip().strip('"').strip("'")
        if key == target_key:
            return value
    return None


def call_moodle_api(
    wstoken: str, wsfunction: str, params: dict[str, Any], timeout: int = 45
) -> Any:
    query = {"wstoken": wstoken, "wsfunction": wsfunction, "moodlewsrestformat": "json"}
    query.update(params)
    url = f"{BASE_URL}?{urlencode(query, doseq=True)}"
    with urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_module_gradebook(wstoken: str, module_id: int) -> tuple[int, dict[str, Any]]:
    payload = call_moodle_api(wstoken, "gradereport_user_get_grade_items", {"courseid": module_id})
    return module_id, (payload if isinstance(payload, dict) else {})


def fetch_student_overview(wstoken: str, student_id: int) -> tuple[int, dict[str, Any]]:
    payload = call_moodle_api(
        wstoken, "gradereport_overview_get_course_grades", {"userid": student_id}
    )
    return student_id, (payload if isinstance(payload, dict) else {})


def fetch_quiz_due_dates(
    api: "TimedApiCaller", module_id: int
) -> tuple[dict[int, int], dict[tuple[str, int], int]]:
    """
    Return quiz close times keyed by coursemodule id for one course/module.
    """
    payload = api.call(
        "mod_quiz_get_quizzes_by_courses",
        {"courseids[0]": module_id},
        timeout=60,
    )
    quizzes = payload.get("quizzes", []) if isinstance(payload, dict) else []
    due_by_cmid: dict[int, int] = {}
    due_by_item: dict[tuple[str, int], int] = {}
    for quiz in quizzes:
        cmid = quiz.get("coursemodule")
        quiz_id = quiz.get("id")
        timeclose = quiz.get("timeclose")
        if cmid is None:
            continue
        if isinstance(timeclose, int) and timeclose > 0:
            due_by_cmid[int(cmid)] = timeclose
            if isinstance(quiz_id, int):
                due_by_item[("quiz", int(quiz_id))] = timeclose
    return due_by_cmid, due_by_item


def fetch_assignment_due_dates(
    api: "TimedApiCaller", module_id: int
) -> tuple[dict[int, int], dict[tuple[str, int], int]]:
    """
    Return assignment due dates keyed by course module id for one course/module.
    """
    payload = api.call(
        "mod_assign_get_assignments",
        {"courseids[0]": module_id, "includenotenrolledcourses": 1},
        timeout=60,
    )
    courses = payload.get("courses", []) if isinstance(payload, dict) else []
    due_by_cmid: dict[int, int] = {}
    due_by_item: dict[tuple[str, int], int] = {}
    for course in courses:
        assignments = course.get("assignments", [])
        for assignment in assignments:
            cmid = assignment.get("cmid")
            assignment_id = assignment.get("id")
            duedate = assignment.get("duedate")
            if cmid is None:
                continue
            if isinstance(duedate, int) and duedate > 0:
                due_by_cmid[int(cmid)] = duedate
                if isinstance(assignment_id, int):
                    due_by_item[("assign", int(assignment_id))] = duedate
    return due_by_cmid, due_by_item


def fetch_module_due_dates(
    api: "TimedApiCaller", module_id: int
) -> tuple[int, dict[int, int], dict[tuple[str, int], int], int, int]:
    """
    Fetch and merge due dates for quiz and assignment activities in one module.
    Returns: (module_id, merged_due_by_cmid, quiz_count, assignment_count)
    """
    quiz_due_by_cmid, quiz_due_by_item = fetch_quiz_due_dates(api, module_id)
    assign_due_by_cmid, assign_due_by_item = fetch_assignment_due_dates(api, module_id)
    merged_cmid = {**assign_due_by_cmid, **quiz_due_by_cmid}
    merged_item = {**assign_due_by_item, **quiz_due_by_item}
    return module_id, merged_cmid, merged_item, len(quiz_due_by_cmid), len(assign_due_by_cmid)


def parse_programme_code(course: dict[str, Any]) -> str | None:
    for value in [course.get("shortname"), course.get("fullname"), course.get("displayname")]:
        if not value or not isinstance(value, str):
            continue
        token = value.strip().split("_", 1)[0].strip()
        if token:
            return token.upper()
    return None


def normalize_text(value: Any) -> str:
    if value is None:
        return ""
    return "".join(ch.lower() for ch in str(value).strip() if ch.isalnum())


def course_matches_programme_name(course: dict[str, Any], programme_name: str) -> bool:
    target_raw = str(programme_name or "").strip().lower()
    target_norm = normalize_text(programme_name)
    if not target_raw and not target_norm:
        return False

    candidates = [course.get("shortname"), course.get("fullname"), course.get("displayname")]
    for candidate in candidates:
        text = str(candidate or "").strip()
        if not text:
            continue
        text_lower = text.lower()
        text_norm = normalize_text(text)
        if target_raw and target_raw in text_lower:
            return True
        if target_norm and target_norm in text_norm:
            return True
    return False


def upsert_programme_fast(
    cur: psycopg.Cursor,
    course: dict[str, Any],
    category_name_by_id: dict[int, str],
) -> int | None:
    category_id = course.get("categoryid")
    code = parse_programme_code(course) or (f"CAT_{category_id}" if category_id is not None else None)
    if not code:
        return None
    name = code
    resolved_category_id = int(category_id) if category_id is not None else None
    resolved_category_name = (
        category_name_by_id.get(resolved_category_id) if resolved_category_id is not None else None
    )
    cur.execute(
        """
        INSERT INTO public.programme
            (programme_code, programme_name, source_category_id, category_id, category)
        VALUES
            (%s, %s, %s, %s, %s)
        ON CONFLICT (programme_code) DO UPDATE
            SET programme_name = EXCLUDED.programme_name,
                source_category_id = EXCLUDED.source_category_id,
                category_id = EXCLUDED.category_id,
                category = EXCLUDED.category
        RETURNING programme_id;
        """,
        (code, name, resolved_category_id, resolved_category_id, resolved_category_name),
    )
    row = cur.fetchone()
    if row:
        return row[0]
    cur.execute("SELECT programme_id FROM public.programme WHERE programme_code = %s", (code,))
    row = cur.fetchone()
    return row[0] if row else None


def upsert_module_fast(cur: psycopg.Cursor, course: dict[str, Any], programme_id: int | None) -> None:
    cur.execute(
        """
        INSERT INTO public.module
            (module_id, programme_id, module_code, module_name, idnumber, startdate_epoch, enddate_epoch, visible, last_synced_at)
        VALUES
            (%s, %s, %s, %s, %s, %s, %s, %s, now())
        ON CONFLICT (module_id) DO UPDATE
            SET programme_id = EXCLUDED.programme_id,
                module_code = EXCLUDED.module_code,
                module_name = EXCLUDED.module_name,
                idnumber = EXCLUDED.idnumber,
                startdate_epoch = EXCLUDED.startdate_epoch,
                enddate_epoch = EXCLUDED.enddate_epoch,
                visible = EXCLUDED.visible,
                last_synced_at = now();
        """,
        (
            course.get("id"),
            programme_id,
            course.get("shortname"),
            course.get("fullname"),
            course.get("idnumber"),
            course.get("startdate"),
            course.get("enddate"),
            bool(course.get("visible")) if course.get("visible") is not None else None,
        ),
    )


def upsert_category(cur: psycopg.Cursor, category: dict[str, Any]) -> None:
    parent_category_id = category.get("parent")
    if parent_category_id is not None:
        cur.execute(
            "SELECT 1 FROM public.category WHERE category_id = %s",
            (parent_category_id,),
        )
        if cur.fetchone() is None:
            parent_category_id = None
    cur.execute(
        """
        INSERT INTO public.category
            (category_id, category_name, idnumber, description, descriptionformat, parent_category_id, sortorder, coursecount, visible, visibleold, timemodified_epoch, depth, path, theme, last_synced_at)
        VALUES
            (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
        ON CONFLICT (category_id) DO UPDATE
            SET category_name = EXCLUDED.category_name,
                idnumber = EXCLUDED.idnumber,
                description = EXCLUDED.description,
                descriptionformat = EXCLUDED.descriptionformat,
                parent_category_id = EXCLUDED.parent_category_id,
                sortorder = EXCLUDED.sortorder,
                coursecount = EXCLUDED.coursecount,
                visible = EXCLUDED.visible,
                visibleold = EXCLUDED.visibleold,
                timemodified_epoch = EXCLUDED.timemodified_epoch,
                depth = EXCLUDED.depth,
                path = EXCLUDED.path,
                theme = EXCLUDED.theme,
                last_synced_at = now();
        """,
        (
            category.get("id"),
            category.get("name"),
            category.get("idnumber"),
            category.get("description"),
            category.get("descriptionformat"),
            parent_category_id,
            category.get("sortorder"),
            category.get("coursecount"),
            bool(category.get("visible")) if category.get("visible") is not None else None,
            bool(category.get("visibleold")) if category.get("visibleold") is not None else None,
            category.get("timemodified"),
            category.get("depth"),
            category.get("path"),
            category.get("theme"),
        ),
    )


def chunked(rows: list[tuple[Any, ...]], size: int) -> list[list[tuple[Any, ...]]]:
    return [rows[i : i + size] for i in range(0, len(rows), size)]


def upsert_module_assessments(
    cur: psycopg.Cursor,
    module_id: int,
    usergrades: list[dict[str, Any]],
    assessment_type_cache: dict[str, int],
) -> dict[int, tuple[int, str | None]]:
    by_grade_item: dict[int, tuple[int, str | None]] = {}
    for ug in usergrades:
        for gi in ug.get("gradeitems", []):
            gid = gi.get("id")
            if gid is None or gid in by_grade_item:
                continue
            if (gi.get("itemtype") or "").lower() in {"course", "category"}:
                continue
            atype = gi.get("itemname") or gi.get("itemmodule") or gi.get("itemtype")
            atype_id = get_or_create_assessment_type_id(cur, assessment_type_cache, atype)
            aname = atype or f"grade_item_{gid}"
            cur.execute(
                """
                INSERT INTO public.assessment
                    (module_id, assessment_type_id, moodle_grade_item_id, cmid, assessment_name, assessment_module, assessment_item_number, is_course_total, last_synced_at)
                VALUES
                    (%s, %s, %s, %s, %s, %s, %s, false, now())
                ON CONFLICT (moodle_grade_item_id) DO UPDATE
                    SET module_id = EXCLUDED.module_id,
                        assessment_type_id = EXCLUDED.assessment_type_id,
                        cmid = EXCLUDED.cmid,
                        assessment_name = EXCLUDED.assessment_name,
                        assessment_module = EXCLUDED.assessment_module,
                        assessment_item_number = EXCLUDED.assessment_item_number,
                        last_synced_at = now()
                RETURNING assessment_id;
                """,
                (module_id, atype_id, gid, gi.get("cmid"), aname, gi.get("itemmodule"), gi.get("itemnumber")),
            )
            aid = cur.fetchone()[0]
            by_grade_item[gid] = (aid, atype)
    return by_grade_item


def upsert_course_total_assessments(
    cur: psycopg.Cursor,
    module_ids: list[int],
    assessment_type_cache: dict[str, int],
) -> dict[int, int]:
    final_type_id = get_or_create_assessment_type_id(cur, assessment_type_cache, "Course Total")
    final_assessment_by_module: dict[int, int] = {}
    for module_id in module_ids:
        cur.execute(
            """
            INSERT INTO public.assessment
                (module_id, assessment_type_id, moodle_grade_item_id, cmid, assessment_name, assessment_module, assessment_item_number, is_course_total, last_synced_at)
            VALUES
                (%s, %s, NULL, NULL, 'Course Total', NULL, 0, true, now())
            ON CONFLICT (module_id, assessment_name, assessment_item_number, is_course_total) DO UPDATE
                SET assessment_type_id = EXCLUDED.assessment_type_id,
                    last_synced_at = now()
            RETURNING assessment_id;
            """,
            (module_id, final_type_id),
        )
        final_assessment_by_module[module_id] = cur.fetchone()[0]
    return final_assessment_by_module


class TimedApiCaller:
    def __init__(self, wstoken: str, verbose: bool = False) -> None:
        self.wstoken = wstoken
        self.verbose = verbose
        self.lock = threading.Lock()
        self.records: list[tuple[str, dict[str, Any], float]] = []

    def call(self, wsfunction: str, params: dict[str, Any], timeout: int = 45) -> Any:
        start = time.perf_counter()
        payload = call_moodle_api(self.wstoken, wsfunction, params, timeout=timeout)
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        with self.lock:
            self.records.append((wsfunction, params, elapsed_ms))
        if self.verbose:
            log(f"[api] {wsfunction} {params} -> {elapsed_ms:.0f}ms")
        return payload

    def print_summary(self) -> None:
        if not self.records:
            log("API timing: no calls recorded")
            return
        log("\nAPI timing summary:")
        grouped: dict[str, list[float]] = {}
        for fn, _params, ms in self.records:
            grouped.setdefault(fn, []).append(ms)
        for fn in sorted(grouped):
            vals = grouped[fn]
            log(
                f"- {fn}: calls={len(vals)}, avg={sum(vals)/len(vals):.0f}ms, max={max(vals):.0f}ms"
            )
        slowest = sorted(self.records, key=lambda r: r[2], reverse=True)[:10]
        log("Top 10 slowest calls:")
        for fn, params, ms in slowest:
            log(f"  {ms:.0f}ms | {fn} | {params}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Fast programme sync (bulk modules + workers)")
    parser.add_argument(
        "--programme-name",
        required=True,
        help="Programme name to match within selected category",
    )
    parser.add_argument("--seed-courseid", type=int, required=True, help="Seed module/course id")
    parser.add_argument(
        "--category-id",
        type=int,
        required=True,
        help="Moodle category id to keep one term only",
    )
    parser.add_argument("--workers", type=int, default=8, help="Parallel API workers")
    parser.add_argument(
        "--max-students",
        type=int,
        default=None,
        help="Optional cap students for quick test",
    )
    parser.add_argument(
        "--skip-finals",
        action="store_true",
        help="Skip per-student course total pass (faster test)",
    )
    parser.add_argument(
        "--verbose-api-timing",
        action="store_true",
        help="Print timing for every API call",
    )
    parser.add_argument(
        "--db-batch-size",
        type=int,
        default=2000,
        help="Batch size for student_assessment writes",
    )
    parser.add_argument("--reset", action="store_true", help="Truncate analytics tables first")
    args = parser.parse_args()

    programme_name = args.programme_name.strip()
    db_conn = read_env_value("DB CONNECTION STRING") or read_env_value("DB_CONNECTION_STRING")
    wstoken = read_env_value("wstoken") or read_env_value("WSTOKEN")
    if not db_conn:
        raise RuntimeError("DB connection string missing in .env")
    if not wstoken:
        raise RuntimeError("wstoken missing in .env")
    api = TimedApiCaller(wstoken, verbose=args.verbose_api_timing)
    log_flow_plan()
    log_run_config(args, programme_name)

    # Discover programme modules from one seed student's overview (fast, small call set).
    log_step(1, "Seed student discovery from seed module", "start")
    log_api_use(
        "gradereport_user_get_grade_items",
        {"courseid": args.seed_courseid},
        "first usergrades[*].userid as seed_student_id",
    )
    seed_payload = api.call("gradereport_user_get_grade_items", {"courseid": args.seed_courseid})
    seed_usergrades = seed_payload.get("usergrades", []) if isinstance(seed_payload, dict) else []
    if not seed_usergrades:
        raise RuntimeError(f"No students found in seed course {args.seed_courseid}")
    seed_student = seed_usergrades[0].get("userid")
    if seed_student is None:
        raise RuntimeError("Could not determine seed student id")
    log(f"[flow][01][done] seed_student_id={seed_student}")

    log_step(2, "Discover candidate modules from seed student overview", "start")
    log_api_use(
        "gradereport_overview_get_course_grades",
        {"userid": seed_student},
        "grades[*].courseid as candidate module ids",
    )
    seed_overview = api.call("gradereport_overview_get_course_grades", {"userid": seed_student})
    discovered_ids = sorted(
        {
            g.get("courseid")
            for g in (seed_overview.get("grades", []) if isinstance(seed_overview, dict) else [])
            if g.get("courseid") is not None
        }
    )
    log(f"[flow][02][done] candidate_courseids={len(discovered_ids)}")
    log_step(3, "Fetch course metadata and filter by programme/category", "start")
    log_api_use(
        "core_course_get_courses",
        {"options[ids][0]": "<courseid>"},
        "course metadata fields incl. shortname/fullname/categoryid then filtered by programme-name + category",
    )
    courses: dict[int, dict[str, Any]] = {}
    for cid in discovered_ids:
        c_payload = api.call("core_course_get_courses", {"options[ids][0]": cid})
        if isinstance(c_payload, list) and c_payload:
            c = c_payload[0]
            programme_matches = course_matches_programme_name(c, programme_name)
            category_matches = c.get("categoryid") == args.category_id
            if programme_matches and category_matches:
                courses[cid] = c
    if not courses:
        # Fallback discovery path when seed-student overview does not surface module list.
        log_api_use(
            "core_course_search_courses",
            {"criterianame": "search", "criteriavalue": programme_name},
            "fallback courses[*] then same programme-name/category filtering",
        )
        search_payload = api.call(
            "core_course_search_courses",
            {"criterianame": "search", "criteriavalue": programme_name},
        )
        for course in (
            search_payload.get("courses", []) if isinstance(search_payload, dict) else []
        ):
            cid = course.get("id")
            if cid is None:
                continue
            programme_matches = course_matches_programme_name(course, programme_name)
            category_matches = course.get("categoryid") == args.category_id
            if programme_matches and category_matches:
                courses[int(cid)] = course
    module_ids = sorted(courses.keys())
    if not module_ids:
        raise RuntimeError(
            f"No modules found for programme_name '{programme_name}' in category_id {args.category_id}"
        )
    log(f"[flow][03][done] kept_modules={len(module_ids)}")

    # Cache Moodle category names once to avoid repeated lookups during upserts.
    log_step(4, "Resolve category metadata for kept modules", "start")
    log_api_use(
        "core_course_get_categories",
        {
            "criteria[0][key]": "id",
            "criteria[0][value]": "<category_id>",
            "addsubcategories": 0,
        },
        "category metadata used for enrichment/upsert",
    )
    category_ids = sorted(
        {int(c["categoryid"]) for c in courses.values() if c.get("categoryid") is not None}
    )
    category_name_by_id: dict[int, str] = {}
    category_payload_by_id: dict[int, dict[str, Any]] = {}
    for category_id in category_ids:
        category_payload = api.call(
            "core_course_get_categories",
            {
                "criteria[0][key]": "id",
                "criteria[0][value]": str(category_id),
                "addsubcategories": 0,
            },
        )
        if isinstance(category_payload, list) and category_payload:
            category_row = category_payload[0]
            category_payload_by_id[category_id] = category_row
            category_name = category_row.get("name")
            if category_name:
                category_name_by_id[category_id] = str(category_name)
    log(f"[flow][04][done] resolved_categories={len(category_name_by_id)}/{len(category_ids)}")

    log(f"[stage] Modules in programme '{programme_name}': {len(module_ids)}")
    log(f"[stage] Category names resolved: {len(category_name_by_id)}/{len(category_ids)}")

    with psycopg.connect(db_conn) as conn:
        with conn.cursor() as cur:
            # Profile enrichment can be API-heavy; avoid server killing the open transaction.
            cur.execute("SET idle_in_transaction_session_timeout = 0;")
            if args.reset:
                log("[stage] Resetting analytics tables...")
                cur.execute(
                    """
                    TRUNCATE TABLE
                        public.student_assessment,
                        public.assessment,
                        public.assessment_type,
                        public.student,
                        public.module,
                        public.programme,
                        public.api_sync_run
                    RESTART IDENTITY CASCADE;
                    """
                )
                conn.commit()
                log("[stage] Reset complete")

            cur.execute(
                """
                INSERT INTO public.api_sync_run (status, notes)
                VALUES ('running', %s)
                RETURNING sync_run_id;
                """,
                (
                    f"programme_name={programme_name}, modules={len(module_ids)}, workers={args.workers}, "
                    f"skip_finals={args.skip_finals}",
                ),
            )
            sync_run_id = cur.fetchone()[0]
            conn.commit()
            log(f"[stage] Sync run created: {sync_run_id}")
            log_step(5, "Create sync run and upsert programme/module cache", "done")

            # Upsert programme/module cache once.
            log("[stage] Upserting programme/module cache...")
            for category_row in category_payload_by_id.values():
                upsert_category(cur, category_row)
            for module_id in module_ids:
                course = courses[module_id]
                pid = upsert_programme_fast(cur, course, category_name_by_id)
                upsert_module_fast(cur, course, pid)
            conn.commit()
            log("[stage] Programme/module cache complete")

            module_meta: dict[int, tuple[int | None, str | None, str | None]] = {}
            for module_id in module_ids:
                cur.execute(
                    """
                    SELECT m.programme_id, m.module_name, p.programme_name
                    FROM public.module m
                    LEFT JOIN public.programme p ON p.programme_id = m.programme_id
                    WHERE m.module_id = %s
                    """,
                    (module_id,),
                )
                module_meta[module_id] = cur.fetchone() or (None, None, None)

            # Fetch module gradebooks in parallel.
            log_step(6, "Fetch module gradebooks (parallel)", "start")
            log_api_use(
                "gradereport_user_get_grade_items",
                {"courseid": "<module_id>"},
                "all usergrades + gradeitems for each kept module",
            )
            log("[stage] Fetching module gradebooks in parallel...")
            gradebooks: dict[int, dict[str, Any]] = {}
            with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
                futs = [
                    pool.submit(
                        lambda m=mid: (m, api.call("gradereport_user_get_grade_items", {"courseid": m}))
                    )
                    for mid in module_ids
                ]
                for fut in as_completed(futs):
                    mid, payload = fut.result()
                    gradebooks[mid] = payload
                    count = len(payload.get("usergrades", [])) if isinstance(payload, dict) else 0
                    log(f"[fetch] module {mid}: {count} students")
            log(f"[flow][06][done] gradebooks_fetched={len(gradebooks)}")

            # Fetch due dates in parallel once, so load loop can focus on DB writes.
            log_step(7, "Fetch due dates (parallel)", "start")
            log_api_use(
                "mod_quiz_get_quizzes_by_courses",
                {"courseids[0]": "<module_id>"},
                "quizzes[*].coursemodule + timeclose",
            )
            log_api_use(
                "mod_assign_get_assignments",
                {"courseids[0]": "<module_id>"},
                "courses[*].assignments[*].cmid + duedate",
            )
            log("[stage] Fetching activity due dates in parallel...")
            due_dates_by_module: dict[int, dict[int, int]] = {}
            due_dates_by_item_by_module: dict[int, dict[tuple[str, int], int]] = {}
            due_counts_by_module: dict[int, tuple[int, int]] = {}
            with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
                futs = [pool.submit(fetch_module_due_dates, api, mid) for mid in module_ids]
                for fut in as_completed(futs):
                    mid, due_map, due_item_map, quiz_count, assign_count = fut.result()
                    due_dates_by_module[mid] = due_map
                    due_dates_by_item_by_module[mid] = due_item_map
                    due_counts_by_module[mid] = (quiz_count, assign_count)
                    log(
                        f"[fetch] module {mid}: due dates quiz={quiz_count} assign={assign_count}"
                    )
            log(f"[flow][07][done] due_date_maps={len(due_dates_by_module)}")

            all_student_ids = sorted(
                {
                    int(ug.get("userid"))
                    for payload in gradebooks.values()
                    for ug in (payload.get("usergrades", []) if isinstance(payload, dict) else [])
                    if ug.get("userid") is not None
                }
            )
            log_step(8, "Enrich student profiles", "start")
            log_api_use(
                "core_user_get_users_by_field",
                {"field": "id", "values[0..n]": "<student ids>"},
                "id/idnumber/email/firstname/lastname/fullname",
            )
            student_profiles = fetch_users_by_ids(wstoken, all_student_ids)
            log(
                f"[stage] Loaded student profiles: {len(student_profiles)}/{len(all_student_ids)}"
            )
            log_step(8, "Enrich student profiles", "done")

            log("[stage] Loading gradebook rows into DB...")
            log_step(9, "Load assessments and marks into DB", "start")
            assessment_type_cache: dict[str, int] = {}
            discovered_students: set[int] = set()
            student_names: dict[int, str | None] = {}
            upserted_students: set[int] = set()
            total_grade_rows = 0

            # Load assessments + student_assessment from module gradebooks.
            total_modules = len(module_ids)
            for module_idx, module_id in enumerate(module_ids, start=1):
                module_started = time.perf_counter()
                payload = gradebooks.get(module_id, {})
                usergrades = payload.get("usergrades", []) if isinstance(payload, dict) else []
                if args.max_students is not None:
                    usergrades = usergrades[: args.max_students]
                pid, module_name, programme_name = module_meta[module_id]
                due_by_cmid = due_dates_by_module.get(module_id, {})
                due_by_item = due_dates_by_item_by_module.get(module_id, {})
                quiz_due_count, assign_due_count = due_counts_by_module.get(module_id, (0, 0))

                assessment_map = upsert_module_assessments(cur, module_id, usergrades, assessment_type_cache)
                conn.commit()
                log(
                    f"[load] module {module_idx}/{total_modules} {module_id}: assessments ready {len(assessment_map)}, due dates quiz={quiz_due_count} assign={assign_due_count}"
                )

                module_student_rows = 0
                module_grade_rows = 0
                student_assessment_rows: list[tuple[Any, ...]] = []
                for ug in usergrades:
                    sid = ug.get("userid")
                    if sid is None:
                        continue
                    discovered_students.add(sid)
                    profile = student_profiles.get(int(sid), {})
                    student_number = profile.get("idnumber") or ug.get("useridnumber")
                    student_name = profile.get("fullname") or ug.get("userfullname")
                    if student_name:
                        student_names[sid] = student_name
                    module_student_rows += 1
                    if sid not in upserted_students:
                        upsert_student(
                            cur,
                            {
                                "id": sid,
                                "idnumber": student_number,
                                "student_number": student_number,
                                "programme_name": programme_name,
                                "email": profile.get("email"),
                                "firstname": profile.get("firstname"),
                                "lastname": profile.get("lastname"),
                                "fullname": student_name,
                            },
                            pid,
                        )
                        upserted_students.add(sid)

                    for gi in ug.get("gradeitems", []):
                        gid = gi.get("id")
                        if gid is None:
                            continue
                        if (gi.get("itemtype") or "").lower() in {"course", "category"}:
                            continue
                        mapped = assessment_map.get(gid)
                        if not mapped:
                            continue
                        aid, atype = mapped
                        cmid = gi.get("cmid")
                        cmid_int = int(cmid) if isinstance(cmid, int) else None
                        due_date_value = due_by_cmid.get(cmid_int) if cmid_int is not None else None
                        if due_date_value is None:
                            itemmodule = (gi.get("itemmodule") or "").strip().lower()
                            iteminstance = gi.get("iteminstance")
                            if itemmodule and isinstance(iteminstance, int):
                                due_date_value = due_by_item.get((itemmodule, int(iteminstance)))
                        due_date_epoch = str(due_date_value) if due_date_value is not None else None
                        student_assessment_rows.append(
                            (
                                sid,
                                student_name,
                                pid,
                                programme_name,
                                module_id,
                                module_name,
                                aid,
                                atype,
                                parse_numeric(gi.get("graderaw")),
                                gi.get("gradeformatted"),
                                due_date_epoch,
                                gi.get("gradedatesubmitted"),
                                gi.get("gradedategraded"),
                                gi.get("gradeislocked"),
                                gi.get("gradeishidden"),
                            )
                        )
                        module_grade_rows += 1

                for chunk_idx, row_chunk in enumerate(
                    chunked(student_assessment_rows, max(1, args.db_batch_size)),
                    start=1,
                ):
                    cur.executemany(
                        """
                        INSERT INTO public.student_assessment
                            (student_id, student_name, programme_id, programme_name, module_id, module_name, assessment_id, assessment_type, mark_raw, mark_display, due_date, date_submitted_epoch, date_graded_epoch, is_locked, is_hidden, synced_at)
                        VALUES
                            (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                        ON CONFLICT (student_id, assessment_id) DO UPDATE
                            SET student_name = EXCLUDED.student_name,
                                programme_id = EXCLUDED.programme_id,
                                programme_name = EXCLUDED.programme_name,
                                module_id = EXCLUDED.module_id,
                                module_name = EXCLUDED.module_name,
                                assessment_type = EXCLUDED.assessment_type,
                                mark_raw = EXCLUDED.mark_raw,
                                mark_display = EXCLUDED.mark_display,
                                due_date = EXCLUDED.due_date,
                                date_submitted_epoch = EXCLUDED.date_submitted_epoch,
                                date_graded_epoch = EXCLUDED.date_graded_epoch,
                                is_locked = EXCLUDED.is_locked,
                                is_hidden = EXCLUDED.is_hidden,
                                synced_at = now();
                        """,
                        row_chunk,
                    )
                    conn.commit()
                    log(
                        f"[load] module {module_id}: chunk {chunk_idx} wrote {len(row_chunk)} rows"
                    )

                total_grade_rows += module_grade_rows
                conn.commit()
                elapsed = time.perf_counter() - module_started
                rate = (module_grade_rows / elapsed) if elapsed > 0 else 0.0
                log(
                    f"[load] module {module_idx}/{total_modules} {module_id}: students={module_student_rows}, grade_rows={module_grade_rows}, rate={rate:.1f} rows/s"
                )
            log_step(9, "Load assessments and marks into DB", "done")

            # Optional final course totals from overview API (parallel across students).
            if not args.skip_finals and discovered_students:
                log_step(10, "Optional course-total pass", "start")
                log_api_use(
                    "gradereport_overview_get_course_grades",
                    {"userid": "<student_id>"},
                    "grades[*].courseid/rawgrade/grade for Course Total rows",
                )
                log("[stage] Fetching course totals in parallel...")
                student_list = sorted(discovered_students)
                final_assessment_by_module = upsert_course_total_assessments(
                    cur, module_ids, assessment_type_cache
                )
                conn.commit()
                final_rows: list[tuple[Any, ...]] = []
                with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
                    futs = [
                        pool.submit(
                            lambda s=sid: (
                                s,
                                api.call("gradereport_overview_get_course_grades", {"userid": s}),
                            )
                        )
                        for sid in student_list
                    ]
                    for idx, fut in enumerate(as_completed(futs), start=1):
                        sid, payload = fut.result()
                        grades = payload.get("grades", []) if isinstance(payload, dict) else []
                        for g in grades:
                            mid = g.get("courseid")
                            if mid not in module_ids:
                                continue
                            pid, module_name, programme_name = module_meta[mid]
                            final_rows.append(
                                (
                                    sid,
                                    student_names.get(sid),
                                    pid,
                                    programme_name,
                                    mid,
                                    module_name,
                                    final_assessment_by_module[mid],
                                    parse_numeric(g.get("rawgrade")),
                                    g.get("grade"),
                                )
                            )
                        if idx % 25 == 0:
                            for row_chunk in chunked(final_rows, max(1, args.db_batch_size)):
                                cur.executemany(
                                    """
                                    INSERT INTO public.student_assessment
                                        (student_id, student_name, programme_id, programme_name, module_id, module_name, assessment_id, assessment_type, mark_raw, mark_display, synced_at)
                                    VALUES
                                        (%s, %s, %s, %s, %s, %s, %s, 'Course Total', %s, %s, now())
                                    ON CONFLICT (student_id, assessment_id) DO UPDATE
                                        SET student_name = EXCLUDED.student_name,
                                            programme_id = EXCLUDED.programme_id,
                                            programme_name = EXCLUDED.programme_name,
                                            module_id = EXCLUDED.module_id,
                                            module_name = EXCLUDED.module_name,
                                            assessment_type = EXCLUDED.assessment_type,
                                            mark_raw = EXCLUDED.mark_raw,
                                            mark_display = EXCLUDED.mark_display,
                                            synced_at = now();
                                    """,
                                    row_chunk,
                                )
                            final_rows.clear()
                            conn.commit()
                            log(f"[finals] processed {idx}/{len(student_list)} students")
                if final_rows:
                    for row_chunk in chunked(final_rows, max(1, args.db_batch_size)):
                        cur.executemany(
                            """
                            INSERT INTO public.student_assessment
                                (student_id, student_name, programme_id, programme_name, module_id, module_name, assessment_id, assessment_type, mark_raw, mark_display, synced_at)
                            VALUES
                                (%s, %s, %s, %s, %s, %s, %s, 'Course Total', %s, %s, now())
                            ON CONFLICT (student_id, assessment_id) DO UPDATE
                                SET student_name = EXCLUDED.student_name,
                                    programme_id = EXCLUDED.programme_id,
                                    programme_name = EXCLUDED.programme_name,
                                    module_id = EXCLUDED.module_id,
                                    module_name = EXCLUDED.module_name,
                                    assessment_type = EXCLUDED.assessment_type,
                                    mark_raw = EXCLUDED.mark_raw,
                                    mark_display = EXCLUDED.mark_display,
                                    synced_at = now();
                            """,
                            row_chunk,
                        )
                conn.commit()
                log("[stage] Course totals complete")
                log_step(10, "Optional course-total pass", "done")

            cur.execute(
                """
                UPDATE public.api_sync_run
                SET status='success', finished_at=now(), notes=%s
                WHERE sync_run_id=%s
                """,
                (
                    f"students={len(discovered_students)}, modules={len(module_ids)}, skip_finals={args.skip_finals}",
                    sync_run_id,
                ),
            )
            conn.commit()
            log_step(11, "Finalize sync run", "done")
            log(
                f"[done] students={len(discovered_students)}, modules={len(module_ids)}, grade_rows={total_grade_rows}"
            )
            api.print_summary()


if __name__ == "__main__":
    main()
