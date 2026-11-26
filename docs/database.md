# Database and ownership

This project uses a dedicated Supabase project. The application migrations deliberately revoke default execution on all functions in `public`; do not apply them to a shared project with unrelated public RPCs. Device tokens are never Supabase user sessions. A browser receives an anon/publishable key and an authenticated user session; the Worker alone holds the service key. Only device SHA-256 hashes, never bearer tokens, enter PostgreSQL.

`supabase/config.toml` keeps `private` outside the API schemas and disables public signup. Create the initial owner using Supabase Auth administrative invitation, then configure the production site/redirect URLs. The local development URL is not a production redirect configuration.

## Applying migrations

Run the normal Supabase CLI workflow from the project directory after linking the intended dedicated project:

```sh
supabase db push
```

Migration 6 adds durable diagnostic dispositions to each batch receipt so a soft-budget skip or revoked cloud permission can never be presented as a stored snapshot. Historical receipts remain explicitly unknown. Migration 8 adds raw-history coverage checks, compatible ingest and credential-rotation locks, notification attempt matching, and archive deletion guards.

Migration 1 creates tables, transactions, grants, indexes, RLS, and latest-only Realtime publication. Migration 2 configures a private `router-diagnostics` bucket and owner read policy; the first path segment is the device UUID. Restrictive policies deny browser writes and prevent unrelated permissive Storage policies from exposing this bucket. Migration 3 installs `pg_cron` in `pg_catalog`, schedules maintenance every minute, and bounds cron execution history. Cron failure is an installation failure, not silently ignored. Do not skip migration 3 in production.

After migration, run `tests/database/hosted-smoke.sql` in the SQL editor. Check actual runs in `cron.job_run_details`, and verify a telemetry upload and an authenticated Realtime update using two test owners. The smoke script is read-only. It has not been run against a hosted project in this checkout.

