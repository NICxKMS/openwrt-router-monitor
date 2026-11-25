#!/usr/bin/env python3
"""Host-only summary of actual-device CSV. Never generates invented measurements."""
import argparse
import csv
import io
import json
from pathlib import Path
import statistics


def analyze(path):
    text=Path(path).read_text()
    rows=list(csv.DictReader(io.StringIO('\n'.join(line for line in text.splitlines() if not line.startswith('#')))))
    if len(rows)<2:
        raise ValueError('at least two real observation rows are required')
    first,last=rows[0],rows[-1]
    elapsed=float(last['uptime_s'])-float(first['uptime_s'])
    total=int(last['cpu_total_ticks'])-int(first['cpu_total_ticks'])
    idle=int(last['cpu_idle_ticks'])-int(first['cpu_idle_ticks'])
    if elapsed<=0 or total<=0 or not 0<=idle<=total:
        raise ValueError('invalid time/counter window: boot/reset or corrupt CSV')
    result={'source':str(path),'observations':len(rows),'elapsed_s':elapsed,'system_busy_pct':100*(total-idle)/total,
            'mem_available_kb_median':statistics.median(int(r['mem_available_kb']) for r in rows),
            'agent_rss_kb_max':max(int(r['agent_rss_kb']) for r in rows),
            'queue_disk_kb_max':max(int(r['queue_disk_kb']) for r in rows),'uplinks':{}}
    for role in ('wan','usbwan'):
        if first[role+'_device'] and first[role+'_device']==last[role+'_device']:
            rx=int(last[role+'_rx_bytes'])-int(first[role+'_rx_bytes']);tx=int(last[role+'_tx_bytes'])-int(first[role+'_tx_bytes'])
            if rx>=0 and tx>=0:
                result['uplinks'][role]={'device':first[role+'_device'],'rx_bytes_delta':rx,'tx_bytes_delta':tx,'includes_other_traffic':True}
    return result

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('baseline');parser.add_argument('telemetry');args=parser.parse_args()
    baseline=analyze(args.baseline);telemetry=analyze(args.telemetry)
    print(json.dumps({'baseline':baseline,'telemetry':telemetry,'system_busy_delta_percentage_points':telemetry['system_busy_pct']-baseline['system_busy_pct'],
        'mem_available_median_delta_kb':telemetry['mem_available_kb_median']-baseline['mem_available_kb_median'],
        'caveat':'Compare matched routing/Wi-Fi workloads and thermal state. Observer overhead is included. System CPU difference is not automatically caused by telemetry. No forwarding throughput or latency benchmark is implied.'},indent=2))
