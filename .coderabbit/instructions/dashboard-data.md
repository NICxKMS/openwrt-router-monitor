---
id: monitor-dashboard-data
name: Dashboard data and chart correctness
paths:
- apps/dashboard/src/lib/**
- apps/dashboard/src/components/**
- apps/dashboard/src/pages/**
- apps/dashboard/src/App.tsx
---

# Data access, charts and actions

- Check auth/session lifecycle, owner and device scoping, Realtime subscription cleanup, hidden/paused behavior, bounded polling, cancellation, stale response races, cache invalidation and errors. Avoid unnecessary requests/rerenders; only device_latest is published by current design.
- Ensure switching routers or time ranges cannot display another device's stale responses. Verify bounded history, resolution choice and cursor pagination.
- Check unit conversions, timezones, counter resets, coverage, extrema, missing values and aggregation. Distinguish sample-weighted means from time-weighted means, adaptive cadence from uniform sampling, and unknown gaps from real zeros.
- Match diagnostic/action receipts to request, device and operation; acceptance is not completion. Ensure pending, timeout, failure and success states are accurate and duplicate actions are prevented.
