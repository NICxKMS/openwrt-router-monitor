"""Package dashboard transport and read-only router discovery."""

from contextlib import contextmanager
import importlib.util
from pathlib import Path
import subprocess
import sys
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
        INSTALLER.install(
            "192.0.2.1", Path("known-local-feed"), terminal=False, launch_browser=False
        )
        self.assertFalse(select.called)
        self.assertEqual(install_with_feed.call_args.args[4], Path("known-local-feed"))

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


if __name__ == "__main__":
    unittest.main()
