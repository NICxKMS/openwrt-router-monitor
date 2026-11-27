import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

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
