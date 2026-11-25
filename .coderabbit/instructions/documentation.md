---
id: monitor-documentation
name: Monitoring documentation accuracy
paths:
- docs/**
- README.md
- AGENTS.md
- CHANGELOG.md
- CONTRIBUTING.md
- '**/.env.example'
---

# Documentation and project guidance

- Check API/schema, collector, dashboard, configuration, install, deployment, security and troubleshooting claims against actual implementation and declared capabilities.
- Keep implementation checklist, decisions, resource budgets and limitations consistent. Distinguish planned/implemented/local-tested/hosted/installed/hardware-accepted states; no unsupported production-ready claims.
- Document compatibility changes, migration order, safe defaults, recovery, units, timezones, missing data and provider limitations. Label estimates and simulations explicitly.
- Verify environment examples use safe placeholders and actual variable names; never include real secrets or instruct users to disable verification. Preserve parent workspace boundaries in agent guidance.
