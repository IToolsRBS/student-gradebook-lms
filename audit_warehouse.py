"""
Durable GRAB export audit trail in MotherDuck.

Local JSONL on Render lives under /tmp and is wiped on redeploy.
This module appends every event to grab_app.export_audit_log so history is permanent.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone

from motherduck_client import connect_motherduck, read_env_value

DEFAULT_SCHEMA = "grab_app"
DEFAULT_TABLE = "export_audit_log"


def audit_schema() -> str:
    return read_env_value("AUDIT_WAREHOUSE_SCHEMA") or DEFAULT_SCHEMA


def audit_table() -> str:
    return read_env_value("AUDIT_WAREHOUSE_TABLE") or DEFAULT_TABLE


def qualified_table() -> str:
    schema = audit_schema().replace('"', "")
    table = audit_table().replace('"', "")
    return f'"{schema}"."{table}"'


def ensure_table(conn) -> None:
    schema = audit_schema().replace('"', "")
    table = qualified_table()
    conn.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
    # Use VARCHAR for JSON payloads to avoid MotherDuck JSON-type insert quirks.
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {table} (
          event_id VARCHAR PRIMARY KEY,
          at TIMESTAMPTZ NOT NULL,
          event VARCHAR NOT NULL,
          job_id VARCHAR,
          report_type VARCHAR,
          status VARCHAR,
          user_email VARCHAR,
          user_name VARCHAR,
          user_role VARCHAR,
          filters VARCHAR,
          file_name VARCHAR,
          error VARCHAR,
          timings_ms VARCHAR
        )
        """
    )


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _as_text(value):
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def append_event(payload: dict) -> dict:
    entry = dict(payload or {})
    entry.setdefault("at", _iso_now())
    event_id = (
        entry.get("eventId")
        or entry.get("event_id")
        or f"{entry['at']}:{entry.get('jobId') or entry.get('job_id') or 'none'}:{entry.get('event') or 'event'}"
    )
    at_value = entry.get("at")
    conn = connect_motherduck()
    try:
        ensure_table(conn)
        table = qualified_table()
        conn.execute(
            f"""
            INSERT OR REPLACE INTO {table} (
              event_id, at, event, job_id, report_type, status,
              user_email, user_name, user_role, filters, file_name, error, timings_ms
            ) VALUES (
              ?, CAST(? AS TIMESTAMPTZ), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            )
            """,
            [
                str(event_id),
                str(at_value),
                entry.get("event"),
                entry.get("jobId") or entry.get("job_id"),
                entry.get("reportType") or entry.get("report_type"),
                entry.get("status"),
                entry.get("userEmail") or entry.get("user_email"),
                entry.get("userName") or entry.get("user_name"),
                entry.get("userRole") or entry.get("user_role"),
                _as_text(entry.get("filters")),
                entry.get("fileName") or entry.get("file_name"),
                entry.get("error"),
                _as_text(entry.get("timingsMs") or entry.get("timings_ms")),
            ],
        )
    finally:
        conn.close()
    entry["eventId"] = str(event_id)
    entry["persisted"] = "motherduck"
    return entry


def _parse_json_field(value):
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    text = str(value).strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        return value


def list_events(limit: int = 1000) -> list[dict]:
    max_rows = max(1, min(int(limit or 1000), 20000))
    conn = connect_motherduck()
    try:
        ensure_table(conn)
        table = qualified_table()
        rows = conn.execute(
            f"""
            SELECT
              event_id, at, event, job_id, report_type, status,
              user_email, user_name, user_role, filters, file_name, error, timings_ms
            FROM {table}
            ORDER BY at DESC
            LIMIT {max_rows}
            """
        ).fetchall()
        columns = [
            "event_id",
            "at",
            "event",
            "job_id",
            "report_type",
            "status",
            "user_email",
            "user_name",
            "user_role",
            "filters",
            "file_name",
            "error",
            "timings_ms",
        ]
        events = []
        for row in rows:
            raw = dict(zip(columns, row))
            at_value = raw["at"]
            if hasattr(at_value, "isoformat"):
                at_value = at_value.isoformat()
            events.append(
                {
                    "eventId": raw["event_id"],
                    "at": str(at_value) if at_value is not None else None,
                    "event": raw["event"],
                    "jobId": raw["job_id"],
                    "reportType": raw["report_type"],
                    "status": raw["status"],
                    "userEmail": raw["user_email"],
                    "userName": raw["user_name"],
                    "userRole": raw["user_role"],
                    "filters": _parse_json_field(raw["filters"]),
                    "fileName": raw["file_name"],
                    "error": raw["error"],
                    "timingsMs": _parse_json_field(raw["timings_ms"]),
                    "source": "motherduck",
                }
            )
        return events
    finally:
        conn.close()


def _print_json(payload) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="GRAB export audit warehouse store")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("ensure", help="Create audit schema/table if missing")

    append_parser = sub.add_parser("append", help="Append one audit event from stdin JSON")
    append_parser.add_argument(
        "--payload",
        help="Optional JSON payload (otherwise read from stdin)",
    )

    list_parser = sub.add_parser("list", help="List recent audit events as JSON")
    list_parser.add_argument("--limit", type=int, default=1000)

    args = parser.parse_args(argv)

    try:
        if args.command == "ensure":
            conn = connect_motherduck()
            try:
                ensure_table(conn)
            finally:
                conn.close()
            _print_json({"ok": True, "table": qualified_table()})
            return 0

        if args.command == "append":
            raw = args.payload
            if not raw:
                raw = sys.stdin.read()
            payload = json.loads(raw or "{}")
            entry = append_event(payload)
            _print_json(entry)
            return 0

        if args.command == "list":
            events = list_events(args.limit)
            _print_json({"ok": True, "count": len(events), "events": events})
            return 0

        parser.error(f"Unknown command: {args.command}")
        return 2
    except Exception as exc:
        print(f"audit_warehouse error: {exc}", file=sys.stderr)
        _print_json({"ok": False, "error": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
