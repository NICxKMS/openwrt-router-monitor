# Wire and database contract v1

All implementation components follow this contract. Schema package is authoritative for validation; changes require coordination.

POST /api/v1/telemetry with Authorization: Bearer DEVICE_TOKEN. JSON:
`{schema_version:1, device_id:UUID, boot_id:UUID, batch_id:UUID, sent_at:ISO-or-null, clock_synced:boolean, samples:Sample[], logs:Log[], inventory?:object, diagnostics?:object, dropped_samples?:integer}`.
At most 12 samples, 100 logs, 96 KiB UTF-8 body, 16 KiB individual detail/diagnostic object. Sample:
`{seq:integer, uptime_s:number, observed_at:ISO-or-null, cpu_pct:number-or-null, load1:number-or-null, mem_total_kb:integer-or-null, mem_available_kb:integer-or-null, mem_free_kb?:integer, cached_kb?:integer, slab_kb?:integer, sreclaimable_kb?:integer, sunreclaim_kb?:integer, temp_c:number-or-null, rx_bytes_delta:integer-or-null, tx_bytes_delta:integer-or-null, elapsed_s:number-or-null, interfaces?:[{name:string,role:'wan'|'usbwan'|'lan'|'other',rx_bytes:string,tx_bytes:string,rx_delta:number-or-null,tx_delta:number-or-null,elapsed_s:number-or-null,reset:boolean}], detail?:object}`.
Counter values are decimal strings to preserve 64-bit precision. Deltas are safe integers and elapsed durations are positive seconds or `null`. CPU computed from differences excluding guest double-count; network deltas use monotonic elapsed time and are null across boot/device/counter reset or ambiguous interface recreation. Aggregate WAN counters only designated uplinks; Ethernet WAN and USB WAN remain separate in interfaces.

Log: `{seq:integer, uptime_s:number, observed_at:ISO-or-null, severity:0..7, service:string<=64, message:string<=1024, count:1..100000, first_at?:ISO-or-null,last_at?:ISO-or-null}`. Repeated messages grouped locally with occurrence count. No entire logread replay.

Worker → service-role RPCs (PostgREST):
- `enroll_device(p_enrollment_hash text,p_token_hash text,p_name text,p_model text) → {device_id}`; one-use token consumed atomically.
- `ingest_batch(p_token_hash text,p_batch jsonb) → {accepted:boolean,duplicate:boolean,config:object,diagnostics_accepted:boolean|null,diagnostics_request_id:string|null,diagnostics_reason:string}`. The transaction authenticates, rate-limits, deduplicates and updates `last_seen_at` by receipt independently of the latest observation.
- `device_config(p_token_hash text) → {device_id,config}`.
- `rotate_device_token(p_device_id uuid,p_owner_id uuid,p_token_hash text) → object`.
- `maintenance() → object`: rollups, retention, offline/threshold alerts and notification queue.
- `claim_notification_attempts(p_limit int) → notification rows` includes each lease's `attempts` value. `finish_notification(p_id uuid,p_attempt int,p_ok bool,p_error text) → void` matches that lease.
- `resource_usage() → {database_bytes,table_bytes,archive_bytes,...}` service-only.

A router confirms snapshot storage when `diagnostics_accepted:true` comes back with its matching `diagnostics_request_id`. `accepted:true` acknowledges the telemetry batch. Diagnostic dispositions are `stored`, `no_diagnostics`, `cloud_diagnostics_disabled`, `storage_budget` or `historical_unknown`. Historical receipts may have `diagnostics_accepted:null`. Replays return the persisted result, so stored snapshots stay acknowledged after policy changes and skipped snapshots stay skipped after storage recovers.

Owner management via Worker validates Supabase Auth bearer with /auth/v1/user. POST /api/v1/enrollment `{name}` inserts `enrollment_tokens {owner_id,token_hash,expires_at,name}`; responds `{token,expires_at}`. POST /api/v1/devices/:id/rotate returns `{token}`; DELETE revokes then removes owned device/data. POST /api/v1/devices/:id/config validates submitted settings and merges them with the latest owned device configuration using a conditional update. POST /api/v1/alerts/:id/ack verifies ownership and updates acknowledged_at. No user token is treated as a device credential.

