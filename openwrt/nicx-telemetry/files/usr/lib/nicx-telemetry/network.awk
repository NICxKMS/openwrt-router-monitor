# Input: validated interface role ifindex monotonic_uptime decimal_rx decimal_tx.
# Decimal subtraction BEFORE conversion prevents loss above IEEE-754 integer range.
function normalize(x) { sub(/^0+/,"",x); return x==""?"0":x }
function less(a,b) { a=normalize(a);b=normalize(b); return length(a)<length(b) || (length(a)==length(b) && ("x" a)<("x" b)) }
function subtract(a,b, i,j,carry,n,r) {
    if(less(a,b))return "null"
    carry=0;r="";j=length(b)
    for(i=length(a);i>0;i--) { n=substr(a,i,1)-(j>0?substr(b,j--,1):0)-carry;carry=n<0; if(n<0)n+=10;r=n r }
    r=normalize(r); return less("9007199254740991",r)?"null":sprintf("%.0f",r+0)
}
BEGIN { while((getline line < state)>0){split(line,p," "); oldrole[p[1]]=p[2];oldindex[p[1]]=p[3];oldtime[p[1]]=p[4];rx[p[1]]=p[5];tx[p[1]]=p[6]} close(state) }
$1 ~ /^[a-zA-Z0-9_.:-]+$/ && $5 ~ /^[0-9]+$/ && $6 ~ /^[0-9]+$/ {
    dr="null";dt="null";elapsed="null";reset=1
    if(($1 in rx) && oldindex[$1]==$3 && $4>oldtime[$1]) {
        dr=subtract($5,rx[$1]);dt=subtract($6,tx[$1]);elapsed=sprintf("%.3f",$4-oldtime[$1]);reset=(dr=="null" || dt=="null")
    }
    if(reset){dr="null";dt="null";elapsed="null"}
    row=sprintf("{\"name\":\"%s\",\"role\":\"%s\",\"rx_bytes\":\"%s\",\"tx_bytes\":\"%s\",\"rx_delta\":%s,\"tx_delta\":%s,\"elapsed_s\":%s,\"reset\":%s}",$1,$2,$5,$6,dr,dt,elapsed,reset?"true":"false")
    list=list sep row;sep=","; nextstate=nextstate $0 "\n"
    if($2=="wan" || $2=="usbwan") { uplinks++; if(reset || oldrole[$1]!=$2)bad=1;else {sr+=dr;st+=dt;if(e!="" && e!=elapsed)bad=1;e=elapsed} }
}
END {
    if(!uplinks || bad || sr>9007199254740991 || st>9007199254740991){r="null";t="null";e="null"}else {r=sprintf("%.0f",sr);t=sprintf("%.0f",st)}
    printf "{\"interfaces\":[%s],\"rx_bytes_delta\":%s,\"tx_bytes_delta\":%s,\"elapsed_s\":%s}\n",list,r,t,e
    printf "%s",nextstate > state;close(state)
}
