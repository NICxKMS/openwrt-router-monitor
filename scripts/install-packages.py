#!/usr/bin/env python3
"""Select and install signed APKs from a matching JIDU6111 release or local feed."""

import argparse
from contextlib import contextmanager
import filecmp
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import ipaddress
import re
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Thread
from urllib.parse import unquote, urlsplit

from package_dashboard import Dashboard, serve_dashboard
from release_feed import APK_NAME, FEED_LIMIT, SHA256, RouterIdentity, download_feed, select_feed


BOARD = "jiorouter,ax6000-jidu6111"
APK = ("apk", "--no-cache", "--repositories-file", "/dev/null")
FEATURED = {
    "luci-app-sqm": "SQM with CAKE",
    "zram-swap": "Compressed swap (zram)",
    "luci-app-adguardhome": "AdGuard Home",
    "luci-app-adblock-fast": "Adblock Fast",
    "luci-app-https-dns-proxy": "Encrypted DNS",
    "luci-app-nlbwmon": "Per-device bandwidth usage",
    "luci-app-statistics": "System graphs",
    "luci-proto-wireguard": "WireGuard",
    "htop": "Process and memory monitor",
}


class FeedHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        name = unquote(urlsplit(self.path).path).removeprefix("/")
        if name != "packages.adb" and APK_NAME.fullmatch(name) is None:
            self.send_error(404)
            return None
        return super().send_head()

    def log_request(self, code="-", size="-"):
        if code != 200:
            super().log_request(code, size)


def remote(ssh, command, *, capture=False, check=True, stderr=None, on_output=None, timeout=90):
    if on_output is not None:
        with subprocess.Popen(
            [*ssh, shlex.join(command)], stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
        ) as process:
            for line in process.stdout:
                on_output(line)
            return process.wait()
    return subprocess.run(
        [*ssh, shlex.join(command)], stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE if capture else None, stderr=stderr, text=True, check=check,
        timeout=timeout,
    )


def packages(ssh, apk, source):
    output = remote(
        ssh, [*apk, "query", "--from", source, "--fields",
              "name,version,description,depends,installed-size,file-size,license,url,arch",
              "--format", "json", "*"], capture=True,
    ).stdout
    return {entry["name"]: entry for entry in json.loads(output)}


def resources(ssh):
    result = {}
    try:
        info = remote(ssh, ["ubus", "call", "system", "info"], capture=True, timeout=10).stdout
        result["memory"] = json.loads(info).get("memory", {})
        output = remote(ssh, ["df", "-Pk", "/overlay"], capture=True, timeout=10).stdout
        values = output.splitlines()[-1].split()
        result["storage"] = {
            "total": int(values[-5]) * 1024,
            "free": int(values[-3]) * 1024,
        }
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        pass
    return result


def package_menu(ssh, apk, installed, available):
    featured = [name for name in FEATURED if name in available]
    choices = featured
    print("\nJIDU6111 package installer")
    while True:
        print()
        for number, name in enumerate(choices, 1):
            description = FEATURED.get(name)
            label = f"{description} ({name})" if description else name
            status = " [installed]" if name in installed else ""
            print(f"  {number:3}. {label}{status}")

        answer = input("\nNumbers to install, /search, m for main menu, q to quit: ").strip()
        if answer.lower() == "q":
            return
        if answer.lower() == "m":
            choices = featured
            continue
        if answer.startswith("/"):
            term = answer[1:].strip().lower()
            matches = sorted(name for name in available if term in name.lower())
            if matches:
                choices = matches
            else:
                print(f"No packages match {term!r}.")
            continue

        numbered_packages = {str(number): name for number, name in enumerate(choices, 1)}
        selections = answer.split()
        if not selections or any(number not in numbered_packages for number in selections):
            print("Enter one or more numbers from the menu, separated by spaces.")
            continue

        selected = dict.fromkeys(numbered_packages[number] for number in selections)
        pending = [name for name in selected if name not in installed]
        if not pending:
            print("Those packages are already installed.")
            continue

        pinned = [f"{name}={available[name]['version']}" for name in pending]
        command = [*apk, "--progress=no"]
        simulate = [*command, "--simulate", "add", "--", *pinned]
        preview = remote(ssh, simulate, capture=True, check=False, stderr=subprocess.STDOUT)
        while True:
            print(f"Preview for {', '.join(pending)}", flush=True)
            print(preview.stdout)
            if preview.returncode:
                print("APK could not resolve the installation.")
                break
            if input("Install these changes? [y/N] ").strip().lower() not in ("y", "yes"):
                break
            fresh = remote(ssh, simulate, capture=True, check=False, stderr=subprocess.STDOUT)
            if fresh.returncode or fresh.stdout != preview.stdout:
                print("The package plan changed. Review the current plan before confirming.")
                preview = fresh
                continue
            try:
                result = remote(ssh, [*command, "add", "--", *pinned], check=False, timeout=None)
                code = result.returncode
            except (OSError, subprocess.SubprocessError):
                code = 255
            if code == 255:
                print("The connection was interrupted. Checking installed package versions before another attempt.")
            try:
                installed = packages(ssh, APK, "installed")
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                raise RuntimeError("Reconnect and check the installed packages before retrying.") from error
            matched = all(installed.get(name, {}).get("version") == available[name]["version"] for name in pending)
            if code in (0, 255) and matched:
                print("The requested package versions are installed.")
            else:
                print("APK did not verify the reviewed changes. Check the output and installed packages.")
            break


