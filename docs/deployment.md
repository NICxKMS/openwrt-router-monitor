# Deployment guide

The monitor uses Supabase and Cloudflare Workers, with `router.nicx.me` as the dashboard and API. Follow the production approval process for changes to hosted services. Use the initial provisioning steps only for a new project.

## 1. Supabase

1. Create a Free organization/project. Choose specific region **South Asia (Mumbai), ap-south-1**. If capacity is unavailable, choose Singapore only after deciding that change. Generate a strong database password and save it in your password manager.
2. Open SQL Editor and run these files in order, each once: `supabase/migrations/202611250001_core.sql`, `202611250002_storage.sql`, `202611250003_cron.sql`. Then apply the remaining migrations in filename order. The sequence sets up schema/RLS/RPCs, the private `router-diagnostics` bucket, latest-state Realtime publication, bounded maintenance, diagnostic receipts and backend fixes. Migration 008 is required before the Worker delivers configured Telegram notifications through the attempt-scoped claim API. On the existing hosted project, compare the actual migration history with the repository SQL before staging an approved migration. The first migrations may have different hosted IDs. Verify equivalent SQL and record the mapping privately. Rehearse pending SQL against disposable data and apply only the reviewed pending migrations in their approved order.
3. Open Authentication → Users and create your owner with an email and strong password. Disable new public signups in Auth settings. Configure the site URL as `https://router.nicx.me` and an exact redirect allowlist. Password login is supported without depending on the shared email sender. Configure your own SMTP for account recovery/invitations if needed; verify current provider allowances before choosing one.
4. Copy the project URL and browser publishable key. Keep the modern secret key (sb_secret_...) separate. In `apps/dashboard/.env.local` set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. `VITE_API_URL` may be omitted for same-origin production.
5. Note your owner UUID for `ADMIN_USER_ID` and `TELEGRAM_OWNER_ID`. It is an identity, not a password.
6. Check Storage: `router-diagnostics` must be private with gzip MIME support. Check Realtime publication: only `public.device_latest`, not raw metrics/logs. Check Cron jobs: successful maintenance each minute and bounded execution-log cleanup.
7. Run `tests/database/hosted-smoke.sql` in the project SQL Editor. Then verify reads as two separate authenticated test users; the local PostgreSQL RLS test is evidence of policy logic, not a replacement for testing the actual project.

Use `python3 -B scripts/dev-stack.py --check` from the monitoring directory to run the full local stack with Docker. Use the embedded PostgreSQL suite for a fast schema and behavior check.

## 2. Cloudflare Worker and secrets

Authenticate with Wrangler in your own account. No paid Workers plan is needed. Secrets are entered interactively so they do not appear in command history:

```sh
cd /home/nicx/projects/openwrt-jidu6111/nicx-router-monitor
pnpm install --frozen-lockfile
pnpm --filter @nicx/worker exec wrangler login
pnpm --filter @nicx/worker exec wrangler secret put SUPABASE_URL
pnpm --filter @nicx/worker exec wrangler secret put SUPABASE_SECRET_KEY
pnpm --filter @nicx/worker exec wrangler secret put ADMIN_USER_ID
```

Review `apps/worker/wrangler.jsonc`: its rate-limit namespace6111 must be unique within your account; `APP_ORIGIN` must exactly match the browser origin. Wrangler can create the Worker when adding its first secret; confirm the account/project name it shows. The privileged Supabase key is never a `VITE_` variable and never installed on the router.

Build the monitoring bundle from the exact clean candidate checkout, using the production browser publishable key in the environment. From the repository root:

```sh
python3 -B scripts/monitor-bundle.py build "$OUTPUT/monitor-bundle.tar.gz" --source-commit "$COMMIT"
```

