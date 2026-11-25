# Router installation and operation

Release 2 was installed and enrolled on the JIDU6111 on 25 November 2026. The router sent real telemetry, and an initial CPU, RSS and buffer observation is documented in the benchmark report. Controlled routing and Wi-Fi tests and long-term quota observation remain pending. It uses the router's BusyBox ash, awk, ubus and JSON shell library; no Python, Node.js or database credential is installed on the router. The web dashboard and Worker are separate deployments.

## Build the two packages

Use an OpenWrt checkout/SDK matching the installed firmware's target and feeds. These two packages are architecture independent; their curl, rpcd, TLS, JSON and coreutils dependencies still need the firmware's compatible feed. Installing from an unrelated snapshot feed is unsafe. This project does not replace the parent's firmware configuration or automatically run a firmware build.

Copy or symlink these directories into the SDK's `package/` directory:

```sh
ln -s /absolute/path/nicx-router-monitor/openwrt/nicx-telemetry package/nicx-telemetry
ln -s /absolute/path/nicx-router-monitor/openwrt/luci-app-nicx-telemetry package/luci-app-nicx-telemetry
make menuconfig
# Network: nicx-telemetry; LuCI applications: luci-app-nicx-telemetry
make package/nicx-telemetry/compile package/luci-app-nicx-telemetry/compile V=s
```

The LuCI recipe resolves `feeds/luci/luci.mk` from the SDK. Have the matching LuCI feed installed before compiling. Runtime dependencies are curl, ca-bundle, jshn, jsonfilter, ubus, uci, rpcd and coreutils-stat. coreutils-stat is explicit because this workspace's target BusyBox configuration disables the stat applet. The optional iw package enables Wi-Fi station/survey statistics. Missing ping6/nslookup/iw capabilities are omitted or labeled unavailable.

Install both resulting APKs using the firmware's trusted local APK installation method and matching dependency feed. Packages are disabled until enrollment and configuration; installation does not change WAN, firewall, Wi-Fi or routing settings. rpcd must discover the new exec object; restart rpcd after installing the package, then reload LuCI. Do not reload networking for telemetry.

## Connect in LuCI

Open Services → Router telemetry. Enter the Worker HTTPS origin, for example `https://router.example.workers.dev`, without a path or trailing slash. In the dashboard create a short-lived enrollment token, then choose Enroll router and paste it. Enrollment includes the read-only board model when available. A successful enrollment saves the device ID and a random device credential privately. Enable telemetry and use LuCI's normal Save & Apply. The Restart telemetry button restarts using saved settings.

Use Test connection to verify the saved origin, TLS and device authentication. It does not change networking. A failure can mean DNS, incorrect time, TLS, unreachable Worker or invalid credentials. A failed upload alone does not prove an ISP outage.

For token rotation, rotate the existing device in the dashboard and copy the returned credential into Replace rotated credential in LuCI. This writes a mode600 file atomically; there is no token read API. It preserves the router ID. Do not enroll again merely to rotate a key: enrollment creates a new device. If you deliberately enroll this router into another device/account, enrollment restarts an already enabled agent with its new identity. Old RAM observations are discarded rather than sent to the new account. If the fixed service restart fails, LuCI explicitly asks you to restart telemetry; the credential remains saved.

The credential is `/etc/nicx-telemetry/token`, directory mode700 and file mode600. A local random mode600 privacy salt produces opaque Wi-Fi client IDs. The credential is passed to curl through a private temporary curl configuration, not through command arguments. Neither credentials, full UCI configuration, SSIDs nor DNS query history are exported. Enrollment/rotation input travels over the authenticated local LuCI RPC session; operate LuCI over a trusted connection.

## Collection and privacy

Defaults are system samples10s, upload30s, Wi-Fi30s, process RSS60s, extended memory/thermal/storage/service detail300s and optional reachability probes30s. Probes are enabled in the shipped UCI configuration and can be turned off: they send two pings each to the configured IPv4/IPv6 targets and the current IPv4 gateway, plus one fixed `example.com` DNS lookup. Telemetry itself only uses outbound verified HTTPS to the configured Worker; no inbound listener, remote shell or Worker-supplied command exists.

