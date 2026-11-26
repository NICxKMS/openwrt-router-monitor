#!/bin/sh
# BusyBox ash. No eval, no remote executable/configurable commands.
umask 077
LIB=${NICX_LIB:-/usr/lib/nicx-telemetry}
STATE=${NICX_STATE:-/tmp/nicx-telemetry}
CONFIG_DIR=${NICX_CONFIG_DIR:-/etc/nicx-telemetry}
credential="$CONFIG_DIR/token"
queue_limit=1572864

load_privacy_salt() {
    local file="$CONFIG_DIR/privacy-salt" salt
    [ -f "$file" ] && [ ! -L "$file" ] && command -v sha256sum >/dev/null || return 1
    [ "$(stat -c '%a:%u' "$file")" = "600:$(id -u)" ] || return 1
    IFS= read -r salt < "$file" && [ "${#salt}" -eq 64 ] || return 1
    case "$salt" in *[!a-f0-9]*) return 1;; esac
    printf '%s' "$salt"
}

init_state_dirs() {
    [ ! -L "$STATE" ] || return 1
    mkdir -p "$STATE" "$STATE/queue" "$STATE/logs" || return 1
    [ "$(stat -c %u "$STATE")" = "$(id -u)" ] || return 1
    chmod 700 "$STATE" "$STATE/queue" "$STATE/logs"
}
init_state() {
    init_state_dirs || return 1
    [ -f "$STATE/sequence" ] || echo 0 > "$STATE/sequence" || return 1
    [ -f "$STATE/dropped" ] || echo 0 > "$STATE/dropped"
}
number() { case "$1" in ''|*[!0-9]*|0?*) return 1;; esac; [ "${#1}" -le 9 ]; }
agent_owner_alive() {
    local owner
    [ -r "$1/lock/pid" ] && IFS= read -r owner < "$1/lock/pid" &&
        number "$owner" && [ "$owner" -gt 0 ] && kill -0 "$owner" 2>/dev/null
}
clamp() { if number "$1" && [ "$1" -ge "$2" ] && [ "$1" -le "$3" ]; then echo "$1";else echo "$4";fi; }
uget() { uci -q get "nicx-telemetry.main.$1" 2>/dev/null; }
load_config() {
    adaptive_sampling=$(uget adaptive_sampling);[ "$adaptive_sampling" = 0 ] || adaptive_sampling=1
    enabled=$(uget enabled); endpoint=$(uget endpoint); device_id=$(uget device_id)
    sample_interval=$(clamp "$(uget sample_interval)" 5 300 10)
    upload_interval=$(clamp "$(uget upload_interval)" 10 900 30)
    wifi_interval=$(clamp "$(uget wifi_interval)" 15 900 30)
    process_interval=$(clamp "$(uget process_interval)" 30 1800 60)
    detail_interval=$(clamp "$(uget detail_interval)" 60 3600 300)
    buffer_kb=$(clamp "$(uget buffer_kb)" 1024 2048 2048)
    # Reserve 512 KiB for immutable pending batch, log staging and temporary bodies.
    queue_limit=$((buffer_kb * 1024 - 524288))
    logs_enabled=$(uget logs_enabled); log_severity=$(clamp "$(uget log_severity)" 0 7 5)
    privacy_addresses=$(uget privacy_addresses); diagnostics_enabled=$(uget diagnostics_enabled)
    [ "$logs_enabled" = 0 ] || logs_enabled=1
    [ "$privacy_addresses" = 1 ] || privacy_addresses=0
    local_sample_interval=$sample_interval;local_upload_interval=$upload_interval
    local_wifi_interval=$wifi_interval;local_process_interval=$process_interval;local_detail_interval=$detail_interval
    local_logs_enabled=$logs_enabled
}
valid_endpoint() {
    # HTTPS origin only: no user info, path, query, IP literals, shell syntax or redirects.
    printf '%s\n' "$1" | awk 'NR!=1{exit 1} length($0)>253{exit 1} !/^https:\/\/[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z][a-zA-Z0-9.-]*$/{exit 1} /\.\.|localhost/{exit 1}'
}
valid_uuid() { printf '%s\n' "$1" | awk 'NR!=1{exit 1} length($0)!=36 || $0!~/^[0-9a-fA-F-]+$/ || substr($0,9,1)!="-" || substr($0,14,1)!="-" || substr($0,19,1)!="-" || substr($0,24,1)!="-"{exit 1}'; }
parse_json_file() {
    # jshn -r puts the entire JSON on argv, which could contain enrollment credentials.
    # -R reads a private file and also allows checking parser failure before eval in jshn.sh.
    jshn -R "$1" >/dev/null 2>&1 || return 1
    json_load_file "$1"
}
parse_json() {
    json_tmp=$(mktemp "$STATE/json.XXXXXX") || return 1
    printf '%s' "$1" > "$json_tmp"
    parse_json_file "$json_tmp";json_result=$?
    rm -f "$json_tmp"
    return "$json_result"
}
next_seq() { read -r seq < "$STATE/sequence"; number "$seq" || seq=0;seq=$((seq+1));echo "$seq" > "$STATE/sequence"; }
add_drop() { read -r drops < "$STATE/dropped";number "$drops" || drops=0;echo $((drops+${1:-1})) > "$STATE/dropped"; }
queue_bytes() { du -sk "$STATE/queue" | awk '{print $1*1024}'; }
trim_queue() {
    bytes=$(queue_bytes)
    for priority in l s c; do
        for file in "$STATE/queue"/*."$priority"; do
            [ "$bytes" -gt "$queue_limit" ] || return 0
            [ -f "$file" ] || continue
            rm -f "$file"; bytes=$(queue_bytes);add_drop 1
        done
    done
}
enqueue() {
    priority=$1; source_file=$2
    case "$priority" in s|l|c);;*)return 1;;esac
    next_seq
    target=$(printf '%s/queue/%010d.%s' "$STATE" "$seq" "$priority")
    cp "$source_file" "$target"
    trim_queue
}
make_curl_config() {
    [ -f "$credential" ] && [ ! -L "$credential" ] || return 1
    [ "$(stat -c '%a:%u' "$credential")" = "600:$(id -u)" ] || return 1
    local secret bound_endpoint bound_device
    {
        IFS= read -r secret || return 1
        # Enrolled credentials are tied to the router identity confirmed by the Worker.
        # Single-line credentials installed before this change remain usable.
        if IFS= read -r bound_endpoint;then
            IFS= read -r bound_device || return 1
            [ "$bound_endpoint" = "$endpoint" ] && [ "$bound_device" = "$device_id" ] || return 1
        fi
    } < "$credential"
    # Token formats from Worker use hex or base64url. Fixed allowlist prevents curl config injection.
    case "$secret" in ''|*[!a-zA-Z0-9_-]*)unset secret;return 1;;esac
    [ "${#secret}" -ge 43 ] && [ "${#secret}" -le 128 ] || { unset secret;return 1; }
    printf 'header = "Authorization: Bearer %s"\n' "$secret" > "$1" && chmod 600 "$1"
}
https() {
    # Credentials reside in a private config file, never curl arguments.
    valid_endpoint "$endpoint" || return 1
    exec curl --disable --silent --show-error --proto '=https' --tlsv1.2 --connect-timeout 8 --max-time 20 \
        --max-filesize 16384 --max-redirs 0 --config "$STATE/auth" \
        --header 'Content-Type: application/json' --output "$STATE/response" \
        --write-out '%{http_code}' "$@" 2> "$STATE/transport-error"
}
pressure_update() {
    # Three high observations enter protection; six healthy observations leave it.
    # Inputs: CPU percentage or null, available KiB, total KiB, queue bytes, queue limit.
    pressure_level=$(awk -v cpu="$1" -v available="$2" -v total="$3" -v queued="$4" -v limit="$5" 'BEGIN {
        known=(cpu ~ /^[0-9]+([.][0-9]+)?$/)
        if(total>0 && available/total<0.05)print "memory"
        else if(known && cpu>=90)print "cpu"
        else if(limit>0 && queued/limit>0.8)print "buffer"
        else if(known && cpu<70 && total>0 && available/total>0.1 && (limit<=0 || queued/limit<0.5))print "healthy"
        else print "neutral"
    }')
    adaptive_active=${adaptive_active:-0};pressure_high=${pressure_high:-0};pressure_healthy=${pressure_healthy:-0}
    if [ "${adaptive_sampling:-1}" = 0 ];then
        adaptive_active=0;pressure_high=0;pressure_healthy=0;pressure_reason=''
    else
        case "$pressure_level" in
            cpu|memory|buffer)
                pressure_healthy=0;pressure_high=$((pressure_high+1));[ "$pressure_high" -le 3 ] || pressure_high=3
                if [ "$pressure_high" -ge 3 ];then adaptive_active=1;pressure_reason=$pressure_level;fi;;
            healthy)
                pressure_high=0;pressure_healthy=$((pressure_healthy+1));[ "$pressure_healthy" -le 6 ] || pressure_healthy=6
                if [ "$pressure_healthy" -ge 6 ];then adaptive_active=0;pressure_reason='';fi;;
            *)pressure_high=0;pressure_healthy=0;;
        esac
    fi
    effective_sample_interval=$sample_interval
    if [ "$adaptive_active" = 1 ];then
        effective_sample_interval=$((sample_interval*3))
        [ "$effective_sample_interval" -ge 30 ] || effective_sample_interval=30
        [ "$effective_sample_interval" -le 300 ] || effective_sample_interval=300
    fi
}
set_cadence() {
    scheduled_interval=$1
    if [ "${adaptive_active:-0}" = 1 ];then scheduled_interval=$((scheduled_interval*2));fi
    [ "$scheduled_interval" -le "$2" ] || scheduled_interval=$2
}
uptime_now() { read -r uptime rest < /proc/uptime; }
clock_now() {
    observed_at=null;clock_synced=false
    # An explicitly running NTP peer alone does not prove synchronization.
    # BusyBox ntpd emits an ntp HOTPLUG event after sync; the shipped hook records it in RAM.
    if [ -f /tmp/nicx-telemetry-clock-synced ] && [ "$(date +%s)" -gt 1735689600 ];then
        clock_synced=true;observed_at="\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
    fi
}

snapshot_create() (
    snapshot_id=$1;snapshot_kind=$2
    uptime_now;json_init;json_add_string request_id "$snapshot_id";json_add_string kind "$snapshot_kind"
    read -r router_boot < /proc/sys/kernel/random/boot_id
    json_add_string boot_id "$router_boot"
    json_add_string state queued;json_add_string reason '';json_add_double requested_uptime_s "$uptime";json_add_double updated_uptime_s "$uptime"
    snapshot_meta=$(mktemp "$STATE/snapshot-state.XXXXXX") || exit 1
    if ! json_dump > "$snapshot_meta" || ! mv "$snapshot_meta" "$STATE/snapshot-status.json";then
        rm -f "$snapshot_meta"
        exit 1
    fi
)
snapshot_mark() (
    next_state=$1;next_reason=$2;expected_id=$3
    [ -n "$expected_id" ] && [ -r "$STATE/snapshot-status.json" ] || exit 0
    parse_json_file "$STATE/snapshot-status.json" || exit 0
    json_get_vars request_id kind state requested_uptime_s
    [ "$request_id" = "$expected_id" ] || exit 0
    # Confirmed acknowledgments survive service restarts and duplicate-batch replay.
    case "$state" in uploaded|failed)exit 0;;esac
    uptime_now;json_init;json_add_string request_id "$request_id";json_add_string kind "$kind"
    read -r router_boot < /proc/sys/kernel/random/boot_id
    json_add_string boot_id "$router_boot"
    json_add_string state "$next_state";json_add_string reason "$next_reason"
    json_add_double requested_uptime_s "$requested_uptime_s";json_add_double updated_uptime_s "$uptime"
    snapshot_meta=$(mktemp "$STATE/snapshot-state.XXXXXX") || exit 1
    json_dump > "$snapshot_meta";mv "$snapshot_meta" "$STATE/snapshot-status.json"
)
pending_snapshot_id() {
    if [ -r "$STATE/snapshot.pending" ];then jsonfilter -i "$STATE/snapshot.pending" -e '@.request_id' 2>/dev/null
    elif [ -r "$STATE/pending" ];then jsonfilter -i "$STATE/pending" -e '@.diagnostics.request_id' 2>/dev/null;fi
}
attach_snapshot_status() {
    IFS= read -r status_base < "$1"
    if [ -s "$STATE/snapshot-status.json" ];then
        IFS= read -r snapshot_metadata < "$STATE/snapshot-status.json"
        printf '%s,"snapshot":%s}\n' "${status_base%\}}" "$snapshot_metadata"
    else printf '%s\n' "$status_base";fi
}
