import argparse
from dataclasses import dataclass
import re

NUMBER = r"(?:0|[1-9][0-9]*)"
TAG = re.compile(rf"v({NUMBER})\.({NUMBER})\.({NUMBER})(?:-beta\.([1-9][0-9]*))?")


@dataclass(frozen=True)
class ReleaseVersion:
    version: str
    series: str
    beta: str | None

    @classmethod
    def parse(cls, tag: str) -> "ReleaseVersion":
        match = TAG.fullmatch(tag)
        if match is None:
            raise ValueError("Expected vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-beta.N")
        major, minor, patch, beta = match.groups()
        return cls(f"{major}.{minor}.{patch}", f"{major}.{minor}", beta)

    @property
    def channel(self) -> str:
        return "stable" if self.beta is None else "beta"

    @property
    def apk_version(self) -> str:
        suffix = "" if self.beta is None else f"_beta{self.beta}"
        return f"{self.version}{suffix}-r1"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Print the OpenWrt APK version for a monitor release tag.")
    parser.add_argument("tag")
    args = parser.parse_args()
    try:
        print(ReleaseVersion.parse(args.tag).apk_version)
    except ValueError as error:
        parser.error(str(error))
