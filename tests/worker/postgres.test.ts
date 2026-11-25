import {afterAll,beforeAll,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {createApp} from '../../apps/worker/src/app';
import {sha256} from '../../apps/worker/src/security';
const owner='00000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'fixture-server-only',APP_ORIGIN:'https://router.nicx.me'};
let db:PGlite;
const sql=async(query:string,values:unknown[]=[]) => (await db.query<Record<string,unknown>>(query,values)).rows;
// Local transport adapter exercises the actual Worker + actual PostgreSQL functions.
// It replaces the Supabase HTTP transport, not the ingestion implementation.
const app=createApp(async(input,options)=>{
  const path=new URL(String(input)).pathname;
  const args=JSON.parse(String(options?.body??'{}'));
  const funcs:Record<string,string[]>={enroll_device:['p_enrollment_hash','p_token_hash','p_name','p_model'],ingest_batch:['p_token_hash','p_batch'],device_config:['p_token_hash']};
  const name=path.split('/').pop()!;
  if(!funcs[name])return Response.json({message:'not found'},{status:404});
  try{
    const fields=funcs[name];
    const result=await sql(`select public.${name}(${fields.map((_,i)=>'$'+(i+1)).join(',')}) as result`,fields.map(k=>args[k]));
    return Response.json(result[0].result);
  }catch(error){return Response.json({message:(error as Error).message},{status:400});}
});
const post=(path:string,body:unknown,token?:string)=>app.fetch(new Request('https://router.nicx.me'+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)}),env);
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;insert into auth.users values('${owner}');`);
  await db.exec(readFileSync('supabase/migrations/202611250001_core.sql','utf8'));
},30000);
afterAll(async()=>{await db?.close();});
describe('real Worker/PostgreSQL ingestion path',()=>{
 it('enrolls, ingests, deduplicates, isolates credentials and rejects revoked devices',async()=>{
  const enrollment='nxe_'+'b'.repeat(64);
  await sql('insert into public.enrollment_tokens(owner_id,token_hash,expires_at,name) values($1,$2,now()+interval \'5 minutes\',$3)',[owner,await sha256(enrollment),'SIMULATED INTEGRATION FIXTURE']);
  const enroll=await post('/api/v1/devices/enroll',{enrollment_token:enrollment,name:'SIMULATED INTEGRATION FIXTURE',model:'Fixture router'});
  expect(enroll.status).toBe(201);const identity=await enroll.json() as {device_id:string;token:string};
  expect((await post('/api/v1/devices/enroll',{enrollment_token:enrollment,name:'replay'})).status).toBe(401);
  const batch={schema_version:1,device_id:identity.device_id,boot_id:crypto.randomUUID(),batch_id:crypto.randomUUID(),sent_at:null,clock_synced:false,samples:[{seq:1,uptime_s:10,observed_at:null,cpu_pct:25,load1:0.5,mem_total_kb:400000,mem_available_kb:250000,temp_c:null,rx_bytes_delta:null,tx_bytes_delta:null,elapsed_s:null}],logs:[{seq:2,uptime_s:10,observed_at:null,severity:4,service:'fixture',message:'password=secret address 192.168.1.1',count:1}]};
  const first=await post('/api/v1/telemetry',batch,identity.token);expect(first.status).toBe(200);expect((await first.json() as any).duplicate).toBe(false);
  const second=await post('/api/v1/telemetry',batch,identity.token);expect(second.status).toBe(200);expect((await second.json() as any).duplicate).toBe(true);
  expect((await sql('select count(*)::int as n from public.metric_samples'))[0].n).toBe(1);
  expect((await sql('select message from public.system_logs'))[0].message).toBe('password=[redacted] address [ip]');
  expect((await sql('select token_hash from private.device_credentials'))[0].token_hash).toBe(await sha256(identity.token));
  await sql('update public.devices set revoked_at=now() where id=$1',[identity.device_id]);
  expect((await post('/api/v1/telemetry',{...batch,batch_id:crypto.randomUUID()},identity.token)).status).toBe(401);
 });
});
