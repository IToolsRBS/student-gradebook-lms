"""CLI for Express dropdown APIs — prints JSON to stdout."""

from __future__ import annotations

import argparse
import json

from motherduck_client import connect_motherduck
from warehouse_metadata import fetch_categories, fetch_modules, fetch_programmes


def main() -> None:
    parser = argparse.ArgumentParser(description="List warehouse categories/programmes")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("categories", help="List Moodle categories from warehouse")
    programmes = sub.add_parser("programmes", help="List programmes for a category")
    programmes.add_argument("--category-name", required=True)
    modules = sub.add_parser("modules", help="List modules for category + programmes")
    modules.add_argument("--category-name", required=True)
    modules.add_argument(
        "--programme-codes",
        required=True,
        help="Comma-separated programme codes",
    )
    args = parser.parse_args()

    conn = connect_motherduck()
    try:
        if args.command == "categories":
            payload = fetch_categories(conn)
        elif args.command == "programmes":
            payload = fetch_programmes(conn, args.category_name)
        else:
            codes = [
                part.strip()
                for part in str(args.programme_codes or "").split(",")
                if part.strip()
            ]
            payload = fetch_modules(conn, args.category_name, codes)
    finally:
        conn.close()

    print(json.dumps(payload))


if __name__ == "__main__":
    main()
