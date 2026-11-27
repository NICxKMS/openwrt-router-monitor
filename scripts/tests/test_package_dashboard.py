"""Package review rejects known insufficient router storage."""

from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from package_dashboard import Dashboard


class PackageDashboardTests(unittest.TestCase):
    def setUp(self):
        self.installed = {"kernel": {"version": "6.18.60~test-r1"}}
        self.available = {"htop": {"version": "1.0-r1", "installed-size": 100}}
        self.free = 100
        self.remote_calls = []
        self.comparison = "<"
        self.batch_output = None
        self.plan = "(1/1) Installing htop (1.0-r1)\n"
        self.dashboard = Dashboard(
            "192.0.2.1", self.installed["kernel"]["version"], self.installed,
            self.available, {}, self.remote, ["apk"], lambda: self.installed,
            lambda: {"storage": {"free": self.free}},
        )

    def remote(self, args, **kwargs):
        self.remote_calls.append(args)
        if args[0] == "sh":
            output = self.batch_output if self.batch_output is not None else self.comparison + "\n"
        else:
            output = self.comparison + "\n" if "version" in args else self.plan
        return subprocess.CompletedProcess(args, 0, output)

    def test_catalog_labels_only_native_newer_versions_with_one_router_command(self):
        self.installed.update({
            "htop": {"version": "0.9-r1"},
            "nano": {"version": "2.0-r1"},
            "curl": {"version": "1.0-r1"},
        })
        self.available.update({
            "nano": {"version": "1.0-r1"},
            "curl": {"version": "1.0-r1"},
        })
        self.batch_output = "<\n>\n"
        self.dashboard.sync()
        status = {pkg["name"]: pkg["update_available"] for pkg in self.dashboard.catalog()["packages"]}
        self.assertEqual(status, {"curl": False, "htop": True, "kernel": False, "nano": False})
        self.assertEqual(len(self.remote_calls), 1)
        self.assertIn("apk version --test", self.remote_calls[0][2])
        self.assertEqual(self.remote_calls[0][-4:], ["0.9-r1", "1.0-r1", "2.0-r1", "1.0-r1"])
        self.dashboard.sync()
        self.assertEqual(len(self.remote_calls), 1)

    def test_catalog_does_not_offer_updates_when_native_comparison_is_incomplete(self):
        self.installed["htop"] = {"version": "0.9-r1"}
        self.batch_output = "unexpected\n"
        self.dashboard.sync()
        htop = next(pkg for pkg in self.dashboard.catalog()["packages"] if pkg["name"] == "htop")
        self.assertFalse(htop["update_available"])

    def test_rejects_preview_when_package_will_not_fit(self):
        self.free = 99
        status, body = self.dashboard.review({"names": ["htop"]})
        self.assertEqual(status, 422)
        self.assertIn("storage", body["message"])
        self.assertIsNone(self.dashboard.preview)

    def test_rechecks_free_storage_before_install(self):
        status, body = self.dashboard.review({"names": ["htop"]})
        self.assertEqual(status, 200)
        self.free = 50
        status, body = self.dashboard.install({"id": body["id"]})
        self.assertEqual(status, 409)
        self.assertIn("storage", body["message"])
        self.assertTrue(all("--simulate" in call for call in self.remote_calls))

    def test_explicit_upgrade_reviews_a_single_pinned_newer_version(self):
        self.installed["htop"] = {"version": "0.9-r1"}
        self.plan = "(1/1) Upgrading htop (0.9-r1 -> 1.0-r1)\n"
        status, body = self.dashboard.review({"names": ["htop"], "upgrade": True})
        self.assertEqual(status, 200)
        self.assertEqual(body["changes"][0]["action"], "Upgrading")
        self.assertEqual(body["size"], 100)
        self.assertEqual(self.remote_calls[0][-2:], ["0.9-r1", "1.0-r1"])
        self.assertEqual(self.remote_calls[1][-1], "htop=1.0-r1")
        self.assertIn("--simulate", self.remote_calls[1])

    def test_upgrade_rejects_older_feed_version_before_transaction(self):
        self.installed["htop"] = {"version": "2.0-r1"}
        self.comparison = ">"
        status, body = self.dashboard.review({"names": ["htop"], "upgrade": True})
        self.assertEqual(status, 400)
        self.assertIn("newer", body["message"])
        self.assertEqual(len(self.remote_calls), 1)
        self.assertIsNone(self.dashboard.preview)

    def test_upgrade_rejects_a_multi_package_request(self):
        self.installed["htop"] = {"version": "0.9-r1"}
        self.available["nano"] = {"version": "1.0-r1"}
        status, body = self.dashboard.review({"names": ["htop", "nano"], "upgrade": True})
        self.assertEqual(status, 400)
        self.assertEqual(self.remote_calls, [])

    def test_upgrade_rejects_unexpected_rollback_or_removal(self):
        self.installed["htop"] = {"version": "0.9-r1"}
        for action in ("Purging", "Downgrading"):
            with self.subTest(action=action):
                self.plan = f"(1/2) {action} dependency (2.0-r1)\n(2/2) Upgrading htop (0.9-r1 -> 1.0-r1)\n"
                status, body = self.dashboard.review({"names": ["htop"], "upgrade": True})
                self.assertEqual(status, 422)
                self.assertIsNone(self.dashboard.preview)

    def test_successful_apk_is_unverified_until_inventory_can_be_read(self):
        status, preview = self.dashboard.review({"names": ["htop"]})
        self.assertEqual(status, 200)
        current = {"kernel": self.installed["kernel"], "htop": {"version": "1.0-r1"}}
        first = True
        installed_calls = []

        def inventory():
            nonlocal first
            if first:
                first = False
                return self.installed
            if len(installed_calls) == 1:
                raise subprocess.TimeoutExpired("ssh", 90)
            return current

        def remote(args, **kwargs):
            if "on_output" in kwargs:
                installed_calls.append(args)
                return 0
            return self.remote(args, **kwargs)

        self.dashboard.refresh = inventory
        self.dashboard.remote = remote
        with patch("package_dashboard.Thread", side_effect=lambda target, args, daemon:
                   SimpleNamespace(start=lambda: target(*args))):
            status, job = self.dashboard.install({"id": preview["id"]})
        self.assertEqual(status, 202)
        self.assertEqual(job["preview_id"], preview["id"])
        self.assertEqual(job["apk_exit"], 0)
        self.assertEqual(job["state"], "unverified")
        self.assertIsNone(job["success"])

        self.dashboard.refresh = lambda: current
        status, catalog = self.dashboard.refresh_catalog()
        self.assertEqual(status, 200)
        self.assertEqual(catalog["job"]["state"], "finished")
        self.assertTrue(catalog["job"]["success"])
        self.assertEqual(len(installed_calls), 1)


if __name__ == "__main__":
    unittest.main()
