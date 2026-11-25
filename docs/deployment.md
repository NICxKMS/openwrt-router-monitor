# Deployment guide

The chosen target is a **new Supabase Free project in Mumbai** and Cloudflare Workers Free, with `router.nicx.me` as the dashboard/API. These instructions create cloud resources only when you execute them or authorize connected account tools. No deployment has been performed by merely building this checkout.

## 1. Supabase

1. Create a Free organization/project. Choose specific region **South Asia (Mumbai), ap-south-1**. If capacity is unavailable, choose Singapore only after deciding that change. Generate a strong database password and save it in your password manager.
2. Open SQL Editor and run these files in order, each once: `supabase/migrations/202611250001_core.sql`, `202611250002_storage.sql`, `202611250003_cron.sql`. Then apply follow-up migrations 004 through 008 in filename order. The sequence sets up schema/RLS/RPCs, the private `router-diagnostics` bucket, latest-state Realtime publication, bounded maintenance, diagnostic receipts and backend fixes. Migration 008 is required before the Worker delivers configured Telegram notifications through the attempt-scoped claim API. For repeatable CLI migrations, use the official Supabase CLI, link this project from the platform directory and run `supabase db push`. Review its migration list first. Do not run `db reset` against a hosted project.
3. Open Authentication → Users and create your owner with an email and strong password. Disable new public signups in Auth settings. Configure the site URL as `https://router.nicx.me` and an exact redirect allowlist. Password login is supported without depending on the shared email sender. Configure your own SMTP for account recovery/invitations if needed; verify current provider allowances before choosing one.
4. Copy the project URL and browser publishable key. Keep the modern secret key (sb_secret_...) separate. In `apps/dashboard/.env.local` set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. `VITE_API_URL` may be omitted for same-origin production.
5. Note your owner UUID for `ADMIN_USER_ID` and `TELEGRAM_OWNER_ID`. It is an identity, not a password.
6. Check Storage: `router-diagnostics` must be private with gzip MIME support. Check Realtime publication: only `public.device_latest`, not raw metrics/logs. Check Cron jobs: successful maintenance each minute and bounded execution-log cleanup.
7. Run `tests/database/hosted-smoke.sql` in the project SQL Editor. Then verify reads as two separate authenticated test users; the local PostgreSQL RLS test is evidence of policy logic, not a replacement for testing the actual project.

CLI alternative in WSL (install the official CLI using its current documented method):

```sh
cd /home/nicx/projects/openwrt-jidu6111/nicx-router-monitor
supabase login
supabase link --project-ref YOUR_PROJECT_REFERENCE
supabase db push
```

The included `supabase/config.toml` is for local Supabase development and does not automatically apply hosted Auth settings. Docker is needed for the full local Supabase stack; it was unavailable in this WSL session. The automated database suite uses embedded PostgreSQL instead.

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

Build and verify before deploying:

```sh
pnpm preflight
pnpm test
pnpm test:database
pnpm test:router
pnpm typecheck
pnpm build
pnpm --filter @nicx/worker run deploy
```

The final command publishes the Worker and static dashboard assets and enables its minute Cron Trigger. It is an explicit deployment action; the build script performs a dry run only. For a workers.dev trial, set `APP_ORIGIN` to that exact HTTPS address before testing browser management actions, then change it back for the custom domain.

PowerShell uses the same pnpm commands from your Windows project directory. Create browser environment values in a file using your editor; do not paste privileged keys into a browser build command. If Windows tooling cannot run package tests, use `wsl` and the WSL checkout path shown above.

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

The parent repository workflow `.github/workflows/nicx-router-monitor.yml` runs checks on changes in this platform. `nicx-router-monitor/.github/workflows/ci.yml` supports exporting this directory as its own repository. Deployment is manual via workflow_dispatch and the `production` environment. Configure environment protection/review if desired.

Repository variables are `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and, for a separate HTTPS API origin, `VITE_API_URL`. Deployment secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Scope the Cloudflare token to the intended account/Worker; custom-domain provisioning is done separately. Worker runtime secrets are provisioned once with Wrangler and preserved by deployments. Do not add the database service key as a frontend/Actions variable. Migrations remain an explicit reviewed operation and are not silently pushed on every frontend build.

Supabase project creation/account authorization, DNS changes and GitHub credential setup are not replaced with placeholder resources. Finish them before marking hosted acceptance complete.


## Version control and releases

The monitor lives in `nicx-router-monitor/` inside the existing firmware repository. Use a feature branch and pull request; `CONTRIBUTING.md` explains checks, package releases and append-only migrations. The parent workflow is authoritative here; the nested workflow is provided only for a future standalone export. Dependabot opens monthly dependency updates. Browser-safe build variables are configured in GitHub; Cloudflare deployment remains manual and needs a separately scoped Actions token. No runtime database secret is copied into GitHub. Telegram configuration is deferred; dashboard alerts continue to work without it.
