import { describe, it, expect } from 'vitest';
import { batchSchema, configSchema, counterDelta, redact, sanitizeJson, csv, selectResolution, estimateUsage } from '../../packages/shared/src/index';

const sample = { seq:1,uptime_s:10,observed_at:null,cpu_pct:null,load1:0.2,mem_total_kb:400000,mem_available_kb:200000,temp_c:null,rx_bytes_delta:null,tx_bytes_delta:null,elapsed_s:null };
const batch = {schema_version:1,device_id:'00000000-0000-4000-8000-000000000001',boot_id:'00000000-0000-4000-8000-000000000002',batch_id:'00000000-0000-4000-8000-000000000003',sent_at:null,clock_synced:false,samples:[sample],logs:[]};
describe('telemetry wire validation', () => {
  it('preserves unavailable values and accepts unsynchronized clock', () => expect(batchSchema.parse(batch).samples[0].cpu_pct).toBeNull());
  it('rejects expensive and unknown remote controls', () => {expect(configSchema.safeParse({sample_interval:0}).success).toBe(false);expect(configSchema.safeParse({command:'reboot'}).success).toBe(false);});
  it('rejects invalid ranges and unbounded detail', () => {expect(batchSchema.safeParse({...batch,samples:[{...sample,cpu_pct:101}]}).success).toBe(false);expect(batchSchema.safeParse({...batch,diagnostics:{value:'x'.repeat(20000)}}).success).toBe(false);});
  it('rejects duplicate sequence numbers within a batch', () => expect(batchSchema.safeParse({...batch,samples:[sample,sample]}).success).toBe(false));
  it('counts UTF-8 bytes in diagnostic objects',()=>expect(batchSchema.safeParse({...batch,diagnostics:{value:'界'.repeat(6000)}}).success).toBe(false));
  it('redacts API credentials from diagnostic keys',()=>expect(sanitizeJson({api_key:'secret',apiKey:'secret',API_KEY:'secret'})).toEqual({api_key:'[redacted]',apiKey:'[redacted]',API_KEY:'[redacted]'}));
  it('rejects integer-precision losing network counters', () => expect(batchSchema.safeParse({...batch,samples:[{...sample,interfaces:[{name:'wan',role:'wan',rx_bytes:123,tx_bytes:'1',rx_delta:null,tx_delta:null,elapsed_s:null,reset:true}]}]}).success).toBe(false));
});
describe('telemetry semantics', () => {
  it('calculates exact deltas beyond JS safe integer absolute counters', () => expect(counterDelta('9007199254741001','9007199254740993',10,false)).toEqual({delta:8,perSecond:0.8,reset:false}));
  it('never interprets reboots, unknown wraparound or missing time as traffic', () => {expect(counterDelta('2','90',10,false).delta).toBeNull();expect(counterDelta('100','90',0,false).delta).toBeNull();expect(counterDelta('100','90',10,true).delta).toBeNull();});
  it('redacts keys, auth headers, MACs and IP addresses', () => {const text = redact('Authorization: Bearer abcdef password=secret private_key=qwerty 192.168.1.10 aa:bb:cc:dd:ee:ff 2001:db8::1'); expect(text).not.toMatch(/abcdef|secret|qwerty|192\.168|aa:bb|2001:db8/);});
  it('escapes spreadsheet formulas and quotes', () => expect(csv([['=1+1','a"b']])).toBe('"\'=1+1","a""b"\r\n'));
  it('chooses age-aware bounded history like the database and labels cost estimates', () => {expect(selectResolution(30*86400)).toBe(3600);expect(selectResolution(1800,60*86400)).toBe(900);expect(selectResolution(3600)).toBe(10);expect(estimateUsage({routers:1,sampleInterval:10,uploadInterval:30,rawDays:3,rowBytes:600,viewers:1}).requestsPerDay).toBe(2880);});
});
