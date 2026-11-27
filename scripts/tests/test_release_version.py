import unittest

from scripts.release_version import ReleaseVersion


class ReleaseVersionTests(unittest.TestCase):
    def test_stable_and_beta_share_a_compatibility_series(self):
        stable = ReleaseVersion.parse("v1.12.3")
        beta = ReleaseVersion.parse("v1.12.3-beta.24")
        self.assertEqual(stable.series, "1.12")
        self.assertEqual(beta.series, stable.series)
        self.assertEqual(stable.channel, "stable")
        self.assertEqual(beta.channel, "beta")
        self.assertEqual(stable.apk_version, "1.12.3-r1")
        self.assertEqual(beta.apk_version, "1.12.3_beta24-r1")

    def test_rejects_versions_outside_the_two_channels(self):
        for tag in ("1.2.3", "v01.2.3", "v1.2.3-beta.0", "v1.2.3-beta.01",
                    "v1.2.3-rc.1", "v1.2.3+r1", "v1.2.3\n"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                ReleaseVersion.parse(tag)
