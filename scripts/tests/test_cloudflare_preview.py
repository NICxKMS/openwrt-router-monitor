import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from cloudflare_preview import validate


class CloudflarePreviewTests(unittest.TestCase):
    def test_requires_native_development_preview(self):
        with self.assertRaisesRegex(ValueError, "Development Preview"):
            validate("https://router.nicx.me", "https://abcdefghijklmnopqrst.supabase.co",
                     "https://another-project.supabase.co", "nicx-router-monitor")

    def test_rejects_production_and_non_https_database_urls(self):
        origin = "https://development-nicx-router-monitor.example.workers.dev"
        production = "https://abcdefghijklmnopqrst.supabase.co"
        for database in (production, "http://127.0.0.1:54321", production + "/"):
            with self.subTest(database=database), self.assertRaises(ValueError):
                validate(origin, database, production, "nicx-router-monitor")

    def test_accepts_distinct_preview_project(self):
        validate("https://development-nicx-router-monitor.example.workers.dev",
                 "https://testdevelopment12345.supabase.co", "https://abcdefghijklmnopqrst.supabase.co",
                 "nicx-router-monitor")
