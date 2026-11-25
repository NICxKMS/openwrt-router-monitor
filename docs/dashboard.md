# Dashboard

The dashboard is a private React 19 / TypeScript / Vite application. It uses a compact navy, cyan and amber instrument layout, with light mode, responsive navigation, visible keyboard focus and reduced-motion support. It never seeds devices or invents readings.

## Local setup

Copy `apps/dashboard/.env.example` to `apps/dashboard/.env.local` and set the Supabase HTTPS URL and browser-safe publishable/anon key. Set `VITE_API_URL` to the Worker origin when the API is hosted separately; omission uses the same origin. Build-time environment changes require a rebuild. A missing or placeholder Supabase URL shows a configuration page instead of a broken login.

Run `pnpm dev` from the monitor root. `pnpm --filter @nicx/dashboard build`, `typecheck`, and `test` validate this application. The output is `apps/dashboard/dist` and can be served by Cloudflare Pages or the configured asset Worker; no deployment is performed by the dashboard build.

Create owner accounts in Supabase Auth; there is no public sign-up flow. Disable public sign-up in the Supabase project. Configure the site's HTTPS origin and allowed callback URL in Auth. Password login uses the Supabase SDK; persisted sessions refresh automatically. The SDK uses PKCE with automatic callback detection for invited/magic-link sessions and reports Auth errors through the login form. Device tokens are never user-session tokens. Browser configuration must never contain a service-role key. Token-bearing enrollment and rotation results remain in memory, and are never written to dashboard preferences.

## Data access

All reads use the signed-in Supabase user and RLS. `devices` supplies the router selector, `device_latest` the current gauges, and the owner-scoped `history` RPC supplies automatically chosen raw or aggregated history. Realtime subscribes **only** to `device_latest`, filtered by the selected `device_id`. A 30-second polling fallback is configurable to 10/30/60/300 seconds. Hidden tabs unsubscribe and suspend polling. Pause removes the subscription and stops automatic refresh; the explicit Refresh button still works. Switching routers clears presentation of the previous router's metrics while the next query completes.

One shared time range applies to charts, logs, bandwidth records and diagnostics. For historical windows, gauge and sparse-detail panels use the last retained raw `metric_samples` observation within the selected effective-time window; the snapshot time is labeled. After raw retention expires, aggregates may remain available while sparse details are explicitly unavailable. Presets cover 15 minutes through 30 days. Historical/custom windows, timezone (Asia/Kolkata by default), appearance, polling preference and selected router persist in browser storage. Custom date-time fields explicitly use browser local time, then convert to UTC; all displayed timestamps use the selected display timezone. Charts have crosshairs, drag/scroll zoom and a range slider. ECharts is a lazy-loaded canvas module with only the required line-chart components. CPU history displays reported minima, maxima and means. Missing metrics remain null, and large time gaps break lines. CSV/JSON exports provide readable values without a chart; CSV protects against spreadsheet formulas.

The pages use these sources:

- Overview, CPU/system and memory: latest typed gauges, sparse CPU core, process, PSI, vmstat, filesystem, thermal and capability fields.
- Network: designated uplink counters and daily bandwidth records, with Ethernet WAN and USB WAN kept separate. Receive/transmit bucket charts show bytes per recorded bucket, not an assumed instantaneous rate.
- Wi-Fi: reported radio/survey/station aggregates. Individual client or station details appear only when the agent reports them.
- Internet/ISP: optional router-side connectivity probes and separate interfaces. ISP/ASN metadata remains unreported unless supplied; the dashboard does not run public IP lookups or speed tests.
- DNS/adblock: optional DNS health, service state and reported adblock data; unsupported counters show a capability/empty explanation.
- Logs: receipt-time date range, severity, exact service and message search. Stable compound cursor pagination uses `received_at` and `id`, with 50 visible rows per page. CSV/JSON exports include only the current page.
- Diagnostics: 20 snapshots per page with bounded date filtering. An owner action can create an actual private gzip archive through the Worker. Downloads use a 60-second signed URL from the private `router-diagnostics` bucket. Snapshot details remain available even when no archive exists.
- Firmware: up to 30 recent boot inventories and actual retained raw observations selected by boot and uptime. Both groups are clipped to the shared measured uptime interval. The UI reports sample counts and query truncation, and warns about traffic, radio, thermal, client and configuration confounders. No synthetic benchmark or causal performance claim is made.
- Alerts: open/all alerts, acknowledgement, and RLS-protected threshold rule create, enable/disable and remove actions. Rules expose operator, sustain, hysteresis and cooldown. Alert generation and notification delivery run server-side.
- Settings: Worker-mediated names, collection/retention config, one-use enrollment, credential rotation, revocation and typed-confirmation deletion. Browser appearance and time preferences are local.

