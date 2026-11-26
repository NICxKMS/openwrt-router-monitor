# Read only named counters. Results contain sizes, never physical addresses.
NR > 30000 { exit 2 }
function rank(bytes, count, name,    position, row) {
    for (position = 1; position <= 12; position++)
        if (!(position in sizes) || bytes + 0 > sizes[position]) break
    if (position > 12) return
    if (ranked < 12) ranked++
    for (row = ranked; row > position; row--) {
        sizes[row] = sizes[row - 1]
        entries[row] = entries[row - 1]
    }
    sizes[position] = bytes + 0
    entries[position] = sprintf("%.0f %s %s", bytes, count, name)
}
mode == "reg" {
    width = (address_cells + size_cells) * 8
    if ((address_cells != 1 && address_cells != 2) ||
        (size_cells != 1 && size_cells != 2) || $0 !~ /^[0-9a-f]+$/ ||
        length($0) > 8 * width || length($0) % width) next
    total = 0
    for (offset = address_cells * 8 + 1; offset <= length($0); offset += width) {
        size = 0
        for (i = offset; i < offset + size_cells * 8; i++)
            size = size * 16 + index("0123456789abcdef", substr($0, i, 1)) - 1
        total += size
    }
    if (total < 9007199254740992) printf "%.0f\n", total
}
mode == "zone" && $1 == "Node" && $3 == "zone" {
    sub(/,$/, "", $2)
    zone = ($2 ~ /^[0-9]+$/ && $4 ~ /^[A-Za-z0-9_]+$/) ? $2 "_" $4 : ""
}
mode == "zone" && zone != "" && $NF ~ /^[0-9]+$/ {
    if ($1 == "pages" && $2 == "free") print zone, "free", $3
    else if ($1 ~ /^(min|low|high|spanned|present|managed)$/) print zone, $1, $2
}
mode == "buddy" && $1 == "Node" && $3 == "zone" {
    sub(/,$/, "", $2)
    if ($2 !~ /^[0-9]+$/ || $4 !~ /^[A-Za-z0-9_]+$/) next
    if (NF < 5 || NF > 24) next
    for (i = 5; i <= NF; i++) if ($i !~ /^[0-9]+$/) next
    largest = -1
    for (i = 5; i <= NF; i++) if ($i > 0) largest = i - 5
    printf "%s_%s %d", $2, $4, largest
    for (i = 5; i <= NF; i++) printf " %s", $i
    printf "\n"
}
mode == "slab" && NR == 1 { valid = ($1 == "slabinfo" && $4 == "2.1") }
mode == "slab" && valid && page_kb > 0 && $1 ~ /^[A-Za-z0-9_.:-]+$/ && length($1) <= 64 &&
    $2 ~ /^[0-9]+$/ && $4 ~ /^[0-9]+$/ && $6 ~ /^[0-9]+$/ &&
    $13 == "slabdata" && $15 ~ /^[0-9]+$/ && $15 > 0 {
    rank($15 * $6 * page_kb * 1024, sprintf("%.0f", $2 * $4), $1)
}
mode == "allocinfo" && NR == 1 { valid = ($1 == "allocinfo" && $4 ~ /^2\.[0-9]+$/) }
mode == "allocinfo" && valid && $1 ~ /^[0-9]+$/ && $1 > 0 && $2 ~ /^[0-9]+$/ &&
    $3 ~ /^[A-Za-z0-9_.\/+-]+:[0-9]+$/ && length($3) <= 160 && $0 !~ /[[:space:]]accurate:no([[:space:]]|$)/ {
    rank($1, $2, $3)
}
END {
    if (mode == "slab" || mode == "allocinfo") {
        if (!valid) exit 1
        for (i = 1; i in sizes; i++) print entries[i]
    }
}
