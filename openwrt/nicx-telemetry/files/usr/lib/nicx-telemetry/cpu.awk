# /proc/stat: user/nice already include guest; sum only fields user..steal.
BEGIN {
    while ((getline line < state) > 0) { split(line,p," "); total[p[1]]=p[2]; idle[p[1]]=p[3] }
    close(state)
}
/^cpu([0-9]+)? / {
    t=0; for(i=2;i<=9;i++) t+=$i
    exists=($1 in total); z=$5+$6; dt=t-total[$1]; di=z-idle[$1]
    value="null"
    if (exists && dt>0 && di>=0 && di<=dt) value=sprintf("%.3f",100*(dt-di)/dt)
    if ($1=="cpu") aggregate=value
    else { cores=cores sep "\"" $1 "\":" value; sep="," }
    nextstate=nextstate $1 " " sprintf("%.0f %.0f",t,z) "\n"
}
END {
    printf "{\"cpu_pct\":%s,\"cores\":{%s}}\n",aggregate==""?"null":aggregate,cores
    printf "%s",nextstate > state; close(state)
}