Adaptive sampling is enabled locally by default. Three consecutive observations of CPU≥90%, available memory<5%, or queue fill>80% trigger protection. System collection slows to three times the configured interval, at least30s and never more than300s. Slow collector intervals double within their normal safety ceilings; internet probes become60s. Six consecutive observations of CPU<70%, memory>10% and queue fill<50% restore normal cadence. You can disable this in LuCI. Status shows the effective interval and pressure reason. Upload success/failure counters count completed attempts during this agent process lifetime, including local credential/transport rejection. The local RSS and peak RSS read the parent process VmRSS/VmHWM; CPU is that parent user+system tick delta divided by all machine CPU ticks. The first CPU observation is null, no clock-tick frequency is guessed, and curl/collector children are explicitly excluded. Initial hardware observations included parent and process-tree RSS and sampled CPU ticks. Controlled forwarding and Wi-Fi overhead and unique memory attribution remain pending.

Slow collectors and uploads run separately so network timeouts do not hold up the normal sample loop. Each collector has at most one active invocation. Source commands have2–5s timeouts, upload connection timeout8s and total timeout20s. Sample age and byte-rate elapsed time use kernel monotonic uptime; sample timing can still vary with CPU load and the short interface lookup.

Common memory breakdown also appears in `detail.meminfo` each sample for the latest dashboard view; slow PSI/vmstat remain under `detail.memory`. Only newly collected slow groups accompany a sample. `detail_uptime_s`, `processes_uptime_s`, `wifi_uptime_s` and `connectivity_uptime_s` label their observation age. This keeps ordinary samples small and prevents repeating the same rich JSON every10s. Cloud configuration may increase/decrease intervals within local UCI frequency floors and fixed safety limits, and may disable/restore locally permitted log export. It cannot set an endpoint, privacy exception, probe address, file path or command.

Logs start at the current log position with `logread -f`; the existing ring is never replayed. Credential-bearing messages are entirely replaced; IP/MAC/IPv6 addresses are removed unless locally opted in. DNS query/reply/forwarding and URL-like records are always omitted. Non-ASCII log characters become `?` so byte truncation cannot create malformed JSON. Repeated redacted messages are grouped in5s windows, with100 qualifying occurrences/window and12 distinct groups/window maximum. Twenty percent of the occurrence budget is reserved for later critical messages; critical groups can replace a lower-priority group in a full map. Output staging has four16KiB slots. Severity0–3 groups are sent before lower-severity records; low-priority queued logs are discarded before samples and critical logs under pressure. Burst filtering and occupied staging slots increment dropped-log occurrences. Disabling log export or tightening address privacy clears staged and queued logs; an immutable pending batch containing logs is discarded with counted drops rather than sent under the new policy.

UTC log first/last timestamps are only populated once a real BusyBox ntpd synchronization hotplug event has been observed. Otherwise log and sample wall timestamps are null, with boot ID, sequence and monotonic uptime retained. ntpd `unsync` clears this quality marker. Installing after an earlier synchronization can conservatively report unverified until the next event. An incorrect clock may also prevent TLS validation: the agent queues until time is repaired and never bypasses certificate checks.

The maximum buffer setting defaults to2048KiB and is limited to1024–2048KiB.512KiB is reserved for the immutable pending body, bounded log staging and collector/serialization work files; the default disk-block-accounted queue cap is1536KiB. State stays in `/tmp/nicx-telemetry`, mode700. The cap is a telemetry buffer limit, not a promise that total shell/curl/library process RAM is2MiB. RAM is never written to persistent history and disappears on reboot. Only UCI and credential/salt files persist and are included in the sysupgrade keep list.

Batches contain at most12 samples,100 grouped logs and80,000bytes of selected record content, with separately bounded inventory/diagnostic overhead below the96KiB wire limit. A retryable batch keeps its UUID and exact bytes for retries. The queue advances only after HTTP200 with `accepted:true`. A batch with diagnostics additionally requires a matching explicit diagnostic disposition: true confirms storage, false records a terminal rejection, and missing/null/mismatched acknowledgment keeps the batch pending. Deploy the diagnostic-receipt database migration and Worker before installing this agent update; an older backend cannot confirm snapshot storage. Critical queued logs may advance the next upload once at least15s has elapsed since the last success, only when there is no pending batch, in-flight upload or error backoff. They never bypass a429/authentication/network retry delay. Backoff starts at5s, doubles to900s and adds up to25% random jitter.401/403,429,5xx, malformed responses and failed TLS retain the batch. A permanently rejected HTTP400/413 body is counted and discarded so it cannot block all later health and critical logs; only a tiny rejection reason/count remains in RAM. There is no special insecure recovery path. Queue item drops are reported in `dropped_samples` (historical contract name; includes discarded log groups); burst occurrence drops are shown separately in local status.

