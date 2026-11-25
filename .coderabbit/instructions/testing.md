---
id: monitor-testing
name: Regression tests and validation
paths:
- tests/**
- '**/*.test.*'
- '**/*.spec.*'
- '**/vitest.config.ts'
- '**/playwright.config.ts'
- package.json
---

# Regression validation

- Require meaningful assertions and deterministic tests of changed behavior, not mock-only implementation detail. Avoid weakening assertions, fixed sleeps, skipped failures or production fixture writes.
- Cover relevant unauthorized/cross-owner access, invalid input, duplicates, resets/reboot, NTP failure, outages, queue saturation, missing capabilities, migration/retention, stale frontend responses and credential rotation.
- Browser tests should cover real user workflows, responsive layout, keyboard use, confirmations and pending/error states with semantic locators and outcome assertions.
- Router fixtures should reflect BusyBox/procfs behavior, missing utilities, bounded reads, log privacy and failure paths. Database tests should verify grants, constraints, isolation, concurrency and idempotency.
- Use the documented pnpm test, typecheck, build, test:router, test:database and test:browser commands as appropriate. Distinguish host tests from actual-router and hosted cloud evidence; do not claim tests were executed without evidence.
