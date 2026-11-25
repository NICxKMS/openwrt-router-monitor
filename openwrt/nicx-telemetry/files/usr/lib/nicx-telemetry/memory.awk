BEGIN { keys["MemTotal"]="mem_total_kb"; keys["MemFree"]="mem_free_kb"; keys["MemAvailable"]="mem_available_kb"; keys["Cached"]="cached_kb"; keys["Slab"]="slab_kb"; keys["SReclaimable"]="sreclaimable_kb"; keys["SUnreclaim"]="sunreclaim_kb" }
{ sub(/:$/,"",$1); if($1 in keys) values[$1]=$2 }
END { printf "{"; for(k in keys) { if(!(k in values) && k!="MemTotal" && k!="MemAvailable")continue; printf "%s\"%s\":%s",sep,keys[k],(k in values)?values[k]:"null";sep="," } print "}" }
