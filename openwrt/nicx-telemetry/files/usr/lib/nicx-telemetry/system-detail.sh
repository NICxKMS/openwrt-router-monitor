#!/bin/sh

diagnostic_uint() {
    case "$1" in ''|*[!0-9]*) return 1;; esac
    [ "${#1}" -le 15 ]
}

collect_device_tree_memory() {
    local root="$1" address_cells size_cells path node size count=0 total=0 device_type
    for path in "$root" "$root/reserved-memory"; do
        [ -r "$path/#address-cells" ] && [ -r "$path/#size-cells" ] || continue
        address_cells=$(hexdump -n 4 -v -e '1/1 "%02x"' "$path/#address-cells")
        size_cells=$(hexdump -n 4 -v -e '1/1 "%02x"' "$path/#size-cells")
        case "$address_cells:$size_cells" in
            0000000[12]:0000000[12]) address_cells=${address_cells#0000000}; size_cells=${size_cells#0000000};;
            *) continue;;
        esac
        if [ "$path" = "$root" ]; then
            for node in "$path"/memory "$path"/memory@*; do
                [ -r "$node/device_type" ] || continue
                device_type=$(head -c 16 "$node/device_type" | tr -d '\000')
                [ "$device_type" = memory ] || continue
                size=$(dt_reg_size "$node")
                diagnostic_uint "$size" && total=$((total + size))
                count=$((count + 1))
                [ "$count" -lt 16 ] || break
            done
            [ "$total" -le 0 ] || json_add_int dt_ram_bytes "$total"
        else
            json_add_array reservations
            collect_dt_reservations "$path"
            json_close_array
        fi
    done
}

dt_reg_size() {
    local status
    [ -r "$1/reg" ] || return
    if [ -r "$1/status" ]; then
        status=$(head -c 16 "$1/status" | tr -d '\000')
        case "$status" in ok|okay) ;; *) return;; esac
    fi
    hexdump -n 129 -v -e '1/1 "%02x"' "$1/reg" |
        awk -v mode=reg -v address_cells="$address_cells" -v size_cells="$size_cells" -f "$LIB/memory-detail.awk"
}

collect_dt_reservations() {
    local root="$1" path node name size digest count=0 LC_ALL=C
    for path in "$root"/*; do
        [ -d "$path" ] || continue
        count=$((count + 1))
        [ "$count" -le 32 ] || break
        node=${path##*/}
        name=${node%%@*}
        case "$name" in ''|*[!a-zA-Z0-9_.,-]*) continue;; esac
        [ "${#name}" -le 64 ] || continue
        size=$(dt_reg_size "$path")
        diagnostic_uint "$size" || continue
        json_add_object ''
        # Hash the full node name so duplicate labels and list changes do not move IDs.
        digest=$(printf '%s' "$node" | sha256sum)
        digest=${digest%% *}
        [ "${#digest}" -ne 64 ] || json_add_string id "reservation-$(printf '%.16s' "$digest")"
        json_add_string name "$name"
        json_add_int bytes "$size"
        [ ! -f "$path/no-map" ] || json_add_boolean no_map 1
        [ ! -f "$path/reusable" ] || json_add_boolean reusable 1
        json_close_object
    done
}