The installation follows [Supabase Cron installation](https://supabase.com/docs/guides/cron/install) and the [Cron quickstart](https://supabase.com/docs/guides/cron/quickstart). Private file access follows [Storage access control](https://supabase.com/docs/guides/storage/security/access-control).

## Callable API

All functions below use a fixed search path. Except `history`, only `service_role` can execute them; public/anon/authenticated execution is explicitly revoked.

| Function | Result and behavior |
| --- | --- |
| `enroll_device(p_enrollment_hash text,p_token_hash text,p_name text,p_model text)` | JSON `{device_id}`. Locks and consumes an unexpired enrollment once; maximum five devices per owner. |
| `device_config(p_token_hash text)` | JSON `{device_id,config}` after checking a live device credential. |
| `rotate_device_token(p_device_id uuid,p_owner_id uuid,p_token_hash text)` | JSON `{rotated:true}`. Locks device and replaces the hash; previous credential immediately stops working. |
| `ingest_batch(p_token_hash text,p_batch jsonb)` | JSON `{accepted,duplicate,config,storage_degraded?,diagnostics_accepted,diagnostics_request_id,diagnostics_reason}`. Diagnostic disposition is stored per batch and stable on replay; null means historical unknown. Stored diagnostics return true, policy/budget skips return false. Declining a diagnostic does not reject ordinary gauges. Authenticates, serializes per device, rate limits, deduplicates and ingests in one transaction. |
| `maintenance()` | JSON `{deleted,completed_at}` or `{skipped:true}` if another maintenance transaction holds the advisory lock. |
| `claim_notification_attempts(p_limit int)` | JSON array `{id,device_id,owner_id,alert_id,event,message,severity,created_at,attempts}`. At most 50, with two-minute leases and `SKIP LOCKED`. |
| `finish_notification(p_id uuid,p_attempt int,p_ok bool,p_error text)` | Void; matches the current attempt, then completes the job or schedules exponential retry, at most eight delivery attempts. Error text is truncated to 500 characters. Worker must sanitize errors before passing them. |
| `enqueue_storage_deletion(p_object_path text)` | Void; validates a UUID/UUID.json.gz path and idempotently queues an unreferenced archive path when an upload races metadata deletion. |
| `claim_storage_deletions(p_limit int)` | JSON array `{id,object_path}` for unreferenced paths, at most 50, with two-minute leases. A queued path is unavailable for new diagnostic references. |
| `finish_storage_deletion(p_id uuid,p_ok bool,p_error text)` | Void; deletes a successful outbox row or schedules exponential retry. Missing Storage objects should count as success. |
| `resource_usage()` | JSON with actual `database_bytes`, actual `table_bytes` including indexes, conservative `logical_budget_bytes`, actual Storage metadata `archive_bytes`/`archive_objects`, row counts and maintenance time. Missing object size metadata produces null, never a fabricated zero. |
| `history(p_device_id uuid,p_from timestamptz,p_to timestamptz)` | Owner-only table result exactly as in `contracts.md`. Security invoker plus explicit `auth.uid()` ownership check; rejects invalid or over-400-day requests. |

`history` uses raw data for up to three hours within the configured raw retention when it can return the complete raw series within 2,160 rows. Short ranges with pruned or too many raw samples use overlapping minute buckets. It also uses minute buckets for recent ranges up to two days, 15-minute buckets for ranges up to 14 days within 180 days, hourly buckets within 365 days, and daily buckets for older requests. Maximum raw output is 2,160 rows; hosted API `max_rows=10000` permits the maximum hourly history range. Bound direct recent-detail and log queries in the UI; use the `(received_at,id)` log index for cursor pagination.

## Tables and grants

All contract tables exist, with RLS enabled on every public table. Browser reads are owner-only through the related `devices.owner_id`. `devices`, telemetry, logs, diagnostics, boots, alerts and aggregates have no browser write grants. The Worker validates ownership before service-role administrative writes. `alert_rules` and `client_names` have owner CRUD policies; checks prevent reassignment to another owner's device. Updating/removing a rule resolves its active alert and resets sustained state. `enrollment_tokens` has no browser grants or read policies.

Hidden credential, deduplication, rate-limit, alert-state, accounting, and queue tables live in `private`, with RLS and no browser schema access. Their RLS bypass is limited to the trusted function owner/service role. Device deletion cascades through its relational telemetry. A diagnostic delete trigger puts the object path in an independent private deletion outbox, which survives device deletion. The Worker deletes files using the Storage API and acknowledges the outbox; deleting SQL metadata alone does not delete an object.

Additional columns preserve correctness: rollups have independent CPU, available-memory, temperature and directional network delta counts; boot sessions retain sample/log eviction sequence watermarks and an inferred uptime origin; raw samples retain `effective_at`; devices expose cumulative `dropped_samples`, `dropped_logs` and `storage_degraded_at`. No second browser Realtime feed is published.

## Ingestion and ordering

Hashes are lowercase 64-character SHA-256 hex, generated by the Worker from random 256-bit credentials. Enrollment inserts lock by owner and allow at most ten active unexpired tokens; expiry cannot exceed 15 minutes. Enrollment and token rotation are atomic.

Ingest and credential rotation lock the device without blocking maintenance's foreign-key checks, then lock the credential. A live credential is checked before duplicate processing. Ten nonduplicate batches per device per minute are accepted; excess attempts raise a rate-limit error with no partial inserts. A repeated batch UUID and identical canonical JSON returns `duplicate:true`; the same UUID with altered data raises a replay error. Sample/log primary keys independently deduplicate rows across batches. Batch fingerprints are nonsecret MD5 identifiers, not credential hashes. Exact batch fingerprints expire after eight days; durable boot watermarks prevent deleted old sample/log sequences from being reintroduced into rollups or logs.

Receipt time always updates `last_seen_at`, including authenticated duplicate receipts and storage-budget rejection. Latest gauges only advance for the current boot and a sequence with nondecreasing uptime; delayed samples from an already known previous boot cannot replace latest. Sparse detail merges by top-level group within a boot, resets on a new boot, and has a 64 KiB cache bound. Raw samples retain their original sparse detail. Agent collector uptime stamps remain available to explain stale detail.

An unknown boot arriving for the first time is treated as the current boot by first receipt. Without trustworthy wall time, a never-before-seen delayed boot cannot be distinguished from a real new boot. This is an explicit inference, not proof of reboot chronology. Synchronized observations within three days and five minutes future tolerance use device time; otherwise an uptime origin anchored to first receipt is used, clamped to receipt time. Unsynchronized absolute history is estimated, while sequence/uptime order remains explicit. `observed_at` retains the actual null/clock state.

Every newly inserted sample adds once to minute/15-minute/hour/day rollups. Averages divide gauge sums by that gauge's non-null count. All-null metrics stay null. Network rollups sum valid deltas and expose independent Rx/Tx counts. The dashboard suppresses a directional window total when a bucket is incomplete. Migration 009 backfills counts only for buckets whose complete raw observations remain. Reset-only traffic stays unavailable. WAN and USB WAN have separate per-interface UTC daily rows; LAN/other interfaces never enter Internet totals. Deltas crossing midnight are assigned to the observation end day rather than inventing within-interval traffic distribution.

## Alerts

Offline alerts use receipt time and `max(120 seconds,3×upload interval)`. Maintenance delays over five minutes open a cloud-gap alert when maintenance resumes. This cannot notify during an unavailable cloud service and does not prove the ISP failed.

Thresholds evaluate each newly accepted latest sample, with sustain time, recovery hysteresis and cooldown. They do not infer sustained high load from elapsed wall time with no samples. Missing common gauges reset pending sustain; omitted sparse collectors retain state until their next bounded observation, while explicit nulls and long gaps reset pending sustain. Metrics are CPU, available memory, temperature, IPv4 latency/loss, memory PSI full avg10 at `memory.psi.memory.full.avg10`, and conntrack percentage from `firewall.conntrack_count/conntrack_max`. Unsupported values never become zero.

Two consecutive explicit `connectivity.<ipv4|ipv6|dns>.available=true,reachable=false` observations open reachability/DNS alerts; missing tools/omitted families do not. A successful probe resolves them. Public endpoint failure is labeled as an observation, not an established ISP cause. New boot observations and newly inserted OOM/allocation failure or ath11k crash/restart log messages open event alerts. Event alerts remain visible until an owner handles them; the system does not invent evidence of recovery. Duplicate logs do not generate duplicate events.

Open/resolved transitions enter a notification outbox in the same transaction. Delivery is asynchronous and at least once: a delivery that succeeds immediately before a lost acknowledgement can be retried. Worker notification destination selection uses the returned owner ID and configured owner-bound credentials. A Worker using migration 8's scoped claims leaves notifications queued if that migration has not been applied. Maintenance and archive cleanup continue.

## Retention and budget

Each maintenance run deletes at most 5,000 raw/log/rollup/daily/batch rows per category and 1,000 diagnostic/enrollment/resolved-alert/notification rows per category. Backlogs drain over successive runs. Raw retention defaults to three days, configurable 1–7, with a 30,000-row/device hard cap. Logs default to seven days, configurable 1–30, with a 10,000-row/device hard cap. Inline or archived diagnostic metadata is bounded to seven days or the latest 50/device; paths enter the Storage deletion outbox. Enrollment rows expire, delivered notifications retain seven days, unresolved delivery work expires at 30 days, and resolved alerts retain 90 days. Boot metadata/watermarks persist for the device lifetime so old sequences stay rejected.

Minute rollups retain 30 days, 15-minute rollups 180 days, hourly 365 days and daily 400 days; separate uplink daily totals retain 730 days. Raw deletion never rebuilds or adds aggregates again. SQL deletion creates reusable database pages; it does not immediately shrink provider-reported disk size.

A transactional live budget estimates full JSON row bytes plus 256 bytes/row overhead across telemetry and bookkeeping. At 320 MiB it drops new sample detail, logs and diagnostic payloads before ordinary gauges; cumulative dropped-log counts and degradation time are visible on the device. At 400 MiB ingest returns `{accepted:false,reason:"storage_budget"}`; Worker must return retryable failure so the agent retains its bounded queue. This conservative application budget differs from actual provider billing and disk allocation, which `resource_usage` reports separately. It is not a free-tier guarantee. Maintenance must remain enabled and Storage deletions must be drained by the Worker.

## Verification evidence and limits

From the project directory:

```sh
node tests/database/schema.test.mjs
node tests/database/integration.test.mjs
python3 tests/router/export_sample.py > /tmp/nicx-router-sample.json
NICX_AGENT_SAMPLE=/tmp/nicx-router-sample.json node tests/database/integration.test.mjs
```

The integration harness uses PGlite's actual PostgreSQL engine, real SQL roles/RLS, core and Storage migrations, and a minimal `auth.uid()`/Storage table fixture. Tests cover one-use enrollment, credential rejection/rotation/revocation, modified replay rejection, per-device rate limiting, out-of-order latest protection, old boot delivery, separate WAN/USB totals, sparse null averages, retention replay protection, owner isolation, Storage ownership, service-only privileges, fixed privileged search paths, sustained/hysteresis thresholds, reachability, event logs, leased queues, deletion cascades and budget degradation/rejection. The optional exported agent sample verifies actual host-fixture collector output reaches PostgreSQL without converting unknown values to zero; it is not physical-router evidence.

PGlite has one connection and does not exercise multi-connection lock races, Supabase Auth/PostgREST/Realtime services, actual Storage HTTP operations, or `pg_cron` execution. Hosted smoke and real deployment checks remain required. No hosted database, cloud account or physical router was provisioned or benchmarked by these tests.

Migration007 replaces alert evaluation to honor bounded effective cadence and guards rule-change resolution notifications during device cascades. Device deletion must not emit a notification referencing its deleted parent. Applied migrations001–006 remain immutable.
