# Implementation and acceptance checklist

Statuses describe evidence, not intent. A checked implementation item does not imply cloud or hardware acceptance.

- [x] Phase 1: inspect workspace, review official cloud limits and local firmware source, record architecture.
- [x] Phase 2: workspace, shared schema and semantic utilities, schema tests.
- [x] Phase 3: migrations, enrollment/credential RPCs, RLS, historical queries, PostgreSQL tests.
- [x] Phase 4: Worker ingestion, management, validation, rate limits, errors, tests.
- [x] Phase 5: installable shell agent, bounded queue, TLS, procd, fixture tests.
- [x] Phase 6: local and actual-router ingestion through Worker/PostgreSQL/dashboard confirmed.
- [ ] Phase 7: modular capability-aware collectors and diagnostics.
- [x] Phase 8: authenticated responsive dashboard, all requested sections, historical queries, exports, Realtime/polling.
- [ ] Phase 9: log pipeline, rollups/retention, cloud alert evaluation and notifications.
- [x] Phase 10: OpenWrt Makefiles, LuCI controls, rpcd ACLs, build verification.
- [ ] Phase 11: security review, automated checks, host measurements, actual-router benchmark harness.
- [x] Phase 12: deployment automation, CI, reproducible documentation.

## Acceptance requiring external access
- [x] Supabase Free Mumbai project provisioned; migrations, RLS, private bucket, latest publication and scheduled maintenance verified. Owner Auth/live Realtime delivery are separate checks.
- [x] Modern backend secret configured; Worker/assets deployed to router.nicx.me; HTTPS/CSP and real database credential rejection verified.
- [x] Actual JIDU6111 package install and enrollment confirmed by user; real samples independently verified in PostgreSQL.
- [x] Actual LuCI enrollment, Save & Apply and Test connection confirmed by user; memory/packages snapshots verified separately; rotation remains a separate live test.
- [ ] Outage/reboot/retry/alert tests with actual services.
- [ ] Actual RAM, CPU, upload data, routing and Wi-Fi impact measured.
- [ ] Free-tier usage observed over representative workload, retention adjusted to measured row sizes.

## Current evidence
- 68 application/shared/Worker/dashboard tests pass, including Worker redirects and action feedback.
- 20 PostgreSQL integration tests plus one schema test; exported host-agent sample enabled, no skips.
- 42 router/host checks pass with native BusyBox and independently built jshn; signed release2 APK dependency closure verified.
- Six desktop/mobile browser checks pass with clearly labeled test-only fixtures.
- Phase 6 now has actual physical-router→Worker→PostgreSQL→dashboard acceptance, plus the local tests.
- Phase 7 is partial; see limitations.md for optional collectors. Phase 9 has logs/retention/cloud alerts; recipient delivery is deferred. Phase 11 now has an initial actual-router CPU/RSS/buffer observation; controlled routing/Wi-Fi and peak/HTTPS attribution remain pending.
- User confirmed router192.168.50.1, JIDU6111, SNAPSHOT r0+38470-c3af7ee2f2, kernel6.18.60, APK and171524 KiB free overlay. SSH password works in user terminal; agent SSH key is not authorized.
- Owner Auth user exists, public signup is disabled and one actual router is enrolled. No production fixture telemetry inserted.

User confirmed both nicx-telemetry and luci-app-nicx-telemetry installed successfully after the coreutils-stat feed fix. Enrollment/live telemetry independently verified afterward.

Cloud first real acceptance: owner signed in, one device enrolled, enrollment code consumed,4 actual samples received at2026-11-25T10:01:29Z. User confirmed dashboard observations and successful LuCI Test connection. No fixture records were inserted into this project.

Live checks also confirmed synchronized clock, successfuluploadcounter, zero droppeditems, credentialdirectory700/token+salt600, actual memory/packages snapshots stored and a clearly labeled local acceptance log received. Immediate/in-flight/completed feedback is deployed in LuCI and the dashboard. A real release2 memory snapshot UUID was confirmed stored and the local state advanced to uploaded. Telegram setup is deferred by the owner.
