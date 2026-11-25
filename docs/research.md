# Verified research and sources

Reviewed 25 November 2026. Provider limits and library releases can change. The lockfile records resolved dependency versions; rerun the package manager audit before upgrades. No cloud quota can guarantee uninterrupted service on a free plan.

## Cloudflare

[Official Worker limits](https://developers.cloudflare.com/workers/platform/limits/): Free currently 100,000 invocations/day, 10 ms CPU/request, 128 MB memory, 50 subrequests/request, 5 Cron Triggers/account; 20,000 static asset files and 25 MiB/file. [Static assets](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) are free and unlimited when served directly. Only /api/* runs the Worker first. The dashboard is a static SPA; private telemetry requires authentication at the data layer. One 30-second upload costs 2,880 daily invocations, plus 1,440 minute cron invocations, management and other usage. No Worker invocation is used for every browser chart refresh.

[Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/) uses UTC and supports a scheduled handler. [Rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) is approximate per Cloudflare location. Strict device limits live in PostgreSQL; the binding reduces unauthenticated abuse but cannot protect the account's entire daily quota against a large distributed attack. Select an otherwise unused namespace ID if6111 is already used in your account.

## Supabase

[Billing](https://supabase.com/docs/guides/platform/billing-on-supabase): Free includes500 MB database/project,1 GB object storage,5 GB uncached egress,50,000 MAU,500,000 Edge Function invocations,2 million Realtime messages/month and200 peak Realtime connections. [Cached/uncached egress](https://supabase.com/docs/guides/platform/manage-your-usage/egress) have separate quotas; private database and Realtime traffic should be budgeted conservatively against uncached egress. The design uses no Edge Functions. [Free database compute](https://supabase.com/kb/faqs/platform/database-only-cost) uses shared CPU/500 MB RAM; two active free projects are available. Pausing and absence of a free SLA remain operational limits.

[Realtime Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes) respects RLS; only device_latest is published. [Realtime limits](https://supabase.com/docs/guides/realtime/limits) include100 messages/second on Free. Subscribers multiply outgoing message counts.1 router×2,880 updates/day×30 days×1 viewing client ≈86,400 updates/month while continuously viewed, before other protocol messages. The app unsubscribes while hidden or paused and polls on a bounded interval.

[Supabase Cron](https://supabase.com/docs/guides/cron) / [installation](https://supabase.com/docs/guides/cron/install) exposes pg_cron; maintenance SQL avoids TimescaleDB and unsupported extensions. [Database size](https://supabase.com/docs/guides/platform/database-size) and PostgreSQL [vacuum](https://www.postgresql.org/docs/current/routine-vacuuming.html) explain why deleting old rows does not immediately shrink allocated files. No paid PITR/backups are assumed. Export encrypted backups yourself. [Regions](https://supabase.com/docs/guides/platform/regions): Mumbai ap-south-1 is offered; Singapore ap-southeast-1 is an alternative if capacity prevents Mumbai. Choose at creation; changing region requires migration.

Supabase's [Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits) mean the default shared email sender is unsuitable for unrestricted production signup. Provision your owner user, disable public signup, use password login over TLS, and configure your own SMTP if you need email recovery/invitations. No production email delivery is claimed.

## OpenWrt and Linux

The official wiki returned Anubis access denial from this environment, so conventions were verified against actual source: parent openwrt/package/base-files/files/lib/functions/procd.sh and built root /lib/functions/procd.sh, libubox sh/jshn.sh, ubox log/logread.c, rpcd exec.c and existing LuCI JS applications and ACLs in openwrt/feeds/luci. Public source mirrors: [procd](https://git.openwrt.org/project/procd.git), [rpcd](https://git.openwrt.org/project/rpcd.git), [LuCI](https://github.com/openwrt/luci), [firewall4](https://github.com/openwrt/firewall4). Runtime detection remains mandatory on other snapshots.

[JIDU6J11 support PR26498](https://github.com/openwrt/openwrt/pull/26498) and the local JIDU6111 DTS/profile identify the community family. This is not evidence that every mainline OpenWrt release supports this board. The existing workspace uses Linux6.18.60 and model-specific calibration. The monitoring packages contain userspace scripts only and do not change drivers/calibration/kernel configuration.

Linux [proc documentation](https://docs.kernel.org/filesystems/proc.html) defines memory/process counters. CPU utilization excludes guest fields already counted in user/nice. MemAvailable estimates reclaimable memory; reserved hardware memory is not inferred from a difference against the512 MB product specification. Vmalloc, RSS, slab and DMA figures can overlap and must not be summed into a fictional driver total.

ath11k source inspected: backports-7.2/drivers/net/wireless/ath/ath11k/debugfs.c in this workspace. It creates soc_dp_stats and fw_stats/{pdev_stats,vdev_stats,beacon_stats} conditionally, and also dangerous writable controls such as simulate_fw_crash. The monitor never writes or blindly reads these controls. No fixed per-driver kernel allocation counter or universally supported PPE path was established. Do not attribute all unreclaimable slab to ath11k. Optional bounded read-only snapshots report capability and evidence, not guessed allocations.

dnsmasq supports some counters only with build/runtime options; domain/client query histories stay disabled. adblock-fast and https-dns-proxy integration were checked against the installed packages' init scripts and LuCI API. Service presence does not imply blocked-query counters. `wg show ... latest-handshakes/transfer` can safely expose selected public status; `wg show ... dump` includes private keys and must never be uploaded. SQM/tc output depends on optional installed tools. nftables/software counters may omit hardware-offloaded traffic.

## Application dependencies

Live npm registry queries returned Hono4.13.22, Zod4.6.7, React19.3.1, Vite8.3.8, Tailwind4.3.5, ECharts6.1.0, Supabase JS2.119.2 and Wrangler4.168.0. Vite8 requires a compatible React plugin6; the install peer conflict was corrected. Node22.22.1 meets the inspected supported engine ranges. TypeScript5.9.3 is deliberately pinned for consistency between packages instead of upgrading the entire project to the new7 release during initial implementation.

Primary library guidance: [Hono](https://hono.dev/docs), [Vite](https://vite.dev/guide/), [Tailwind Vite integration](https://tailwindcss.com/docs/installation/using-vite), [shadcn Vite integration](https://ui.shadcn.com/docs/installation/vite). Charts use selected ECharts modules and local UI primitives; no external font/CDN request is needed.

Modern Supabase keys were verified against https://supabase.com/docs/guides/getting-started/api-keys : production uses a browser publishable key and backend sb_secret key on apikey, not legacy JWT API keys. Current Workers request documentation https://developers.cloudflare.com/workers/runtime-apis/request/ confirms only follow/manual redirect modes; error throws before transport. Backend calls use manual and reject redirects rather than forwarding credentials.
