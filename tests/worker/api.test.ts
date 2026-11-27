import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../../apps/worker/src/app';
import { sha256 } from '../../apps/worker/src/security';
import {applySupabaseAuth} from '../../apps/worker/src/db';
import {Database} from '../../apps/worker/src/db';

const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'server-secret',APP_ORIGIN:'https://router.nicx.me'};
const batch={schema_version:1,device_id:'00000000-0000-4000-8000-000000000001',boot_id:'00000000-0000-4000-8000-000000000002',batch_id:'00000000-0000-4000-8000-000000000003',sent_at:null,clock_synced:false,samples:[],logs:[]};
const token='nxd_'+'a'.repeat(64);
const request=(path:string,body:unknown,auth=token,origin?:string)=>new Request('https://router.nicx.me'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+auth,...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});
describe('private API',()=>{
  it.each([true,false,null])('preserves explicit diagnostic receipt %s independently of accepted metrics',async(receipt)=>{
    const r=await createApp(async()=>Response.json({accepted:true,duplicate:true,config:{},diagnostics_accepted:receipt,diagnostics_request_id:batch.batch_id,diagnostics_reason:receipt===false?'storage_budget':undefined})).fetch(request('/api/v1/telemetry',batch),env);
    expect(r.status).toBe(200);const body=await r.json() as any;
    expect(body.diagnostics_accepted).toBe(receipt);
    expect(body.diagnostics_request_id).toBe(batch.batch_id);
    if(receipt===false)expect(body.diagnostics_reason).toBe('storage_budget');
  });
  it('does not invent a diagnostic receipt for older backend responses',async()=>{
    const r=await createApp(async()=>Response.json({accepted:true,config:{}})).fetch(request('/api/v1/telemetry',batch),env);
    expect((await r.json() as any).diagnostics_accepted).toBeNull();
  });
  it('does not bind the native fetch function to the Database instance',async()=>{
    const db=new Database(env,async function(this:unknown){expect(this).toBeUndefined();return Response.json({ok:true});});
    await expect(db.rpc('fixture')).resolves.toEqual({ok:true});
  });
  it('allows an explicitly enabled local database without permitting insecure hosted origins', async () => {
    const fetcher = vi.fn(async () => Response.json({ok: true}));
    const local = {...env, APP_ORIGIN: 'http://127.0.0.1:5174', SUPABASE_URL: 'http://127.0.0.1:54321'};
    await expect(new Database(local, fetcher).rpc('fixture')).rejects.toMatchObject({status: 503});
    await expect(new Database({...local, DEV_LOOPBACK_SUPABASE: '1'}, fetcher).rpc('fixture')).resolves.toEqual({ok: true});
    await expect(new Database({...local, DEV_LOOPBACK_SUPABASE: '1', SUPABASE_URL: 'http://example.test:54321'}, fetcher)
      .rpc('fixture')).rejects.toMatchObject({status: 503});
    await expect(new Database({...local, DEV_LOOPBACK_SUPABASE: '1', APP_ORIGIN: env.APP_ORIGIN}, fetcher)
      .rpc('fixture')).rejects.toMatchObject({status: 503});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('uses Worker-supported manual redirects and refuses to follow privileged requests',async()=>{
    let mode:RequestRedirect|undefined;
    const db=new Database(env,async(_input,options)=>{mode=options?.redirect;return new Response(null,{status:302,headers:{Location:'https://untrusted.example'}});});
    await expect(db.rpc('fixture')).rejects.toMatchObject({status:503});
    expect(mode).toBe('manual');
  });
  it('sends modern secret keys only as apikey and preserves user JWT authentication',()=>{
    const modern={...env,SUPABASE_SECRET_KEY:'sb_secret_fixture_backend_only'};
    const headers=new Headers();applySupabaseAuth(headers,modern);
    expect(headers.get('apikey')).toBe(modern.SUPABASE_SECRET_KEY);expect(headers.has('Authorization')).toBe(false);
    applySupabaseAuth(headers,modern,'user.jwt.signature');expect(headers.get('Authorization')).toBe('Bearer user.jwt.signature');
  });
  it('keeps public health minimal',async()=>{const fetcher=vi.fn();const r=await createApp(fetcher).fetch(new Request('https://router.nicx.me/api/v1/health'),env);expect(r.status).toBe(200);expect(await r.json()).toEqual({ok:true,schema_version:1});expect(fetcher).not.toHaveBeenCalled();});
  it('does not send secrets to invalid or foreign requests',async()=>{const fetcher=vi.fn();const app=createApp(fetcher);expect((await app.fetch(request('/api/v1/telemetry',batch,'bad'),env)).status).toBe(401);expect((await app.fetch(request('/api/v1/telemetry',batch,token,'https://evil.test'),env)).status).toBe(403);expect(fetcher).not.toHaveBeenCalled();});
  it('hashes credentials and uses one transactional ingestion call',async()=>{let sent:any;const fetcher=vi.fn(async (_url:any,options:any)=>{sent=JSON.parse(options.body);return Response.json({accepted:true,duplicate:false,config:{sample_interval:10}});});const r=await createApp(fetcher).fetch(request('/api/v1/telemetry',batch),env);expect(r.status).toBe(200);expect(sent.p_token_hash).toBe(await sha256(token));expect(JSON.stringify(sent)).not.toContain(token);expect(fetcher).toHaveBeenCalledTimes(1);expect(r.headers.get('Cache-Control')).toBe('no-store');});
  it('rejects oversized streaming bodies without trusting content length',async()=>{const r=await createApp(vi.fn()).fetch(request('/api/v1/telemetry',{...batch,extra:'x'.repeat(100000)}),env);expect(r.status).toBe(413);});
  it('sanitizes logs and rejects arbitrary remote commands',async()=>{let sent:any;const fetcher=vi.fn(async(_u:any,o:any)=>{sent=JSON.parse(o.body);return Response.json({accepted:true,duplicate:false,config:{}});});const log={seq:1,uptime_s:1,observed_at:null,severity:3,service:'test',message:'password=secret 192.168.1.1',count:1};expect((await createApp(fetcher).fetch(request('/api/v1/telemetry',{...batch,logs:[log]}),env)).status).toBe(200);expect(sent.p_batch.logs[0].message).not.toContain('secret');expect(sent.p_batch.logs[0].message).not.toContain('192.168');});
  it('retries a conflicting settings save while preserving the concurrent settings',async()=>{
    const owner='00000000-0000-4000-8000-000000000009';
    let stored={diagnostics_enabled:true,upload_interval:30,wifi_interval:1200};
    let writes=0;
    const app=createApp(async (input,options)=>{
      const url=new URL(String(input));
      if(url.pathname==='/auth/v1/user')return Response.json({id:owner});
      expect(url.pathname).toBe('/rest/v1/devices');
      expect(url.searchParams.get('owner_id')).toBe('eq.'+owner);
      expect(url.searchParams.get('id')).toBe('eq.'+batch.device_id);
      if(options?.method!=='PATCH')return Response.json([{id:batch.device_id,config:stored}]);
      writes++;
      if(writes===1)stored={...stored,diagnostics_enabled:false};
      const previous=JSON.parse(url.searchParams.get('config')!.slice(3));
      expect(new Headers(options.headers).get('Prefer')).toBe('return=representation');
      if(JSON.stringify(previous)!==JSON.stringify(stored))return Response.json([]);
      stored=JSON.parse(String(options.body)).config;
      return Response.json([{id:batch.device_id}]);
    });
    const response=await app.fetch(request('/api/v1/devices/'+batch.device_id+'/config',{upload_interval:60},'user.jwt.fixture-signature'),env);
    expect(response.status).toBe(200);
    expect(writes).toBe(2);
    expect(stored).toEqual({diagnostics_enabled:false,upload_interval:60,wifi_interval:900});
  });
  it('delivers legacy settings with supported interval bounds and preserves the other settings',async()=>{
    const app=createApp(async()=>Response.json({device_id:batch.device_id,config:{wifi_interval:1200,process_interval:2400,diagnostics_enabled:true}}));
    const response=await app.fetch(new Request('https://router.nicx.me/api/v1/device/config',{headers:{Authorization:'Bearer '+token}}),env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({device_id:batch.device_id,config:{wifi_interval:900,process_interval:1800,diagnostics_enabled:true}});
  });
  it('maps backend rate limits and fails closed on backend failures',async()=>{let app=createApp(async()=>Response.json({message:'rate_limited',code:'P0001'},{status:400}));expect((await app.fetch(request('/api/v1/telemetry',batch),env)).status).toBe(429);app=createApp(async()=>new Response('database secret',{status:503}));const r=await app.fetch(request('/api/v1/telemetry',batch),env);expect(r.status).toBe(503);expect(await r.text()).not.toContain('database secret');});
  it('never accepts device token as owner session',async()=>{const fetcher=vi.fn();expect((await createApp(fetcher).fetch(request('/api/v1/enrollment',{name:'home'}),env)).status).toBe(401);expect(fetcher).not.toHaveBeenCalled();});
  it('rejects unsupported schema without database calls',async()=>{const fetcher=vi.fn();expect((await createApp(fetcher).fetch(request('/api/v1/telemetry',{...batch,schema_version:2}),env)).status).toBe(400);expect(fetcher).not.toHaveBeenCalled();});
  it('never leaks token from upstream exceptions',async()=>{const r=await createApp(async()=>{throw new Error(token);}).fetch(request('/api/v1/telemetry',batch),env);expect(r.status).toBe(503);expect(await r.text()).not.toContain(token);});
});
