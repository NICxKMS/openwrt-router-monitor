# Resource budgets and retention

All data-volume calculations below are **estimates**, not router measurements or provider billing. Run `pnpm estimate` and replace assumed row sizes with observed PostgreSQL relation/index sizes after several days. The hosted baseline observed on initial setup was about12.4 MB database/0.44 MB application relations with no routers or telemetry; this is a database measurement, not a forecast of steady state.

## Requests and network

10-second sampling yields8,640 samples/day/router.30-second uploads yield2,880 Worker requests/day/router and86,400/month before retries/configuration. Minute cloud Cron adds1,440/day globally. One router therefore leaves substantial room below100,000 Worker invocations/day, but public abuse or many routers can exhaust it. Static assets are served directly. No continuous server/computer is required.

At an illustrative800–1,200 bytes per sparse raw row including a rough share of index overhead, three raw days/router need roughly21–31 MB. This is not a measured PostgreSQL row size; rich samples/logs can be much larger. The database caps raw rows at30,000/device, so seven days at10 seconds does not imply all60,480 samples will remain. The UI must display that cap. Five enrolled routers is the default service limit.

At an illustrative600-byte sample on the wire, metrics alone are5.2 MB/day/router before HTTP/TLS, Wi-Fi details, inventory, probes and logs. Sparse slow collector data is sent only after collection, not repeated every10 seconds. Curl may reuse a connection only during its own request; separate shell uploads incur TLS setup again. Measure WAN bytes and actual transfer time with the benchmark harness. The agent never runs automatic speed tests.

## Storage tiers

| Data | Default bound |
| --- | --- |
| Raw common metrics / sparse detail |3 days, configurable1–7;30,000 rows/device |
| Minute rollups |30 days |
|15-minute rollups |180 days |
| Hourly rollups |365 days |
| Daily rollups |400 days |
| Per-interface WAN/USB daily totals |730 days |
| Routine logs |7 days,10,000 rows/device cap |
| Critical logs |Same configured log-age/row cap; severity priority is applied in router admission |
| Diagnostics / metadata |7 days or latest50/device; Storage deletion queued |
| Resolved alerts |90 days |
| Delivered notifications |7 days; undelivered work expires at30 days |

See actual SQL and database.md for exact retention precedence. Hourly/daily rollups are already accumulated when raw rows expire, avoiding a gap between an outage and a catch-up aggregation job. Rollups preserve per-gauge min/max/sum/count, counter totals and observed interval coverage. Percentiles are not implemented. Sample-weighted means are reported as such; irregular/adaptive sampling can bias comparisons. No claim is made that every rich process/client field has a year of separate numeric history.

Each minute SQL maintenance deletes bounded batches; this avoids long transactions but can take several runs to catch up. PostgreSQL autovacuum reuses dead space. DELETE does not directly shrink allocated data files; bloat, WAL, indexes and other Supabase tables still count. Do not routinely VACUUM FULL a monitoring database: it rewrites tables and takes locks. Inspect and plan any physical rewrite separately.

The application tracks conservative logical bytes transactionally. At320 MiB new low-priority detail/log/diagnostic payloads are dropped with loss reporting; at400 MiB it rejects new batches with a retryable response until maintenance creates room. This budget differs from Supabase's physical/database-size meter. Auth, catalog, bloat and unrelated objects can reach provider limits earlier. Review actual project usage and decrease retention/frequency before the quota is close.

Storage archives have a separate750 MB application guard against the1 GB published Free allowance. Compressing a small diagnostic may save little; archives are optional and owner-triggered. Inline snapshot payloads remain small, so archiving is not a mandatory path for ordinary metrics. Object deletion is asynchronous; provider outages can temporarily delay reclamation. Bulk automatic old-log archiving is not implemented; page exports and grouped logs keep the default workload bounded.

## Realtime and egress

One continuously visible viewer receiving one update every30 seconds consumes about86,400 Realtime updates/month/router, before protocol/auth overhead. Subscribers multiply deliveries. Only device_latest is published; the app unsubscribes while hidden/paused and uses bounded polling fallback. Chart history queries are capped and select an aggregate resolution appropriate to age/range.

The browser can consume more egress than ingestion: an illustrative1,000-row×150-byte history response every30 seconds is about432 MB/day of continuous viewing. Actual response size varies; pause live updates or increase the configurable fallback interval when leaving dashboards open. Provider metering is authoritative. The initial version reports database/Storage bytes and planning estimates; it does not retrieve authoritative Cloudflare invocation or Supabase egress/Realtime billing counters automatically.

## Router RAM and failures

The default total state allocation is2 MiB:1.5 MiB queue plus a reserved work/pending/log allowance. Linux tmpfs files consume RAM and disk blocks matter more than byte lengths. Runtime process RSS, child peaks and page sharing must be measured on the JIDU6111. No low-single-digit-MiB performance claim has been verified on that hardware. RAM queues disappear on power failure or reboot; persistent telemetry flash writes are intentionally avoided.
