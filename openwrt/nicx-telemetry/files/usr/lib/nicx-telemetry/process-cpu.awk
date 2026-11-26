# Compare CPU ticks across samples. PID and start time together identify a task.
BEGIN {
    while ((getline line < state) > 0) {
        split(line, fields, " ")
        if (fields[1]=="cpu") previous_total=fields[2]
        else ticks[fields[1] ":" fields[2]]=fields[3]
    }
    close(state)
}
/^cpu / {
    for (i=2; i<=9; i++) total+=$i
    elapsed=total-previous_total
    next_snapshot=sprintf("cpu %.0f\n",total)
}
/^[0-9]+ \(/ && total>0 && count<512 {
    pid=$1
    # The command name may contain spaces or parentheses. Export only safe names.
    if (!match($0,/^.*\) /)) next
    name=substr($0,length(pid)+3,RLENGTH-length(pid)-4)
    if (name !~ /^[A-Za-z0-9_.:-]+$/ || length(name)>64) name = "task"
    if (split(substr($0,RLENGTH+1), fields, " ")<20) next
    start=fields[20]
    if (start !~ /^[0-9]+$/ || fields[12] !~ /^[0-9]+$/ || fields[13] !~ /^[0-9]+$/) next
    current=fields[12]+fields[13]
    key=pid ":" start
    next_snapshot=next_snapshot sprintf("%s %s %.0f\n",pid,start,current)
    count++
    if (previous_total<=0 || elapsed<=0 || !(key in ticks)) next
    delta=current-ticks[key]
    if (delta>0 && delta<=elapsed)
        printf "%.3f %s %s\n",100*delta/elapsed,pid,name
}
END {
    if (total>0) {
        printf "%s",next_snapshot > (state ".new")
        close(state ".new")
    }
}
