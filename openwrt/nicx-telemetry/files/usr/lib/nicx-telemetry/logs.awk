# One bounded slice, grouped AFTER redaction. No unredacted log files on disk.
function quote(s, i,c,out) {
    gsub(/[^ -~]/,"?",s);out="\""
    for(i=1;i<=length(s);i++){
        c=substr(s,i,1)
        if(c=="\\")out=out "\\\\"
        else if(c=="\"")out=out "\\\""
        else out=out c
    }
    return out "\""
}
function redact(s, lower) {
    lower=tolower(s)
    # Secret-bearing lines are entirely suppressed; token spellings vary by service.
    if(lower ~ /(authorization|bearer|password|passwd|psk|secret|token|api.key|private.key|cookie)/) return "[credential-bearing log redacted]"
    if(!addresses) {
        gsub(/[[:xdigit:]][[:xdigit:]](:[[:xdigit:]][[:xdigit:]])(:[[:xdigit:]][[:xdigit:]])(:[[:xdigit:]][[:xdigit:]])(:[[:xdigit:]][[:xdigit:]])(:[[:xdigit:]][[:xdigit:]])/,"[MAC]",s)
        gsub(/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/,"[IP]",s)
        # Conservative IPv6 replacement, including compressed and link-local forms.
        gsub(/[[:xdigit:]]*:[[:xdigit:]:]*:[[:xdigit:]:.]+(%[a-zA-Z0-9_.-]+)?/,"[IPv6]",s)
    }
    gsub(/[^ -~]/,"?",s)
    return substr(s,1,1024)
}
function emit( i,k,path,chunk,sep,allowed) {
    if(stream)synced=(system("test -f /tmp/nicx-telemetry-clock-synced")==0)
    if(!groups)return
    if(stream){
        slot=(slot+1)%4;path=spool "/" slot ".ready"
        allowed=(system("test ! -e " path)==0)
        if(!allowed){for(i=1;i<=groups;i++)dropped+=counts[order[i]]}
        if((getline line < "/proc/uptime")>0){split(line,t," ");uptime=t[1]}close("/proc/uptime")
    }else allowed=1
    emitted_bytes=0
    for(priority=0;priority<=7;priority++)for(i=1;i<=groups;i++){
        k=order[i];if(k=="" || level[k]!=priority)continue
        row=sprintf("{\"uptime_s\":%s,\"observed_at\":%s,\"severity\":%d,\"service\":%s,\"message\":%s,\"count\":%d,\"first_at\":%s,\"last_at\":%s}",uptime,first[k],level[k],quote(svc[k]),quote(msg[k]),counts[k],first[k],last[k])
        if(allowed){if(stream){if(emitted_bytes+length(row)+1<=16000){print row > (spool "/current.tmp");emitted_bytes+=length(row)+1}else dropped+=counts[k]}else print row}
        delete counts[k];delete msg[k];delete svc[k];delete level[k];delete order[i];delete first[k];delete last[k]
    }
    if(stream && allowed && emitted_bytes){close(spool "/current.tmp");system("mv " spool "/current.tmp " path)}
    groups=0;seen=0;low_seen=0
    if(dropfile!=""){print dropped+0 > dropfile;close(dropfile)}
}
BEGIN {split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec",months," ");for(i=1;i<=12;i++)month[months[i]]=i;
sev["emerg"]=0;sev["alert"]=1;sev["crit"]=2;sev["err"]=3;sev["warn"]=4;sev["warning"]=4;sev["notice"]=5;sev["info"]=6;sev["debug"]=7;if(!budget)budget=100}
{
    if(stream && $0=="__NICX_TICK__"){emit();next}
    # DNS query/reply logging and URL-like request records are never exported.
    if(tolower($0) ~ /(query\[|reply .* is |\/dns-query|https?:\/\/|dnsmasq.*(cached|forwarded))/)next
    n=split($6,p,"."); severity=(p[n] in sev)?sev[p[n]]:5
    if(severity>threshold)next
    if(stream){
        # Leave 20% of the occurrence budget available for later critical messages.
        if(seen>=budget || (severity>3 && low_seen>=int(budget*0.8))){dropped++;next}
        seen++;if(severity>3)low_seen++
    }else if(++seen>budget){dropped++;next}
    service=$7;sub(/\[[0-9]+\]:?$/,"",service);sub(/:$/,"",service)
    if(service !~ /^[a-zA-Z0-9_.\/-]+$/)service="system"
    message=$0;for(i=1;i<=7;i++) sub(/^[^ \t]+[ \t]+/,"",message)
    message=redact(message);key=severity SUBSEP service SUBSEP message
    if(!(key in counts)){
        slot_index=0
        if(stream && groups>=12){
            # Evict one lower-priority group instead of letting a notice storm hide OOM.
            if(severity<=3)for(j=groups;j>0;j--)if(level[order[j]]>3){slot_index=j;break}
            if(!slot_index){dropped++;next}
            previous=order[slot_index];dropped+=counts[previous]
            delete counts[previous];delete msg[previous];delete svc[previous];delete level[previous];delete first[previous];delete last[previous]
        }else slot_index=++groups
        order[slot_index]=key;msg[key]=message;svc[key]=substr(service,1,64);level[key]=severity
    }
    timestamp="null"
    if(synced && ($2 in month) && $5>=2025 && $5<=2100 && $3>=1 && $3<=31 && $4~/^[0-9][0-9]:[0-9][0-9]:[0-9][0-9]$/)
        timestamp=quote(sprintf("%04d-%02d-%02dT%sZ",$5,month[$2],$3,$4))
    if(!counts[key])first[key]=timestamp
    last[key]=timestamp
    counts[key]++
}
END { emit();if(dropfile!=""){print dropped+0 > dropfile;close(dropfile)} }
