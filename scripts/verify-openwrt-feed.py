#!/usr/bin/env python3
"""Verify signed dependency closure in a temporary host APK database; never contacts a router."""
import argparse
from pathlib import Path
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[2] / 'openwrt')
args = parser.parse_args()
source = args.source.resolve()
binary = source / 'staging_dir/host/bin/apk'
feed = source / 'staging_dir/packages/qualcommbe/packages.adb'
key = source / 'public-key.pem'
for item in (binary, feed, key):
    if not item.is_file():
        parser.error(f'Missing {item}; build packages and run make package-index first.')
with tempfile.TemporaryDirectory(prefix='nicx-feed-verification-') as temporary:
    root = Path(temporary, 'root')
    keys = Path(temporary, 'keys')
    root.mkdir()
    keys.mkdir()
    shutil.copyfile(key, keys / 'public-key.pem')
    base = [str(binary), '--root', str(root), '--usermode', '--no-cache', '--repositories-file', '/dev/null', '--keys-dir', str(keys), '--arch', 'aarch64_cortex-a53']
    subprocess.run([*base, '--initdb', 'add'], check=True)
    print('Checking signed dependency archives in a temporary directory without running scripts.', flush=True)
    subprocess.run([*base, '-X', feed.as_uri(), 'add', '--scripts=no', '--commit-hooks=no',
                    'nicx-telemetry', 'luci-app-nicx-telemetry'], check=True)
