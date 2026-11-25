# Operations, recovery and maintenance

## Routine checks

In LuCI check last successful upload, upload error code, queue/dropped counts, clock sync and agent RSS/CPU status. In the dashboard check latest receipt time and unsupported capabilities. In Supabase inspect maintenance job success, database/Storage bytes and Realtime/egress usage. A green Worker health endpoint proves only that the HTTP handler can respond.

For a read-only router check over your LAN:

```sh
ubus call nicx.telemetry status
/etc/init.d/nicx-telemetry status
du -sk /tmp/nicx-telemetry
logread -e nicx-telemetry
```

Never paste credential files into support tickets. Log exports can still contain personal operational information after redaction.

## Common failures

| Symptom | Check/action |
| --- | --- |
| No data after enrollment | Local enable flag, correct cloud device ID, outbound DNS/HTTPS and token mode600; test connection locally |
| TLS fails just after reboot | Router clock/NTP and CA bundle. Wait for valid time; never disable certificate verification |
| Authentication rejected | Revoked/rotated token. Replace through the write-only local LuCI credential action; old tokens cannot be restored |
| Persistent invalid payload | Agent counts and drops permanently invalid400/413 batches; inspect schema compatibility/version and reported loss, not raw secrets |
|429 | Back off; do not decrease upload interval during rate limiting |
|503 / storage budget | Check Supabase health, successful cron and logical/physical usage. Decrease retention, allow bounded cleanup to catch up |
| No ath11k/PPE values | Review capability report and exact running firmware; no assumed universal ABI |
| Incomplete WAN/client totals | Offload bypass, missing samples, interface reset or unsupported client attribution. Do not disable offloading merely to collect counters |
| Sparse detail absent in old range | Raw detail retention has expired; aggregate history contains only common numeric gauges |
| No Telegram delivery | Owner-bound secrets, bot permission/chat membership, notification attempts and Worker scheduled execution |
| Archive deletion delayed | Worker Cron and Storage API availability; SQL cleanup only queues object deletion |
| UI403 | APP_ORIGIN must match the exact browser origin; usage additionally requires ADMIN_USER_ID |

An endpoint failing ICMP alone is not proof of an ISP outage. Compare gateway, IPv4/IPv6, DNS and upload results. A router offline alert cannot distinguish loss of power from a complete uplink outage without independent evidence. During cloud outages the cloud cannot deliver an immediate alert about itself; a maintenance gap is recorded after recovery.

## Backup and restore

Free Supabase backups/PITR are not assumed. Use the official CLI or PostgreSQL client from a trusted computer to export schema/data and store the export encrypted. Keep database credentials in a local password manager or PostgreSQL service/passfile, not in shell history. Include auth ownership mapping, application tables, migration history and private configuration; export Storage files separately through the Storage API. Store a router sysupgrade backup and its firmware/kernel/package signing information separately.

An application-only dump does not fully restore Supabase Auth and Storage service state. Follow Supabase's current backup/restore documentation for those managed schemas and object files. Restore first into a separate project, apply migrations in order, validate RLS with two test users and check object policies/cron before changing the Worker URL/secrets. Rotate device credentials if backups may have been exposed. Do not overwrite the production project as a restore experiment.

## Upgrade

Back up first. Check the schema version supported by the agent/Worker and run local tests. Add a new migration; never edit a migration already applied to the hosted project. Deploy database compatibility additions before code that requires them. Deploy Worker/assets together, then upgrade userspace router packages built for the installed snapshot. Confirm enrollment credentials and UCI preserved, agent starts and latest data resumes. Avoid firmware flashing solely for this userspace package.

Cloudflare can roll back a Worker deployment; schema rollback is a separate reviewed migration. Do not assume rolling back JS reverses SQL. Keep old schema fields until compatible agents have been upgraded. Snapshot driver/kernel behavior can change across firmware; retest capability detection instead of trusting previous results.

## Removal

Disable/stop only nicx-telemetry locally. Revoke the device in the dashboard, export any history you need, then delete it to remove associated rows and enqueue archive cleanup. Keep the cloud Worker Cron running until queued Storage deletions finish. Uninstall LuCI/agent with your snapshot's package manager; token files are preserved deliberately for upgrades/backups and can be explicitly removed locally after revocation. Do not delete unrelated configuration or networking packages.

If an archive upload succeeds but its database registration response is lost, the service reads back its exact object path. A matching pointer confirms success; an unavailable or different result remains unconfirmed. It never queues a potentially referenced archive for deletion. This can leave an unreferenced object after an uncertain registration failure. Storage usage includes those objects. For manual reconciliation, pause archive creation, inspect older bucket objects against current diagnostic pointers, and remove only confirmed unreferenced objects. Never infer that an object is orphaned solely from a timeout.

Disabling monitoring never requires changing routing, DNS, offloading, ISP settings or firewall ports.
