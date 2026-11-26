BEGIN {
    keys["MemTotal"]="mem_total_kb"; keys["MemFree"]="mem_free_kb"; keys["MemAvailable"]="mem_available_kb"
    keys["Cached"]="cached_kb"; keys["Slab"]="slab_kb"
    keys["SReclaimable"]="sreclaimable_kb"; keys["SUnreclaim"]="sunreclaim_kb"
}
/^[A-Za-z_()]+:[[:space:]]/ && $2 ~ /^[0-9]+$/ {
    sub(/:$/, "", $1)
    values[$1] = $2 + 0
}
function emit(key, value) {
    printf "%s %.0f\n", key, value
}
function bucket(key, field) {
    if (!(field in values)) return
    emit(key, values[field])
    accounted += values[field]
}
END {
    if (mode == "accounting") {
        bucket("free", "MemFree")
        bucket("anonymous", "AnonPages")
        bucket("shared_and_tmpfs", "Shmem")
        if (("Cached" in values) && ("Shmem" in values) && values["Cached"] >= values["Shmem"]) {
            cache = values["Cached"] - values["Shmem"]
            emit("file_cache", cache)
            accounted += cache
        }
        bucket("block_buffers", "Buffers")
        bucket("slab", "Slab")
        if (("KReclaimable" in values) && ("SReclaimable" in values) && values["KReclaimable"] >= values["SReclaimable"]) {
            reclaimable = values["KReclaimable"] - values["SReclaimable"]
            emit("other_reclaimable_kernel", reclaimable)
            accounted += reclaimable
        }
        bucket("kernel_stacks", "KernelStack")
        bucket("shadow_call_stacks", "ShadowCallStack")
        bucket("page_tables", "PageTables")
        bucket("secondary_page_tables", "SecPageTables")
        bucket("per_cpu", "Percpu")
        bucket("hugetlb", "Hugetlb")
        if ("MemTotal" in values) emit("total", values["MemTotal"])
        required = split("MemTotal MemFree AnonPages Shmem Cached Buffers Slab KernelStack PageTables", fields, " ")
        complete = 1
        for (i = 1; i <= required; i++) if (!(fields[i] in values)) complete = 0
        if (complete && values["Cached"] >= values["Shmem"]) {
            emit("measured_categories", accounted)
            emit("counter_difference", values["MemTotal"] - accounted)
        }
    } else if (mode == "kernel") {
        count = split("Active Inactive Unevictable Mlocked Dirty Writeback Mapped SwapCached SReclaimable SUnreclaim VmallocUsed CmaTotal CmaFree AnonHugePages ShmemHugePages FileHugePages KernelStack PageTables", fields, " ")
        for (i = 1; i <= count; i++) if (fields[i] in values) emit(fields[i], values[fields[i]])
    } else {
        printf "{"
        for (key in keys) {
            if (!(key in values) && key != "MemTotal" && key != "MemAvailable") continue
            printf "%s\"%s\":%s", separator, keys[key], (key in values) ? sprintf("%.0f", values[key]) : "null"
            separator = ","
        }
        print "}"
    }
}
