# Nicx Router Monitor

Scope: this directory only. The parent firmware workspace has unrelated user edits; preserve them. Do not modify the parent's OpenWrt tree or install anything on the physical router without an explicit request.

## Branch policy

| Branch | Purpose | Lifecycle |
| --- | --- | --- |
| `development` | Shared integration and the source of Development candidates. | Permanent. |
| `stable` | Source and component pins approved for production. | Permanent. |
| `router` | Legacy downloads for the installed firmware. | Retire after the replacement installer passes on hardware and the maintainer approves. |
| `codex/jidu6111-release-workflow` | Introduce the unified release tools and verify them. | Retire after the change is merged. |

- Record each new branch's purpose, dependencies and retirement condition. Use separate worktrees and target regular monitoring PRs at `development`.
- Send selective production promotion PRs to `stable`. Follow the release procedure before deploying or recording the change as Stable.

## Architecture and conventions
- pnpm workspace; React/Vite dashboard, Hono Worker, shared Zod wire schema, PostgreSQL migrations, BusyBox ash agent and LuCI packages.
- No inbound router access, remote shell, direct database credentials on routers, sample data in production, or disabled TLS checks.
- UTC in storage; display Asia/Kolkata by default. Unsupported values are null/absent with capability explanations.
- Keep common gauges typed and extended diagnostics sparse JSON. Publish only device_latest through Realtime.
- All privileged database functions are service_role-only, fixed search_path, and use atomic transactions. Every user-visible relation has RLS.
- Credentials: random 256-bit bearer tokens, SHA-256 hashes in PostgreSQL, short-lived one-use enrollment, explicit revocation/rotation. Never log tokens.
- Runtime state and bounded queues are /tmp only. Reading diagnostic files must use allowlists, size limits and timeouts; never write debugfs settings.
- Tests must distinguish fixture simulation, host measurements and actual-router evidence. Do not claim deployment or device benchmarks without evidence.
- Use docs/implementation-checklist.md and docs/decisions.md for progress and design decisions. Update actual limitations as features are implemented.
- Validation: pnpm test, pnpm typecheck, pnpm build, Python unittest for shell fixtures, PostgreSQL integration harness, and router benchmark on hardware when available.

## Delivery status
Core implementation and Cloudflare deployment are present. Supabase project whpnjrdsksgmtzgvaepx is Free/Mumbai, migrations001–006 applied and Cron verified. Cloudflare account02d66297ae254b05f52ec3795c717da9 hosts router.nicx.me. Backend uses modern SUPABASE_SECRET_KEY via apikey only; legacy fallback is compatibility-only. Workers requires redirect:manual with explicit non-2xx rejection, not redirect:error. Owner Auth user is created and public signup is disabled; the actual JIDU6111 is enrolled and sending real samples. Telegram setup is explicitly deferred by the owner. Release2 packages and the action-feedback dashboard are deployed; real snapshot request/receipt matching is verified. Controlled routing/Wi-Fi impact measurements remain pending. Tests/fixtures must never seed production. See docs/limitations.md and checklist; do not claim the full original definition of done.

Pre-merge review corrections are in source: migration007 adds cadence-aware alert continuity and safe active-rule device deletion; router release3 carries atomic snapshot caches and cadence metadata. These source changes have local regression/build verification and are distinct from the release2 installation/migrations001–006 hosted acceptance above. Treat docs/deployment-state.json as historical evidence. Read the live systems and the owner-only promotion record before claiming rollout.
