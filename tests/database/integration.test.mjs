import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
let db;
const owner='00000000-0000-4000-8000-000000000001';
const other='00000000-0000-4000-8000-000000000002';
const boot='10000000-0000-4000-8000-000000000001';
const token='a'.repeat(64);
let device;
const q=async(sql,params=[]) => (await db.query(sql,params)).rows;
const rpc=async(name,args) => name==='history' ? q(`select * from public.history(${args.map((_,i)=>'$'+(i+1)).join(',')})`,args) : (await q(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args))[0].result;
const batch=(seq, extras={})=>({schema_version:1,device_id:device,boot_id:boot,batch_id:crypto.randomUUID(),sent_at:null,clock_synced:false,samples:[{seq,uptime_s:seq*10,observed_at:null,cpu_pct:50,load1:null,mem_total_kb:100000,mem_available_kb:null,temp_c:null,rx_bytes_delta:null,tx_bytes_delta:null,elapsed_s:10,interfaces:[{name:'wan',role:'wan',rx_bytes:'100',tx_bytes:'200',rx_delta:100,tx_delta:200,elapsed_s:10,reset:false},{name:'usb0',role:'usbwan',rx_bytes:'30',tx_bytes:'40',rx_delta:30,tx_delta:40,elapsed_s:10,reset:false}]}],logs:[],...extras});
before(async()=>{
 db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth; create table auth.users(id uuid primary key);
 create schema storage;
 create table storage.buckets(id text primary key,name text,public bool,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,metadata jsonb);
 alter table storage.objects enable row level security;
 grant usage on schema storage to authenticated; grant select on storage.objects to authenticated;
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema auth to authenticated,service_role; grant execute on function auth.uid() to authenticated;
 insert into auth.users values ('${owner}'),('${other}');`);
 await db.exec(readFileSync(new URL('../../supabase/migrations/202611250001_core.sql',import.meta.url),'utf8'));
 await db.exec(readFileSync(new URL('../../supabase/migrations/202611250002_storage.sql',import.meta.url),'utf8'));
 await db.exec(readFileSync(new URL('../../supabase/migrations/202611250004_advisor_indexes.sql',import.meta.url),'utf8'));
 await db.exec(readFileSync(new URL('../../supabase/migrations/202611250005_archive_replacement.sql',import.meta.url),'utf8'));
 await db.exec(readFileSync(new URL('../../supabase/migrations/202611250006_diagnostic_receipts.sql',import.meta.url),'utf8'));
 await db.exec(readFileSync(new URL('../../supabase/migrations/202611250007_alert_continuity.sql',import.meta.url),'utf8'));
 await db.exec(readFileSync(new URL('../../supabase/migrations/202611250008_backend_review.sql',import.meta.url),'utf8'));
 await db.exec(`insert into public.enrollment_tokens(owner_id,token_hash,expires_at,name) values ('${owner}','${'e'.repeat(64)}',now()+interval '5 minutes','test');`);
 device=(await rpc('enroll_device',['e'.repeat(64),token,'test','fixture'])).device_id;
});
beforeEach(async()=>{await db.exec('reset role');await q('update private.device_credentials set window_start=now(),window_count=0')});
after(async()=>{await db?.close()});
test('archive replacement queues old objects without reverting the new pointer',async()=>{
 const d=(await q('insert into public.devices(owner_id,name) values($1,$2) returning id',[owner,'ARCHIVE TEST FIXTURE']))[0].id;
 const oldPath=d+'/'+crypto.randomUUID()+'.json.gz',newPath=d+'/'+crypto.randomUUID()+'.json.gz';
 const id=(await q('insert into public.diagnostics(device_id,boot_id,payload,object_path) values($1,$2,$3,$4) returning id',[d,boot,{},oldPath]))[0].id;
 await q('update public.diagnostics set object_path=$1 where id=$2',[newPath,id]);
 assert.equal((await q('select object_path from public.diagnostics where id=$1',[id]))[0].object_path,newPath);
 assert.equal((await q('select count(*)::int n from private.storage_deletions where object_path=$1',[oldPath]))[0].n,1);
 await q('delete from public.devices where id=$1',[d]);
 const tasks=await rpc('claim_storage_deletions',[10]);
 assert.equal(tasks.length,2);
 for(const task of tasks)await rpc('finish_storage_deletion',[task.id,true,null]);
});
test('enrollment is single use, auth is distinct, token rotates atomically',async()=>{
 await assert.rejects(rpc('enroll_device',['e'.repeat(64),'b'.repeat(64),'x',null]),/enrollment/i);
 await assert.rejects(rpc('device_config',['c'.repeat(64)]),/credential/i);
 assert.equal((await rpc('device_config',[token])).device_id,device);
 await assert.rejects(rpc('rotate_device_token',[device,other,'b'.repeat(64)]),/owned/i);
});
test('ingest dedupes, rejects changed replay, protects latest and preserves null rollups/uplink totals',async()=>{
 const b=batch(2);
 assert.equal((await rpc('ingest_batch',[token,b])).accepted,true);
 assert.equal((await rpc('ingest_batch',[token,b])).duplicate,true);
 await assert.rejects(rpc('ingest_batch',[token,{...b,sent_at:new Date().toISOString()}]),/replay/i);
 await rpc('ingest_batch',[token,batch(1)]);
 const latest=(await q('select * from public.device_latest'))[0]; assert.equal(latest.seq,2);
 assert.equal((await q('select count(*)::int n from public.metric_samples'))[0].n,2);
 const roll=(await q('select sum(sample_count)::int sample_count,sum(cpu_sum)::float8 cpu_sum,sum(mem_available_sum) mem_available_sum,sum(mem_available_count)::int mem_available_count from public.metric_rollups where resolution_s=60'))[0];
 assert.equal(roll.sample_count,2); assert.equal(roll.cpu_sum,100); assert.equal(roll.mem_available_sum,null); assert.equal(roll.mem_available_count,0);
 const daily=await q('select role,sum(rx_bytes)::int bytes from public.bandwidth_daily group by role order by role');
 assert.deepEqual(daily,[{role:'usbwan',bytes:60},{role:'wan',bytes:200}]);
});
test('RLS isolates two owners and denies direct credential access and privileged RPCs',async()=>{
 await db.exec(`set role authenticated; set request.jwt.claim.sub='${other}';`);
 assert.equal((await q('select * from public.devices')).length,0);
 await assert.rejects(q('select * from private.device_credentials'),/permission denied/);
 await assert.rejects(rpc('device_config',[token]),/permission denied/);
 await assert.rejects(rpc('history',[device,new Date(Date.now()-60000),new Date()]),/owned/i);
 await db.exec(`set request.jwt.claim.sub='${owner}';`);
 assert.equal((await q('select * from public.devices')).length,1);
 assert.ok((await rpc('history',[device,new Date(Date.now()-60000),new Date(Date.now()+60000)])).length>0);
 await db.exec('reset role');
});
test('service operations and notification retry/claim work; maintenance keeps additive rollups',async()=>{
 await rpc('maintenance',[]);
 assert.equal((await q('select sum(sample_count)::int n from public.metric_rollups where resolution_s=60'))[0].n,2);
 const usage=await rpc('resource_usage',[]); assert.ok(usage.database_bytes>0);
 await db.exec(`update public.devices set last_seen_at=now()-interval '10 minutes' where id='${device}'`);
 await rpc('maintenance',[]);
 assert.equal((await q("select count(*)::int n from public.alerts where rule_key='offline' and resolved_at is null"))[0].n,1);
 const notifications=await rpc('claim_notification_attempts',[20]); assert.ok(notifications.length>=1);
 await rpc('finish_notification',[notifications[0].id,notifications[0].attempts,false,'fixture failure']);
 assert.equal((await q('select attempts from private.notification_queue where id=$1',[notifications[0].id]))[0].attempts,1);
});
test('thresholds sustain on sample time, reset between breaches, and recover with hysteresis',async()=>{
 const rule=(await q("insert into public.alert_rules(device_id,metric,operator,threshold,sustain_s,hysteresis,cooldown_s) values($1,'cpu_pct','gt',80,20,10,0) returning id",[device]))[0].id;
 const t=Date.now()-60000;
 const make=(seq,cpu,offset)=>({...batch(seq).samples[0],cpu_pct:cpu,observed_at:new Date(t+offset*1000).toISOString()});
 await rpc('ingest_batch',[token,batch(10,{clock_synced:true,samples:[make(10,90,0),make(11,90,10),make(12,50,20),make(13,90,30)]})]);
 assert.equal((await q('select count(*)::int n from public.alerts where rule_key=$1 and resolved_at is null',[rule]))[0].n,0);
 await rpc('ingest_batch',[token,batch(15,{clock_synced:true,samples:[make(14,90,40),make(15,90,50)]})]);
 assert.equal((await q('select count(*)::int n from public.alerts where rule_key=$1 and resolved_at is null',[rule]))[0].n,1);
 await rpc('ingest_batch',[token,batch(16,{clock_synced:true,samples:[make(16,75,55)]})]);
 assert.equal((await q('select count(*)::int n from public.alerts where rule_key=$1 and resolved_at is null',[rule]))[0].n,1);
 await rpc('ingest_batch',[token,batch(17,{clock_synced:true,samples:[make(17,70,60)]})]);
 assert.equal((await q('select count(*)::int n from public.alerts where rule_key=$1 and resolved_at is null',[rule]))[0].n,0);
});
test('storage deletion outbox survives device cascade and supports leased retry',async()=>{
 const path=device+'/'+crypto.randomUUID()+'.json.gz';
 const id=(await q('insert into public.diagnostics(device_id,boot_id,payload,object_path) values($1,$2,$3,$4) returning id',[device,boot,{},path]))[0].id;
 await q('delete from public.diagnostics where id=$1',[id]);
 await assert.rejects(rpc('enqueue_storage_deletion',['../../foreign.json.gz']),/invalid archive/);
 await rpc('enqueue_storage_deletion',[path]);
 const tasks=await rpc('claim_storage_deletions',[10]); assert.equal(tasks[0].object_path,path);assert.equal(tasks.length,1);
 assert.equal((await rpc('claim_storage_deletions',[10])).length,0);
 await rpc('finish_storage_deletion',[tasks[0].id,true,null]);
 assert.equal((await q('select * from private.storage_deletions')).length,0);
});
test('archive cleanup never leases a path still referenced by diagnostic metadata',async()=>{
 const path=device+'/'+crypto.randomUUID()+'.json.gz',queuedPath=device+'/'+crypto.randomUUID()+'.json.gz';
 const snapshot=(await q('insert into public.diagnostics(device_id,boot_id,payload,object_path) values($1,$2,$3,$4) returning id',[device,boot,{},path]))[0].id;
 await rpc('enqueue_storage_deletion',[path]);
 assert.equal((await q('select count(*)::int n from private.storage_deletions where object_path=$1',[path]))[0].n,0);
 // Simulate a queue item written by a previous Worker while the reference still exists.
 await q('insert into private.storage_deletions(object_path) values($1)',[path]);
 assert.deepEqual(await rpc('claim_storage_deletions',[10]),[]);
 await rpc('enqueue_storage_deletion',[queuedPath]);
 await assert.rejects(q('update public.diagnostics set object_path=$1 where id=$2',[queuedPath,snapshot]),/queued for deletion/);
 await q('delete from public.diagnostics where id=$1',[snapshot]);
 const tasks=await rpc('claim_storage_deletions',[10]);
 assert.deepEqual(tasks.map(x=>x.object_path).sort(),[path,queuedPath].sort());
 for(const task of tasks)await rpc('finish_storage_deletion',[task.id,true,null]);
});
test('an expired notification attempt cannot finish a newer claim',async()=>{
 await db.exec('update private.notification_queue set available_at=now()-interval \'1 second\',claimed_until=null,last_error=null where delivered_at is null');
 const [first]=await rpc('claim_notification_attempts',[1]);
 assert.ok(first);
 await q("update private.notification_queue set claimed_until=now()-interval '1 second' where id=$1",[first.id]);
 const [second]=await rpc('claim_notification_attempts',[1]);
 assert.equal(second.id,first.id);
 assert.equal(second.attempts,first.attempts+1);
 await rpc('finish_notification',[first.id,first.attempts,false,'stale failure']);
 const [current]=await q('select claimed_until,last_error,delivered_at from private.notification_queue where id=$1',[second.id]);
 assert.ok(current.claimed_until);
 assert.equal(current.last_error,null);
 assert.equal(current.delivered_at,null);
 await rpc('finish_notification',[second.id,second.attempts,true,null]);
 assert.ok((await q('select delivered_at from private.notification_queue where id=$1',[second.id]))[0].delivered_at);
});
test('history uses minute rollups for incomplete raw buckets inside the configured retention',async()=>{
 const id=(await q("insert into public.devices(owner_id,name,config) values($1,$2,'{\"retention_raw_days\":7}') returning id",[owner,'RETAINED COVERAGE FIXTURE']))[0].id;
 const started=Math.floor((Date.now()-5*86400000)/60000)*60000;
 const time=(offset)=>new Date(started+offset*1000);
 try{
  for(const [seq,offset,cpu] of [[1,12,20],[2,22,50],[3,72,90]]){
   await q('insert into public.metric_samples(device_id,boot_id,seq,effective_at,uptime_s,cpu_pct) values($1,$2,$3,$4,$5,$6)',[id,boot,seq,time(offset),offset,cpu]);
   await q('select private.accumulate_sample(s) from public.metric_samples s where device_id=$1 and seq=$2',[id,seq]);
  }
  await db.exec(`set role authenticated; set request.jwt.claim.sub='${owner}'`);
  const raw=await rpc('history',[id,time(10),time(90)]);
  assert.deepEqual(raw.map(x=>Number(x.sample_count)),[1,1,1]);
  await db.exec('reset role');
  await q('delete from public.metric_samples where device_id=$1 and seq=1',[id]);
  await db.exec(`set role authenticated; set request.jwt.claim.sub='${owner}'`);
  const minute=await rpc('history',[id,time(10),time(90)]);
  assert.deepEqual(minute.map(x=>[Number(x.sample_count),x.cpu_pct]),[[2,35],[1,90]]);
  const laterRaw=await rpc('history',[id,time(60),time(90)]);
  assert.deepEqual(laterRaw.map(x=>new Date(x.bucket).valueOf()),[time(72).valueOf()]);
 }finally{await db.exec('reset role');await q('delete from public.devices where id=$1',[id]);}
});
test('history returns a minute bucket if complete raw data exceeds the response limit',async()=>{
 const id=(await q('insert into public.devices(owner_id,name) values($1,$2) returning id',[owner,'DENSE HISTORY FIXTURE']))[0].id;
 const minute=new Date(Math.floor((Date.now()-3600000)/60000)*60000);
 const end=new Date(minute.valueOf()+60000);
 try{
  await q(`insert into public.metric_samples(device_id,boot_id,seq,effective_at,uptime_s,cpu_pct)
   select $1,$2,i,$3::timestamptz+i*interval '1 millisecond',i,50 from generate_series(1,2161) i`,[id,boot,minute]);
  await q(`insert into public.metric_rollups(device_id,resolution_s,bucket,sample_count,cpu_sum,cpu_count,mem_available_count,temp_count)
   values($1,60,$2,2161,50*2161,2161,0,0)`,[id,minute]);
  await db.exec(`set role authenticated; set request.jwt.claim.sub='${owner}'`);
  const rows=await rpc('history',[id,minute,end]);
  assert.equal(rows.length,1);
  assert.equal(Number(rows[0].sample_count),2161);
 }finally{await db.exec('reset role');await q('delete from public.devices where id=$1',[id]);}
});
test('maintenance deletes expired raw rows but replay cannot re-add their rollups',async()=>{
 const total=(await q('select sum(sample_count)::int n from public.metric_rollups where resolution_s=60'))[0].n;
 await db.exec("update public.metric_samples set received_at=now()-interval '10 days'");
 await rpc('maintenance',[]);
 assert.equal((await q('select count(*)::int n from public.metric_samples'))[0].n,0);
 await rpc('ingest_batch',[token,batch(1)]);
 assert.equal((await q('select count(*)::int n from public.metric_samples'))[0].n,0);
 assert.equal((await q('select sum(sample_count)::int n from public.metric_rollups where resolution_s=60'))[0].n,total);
});
test('private Storage policy isolates owners and reports real object metadata bytes',async()=>{
 assert.equal((await q("select public from storage.buckets where id='router-diagnostics'"))[0].public,false);
 await q("insert into storage.objects(bucket_id,name,metadata) values('router-diagnostics',$1,'{\"size\":1234}')",[device+'/snapshot.json.gz']);
 assert.equal((await rpc('resource_usage',[])).archive_bytes,1234);
 await db.exec(`set role authenticated; set request.jwt.claim.sub='${other}'`);
 assert.equal((await q('select * from storage.objects')).length,0);
 await db.exec(`set request.jwt.claim.sub='${owner}'`);
 assert.equal((await q('select * from storage.objects')).length,1);
 await assert.rejects(q("insert into storage.objects(bucket_id,name) values('router-diagnostics','unauthorized')"),/permission denied/);
 await db.exec('reset role');
});
test('rollups use per-gauge counts and fall back to retained history after raw expiry',async()=>{
 const b=batch(18); b.samples[0].cpu_pct=null; b.samples[0].mem_available_kb=0;
 await rpc('ingest_batch',[token,b]);
 const totals=(await q('select sum(cpu_count)::int cpu_n,sum(sample_count)::int n,sum(mem_available_sum)::int mem_sum,sum(mem_available_count)::int mem_n from public.metric_rollups where resolution_s=60'))[0];
 assert.equal(totals.n-totals.cpu_n,1); assert.equal(totals.mem_n,1); assert.equal(totals.mem_sum,0);
 await db.exec(`set role authenticated;set request.jwt.claim.sub='${owner}'`);
 const rows=await rpc('history',[device,new Date(Date.now()-31*86400000),new Date(Date.now()+86400000)]);
 assert.ok(rows.length>0); assert.equal(Number(rows[0].mem_available_kb),0);
 await db.exec('reset role');
});
test('known old boot cannot replace latest; distinct boot inventory and log events are retained',async()=>{
 const boot2=crypto.randomUUID();
 await rpc('ingest_batch',[token,batch(1,{boot_id:boot2,inventory:{firmware:'fixture-only'},logs:[{seq:1,uptime_s:10,observed_at:null,severity:2,service:'kernel',message:'Out of memory: fixture',count:3},{seq:2,uptime_s:10,observed_at:null,severity:3,service:'ath11k',message:'firmware crashed',count:1}]})]);
 await rpc('ingest_batch',[token,batch(30)]);
 assert.equal((await q('select boot_id from public.device_latest'))[0].boot_id,boot2);
 assert.equal((await q('select count(*)::int n from public.boot_sessions where device_id=$1',[device]))[0].n,2);
 assert.equal((await q("select count(*)::int n from public.alerts where rule_key like 'oom:%' or rule_key like 'ath11k:%'"))[0].n,2);
 assert.equal((await q('select count from public.system_logs where seq=1 and boot_id=$1',[boot2]))[0].count,3);
});
test('advanced sparse thresholds and two explicit failed probes alert without treating missing capabilities as failure',async()=>{
 const current=(await q('select boot_id from public.device_latest'))[0].boot_id;
 const id=(await q("insert into public.alert_rules(device_id,metric,operator,threshold,sustain_s,hysteresis,cooldown_s) values($1,'conntrack_pct','gt',80,0,10,0) returning id",[device]))[0].id;
 for(const seq of [100,101]) {
  const b=batch(seq,{boot_id:current}); b.samples[0].detail={firewall:{conntrack_count:90,conntrack_max:100},connectivity:{ipv4:{available:true,reachable:false},dns:{available:true,reachable:false}}};
  await rpc('ingest_batch',[token,b]);
  if(seq===100) assert.equal((await q("select count(*)::int n from public.alerts where rule_key like 'reachability:%' and resolved_at is null"))[0].n,0);
 }
 assert.equal((await q('select count(*)::int n from public.alerts where rule_key=$1 and resolved_at is null',[id]))[0].n,1);
 assert.equal((await q("select count(*)::int n from public.alerts where rule_key like 'reachability:%' and resolved_at is null"))[0].n,2);
 const b=batch(102,{boot_id:current});b.samples[0].detail={firewall:{conntrack_count:60,conntrack_max:100},connectivity:{ipv4:{available:true,reachable:true},dns:{available:true,reachable:true}}};
 await rpc('ingest_batch',[token,b]);
 assert.equal((await q("select count(*)::int n from public.alerts where (rule_key like 'reachability:%' or rule_key=$1) and resolved_at is null",[id]))[0].n,0);
});
test('budget degrades low priority payloads before hard stop and reports dropped logs',async()=>{
 const baseline=(await q('select live_bytes from private.storage_budget'))[0].live_bytes;
 await db.exec('update private.storage_budget set live_bytes=335544321');
 const b=batch(31,{logs:[{seq:99,uptime_s:310,observed_at:null,severity:5,service:'fixture',message:'low priority',count:1}]}); b.samples[0].detail={large:'fixture'};
 assert.equal((await rpc('ingest_batch',[token,b])).storage_degraded,true);
 assert.equal((await q('select detail from public.metric_samples where boot_id=$1 and seq=31',[boot]))[0].detail,null);
 assert.equal((await q('select dropped_logs from public.devices where id=$1',[device]))[0].dropped_logs,1);
 await db.exec('update private.storage_budget set live_bytes=419430401');
 const count=(await q('select count(*)::int n from public.metric_samples'))[0].n;
 const rejected=await rpc('ingest_batch',[token,batch(32)]); assert.equal(rejected.accepted,false); assert.equal(rejected.reason,'storage_budget');
 assert.equal((await q('select count(*)::int n from public.metric_samples'))[0].n,count);
 await q('update private.storage_budget set live_bytes=$1',[baseline]);
});
test('catalog enforces RLS, explicit RPC grants, and fixed privileged search paths',async()=>{
 const exposed=await q("select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity"); assert.deepEqual(exposed,[]);
 const unsafe=await q("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private') and p.prosecdef and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute') or not exists(select 1 from unnest(p.proconfig) c where c like 'search_path=%'))"); assert.deepEqual(unsafe,[]);
 await db.exec('set role anon'); await assert.rejects(q('select * from public.devices'),/permission denied/);await db.exec('reset role');
});
test('diagnostic receipt distinguishes stored, budget-skipped, and historical unknown replay',async()=>{
 const plain=batch(699);const plainReceipt=await rpc('ingest_batch',[token,plain]);assert.equal(plainReceipt.diagnostics_accepted,false);assert.equal(plainReceipt.diagnostics_reason,'no_diagnostics');assert.equal(plainReceipt.diagnostics_request_id,null);
 const plainReplay=await rpc('ingest_batch',[token,plain]);assert.equal(plainReplay.duplicate,true);assert.equal(plainReplay.diagnostics_accepted,false);assert.equal(plainReplay.diagnostics_reason,'no_diagnostics');
 await q("update public.devices set config=config||'{\"diagnostics_enabled\":true}' where id=$1",[device]);
 const diagnostic=(n)=>batch(n,{diagnostics:{request_id:crypto.randomUUID(),kind:'memory',snapshot:{fixture:true}}});
 const good=diagnostic(700);
 let receipt=await rpc('ingest_batch',[token,good]);
 assert.equal(receipt.diagnostics_accepted,true);assert.equal(receipt.diagnostics_request_id,good.diagnostics.request_id);
 assert.equal((await q("select count(*)::int n from public.diagnostics where payload->>'request_id'=$1",[good.diagnostics.request_id]))[0].n,1);
 const budget=(await q('select live_bytes from private.storage_budget'))[0].live_bytes;
 await db.exec('update private.storage_budget set live_bytes=335544321');
 const skipped=diagnostic(701);receipt=await rpc('ingest_batch',[token,skipped]);
 assert.equal(receipt.accepted,true);assert.equal(receipt.diagnostics_accepted,false);assert.equal(receipt.diagnostics_reason,'storage_budget');assert.equal(receipt.diagnostics_request_id,skipped.diagnostics.request_id);
 assert.equal((await q("select count(*)::int n from public.diagnostics where payload->>'request_id'=$1",[skipped.diagnostics.request_id]))[0].n,0);
 const successfulReplay=await rpc('ingest_batch',[token,good]);assert.equal(successfulReplay.duplicate,true);assert.equal(successfulReplay.diagnostics_accepted,true);
 await q('update private.storage_budget set live_bytes=$1',[budget]);
 receipt=await rpc('ingest_batch',[token,skipped]);assert.equal(receipt.duplicate,true);assert.equal(receipt.diagnostics_accepted,false);assert.equal(receipt.diagnostics_reason,'storage_budget');assert.equal(receipt.diagnostics_request_id,skipped.diagnostics.request_id);
 const historical=diagnostic(702);
 await q('insert into private.ingest_batches(device_id,batch_id,payload_hash) values($1,$2,md5($3::jsonb::text))',[device,historical.batch_id,historical]);
 receipt=await rpc('ingest_batch',[token,historical]);assert.equal(receipt.duplicate,true);assert.equal(receipt.diagnostics_accepted,null);assert.equal(receipt.diagnostics_reason,'historical_unknown');
 await assert.rejects(rpc('ingest_batch',[token,{...skipped,diagnostics:{...skipped.diagnostics,request_id:crypto.randomUUID()}}]),/replay/);
 await q("update public.devices set config=config||'{\"diagnostics_enabled\":false}' where id=$1",[device]);
 const disabled=diagnostic(703);receipt=await rpc('ingest_batch',[token,disabled]);assert.equal(receipt.accepted,true);assert.equal(receipt.diagnostics_accepted,false);assert.equal(receipt.diagnostics_reason,'cloud_diagnostics_disabled');
 assert.equal((await q("select count(*)::int n from public.diagnostics where payload->>'request_id'=$1",[disabled.diagnostics.request_id]))[0].n,0);
 await q("update public.devices set config=config||'{\"diagnostics_enabled\":true}' where id=$1",[device]);
 receipt=await rpc('ingest_batch',[token,disabled]);assert.equal(receipt.duplicate,true);assert.equal(receipt.diagnostics_accepted,false);assert.equal(receipt.diagnostics_reason,'cloud_diagnostics_disabled');
 await q("update public.devices set config=config||'{\"diagnostics_enabled\":false}' where id=$1",[device]);
});
test('billing-cycle quota uses Internet uplink totals and resolves when quota is disabled',async()=>{
 await q("update public.devices set config=config||'{\"monthly_quota_gb\":0.000000001}' where id=$1",[device]);
 await rpc('maintenance',[]);
 assert.equal((await q("select count(*)::int n from public.alerts where rule_key='monthly_quota' and resolved_at is null"))[0].n,1);
 await q("update public.devices set config=config||'{\"monthly_quota_gb\":0}' where id=$1",[device]);
 await rpc('maintenance',[]);
 assert.equal((await q("select count(*)::int n from public.alerts where rule_key='monthly_quota' and resolved_at is null"))[0].n,0);
});
test('owner rule edits work through RLS and rule removal resolves its active alert',async()=>{
 await db.exec(`set role authenticated;set request.jwt.claim.sub='${other}'`);
 await assert.rejects(q("insert into public.alert_rules(device_id,metric,operator,threshold) values($1,'cpu_pct','gt',80)",[device]),/row-level security/);
 await db.exec(`set request.jwt.claim.sub='${owner}'`);
 const rule=(await q("insert into public.alert_rules(device_id,metric,operator,threshold) values($1,'cpu_pct','gt',80) returning id",[device]))[0].id;
 await q('update public.alert_rules set threshold=90 where id=$1',[rule]);
 await db.exec('reset role');
 await q("insert into public.alerts(device_id,rule_key,severity,message) values($1,$2,'warning','fixture')",[device,rule]);
 await db.exec(`set role authenticated;set request.jwt.claim.sub='${owner}'`);
 await q('delete from public.alert_rules where id=$1',[rule]);
 const alert=(await q('select resolved_at from public.alerts where rule_key=$1',[rule]))[0];assert.ok(alert.resolved_at);
 await db.exec('reset role');
});
test('atomic device rate limit rejects excess requests without partial rows',async()=>{
 let limited=false;
 for(let i=3;i<20;i++) { try { await rpc('ingest_batch',[token,batch(i)]); } catch(e) { assert.match(e.message,/rate limit/); limited=true; break; } }
 assert.equal(limited,true);
});
test('actual host-fixture agent sample ingests without converting unavailable gauges to zero',{skip:!process.env.NICX_AGENT_SAMPLE},async()=>{
 const sample=JSON.parse(readFileSync(process.env.NICX_AGENT_SAMPLE,'utf8')); sample.seq=500;
 const current=(await q('select boot_id from public.device_latest'))[0].boot_id;
 const b=batch(500,{boot_id:current,samples:[sample]});
 const result=await rpc('ingest_batch',[token,b]);assert.equal(result.accepted,true);
 const stored=(await q('select * from public.metric_samples where device_id=$1 and boot_id=$2 and seq=500',[device,current]))[0];
 assert.equal(stored.cpu_pct,sample.cpu_pct);assert.equal(stored.temp_c,sample.temp_c);assert.equal(stored.mem_available_kb,sample.mem_available_kb);
 assert.deepEqual(stored.detail.capabilities,sample.detail.capabilities);
});
// Isolated devices keep these cadence regressions independent of earlier fixtures.
async function cadenceFixture(run,{metric='cpu_pct',threshold=80,sustain=240,config={}}={}) {
 const id=crypto.randomUUID(),credential=crypto.randomUUID().replaceAll('-','').repeat(2),session=crypto.randomUUID();
 await q('insert into public.devices(id,owner_id,name) values($1,$2,$3)',[id,owner,'CADENCE TEST FIXTURE']);
 await q('insert into private.device_credentials(device_id,token_hash) values($1,$2)',[id,credential]);
 await q('update public.devices set config=config||$1::jsonb where id=$2',[config,id]);
 const rule=(await q("insert into public.alert_rules(device_id,metric,operator,threshold,sustain_s,hysteresis,cooldown_s) values($1,$2,'gt',$3,$4,0,0) returning id",[id,metric,threshold,sustain]))[0].id;
 const started=Date.now()-86400000;
 let seq=0;
 const observe=async(offset,{cadence={sample_s:120,connectivity_s:30,detail_s:300},detail={},elapsed=120,cpu=95}={})=>{
  const sample={...batch(++seq).samples[0],uptime_s:offset+10,observed_at:new Date(started+offset*1000).toISOString(),cpu_pct:cpu,elapsed_s:elapsed,detail:{...detail,...(cadence===null?{}:{cadence})}};
  return rpc('ingest_batch',[credential,batch(seq,{device_id:id,boot_id:session,clock_synced:true,samples:[sample]})]);
 };
 const active=async(key)=>Number((await q('select count(*)::int n from public.alerts where device_id=$1 and rule_key=$2 and resolved_at is null',[id,key]))[0].n);
 try {await run({id,rule,observe,active});} finally {await q('delete from public.devices where id=$1',[id]);}
}
const failedIpv4={connectivity:{ipv4:{available:true,reachable:false}}};
test('cadence: local 120-second observations sustain CPU and consecutive probe alerts',async()=>{
 await cadenceFixture(async({rule,observe,active})=>{
  await observe(0,{detail:failedIpv4});await observe(120,{detail:failedIpv4});
  assert.equal(await active(rule),0);assert.equal(await active('reachability:ipv4'),1);
  await observe(240);
  assert.equal(await active(rule),1);
 });
});
test('cadence: adaptive 60-second probes preserve latency sustain and failure streaks',async()=>{
 await cadenceFixture(async({rule,observe,active})=>{
  const options={cadence:{sample_s:30,connectivity_s:60,detail_s:600},elapsed:30,detail:{connectivity:{ipv4:{available:true,reachable:false,latency_ms:100}}}};
  await observe(0,options);await observe(60,options);
  assert.equal(await active(rule),1);assert.equal(await active('reachability:ipv4'),1);
 },{metric:'latency_ms',threshold:50,sustain:60,config:{wifi_interval:15}});
});
test('cadence: hourly detail sustains PSI and conntrack rules despite faster cloud requests',async()=>{
 for(const metric of ['memory_psi_full_avg10','conntrack_pct'])await cadenceFixture(async({rule,observe,active})=>{
  const options={cadence:{sample_s:10,connectivity_s:30,detail_s:3600},elapsed:10,detail:{memory:{psi:{memory:{full:{avg10:95}}}},firewall:{conntrack_count:95,conntrack_max:100}}};
  await observe(0,options);await observe(3600,options);
  assert.equal(await active(rule),1,metric+' must use observed detail cadence');
 },{metric,sustain:3600,config:{detail_interval:60}});
});
test('cadence: legacy observations fall back to bounded monotonic elapsed time',async()=>{
 await cadenceFixture(async({rule,observe,active})=>{
  for(const offset of [0,120,240])await observe(offset,{cadence:null,elapsed:120,detail:failedIpv4});
  assert.equal(await active(rule),1);assert.equal(await active('reachability:ipv4'),1);
 });
});
test('cadence: a real gap still resets threshold sustain and probe failure streaks',async()=>{
 await cadenceFixture(async({rule,observe,active})=>{
  await observe(0,{detail:failedIpv4});await observe(1200,{detail:failedIpv4});
  assert.equal(await active(rule),0);assert.equal(await active('reachability:ipv4'),0);
  await observe(1320,{detail:failedIpv4});
  assert.equal(await active(rule),0);assert.equal(await active('reachability:ipv4'),1);
  await observe(1440);assert.equal(await active(rule),1);
 });
});
test('cadence: invalid metadata cannot extend continuity across a real gap',async()=>{
 for(const cadence of [{sample_s:'300',connectivity_s:'120',detail_s:'3600'},{sample_s:1e200,connectivity_s:1e200,detail_s:1e200},{sample_s:0,connectivity_s:-1,detail_s:null}])await cadenceFixture(async({rule,observe,active})=>{
  await observe(0,{cadence,elapsed:10,detail:failedIpv4});await observe(120,{cadence,elapsed:10,detail:failedIpv4});
  assert.equal(await active(rule),0);assert.equal(await active('reachability:ipv4'),0);
 },{sustain:120});
});
test('deleting a device with an active rule alert cascades without a resolution notification',async()=>{
 await cadenceFixture(async({id,rule,observe,active})=>{
  await observe(0);assert.equal(await active(rule),1);
  await q('delete from public.devices where id=$1',[id]);
  for(const table of ['devices','alert_rules','alerts','metric_samples']) {
   const key=table==='devices'?'id':'device_id';
   assert.equal((await q(`select count(*)::int n from public.${table} where ${key}=$1`,[id]))[0].n,0,table);
  }
  assert.equal((await q('select count(*)::int n from private.notification_queue where device_id=$1',[id]))[0].n,0);
  assert.equal((await q('select count(*)::int n from public.devices where id=$1',[device]))[0].n,1,'another device remains intact');
 },{sustain:0});
});
test('credential rotation revokes previous token, deletion queues archive paths even through cascades',async()=>{
 await rpc('rotate_device_token',[device,owner,'f'.repeat(64)]);
 await assert.rejects(rpc('device_config',[token]),/credential/);
 assert.equal((await rpc('device_config',['f'.repeat(64)])).device_id,device);
 await q('update public.devices set revoked_at=now() where id=$1',[device]);
 await assert.rejects(rpc('ingest_batch',['f'.repeat(64),batch(200)]),/credential/);
 const path=device+'/'+crypto.randomUUID()+'.json.gz';
 await q('insert into public.diagnostics(device_id,boot_id,payload,object_path) values($1,$2,$3,$4)',[device,boot,{},path]);
 await q('delete from public.devices where id=$1',[device]);
 const tasks=await rpc('claim_storage_deletions',[10]); assert.ok(tasks.some(t=>t.object_path===path));
 assert.equal((await q('select * from public.metric_samples')).length,0);
});
