#!/bin/sh
# Cache slow collectors separately. Every external diagnostic has a timeout and size bound.
collect_network() {
    : > "$STATE/network.input"
    for logical in wan usbwan lan;do
        device=$(timeout 2 ubus call "network.interface.$logical" status 2>/dev/null | head -c 8192 | jsonfilter -e '@.l3_device' 2>/dev/null)
        case "$device" in ''|*[!a-zA-Z0-9_.:-]*)continue;;esac
        [ -r "/sys/class/net/$device/ifindex" ] || continue
        read -r index < "/sys/class/net/$device/ifindex"
        link=unknown;changes=unknown
        [ ! -r "/sys/class/net/$device/iflink" ] || read -r link < "/sys/class/net/$device/iflink"
        [ ! -r "/sys/class/net/$device/carrier_changes" ] || read -r changes < "/sys/class/net/$device/carrier_changes"
        index="$index:$link:$changes"
        uptime_now
        read -r rx < "/sys/class/net/$device/statistics/rx_bytes"
        read -r tx < "/sys/class/net/$device/statistics/tx_bytes"
        # Avoid double counting an accidental shared WAN/USB device.
        case " $seen_devices " in *" $device "*)continue;;esac
        seen_devices="$seen_devices $device"
        printf '%s %s %s %s %s %s\n' "$device" "$logical" "$index" "$uptime" "$rx" "$tx" >> "$STATE/network.input"
    done
    unset seen_devices
    awk -v state="$STATE/network.previous" -f "$LIB/network.awk" "$STATE/network.input" > "$STATE/network.json"
}
collect_processes() {
    # RSS is not unique memory (shared pages can be counted by multiple processes).
    awk '/^Name:/{name=$2} /^Pid:/{pid=$2} /^VmRSS:/{if(name ~ /^[a-zA-Z0-9_.:-]+$/)print $2,pid,name}' /proc/[0-9]*/status 2>/dev/null | sort -nr | head -n 12 > "$STATE/process.input"
    json_init;json_add_array processes
    while read -r rss pid name;do
        json_add_object '';json_add_string name "$name";json_add_int pid "$pid";json_add_int rss_kb "$rss";json_close_object
    done < "$STATE/process.input"
    json_close_array;uptime_now;json_add_double processes_uptime_s "$uptime";json_dump > "$STATE/process.new";mv "$STATE/process.new" "$STATE/process.json";: > "$STATE/process.dirty"
}
detect_policy_services() {
    firewall_active=unknown;firewall_check=nft_unavailable
    if command -v nft >/dev/null;then
        # firewall4 applies rules then exits; daemon process existence is not its health.
        # Discard the ruleset entirely; bound only the diagnostic error and runtime.
        (ulimit -f 4;LC_ALL=C timeout 2 nft list table inet fw4 >/dev/null 2> "$STATE/firewall.error")
        nft_result=$?
        if [ "$nft_result" -eq 0 ];then firewall_active=1;firewall_check=nft_table_present
        else
            firewall_check=nft_query_unknown
            case "$nft_result" in
                1|2)if head -c 1024 "$STATE/firewall.error" | awk 'index($0,"No such file or directory"){missing=1}END{exit !missing}';then
                    firewall_active=0;firewall_check=nft_table_absent
                fi;;
            esac
        fi
        rm -f "$STATE/firewall.error"
    fi
    # Verified AdBlock Fast procd data API. No configuration, domain, error-message
    # or resolver data is retained. An absent/unrecognized API never means down.
    adblock_status=$(timeout 2 ubus call service list '{"name":"adblock-fast"}' 2>/dev/null | head -c 8192 | jsonfilter -e '@["adblock-fast"].data.status' 2>/dev/null)
    adblock_active=unknown;adblock_check=procd_status_unavailable
    case "$adblock_status" in
        statusSuccess)adblock_active=1;adblock_check=procd_status_success;;
        statusStopped)adblock_active=0;adblock_check=procd_status_stopped;;
        statusFail)adblock_active=0;adblock_check=procd_status_failed;;
        statusStarting|statusRestarting|statusForceReloading|statusDownloading|statusProcessing|statusTriggerBootWait|statusTriggerStartWait)adblock_check=procd_status_transition;;
    esac
    unset adblock_status
}
collect_detail() {
    detect_policy_services
    json_init
    json_add_object memory
    json_add_object vmstat
    while read -r key value;do
        case "$key" in pgfault|pgmajfault|pswpin|pswpout|oom_kill|pgscan_kswapd|pgsteal_kswapd)json_add_string "$key" "$value";;esac
    done < /proc/vmstat
    json_close_object
    json_add_object psi
    for kind in cpu memory io;do
        [ -r "/proc/pressure/$kind" ] || continue
        json_add_object "$kind"
        while read -r pressure rest;do
            case "$pressure" in some|full);;*)continue;;esac
            json_add_object "$pressure"
            for pair in $rest;do
                key=${pair%%=*};value=${pair#*=}
                case "$value" in ''|*[!0-9.]* )continue;;esac
                case "$key" in avg10|avg60|avg300)json_add_double "$key" "$value";;total)json_add_string "$key" "$value";;esac
            done
            json_close_object
        done < "/proc/pressure/$kind"
        json_close_object
    done
    json_close_object;json_close_object
    json_add_array thermal
    count=0
    for path in /sys/class/thermal/thermal_zone*/temp;do
        [ -r "$path" ] || continue
        count=$((count+1));[ "$count" -le 16 ] || break
        read -r temp < "$path";case "$temp" in ''|*[!0-9-]*)continue;;esac
        temp_c=$(awk -v t="$temp" 'BEGIN{if(t>=-40000 && t<=150000)printf "%.1f",t/1000;else print "null"}')
        [ "$temp_c" = null ] && continue
        zone=${path%/temp};zone=${zone##*/}
        json_add_object '';json_add_string name "$zone";json_add_double temp_c "$temp_c";json_close_object
    done
    json_close_array
    json_add_object storage
    for mount in overlay tmp;do
        [ -d "/$mount" ] || continue
        set -- $(df -k "/$mount" 2>/dev/null | awk 'NR==2{print $2,$3,$4}')
        [ "$#" -eq 3 ] || continue
        json_add_object "$mount";json_add_int total_kb "$1";json_add_int used_kb "$2";json_add_int available_kb "$3";json_close_object
    done
    json_close_object
    json_add_object firewall
    for field in count max;do
        path="/proc/sys/net/netfilter/nf_conntrack_$field"
        [ -r "$path" ] || continue
        read -r value < "$path";number "$value" && json_add_int "conntrack_$field" "$value"
    done
    for key in flow_offloading flow_offloading_hw;do
        value=$(uci -q get "firewall.@defaults[0].$key")
        json_add_boolean "$key" "$([ "$value" = 1 ] && echo 1 || echo 0)"
    done
    json_close_object
    json_add_object services
    # Existence/running status only; do not export service command lines or config.
    for service in dnsmasq odhcpd sysntpd https-dns-proxy hostapd rpcd network uhttpd;do
        [ -x "/etc/init.d/$service" ] || continue
        if timeout 2 "/etc/init.d/$service" running >/dev/null 2>&1;then value=1;else value=0;fi
        json_add_boolean "$service" "$value"
    done
    case "$firewall_active" in 0|1)json_add_boolean firewall "$firewall_active";;*)json_add_null firewall;;esac
    case "$adblock_active" in 0|1)json_add_boolean adblock-fast "$adblock_active";;*)json_add_null adblock-fast;;esac
    json_close_object
    json_add_object service_checks
    json_add_string firewall "$firewall_check";json_add_string adblock-fast "$adblock_check"
    json_close_object
    json_add_object capabilities
    json_add_string psi "$([ -d /proc/pressure ] && echo available || echo unavailable)"
    json_add_string wifi "$(command -v iw >/dev/null && echo available || echo 'unavailable: install iw')"
    json_add_string debugfs 'disabled: no debugfs reads or changes'
    json_add_string ppe 'unavailable: no stable driver-independent counter ABI'
    json_add_string slab_attribution 'unavailable: per-cache attribution not collected'
    json_add_string dns_counters 'unavailable: no stable dnsmasq counter ABI without query logging'
    json_add_string dns_queries 'disabled: privacy policy'
    json_close_object
    uptime_now;json_add_double detail_uptime_s "$uptime";json_dump > "$STATE/detail.new";mv "$STATE/detail.new" "$STATE/detail.json";: > "$STATE/detail.dirty"
}
collect_inventory() {
    board=$(timeout 2 ubus call system board 2>/dev/null | head -c 8192)
    json_init;json_add_string agent_version 1.0.0
    for key in model kernel release.version release.revision release.target release.description;do
        value=$(jsonfilter -s "$board" -e "@.$key" 2>/dev/null | head -c 256)
        json_add_string "${key##*.}" "$value"
    done
    json_dump > "$STATE/inventory.json"
    unset board value
}
collect_wifi() {
    command -v iw >/dev/null || { echo '{"wifi":{"radios":[],"available":false}}' > "$STATE/wifi.new";mv "$STATE/wifi.new" "$STATE/wifi.json";: > "$STATE/wifi.dirty";return; }
    timeout 2 iw dev 2>/dev/null | awk '$1=="Interface" && $2~/^[a-zA-Z0-9_.:-]+$/{print $2}' | head -n 4 > "$STATE/wifi.interfaces"
    json_init;json_add_object wifi;json_add_boolean available 1
    country=$(timeout 2 iw reg get 2>/dev/null | awk '/^country [A-Z][A-Z]:/{sub(":","",$2);print $2;exit}')
    [ -z "$country" ] || json_add_string country "$country"
    json_add_array radios
    client_budget=24;salt_available=0
    if [ -f "$CONFIG_DIR/privacy-salt" ] && [ ! -L "$CONFIG_DIR/privacy-salt" ] && command -v sha256sum >/dev/null;then
        if [ "$(stat -c '%a:%u' "$CONFIG_DIR/privacy-salt")" = "600:$(id -u)" ];then
            IFS= read -r privacy_salt < "$CONFIG_DIR/privacy-salt";salt_available=1
        fi
    fi
    while read -r interface;do
        timeout 2 iw dev "$interface" station dump 2>/dev/null | head -c 32768 | awk '
        function flush(){if(mac!="" && n++<24)print mac,signal,rx,tx,retries,failed,rxrate,txrate}
        /^Station /{flush();mac=$2;signal=rx=tx=retries=failed=rxrate=txrate="-"}
        /^[ \t]*signal:/{if($2~/^-?[0-9]+$/)signal=$2}/^[ \t]*rx bytes:/{if($3~/^[0-9]+$/)rx=$3}/^[ \t]*tx bytes:/{if($3~/^[0-9]+$/)tx=$3}
        /^[ \t]*tx retries:/{if($3~/^[0-9]+$/)retries=$3}/^[ \t]*tx failed:/{if($3~/^[0-9]+$/)failed=$3}
        /^[ \t]*rx bitrate:/{if($3~/^[0-9]+([.][0-9]+)?$/)rxrate=$3}/^[ \t]*tx bitrate:/{if($3~/^[0-9]+([.][0-9]+)?$/)txrate=$3}END{flush()}' > "$STATE/stations.input"
        stations=$(wc -l < "$STATE/stations.input")
        signal=$(awk '$2!="-"{n++;s+=$2}END{if(n)print s/n;else print "null"}' "$STATE/stations.input")
        json_add_object '';json_add_string name "$interface";json_add_int stations "$stations"
        timeout 2 iw dev "$interface" info 2>/dev/null | awk '/channel [0-9]+ /{gsub(/[(),]/," ");for(i=1;i<=NF;i++){if($i=="MHz" && i>1 && !seen++){print "frequency",$(i-1)}if($i=="width:")print "width_mhz",$(i+1)}}' > "$STATE/radio.input"
        while read -r key value;do case "$value" in ''|*[!0-9]*)continue;;esac;json_add_int "$key" "$value";done < "$STATE/radio.input"
        [ "$signal" = null ] || json_add_double signal_avg_dbm "$signal"
        json_add_array clients
        while read -r mac sig rx tx retries failed rxrate txrate;do
            [ "$client_budget" -gt 0 ] || continue
            case "$mac" in *[!a-fA-F0-9:]*)continue;;esac
            [ "$salt_available" = 1 ] || continue
            # Secret prefix plus suffix prevents exposing stable public MAC hashes.
            # Local random salt never leaves this device or enters command arguments.
            client_id=$(printf '%s%s%s' "$privacy_salt" "$mac" "$privacy_salt" | sha256sum)
            client_id=${client_id%% *}
            client_budget=$((client_budget-1))
            json_add_object '';json_add_string client_id "${client_id%????????????????????????????????}"
            [ "$sig" = - ] || json_add_int signal_dbm "$sig"
            [ "$rx" = - ] || json_add_string rx_bytes "$rx"
            [ "$tx" = - ] || json_add_string tx_bytes "$tx"
            [ "$retries" = - ] || json_add_int tx_retries "$retries"
            [ "$failed" = - ] || json_add_int tx_failed "$failed"
            [ "$rxrate" = - ] || json_add_double rx_rate_mbps "$rxrate"
            [ "$txrate" = - ] || json_add_double tx_rate_mbps "$txrate"
            json_close_object
        done < "$STATE/stations.input"
        json_close_array
        timeout 2 iw dev "$interface" survey dump 2>/dev/null | head -c 8192 | awk '
        /frequency:/{active=($0~/in use/);if(active)print "frequency",$2}
        active && /channel active time:/{print "active_ms",$4}
        active && /channel busy time:/{print "busy_ms",$4}
        active && /noise:/{print "noise_dbm",$2}' > "$STATE/survey.input"
        json_add_object survey
        while read -r key value;do case "$value" in ''|*[!0-9-]*)continue;;esac;json_add_int "$key" "$value";done < "$STATE/survey.input"
        json_close_object;json_close_object
    done < "$STATE/wifi.interfaces"
    unset privacy_salt
    json_close_array;json_close_object;uptime_now;json_add_double wifi_uptime_s "$uptime";json_dump > "$STATE/wifi.new";mv "$STATE/wifi.new" "$STATE/wifi.json";: > "$STATE/wifi.dirty"
    rm -f "$STATE/stations.input"
}
collect_connectivity() {
    [ "$(uget probes_enabled)" = 1 ] || { echo '{"connectivity":{"reason":"optional probes disabled"}}' > "$STATE/connectivity.new";mv "$STATE/connectivity.new" "$STATE/connectivity.json";: > "$STATE/connectivity.dirty";return; }
    json_init;json_add_object connectivity
    for family in ipv4 ipv6 gateway;do
        case "$family" in
            ipv4)target=$(uget probe_ipv4);target=${target:-1.1.1.1};case "$target" in *[!0-9.]*|'')continue;;esac;tool=ping;;
            ipv6)target=$(uget probe_ipv6);target=${target:-2606:4700:4700::1111};case "$target" in *[!a-fA-F0-9:]*|'')continue;;esac;tool=ping6;;
            gateway)target=$(ip -4 route show default 2>/dev/null | awk 'NR==1{print $3}');case "$target" in *[!0-9.]*|'')continue;;esac;tool=ping;;
        esac
        command -v "$tool" >/dev/null || continue
        timeout 5 "$tool" -n -c 2 -W 1 "$target" > "$STATE/probe.input" 2>/dev/null
        json_add_object "$family";json_add_boolean available 1
        loss=$(awk -F '%' '/packet loss/{n=split($1,a," ");print a[n]}' "$STATE/probe.input")
        case "$loss" in ''|*[!0-9.]*)json_add_boolean reachable 0;;*)json_add_double loss_pct "$loss";json_add_boolean reachable "$([ "$loss" = 100 ] && echo 0 || echo 1)";;esac
        set -- $(awk -F '= ' '/min\/avg\/max/{split($2,a,"/");print a[2],a[3]-a[1]}' "$STATE/probe.input")
        if [ "$#" -eq 2 ];then json_add_double latency_ms "$1";json_add_double jitter_ms "$2";fi
        json_close_object
    done
    # No user/domain queries: fixed public health name only; resolution success, coarse timing.
    if command -v nslookup >/dev/null;then
        uptime_now;start=$uptime
        if timeout 3 nslookup example.com >/dev/null 2>&1;then reachable=1;else reachable=0;fi
        uptime_now;elapsed=$(awk -v a="$start" -v b="$uptime" 'BEGIN{print (b-a)*1000}')
        json_add_object dns;json_add_boolean available 1;json_add_boolean reachable "$reachable";json_add_double latency_ms "$elapsed";json_close_object
    fi
    json_add_string interpretation 'Reachability hints; ICMP may be filtered; DNS includes local caching; jitter is max minus min of two probes.'
    json_close_object;uptime_now;json_add_double connectivity_uptime_s "$uptime";json_dump > "$STATE/connectivity.new";mv "$STATE/connectivity.new" "$STATE/connectivity.json";: > "$STATE/connectivity.dirty"
}
collect_sample() {
    uptime_now;clock_now
    awk -v state="$STATE/cpu.previous" -f "$LIB/cpu.awk" /proc/stat > "$STATE/cpu.json"
    awk -f "$LIB/memory.awk" /proc/meminfo > "$STATE/memory.json"
    collect_network
    read -r load rest < /proc/loadavg
    temp=null
    [ -r /sys/class/thermal/thermal_zone0/temp ] && temp=$(awk '{if($1>=-40000 && $1<=150000)print $1/1000;else print "null"}' /sys/class/thermal/thermal_zone0/temp)
    next_seq
    printf '{"seq":%s,"uptime_s":%s,"observed_at":%s,"load1":%s,"temp_c":%s,' "$seq" "$uptime" "$observed_at" "$load" "$temp" > "$STATE/sample"
    for part in memory network;do read -r fragment < "$STATE/$part.json";fragment=${fragment#\{};fragment=${fragment%\}};printf '%s,' "$fragment" >> "$STATE/sample";done
    cpu=$(jsonfilter -i "$STATE/cpu.json" -e '@.cpu_pct')
    cores=$(jsonfilter -i "$STATE/cpu.json" -e '@.cores')
    printf '"cpu_pct":%s,"detail":{"cpu":{"cores":%s}' "${cpu:-null}" "${cores:-\{\}}" >> "$STATE/sample"
    printf ',"meminfo":' >> "$STATE/sample";cat "$STATE/memory.json" >> "$STATE/sample"
    cp "$STATE/sample" "$STATE/sample.base"
    for part in detail process wifi connectivity;do
        [ -s "$STATE/$part.json" ] && mv "$STATE/$part.dirty" "$STATE/$part.consuming" 2>/dev/null || continue
        read -r fragment < "$STATE/$part.json";fragment=${fragment#\{};fragment=${fragment%\}}
        [ -n "$fragment" ] && printf ',%s' "$fragment" >> "$STATE/sample"
    done
    printf '}}\n' >> "$STATE/sample"
    # Bound detail well below 16 KiB; omit slow extended detail if unexpectedly large.
    if [ "$(wc -c < "$STATE/sample")" -gt 15000 ];then
        cp "$STATE/sample.base" "$STATE/sample";printf '}}\n' >> "$STATE/sample"
        add_drop 1 # preserve common gauges even if extended detail exceeded its limit
    fi
    enqueue s "$STATE/sample"
    set -- $(awk '/^MemAvailable:/{available=$2}/^MemTotal:/{total=$2}END{print available+0,total+0}' /proc/meminfo)
    pressure_update "$cpu" "$1" "$2" "${bytes:-0}" "$queue_limit"
    rm -f "$STATE/detail.consuming" "$STATE/process.consuming" "$STATE/wifi.consuming" "$STATE/connectivity.consuming"
}
