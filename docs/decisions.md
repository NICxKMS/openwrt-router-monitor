# Architecture decisions — 25 November 2026

## ADR 001: retain the requested cloud stack
Outbound verified HTTPS → Hono Worker → one transactional Supabase RPC → PostgreSQL. Dashboard uses Supabase Auth, read-only RLS-protected queries and one device_latest subscription. Static assets bypass Worker execution. No D1, Neon, Redis, VPS or always-on computer. Direct ingestion would put more validation and enrollment complexity in public PostgreSQL functions; Edge Functions add another deployment and invocation budget without a benefit for this workload.

## ADR 002: isolate from firmware development
Use nicx-router-monitor/ inside the existing workspace. Existing firmware edits remain intact. OpenWrt packages are copied/symlinked into an SDK explicitly, never silently inserted into the build tree.

## ADR 003: compact storage and bounded retention
One common metrics row per 10-second sample, sparse detail payloads at their own interval, one latest state per device. Aggregations preserve min/max/sum/count and counter deltas separately. Defaults are storage-budgeted and documented as estimates until actual pg_total_relation_size measurements exist. Seven raw days plus long rich JSON histories cannot be promised inside 500 MB. Maintenance rolls up before deletion and stops accepting lower-priority data on an application storage guard. PostgreSQL DELETE reuses space after vacuum; it does not immediately shrink allocated files.

## ADR 004: shell first, measure before native rewrite
BusyBox ash + bounded awk parsers + existing ubus/jshn. curl is an explicit package dependency for bounded HTTPS timeouts, headers and response handling. No Python or JS on the router. A native implementation can reduce forks but adds cross-compilation and HTTP/JSON dependency maintenance; only measured router overhead can justify replacement. Persistent state is limited to UCI and enrollment credentials; queues and status are RAM.

## ADR 005: capability detection and privacy
Never assume PPE, ath11k debugfs or dnsmasq counters. Read installed source and runtime capabilities. Debugfs is not mounted or changed by this agent. Driver snapshots are read-only and opt-in. No DNS browsing history or full configuration files. Local address anonymization uses keyed hashes where supported; unavailable anonymization means omit identifiers. Kernel reservations and slab attribution must not be fabricated from missing memory.

## ADR 006: trust and failure boundaries
Device credentials authenticate even with an incorrect clock; boot UUID plus sequence gives idempotency for buffered/out-of-order records. Server timestamps are authoritative for liveness. Each payload states clock quality. Enrollment is single-use and short-lived. Config synchronization is strictly allowlisted; no commands. Telemetry can fail or be disabled without changing networking services.

## ADR 007: monitoring interface
Compact industrial instrument panel: slate/navy, cyan data accents, amber warnings, clear monospace numbers, strong readable labels. Empty states describe missing enrollment/data; no fake chart values. Navigation groups system, traffic and operations. Responsive sidebar becomes a mobile drawer. Charts are lazy-loaded ECharts with shared range, zoom and null gaps. Local configuration failure is explained before login.

## Deep system telemetry

The agent uses existing sparse detail records for the RAM ledger, allocator reports and CPU breakdown. Its sysfs and procfs readers are bounded. Keeping firmware-reserved RAM and overlapping diagnostic views separate from Linux-managed accounting makes both discrepancies visible. Cloud schemas and router enrollment stay compatible.
