export type Row = Record<string, unknown>;
export interface Device {id:string;name:string;model:string|null;last_seen_at:string|null;revoked_at:string|null;config:Record<string,unknown>}
export interface Sample {bucket?:string;received_at?:string;observed_at?:string;effective_at?:string;uptime_s?:number;cpu_pct:number|null;cpu_min?:number|null;cpu_max?:number|null;load1?:number|null;mem_available_kb:number|null;mem_total_kb?:number|null;mem_free_kb?:number|null;cached_kb?:number|null;slab_kb?:number|null;sreclaimable_kb?:number|null;sunreclaim_kb?:number|null;temp_c:number|null;rx_bytes_delta:number|null;tx_bytes_delta:number|null;elapsed_s:number|null;detail?:Row;interfaces?:Row[];sample_count?:number}
export interface TimeRange {from:string;to:string;live:boolean;hours:number}
export const nowRange=(hours=6):TimeRange=>({from:new Date(Date.now()-hours*3600000).toISOString(),to:new Date().toISOString(),live:true,hours});
export const num=(v:unknown):number|null=>typeof v==='number'&&Number.isFinite(v)?v:null;
export const fmt=(v:unknown,suffix='',digits=1)=>num(v)===null?'—':`${Number(v).toLocaleString(undefined,{maximumFractionDigits:digits})}${suffix}`;
export function bytes(v:unknown):string {const n=typeof v==='string'?Number(v):num(v);if(n===null||!Number.isFinite(n))return '—';const unit=n===0?0:Math.min(4,Math.max(0,Math.floor(Math.log(Math.abs(n))/Math.log(1024))));return `${(n/1024**unit).toLocaleString(undefined,{maximumFractionDigits:1})} ${['B','KiB','MiB','GiB','TiB'][unit]}`;}
export const rate=(delta:unknown,seconds:unknown)=>num(delta)!==null&&num(seconds)!==null&&Number(seconds)>0?Number(delta)*8/Number(seconds)/1e6:null;
export function date(v:unknown,zone:string,full=false){if(typeof v!=='string'||!Number.isFinite(Date.parse(v)))return '—';return new Intl.DateTimeFormat('en-IN',{timeZone:zone,...(full?{dateStyle:'medium' as const,timeStyle:'medium' as const}:{hour:'2-digit' as const,minute:'2-digit' as const,second:'2-digit' as const})}).format(new Date(v));}
export const uptime=(v:unknown)=>num(v)===null?'—':`${Math.floor(Number(v)/86400)}d ${Math.floor(Number(v)%86400/3600)}h ${Math.floor(Number(v)%3600/60)}m`;
export function safeCsv(rows:Row[]){if(!rows.length)return '';const keys=Array.from(new Set(rows.flatMap(Object.keys)));const cell=(v:unknown)=>{let s=typeof v==='object'?JSON.stringify(v):String(v??'');if(/^[\s\u0000-\u001f]*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};return [keys.map(cell).join(','),...rows.map(r=>keys.map(k=>cell(r[k])).join(','))].join('\r\n');}
export function download(rows:Row[],name:string,type:'csv'|'json'){const a=document.createElement('a');const url=URL.createObjectURL(new Blob([type==='csv'?safeCsv(rows):JSON.stringify(rows,null,2)],{type:type==='csv'?'text/csv;charset=utf-8':'application/json'}));a.href=url;a.download=`${name}.${type}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export function readPreference<T>(key:string,fallback:T):T {try {const value=localStorage.getItem('nicx:'+key);return value?JSON.parse(value) as T:fallback;}catch{return fallback;}}
export function writePreference(key:string,value:unknown){try{localStorage.setItem('nicx:'+key,JSON.stringify(value));}catch{/* Browser storage may be disabled. */}}
export const object=(v:unknown):Row=>v&&typeof v==='object'&&!Array.isArray(v)?v as Row:{};
export const rows=(v:unknown):Row[]=>Array.isArray(v)?v.filter(x=>x&&typeof x==='object') as Row[]:[];

export function matchUptimeWindows(a:Sample[],b:Sample[],start:number,end:number){const from=Math.max(start,a[0]?.uptime_s??Infinity,b[0]?.uptime_s??Infinity),to=Math.min(end,a.at(-1)?.uptime_s??-Infinity,b.at(-1)?.uptime_s??-Infinity);if(from>=to)return null;return {a:a.filter(v=>v.uptime_s!>=from&&v.uptime_s!<=to),b:b.filter(v=>v.uptime_s!>=from&&v.uptime_s!<=to),from,to};}

export const timeRangeKey=(range:TimeRange)=>range.live?'live:'+range.hours:range.from+':'+range.to;
export const MAX_RAW_SAMPLES=30000;
export const retainedSampleEstimate=(sampleInterval:number,days:number)=>Math.min(MAX_RAW_SAMPLES,Math.ceil(days*86400/sampleInterval));
export function cloudConfig(config:Row):Row{return Object.fromEntries(Object.entries(config).filter(([key])=>!['buffer_kb','log_severity','privacy_addresses'].includes(key)));}
export function axisTimeLabel(value:unknown,zone:string){const time=typeof value==='number'?value:typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(time)?date(new Date(time).toISOString(),zone,true):'—';}
export function memoryCategories(sample:Partial<Sample>|null):Row[]{const info=object(object(sample?.detail).meminfo);return [['mem_free_kb','Free pages'],['cached_kb','File cache'],['slab_kb','Total slab'],['sreclaimable_kb','Reclaimable slab'],['sunreclaim_kb','Unreclaimable slab']].map(([key,name])=>({key,name,bytes:num(info[key])!==null?Number(info[key])*1024:num(sample?.[key as keyof Sample])!==null?Number(sample?.[key as keyof Sample])*1024:null}));}
