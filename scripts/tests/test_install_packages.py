"""Package dashboard transport and read-only router discovery."""

from contextlib import contextmanager
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location("install_packages", SCRIPTS / "install-packages.py")
INSTALLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALLER)


@contextmanager
def fake_connection(*args):
    yield ["ssh"], ["forward"], "root@192.0.2.1"


class PackageInstallerTests(unittest.TestCase):
    @patch.object(INSTALLER, "select_feed")
    @patch.object(INSTALLER, "install_with_feed")
    @patch.object(INSTALLER, "packages")
    @patch.object(INSTALLER, "remote")
    @patch.object(INSTALLER, "router_connection", fake_connection)
    def test_manual_feed_bypasses_github(self, remote, packages, install_with_feed, select):
        remote.return_value = subprocess.CompletedProcess([], 0, INSTALLER.BOARD + "\n")
        packages.return_value = {"kernel": {"version": "6.18.60~matching-r1"}}
        with tempfile.TemporaryDirectory() as temporary:
            local = Path(temporary)
            (local / "packages.adb").write_bytes(b"signed index")
            (local / "htop-1.0-r1.apk").write_bytes(b"signed package")
            def served(*args, **kwargs):
                snapshot = args[4]
                self.assertNotEqual(snapshot, local)
                (local / "packages.adb").write_bytes(b"new index")
                (local / "htop-1.0-r1.apk").write_bytes(b"new package")
                self.assertEqual((snapshot / "packages.adb").read_bytes(), b"signed index")
                self.assertEqual((snapshot / "htop-1.0-r1.apk").read_bytes(), b"signed package")
            install_with_feed.side_effect = served
            INSTALLER.install("192.0.2.1", local, terminal=False, launch_browser=False)
        self.assertFalse(select.called)

    def test_local_feed_rejects_package_replaced_during_snapshot(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "feed"
            source.mkdir()
            (source / "packages.adb").write_bytes(b"fixed index")
            package = source / "htop-1.0-r1.apk"
            package.write_bytes(b"first")
            copy = INSTALLER.shutil.copyfile

            def replace_after_copy(path, destination):
                copy(path, destination)
                if path == package:
                    package.write_bytes(b"other")

            with patch.object(INSTALLER.shutil, "copyfile", side_effect=replace_after_copy):
                with self.assertRaisesRegex(RuntimeError, "changed while copying"):
                    INSTALLER.snapshot_feed(source, root / "snapshot")

    @patch.object(INSTALLER, "download_feed")
    @patch.object(INSTALLER, "select_feed")
    @patch.object(INSTALLER, "install_with_feed")
    @patch.object(INSTALLER, "packages")
    @patch.object(INSTALLER, "remote")
    @patch.object(INSTALLER, "router_connection", fake_connection)
    def test_release_lookup_uses_router_board_kernel_arch_and_trust(self, remote, packages,
                                                                  install_with_feed, select, download):
        remote.side_effect = [
            subprocess.CompletedProcess([], 0, INSTALLER.BOARD + "\n"),
            subprocess.CompletedProcess([], 0, "aarch64_cortex-a53\n"),
            subprocess.CompletedProcess([], 0, "a" * 64 + "  /etc/apk/keys/public-key.pem\n"),
        ]
        packages.return_value = {"kernel": {"version": "6.18.60~matching-r1"}}
        select.return_value.channel = "development"
        select.return_value.tag = "v1.1.0-dev.1.1"
        select.return_value.profile = "gcc-kernel"
        download.return_value = Path("verified")
        INSTALLER.install(
            "192.0.2.1", None, channel="development", terminal=False, launch_browser=False
        )
        identity, channel, profile = select.call_args.args
        self.assertEqual(identity.board, INSTALLER.BOARD)
        self.assertEqual(identity.kernel, "6.18.60~matching-r1")
        self.assertEqual(identity.architecture, "aarch64_cortex-a53")
        self.assertEqual(identity.key_fingerprints, frozenset({"a" * 64}))
        self.assertEqual(channel, "development")
        self.assertIsNone(profile)
        self.assertEqual(install_with_feed.call_args.args[4], Path("verified"))

    @patch("builtins.input", side_effect=["1", "y", "n", "q"])
    @patch.object(INSTALLER, "remote")
    def test_terminal_requires_new_confirmation_if_plan_changes(self, remote, answer):
        remote.side_effect = [
            subprocess.CompletedProcess([], 0, "original plan"),
            subprocess.CompletedProcess([], 0, "updated plan"),
        ]
        INSTALLER.package_menu(["ssh"], ["apk"], {}, {"htop": {"version": "1.0-r1"}})
        self.assertEqual(remote.call_count, 2)
        self.assertTrue(all("--simulate" in call.args[1] for call in remote.call_args_list))

    @patch("builtins.input", side_effect=["1", "y", "q"])
    @patch.object(INSTALLER, "packages")
    @patch.object(INSTALLER, "remote")
    def test_terminal_applies_exact_confirmation_without_discovery_timeout(self, remote, packages, answer):
        remote.side_effect = [
            subprocess.CompletedProcess([], 0, "approved plan"),
            subprocess.CompletedProcess([], 0, "approved plan"),
            subprocess.CompletedProcess([], 0),
        ]
        packages.return_value = {"htop": {"version": "1.0-r1"}}
        INSTALLER.package_menu(["ssh"], ["apk"], {}, {"htop": {"version": "1.0-r1"}})
        self.assertEqual(remote.call_count, 3)
        self.assertIsNone(remote.call_args.kwargs["timeout"])
        self.assertEqual(remote.call_args.args[1], ["apk", "--progress=no", "add", "--", "htop=1.0-r1"])
        self.assertEqual(packages.call_count, 1)


if __name__ == "__main__":
    unittest.main()
