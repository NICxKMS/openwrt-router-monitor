# Measurement evidence

No physical JIDU6111 measurements are included. The shell agent fixture tests and any host timings describe this development machine, not router overhead.

Copy `router-benchmark.sh` to `/tmp` on the router after installing the packages. Run comparable observation windows with telemetry stopped and enabled. The script itself is read-only and never changes routing, offload, Wi-Fi, services, debugfs, packages or credentials. Stop/start telemetry yourself in LuCI between runs; do not stop network services. Save results off the router before reboot.

```sh
sh /tmp/router-benchmark.sh 120 baseline > /tmp/baseline.csv
# Enable telemetry in LuCI; wait for startup to finish.
sh /tmp/router-benchmark.sh 120 telemetry > /tmp/telemetry.csv
```

On the host:

```sh
python3 benchmarks/analyze-router.py baseline.csv telemetry.csv
```

Repeat under idle, active Ethernet forwarding and active Wi-Fi forwarding using the same clients, transfers, offload configuration, channel and temperature range. Measure throughput and latency from clients separately; this harness does not simulate forwarding tests. Add an outage observation with the Worker endpoint unreachable to measure bounded queue growth and background retry behavior. Avoid interrupting internet access if it is needed for other work.

The agent RSS column sums currently alive descendants, counts shared pages more than once and can miss short-lived processes. Whole-system CPU and available-memory differences are the useful comparison. Interface byte counters are exact decimal captures but include all router traffic, so they do not isolate telemetry traffic. Measure actual HTTPS traffic with an external capture or existing read-only accounting; do not label the WAN total as upload overhead. CPU clock-tick default100 is metadata only and does not affect whole-system busy percentage. Hardware page size may differ; the RSS column assumes the target JIDU6111 kernel's4KiB pages and must be adjusted on another architecture.
