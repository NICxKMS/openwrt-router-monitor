---
id: monitor-resource-efficiency
name: Resource budgets and benchmarks
paths:
- openwrt/**
- apps/**
- supabase/**
- packages/shared/**
- benchmarks/**
- scripts/estimate.ts
- docs/resource-budgets.md
- pnpm-lock.yaml
- '**/package.json'
---

# Resource efficiency

- Account for the JIDU6111's 512 MB physical RAM, documented default 2 MiB runtime state, 10-second samples and 30-second uploads. Keep queues, work buffers, collectors, requests and retries bounded. Assess temporary peaks, tmpfs blocks, subprocesses, CPU, network and flash writes.
- Evaluate sparse payloads, batching, retention, raw row caps, rollups, indexes, archive budgets, Cron invocation count, egress, Realtime fanout and hidden-tab polling. Avoid mandatory paid services and unbounded work. Check current docs before citing provider limits; estimates are not actual billing.
- Check dependency necessity and lockfile consistency, bundle growth, Worker execution and package size; avoid style edits to generated lockfiles.
- Benchmark comparable workloads, firmware, hardware and time windows; distinguish shared/private RSS, kernel reservations, slab, zram and tmpfs. No unsupported attribution, extrapolation or claims of hardware-tested performance. Benchmark harnesses must be bounded and non-disruptive.