POST /api/v1/devices/enroll `{enrollment_token,name,model?}` → `{device_id,token,config}`. GET /api/v1/device/config uses device credential. GET /api/v1/health public minimal health only. `/api/v1/logs`, `/api/v1/diagnostics`, `/api/v1/heartbeat` may share the telemetry envelope; document aliases.

Dashboard uses Supabase browser publishable/anon key + user session. Tables (snake_case):
- `devices`: id uuid,owner_id uuid,name,model,created_at,last_seen_at,last_boot_id,config jsonb,revoked_at.
- `device_latest`: device_id PK,received_at,boot_id,seq,observed_at,uptime_s,cpu_pct,load1,mem_total_kb,mem_available_kb,temp_c,rx_bytes_delta,tx_bytes_delta,elapsed_s,detail jsonb,interfaces jsonb.
- `metric_samples`: device_id,boot_id,seq,observed_at,received_at,uptime_s,typed Sample gauges and sparse detail/interfaces. Unique(device_id,boot_id,seq).
- `system_logs`: id,device_id,boot_id,seq,observed_at,received_at,uptime_s,severity,service,message,count,first_at,last_at. Unique(device_id,boot_id,seq).
- `diagnostics`: id,device_id,boot_id,created_at,payload jsonb,object_path nullable.
- `boot_sessions`: device_id,boot_id,first_seen_at,last_seen_at,inventory jsonb.
- `alerts`: id,device_id,rule_key,severity,message,opened_at,resolved_at,acknowledged_at.
- `alert_rules`: id,device_id,metric,operator,threshold,sustain_s,hysteresis,cooldown_s,enabled.
- `metric_rollups`: device_id,resolution_s,bucket,sample_count,cpu_min,cpu_max,cpu_sum,mem_available_min,mem_available_max,mem_available_sum,temp_min,temp_max,temp_sum,rx_bytes,tx_bytes,coverage_s.
- `bandwidth_daily`: device_id,day,interface_name,role,rx_bytes,tx_bytes,coverage_s.
- `client_names`: device_id,client_id,name; identifiers only local anonymized IDs.

Read RPC `history(p_device_id uuid,p_from timestamptz,p_to timestamptz) → [{bucket,cpu_pct,cpu_min,cpu_max,mem_available_kb,temp_c,rx_bytes_delta,tx_bytes_delta,elapsed_s,sample_count,rx_delta_count,tx_delta_count,traffic_window_exact}]` auto resolution and owner auth required. The dashboard labels window totals approximate when raw intervals cross the start or retained rollups cannot align to the requested boundaries. Recent raw detail via metric_samples query limited 360 rows; logs cursor on received_at+id (bounded pages). Firmware comparison from boot_sessions and metric_samples/rollups, matched uptime observation windows and explicit confounder caveats.

Default remote config: `{sample_interval:10,upload_interval:30,wifi_interval:30,process_interval:60,detail_interval:300,buffer_kb:2048,logs_enabled:true,log_severity:5,privacy_addresses:false,diagnostics_enabled:false,retention_raw_days:3,retention_logs_days:7,monthly_quota_gb:0,billing_day:1}`. Worker validates strictly; agent applies only interval/enabled fields, no endpoints or shell from cloud. Local UCI overrides and safety limits apply. Wi-Fi and process intervals are capped at 900 and 1,800 seconds respectively. Legacy stored values above those limits are capped when read.

History uses raw samples for ranges up to three hours within the configured retention when the raw series is complete and fits the 2,160-row limit. If raw data has been pruned or exceeds that limit, history returns the minute aggregates that overlap the request. Other ranges use minute buckets for windows of up to two days starting within the last 30 days, 15-minute buckets for windows of up to 14 days starting within the last 180 days, hourly buckets within 365 days, and daily buckets up to 400 days.

`device_latest` merges sparse detail keys within the same boot. Archive paths use `deviceUUID/uniqueArchiveUUID.json.gz`. Replacing an archive queues the previous object. The `apikey` header carries the modern Supabase backend secret and `Authorization` carries user JWTs.

Effective cadence is reported in each sample as `detail.cadence.{sample_s,connectivity_s,detail_s}`. These are local/adaptive intervals, not remote execution settings. Alert evaluation bounds them independently and uses three observation intervals for continuity gaps; legacy samples fall back to bounded elapsed time and cloud defaults. Missing capabilities still do not indicate failure.
