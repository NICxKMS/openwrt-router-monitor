"""Discover and unpack this repository's verified GitHub release feeds."""

from dataclasses import dataclass
import hashlib
import json
import re
import shutil
import tarfile
from urllib.error import HTTPError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


REPO = "NICxKMS/openwrt-jidu6111"
MANIFEST = "release-manifest.json"
MANAGED = "<!-- jidu6111-managed -->"
PENDING = "<!-- jidu6111-publication-pending -->"
VERSION = r"v[0-9]+\.[0-9]+\.[0-9]+"
SHA256 = re.compile(r"[0-9a-f]{64}")
APK_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+~@-]*\.apk")
FEED_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]*\.tar\.gz")
METADATA_LIMIT = 4 * 1024 * 1024
DOWNLOAD_LIMIT = 512 * 1024 * 1024
FEED_LIMIT = 1024 * 1024 * 1024
FILE_LIMIT = 8192


@dataclass(frozen=True)
class RouterIdentity:
    board: str
    architecture: str
    kernel: str
    key_fingerprints: frozenset[str]


@dataclass(frozen=True)
class SelectedFeed:
    channel: str
    tag: str
    profile: str
    asset: str
    size: int
    sha256: str


class GitHubRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        url = urlsplit(newurl)
        host = url.hostname or ""
        if (
            url.scheme != "https" or url.port not in (None, 443) or url.username is not None
            or not (host in ("api.github.com", "github.com") or host.endswith(".githubusercontent.com"))
        ):
            raise RuntimeError("GitHub returned an unexpected release download address.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


urlopen = build_opener(GitHubRedirects()).open


def read_json(url, *, expected_digest=None):
    request = Request(url, headers={"User-Agent": "JIDU6111-Package-Dashboard"})
    with urlopen(request, timeout=30) as response:
        data = response.read(METADATA_LIMIT + 1)
    if len(data) > METADATA_LIMIT:
        raise RuntimeError("GitHub release metadata is too large.")
    if expected_digest is not None and expected_digest != "sha256:" + hashlib.sha256(data).hexdigest():
        raise RuntimeError("Release manifest checksum verification failed.")
    return json.loads(data)


def asset_url(tag, filename):
    return f"https://github.com/{REPO}/releases/download/{quote(tag, safe='')}/{quote(filename, safe='')}"


def managed_release(release, *, development):
    if not isinstance(release, dict) or not isinstance(release.get("published_at"), str):
        return False
    body = release.get("body") or ""
    tag = release.get("tag_name") or ""
    pattern = VERSION + (r"-dev\.[0-9]+\.[0-9]+" if development else "")
    return (
        isinstance(body, str) and MANAGED in body and PENDING not in body
        and isinstance(tag, str) and re.fullmatch(pattern, tag) is not None
        and release.get("draft") is False and release.get("prerelease") is development
    )


def channel_release(channel):
    api = f"https://api.github.com/repos/{REPO}/releases"
    if channel == "stable":
        try:
            release = read_json(f"{api}/latest")
        except HTTPError as error:
            if error.code != 404:
                raise
            return None
        return release if managed_release(release, development=False) else None

    releases = read_json(f"{api}?per_page=100")
    if not isinstance(releases, list):
        raise RuntimeError("GitHub returned an invalid release list.")
    return max(
        (release for release in releases if managed_release(release, development=True)),
        key=lambda release: (release.get("published_at") or "", release["tag_name"]),
        default=None,
    )


def release_manifest(release):
    assets = release.get("assets")
    if not isinstance(assets, list):
        raise RuntimeError("GitHub release is missing its asset list.")
    matches = [asset for asset in assets if isinstance(asset, dict) and asset.get("name") == MANIFEST]
    if len(matches) != 1:
        raise RuntimeError(f"Release {release['tag_name']} is missing its manifest asset.")
    manifest = read_json(asset_url(release["tag_name"], MANIFEST), expected_digest=matches[0].get("digest"))
    if (
        not isinstance(manifest, dict) or type(manifest.get("schema")) is not int or manifest["schema"] != 1
        or not isinstance(manifest.get("assets"), dict) or not isinstance(manifest.get("profiles"), list)
    ):
        raise RuntimeError(f"Release {release['tag_name']} has an unsupported manifest.")
    return manifest


def select_feed(router, channel="auto", profile=None):
    channels = ("stable", "development") if channel == "auto" else (channel,)
    for current in channels:
        release = channel_release(current)
        if release is None:
            continue
        manifest = release_manifest(release)
        compatible = [
            entry for entry in manifest["profiles"] if isinstance(entry, dict)
            and isinstance(entry.get("id"), str) and (profile is None or entry["id"] == profile)
            and entry.get("board") == router.board and entry.get("architecture") == router.architecture
            and entry.get("kernel") == router.kernel
            and isinstance(entry.get("key_sha256"), str) and entry["key_sha256"] in router.key_fingerprints
        ]
        if not compatible:
            continue
        entry = compatible[0]
        filename = entry.get("feed")
        if any(match.get("feed") != filename for match in compatible[1:]):
            raise RuntimeError(f"Multiple {current} feeds match. Choose a profile with --profile.")
        if not isinstance(filename, str) or FEED_NAME.fullmatch(filename) is None:
            raise RuntimeError(f"Release {release['tag_name']} has an invalid package feed asset name.")
        files = [
            asset for asset in release["assets"] if isinstance(asset, dict) and asset.get("name") == filename
        ]
        metadata = manifest["assets"].get(filename)
        if len(files) != 1 or not isinstance(metadata, dict):
            raise RuntimeError(f"Release {release['tag_name']} is missing its {filename} asset.")
        size, digest = metadata.get("size"), metadata.get("sha256")
        if (
            type(size) is not int or not 0 < size <= DOWNLOAD_LIMIT
            or not isinstance(digest, str) or SHA256.fullmatch(digest) is None
            or files[0].get("size", size) != size
            or files[0].get("digest") not in (None, f"sha256:{digest}")
        ):
            raise RuntimeError(f"Release {release['tag_name']} has inconsistent package feed asset metadata.")
        return SelectedFeed(current, release["tag_name"], entry["id"], filename, size, digest)

    raise RuntimeError(
        f"No compatible {'Stable or Development' if channel == 'auto' else channel.title()} feed was found "
        "for this router's board, full kernel package version, architecture and signing key. "
        "Use --feed with a matching local repository if you have one."
    )


def extract_feed(archive, destination):
    destination.mkdir()
    seen = set()
    total = 0
    free = shutil.disk_usage(destination).free
    try:
        with tarfile.open(archive, "r|gz") as files:
            for count, member in enumerate(files, start=1):
                name = member.name.removeprefix("./")
                if count > FILE_LIMIT:
                    raise RuntimeError("Package feed archive contains too many entries.")
                if count == 1 and name in ("", ".") and member.isdir():
                    continue
                if (
                    member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE) or name in seen
                    or (name != "packages.adb" and APK_NAME.fullmatch(name) is None)
                    or member.size <= 0 or member.sparse is not None
                ):
                    raise RuntimeError(f"Package feed archive contains an invalid entry {member.name!r}.")
                total += member.size
                if total > min(free, FEED_LIMIT):
                    raise RuntimeError("The package feed is too large for this computer's temporary workspace.")
                with files.extractfile(member) as source, (destination / name).open("xb") as target:
                    shutil.copyfileobj(source, target)
                seen.add(name)
    except (tarfile.TarError, EOFError) as error:
        raise RuntimeError("The package feed archive is damaged.") from error
    if "packages.adb" not in seen or len(seen) < 2:
        raise RuntimeError("The package feed archive needs packages.adb and at least one APK.")


def download_feed(selection, directory):
    archive = directory / selection.asset
    checksum = hashlib.sha256()
    remaining = selection.size
    if shutil.disk_usage(directory).free < remaining:
        raise RuntimeError("There is insufficient temporary storage to download this package feed.")
    request = Request(
        asset_url(selection.tag, selection.asset), headers={"User-Agent": "JIDU6111-Package-Dashboard"}
    )
    with urlopen(request, timeout=60) as response, archive.open("xb") as target:
        while chunk := response.read(min(1024 * 1024, remaining + 1)):
            remaining -= len(chunk)
            if remaining < 0:
                raise RuntimeError("The package feed download exceeded its expected size.")
            checksum.update(chunk)
            target.write(chunk)
    if remaining or checksum.hexdigest() != selection.sha256:
        raise RuntimeError("The package feed download failed size or checksum verification.")
    feed = directory / "feed"
    extract_feed(archive, feed)
    archive.unlink()
    return feed
