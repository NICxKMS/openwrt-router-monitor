# Changelog

Version the web platform with semantic versions and the OpenWrt packages with `PKG_VERSION` plus `PKG_RELEASE`. Database migrations are append-only. Package release numbers may advance independently of the web version.

## 0.1.0 — 2026-11-25

Initial working platform: authenticated Worker ingestion, private PostgreSQL history, retention and alerts, responsive dashboard, and installable OpenWrt agent/LuCI packages. Actual JIDU6111 telemetry and logs have reached the hosted dashboard. See the acceptance checklist for remaining validation and optional collectors.

### Pre-merge corrections / OpenWrt 1.0.0-r3

- Preserve client-name form values before disabling controls; prevent stale log/diagnostic exports.
- Confirm uncertain archive registration without deleting a potentially referenced object.
- Publish network snapshots atomically and reject invalid cached JSON locally.
- Report effective collection cadence so slower local/adaptive sampling preserves valid alert streaks.
- Allow device deletion when threshold rules have active alerts.
- Add migration007 without changing applied migrations. Apply it before rolling out release3.

### OpenWrt 1.0.0-r2

- Visible pending, success and failure feedback in LuCI; duplicate action protection.
- Snapshot request identities and confirmed cloud receipts; queued and uploaded states remain distinct.
- Clear local/cloud diagnostic permissions, storage-budget rejection and retry explanations.
- Service health detection, missing Wi-Fi values and agent resource counters corrected.
- Web actions show progress and persistent outcomes, including uncertain timeout results.

Telegram setup is deferred at the owner's request. Routing and Wi-Fi impact require controlled hardware measurements; no unmeasured performance claims are made.
