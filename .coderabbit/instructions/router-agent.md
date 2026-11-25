---
id: monitor-router-agent
name: OpenWrt telemetry agent
paths:
- openwrt/nicx-telemetry/**
---

# Router agent and collectors

- Review extensionless init/hotplug/rpcd scripts, UCI, upgrade keep files, shell and AWK. Require BusyBox ash and declared dependencies; inspect quoting, injection, signals, cleanup, locks, atomic writes, private temporary files, procd supervision and exit handling.
- Bound subprocesses, output, reads, queue size, retry backoff, upload timeout and temporary peak allocations. Keep runtime state in /tmp; account for filesystem blocks and overlapping work. Do not continuously write telemetry to flash.
- Review enrollment, token rotation, revocation, NTP/unsynced clocks, WAN loss, reboot, partial uploads, duplicate receipts and resource exhaustion. Fail independently of netifd, firewall, dnsmasq and Wi-Fi. Never introduce arbitrary remote execution or debugfs writes.
- Verify CPU deltas excluding double-counted guest time, MemAvailable vs MemFree, reclaimable/unreclaimable slab, swap/zram, monotonic elapsed time, 64-bit counter precision, resets and interface recreation. Keep WAN and USB WAN separate. Preserve missing values rather than zero.
- Verify boot identity, log severity/grouping/cursors, sparse diagnostic payloads, capability detection, privacy filtering, bounded allowlisted reads and accurate drop reporting. No full log replay or fabricated ath11k attribution.
- Check package install/upgrade/uninstall, permissions and backward compatibility. Require representative router evidence for resource or stability claims; fixture tests are not hardware tests.
