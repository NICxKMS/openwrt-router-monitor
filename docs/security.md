# Security and privacy model

The router makes only outbound HTTPS requests and retains its normal firewall/offload behavior. Telemetry failure does not restart dnsmasq, netifd, Wi-Fi, firewall or other networking services. The agent is a local read-only observer; procd may restart only that agent.

## Trust boundaries

Browser users authenticate with Supabase Auth. Every user-facing relation has owner RLS; frontend data reads use the browser key and user's session. Public anonymous read/write access is denied. The Worker verifies user tokens through Supabase Auth before using service-role privileges, and checks device ownership for each management operation. Device authentication uses a separate random bearer credential; possession allows writing only that device's monitoring data/config reads. An owner can revoke or rotate it.

Device and enrollment tokens are SHA-256 hashed in PostgreSQL. High-entropy random tokens do not need a slow password hash. Browser passwords are handled by Supabase Auth. Private credential tables are in an unexposed private schema; privileged SQL functions use fixed search paths and explicit service-role-only grants. Enrollment is single-use, expires in ten minutes, and is transactionally limited per owner. Device writes use atomic per-device request limits and unique batch/sample keys. Replayed identical batches do not duplicate stored samples or bandwidth totals.

The service-role key is powerful. It exists only in Worker secrets or ignored local development files. It must never appear in `VITE_` variables, frontend bundles, firmware, UCI or router logs. The preflight script detects common accidental browser-key assignments, but is not a substitute for secret handling. Local token files are owner-only mode600; status never returns their contents. Curl receives authorization through a private temporary configuration file rather than command arguments.

## Data minimization

No DNS query history, browsing domains, credentials, full configuration files, VPN private keys or arbitrary process command lines are collected. Client identifiers use a device-local secret salt where tools are available. If safe identification is unavailable, identifiers are omitted. Address inclusion is a local opt-in; server log redaction remains defense in depth. Regex redaction cannot recognize every possible personal datum, so avoid sharing free-text logs/snapshots publicly even after redaction.

The agent reads only allowlisted diagnostic sources, with time/output limits. It never enables debug logging, writes debugfs, changes Wi-Fi settings or mounts debugfs to manufacture a missing capability. Installed firmware/driver variations are reported as unsupported or unavailable. Memory attribution to ath11k is never guessed from total RAM differences.

## Resource and abuse protection

Worker request bodies are bounded while streaming, without trusting Content-Length. JSON has strict wire fields, bounded arrays, recursive depth/size checks, numerical ranges and unknown-config rejection. API browser origins must match APP_ORIGIN. Static CSP permits only local scripts and configured Supabase HTTPS/WebSockets; no external scripts or fonts. The default Supabase hostname wildcard can be narrowed to your project after setup. Styles allow inline declarations because chart/UI primitives use them. Diagnostic exports are private gzip files with size/budget checks and owner-only reads.

Cloudflare's edge limiter is approximate and local to a location; database limits are atomic globally for each credential. A distributed attacker can still exhaust a free Worker request allowance before application validation. Free plans do not provide a monitoring SLA. Token revocation, cloud usage visibility, application storage budgets and bounded retention limit consequences; they do not eliminate provider outages.

## Removal and recovery

Revocation stops ingestion but preserves existing records. Deletion cascades device tables and queues private Storage deletion; the minute Worker cron drains that queue. Keep it running until deletion tasks complete. A provider outage can delay physical object removal. Removing the whole Supabase account/project requires separate account actions and backup decisions.

RAM queues are lost at power failure/reboot. Kernel panic/OOM may stop logs before they are read or uploaded. No guarantee of final crash-log capture is possible without an independent persistent crash facility; the monitor does not enable one or write logs continuously to flash. On suspected token disclosure, revoke/rotate it and install the new token through local LuCI. On service-key disclosure, rotate the Supabase key, update the Worker secret and review project logs/policies.
