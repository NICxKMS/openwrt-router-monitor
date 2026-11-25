#!/bin/sh
# Read-only measurement. Run manually on the actual router, once stopped, once running.
# sh router-benchmark.sh 120 baseline > /tmp/baseline.csv
# sh router-benchmark.sh 120 telemetry > /tmp/telemetry.csv
umask 077
seconds=${1:-120};label=${2:-telemetry}
case "$seconds" in ''|*[!0-9]*)echo 'duration must be 10..3600 seconds' >&2;exit 1;;esac
[ "$seconds" -ge 10 ] && [ "$seconds" -le 3600 ] || exit 1
case "$label" in ''|*[!a-zA-Z0-9_-]*)exit 1;;esac
printf '# label=%s; kernel=%s; hardware=%s; clock_ticks=%s\n' "$label" "$(uname -r)" "$(cat /tmp/sysinfo/model 2>/dev/null)" "$(getconf CLK_TCK 2>/dev/null || echo 100)"
printf '# CPU ticks include currently alive descendants only; short-lived exited collectors may be missed. CPU system total is the reliable comparison. RSS sums shared pages. Interface counters include other internet traffic.\n'
printf 'uptime_s,cpu_total_ticks,cpu_idle_ticks,mem_available_kb,agent_ticks,agent_rss_kb,queue_disk_kb,wan_device,wan_rx_bytes,wan_tx_bytes,usbwan_device,usbwan_rx_bytes,usbwan_tx_bytes\n'
stop=$(( $(cut -d . -f 1 /proc/uptime) + seconds ))
root_pid=''
while :;do
    read -r uptime rest < /proc/uptime
    now=${uptime%%.*};[ "$now" -lt "$stop" ] || break
    cpu=$(awk '/^cpu /{t=0;for(i=2;i<=9;i++)t+=$i;printf "%.0f,%.0f",t,$5+$6;exit}' /proc/stat)
    mem=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
    if [ -r /tmp/nicx-telemetry/lock/pid ] && IFS= read -r observed_pid < /tmp/nicx-telemetry/lock/pid;then
        case "$observed_pid" in ''|*[!0-9]*);;*)root_pid=$observed_pid;;esac
    fi
    # /proc/pid/stat's comm may contain spaces; remove everything through the final ') '.
    process=$(awk -v root="$root_pid" '
        {pid=$1;sub(/^.*\) /,"");p[pid]=$2;t[pid]=$12+$13;r[pid]=$22*4}
        END{if(root ~ /^[0-9]+$/ && root in p){inside[root]=1;for(pass=0;pass<8;pass++)for(k in p)if(p[k] in inside)inside[k]=1;for(k in inside){ticks+=t[k];rss+=r[k]}}printf "%.0f,%.0f",ticks,rss}' /proc/[0-9]*/stat 2>/dev/null)
    queue=$(du -sk /tmp/nicx-telemetry/queue 2>/dev/null | awk '{print $1}')
    printf '%s,%s,%s,%s,%s' "$uptime" "$cpu" "${mem:-0}" "${process:-0,0}" "${queue:-0}"
    for role in wan usbwan;do
        device=$(ubus call "network.interface.$role" status 2>/dev/null | jsonfilter -e '@.l3_device')
        case "$device" in ''|*[!a-zA-Z0-9_.:-]*)printf ',,,';continue;;esac
        if [ -r "/sys/class/net/$device/statistics/rx_bytes" ];then
            read -r rx < "/sys/class/net/$device/statistics/rx_bytes"
            read -r tx < "/sys/class/net/$device/statistics/tx_bytes"
            printf ',%s,%s,%s' "$device" "$rx" "$tx"
        else printf ',,,';fi
    done
    printf '\n';sleep 1
done