Every local action shows immediate inline progress and prevents a duplicate click while its request is pending. The success or failure stays beside its button; a lost RPC connection is labeled unconfirmed rather than claiming the action failed or completed. Enrollment and credential dialogs retain pending/error feedback and clear secret inputs. The normal Save & Apply flow remains LuCI's settings apply mechanism.

Snapshot feedback distinguishes queued locally, uploading, waiting to retry, uploaded and failed. Each accepted local request gets a kernel-generated UUID in its diagnostic payload and RAM status. A second request is rejected while the first is queued/uploading/retrying. Five-second polling updates the visible result. Uploaded requires HTTP200 with accepted:true, diagnostics_accepted:true, and diagnostics_request_id matching the queued UUID; generic metric acceptance alone is insufficient. An explicit storage-budget rejection marks the snapshot failed. A missing, historical/unknown or mismatched receipt preserves the exact pending body and waits for a verifiable acknowledgment; it does not mean an archive object was created. Authentication, rate-limit and network failures remain waiting with a reason. Rejected/discarded batches and revoked permissions become failed. Completed status survives a service restart in RAM; reboot clears it along with the buffer. Polling can reconcile a newer request made in another browser or after an unconfirmed RPC response, while older results cannot overwrite a newly queued request. No progress percentage or completion timer is invented.

Snapshots require both the local opt-in and dashboard/cloud diagnostics permission. The cloud permission starts denied until a successful configuration response confirms it. They are requested locally in LuCI; disabled permissions are reported explicitly. The allowlist is cached memory/detail, interface counters, Wi-Fi summary, or a bounded installed-package list. The sender checks both permissions again when sealing a batch. No arbitrary file or executable can be supplied. There are no debugfs snapshots, no debugfs mounts/writes and no enablement of driver tracing.

## Verification and remaining acceptance

Run host fixture checks from the project root:

```sh
python3 -m unittest discover -s tests/router -v
# To use an available native BusyBox:
NICX_BUSYBOX=/path/to/native/busybox python3 -m unittest discover -s tests/router -v
python3 tests/router/export_sample.py > /tmp/nicx-router-sample.json
```

Envelope/RPC tests use the native jshn already built under the parent's OpenWrt host staging directory, with temporary mock ubus/UCI/curl and actual host `/proc` reads. Those tests explicitly skip if jshn is absent; the CPU/counter/log/security fixtures remain runnable. AArch64 router binaries cannot be treated as native host test tools. See `benchmarks/README.md` for read-only actual-router measurements.

Hardware acceptance still includes follow-up service-state/Wi-Fi fixes, firmware-specific LuCI apply and enrollment/rotation behavior, both snapshot permissions, USB reconnection gaps, complete station/survey availability, buffer RSS/CPU measurements, outage/reboot recovery and matched forwarding throughput/latency. The existing live samples confirm baseline operation, not all of these cases. Host fixtures do not prove these outcomes.

## This workspace

The signed build artifacts are in artifacts/openwrt/ and the parent combined feed. From the parent firmware workspace, run make install-packages and search nicx to select both packages. The existing installer verifies the board, full kernel and signing key and simulates the package plan before installation. User confirmed JIDU6111 at192.168.50.1, kernel6.18.60 and APK. No firmware flashing is needed for these userspace packages. Release 2 installation and its matching cloud snapshot receipt were verified on this router. The existing signed artifacts are release 3. The review fixes are in release 4 source and need a fresh signed build before installation.

When building through direct make command-line module overrides instead of menuconfig, explicitly build the stat dependency too:

```sh
make package/feeds/packages/coreutils/compile CONFIG_PACKAGE_coreutils-stat=m
make package/index package/merge-index
```

From the monitoring project, run `python3 scripts/verify-openwrt-feed.py --source /path/to/openwrt` to check the signed feed and install the selected dependency archives into an isolated temporary APK root with package scripts disabled before offering the feed to a router.
