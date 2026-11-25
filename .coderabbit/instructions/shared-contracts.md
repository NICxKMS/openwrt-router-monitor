---
id: monitor-shared-contracts
name: Shared telemetry wire contracts
paths:
- packages/shared/**
- docs/contracts.md
---

# Shared schemas and compatibility

- Shared Zod validation is authoritative for the wire schema; check every producer and consumer for versioned fields, required/optional/null semantics, UUIDs, timestamps, ranges and unknown fields.
- Preserve decimal-string 64-bit counters and safe deltas, boot/session identity, monotonic elapsed time, receipt vs observation times and reset/unsupported handling.
- Verify array/body/nesting bounds and remote configuration allowlists. Current contract v1 caps include 12 samples, 100 logs, 96 KiB body and 16 KiB individual detail; confirm changes are coordinated with agent, Worker and database.
- Prevent incompatible changes during staggered upgrades. Require contract tests and migration/versioning strategy for intentional breaking changes. Avoid duplicated validators that diverge.
