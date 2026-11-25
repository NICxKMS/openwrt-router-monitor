---
id: monitor-database
name: Supabase database and migrations
paths:
- supabase/**
- tests/database/**
---

# Database and migrations

- Check owner RLS, anonymous/authenticated permissions, private credential tables, service-role-only privileged functions, fixed SECURITY DEFINER search_path, explicit grants/revokes, SQL injection and cross-owner isolation.
- Verify atomic one-use enrollment, token rotation, rate limiting, ingestion dedupe, boot/sample uniqueness, constraints, cascade behavior, concurrent maintenance/ingestion and correct receipt vs observation ordering. Retries must not double-count samples or bandwidth.
- Check rollup continuity, coverage, retention, bounded delete/query batches, indexes, bloat, archives, deletion queues, active alert transitions, cadence-aware continuity, hysteresis and cooldowns.
- Keep applied migrations immutable unless an explicit safe migration plan says otherwise. Check fresh and existing DB upgrades, ordering, dependencies, locks, rolling compatibility and recovery from destructive changes.
- Distinguish logical byte budgets from provider physical storage; DELETE does not immediately shrink allocated storage. Distinguish local PGlite/Postgres tests from hosted acceptance; never use destructive fixtures on production.
