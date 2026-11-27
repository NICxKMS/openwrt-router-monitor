# Monitor releases

`main` is the protected integration branch. Use pull requests and isolated worktrees. Stable uses GitHub releases tagged `vMAJOR.MINOR.PATCH`. Beta uses GitHub prereleases tagged `vMAJOR.MINOR.PATCH-beta.N`. Publish from an exact commit. For an older supported series, branch temporarily from its Stable tag, verify the maintenance patch, and forward-port applicable fixes to `main`.

Every official release carries both monitor APKs and the dashboard and Worker built from the same commit. The version is shared across both components. Matching `MAJOR.MINOR` identifies the compatibility series. PATCH requires verified mutual compatibility, including the telemetry protocol, database schema and router capabilities. Use a new series for a coordinated upgrade. GitHub Latest is for release discovery. Production eligibility also requires verified compatibility with the installed router package.

Use GitHub draft releases to assemble and verify assets before publication. Keep historical Stable releases and one active verified Beta. Keep superseded Beta releases while they are needed for an active deployment, promotion or recovery. GitHub release immutability prevents asset replacement and tag reuse, including reuse after an immutable release is deleted.

## Build inputs

Both OpenWrt recipes accept the same explicit `NICX_MONITOR_RELEASE_VERSION` for standalone release builds. In a disposable, prepared OpenWrt APK SDK, follow the [recipe setup](router.md#build-the-two-packages), then pass the mapped version as the environment variable:

```sh
SDK=/absolute/path/to/prepared-openwrt-sdk
tag=v1.0.1-beta.1
apk_version=$(python3 -B scripts/release_version.py "$tag") &&
  NICX_MONITOR_RELEASE_VERSION="${apk_version%-r1}" make -C "$SDK" \
  package/nicx-telemetry/compile package/luci-app-nicx-telemetry/compile
```

Stable `v1.0.1` maps to `1.0.1-r1`, Beta `v1.0.1-beta.1` to `1.0.1_beta1-r1`. Start above `1.0.0` when replacing legacy `1.0.0-rN` packages. Existing pinned firmware feed builds use their recipe defaults. Before an official release, use actual APK tooling to verify ordering, signatures, dependencies and installation on the supported platform.

Build the web archive from the same clean checkout. Set `VITE_SUPABASE_ANON_KEY` to the target project's browser publishable key and choose an output directory outside the checkout.

```sh
OUTPUT=/absolute/path/to/monitor-release-output
mkdir -p "$OUTPUT" &&
  python3 -B scripts/monitor-bundle.py build "$OUTPUT/monitor-bundle.tar.gz" \
  --source-commit "$(git rev-parse HEAD)" --channel beta
```

Use `--channel stable` for Production assets. The command only builds. The archive contains the Worker code, static files and source commit.

## Environment and cutover status

Wrangler defines Production at `router.nicx.me` and Beta at `router-beta.nicx.me` with separate Supabase project references. Set the Beta Worker runtime `SUPABASE_SECRET_KEY` using the Beta project. Build its browser assets with that project's publishable key. Keep Production credentials in Production. Temporary PR Previews belong under the Beta Worker, with test data and Cloudflare Access before sharing private content.

The previous Production workflow was disabled and depended on firmware draft metadata and a helper absent in this repository. Standalone publication and Production automation remain pending until signed package verification, authenticated installed-package evidence and the compatibility gate are tested together. A health response alone does not establish which package is installed or whether telemetry is being accepted.

Before the first Stable release, capture the installed APK versions, a fresh accepted telemetry sample from the same router, the actual Worker version and database migration history. Verify the recovery artifacts against the installed router and retain them. Resolve the live Worker source provenance before treating it as a verified Stable baseline. Keep existing production data and deployment in place while verifying that baseline.
