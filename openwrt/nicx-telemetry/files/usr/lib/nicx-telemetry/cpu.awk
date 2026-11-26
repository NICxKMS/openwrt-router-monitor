# /proc/stat user and nice include guest time. Split guest out of the modes.
BEGIN {
    split("user nice system idle iowait irq softirq steal guest guest_nice", mode, " ")
    while ((getline line < state) > 0) {
        count = split(line, previous, " ")
        if (count != 11) continue
        for (i = 1; i <= 10; i++) last[previous[1], i] = previous[i + 1]
    }
    close(state)
}
/^cpu([0-9]+)?[[:space:]]/ && ++cpu_rows <= 65 {
    total = 0
    valid = (($1, 1) in last)
    nextstate = nextstate $1
    for (i = 1; i <= 10; i++) {
        delta[i] = $(i + 1) - last[$1, i]
        if (delta[i] < 0) valid = 0
        if (i <= 8) total += delta[i]
        nextstate = nextstate sprintf(" %.0f", $(i + 1))
    }
    nextstate = nextstate "\n"
    delta[1] -= delta[9]
    delta[2] -= delta[10]
    value = "null"
    if (valid && total > 0 && delta[1] >= 0 && delta[2] >= 0) {
        value = sprintf("%.3f", 100 * (total - delta[4] - delta[5]) / total)
        modes = ""
        for (i = 1; i <= 10; i++) {
            percent = sprintf("%.2f", 100 * delta[i] / total)
            sub(/0+$/, "", percent)
            sub(/\.$/, "", percent)
            modes = modes (i == 1 ? "" : ",") ($1 == "cpu" ? "\"" mode[i] "\":" : "") percent
        }
        if ($1 == "cpu") aggregate_modes = modes
        else if (cpu_rows <= 17) {
            core_modes = core_modes mode_sep "\"" $1 "\":[" modes "]"
            mode_sep = ","
        }
    }
    if ($1 == "cpu") aggregate = value
    else {
        cores = cores core_sep "\"" $1 "\":" value
        core_sep = ","
    }
}
/^(ctxt|intr|softirq|procs_running|procs_blocked|processes) / && $2 ~ /^[0-9]+$/ {
    scheduler = scheduler scheduler_sep "\"" $1 "\":\"" $2 "\""
    scheduler_sep = ","
}
END {
    printf "{\"cpu_pct\":%s,", aggregate == "" ? "null" : aggregate
    if (sample) printf "\"detail\":{\"cpu\":{"
    if (sample) printf "\"cores\":{%s}}", cores
    else printf "\"cores\":{%s},\"modes\":{%s},\"core_modes\":{%s},\"scheduler\":{%s}}",
        cores, aggregate_modes, core_modes, scheduler
    print sample ? "}}" : ""
    printf "%s", nextstate > state
    close(state)
}
