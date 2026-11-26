# Collector contract and capability boundaries

All common observations use schema_version1 in `docs/contracts.md`. Missing required gauges are null; unsupported optional measurements are omitted. A zero is only a measured zero. Collection runs on the router, not in a cloud process querying its LAN.

| Collector | Default cadence | Actual source and computation | Limits / unavailable behavior |
|---|---:|---|---|
| Aggregate and per-core CPU |10s|`/proc/stat` deltas, fields user through steal; idle includes iowait; guest fields are not added a second time|First sample, decreasing counters or invalid total delta produce null. Per-core utilization is in `detail.cpu.cores`; state vectors cover the first 16 cores. CPU states split guest/guest-nice from user/nice. Scheduler and IRQ totals are decimal strings|
| Load / common memory |10s|`/proc/loadavg`; MemTotal, MemAvailable, MemFree, Cached, Slab, SReclaimable, SUnreclaim from `/proc/meminfo`|Availability is a kernel estimate, not simply free+cache. No invented reserved-memory/slab attribution|
| Interface traffic |10s|`ubus call network.interface.{wan,usbwan,lan} status`→routed `l3_device`; sysfs byte counters and link identity|Absolute counters are decimal strings; decimal subtraction precedes numeric conversion. Unsafe deltas, counter decrease, identity changes or missing observations produce null/reset. WAN and USB WAN remain separate; LAN is excluded from aggregate WAN|
| Processes |60s|12 largest RSS values, with proportional RAM and swap from `smaps_rollup` for up to eight. Eight busiest tasks from `stat` CPU deltas keyed by PID and start time|RSS includes duplicate shared pages. PSS divides them among users. CPU is a share of total machine time and can miss tasks that exit between samples. No command lines or environment|
| RAM accounting |300s|Kernel-managed RAM, free, anonymous, shared/tmpfs, disjoint file cache, buffers, slab, stacks, page tables and other measured buckets. Also device tree RAM and named static reservation sizes|The signed counter difference is the amount these counters cannot reconcile. Device tree ranges are a separate view. Physical addresses are excluded|
| Kernel memory detail |300s|Top 12 accurate allocation sites and top 12 slab caches by backing pages, zones and free-block orders, zram, swap, socket memory|Read-only and bounded. Fields depend on kernel support. Cache, allocation-site, socket and other diagnostic views can overlap|
| CPU detail |300s|CPU frequency policies and cumulative software interrupt counts by class|Frequency is the policy-reported value. A missing policy exposes no frequency readings|
| VM counters / PSI |300s|Selected pgfault, pgmajfault, swap, OOM and reclaim counters from `/proc/vmstat`; readable CPU/memory/IO pressure files|Cumulative VM/PSI totals are strings. A missing PSI file is unavailable, not zero pressure. Unreported values remain unavailable|
| Temperature / storage |300s|Up to16 thermal zones and `df -k` for `/overlay` and `/tmp`|Temperature range validated; thermal_zone0 is the common top-level temperature, without assuming its sensor label means CPU. No raw NAND writes or flash probing|
| Firewall / conntrack |300s|Conntrack count/max sysctls and two allowlisted UCI flow-offloading flags|Configured software/hardware offload does not prove hardware is currently forwarding flows. No conntrack table or firewall configuration export|
| Service health |300s|Persistent daemon `init.d SERVICE running` checks; firewall4 uses a bounded, read-only `nft list table inet fw4` presence check; AdBlock Fast uses only the allowlisted procd `data.status` enum; AdGuard Home uses its daemon status|A successful policy application is distinct from a persistent process. Missing nft/API, query failures and transitional/unknown AdBlock states are null, with `service_checks` explanations. Only an explicitly missing fw4 table or a known stopped/failed AdBlock status is false|
| Board / firmware inventory |Startup|Allowlisted `ubus system board`: model, kernel, release version/revision/target/description; agent version|Enrollment also sends the read-only board model when available. No serial, board MAC, hostname or complete ubus response. Stable inventory is carried in the boot envelope|
| Wi-Fi / stations / survey |30s|Optional `iw dev`, up to4 interfaces; station dump signal, byte strings, retries/failures/rates, up to24 parsed stations/interface and24 uploaded clients total; in-use survey active/busy/frequency/noise; interface frequency/width and global regulatory country|No assumptions about vendor PPE or ath11k private ABI. If iw is absent, explicit unavailable capability and empty radio list. Absent signal/byte/rate/retry fields stay absent; signal averages include only measured signals and an explicitly reported zero stays zero. Client count is capped to the parsed24/interface, client detail to24 total; per-client byte counters are not per-uplink accounting|
| Internet hints |30s|Background, two bounded pings per supported IPv4,IPv6 and current IPv4 gateway; one fixed `example.com` lookup|Family omitted if its tool is missing. Available means a probe executed, reachable reports result. ICMP filtering is not a diagnosed ISP outage; DNS time includes cache/local resolver work. Jitter is two-probe max-minus-min, not statistical jitter|
| Logs |Continuous /5s grouped flush|Current-position `logread -f`, severity0–7, local grouping after privacy filtering|100 occurrences/5s with20% reserved for later critical messages,12 groups/5s with low-priority eviction, four16KiB staging slots. Burst drops are counted. Trusted UTC first/last times only after NTP quality marker; otherwise null|
| Snapshots |Local explicit request only|Cached memory/detail, interface or Wi-Fi JSON; `apk info -v` or `opkg list-installed`, at most8KiB package text|Requires local diagnostics_enabled and current cloud diagnostics permission. Each request includes a UUID; RAM feedback tracks queued/uploading/retrying/uploaded/failed and rejects concurrent active requests. Uploaded requires accepted:true plus diagnostics_accepted:true and the matching diagnostics_request_id in the persisted server receipt. Explicit rejection is failed; unknown/mismatched receipt remains retrying with the immutable batch preserved. Only enum choices, never user paths/commands; entire diagnostic object remains below16KiB|