Run the monitoring CI checks and include this file and its SHA-256 in the Stable draft manifest. The protected workflow verifies that digest, deploys the fixed bundle with Wrangler and reports the active Worker version. Rehearse and approve changes to Cloudflare routes and triggers separately before deployment. For a new Worker, apply the approved minute trigger from `apps/worker/wrangler.jsonc` with `pnpm --filter @nicx/worker exec wrangler triggers deploy`. Check that `* * * * *` appears in the Worker’s Cron Triggers before testing scheduled notifications. [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

## 3. Domain

In Cloudflare, confirm `nicx.me` is in the intended account/zone. On the Worker → Settings → Domains & Routes, add custom domain `router.nicx.me`. Review any existing DNS record before replacing it. Wait for HTTPS certificate activation, then open the domain. Keep `APP_ORIGIN=https://router.nicx.me`. No router public IP, inbound ports or ISP bridge mode are involved.

Run read-only checks:

```sh
MONITOR_URL=https://router.nicx.me node scripts/cloud-smoke.mjs
```

PowerShell:

```powershell
$env:MONITOR_URL = 'https://router.nicx.me'
node scripts/cloud-smoke.mjs
```

## 4. Enrollment and live validation

1. Build/install the matching OpenWrt packages using [router.md](router.md). Leave the agent disabled until enrolled.
2. Sign in to the dashboard. Select **Enroll router**, enter a friendly name, and copy the one-use ten-minute token.
3. On the router's local LuCI → Services → Nicx Telemetry, enter the HTTPS endpoint and enrollment token. Enroll, then enable/start telemetry. The long-lived device token is stored locally mode600 and never shown by status APIs.
4. Confirm last successful upload, bounded queue size and stable failed-upload counts in LuCI. Confirm real device, boot, CPU and MemAvailable data on the cloud dashboard. Do not regard an HTTP health response as proof of ingestion.
5. Pause/resume live mode, test another time range, compare observed/received timestamps, inspect logs, and verify the project's Realtime message count.
6. Disconnect only the monitored router's uplink for a controlled maintenance window. Verify RAM buffering, cloud offline alert, reconnection and deduplication. Do not use a failure test that disrupts other people without planning it.
7. Run the benchmark script and observe provider usage over several days before raising frequencies or retention.

## 5. Telegram

Create a Telegram bot using Telegram's official BotFather and obtain your own chat ID through the official Bot API. Do not put bot tokens in browser or router configuration. Set Worker secrets:

```sh
pnpm --filter @nicx/worker exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm --filter @nicx/worker exec wrangler secret put TELEGRAM_CHAT_ID
pnpm --filter @nicx/worker exec wrangler secret put TELEGRAM_OWNER_ID
```

The configured recipient receives **only** alerts owned by `TELEGRAM_OWNER_ID`. Delivery uses plain text, no remote markup, with leased retries and bounded attempts. Provider/network failures can cause at-least-once delivery; duplicates after an ambiguous provider response are possible. No notifications are sent by local tests. Additional users need separate configured destinations before their notifications can be delivered. Email delivery is not implemented.

Test using a temporary CPU rule below the current measured usage with a short sustain period, observe one opening and one recovery notification, then remove the rule. Do not force OOM, reboot or driver crashes to test alerting.

## 6. GitHub Actions

The parent repository’s test workflow validates monitoring source. For production, use `production.yml`. Configure the GitHub `production` environment for the protected `stable` branch, require the maintainer’s approval, and set its `JIDU6111_PRODUCTION_MAINTAINER` variable to the reviewing GitHub username. Configure narrowly scoped `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` environment secrets. Keep runtime database credentials in Cloudflare.

From the repository root, prepare the private record for the exact Stable release draft:

```sh
python3 -B scripts/promotion.py prepare --manifest "$OUTPUT/release-manifest.json" --reservation-tag "$TAG"
```

The draft manifest includes `promotion.kind` and the expected current `promotion.expected_worker_version` for changes that deploy a Worker. Use `promotion.required_agent_version` for any change that depends on a new agent. A combined change must specify it. For database or firmware changes with a Worker deployment, set `promotion.deploy_worker` to `true`. Set `promotion.expected_migrations` to the observed hosted migration identifiers expected after a database change.

When an agent update is required, confirm the installed package on the same router that sent the accepted sample. Record the time of installation verification and the sample's accepted timestamp:

```sh
python3 -B scripts/promotion.py record-agent --version "$AGENT_VERSION" \
  --installed-at "$INSTALLED_AT" --received-at "$RECEIVED_AT"
```

For a change that deploys a Worker, dispatch the workflow with the verified inputs and approve the matching GitHub environment request. For other promotions, continue directly to live verification.

```sh
set -o pipefail
python3 -B scripts/promotion.py deployment-inputs --manifest "$OUTPUT/release-manifest.json" --reservation-tag "$TAG" |
  gh workflow run production.yml --ref stable --json
```

Following live checks, create a private observed JSON file with `router.board`, `router.kernel`, `router.firmware`, `router.architecture`, `router.trusted_keys` (the SHA-256 fingerprints), `router.agent_version`, `worker_version`, `migrations`, `verified_at` and `checks`. Use UTC timestamps. For firmware include `observation_started_at`. For a Worker deployment include the successful GitHub Actions run ID as the numeric `production_run_id`. Take it from the production workflow run URL. Base checks are `router_identity`, `feed_signature`, `worker_health`, `database_state` and `recovery_ready`. Additional check labels depend on the change and are listed by the verification command when missing. Record checks only after collecting real evidence. Then run:

```sh
python3 -B scripts/promotion.py verify-production --manifest "$OUTPUT/release-manifest.json" \
  --reservation-tag "$TAG" --observed "$OBSERVED"
```

After protected Stable publication succeeds, run `scripts/promotion.py complete` with the same manifest and reservation tag. It checks GitHub Latest and the published manifest before saving the observed state locally. Before clearing an interrupted reservation, check the actual router, Worker and database. If the Worker needs recovery, obtain approval to reactivate the recorded previous compatible version in Cloudflare and then verify dashboard access and telemetry. Keep the database migration history intact and use a reviewed corrective migration or a rehearsed restore when needed.