def snapshot_feed(source, destination):
    index = source / "packages.adb"
    packages = sorted(path for path in source.iterdir() if APK_NAME.fullmatch(path.name))
    if not index.is_file() or not packages:
        raise RuntimeError(f"No signed package feed in {source}. Use a directory with packages.adb and APK files.")
    paths = [index, *packages]
    if any(not path.is_file() for path in paths):
        raise RuntimeError("The local feed contains an APK that is missing or is not a regular file.")
    size = sum(path.stat().st_size for path in paths)
    if size > min(FEED_LIMIT, shutil.disk_usage(destination.parent).free):
        raise RuntimeError("There is insufficient temporary storage for the local package feed.")
    destination.mkdir()
    for path in paths:
        shutil.copyfile(path, destination / path.name)
    if not filecmp.cmp(index, destination / index.name, shallow=False):
        raise RuntimeError("The local package feed changed while copying. Retry once its build finishes.")
    return destination


@contextmanager
def router_connection(router, workspace):
    address = f"root@{router}"
    ssh_socket = str(workspace / "ssh")
    ssh = ["ssh", "-S", ssh_socket, "-o", "BatchMode=yes", "-T"]
    print(f"Connecting to {address} …", flush=True)
    subprocess.run(
        ["ssh", "-M", "-fN", "-S", ssh_socket, "-o", "ControlPersist=no",
         "-o", "StrictHostKeyChecking=yes", "-o", "ClearAllForwardings=yes",
         "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15",
         "-o", "ServerAliveCountMax=2", "--", address],
        check=True,
    )
    try:
        yield [*ssh, "--", address], [*ssh, "-O", "forward"], address
    finally:
        subprocess.run(
            [*ssh, "-O", "exit", "--", address],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        )


@contextmanager
def served_feed(feed):
    if not (feed / "packages.adb").is_file():
        raise RuntimeError(f"No packages.adb in {feed}. Pass a matching local repository with --feed.")
    handler = partial(FeedHandler, directory=str(feed.resolve()))
    with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield server.server_port
        finally:
            server.shutdown()
            thread.join()


def router_identity(connection, board, kernel):
    architecture = remote(connection, ["cat", "/etc/apk/arch"], capture=True).stdout.strip()
    output = remote(
        connection, ["find", "/etc/apk/keys", "-maxdepth", "1", "-type", "f",
                     "-exec", "sha256sum", "{}", ";"], capture=True,
    ).stdout
    fingerprints = frozenset(
        line.split()[0] for line in output.splitlines() if line.strip() and SHA256.fullmatch(line.split()[0])
    )
    if not architecture or not fingerprints:
        raise RuntimeError("The router's APK architecture or trusted signing keys could not be determined.")
    return RouterIdentity(board, architecture, kernel, fingerprints)