collect_memory_diagnostics() {
    local proc="$1" sys="$2" page_kb mode input key value zone last largest orders order
    local allocated count name path original compressed peak limit rest field
    page_kb=$(awk '/^KernelPageSize:/ {print $2; exit}' "$proc/self/smaps" 2>/dev/null)
    diagnostic_uint "$page_kb" && json_add_int page_kb "$page_kb"

    for mode in accounting kernel; do
        awk -v mode="$mode" -f "$LIB/memory.awk" "$proc/meminfo" > "$STATE/memdetail.input"
        json_add_object "${mode}_kb"
        while read -r key value; do json_add_int "$key" "$value"; done < "$STATE/memdetail.input"
        json_close_object
    done

    collect_device_tree_memory "$sys/firmware/devicetree/base"
    json_add_array zones
    if [ -r "$proc/zoneinfo" ] && timeout 2 awk -v mode=zone -f "$LIB/memory-detail.awk" "$proc/zoneinfo" > "$STATE/memdetail.input"; then
        last=; count=0
        while read -r zone key value; do
            if [ "$zone" != "$last" ]; then
                [ -z "$last" ] || json_close_object
                last=; count=$((count + 1)); [ "$count" -le 16 ] || break
                json_add_object ''
                json_add_string zone "$zone"
                last="$zone"
            fi
            json_add_int "$key" "$value"
        done < "$STATE/memdetail.input"
        [ -z "$last" ] || json_close_object
    fi
    json_close_array

    json_add_array free_blocks
    if [ -r "$proc/buddyinfo" ] && timeout 2 awk -v mode=buddy -f "$LIB/memory-detail.awk" "$proc/buddyinfo" > "$STATE/memdetail.input"; then
        count=0
        while read -r zone largest orders; do
            count=$((count + 1)); [ "$count" -le 16 ] || break
            json_add_object ''
            json_add_string zone "$zone"
            json_add_int largest_order "$largest"
            json_add_array blocks_by_order
            for order in $orders; do json_add_int '' "$order"; done
            json_close_array
            json_close_object
        done < "$STATE/memdetail.input"
    fi
    json_close_array

    for mode in slab allocinfo; do
        case "$mode" in slab) input=slabinfo;; allocinfo) input=allocinfo;; esac
        if [ -r "$proc/$input" ] &&
            timeout 3 awk -v mode="$mode" -v page_kb="${page_kb:-0}" -f "$LIB/memory-detail.awk" "$proc/$input" > "$STATE/memdetail.input" 2>/dev/null; then
            json_add_array "$mode"
            while read -r allocated count name; do
                json_add_object ''
                json_add_int allocated_bytes "$allocated"
                json_add_string name "$name"
                case "$mode" in
                    slab) json_add_int active_object_bytes "$count";;
                    allocinfo) json_add_string allocations "$count";;
                esac
                json_close_object
            done < "$STATE/memdetail.input"
            json_close_array
        fi
    done
    rm -f "$STATE/memdetail.input"

    json_add_object swap
    while read -r key value rest; do
        case "$key" in
            SwapTotal:) json_add_int total_kb "$value";;
            SwapFree:) json_add_int free_kb "$value";;
        esac
    done < "$proc/meminfo"
    json_close_object

    json_add_array zram
    count=0
    for path in "$sys"/block/zram[0-9]*/mm_stat; do
        [ -r "$path" ] || continue
        read -r original compressed allocated limit peak rest < "$path" || continue
        diagnostic_uint "$original" && diagnostic_uint "$compressed" && diagnostic_uint "$allocated" || continue
        count=$((count + 1)); [ "$count" -le 4 ] || break
        name=${path%/mm_stat}
        json_add_object ''
        json_add_string name "${name##*/}"
        json_add_int original_bytes "$original"
        json_add_int compressed_bytes "$compressed"
        json_add_int allocated_bytes "$allocated"
        diagnostic_uint "$limit" && json_add_int limit_bytes "$limit"
        diagnostic_uint "$peak" && json_add_int peak_bytes "$peak"
        json_close_object
    done
    json_close_array

    json_add_object sockets
    if [ -r "$proc/net/sockstat" ]; then
        while read -r name rest; do
            case "$name" in sockets:|TCP:|UDP:|UDPLITE:|RAW:|FRAG:) ;; *) continue;; esac
            json_add_object "${name%:}"
            set -- $rest
            while [ "$#" -ge 2 ]; do
                field="$1"; value="$2"; shift 2
                case "$field" in used|inuse|orphan|tw|alloc|mem|memory)
                    diagnostic_uint "$value" && json_add_int "$field" "$value";;
                esac
            done
            json_close_object
        done < "$proc/net/sockstat"
    fi
    json_close_object
}

collect_cpu_diagnostics() {
    local proc="$1" sys="$2" path name field value count=0
    json_add_array cpu_frequency
    for path in "$sys"/devices/system/cpu/cpufreq/policy[0-9]*; do
        [ -d "$path" ] || continue
        count=$((count + 1)); [ "$count" -le 16 ] || break
        json_add_object ''
        json_add_string policy "${path##*/}"
        for field in scaling_cur_freq scaling_min_freq scaling_max_freq; do
            [ -r "$path/$field" ] || continue
            read -r value < "$path/$field"
            diagnostic_uint "$value" && json_add_int "$field" "$value"
        done
        json_close_object
    done
    json_close_array
    json_add_object cpu_softirq
    if [ -r "$proc/softirqs" ]; then
        awk 'NR<=20 && $1 ~ /^[A-Z_]+:$/ {
            total=0
            for(i=2;i<=NF;i++) total+=$i
            printf "%s %.0f\n", substr($1,1,length($1)-1),total
        }' "$proc/softirqs" > "$STATE/softirq.input"
        while read -r name value; do json_add_string "$name" "$value"; done < "$STATE/softirq.input"
        rm -f "$STATE/softirq.input"
    fi
    json_close_object
}
