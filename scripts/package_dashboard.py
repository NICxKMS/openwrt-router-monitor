"""Serve the package dashboard over a private, local browser session."""

from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
from pathlib import Path
import secrets
import shutil
import subprocess
from threading import Lock, Thread
import time
import webbrowser


ASSETS = Path(__file__).with_name("package-dashboard")
PAGES = {
    "/": ("index.html", "text/html"),
    "/dashboard.css": ("dashboard.css", "text/css"),
    "/dashboard.js": ("dashboard.js", "text/javascript"),
}


class Dashboard:
    def __init__(self, router, kernel, installed, available, featured, remote, apk, refresh, resources,
                 *, feed_label="Signed package feed"):
        self.router = router
        self.kernel = kernel
        self.feed_label = feed_label
        self.installed = installed
        self.available = available
        self.featured = featured
        self.remote = remote
        self.apk = apk
        self.refresh = refresh
        self.resources = resources
        self.metrics = resources()
        self.checked_at = time.time()
        self.connected = True
        self.preview = None
        self.closing = False
        self.lock = Lock()
        self.state_lock = Lock()
        self.job = None
        self.update_versions = None
        self.updates = set()
        self.refresh_updates()

    def refresh_updates(self):
        versions = {
            name: (package["version"], self.available[name]["version"])
            for name, package in self.installed.items()
            if name != "kernel" and name in self.available and package["version"] != self.available[name]["version"]
        }
        if versions == self.update_versions:
            return
        self.updates = set()
        self.update_versions = None
        if versions:
            # Compare the installed/feed pairs in one read-only SSH command.
            compare = 'while [ "$#" -ge 2 ]; do apk version --test -- "$1" "$2" || exit; shift 2; done'
            arguments = [version for pair in versions.values() for version in pair]
            try:
                result = self.remote(
                    ["sh", "-c", compare, "apk-versions", *arguments],
                    capture=True, check=False, stderr=subprocess.STDOUT,
                )
            except (OSError, subprocess.SubprocessError):
                return
            comparisons = result.stdout.splitlines()
            if result.returncode or len(comparisons) != len(versions) or set(comparisons) - {"<", "=", ">"}:
                return
            self.updates = {name for name, order in zip(versions, comparisons) if order == "<"}
        self.update_versions = versions

    def catalog(self):
        entries = self.available | {
            name: entry for name, entry in self.installed.items() if name not in self.available
        }
        return {
            "router": self.router,
            "kernel": self.kernel,
            "feed_label": self.feed_label,
            "resources": self.metrics,
            "checked_at": self.checked_at,
            "connected": self.connected,
            "job": self.job_status(),
            "packages": [
                {
                    "name": name,
                    "version": entry["version"],
                    "description": entry.get("description", ""),
                    "installed": self.installed.get(name, {}).get("version"),
                    "title": self.featured.get(name),
                    "available": name in self.available,
                    "update_available": name in self.updates,
                    "size": entry.get("installed-size"),
                    "download": entry.get("file-size", 0),
                    "depends": entry.get("depends", []),
                    "license": entry.get("license", ""),
                    "url": entry.get("url", ""),
                    "arch": entry.get("arch", ""),
                }
                for name, entry in sorted(entries.items())
            ],
        }

    def sync(self):
        self.installed = self.refresh()
        self.connected = True
        self.metrics = self.resources()
        self.checked_at = time.time()
        if self.installed.get("kernel", {}).get("version") != self.kernel:
            raise RuntimeError("The router firmware changed. Restart the installer with its matching feed.")
        self.refresh_updates()

    def transaction(self, names, *, simulate):
        options = ["--simulate"] if simulate else []
        pinned = [f"{name}={self.available[name]['version']}" for name in names]
        return self.remote(
            [*self.apk, "--progress=no", *options, "add", "--", *pinned],
            capture=True, check=False, stderr=subprocess.STDOUT,
        )

    def has_space(self, size):
        free = self.metrics.get("storage", {}).get("free")
        return free is None or size <= free

    def review(self, payload):
        self.preview = None
        names = payload.get("names")
        upgrade = payload.get("upgrade", False)
        if (
            not isinstance(upgrade, bool) or not isinstance(names, list)
            or not names or len(names) > len(self.available)
            or any(not isinstance(name, str) or name not in self.available for name in names)
        ):
            return 400, {"message": "Choose packages from the signed feed."}
        if upgrade and (len(names) != 1 or names[0] == "kernel"):
            return 400, {"message": "Choose one installed package to update."}
        self.sync()
        if upgrade:
            if names[0] not in self.installed:
                return 400, {"message": "Choose one installed package to update."}
            if names[0] not in self.updates:
                return 400, {"message": "This signed feed has no newer version of the selected package."}
        else:
            names = list(dict.fromkeys(name for name in names if name not in self.installed))
            if not names:
                return 400, {"message": "Those packages are already installed."}
        result = self.transaction(names, simulate=True)
        if result.returncode:
            return 422, {"message": "APK could not resolve these packages.", "output": result.stdout}
        preview_id = secrets.token_urlsafe(18)
        changes = []
        for action, name in re.findall(r"^\(\s*\d+/\s*\d+\) (\w+) (\S+)", result.stdout, re.MULTILINE):
            entry = self.available.get(name, {})
            changes.append({
                "action": action, "name": name, "version": entry.get("version"),
                "requested": name in names, "size": entry.get("installed-size", 0),
            })
        if upgrade and (
            not any(change["name"] == names[0] and change["action"] == "Upgrading" for change in changes)
            or any(change["name"] == "kernel" or change["action"] not in {"Installing", "Upgrading"}
                   for change in changes)
        ):
            return 422, {"message": "APK could not plan this update without other unexpected changes.",
                         "output": result.stdout}
        size = sum(change["size"] for change in changes if change["action"] in {"Installing", "Upgrading"})
        if not self.has_space(size):
            return 422, {"message": "The selected packages exceed the router's free storage."}
        self.preview = {
            "size": size, "upgrade": upgrade,
            "id": preview_id, "names": names, "output": result.stdout,
            "snapshot": self.installed.copy(),
        }
        return 200, {
            "id": preview_id, "names": names, "output": result.stdout, "changes": changes,
            "size": size,
            "storage": self.metrics.get("storage"), "catalog": self.catalog(),
        }

    def install(self, payload):
        if not self.preview or self.preview["id"] != payload.get("id"):
            return 409, {"message": "Review the packages again to get a current installation plan."}
        preview = self.preview
        self.preview = None
        self.sync()
        if self.installed != preview["snapshot"]:
            return 409, {"message": "Packages on the router changed. Review the queue again."}
        if not self.has_space(preview["size"]):
            return 409, {"message": "The selected packages exceed the router's current free storage."}
        result = self.transaction(preview["names"], simulate=True)
        if result.returncode or result.stdout != preview["output"]:
            return 409, {"message": "The installation plan changed. Review the queue again."}
        with self.state_lock:
            self.job = {
                "id": secrets.token_urlsafe(12), "state": "running", "output": "",
                "names": preview["names"], "started": time.time(), "success": None,
                "preview_id": preview["id"], "apk_exit": None,
                "versions": {name: self.available[name]["version"] for name in preview["names"]},
                "upgrade": preview["upgrade"],
                "message": "Updating the selected package…" if preview["upgrade"] else "Installing packages on the router…",
            }
        Thread(target=self.run_install, args=(preview["names"],), daemon=True).start()
        return 202, self.job_status()

    def job_status(self):
        with self.state_lock:
            return dict(self.job) if self.job else None

    def append_output(self, line):
        with self.state_lock:
            self.job["output"] = (self.job["output"] + line)[-262144:]

    def reconcile_inventory(self):
        # Called with state_lock held after a successful installed-package read.
        job = self.job
        matched = all(self.installed.get(name, {}).get("version") == version
                      for name, version in job["versions"].items())
        success = matched and job["apk_exit"] in (None, 0)
        if success:
            message = "Package updated." if job["upgrade"] else "Packages installed."
        elif job["apk_exit"] not in (None, 0):
            message = "APK reported an error during the reviewed changes. Check the log."
        else:
            message = "The router does not report all the requested package versions."
        job.update(state="finished", success=success, message=message)

    def run_install(self, names):
        code = None
        verified = False
        try:
            pinned = [f"{name}={self.available[name]['version']}" for name in names]
            result = self.remote(
                [*self.apk, "--progress=no", "add", "--", *pinned],
                on_output=self.append_output,
            )
            code = None if result == 255 else result
            self.sync()
            verified = True
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            self.connected = False
            self.append_output(f"\n{error}\n")
        with self.state_lock:
            self.job.update(apk_exit=code, finished=time.time())
            if verified:
                self.reconcile_inventory()
            elif code not in (None, 0):
                self.job.update(
                    state="finished", success=False,
                    message="APK reported an error. Select Refresh to check the installed packages.",
                )
            else:
                self.job.update(
                    state="unverified", success=None,
                    message="The result is unverified. Select Refresh to check the installed package versions.",
                )

    def busy(self):
        job = self.job_status()
        return job and job["state"] == "running"

    def refresh_catalog(self):
        try:
            self.sync()
        except (OSError, ValueError, subprocess.SubprocessError):
            self.connected = False
            return 503, {"message": "The router could not be reached. Check its connection, then try Refresh."}
        with self.state_lock:
            if self.job and self.job["state"] == "unverified":
                self.reconcile_inventory()
        return 200, self.catalog()


