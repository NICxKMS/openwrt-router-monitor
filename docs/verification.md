# Verification evidence

Evidence recorded25 November2026. See the checklist for current deployment/hardware acceptance; local passes do not imply device installation or provider SLA.

## Automated checks

- Shared schema/API/Worker tests: actual validation, modern Supabase secret headers, streamed body caps, authentication separation, redaction, database failure mapping, notification owner isolation, orphan archive cleanup and Worker→actual PostgreSQL integration.
- Database: real embedded PostgreSQL tests for owner RLS/privileged grants, one-use enrollment, atomic dedupe, counter totals, ordering, retention, derived/event/threshold alerts, billing cycles, archive cleanup and budgets. The host-agent fixture test is optional unless `NICX_AGENT_SAMPLE` is set.
- Router:28 native BusyBox ash/awk tests with local OpenWrt host jshn. Includes counter precision near UINT64_MAX, reset detection, critical-admission during storms, immutable retries, asynchronous upload/cleanup, privacy purge, snapshot opt-ins, sparse data, enrollment201, rotation, adaptive hysteresis and critical-upload cooldown.
- Dashboard:24 component/model/data tests, including selected timezone, historical effective time, CSV control characters, paging stability, raw-retention caps, local-only controls and memory categories.
- Browser: desktop1440px and mobile390px tests with explicitly labeled simulated network responses exercise login, navigation, memory/log pages, live pause, chart loading and horizontal overflow. These fixtures are test-only and never inserted into production.
- TypeScript checks, production Vite build and Wrangler dry run.
- Production dependency audit returned zero known vulnerabilities on this date; this is not a guarantee against unknown vulnerabilities.

Commands:

```sh
pnpm preflight
pnpm test
python3 tests/router/export_sample.py > /tmp/nicx-router-sample.json
NICX_AGENT_SAMPLE=/tmp/nicx-router-sample.json pnpm test:database
NICX_BUSYBOX=/path/to/native/busybox pnpm test:router
pnpm typecheck
pnpm build
pnpm exec playwright install chromium
pnpm test:browser
```

On a standard host without the parent OpenWrt staging tools, host-jshn fixture tests explicitly skip; parser/queue tests still run. CI does not claim skipped hardware checks pass. Local build helpers keep Wrangler logs in the project rather than requiring writes to the user's global settings folder.

## OpenWrt package build

Both packages were compiled in the existing AArch64 cortex-a53 community6.18.60 tree using temporary new package links. The initial restricted run hit fakeroot's local-process communication restriction; rerunning with that helper permitted succeeded. A missing LuCI build discovery marker and rules include were corrected, then both full targets built successfully. This did not flash firmware or install packages on the router.

Artifacts are copied into `artifacts/openwrt/` with SHA-256 checksums. They are signed by this workspace's existing build key; verify it matches the installed firmware before installation. Dependencies are not embedded in these two small userspace APKs; use the matching signed feed.

## Hosted database checks

Created a new Free project in Mumbai: `whpnjrdsksgmtzgvaepx`. Applied numbered migrations in sequence. Verified all12 public application tables have RLS, only device_latest is published to Realtime, the diagnostic bucket is private, both scheduled jobs are active, and maintenance ran successfully on the actual hosted database. Initial empty database measured about12.4 MB; no actual router samples are claimed.

Security advisor reported informational missing-policy notices on deliberately service-only deny-by-default relations. These tables have no anon/authenticated grants; adding permissive policies merely to silence that information would weaken the model. Performance advisor's FK indexes were added in a new follow-up migration. Empty-project unused-index information is expected. [Advisor explanations](https://supabase.com/docs/guides/database/database-linter) describe their limits.

Physical-router resource use, hardware acceleration coverage, outage recovery, actual Auth/Realtime/notification flows and provider CPU/bandwidth limits remain measurements to perform, not results to invent.

## Live deployment follow-up

Deployed the real Worker and static assets to https://router.nicx.me. Live smoke confirms HTTPS/security headers and the actual Worker→Supabase authentication path rejects an unissued device token with401, without inserting telemetry. Direct anonymous table/RPC access is denied. The first live check exposed Workers incompatibility with redirect:error; it was corrected to redirect:manual with explicit status rejection and regression coverage. Modern sb_secret keys use apikey only. No privileged credential was printed or stored in the repository.

Final local checks at this stage:54 application/shared/Worker/dashboard tests,19 PostgreSQL integration tests plus1 schema test,28 native BusyBox tests,2 browser flows. Router access is reachable but requires the user to authenticate in their terminal. Both packages are also in the existing combined signed feed. Hosted Auth owner creation, physical installation/enrollment and delivery destinations are still pending.

Hosted owner account creation and disable_signup=true were verified. Supabase's leaked-password protection advisor remains a Free-plan limitation: that provider feature requires Pro; no paid upgrade is introduced. See https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection . Initial package-plan validation exposed missing coreutils-stat output in the combined feed; it was built explicitly and the feed was refreshed and passed an isolated signed38-package install simulation.

Physical-router acceptance progressed: user confirmed both packages installed, LuCI enrollment/Test connection succeeded and dashboard observations appear. Independent hosted query verified one actual device, consumed enrollment code, increasing samples, reset-aware WAN/LAN counters, minute/15-minute/hour/day rollups, one WAN daily total and IPv4/IPv6/gateway/DNS probes. First observed snapshot reported CPU1.854%, usable RAM444272KiB, available RAM156284KiB and49.3°C; these are router-state readings, not measured agent overhead. PSI is reported unavailable on this firmware. A one-shot firewall-service status probe is being corrected after live validation.

## Release 2 hosted acceptance — 2026-11-25

68 application/shared/Worker/dashboard checks, 20 PostgreSQL integration checks plus one schema check, 42 router/host checks, and six desktop/mobile browser checks pass. The router tests also pass using jshn independently built from pinned official libubox source, so fresh-checkout CI does not silently skip the envelope tests. Signed release2 APK dependency closure passed with trusted keys: 38 packages /4498 KiB in an empty simulated database.

Both actual-router packages upgraded from1.0.0-r1 to1.0.0-r2; existing configuration, device credential and privacy salt were checked unchanged without printing their contents. A real memory snapshot progressed from queued to uploaded, and its request UUID matched a stored diagnostic and a durable positive database receipt. The deployed Worker version is recorded in deployment-state.json. This verifies the action path; it does not establish long-term reliability or controlled routing/Wi-Fi impact. Telegram setup was deferred by the owner.

## Pre-merge review validation — 2026-11-25

Independent review identified and corrected six concrete issues: lost form values under disabled controls, stale query exports, potentially destructive cleanup after uncertain archive registration, non-atomic network snapshot reads, alert continuity with slower local/adaptive cadence, and device deletion with active threshold-rule alerts. Regression cases were observed failing before their fixes. Fresh checks pass:74 application tests,27 PostgreSQL integration tests plus1 schema check (host fixture enabled, no skips),46 BusyBox router/host checks,6 desktop/mobile browser checks, typecheck and production build. Both release3 signed APK packages built; an isolated trusted-feed simulation resolved38 packages /4499KiB. This is source/build evidence; deployed release2 and migrations001–006 remain separately recorded.