def install_with_feed(connection, forward, address, router, feed, label, identity, installed,
                      *, terminal, launch_browser):
    with served_feed(feed) as feed_port:
        port = subprocess.check_output(
            [*forward, "-R", f"localhost:0:127.0.0.1:{feed_port}", "--", address], text=True,
        ).strip()
        if not port.isascii() or not port.isdecimal() or not 1 <= int(port) <= 65535:
            raise RuntimeError("SSH did not return a usable port for the package feed.")

        feed_apk = [*APK, "-X", f"http://127.0.0.1:{port}/packages.adb"]
        available = packages(connection, feed_apk, "none")
        feed_kernel = available.get("kernel", {})
        if feed_kernel.get("version") != identity.kernel:
            raise RuntimeError(
                f"Kernel mismatch. Router: {identity.kernel}. "
                f"Feed: {feed_kernel.get('version') or 'unknown'}."
            )
        if identity.architecture and feed_kernel.get("arch") != identity.architecture:
            raise RuntimeError(
                f"Architecture mismatch. Router: {identity.architecture}. "
                f"Feed: {feed_kernel.get('arch') or 'unknown'}."
            )
        if terminal:
            package_menu(connection, feed_apk, installed, available)
            return
        serve_dashboard(
            Dashboard(
                router, identity.kernel, installed, available, FEATURED,
                partial(remote, connection), feed_apk,
                partial(packages, connection, APK, "installed"),
                partial(resources, connection), feed_label=label,
            ),
            launch_browser=launch_browser,
        )


def install(router, feed, *, channel="auto", profile=None, terminal, launch_browser):
    with TemporaryDirectory(prefix="jidu6111-", dir="/tmp") as temp:
        workspace = Path(temp)
        with router_connection(router, workspace) as (connection, forward, address):
            board = remote(connection, ["cat", "/tmp/sysinfo/board_name"], capture=True).stdout.strip()
            if board != BOARD:
                raise RuntimeError(f"Expected {BOARD}, but {router} reports {board!r}.")
            installed = packages(connection, APK, "installed")
            kernel = installed.get("kernel", {}).get("version")
            if not kernel:
                raise RuntimeError("The router's full installed kernel package version could not be determined.")

            if feed is None:
                identity = router_identity(connection, board, kernel)
                selection = select_feed(identity, channel, profile)
                label = f"{selection.channel.title()} {selection.tag} · {selection.profile}"
                print(f"Downloading and verifying {label}…", flush=True)
                feed = download_feed(selection, workspace)
            else:
                # APK still checks the local index against the router's trusted keys.
                identity = RouterIdentity(board, "", kernel, frozenset())
                label = "Local signed package feed"
                print(f"Staging signed packages from {feed}", flush=True)
                feed = snapshot_feed(feed, workspace / "feed")
            install_with_feed(
                connection, forward, address, router, feed, label, identity, installed,
                terminal=terminal, launch_browser=launch_browser,
            )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--router", default="192.168.50.1", help="router address (default: %(default)s)")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--feed", type=Path, help="local directory containing signed APKs and packages.adb")
    source.add_argument(
        "--channel", choices=("auto", "stable", "development"), default="auto",
        help="release channel (default: prefer a matching Stable, then Development)",
    )
    parser.add_argument("--profile", help="choose a compiler profile when multiple release feeds match")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--terminal", action="store_true", help="use the numbered terminal menu")
    mode.add_argument("--no-browser", action="store_true", help="print the dashboard URL without opening it")
    args = parser.parse_args()
    if args.feed is not None and args.profile is not None:
        parser.error("--profile selects a GitHub release feed and cannot be combined with --feed.")
    try:
        try:
            ipaddress.ip_address(args.router)
        except ValueError:
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,252}", args.router):
                parser.error("Use an IP address or SSH host name for --router.")
        install(
            args.router, args.feed, channel=args.channel, profile=args.profile,
            terminal=args.terminal, launch_browser=not args.no_browser,
        )
    except (EOFError, KeyboardInterrupt):
        print()
        return 130
    except (OSError, RuntimeError, subprocess.SubprocessError, ValueError) as error:
        print(f"Package installer: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
