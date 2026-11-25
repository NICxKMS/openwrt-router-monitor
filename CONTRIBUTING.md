# Contributing

Work from a short-lived `codex/…`, `feat/…` or `fix/…` branch and open a pull request against `main`. Keep commits focused, describe the user-visible behavior, and include relevant verification. Preserve unrelated firmware workspace edits. Never commit `.env.local`, Worker secrets, router credentials, private diagnostics, build trees or package binaries.

From this directory, run `pnpm install --frozen-lockfile`, `pnpm preflight`, `pnpm test`, `pnpm typecheck`, `pnpm test:database`, `pnpm test:router` and `pnpm build`. Browser checks use `pnpm exec playwright install chromium` then `pnpm test:browser`. CI additionally builds the pinned native OpenWrt JSON helper, runs the BusyBox tests and ingests a host-generated fixture into its local test database. Fixture data never goes to production.

For standalone router tests on Ubuntu, install `build-essential cmake pkg-config libjson-c-dev busybox-static`, run `sh scripts/build-test-jshn.sh "$PWD/.test-tools"`, and set `NICX_TEST_STAGING="$PWD/.test-tools" NICX_BUSYBOX=/usr/bin/busybox` when running tests. A matching parent OpenWrt host staging directory is also supported. Skipped tests are not evidence that router behavior passed.

Add new SQL migrations; never edit an applied migration. Test authorization, replay behavior and retention when changing ingestion. Represent unavailable measurements as null or absent and keep raw credentials out of fixtures and errors. Router changes must keep buffers and operations bounded and must never alter normal forwarding services.

Update `CHANGELOG.md`, relevant documentation and the acceptance checklist for behavioral changes. Increase `PKG_RELEASE` in both OpenWrt Makefiles for package updates; increase `PKG_VERSION` for upstream package versions. Do not reuse an already published package version with different contents. Tag reviewed releases as `monitor-vX.Y.Z`; record APK checksums and the source commit in release notes. Store signed APKs as release assets rather than Git blobs.

Deployment uses a separate manual workflow after verification. Build variables are browser-safe; privileged runtime keys stay in Cloudflare. Review database migrations explicitly before hosted application. Roll back the Worker and package release separately; avoid destructive schema rollback.
