---
id: monitor-architecture
name: Monitoring architecture and contracts
---

# Monitoring architecture

Review against AGENTS.md and docs/contracts.md, security.md, resource-budgets.md, decisions.md and current implementation. Treat documented defaults as current baselines, not immutable limits when a coordinated change is justified.

- Stack: React/Vite dashboard, Hono Cloudflare Worker, shared Zod contracts, Supabase Auth/PostgreSQL, BusyBox ash/AWK telemetry and LuCI. Trace router collection through schema, ingestion, persistence and dashboard display; consider mixed deployed versions.
- Outbound HTTPS only; no inbound access requirement, remote shell, arbitrary cloud commands, direct DB credentials on routers or disabled TLS. Monitoring failure must not disrupt networking.
- Keep telemetry bounded and inexpensive, runtime state in /tmp, no continuous flash writes, no compulsory paid/always-running infrastructure. Preserve separate device and owner credentials.
- Use UTC for storage and Asia/Kolkata as default display; unsupported measurements must be null/absent with capability context. Do not fabricate data or imply guaranteed crash capture.
- Distinguish implemented, locally tested, deployed, installed and hardware-verified states. Respect parent firmware scope and existing worktree changes.
