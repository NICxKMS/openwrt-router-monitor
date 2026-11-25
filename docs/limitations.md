# Compatibility and explicit limitations

## Firmware matrix

| Environment | Evidence | Still required |
| --- | --- | --- |
| Existing JIDU6111 community6.18.60 source/SDK |Release 2 installed and enrolled; real metrics, logs, LuCI feedback, snapshot receipts and initial CPU/RSS/buffer observations verified; release 3 packages built |Release 3 rollout, controlled forwarding/Wi-Fi tests, unique memory attribution and long-term quota observation |
| Native BusyBox ash/awk1.37 host |46 router/host checks and actual host jshn sample generation |This is not the AArch64 router's RAM/CPU/forwarding measurement |
| Other OpenWrt snapshots |Runtime detection and userspace-only recipes |Build against matching feeds and test capabilities; no blanket compatibility guarantee |
| Hosted Supabase PostgreSQL17 |Migrations, RLS catalog, private Storage bucket, Realtime publication, successful Cron execution |Storage HTTP archive delivery, live subscriber and recipient delivery tests (Telegram deferred) |
| Local embedded PostgreSQL |Real roles/RLS/functions and correctness tests |Multi-connection lock races and provider behavior |

## Requested capabilities that remain unavailable or narrower

The core monitoring pipeline is implemented, but the full original specification is not a claim that every optional diagnostic is supported. The following are explicit limits, not placeholder collectors:

- No firmware-specific PPE/offloaded-connection counter integration was established. Hardware-offloaded Linux counters may be incomplete; offload is never disabled by monitoring.
- No ath11k WCSS/QMI/DMA/ring allocation attribution or debugfs driver snapshots are implemented. Unsafe/expensive driver controls are not touched. Firmware failures can be observed through delivered logs, not guaranteed crash dumps.
- Selected slab cache/fragmentation/buddyinfo/zoneinfo, reserved-memory attribution, per-process time-series profiling and kernel allocation ownership are not collected. Standard meminfo, PSI/vmstat, bounded process RSS and service presence are available.
- Wi-Fi client counters/signals/rates are bounded snapshots with salted identifiers, not complete roaming/association history, all MCS/NSS/GI details or every radio's firmware counters. Unknown/missing fields stay unknown.
- DNS/adblock integrations currently report available service/probe status; no package-specific query/cache/block-count API is claimed without a verified implementation. DNS browsing logs remain disabled. Adblock reload memory timelines are not implemented.
- VPN/SQM/PBR/multi-WAN package presence/status is narrower than a dedicated collector of every handshake, transfer and qdisc statistic. No private key/configuration dump is uploaded.
- Per-client-by-uplink Internet accounting is not implemented. Ethernet WAN and USB WAN interface totals are separate. Deltas crossing UTC midnight are assigned to the observation end day; billing cycles currently use UTC dates.
- Internet probes provide reachability, coarse DNS timings and two-probe min/max spread. They cannot conclusively identify an ISP outage, and no bandwidth speed-test engine is implemented.
- Firmware comparison uses equivalent retained raw uptime windows and common metrics with confounder warnings. It does not establish causation or retain rich per-client/process detail for a year.
- Alerts cover offline/maintenance gaps, configured common/derived thresholds, repeated reachability failures, monthly quota, reboot/OOM/ath11k log events. Statistical memory-leak classification and every package-specific anomaly rule are not implemented.
- Telegram supports one configured owner-bound destination; email and per-user destination provisioning are not implemented. Notification delivery is at least once, with bounded retries.
- Logs use bounded server-side pagination (50 rows/page), grouping and export, not an unbounded browser log stream. Query results can have missing intervals because buffering and severity filtering deliberately drop data under pressure.
- No automatic bulk old-log archive export, provider billing API collection, percentile sketches, partitioning, native C agent or installable PWA is implemented. These require demonstrated benefits before adding complexity.

## Operational limits

Cloudflare/Supabase free plans have finite resources and no guarantee of uninterrupted monitoring. Application logical-byte budgets and retention reduce consumption but are not a substitute for provider usage/billing meters. No seven-day rich10-second history promise is made inside500 MB.

No automatic cloud-to-router commands or snapshot triggers exist. All local actions use fixed allowlisted operations in LuCI. Remote configuration can adjust bounded monitoring policy, never networking, shell commands, endpoint or credentials.

RAM buffering cannot survive an unexpected reboot. A kernel panic/OOM/power cut may prevent final logs from reaching userspace/cloud. Clock-unsynchronized timelines and the chronology of never-seen old boot IDs can be inferred from receipt/uptime and must be interpreted as estimates. Host fixture data is isolated from production; the hosted project has no fabricated telemetry or enrolled sample routers.

Do not mark the physical-router and end-to-end acceptance checklist complete until these checks are performed with the actual router, owner account and delivery destination.
