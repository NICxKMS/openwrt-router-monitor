# Wire and database contract v1

All implementation components follow this contract. Schema package is authoritative for validation; changes require coordination.

POST /api/v1/telemetry with Authorization: Bearer DEVICE_TOKEN. JSON:
`{schema_version:1, device_id:UUID, boot_id:UUID, batch_id:UUID, sent_at:ISO-or-null, clock_synced:boolean, samples:Sample[], logs:Log[], inventory?:object, diagnostics?:object, dropped_samples?:integer}`.
At most 12 samples, 100 logs, 96 KiB UTF-8 body, 16 KiB individual detail/diagnostic object. Sample:
`{seq:integer, uptime_s:number, observed_at:ISO-or-null, cpu_pct:number-or-null, load1:number-or-null, mem_total_kb:integer-or-null, mem_available_kb:integer-or-null, mem_free_kb?:integer, cached_kb?:integer, slab_kb?:integer, sreclaimable_kb?:integer, sunreclaim_kb?:integer, temp_c:number-or-null, rx_bytes_delta:integer-or-null, tx_bytes_delta:integer-or-null, elapsed_s:number-or-null, interfaces?:[{name:string,role:'wan'|'usbwan'|'lan'|'other',rx_bytes:string,tx_bytes:string,rx_delta:number-or-null,tx_delta:number-or-null,elapsed_s:number-or-null,reset:boolean}], detail?:object}`.
Counter values are decimal strings to preserve 64-bit precision. Deltas are safe integers. CPU computed from differences excluding guest double-count; network deltas use monotonic elapsed time and are null across boot/device/counter reset or ambiguous interface recreation. Aggregate WAN counters only designated uplinks; Ethernet WAN and USB WAN remain separate in interfaces.

Log: `{seq:integer, uptime_s:number, observed_at:ISO-or-null, severity:0..7, service:string<=64, message:string<=1024, count:1..100000, first_at?:ISO-or-null,last_at?:ISO-or-null}`. Repeated messages grouped locally with occurrence count. No entire logread replay.

Worker → service-role RPCs (PostgREST):
- `enroll_device(p_enrollment_hash text,p_token_hash text,p_name text,p_model text) → {device_id}`; one-use token consumed atomically.
- `ingest_batch(p_token_hash text,p_batch jsonb) → {accepted:boolean,duplicate:boolean,config:object}`; authenticate, rate-limit atomically, insert/dedupe, update last_seen by receipt independently of latest observation.
- `device_config(p_token_hash text) → {device_id,config}`.
- `rotate_device_token(p_device_id uuid,p_owner_id uuid,p_token_hash text) → object`.
- `maintenance() → object`: rollups, retention, offline/threshold alerts and notification queue.
- `claim_notifications(p_limit int) → notification rows`, `finish_notification(p_id uuid,p_ok bool,p_error text) → void`.
- `resource_usage() → {database_bytes,table_bytes,archive_bytes,...}` service-only.

Owner management via Worker validates Supabase Auth bearer with /auth/v1/user. POST /api/v1/enrollment `{name}` inserts `enrollment_tokens {owner_id,token_hash,expires_at,name}`; responds `{token,expires_at}`. POST /api/v1/devices/:id/rotate returns `{token}`; DELETE revokes then removes owned device/data. POST /api/v1/devices/:id/config validates allowlist and updates devices.config. POST /api/v1/alerts/:id/ack verifies ownership and updates acknowledged_at. No user token is treated as a device credential.

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

Read RPC `history(p_device_id uuid,p_from timestamptz,p_to timestamptz) → [{bucket,cpu_pct,cpu_min,cpu_max,mem_available_kb,temp_c,rx_bytes_delta,tx_bytes_delta,elapsed_s,sample_count}]` auto resolution and owner auth required. Recent raw detail via metric_samples query limited 360 rows; logs cursor on received_at+id (bounded pages). Firmware comparison from boot_sessions and metric_samples/rollups, matched uptime observation windows and explicit confounder caveats.

Default remote config: `{sample_interval:10,upload_interval:30,wifi_interval:30,process_interval:60,detail_interval:300,buffer_kb:2048,logs_enabled:true,log_severity:5,privacy_addresses:false,diagnostics_enabled:false,retention_raw_days:3,retention_logs_days:7,monthly_quota_gb:0,billing_day:1}`. Worker validates strictly; agent applies only interval/enabled fields, no endpoints or shell from cloud. Local UCI overrides / safety limits apply.

Actual retention-aware history: raw for≤3h within configured raw age;60s for≤2d windows starting≤30d ago;900s for≤14d windows starting≤180d ago;3600s within365d; otherwise86400s up to400d. device_latest merges sparse detail keys only within the same boot. Archive paths use deviceUUID/uniqueArchiveUUID.json.gz; replacing an archive queues the previous object. Modern Supabase backend secret uses the apikey header only; Authorization carries user JWTs.
