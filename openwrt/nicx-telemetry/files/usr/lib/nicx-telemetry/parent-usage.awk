# Inputs: parent /proc/PID/stat, aggregate /proc/stat, parent /proc/PID/status.
# CPU is the parent's share of total machine ticks. No HZ assumption or child times.
BEGIN {
    rss=peak="null";cpu="null"
    if((getline previous < state)>0){split(previous,p," ");old_ticks=p[1];old_total=p[2];have_previous=1}
    close(state)
}
FILENAME==ARGV[1] {
    sub(/^.*\) /,"");ticks=$12+$13;have_ticks=1
}
FILENAME==ARGV[2] && /^cpu / {
    total=0;for(i=2;i<=9;i++)total+=$i;have_total=1
}
FILENAME==ARGV[3] && /^VmRSS:/ {if($2~/^[0-9]+$/)rss=$2}
FILENAME==ARGV[3] && /^VmHWM:/ {if($2~/^[0-9]+$/)peak=$2}
END {
    if(have_ticks && have_total){
        elapsed=total-old_total;used=ticks-old_ticks
        if(have_previous && elapsed>0 && used>=0 && used<=elapsed)cpu=sprintf("%.3f",100*used/elapsed)
        printf "%.0f %.0f\n",ticks,total > state;close(state)
    }
    print cpu,rss,peak
}
