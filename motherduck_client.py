"""
MotherDuck connection helper — matches dbt profile pattern:

  type: duckdb
  path: "md:regent_data_platform_prod"
  token: "{{ env_var('MOTHERDUCK_TOKEN') }}"
"""

from __future__ import annotations

import os
from pathlib import Path

import duckdb

ENV_FILE_NAMES = (".env", ".env.txt")
DEFAULT_DATABASE = "regent_data_platform_prod"
DEFAULT_GRADEBOOK_SCHEMA = "moodle_processed"
DEFAULT_STAGING_SCHEMA = "moodle_staging"
DEFAULT_DIM_SCHEMA = "moodle_processed"
BRIDGE_CATEGORY_PROGRAMMES_TABLE = "bridge_category_programmes"


def read_env_value(*keys: str) -> str | None:
    for key in keys:
        value = os.getenv(key)
        if value and str(value).strip():
            return str(value).strip().strip('"').strip("'")
    script_dir = Path(__file__).resolve().parent
    candidates = [
        script_dir / name for name in ENV_FILE_NAMES
    ] + [Path.cwd() / name for name in ENV_FILE_NAMES]
    for env_file in candidates:
        if not env_file.exists():
            continue
        for raw_line in env_file.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            left, right = line.split("=", 1)
            env_key = left.strip().strip('"').strip("'")
            env_val = right.strip().strip('"').strip("'")
            if env_key in keys and env_val:
                return env_val
    return None


def motherduck_database() -> str:
    return read_env_value("MOTHERDUCK_DATABASE") or DEFAULT_DATABASE


def normalize_motherduck_token(raw: str) -> str:
    """Clean token from .env / env vars (quotes, Bearer prefix, line breaks)."""
    token = raw.strip().strip('"').strip("'")
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    token = "".join(token.split())
    # md_ prefix is a MotherDuck wrapper; DuckDB expects the underlying JWT.
    if token.startswith("md_"):
        token = token[3:]
    return token


def validate_motherduck_token(token: str) -> None:
    parts = token.split(".")
    if len(parts) != 3 or not all(parts):
        raise RuntimeError(
            "MOTHERDUCK_TOKEN looks incomplete (expected a JWT with 3 dot-separated "
            "parts). Copy the full access token from MotherDuck → Settings → Access Tokens."
        )


def motherduck_token() -> str:
    token = read_env_value("MOTHERDUCK_TOKEN")
    if not token:
        raise RuntimeError(
            "MOTHERDUCK_TOKEN is required (same token as dbt profiles.yml)"
        )
    token = normalize_motherduck_token(token)
    validate_motherduck_token(token)
    return token


def connect_motherduck() -> duckdb.DuckDBPyConnection:
    """
    Connect to MotherDuck using the dbt-equivalent path md:{database}.
    Uses config= (recommended by MotherDuck) instead of query-string only.
    """
    import re

    database = motherduck_database()
    token = motherduck_token()
    os.environ["motherduck_token"] = token
    try:
        conn = duckdb.connect(f"md:{database}", config={"motherduck_token": token})
    except Exception as exc:
        message = str(exc)
        if "Failed to download extension \"motherduck\"" in message or (
            "motherduck" in message.lower() and "HTTP 404" in message
        ):
            raise RuntimeError(
                "DuckDB could not download the MotherDuck extension for this "
                f"DuckDB version ({duckdb.__version__}). Pin duckdb in "
                "requirements.txt to a version that has the MotherDuck extension "
                "published (see extensions.duckdb.org), rebuild the image, and retry. "
                f"Original error: {message}"
            ) from exc
        raise
    # Cap local DuckDB buffer so exports are less likely to OOM on small hosts.
    memory_limit = read_env_value("DUCKDB_MEMORY_LIMIT") or "512MB"
    if re.fullmatch(r"\d+(?:\.\d+)?\s*(?:KB|MB|GB)", memory_limit, flags=re.I):
        try:
            conn.execute(f"SET memory_limit='{memory_limit.replace(' ', '')}'")
        except Exception:
            pass
    try:
        conn.execute("SET threads=2")
    except Exception:
        pass
    return conn


def gradebook_schema() -> str:
    return (
        read_env_value("WAREHOUSE_GRADEBOOK_SCHEMA", "WAREHOUSE_SCHEMA")
        or DEFAULT_GRADEBOOK_SCHEMA
    )


def staging_schema() -> str:
    return read_env_value("WAREHOUSE_STAGING_SCHEMA") or DEFAULT_STAGING_SCHEMA


def dim_schema() -> str:
    return read_env_value("WAREHOUSE_DIM_SCHEMA") or DEFAULT_DIM_SCHEMA


def courses_schema() -> str:
    return read_env_value("WAREHOUSE_COURSES_SCHEMA") or dim_schema()


def qualified_relation(schema: str, table: str) -> str:
    for name, label in ((schema, "schema"), (table, "table")):
        if not name or not all(ch.isalnum() or ch == "_" for ch in name):
            raise ValueError(f"Invalid {label}: {name}")
    return f'"{schema}"."{table}"'