class RequestHandler(BaseHTTPRequestHandler):
    def __init__(self, *args, dashboard, token, **kwargs):
        self.dashboard = dashboard
        self.token = token
        super().__init__(*args, **kwargs)

    def log_message(self, fmt, *args):
        pass

    def respond(self, status, data, mime):
        self.send_response(status)
        self.send_header("Content-Type", f"{mime}; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'none'; script-src 'self'; style-src 'self'; "
            "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        )
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def json_response(self, status, data):
        self.respond(status, json.dumps(data).encode(), "application/json")

    def local_host(self):
        return self.headers.get("Host") == f"127.0.0.1:{self.server.server_port}"

    def authorize(self):
        auth = self.headers.get("Authorization", "").encode("latin-1")
        if self.local_host() and secrets.compare_digest(auth, f"Bearer {self.token}".encode()):
            return True
        self.json_response(403, {"message": "Open the dashboard link printed in WSL."})
        return False

    def do_GET(self):
        page = PAGES.get(self.path)
        if page and self.local_host():
            name, mime = page
            self.respond(200, (ASSETS / name).read_bytes(), mime)
        elif self.path == "/api/catalog":
            if self.authorize():
                self.json_response(200, self.dashboard.catalog())
        elif self.path == "/api/job":
            if self.authorize():
                self.json_response(200, self.dashboard.job_status())
        else:
            self.json_response(404, {"message": "Page not found."})

    def do_POST(self):
        if not self.authorize():
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if self.headers.get_content_type() != "application/json" or not 0 < length <= 32768:
                raise ValueError()
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError()
        except ValueError:
            self.json_response(400, {"message": "Invalid request."})
            return

        dashboard = self.dashboard
        if not dashboard.lock.acquire(blocking=False):
            self.json_response(409, {"message": "Another operation is in progress."})
            return
        try:
            if dashboard.closing:
                self.json_response(409, {"message": "The installer is closing."})
            elif dashboard.busy():
                self.json_response(409, {"message": "An installation is running. Wait for it to finish."})
            elif self.path == "/api/preview":
                self.json_response(*dashboard.review(payload))
            elif self.path == "/api/install":
                self.json_response(*dashboard.install(payload))
            elif self.path == "/api/refresh":
                self.json_response(*dashboard.refresh_catalog())
            elif self.path == "/api/close":
                dashboard.closing = True
                self.json_response(200, {"message": "Session closed."})
                Thread(target=self.server.shutdown, daemon=True).start()
            else:
                self.json_response(404, {"message": "Action not found."})
        except RuntimeError as error:
            self.json_response(409, {"message": str(error)})
        except (OSError, ValueError, subprocess.SubprocessError):
            dashboard.connected = False
            self.json_response(503, {"message": "The router could not be reached. Check the WSL terminal and try Refresh."})
        finally:
            dashboard.lock.release()


def open_dashboard(url):
    opener = shutil.which("wslview") or shutil.which("explorer.exe")
    try:
        if opener:
            subprocess.Popen([opener, url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            webbrowser.open(url)
    except (OSError, webbrowser.Error):
        pass


def serve_dashboard(dashboard, *, launch_browser):
    token = secrets.token_urlsafe(24)
    handler = partial(RequestHandler, dashboard=dashboard, token=token)
    with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
        url = f"http://127.0.0.1:{server.server_port}/#{token}"
        print(f"\nOpen the package dashboard: {url}", flush=True)
        print("Keep this terminal open while installing packages.", flush=True)
        if launch_browser:
            Thread(target=open_dashboard, args=(url,), daemon=True).start()
        try:
            server.serve_forever()
        finally:
            with dashboard.lock:
                dashboard.closing = True
            # Also wait for installs admitted just before Ctrl+C.
            if dashboard.busy():
                print("Finishing the active installation before closing…", flush=True)
            while dashboard.busy():
                time.sleep(0.25)
