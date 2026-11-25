import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { batchSchema, configSchema, defaultConfig, jsonStorageBytes, MAX_BODY_BYTES, redact, sanitizeJson, SCHEMA_VERSION, storedConfigSchema } from '@nicx/shared';
import { applySupabaseAuth, Database, type Env, type Fetcher } from './db';
import { ApiError, bearer, deviceToken, issueToken, readJson, sha256 } from './security';

const nameSchema=z.string().trim().min(1).max(80);
const idSchema=z.uuid();
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);if(!result.success)throw new ApiError(400,'validation_failed');return result.data;}

export function createApp(fetcher:Fetcher=fetch){
  const app=new Hono<{Bindings:Env}>();
  app.use('/api/*',async(c,next)=>{
    const origin=c.req.header('Origin');
    c.header('Cache-Control','no-store');c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','no-referrer');c.header('X-Frame-Options','DENY');c.header('X-Request-ID',crypto.randomUUID());
    if(new URL(c.req.url).protocol!=='https:'&&!['localhost','127.0.0.1'].includes(new URL(c.req.url).hostname))throw new ApiError(400,'https_required');
    if(origin && origin!==c.env.APP_ORIGIN)throw new ApiError(403,'origin_not_allowed');
    if(origin){c.header('Access-Control-Allow-Origin',origin);c.header('Vary','Origin');}
    if(c.req.method==='OPTIONS'){c.header('Access-Control-Allow-Methods','GET,POST,PUT,PATCH,DELETE,OPTIONS');c.header('Access-Control-Allow-Headers','Authorization,Content-Type');return c.body(null,204);}
    if(c.env.API_RATE_LIMITER){
      // Edge limits reduce abuse; strict per-device limits are transactional in PostgreSQL.
      const ip=c.req.header('CF-Connecting-IP')??'local';
      const {success}=await c.env.API_RATE_LIMITER.limit({key:await sha256(ip)});if(!success)throw new ApiError(429,'rate_limited');
    }
    await next();
  });
  app.get('/api/v1/health',c=>c.json({ok:true,schema_version:SCHEMA_VERSION}));

  app.post('/api/v1/devices/enroll',async c=>{
    const body=parse(z.object({enrollment_token:z.string().regex(/^nxe_[a-f0-9]{64}$/),name:nameSchema,model:z.string().max(120).optional()}).strict(),await readJson(c.req.raw,4096));
    const token=issueToken('nxd_');
    const result=await new Database(c.env,fetcher).rpc<{device_id:string}>('enroll_device',{p_enrollment_hash:await sha256(body.enrollment_token),p_token_hash:await sha256(token),p_name:body.name,p_model:body.model??'OpenWrt'});
    if(!result?.device_id)throw new ApiError(503,'invalid_backend_response');
    return c.json({device_id:result.device_id,token,config:defaultConfig},201);
  });
  const ingest=async(c:Context<{Bindings:Env}>)=>{
    const token=deviceToken(c.req.header('Authorization'));
    const body=parse(batchSchema,await readJson(c.req.raw,MAX_BODY_BYTES));
    // Server defense in depth: agent already redacts; never persist credential-like fields.
    for(const log of body.logs){log.message=redact(log.message);log.service=redact(log.service);}
    for(const sample of body.samples){if(sample.detail)sample.detail=sanitizeJson(sample.detail) as Record<string,unknown>;}
    if(body.inventory)body.inventory=sanitizeJson(body.inventory) as Record<string,unknown>;
    if(body.diagnostics)body.diagnostics=sanitizeJson(body.diagnostics) as Record<string,unknown>;
    if(jsonStorageBytes(body)>MAX_BODY_BYTES)throw new ApiError(413,'body_too_large');
    const result=await new Database(c.env,fetcher).rpc<{accepted:boolean;duplicate:boolean;config:unknown;reason?:string;diagnostics_accepted?:boolean|null;diagnostics_reason?:string;diagnostics_request_id?:string|null}>('ingest_batch',{p_token_hash:await sha256(token),p_batch:body});
    if(typeof result?.accepted!=='boolean')throw new ApiError(503,'invalid_backend_response');
    if(!result.accepted)throw new ApiError(503,result.reason==='storage_budget'?'storage_budget_exceeded':'batch_not_accepted');
    const config=storedConfigSchema.safeParse(result.config);
    return c.json({accepted:result.accepted,duplicate:result.duplicate??false,diagnostics_accepted:typeof result.diagnostics_accepted==='boolean'?result.diagnostics_accepted:null,diagnostics_reason:['storage_budget','cloud_diagnostics_disabled','stored','no_diagnostics','historical_unknown'].includes(result.diagnostics_reason??'')?result.diagnostics_reason:undefined,diagnostics_request_id:typeof result.diagnostics_request_id==='string'&&idSchema.safeParse(result.diagnostics_request_id).success?result.diagnostics_request_id:null,config:config.success?config.data:{},server_time:new Date().toISOString()});
  };
  for(const path of ['/api/v1/telemetry','/api/v1/logs','/api/v1/diagnostics','/api/v1/heartbeat'])app.post(path,ingest);
  app.get('/api/v1/device/config',async c=>{
    const token=deviceToken(c.req.header('Authorization'));
    const result=await new Database(c.env,fetcher).rpc<{device_id:string;config:unknown}>('device_config',{p_token_hash:await sha256(token)});
    return c.json({device_id:result.device_id,config:parse(storedConfigSchema,result.config)});
  });

  app.post('/api/v1/enrollment',async c=>{
    const db=new Database(c.env,fetcher);const user=await db.user(bearer(c.req.header('Authorization')));
    const {name}=parse(z.object({name:nameSchema}).strict(),await readJson(c.req.raw,4096));
    const token=issueToken('nxe_'),expires_at=new Date(Date.now()+10*60000).toISOString();
    await db.call('/rest/v1/enrollment_tokens',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({owner_id:user.id,name,token_hash:await sha256(token),expires_at})});
    return c.json({token,expires_at},201);
  });
  app.patch('/api/v1/devices/:id',async c=>{
    const db=new Database(c.env,fetcher),user=await db.user(bearer(c.req.header('Authorization'))),id=parse(idSchema,c.req.param('id'));
    await db.ownedDevice(id,user.id);const values=parse(z.object({name:nameSchema}).strict(),await readJson(c.req.raw,4096));
    await db.patch('devices','id=eq.'+id+'&owner_id=eq.'+user.id,values);return c.json({ok:true});
  });
  app.post('/api/v1/devices/:id/config',async c=>{
    const db=new Database(c.env,fetcher),user=await db.user(bearer(c.req.header('Authorization'))),id=parse(idSchema,c.req.param('id'));
    const config=parse(configSchema,await readJson(c.req.raw,8192));
    for(let attempt=0;attempt<3;attempt++){
      const device=await db.ownedDevice(id,user.id);
      const previous=device.config??{};
      const updated=await db.call<{id:string}[]>(
        '/rest/v1/devices?id=eq.'+id+'&owner_id=eq.'+user.id+'&config=eq.'+encodeURIComponent(JSON.stringify(previous))+'&select=id',
        {method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({config:{...parse(storedConfigSchema,previous),...config}})},
      );
      if(!Array.isArray(updated))throw new ApiError(503,'invalid_backend_response');
      if(updated.length===1)return c.json({ok:true});
    }
    throw new ApiError(409,'config_changed_retry');
  });
  app.post('/api/v1/devices/:id/rotate',async c=>{
    const db=new Database(c.env,fetcher),user=await db.user(bearer(c.req.header('Authorization'))),id=parse(idSchema,c.req.param('id'));await db.ownedDevice(id,user.id);
    const token=issueToken('nxd_');await db.rpc('rotate_device_token',{p_device_id:id,p_owner_id:user.id,p_token_hash:await sha256(token)});return c.json({token});
  });
  app.post('/api/v1/devices/:id/revoke',async c=>{
    const db=new Database(c.env,fetcher),user=await db.user(bearer(c.req.header('Authorization'))),id=parse(idSchema,c.req.param('id'));await db.ownedDevice(id,user.id);
    await db.patch('devices','id=eq.'+id+'&owner_id=eq.'+user.id,{revoked_at:new Date().toISOString()});return c.json({ok:true});
  });
  app.delete('/api/v1/devices/:id',async c=>{
    const db=new Database(c.env,fetcher),user=await db.user(bearer(c.req.header('Authorization'))),id=parse(idSchema,c.req.param('id'));await db.ownedDevice(id,user.id);
    await db.call('/rest/v1/devices?id=eq.'+id+'&owner_id=eq.'+user.id,{method:'DELETE',headers:{Prefer:'return=minimal'}});return c.json({ok:true});
  });
  app.put('/api/v1/devices/:id/client-names/:client',async c=>{
    const db=new Database(c.env,fetcher),user=await db.user(bearer(c.req.header('Authorization'))),id=parse(idSchema,c.req.param('id'));await db.ownedDevice(id,user.id);
    const client=parse(z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),c.req.param('client'));const {name}=parse(z.object({name:nameSchema}).strict(),await readJson(c.req.raw,4096));
    await db.call('/rest/v1/client_names?on_conflict=device_id,client_id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({device_id:id,client_id:client,name})});return c.json({ok:true});
  });
  app.post('/api/v1/alerts/:id/ack',async c=>{
    const db=new Database(c.env,fetcher),user=await db.user(bearer(c.req.header('Authorization'))),id=parse(idSchema,c.req.param('id'));
    const rows=await db.call<{device_id:string}[]>('/rest/v1/alerts?id=eq.'+id+'&select=device_id');if(!rows?.[0])throw new ApiError(404,'not_found');await db.ownedDevice(rows[0].device_id,user.id);
    await db.patch('alerts','id=eq.'+id,{acknowledged_at:new Date().toISOString()});return c.json({ok:true});
  });
  app.get('/api/v1/usage',async c=>{
    const db=new Database(c.env,fetcher),user=await db.user(bearer(c.req.header('Authorization')));
    if(!c.env.ADMIN_USER_ID||user.id!==c.env.ADMIN_USER_ID)throw new ApiError(403,'admin_required');return c.json(await db.rpc('resource_usage'));
  });

  app.post('/api/v1/devices/:id/diagnostics/:snapshot/archive',async c=>{
    const db=new Database(c.env,fetcher),user=await db.user(bearer(c.req.header('Authorization'))),id=parse(idSchema,c.req.param('id')),snapshot=parse(idSchema,c.req.param('snapshot'));
    await db.ownedDevice(id,user.id);
    const rows=await db.call<{payload:unknown;object_path:string|null}[]>('/rest/v1/diagnostics?id=eq.'+snapshot+'&device_id=eq.'+id+'&select=payload,object_path');
    if(!rows?.[0])throw new ApiError(404,'not_found');
    if(rows[0].object_path)return c.json({object_path:rows[0].object_path});
    const usage=await db.rpc<{archive_bytes:number|null}>('resource_usage');
    if(usage.archive_bytes===null)throw new ApiError(503,'storage_usage_unavailable');
    if(usage.archive_bytes>750_000_000)throw new ApiError(429,'archive_budget_exceeded');
    const encoded=new TextEncoder().encode(JSON.stringify(rows[0].payload));
    const compressed=new Response(new Blob([encoded]).stream().pipeThrough(new CompressionStream('gzip')));
    const object_path=id+'/'+crypto.randomUUID()+'.json.gz';
    const endpoint=c.env.SUPABASE_URL.replace(/\/$/,'')+'/storage/v1/object/router-diagnostics/'+object_path;
    const headers=new Headers({'Content-Type':'application/gzip','x-upsert':'true'});applySupabaseAuth(headers,c.env);
    let response:Response;try{response=await fetcher(endpoint,{method:'POST',headers,body:await compressed.arrayBuffer(),signal:AbortSignal.timeout(12000),redirect:'manual'});}catch{
      await db.rpc('enqueue_storage_deletion',{p_object_path:object_path});throw new ApiError(503,'archive_upload_failed');
    }
    if(!response.ok){await db.rpc('enqueue_storage_deletion',{p_object_path:object_path});throw new ApiError(503,'archive_upload_failed');}
    let updated=false,definitivelyMissing=false;
    try{
      const rows=await db.call<unknown[]>('/rest/v1/diagnostics?id=eq.'+snapshot+'&device_id=eq.'+id,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({object_path})});
      updated=Array.isArray(rows)&&rows.length===1;
      definitivelyMissing=Array.isArray(rows)&&rows.length===0;
    }catch{}
    if(!updated&&!definitivelyMissing){
      // A lost response may follow a committed PATCH. Read back before attempting cleanup.
      try{
        const current=await db.call<{object_path:string|null}[]>('/rest/v1/diagnostics?id=eq.'+snapshot+'&device_id=eq.'+id+'&select=object_path');
        updated=Array.isArray(current)&&current.length===1&&current[0].object_path===object_path;
        definitivelyMissing=Array.isArray(current)&&current.length===0;
      }catch{}
    }
    if(definitivelyMissing){
      await db.rpc('enqueue_storage_deletion',{p_object_path:object_path});
      throw new ApiError(409,'snapshot_changed_retry');
    }
    if(!updated)throw new ApiError(503,'archive_commit_unconfirmed');
    return c.json({object_path});
  });

  app.all('/api/*',()=>{throw new ApiError(404,'not_found');});
  app.onError((error,c)=>{
    const known=error instanceof ApiError?error:new ApiError(500,'internal_error');
    if(known.status===429)c.header('Retry-After','60');
    if(known.status===503)c.header('Retry-After','30');
    return c.json({error:known.code},known.status);
  });
  return app;
}
