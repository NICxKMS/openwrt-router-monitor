import importlib.util
import io
import json
import os
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

module_path = Path(__file__).resolve().parents[1] / "monitor-bundle.py"
spec = importlib.util.spec_from_file_location("monitor_bundle", module_path)
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class MonitorBundleTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.archive = self.root / "monitor-bundle.tar.gz"
        self.destination = self.root / "extracted"
        self.revision = "a" * 40

    def make_archive(self, extra=()):
        members = [
            ("bundle.json", json.dumps({"source_commit": self.revision}).encode()),
            ("worker.js", b"export default {};"),
            ("dashboard/index.html", b"index"),
            *extra,
        ]
        with tarfile.open(self.archive, "w:gz") as archive:
            for name, content in members:
                info = tarfile.TarInfo(name)
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))

    def test_build_drops_ambient_tools_and_cloud_credentials(self):
        with patch.dict(os.environ, {"PATH": "/usr/bin", "GH_TOKEN": "gh", "GITHUB_TOKEN": "github",
                                    "AWS_ACCESS_KEY_ID": "aws", "HOME": "/host-home",
                                    "NODE_OPTIONS": "--require=untrusted.js"}, clear=True):
            env = bundle.build_environment(self.root, "https://fixture.supabase.co", "public-fixture")
        self.assertEqual(env["PATH"], "/usr/bin")
        self.assertEqual(env["HOME"], str(self.root))
        self.assertEqual(env["VITE_SUPABASE_ANON_KEY"], "public-fixture")
        self.assertFalse({"GH_TOKEN", "GITHUB_TOKEN", "AWS_ACCESS_KEY_ID", "NODE_OPTIONS"} & env.keys())

    def test_beta_refuses_to_build_against_the_production_database(self):
        production = {"SUPABASE_URL": "https://production.supabase.co"}
        config = {"vars": production, "env": {"beta": {"vars": production}}}
        with self.assertRaisesRegex(ValueError, "distinct"):
            bundle.database_for_build(config, "beta")

    def test_pack_and_unpack_use_the_same_archive_limits(self):
        worker = self.root / "worker.js"
        dashboard = self.root / "dashboard"
        dashboard.mkdir()
        worker.write_bytes(b"worker")
        (dashboard / "index.html").write_bytes(b"dashboard")
        limit = worker.stat().st_size + (dashboard / "index.html").stat().st_size + len(
            json.dumps({"source_commit": self.revision}, sort_keys=True).encode()
        )
        with patch.object(bundle, "MAX_MEMBERS", 3, create=True), patch.object(bundle, "MAX_BYTES", limit):
            bundle.pack(self.archive, worker, dashboard, self.revision)
            bundle.unpack(self.archive, self.destination, self.revision)
            self.archive.unlink()
            (dashboard / "index.html").write_bytes(b"dashboard!")
            with self.assertRaisesRegex(ValueError, "size"):
                bundle.pack(self.archive, worker, dashboard, self.revision)
            self.assertFalse(self.archive.exists())
            (dashboard / "index.html").write_bytes(b"dashboard")
            (dashboard / "too-many.txt").touch()
            with self.assertRaisesRegex(ValueError, "file count"):
                bundle.pack(self.archive, worker, dashboard, self.revision)
            self.assertFalse(self.archive.exists())

    def test_extraction_validates_source(self):
        self.make_archive()
        bundle.unpack(self.archive, self.destination, self.revision)
        self.assertTrue((self.destination / "worker.js").is_file())
        with self.assertRaisesRegex(ValueError, "source"):
            bundle.unpack(self.archive, self.root / "bad-source", "0" * 40)

    def test_extraction_rejects_archive_paths_and_duplicates(self):
        for name in ("dashboard/../worker.js", "/dashboard/file.js", "worker.js", "unknown"):
            with self.subTest(name=name):
                self.make_archive([(name, b"bad")])
                with self.assertRaises(ValueError):
                    bundle.unpack(self.archive, self.destination, self.revision)
                self.assertFalse(self.destination.exists())


if __name__ == "__main__":
    unittest.main()
