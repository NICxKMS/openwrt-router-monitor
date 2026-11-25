---
id: monitor-worker
name: Cloudflare Worker and API
paths:
- apps/worker/**
---

# Worker and API

- Review Hono and Workers runtime compatibility rather than assuming Node APIs. Check streamed body limits without trusting Content-Length, bounded validation, CORS, SSRF, redirect handling, timeouts, status codes and error sanitization.
- Verify device vs owner authorization, ownership checks, replay protection, atomic rate limiting, idempotent ingestion, bounded retries and no privileged secret leakage. Modern Supabase backend secrets use apikey, not user JWT Authorization; preserve documented manual redirect and non-2xx rejection behavior.
- Check scheduled maintenance, overlapping Cron executions, notification claims/retries, offline/threshold alerts, rollup/retention continuity, archives and partial failure recovery. Avoid duplicate delivery or notification storms where possible; acceptance is not delivery.
- Bound DB/Storage calls, execution time, public endpoint exposure and provider quota amplification. Test service outage, malformed requests, denied access and repeated submissions.
- Verify wrangler bindings, compatibility date, environments, scheduled triggers, secret separation and safe deployment. Do not introduce production writes in local validation.
