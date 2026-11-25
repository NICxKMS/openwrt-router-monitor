import {describe,it,expect} from 'vitest';
import {createApp} from '../../apps/worker/src/app';
const owner='00000000-0000-4000-8000-000000000001',device='10000000-0000-4000-8000-000000000001',snapshot='20000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_fixture_backend_only',APP_ORIGIN:'https://router.nicx.me'};
describe('diagnostic archive failure recovery',()=>{
 for(const failure of ['deleted','ambiguous-upload'] as const)it('queues orphan cleanup after '+failure,async()=>{
  let queued='';
  const app=createApp(async(input,options)=>{
   const url=new URL(String(input));
   if(url.pathname==='/auth/v1/user')return Response.json({id:owner});
   if(url.pathname==='/rest/v1/devices')return Response.json([{id:device}]);
   if(url.pathname==='/rest/v1/diagnostics')return Response.json(options?.method==='PATCH'?[]:[{payload:{kind:'fixture'},object_path:null}]);
   if(url.pathname==='/rest/v1/rpc/resource_usage')return Response.json({archive_bytes:0});
   if(url.pathname==='/rest/v1/rpc/enqueue_storage_deletion'){queued=JSON.parse(String(options?.body)).p_object_path;return Response.json(null);}
   if(url.pathname.startsWith('/storage/v1/object/router-diagnostics/')){
    expect(new Headers(options?.headers).get('apikey')).toBe(env.SUPABASE_SECRET_KEY);
    expect(new Headers(options?.headers).has('Authorization')).toBe(false);
    if(failure==='ambiguous-upload')throw new Error('Response lost after provider accepted upload');
    return Response.json({});
   }
   throw new Error('Unexpected fixture request');
  });
  const response=await app.fetch(new Request(`https://router.nicx.me/api/v1/devices/${device}/diagnostics/${snapshot}/archive`,{method:'POST',headers:{Authorization:'Bearer user.jwt.fixture-signature'}}),env);
  expect(response.status).toBe(failure==='deleted'?409:503);
  expect(queued).toMatch(new RegExp('^'+device+'/[a-f0-9-]{36}\\.json\\.gz$'));
 });
});
