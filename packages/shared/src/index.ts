import { z } from 'zod';

export const MAX_BODY_BYTES = 96 * 1024;
export const SCHEMA_VERSION = 1;
/** Approximate PostgreSQL JSONB text spacing, without counting commas inside strings. */
export function jsonStorageBytes(value:unknown):number {
  let extra=0,tooDeep=false;
  const visit=(v:unknown,depth=0):void=>{
    if(depth>16){tooDeep=true;return;}
    if(Array.isArray(v)){extra+=Math.max(0,v.length-1);v.forEach(x=>visit(x,depth+1));}
    else if(v && typeof v==='object'){const entries=Object.entries(v);extra+=entries.length+Math.max(0,entries.length-1);entries.forEach(([,x])=>visit(x,depth+1));}
    else if(typeof v==='number'&&String(v).includes('e'))extra+=24; // conservative exponent normalization budget
  };
  visit(value);if(tooDeep)return Infinity;return new TextEncoder().encode(JSON.stringify(value)).byteLength+extra;
}
const safeInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const gauge = z.number().finite().nonnegative().nullable();
const timestamp = z.iso.datetime({ offset: true }).nullable();
const uuid = z.uuid();
export const jsonObject = z.record(z.string().max(128), z.unknown()).superRefine((value, ctx) => {
  if (jsonStorageBytes(value) > 16384) ctx.addIssue({code:'custom',message:'Diagnostic object too large'});
  function check(v: unknown, depth: number): boolean {
    if (depth > 8) return false;
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (Array.isArray(v)) return v.length <= 256 && v.every(x => check(x,depth+1));
    if (typeof v === 'object') return Object.entries(v).length <= 256 && Object.entries(v).every(([k,x]) => !['__proto__','constructor','prototype'].includes(k) && check(x,depth+1));
    return false;
  }
  if (!check(value,0)) ctx.addIssue({code:'custom',message:'Invalid diagnostic structure'});
});

export const configSchema = z.object({
  sample_interval:z.number().int().min(5).max(300).optional(),
  upload_interval:z.number().int().min(15).max(900).optional(),
  wifi_interval:z.number().int().min(15).max(1800).optional(),
  process_interval:z.number().int().min(30).max(3600).optional(),
  detail_interval:z.number().int().min(60).max(3600).optional(),
  buffer_kb:z.number().int().min(1024).max(4096).optional(),
  logs_enabled:z.boolean().optional(),
  log_severity:z.number().int().min(0).max(7).optional(),
  privacy_addresses:z.boolean().optional(),
  diagnostics_enabled:z.boolean().optional(),
  retention_raw_days:z.number().int().min(1).max(7).optional(),
  retention_logs_days:z.number().int().min(1).max(14).optional(),
  monthly_quota_gb:z.number().min(0).max(100000).optional(),
  billing_day:z.number().int().min(1).max(28).optional(),
}).strict();
export const defaultConfig = Object.freeze({sample_interval:10,upload_interval:30,wifi_interval:30,process_interval:60,detail_interval:300,buffer_kb:2048,logs_enabled:true,log_severity:5,privacy_addresses:false,diagnostics_enabled:false,retention_raw_days:3,retention_logs_days:7,monthly_quota_gb:0,billing_day:1});
export type DeviceConfig = z.infer<typeof configSchema>;

export const interfaceSchema = z.object({
  name:z.string().regex(/^[a-zA-Z0-9_.:@-]{1,32}$/),role:z.enum(['wan','usbwan','lan','other']),
  rx_bytes:z.string().regex(/^\d{1,20}$/),tx_bytes:z.string().regex(/^\d{1,20}$/),
  rx_delta:safeInt.nullable(),tx_delta:safeInt.nullable(),elapsed_s:gauge,reset:z.boolean(),
}).strict();
export const sampleSchema = z.object({
  seq:safeInt,uptime_s:z.number().finite().nonnegative().max(1e10),observed_at:timestamp,
  cpu_pct:z.number().finite().min(0).max(100).nullable(),load1:gauge,
  mem_total_kb:safeInt.nullable(),mem_available_kb:safeInt.nullable(),
  mem_free_kb:safeInt.optional(),cached_kb:safeInt.optional(),slab_kb:safeInt.optional(),sreclaimable_kb:safeInt.optional(),sunreclaim_kb:safeInt.optional(),
  temp_c:z.number().finite().min(-50).max(200).nullable(),
  rx_bytes_delta:safeInt.nullable(),tx_bytes_delta:safeInt.nullable(),elapsed_s:gauge,
  interfaces:z.array(interfaceSchema).max(32).optional(),detail:jsonObject.optional(),
}).strict();
export const logSchema = z.object({seq:safeInt,uptime_s:z.number().finite().nonnegative().max(1e10),observed_at:timestamp,severity:z.number().int().min(0).max(7),service:z.string().min(1).max(64),message:z.string().max(1024),count:z.number().int().min(1).max(100000),first_at:timestamp.optional(),last_at:timestamp.optional()}).strict();
export const batchSchema = z.object({schema_version:z.literal(1),device_id:uuid,boot_id:uuid,batch_id:uuid,sent_at:timestamp,clock_synced:z.boolean(),samples:z.array(sampleSchema).max(12),logs:z.array(logSchema).max(100),inventory:jsonObject.optional(),diagnostics:jsonObject.optional(),dropped_samples:safeInt.optional()}).strict().superRefine((value,ctx)=>{
  for (const key of ['samples','logs'] as const) {
    if(new Set(value[key].map(x=>x.seq)).size!==value[key].length) ctx.addIssue({code:'custom',path:[key],message:'Duplicate sequence'});
  }
});
export type TelemetryBatch = z.infer<typeof batchSchema>;
export type Sample = z.infer<typeof sampleSchema>;

