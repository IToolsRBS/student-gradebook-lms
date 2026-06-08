"""Print programme-dropdown pipeline counts for a category (troubleshooting)."""

from __future__ import annotations

import argparse
import json

from motherduck_client import connect_motherduck
from warehouse_metadata import debug_programme_chain


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--category-name", required=True)
    args = parser.parse_args()

    conn = connect_motherduck()
    try:
        report = debug_programme_chain(conn, args.category_name.strip())
    finally:
        conn.close()

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
