# Implementation plan

User supplied a detailed twelve-phase specification and authorized autonomous implementation. This plan decomposes independent components with docs/contracts.md as their boundary; reviews and integration are sequential after each component arrives.

1. Establish shared schema and tests: reject oversized/unknown configuration, preserve missing values, exact counters, redact secrets, export safe CSV. Run `pnpm test tests/shared` and `pnpm typecheck`.
2. Implement migrations and real PostgreSQL integration tests: verify owner isolation, one-use enrollment, duplicate retries, out-of-order state, reset-safe sums and null-aware rollups. Keep SQL function grants service-only. `pnpm test:database`.
3. Implement Hono routes and tests with injected HTTP transport: cap streamed bodies, validate credentials, fail closed, restrict CORS, call atomic RPCs, avoid returning database secrets. `pnpm test tests/worker`.
4. Implement router collector/buffer/HTTPS lifecycle and packaging under openwrt/. Exercise fixtures and outage behavior using Python host tests. Cross-build userspace packages in the matching SDK when available. `pnpm test:router`.
5. Implement dashboard against real database relations, without embedded fake statistics. Test auth/config/empty/errors, exports and history selection. `pnpm --filter @nicx/dashboard build`.
6. Integrate local Worker→PostgreSQL using real SQL RPC adapter in tests, then agent envelope through Worker. Verify retry deduplication and token rejection.
7. Review security boundaries and retention/notification correctness. Run all tests, build, typecheck and package checks; fix findings and rerun affected checks.
8. Publish reproducible setup/upgrade/backup/operations docs and CI. Keep cloud deployment and actual-router performance as explicit external acceptance items until accounts and hardware are available.

Each component owns disjoint files during implementation. No changes to parent firmware files, no cloud writes, no credentials committed, no physical router changes.
