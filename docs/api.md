# HTTP API v1

All production requests use verified HTTPS. JSON only; request compression is rejected to avoid decompression bombs. API errors are `{ "error": "stable_code" }` without SQL, secrets or request bodies. Responses use `Cache-Control: no-store`, request IDs and security headers. Foreign browser origins are rejected. Routers omit Origin.

| Route | Authentication | Action |
| --- | --- | --- |
| GET /api/v1/health | Public | Minimal process health/schema version; not database health |
| POST /api/v1/devices/enroll | One-use enrollment token in JSON | Consume ten-minute enrollment, issue random device credential,201 |
| POST /api/v1/telemetry | Device bearer | Validate and atomically insert bounded envelope,200 |
| POST /api/v1/logs /diagnostics /heartbeat | Device bearer | Aliases using the identical envelope, not separate wire schemas |
| GET /api/v1/device/config | Device bearer | Strict allowlisted telemetry settings |
| POST /api/v1/enrollment | Supabase user bearer | Create one-use enrollment `{name}` |
| PATCH /api/v1/devices/:id | Owner user bearer | Rename `{name}` |
| POST /api/v1/devices/:id/config | Owner user bearer | Merge validated allowlisted settings |
| POST /api/v1/devices/:id/rotate | Owner user bearer | Issue replacement token; old token invalid immediately |
| POST /api/v1/devices/:id/revoke | Owner user bearer | Stop device ingestion while preserving history |
| DELETE /api/v1/devices/:id | Owner user bearer | Delete device/history, queue archive deletion |
| PUT /api/v1/devices/:id/client-names/:client | Owner user bearer | Friendly name for an anonymized client identifier |
| POST /api/v1/alerts/:id/ack | Owner user bearer | Acknowledge an existing alert |
| POST /api/v1/devices/:id/diagnostics/:snapshot/archive | Owner user bearer | Gzip existing snapshot, save private Storage object, idempotent path |
| GET /api/v1/usage | ADMIN_USER_ID only | Global database/storage usage; never expose another owner's telemetry |

See [contracts.md](contracts.md) and `packages/shared/src/index.ts` for exact types. Max96 KiB streamed body,12 samples,100 logs,1024 characters/message,16 KiB extended object. Devices carry UUID boot IDs, sample/log sequences and immutable UUID batch IDs. Auth tokens use256 bits randomness with `nxd_` or `nxe_` prefixes and SHA-256 hashes in PostgreSQL. Enrollment and user sessions cannot be substituted for device credentials.

Typical sample batch:

```json
{"schema_version":1,"device_id":"00000000-0000-4000-8000-000000000001","boot_id":"00000000-0000-4000-8000-000000000002","batch_id":"00000000-0000-4000-8000-000000000003","sent_at":null,"clock_synced":false,"samples":[{"seq":1,"uptime_s":10,"observed_at":null,"cpu_pct":null,"load1":0.1,"mem_total_kb":400000,"mem_available_kb":200000,"temp_c":null,"rx_bytes_delta":null,"tx_bytes_delta":null,"elapsed_s":null}],"logs":[]}
```

This example is synthetic documentation, never production telemetry. Unknown gauges are null; raw64-bit interface counters are decimal strings. Counters/gauges have separate aggregation semantics. Server receipt time determines liveness. Unsynchronized wallclock data is estimated on a receipt-relative timeline and must be interpreted accordingly.

Status codes:400 malformed/invalid,401 credential expired/revoked/invalid,403 foreign origin or ownership denied,404 missing resource,413 oversized body,415 wrong content type/encoding,429 rate limit,503 storage budget/backend unavailable.429 includes Retry-After60;503 includes Retry-After30. Agent retains immutable batches until a200 response with accepted=true. Duplicate retries succeed with duplicate=true; changed payload under a retained batch ID is rejected.

Config synchronization cannot change endpoints, credentials, commands, filesystem paths or networking. Local UCI safety/privacy settings are authoritative; remote changes can reduce sampling frequency within fixed bounds. There is no cloud remote-shell or inbound diagnostic command endpoint. Triggering snapshots happens on local LuCI; cloud archive requests operate only on data already uploaded.
