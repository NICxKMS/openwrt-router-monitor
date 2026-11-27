#!/usr/bin/env python3
"""Start a disposable monitor stack and seed it with a simulated router."""

import argparse
import fcntl
from contextlib import contextmanager, ExitStack
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
import uuid

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "jidu6111-monitor-dev-"


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


HTTP = build_opener(ProxyHandler({}), NoRedirects())


def clean_env():
    return {key: value for key, value in os.environ.items()
            if not key.startswith(("SUPABASE_", "VITE_", "WRANGLER_", "CLOUDFLARE_", "NICX_DEV_"))}


def open_ports(count):
    with ExitStack() as stack:
        sockets = [stack.enter_context(socket.socket()) for _ in range(count)]
        for server in sockets:
            server.bind(("127.0.0.1", 0))
        return [server.getsockname()[1] for server in sockets]


def local_url(port):
    return f"http://127.0.0.1:{port}"


def supabase_config(directory, project, ports, dashboard):
    config = (ROOT / "supabase/config.toml").read_text()
    values = {"54321": ports[0], "54322": ports[1], "54320": ports[2]}
    config = re.sub(r"54321|54322|54320", lambda match: str(values[match[0]]), config)
    config = re.sub(r'(?m)^project_id = ".*"$', f'project_id = "{project}"', config)
    config = re.sub(r'(?m)^site_url = ".*"$', f'site_url = "{local_url(dashboard)}"', config)
    config += f"\n[studio]\nport = {ports[3]}\n\n[inbucket]\nport = {ports[4]}\n"
    config += "\n[analytics]\nenabled = false\n"
    source = directory / "supabase"
    source.mkdir()
    (source / "config.toml").write_text(config)
    shutil.copytree(ROOT / "supabase/migrations", source / "migrations")
    return config


def worker_config(database, dashboard):
    return {
        "name": "nicx-monitor-local",
        "main": str(ROOT / "apps/worker/src/index.ts"),
        "compatibility_date": json.loads((ROOT / "apps/worker/wrangler.jsonc").read_text())["compatibility_date"],
        "vars": {"APP_ORIGIN": local_url(dashboard), "SUPABASE_URL": local_url(database),
                 "DEV_LOOPBACK_SUPABASE": "1"},
    }


def request(base, route, payload=None, *, key=None, token=None):
    target = urlsplit(base)
    if target.scheme != "http" or target.hostname != "127.0.0.1" or not target.port:
        raise ValueError("The development stack accepts only local endpoints")
    headers = {"Content-Type": "application/json"}
    if key:
        headers["apikey"] = key
    if token:
        headers["Authorization"] = "Bearer " + token
    data = json.dumps(payload).encode() if payload is not None else None
    with HTTP.open(Request(base + route, data=data, headers=headers), timeout=8) as response:
        return response.read()


def load(base, route, payload=None, **auth):
    return json.loads(request(base, route, payload, **auth))


def seed(api, worker, publishable, backend):
    email = "router-fixture@example.test"
    password = secrets.token_urlsafe(24)
    credentials = {"email": email, "password": password}
    admin_token = None if backend.startswith("sb_secret_") else backend
    load(api, "/auth/v1/admin/users", {**credentials, "email_confirm": True}, key=backend, token=admin_token)
    user = load(api, "/auth/v1/token?grant_type=password", credentials, key=publishable)
    enrollment = load(worker, "/api/v1/enrollment", {"name": "Simulated JIDU6111"}, token=user["access_token"])
    router = load(worker, "/api/v1/devices/enroll", {
        "enrollment_token": enrollment["token"], "name": "Simulated JIDU6111",
    })
    sample = {
        "seq": 1, "uptime_s": 10, "observed_at": None, "cpu_pct": 42, "load1": None,
        "mem_total_kb": 512000, "mem_available_kb": 283000, "temp_c": None,
        "rx_bytes_delta": None, "tx_bytes_delta": None, "elapsed_s": 10, "interfaces": [],
    }
    result = load(worker, "/api/v1/telemetry", {
        "schema_version": 1, "device_id": router["device_id"], "boot_id": str(uuid.uuid4()),
        "batch_id": str(uuid.uuid4()), "sent_at": None, "clock_synced": False, "samples": [sample], "logs": [],
    }, token=router["token"])
    if not result.get("accepted"):
        raise ValueError("The disposable API did not accept the simulated router sample")
    latest = load(api, f'/rest/v1/device_latest?device_id=eq.{router["device_id"]}&select=seq',
                  key=publishable, token=user["access_token"])
    if latest != [{"seq": 1}]:
        raise ValueError("The test owner could not read the accepted sample")
    return email, password


def ready(process, url, route):
    deadline = time.monotonic() + 30
    while process.poll() is None and time.monotonic() < deadline:
        try:
            request(url, route)
            return
        except URLError:
            time.sleep(0.25)
    raise RuntimeError(f"Development service failed to start at {url}")


def stop_process(process):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