Core samples carry CPU, memory and interfaces each interval, with current breakdown gauges in the separate `detail.meminfo` group. Slow groups carry only when freshly collected, with separate monotonic metadata: `detail_uptime_s`, `processes_uptime_s`, `wifi_uptime_s`, `connectivity_uptime_s`. Latest views must preserve earlier slow groups and their timestamps when a subsequent sample contains only CPU and common meminfo. A history chart must not imply the slow groups were measured at every10s tick.

The `cpu.core_modes` arrays follow user, nice, kernel, idle, I/O wait, hardware IRQ, software IRQ, steal, guest, and guest-nice order. The sum is approximately 100% after rounding. `memory.accounting_kb` omits the difference if essential counters are missing. Swap-cache pages can have anonymous mappings and are shown separately in `memory.kernel_kb`. Firmware reservations, allocator attribution, and process PSS answer different questions and cannot be added to the RAM ledger.

A representative detail structure is:

```json
{
  "cpu": {"cores": {"cpu0": 12.5}},
  "memory": {"vmstat": {"pgmajfault": "21"}, "psi": {"memory": {"some": {"avg10": 0.2, "total": "125000"}}}},
  "processes": [{"name": "dnsmasq", "pid": 123, "rss_kb": 2048}],
  "wifi": {"available": true, "radios": [{"name": "phy0-ap0", "stations": 1, "signal_avg_dbm": -51, "frequency": 5180, "width_mhz": 80, "clients": [{"client_id": "opaque-local-salted-id", "signal_dbm": -51, "rx_bytes": "12345678901234567", "tx_bytes": "10", "tx_retries": 2, "tx_failed": 0, "rx_rate_mbps": 600, "tx_rate_mbps": 600}], "survey": {"active_ms": 1000, "busy_ms": 120, "noise_dbm": -95}}]},
  "connectivity": {"ipv4": {"available": true, "reachable": true, "latency_ms": 14.2, "loss_pct": 0, "jitter_ms": 1.4}},
  "firewall": {"conntrack_count": 123, "conntrack_max": 65536, "flow_offloading": true, "flow_offloading_hw": false},
  "services": {"dnsmasq": true, "https-dns-proxy": true},
  "thermal": [{"name": "thermal_zone0", "temp_c": 56}],
  "capabilities": {"psi": "available", "ppe": "unavailable: no stable driver-independent counter ABI"},
  "detail_uptime_s": 100,
  "processes_uptime_s": 100,
  "wifi_uptime_s": 100,
  "connectivity_uptime_s": 100
}
```

This example is documentation, not seeded production data. Raw IPs/MACs are not sent in Wi-Fi IDs. IDs use SHA-256 over a local256-bit random salt, the address and the salt again, truncated to128bits. If the salt or SHA-256 implementation is missing, client records are omitted. Names/SSID/lease hostnames are not collected, so a dashboard must use optional owner-provided client labels rather than reverse the IDs.

## Local firmware-source verification

The actual local build tree was inspected, rather than assuming a generic ath11k interface:

- `openwrt/build_dir/target-aarch64_cortex-a53_musl/ubox-2026.11.15~b0635f42/log/logread.c`, lines399–404, sets stream1 and lines0 when `-f` is used without `-l`. This starts with future messages instead of a full buffer replay.
- `openwrt/package/utils/busybox/files/ntpd-hotplug` forwards ACTION plus ntpd environment into hotplug.ntp; the local BusyBox `networking/ntpd.c` emits stratum, step, periodic and unsync events. The package hook uses stratum1–15 only.
- The target BusyBox `.config` enables awk, timeout, sha256sum and du but disables stat and od. coreutils-stat is therefore an explicit dependency; kernel random UUIDs supply retry jitter without od.
- `openwrt/build_dir/target-aarch64_cortex-a53_musl/linux-qualcommbe_ipq95xx/mac80211-regular/backports-7.2/drivers/net/wireless/ath/ath11k/debugfs.c` registers `fw_stats/pdev_stats`, `vdev_stats` and `beacon_stats`. Those code paths request firmware stats through `ath11k_mac_fw_stats_request`, and other debugfs entries control tracing or dump device memory. The agent does not read or modify them. No debugfs mounted-state assumption is made.

The local firewall4 init script applies/flushes rules through `fw4` and has no persistent daemon. AdBlock Fast1.2.4 source reads/writes `service.list {name:"adblock-fast"}`→`data.status`, with `statusSuccess`, `statusStopped`, `statusFail` and intermediate states. The collector reads only this enum, not the accompanying errors, messages, domains or configuration.

PPE acceleration metrics, complete attribution of all physical pages, dnsmasq query counters without query logging, per-client-by-uplink attribution and driver firmware crash dumps are currently unavailable. Their absence is intentional and must not be rendered as measured zero or active capabilities.
