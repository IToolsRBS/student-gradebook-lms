import os
import sys

import psycopg2
import requests
from dotenv import load_dotenv


def get_required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise ValueError(f"Missing required environment variable: {name}")
    return value


def fetch_enrolled_users(moodle_url: str, moodle_token: str, course_id: str) -> list[dict]:
    response = requests.post(
        moodle_url,
        data={
            "wstoken": moodle_token,
            "wsfunction": "core_enrol_get_enrolled_users",
            "moodlewsrestformat": "json",
            "courseid": course_id,
        },
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()

    if isinstance(data, dict) and data.get("exception"):
        message = data.get("message", "Unknown Moodle API error")
        raise RuntimeError(f"Moodle API error: {message}")

    if not isinstance(data, list):
        raise RuntimeError("Unexpected Moodle API response format.")

    return data


def insert_users(database_url: str, users: list[dict]) -> int:
    conn = psycopg2.connect(database_url)
    inserted_count = 0

    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS users (
                        id BIGINT PRIMARY KEY,
                        fullname TEXT,
                        email TEXT,
                        phone1 TEXT
                    )
                    """
                )

                cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS phone1 TEXT")

                for user in users:
                    cur.execute(
                        """
                        INSERT INTO users (id, fullname, email, phone1)
                        VALUES (%s, %s, %s, %s)
                        ON CONFLICT (id) DO UPDATE SET
                            fullname = EXCLUDED.fullname,
                            email = EXCLUDED.email,
                            phone1 = COALESCE(EXCLUDED.phone1, users.phone1)
                        """,
                        (
                            user.get("id"),
                            user.get("fullname"),
                            user.get("email"),
                            user.get("phone1"),
                        ),
                    )
                    inserted_count += cur.rowcount
    finally:
        conn.close()

    return inserted_count


def main() -> int:
    load_dotenv()

    try:
        moodle_url = get_required_env("MOODLE_URL")
        moodle_token = get_required_env("MOODLE_TOKEN")
        database_url = get_required_env("DATABASE_URL")
        course_id = get_required_env("MOODLE_COURSE_ID")

        users = fetch_enrolled_users(moodle_url, moodle_token, course_id)
        inserted_count = insert_users(database_url, users)
        print(f"Inserted {inserted_count} users.")
        return 0
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