def stop_database(directory, project, env):
    if not (directory / "supabase/config.toml").is_file():
        return True
    try:
        return subprocess.run(
            ["supabase", "--workdir", str(directory), "stop", "--project-id", project, "--no-backup"],
            env=env, check=False, timeout=45,
        ).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def start_time(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def publish_processes(directory, processes):
    path = directory / "processes.json"
    temporary = directory / "processes.tmp"
    temporary.write_text(json.dumps([[process.pid, start_time(process.pid)] for process in processes]))
    temporary.replace(path)


def reap_abandoned(env):
    for directory in Path(tempfile.gettempdir()).glob(PREFIX + "*"):
        if directory.is_symlink() or not directory.is_dir():
            continue
        identity = directory.stat()
        if identity.st_uid != os.getuid() or identity.st_mode & 0o077:
            continue
        try:
            with os.fdopen(os.open(directory / "lock", os.O_RDONLY | os.O_NOFOLLOW)) as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                project = (directory / "project-id").read_text()
                if not re.fullmatch(r"jidu-dev-[0-9a-f]{12}", project):
                    continue
                if (directory / "processes.json").exists():
                    for pid, recorded_start in json.loads((directory / "processes.json").read_text()):
                        if recorded_start and start_time(pid) == recorded_start:
                            try:
                                if os.getpgid(pid) == pid:
                                    os.killpg(pid, signal.SIGTERM)
                            except ProcessLookupError:
                                pass
                if stop_database(directory, project, env):
                    shutil.rmtree(directory)
                else:
                    raise RuntimeError(f"Could not remove abandoned local stack {project}")
        except (BlockingIOError, FileNotFoundError):
            continue


@contextmanager
def session_directory(env):
    directory = Path(tempfile.mkdtemp(prefix=PREFIX))
    project = "jidu-dev-" + uuid.uuid4().hex[:12]
    with (directory / "lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        (directory / "project-id").write_text(project)
        try:
            yield directory, project
        finally:
            if not stop_database(directory, project, env):
                raise RuntimeError(f"Could not remove local stack {project}. Retry with --cleanup")
            shutil.rmtree(directory)


def start(check, cleanup):
    for command in ("docker", "supabase", "pnpm"):
        if not shutil.which(command):
            raise RuntimeError(f"Install {command} for the disposable monitoring stack")
    env = clean_env()
    subprocess.run(["docker", "info", "--format", "{{.ServerVersion}}"], env=env,
                   check=True, timeout=10, stdout=subprocess.DEVNULL)
    reap_abandoned(env)
    if cleanup:
        return
    with session_directory(env) as (directory, project):
        env["WRANGLER_LOG_PATH"] = str(directory / "wrangler-logs")
        env["WRANGLER_SEND_METRICS"] = "false"
        db_ports = open_ports(7)
        worker_port, dashboard_port = db_ports[5:]
        supabase_config(directory, project, db_ports[:5], dashboard_port)
        cli = ["supabase", "--workdir", str(directory)]
        processes = []
        try:
            print("Starting a disposable Supabase instance.", flush=True)
            subprocess.run([*cli, "start"], env=env, check=True, stdout=subprocess.DEVNULL)
            status = json.loads(subprocess.check_output([*cli, "status", "--output", "json"], env=env))
            origin = urlsplit(status["API_URL"])
            if origin.hostname not in {"localhost", "127.0.0.1"} or origin.port != db_ports[0]:
                raise ValueError("Supabase did not report the isolated loopback instance")
            publishable = status.get("PUBLISHABLE_KEY") or status["ANON_KEY"]
            backend = status.get("SECRET_KEY") or status["SERVICE_ROLE_KEY"]
            config = worker_config(db_ports[0], dashboard_port)
            worker_config_file = directory / "wrangler.json"
            worker_env = directory / "worker.env"
            backend_var = "SUPABASE_SECRET_KEY" if backend.startswith("sb_secret_") else "SUPABASE_SERVICE_ROLE_KEY"
            worker_config_file.write_text(json.dumps(config))
            worker_env.write_text(f"{backend_var}={backend}\n")
            worker_env.chmod(0o600)
            worker = subprocess.Popen([
                "pnpm", "--filter", "@nicx/worker", "exec", "wrangler", "dev", "--local",
                "--config", str(worker_config_file), "--env-file", str(worker_env),
                "--ip", "127.0.0.1", "--port", str(worker_port),
                "--persist-to", str(directory / "worker-state"),
            ], cwd=ROOT, env=env, start_new_session=True)
            processes.append(worker)
            publish_processes(directory, processes)
            ready(worker, local_url(worker_port), "/api/v1/health")
            email, password = seed(local_url(db_ports[0]), local_url(worker_port), publishable, backend)
            dashboard = subprocess.Popen([
                "pnpm", "--filter", "@nicx/dashboard", "dev", "--host", "127.0.0.1",
                "--port", str(dashboard_port), "--strictPort",
            ], cwd=ROOT, env={
                **env, "VITE_SUPABASE_URL": local_url(db_ports[0]), "VITE_SUPABASE_ANON_KEY": publishable,
                "VITE_API_URL": local_url(worker_port), "NICX_DEV_ENV_DIR": str(directory),
            }, start_new_session=True)
            processes.append(dashboard)
            publish_processes(directory, processes)
            ready(dashboard, local_url(dashboard_port), "/")
            print("The simulated router sample reached the local owner dashboard data.", flush=True)
            if not check:
                print(f"Dashboard {local_url(dashboard_port)}\nFixture email {email}\nFixture password {password}",
                      flush=True)
                print("Press Ctrl+C to stop and remove this session.", flush=True)
                while all(process.poll() is None for process in processes):
                    time.sleep(0.5)
                raise RuntimeError("A monitoring development service stopped unexpectedly")
        finally:
            for process in reversed(processes):
                stop_process(process)


def interrupted(_signal, _frame):
    raise KeyboardInterrupt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify the sample and stop as soon as the dashboard is ready")
    parser.add_argument("--cleanup", action="store_true", help="Remove abandoned sessions owned by this tool")
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, interrupted)
    try:
        start(args.check, args.cleanup)
    except KeyboardInterrupt:
        return 0
    except (RuntimeError, ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        print(f"Monitoring development stack: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