Enrollment, config, device/client names, rotation, revocation, deletion, archive creation and alert acknowledgement use authenticated owner Worker routes. Alert rule writes use RLS directly. The dashboard never executes commands on routers. The local router configuration remains authoritative for endpoints, executable actions and safety overrides.

## Budgets and limits

The budget view labels its request/sample arithmetic and illustrative 1 KiB payload assumption as estimates. It does not claim accurate Supabase or Cloudflare invoices. Project resource usage is fetched on demand from the admin-only Worker endpoint; a non-admin sees an explicit authorization error. Daily bandwidth is observed coverage, not ISP billing usage. Tables are bounded; daily bandwidth currently displays at most 90 rows and client names at most 200. Firmware raw reads request at most 3,601 observations per group and detect lower database result caps using exact counts. Shorten the comparison window when limits apply.

Extended sparse detail currently uses structured expandable fields and tables rather than a historical chart for every kernel counter. Long-term historical detail is subject to raw retention; aggregated history contains common gauges only. Wi-Fi and DNS/adblock unsupported values are not fabricated. Client naming edits and additions require a known local anonymized identifier. The UI does not enable optional probes or diagnostics beyond the validated cloud collection flags, schedule remote commands, expose a terminal, or perform an active speed test.

## Verification evidence

Component/jsdom tests cover selected-router-only subscriptions, hidden-tab removal/reconnection, paused polling, null-versus-zero formatting, safe CSV export, timezone display, equal uptime-window selection, and loading/error/empty presentation. These are fixture simulations. Production build/type checking and the root browser harness provide local software evidence only; no deployment, live Supabase account, physical-router observations or real notification delivery is implied.

## Action feedback

User-triggered requests show an immediate working label and disable duplicate submission. A result remains next to its control and in a fixed activity panel that stays visible when the page is scrolled. Results remain until another attempt or explicit dismissal; automatic polling and Realtime updates do not create activity messages. Failed attempts remain visible while a retry is in progress. Status announcements use accessible live regions, and reduced-motion preferences stop spinner animation.

Enrollment, clipboard copies, name/config/client updates, credential operations, acknowledgements, rule writes, archive creation, download-link preparation, exports, login/sign-out and firmware comparisons all use the shared feedback flow. Config success means saved in the cloud, with delivery on the router's next successful upload; it does not claim that local permissions changed. Exports report that a file was prepared for the browser, never that the download finished. Private archives use a separate prepare-link step and a normal user-clicked link, avoiding asynchronous pop-up blocking. Expired links explain that a new link is needed.

Manual Refresh waits for actual router-list, latest/history/snapshot and mounted-page query promises, including diagnostics and logs, before reporting completion. The last successful check time is distinct from the last observation time. Received diagnostic records are explicitly marked **Received in cloud**, include the router request ID when supplied, and distinguish archive state from receipt. A queued local snapshot cannot appear in this list until the router uploads it successfully. The dashboard cannot request router-side collection.

HTTP operations and action waits are bounded to 20 seconds. A timeout or interrupted mutation is described as **unconfirmed completion**, because the service may already have committed the action. The UI directs the user to refresh before retrying. Cancellable owner requests receive an abort signal; credential/enrollment results are also guarded against late completion, changed router selection, closed/reopened dialogs and expired action attempts. Secrets are never included in feedback messages or persisted by this system.

Regression tests use deferred promises to exercise genuine pending states, duplicate prevention, confirmed success, rejected requests, clipboard rejection, timeout uncertainty, refresh completion across core/page reads and late secret responses. Browser tests use synthetic responses only and check feedback visibility on desktop/mobile while scrolled. These checks do not establish production or hardware acceptance.
