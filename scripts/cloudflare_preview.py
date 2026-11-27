"""Validate public Cloudflare Development Preview URLs before using secrets."""

import json
import os
from pathlib import Path
import re
import sys


def validate(origin, database, production_database, worker):
    subdomain = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    pattern = rf"https://development-{re.escape(worker)}\.{subdomain}\.workers\.dev"
    if not re.fullmatch(pattern, origin):
        raise ValueError("Set the expected native Cloudflare Development Preview URL")
    if not production_database or database == production_database or not re.fullmatch(
        r"https://[a-z0-9]{20}\.supabase\.co", database
    ):
        raise ValueError("Use an HTTPS Supabase test project distinct from production")


def main():
    worker = Path(__file__).resolve().parents[1] / "apps/worker/wrangler.jsonc"
    config = json.loads(worker.read_text())
    try:
        validate(os.getenv("NICX_PREVIEW_ORIGIN", ""), os.getenv("NICX_PREVIEW_SUPABASE_URL", ""),
                 config["vars"]["SUPABASE_URL"], config["name"])
        key = os.getenv("NICX_PREVIEW_SUPABASE_PUBLISHABLE_KEY", "")
        if not key.startswith("sb_publishable_"):
            raise ValueError("Set the preview Supabase browser publishable key")
    except ValueError as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