/** No guessing at wraparound: an unknown reset produces missing data. */
export function counterDelta(current:string, previous:string, elapsed:number, reset:boolean): {delta:number|null;perSecond:number|null;reset:boolean} {
  if(reset || elapsed<=0 || !Number.isFinite(elapsed)) return {delta:null,perSecond:null,reset:true};
  try {
    const diff=BigInt(current)-BigInt(previous);
    if(diff<0n || diff>BigInt(Number.MAX_SAFE_INTEGER)) return {delta:null,perSecond:null,reset:true};
    return {delta:Number(diff),perSecond:Number(diff)/elapsed,reset:false};
  } catch { return {delta:null,perSecond:null,reset:true}; }
}

export function redact(input:string, addresses=true):string {
  let text=input
    .replace(/\b(?:authorization\s*:\s*)?(?:bearer|basic)\s+[^\s,;]+/gi,'[credential redacted]')
    .replace(/\b(password|passwd|secret|token|api[_-]?key|private[_-]?key|preshared[_-]?key)\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,'$1=[redacted]')
    .replace(/\b(?:nxd_|nxe_)[a-f0-9]{64}\b/gi,'[credential redacted]')
    .replace(/\bsb_secret_[A-Za-z0-9_-]+\b/g,'[credential redacted]')
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/gi,'https://[redacted]@');
  if(addresses) text=text.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,'[ip]').replace(/\b(?:[a-f0-9]{2}:){5}[a-f0-9]{2}\b/gi,'[mac]').replace(/(?<![\w])(?:[a-f0-9]{0,4}:){2,}[a-f0-9:.]{0,39}(?:%[a-z0-9]+)?/gi,'[ip6]');
  return text;
}
export function sanitizeJson(value:unknown,addresses=true,depth=0):unknown {
  if(depth>8) return null;
  if(typeof value==='string') return redact(value,addresses);
  if(Array.isArray(value)) return value.map(x=>sanitizeJson(x,addresses,depth+1));
  if(value!==null && typeof value==='object') return Object.fromEntries(Object.entries(value).filter(([k])=>!['__proto__','constructor','prototype'].includes(k)).map(([k,v])=>[k,/password|passwd|secret|token|api[_-]?key|private[_-]?key|preshared[_-]?key|authorization/i.test(k)?'[redacted]':sanitizeJson(v,addresses,depth+1)]));
  return value;
}
export function csv(rows:unknown[][]):string {
  return rows.map(row=>row.map(value=>{
    let text=value===null || value===undefined?'':String(value);
    if(/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text="'"+text;
    return '"'+text.replaceAll('"','""')+'"';
  }).join(',')).join('\r\n')+'\r\n';
}
export function selectResolution(seconds:number,ageSeconds=seconds,rawDays=3):number {
  if(seconds<=3*3600&&ageSeconds<=rawDays*86400)return 10;
  if(seconds<=2*86400&&ageSeconds<=30*86400)return 60;
  if(seconds<=14*86400&&ageSeconds<=180*86400)return 900;
  return ageSeconds<=365*86400?3600:86400;
}
export function estimateUsage(input:{routers:number;sampleInterval:number;uploadInterval:number;rawDays:number;rowBytes:number;viewers:number}) {
  const requestsPerDay=Math.ceil(86400/input.uploadInterval)*input.routers;
  return {estimated:true,requestsPerDay,requestsPerMonth:requestsPerDay*30,rawDatabaseBytes:Math.ceil(86400/input.sampleInterval)*input.routers*input.rawDays*input.rowBytes,realtimeMessagesPerMonth:requestsPerDay*30*input.viewers,workerDailyLimit:100000,databaseLimitBytes:500_000_000,storageLimitBytes:1_000_000_000};
}
