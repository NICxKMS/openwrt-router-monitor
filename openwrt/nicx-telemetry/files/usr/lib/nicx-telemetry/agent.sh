#!/bin/sh
. "${NICX_LIB:-/usr/lib/nicx-telemetry}/common.sh"
. "${NICX_JSHN:-/usr/share/libubox/jshn.sh}"
. "$LIB/collectors.sh"

import_logs() {
    for chunk in "$STATE/logs"/*.ready;do
        [ -s "$chunk" ] || continue
        while IFS= read -r record;do
            parse_json "$record" || continue
            json_get_var severity severity
            next_seq;json_add_int seq "$seq";json_dump > "$STATE/logitem"
            if [ "$severity" -le 3 ];then enqueue c "$STATE/logitem";else enqueue l "$STATE/logitem";fi
        done < "$chunk"
        rm -f "$chunk"
    done
}
seal_batch() {
    [ ! -s "$STATE/pending" ] || return 0
    : > "$STATE/selected";: > "$STATE/samples.part";: > "$STATE/logs.part"
    sample_count=0;log_count=0;body_size=0
    # Critical log groups win admission; samples remain ordered oldest first.
    for priority in c s l;do
        for file in "$STATE/queue"/*."$priority";do
            [ -f "$file" ] || continue
            if [ "$priority" = s ];then [ "$sample_count" -lt 12 ] || break;else [ "$log_count" -lt 100 ] || break;fi
            size=$(wc -c < "$file");[ $((body_size+size)) -le 80000 ] || break
            body_size=$((body_size+size))
            if [ "$priority" = s ];then
                [ "$sample_count" -eq 0 ] || printf ',' >> "$STATE/samples.part"
                cat "$file" >> "$STATE/samples.part";sample_count=$((sample_count+1))
            else
                [ "$log_count" -eq 0 ] || printf ',' >> "$STATE/logs.part"
                cat "$file" >> "$STATE/logs.part";log_count=$((log_count+1))
            fi
            printf '%s\n' "$file" >> "$STATE/selected"
        done
    done
    [ $((sample_count+log_count)) -gt 0 ] || return 1
    clock_now;read -r batch_id < /proc/sys/kernel/random/uuid
    read -r pending_drops < "$STATE/dropped"
    {
        printf '{"schema_version":1,"device_id":"%s","boot_id":"%s","batch_id":"%s","clock_synced":%s,"sent_at":%s,"samples":[' "$device_id" "$boot_id" "$batch_id" "$clock_synced" "$observed_at"
        cat "$STATE/samples.part";printf '],"logs":[';cat "$STATE/logs.part";printf '],"dropped_samples":%s' "$pending_drops"
        if [ -s "$STATE/inventory.json" ];then printf ',"inventory":';cat "$STATE/inventory.json";fi
        if [ "$diagnostics_enabled" = 1 ] && [ "${remote_diagnostics_enabled:-0}" = 1 ] && [ -s "$STATE/snapshot" ];then
            printf ',"diagnostics":';cat "$STATE/snapshot"
            mv "$STATE/snapshot" "$STATE/snapshot.pending"
        fi
        printf '}\n'
    } > "$STATE/pending.new"
    # Atomic immutable body: retries use the identical batch UUID, sent_at and content.
    mv "$STATE/pending.new" "$STATE/pending"
    printf '%s\n' "$pending_drops" > "$STATE/pending.drops"
    while IFS= read -r file;do rm -f "$file";done < "$STATE/selected"
    rm -f "$STATE/selected" "$STATE/samples.part" "$STATE/logs.part"
}
apply_remote_config() {
    # Server may adjust safe intervals and reduce/restore locally permitted logging. Local limits and privacy stay authoritative.
    # Local UCI intervals are ceilings on collection frequency (max local/remote seconds).
    parse_json "$(cat "$STATE/response")" || return
    json_select config >/dev/null 2>&1 || return
    for key in sample_interval upload_interval wifi_interval process_interval detail_interval;do
        json_get_var value "$key"
        number "$value" || continue
        case "$key" in
            sample_interval)[ "$value" -ge "${local_sample_interval:-$sample_interval}" ] && [ "$value" -le 300 ] && sample_interval=$value;;
            upload_interval)[ "$value" -ge "${local_upload_interval:-$upload_interval}" ] && [ "$value" -le 900 ] && upload_interval=$value;;
            wifi_interval)[ "$value" -ge "${local_wifi_interval:-$wifi_interval}" ] && [ "$value" -le 900 ] && wifi_interval=$value;;
            process_interval)[ "$value" -ge "${local_process_interval:-$process_interval}" ] && [ "$value" -le 1800 ] && process_interval=$value;;
            detail_interval)[ "$value" -ge "${local_detail_interval:-$detail_interval}" ] && [ "$value" -le 3600 ] && detail_interval=$value;;
        esac
    done
    json_get_var remote_logs logs_enabled
    case "$remote_logs" in
        0|false)if [ "$logs_enabled" = 1 ];then stop_logs;logs_enabled=0;purge_logs;fi;;
        1|true)if [ "$local_logs_enabled" = 1 ] && [ "$logs_enabled" = 0 ];then logs_enabled=1;start_logs;fi;;
    esac
    json_get_var remote_diag diagnostics_enabled
    case "$remote_diag" in 1|true)remote_diagnostics_enabled=1;;*)remote_diagnostics_enabled=0
        if [ -s "$STATE/snapshot" ];then
            snapshot_mark failed cloud_diagnostics_disabled "$(jsonfilter -i "$STATE/snapshot" -e '@.request_id' 2>/dev/null)"
            rm -f "$STATE/snapshot"
        fi;;esac
}
upload_transport() {
    # Runs in a child. Only the main loop mutates queues or drop counters.
    snapshot_mark uploading '' "$(pending_snapshot_id)"
    if ! make_curl_config "$STATE/auth";then
        echo '1 credentials' > "$STATE/upload.done.new"
        mv "$STATE/upload.done.new" "$STATE/upload.done";return 1
    fi
    trap '[ -z "$transport_pid" ] || kill "$transport_pid" 2>/dev/null; rm -f "$STATE/auth"; exit 1' INT TERM
    https --request POST --data-binary "@$STATE/pending" "$endpoint/api/v1/telemetry" > "$STATE/http.code" &
    transport_pid=$!
    wait "$transport_pid";result=$?
    read -r status < "$STATE/http.code"
    rm -f "$STATE/auth" "$STATE/http.code"
    printf '%s %s\n' "$result" "$status" > "$STATE/upload.done.new"
    mv "$STATE/upload.done.new" "$STATE/upload.done"
}
upload_failure() {
    last_error=$1;snapshot_mark retrying "$last_error" "$(pending_snapshot_id)"
}
finish_upload() {
    failed_uploads=$(( ${failed_uploads:-0} + 1 ))
    result=1;status=''
    [ ! -r "$STATE/upload.done" ] || read -r result status < "$STATE/upload.done"
    rm -f "$STATE/upload.done"
    if [ "$result" -eq 0 ] && [ "$status" = 200 ];then
        parse_json "$(cat "$STATE/response")" 2>/dev/null || { upload_failure invalid_response;return 1; }
        json_get_var accepted accepted
        [ "$accepted" = 1 ] || [ "$accepted" = true ] || { upload_failure not_accepted;return 1; }
        acknowledged_snapshot=$(pending_snapshot_id)
        if [ -n "$acknowledged_snapshot" ];then
            json_get_var receipt_id diagnostics_request_id
            json_get_var receipt_accepted diagnostics_accepted
            json_get_var receipt_reason diagnostics_reason
            json_get_type receipt_type diagnostics_accepted
            if [ "$receipt_id" != "$acknowledged_snapshot" ] || [ "$receipt_type" != boolean ];then
                upload_failure diagnostic_receipt_unconfirmed;return 1
            fi
            case "$receipt_accepted" in
                1|true)snapshot_mark uploaded '' "$acknowledged_snapshot";;
                0|false)
                    case "$receipt_reason" in
                        storage_budget|diagnostic_storage_budget)receipt_reason=diagnostic_storage_budget;;
                        diagnostics_disabled|cloud_diagnostics_disabled);;
                        *)receipt_reason=diagnostic_storage_rejected;;
                    esac
                    snapshot_mark failed "$receipt_reason" "$acknowledged_snapshot";;
                *)upload_failure diagnostic_receipt_unconfirmed;return 1;;
            esac
        fi
        failed_uploads=$((failed_uploads-1));successful_uploads=$(( ${successful_uploads:-0} + 1 ))
        read -r acknowledged < "$STATE/pending.drops";read -r current < "$STATE/dropped"
        echo $((current-acknowledged)) > "$STATE/dropped"
        rm -f "$STATE/pending" "$STATE/pending.drops" "$STATE/snapshot.pending" "$STATE/transport-error"
        apply_remote_config;rm -f "$STATE/response"
        uptime_now;last_success=$uptime;last_error='';return 0
    fi
    # Raw curl messages / response bodies are never sent to syslog or exposed in LuCI.
    case "$status" in
        400|413)
            snapshot_mark failed invalid_payload_discarded "$(pending_snapshot_id)"
            pending_count;add_drop "$pending_items"
            # Keep only a reason and count: retaining rejected bodies wastes the bounded buffer.
            printf '{"http_status":%s,"discarded_items":%s}\n' "$status" "$pending_items" > "$STATE/last-rejection.json"
            rm -f "$STATE/pending" "$STATE/pending.drops" "$STATE/snapshot.pending"
            last_error=invalid_payload_discarded;;
        credentials)last_error=credentials_unavailable;;401|403)last_error=authentication_rejected;;413)last_error=payload_rejected;;429)last_error=server_rate_limited;;*)last_error=upload_failed;;esac
    snapshot_mark retrying "$last_error" "$(pending_snapshot_id)"
    rm -f "$STATE/response" "$STATE/transport-error"
    return 1
}
pending_count() {
    pending_items=0;pending_log_items=0
    if [ -r "$STATE/pending" ] && parse_json_file "$STATE/pending";then
        if json_select samples 2>/dev/null;then json_get_keys item_keys;set -- $item_keys;pending_items=$#;json_select ..;fi
        if json_select logs 2>/dev/null;then json_get_keys item_keys;set -- $item_keys;pending_log_items=$#;json_select ..;fi
    fi
    pending_items=$((pending_items+pending_log_items));[ "$pending_items" -gt 0 ] || pending_items=1
}
purge_logs() {
    for log_file in "$STATE/queue/"*.c "$STATE/queue/"*.l;do
        [ -f "$log_file" ] || continue
        rm -f "$log_file";add_drop 1
    done
    rm -f "$STATE/logs/"*
    if [ -s "$STATE/pending" ];then
        pending_count
        if [ "$pending_log_items" -gt 0 ];then
            snapshot_mark failed privacy_policy_changed "$(pending_snapshot_id)"
            add_drop "$pending_items"
            rm -f "$STATE/pending" "$STATE/pending.drops" "$STATE/snapshot.pending"
        fi
    fi
}
upload_batch() { (upload_transport);finish_upload; }
critical_upload_due() {
    [ -z "$upload_pid" ] && [ "${retry_delay:-0}" -eq 0 ] && [ ! -s "$STATE/pending" ] || return 1
    [ -n "$last_success" ] || return 1
    critical_found=0
    for critical_file in "$STATE/queue/"*.c;do
        [ -f "$critical_file" ] || continue
        critical_found=1;break
    done
    [ "$critical_found" -eq 1 ] || return 1
    awk -v now="$1" -v previous="$last_success" 'BEGIN {
        exit !(previous ~ /^[0-9]+([.][0-9]+)?$/ && now-previous>=15)
    }'
}
write_status() {
    json_init;json_add_boolean running 1;json_add_string version 1.0.0
    json_add_int failed_uploads "${failed_uploads:-0}";json_add_int successful_uploads "${successful_uploads:-0}"
    set -- $(awk -v state="$STATE/parent-usage.previous" -f "$LIB/parent-usage.awk" "/proc/$$/stat" /proc/stat "/proc/$$/status" 2>/dev/null)
    case "$1" in ''|null)json_add_null parent_cpu_pct;;*)json_add_double parent_cpu_pct "$1";;esac
    case "$2" in ''|null)json_add_null parent_rss_kb;;*)json_add_int parent_rss_kb "$2";;esac
    case "$3" in ''|null)json_add_null parent_peak_rss_kb;;*)json_add_int parent_peak_rss_kb "$3";;esac
    json_add_string usage_scope 'agent parent only; CPU share of total machine; curl and collectors excluded'
    json_add_int queue_bytes "$(queue_bytes)";json_add_int queue_limit_bytes "$queue_limit"
    read -r drops < "$STATE/dropped";json_add_int dropped_items "$drops"
    if [ -r "$STATE/log-dropped" ];then read -r log_dropped < "$STATE/log-dropped";json_add_int dropped_logs "$log_dropped";fi
    json_add_boolean pending "$([ -s "$STATE/pending" ] && echo 1 || echo 0)"
    json_add_string last_error "$last_error";json_add_string last_success_uptime_s "${last_success:-}"
    json_add_boolean clock_synced "$([ "$clock_synced" = true ] && echo 1 || echo 0)"
    json_add_boolean adaptive_sampling "${adaptive_active:-0}"
    json_add_string pressure_reason "${pressure_reason:-}"
    json_add_int effective_sample_interval "${effective_sample_interval:-$sample_interval}"
    json_add_boolean cloud_diagnostics_enabled "${remote_diagnostics_enabled:-0}"
    json_add_int retry_s "$retry_delay";json_add_int sample_interval "$sample_interval";json_add_int upload_interval "$upload_interval"
    json_add_boolean logs_enabled "$logs_enabled";json_add_boolean privacy_addresses "$privacy_addresses"
    json_dump > "$STATE/status.base";attach_snapshot_status "$STATE/status.base" > "$STATE/status.new"
    mv "$STATE/status.new" "$STATE/status.json";rm -f "$STATE/status.base"
}
child_alive() {
    number "$1" || return 1
    [ -r "/proc/$1/stat" ] || return 1
    IFS= read -r proc_line < "/proc/$1/stat" || return 1
    proc_fields=${proc_line##*) };set -- $proc_fields
    [ "$2" = "$$" ] && kill -0 "${proc_line%% *}" 2>/dev/null
}
terminate_roots() {
    child_roots="$*"
    # Freeze supervised roots before enumerating descendants, so stopped collectors cannot
    # spawn new writers while cleanup releases the lock to a replacement instance.
    owned_roots=''
    for child in $child_roots;do if child_alive "$child";then owned_roots="$owned_roots $child";kill -STOP "$child" 2>/dev/null;fi;done
    child_roots=$owned_roots
    tree=$(awk -v roots="$child_roots" '
        {pid=$1;sub(/^.*\) /,"");parent[pid]=$2}
        END{n=split(roots,r," ");for(i=1;i<=n;i++)if(r[i]~/^[0-9]+$/)inside[r[i]]=1;
        for(pass=0;pass<16;pass++)for(k in parent)if(parent[k] in inside)inside[k]=1;
        for(k in inside)printf "%s ",k}' /proc/[0-9]*/stat 2>/dev/null)
    [ -z "$tree" ] || kill -KILL $tree 2>/dev/null
    for child in $child_roots;do wait "$child" 2>/dev/null;done
}
cleanup() {
    terminate_children
    snapshot_mark retrying telemetry_stopped "$(pending_snapshot_id)"
    rm -f "$STATE/logpipe" "$STATE/auth" "$STATE/lock/pid"
    rmdir "$STATE/lock" 2>/dev/null
}
terminate_children() {
    terminate_roots "$upload_pid" "$detail_pid" "$process_pid" "$wifi_pid" "$probe_pid" "$log_pid" "$logread_pid" "$tick_pid"
}
stop_logs() {
    terminate_roots "$log_pid" "$logread_pid" "$tick_pid"
    log_pid='';logread_pid='';tick_pid=''
    rm -f "$STATE/logpipe"
}
start_logs() {
    [ "$logs_enabled" = 1 ] || return
    rm -f "$STATE/logpipe";mkfifo -m 600 "$STATE/logpipe"
    awk -v stream=1 -v spool="$STATE/logs" -v threshold="$log_severity" -v budget=100 \
        -v addresses="$privacy_addresses" -v dropfile="$STATE/log-dropped" -f "$LIB/logs.awk" < "$STATE/logpipe" &
    log_pid=$!
    TZ=UTC0 logread -f > "$STATE/logpipe" 2>/dev/null & logread_pid=$!
    (while sleep 5;do printf '__NICX_TICK__\n';done) > "$STATE/logpipe" & tick_pid=$!
}
main() {
    init_state || exit 1
    # A second instance never removes or steals the current process's lock.
    if ! mkdir "$STATE/lock" 2>/dev/null;then
        read -r owner < "$STATE/lock/pid" 2>/dev/null
        number "$owner" && kill -0 "$owner" 2>/dev/null && exit 1
        rm -f "$STATE/lock/pid";rmdir "$STATE/lock" 2>/dev/null
        mkdir "$STATE/lock" 2>/dev/null || exit 1
    fi
    echo $$ > "$STATE/lock/pid";trap cleanup EXIT;trap 'exit 0' INT TERM
    load_config
    [ "$enabled" = 1 ] && valid_endpoint "$endpoint" && valid_uuid "$device_id" || exit 1
    prior_device='';[ ! -r "$STATE/device_id" ] || read -r prior_device < "$STATE/device_id"
    if [ -n "$prior_device" ] && [ "$prior_device" != "$device_id" ];then
        # Enrollment into another device/account cannot replay the prior device's observations.
        rm -f "$STATE/queue/"* "$STATE/logs/"* "$STATE/pending" "$STATE/pending.drops" "$STATE/snapshot" "$STATE/snapshot.pending"
        rm -f "$STATE/"*.dirty "$STATE/"*.consuming "$STATE/detail.json" "$STATE/process.json" "$STATE/wifi.json" "$STATE/connectivity.json"
        echo 0 > "$STATE/sequence";echo 0 > "$STATE/dropped"
    fi
    printf '%s\n' "$device_id" > "$STATE/device_id"
    read -r boot_id < /proc/sys/kernel/random/boot_id
    rm -f "$STATE/cpu.previous" "$STATE/network.previous" "$STATE/parent-usage.previous"
    if [ -d "$STATE/snapshot.lock" ];then
        snapshot_owner='';read -r snapshot_owner < "$STATE/snapshot.lock/pid" 2>/dev/null
        if ! number "$snapshot_owner" || ! kill -0 "$snapshot_owner" 2>/dev/null;then rm -f "$STATE/snapshot.lock/pid";rmdir "$STATE/snapshot.lock" 2>/dev/null;fi
    fi
    if [ ! -d "$STATE/snapshot.lock" ] && [ ! -s "$STATE/snapshot" ] && [ -z "$(pending_snapshot_id)" ];then
        snapshot_mark failed snapshot_interrupted "$(jsonfilter -i "$STATE/snapshot-status.json" -e '@.request_id' 2>/dev/null)"
    fi
    # Recover a seal interrupted before its immutable body was committed.
    if [ -s "$STATE/snapshot.pending" ] && [ ! -s "$STATE/pending" ];then mv "$STATE/snapshot.pending" "$STATE/snapshot";fi
    if [ "$diagnostics_enabled" != 1 ];then
        if [ -s "$STATE/snapshot" ];then
            snapshot_mark failed diagnostics_disabled "$(jsonfilter -i "$STATE/snapshot" -e '@.request_id' 2>/dev/null)";rm -f "$STATE/snapshot"
        fi
        pending_diag_id=$(pending_snapshot_id)
        if [ -n "$pending_diag_id" ];then
            snapshot_mark failed diagnostics_disabled "$pending_diag_id";pending_count;add_drop "$pending_items"
            rm -f "$STATE/pending" "$STATE/pending.drops" "$STATE/snapshot.pending"
        fi
    fi
    remote_diagnostics_enabled=0
    prior_privacy=0;[ ! -r "$STATE/privacy_addresses" ] || read -r prior_privacy < "$STATE/privacy_addresses"
    if [ "$logs_enabled" = 0 ] || { [ "$prior_privacy" = 1 ] && [ "$privacy_addresses" = 0 ]; };then purge_logs;fi
    printf '%s\n' "$privacy_addresses" > "$STATE/privacy_addresses"
    collect_inventory
    collect_detail & detail_pid=$!
    collect_processes & process_pid=$!
    collect_wifi & wifi_pid=$!
    collect_connectivity & probe_pid=$!
    start_logs
    uptime_now;now=${uptime%%.*}
    next_sample=0;next_wifi=$((now+wifi_interval));next_process=$((now+process_interval));next_detail=$((now+detail_interval));next_probe=$((now+30));next_upload=0;next_status=0;retry_delay=0
    backoff=5;last_error='';last_success=''
    while :;do
        uptime_now;now=${uptime%%.*}
        [ "$now" -lt "$next_detail" ] || { if ! child_alive "$detail_pid";then wait "$detail_pid" 2>/dev/null;collect_detail & detail_pid=$!;fi;set_cadence "$detail_interval" 3600;next_detail=$((now+scheduled_interval)); }
        [ "$now" -lt "$next_process" ] || { if ! child_alive "$process_pid";then wait "$process_pid" 2>/dev/null;collect_processes & process_pid=$!;fi;set_cadence "$process_interval" 1800;next_process=$((now+scheduled_interval)); }
        [ "$now" -lt "$next_wifi" ] || { if ! child_alive "$wifi_pid";then wait "$wifi_pid" 2>/dev/null;collect_wifi & wifi_pid=$!;fi;set_cadence "$wifi_interval" 900;next_wifi=$((now+scheduled_interval)); }
        [ "$now" -lt "$next_probe" ] || { if ! child_alive "$probe_pid";then wait "$probe_pid" 2>/dev/null;collect_connectivity & probe_pid=$!;fi;set_cadence 30 120;next_probe=$((now+scheduled_interval)); }
        [ "$now" -lt "$next_sample" ] || { collect_sample;next_sample=$((now+effective_sample_interval)); }
        import_logs
        if [ -n "$upload_pid" ] && ! child_alive "$upload_pid";then
            wait "$upload_pid" 2>/dev/null;upload_pid=''
            if finish_upload;then backoff=5;retry_delay=0;next_upload=$((now+upload_interval))
            else
                read -r random_uuid < /proc/sys/kernel/random/uuid;random=${random_uuid%%-*};random=$((0x$random))
                retry_delay=$((backoff+random%(backoff/4+1)));next_upload=$((now+retry_delay))
                backoff=$((backoff*2));[ "$backoff" -le 900 ] || backoff=900
            fi
        fi
        if [ -z "$upload_pid" ] && { [ "$now" -ge "$next_upload" ] || critical_upload_due "$now"; } && seal_batch;then
            rm -f "$STATE/upload.done"
            (upload_transport) & upload_pid=$!
        fi
        if [ "$now" -ge "$next_status" ];then write_status;next_status=$((now+5));fi
        sleep 1
    done
}
[ "${NICX_AGENT_LIBRARY_ONLY:-0}" = 1 ] || main "$@"
