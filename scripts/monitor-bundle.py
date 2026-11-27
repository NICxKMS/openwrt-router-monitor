#!/usr/bin/env python3
"""Build or unpack the fixed Worker and dashboard bytes for a production promotion."""

import argparse
import gzip
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MONITOR = ROOT / "nicx-router-monitor"
REQUIRED = {"bundle.json", "worker.js", "dashboard/index.html"}
MAX_BYTES = 96 * 1024 * 1024


def bundle_path(name):
    path = PurePosixPath(name)
    if str(path) != name or path.is_absolute() or ".." in path.parts or "\\" in name:
        raise ValueError(f"Unsafe bundle path: {name!r}")
    if name in {"bundle.json", "worker.js"} or (len(path.parts) > 1 and path.parts[0] == "dashboard"):
        return path
    raise ValueError(f"Unexpected bundle file: {name!r}")


def unpack(archive_path, destination, expected_commit):
    if destination.exists():
        raise ValueError("Bundle extraction needs a new destination")
    with tarfile.open(archive_path, "r:gz") as archive:
        files = {}
        size = 0
        for member in archive:
            path = bundle_path(member.name)
            size += member.size
            if not member.isfile() or path in files or size > MAX_BYTES or len(files) >= 4096:
                raise ValueError("Unsafe or oversized monitoring bundle")
            files[path] = member
        if not REQUIRED <= {str(file) for file in files}:
            raise ValueError("The monitoring bundle is incomplete")
        entry = files[PurePosixPath("bundle.json")]
        if entry.size > 4096:
            raise ValueError("Invalid bundle provenance")
        with archive.extractfile(entry) as file:
            if json.load(file).get("source_commit") != expected_commit:
                raise ValueError("Bundle source commit differs from the approved source")
        destination.mkdir(mode=0o700)
        try:
            for path, member in files.items():
                output = destination / path
                output.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, output.open("xb") as target:
                    shutil.copyfileobj(source, target)
        except BaseException:
            shutil.rmtree(destination)
            raise


def pack(destination, worker, dashboard, source_commit):
    assets = sorted(dashboard.rglob("*"))
    if not worker.is_file() or not (dashboard / "index.html").is_file():
        raise ValueError("Worker bundle or dashboard build is missing")
    if any(file.is_symlink() for file in assets):
        raise ValueError("Dashboard assets must be regular files")
    with destination.open("xb") as output:
        try:
            with gzip.GzipFile(fileobj=output, filename="", mode="wb", mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode="w") as archive:
                    metadata = json.dumps({"source_commit": source_commit}, sort_keys=True).encode()
                    entry = tarfile.TarInfo("bundle.json")
                    entry.size = len(metadata)
                    archive.addfile(entry, io.BytesIO(metadata))
                    files = [("worker.js", worker)]
                    files.extend(("dashboard/" + file.relative_to(dashboard).as_posix(), file)
                                 for file in assets if file.is_file())
                    for name, path in files:
                        bundle_path(name)
                        entry = tarfile.TarInfo(name)
                        entry.size = path.stat().st_size
                        with path.open("rb") as asset:
                            archive.addfile(entry, asset)
        except BaseException:
            destination.unlink(missing_ok=True)
            raise


def build(destination, source_commit):
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    status = subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True)
    if actual != source_commit or status:
        raise ValueError("Build a production bundle from a clean checkout of the exact candidate")
    key = os.environ.get("VITE_SUPABASE_ANON_KEY", "")
    if not key:
        raise ValueError("Set VITE_SUPABASE_ANON_KEY to the production browser publishable key")
    config = json.loads((MONITOR / "apps/worker/wrangler.jsonc").read_text())
    env = {name: value for name, value in os.environ.items()
           if not name.startswith(("CLOUDFLARE_", "VITE_", "SUPABASE_", "WRANGLER_"))}
    env.update(VITE_SUPABASE_URL=config["vars"]["SUPABASE_URL"], VITE_SUPABASE_ANON_KEY=key,
               VITE_API_URL="", WRANGLER_SEND_METRICS="false")
    with tempfile.TemporaryDirectory(prefix="jidu6111-monitor-bundle-") as work:
        scratch = Path(work)
        env["WRANGLER_LOG_PATH"] = str(scratch / "logs")
        dashboard = scratch / "dashboard"
        worker = scratch / "worker"
        subprocess.run(["pnpm", "--filter", "@nicx/dashboard", "build", "--outDir", str(dashboard)],
                       cwd=MONITOR, env=env, check=True)
        subprocess.run(["pnpm", "--filter", "@nicx/worker", "exec", "wrangler", "versions", "upload",
                        "--dry-run", "--outdir", str(worker), "--assets", str(dashboard)],
                       cwd=MONITOR, env=env, check=True)
        pack(destination, worker / "index.js", dashboard, source_commit)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("build", "unpack"):
        command = commands.add_parser(name)
        command.add_argument("archive", type=Path)
        command.add_argument("--source-commit", required=True)
        if name == "unpack":
            command.add_argument("destination", type=Path)
    args = parser.parse_args()
    try:
        if not re.fullmatch("[a-f0-9]{40}", args.source_commit):
            raise ValueError("Expected an exact source commit")
        if args.command == "unpack":
            unpack(args.archive, args.destination, args.source_commit)
        else:
            build(args.archive, args.source_commit)
    except (ValueError, OSError, tarfile.TarError, subprocess.SubprocessError) as error:
        print(f"Monitor bundle error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
