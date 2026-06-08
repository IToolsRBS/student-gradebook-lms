"""CLI for Express dropdown APIs — prints JSON to stdout."""

from __future__ import annotations

import argparse
import json

from motherduck_client import connect_motherduck
from warehouse_metadata import fetch_categories, fetch_programmes


def main() -> None:
    parser = argparse.ArgumentParser(description="List warehouse categories/programmes")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("categories", help="List Moodle categories from warehouse")
    programmes = sub.add_parser("programmes", help="List programmes for a category")
    programmes.add_argument("--category-name", required=True)
    args = parser.parse_args()

    conn = connect_motherduck()
    try:
        if args.command == "categories":
            payload = fetch_categories(conn)
        else:
            payload = fetch_programmes(conn, args.category_name)
    finally:
        conn.close()

    print(json.dumps(payload))


if __name__ == "__main__":
    main()
