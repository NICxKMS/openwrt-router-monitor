import {describe,it,expect} from 'vitest';
import {createApp} from '../../apps/worker/src/app';
const owner='00000000-0000-4000-8000-000000000001',device='10000000-0000-4000-8000-000000000001',snapshot='20000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_fixture_backend_only',APP_ORIGIN:'https://router.nicx.me'};
describe('diagnostic archive failure recovery',()=>{
 for(const confirmed of [true,false])it('does not delete a potentially committed archive after a lost registration response: '+confirmed,async()=>{
  let stored:string|null=null,queued=0,reads=0;
  const app=createApp(async(input,options)=>{
   const url=new URL(String(input));
   if(url.pathname==='/auth/v1/user')return Response.json({id:owner});
   if(url.pathname==='/rest/v1/devices')return Response.json([{id:device}]);
   if(url.pathname==='/rest/v1/diagnostics'){
    if(options?.method==='PATCH'){stored=JSON.parse(String(options.body)).object_path;throw new Error('Registration committed but response lost');}
    if(reads++ && !confirmed)throw new Error('Readback unavailable');
    return Response.json([{payload:{kind:'fixture'},object_path:stored}]);
   }
   if(url.pathname==='/rest/v1/rpc/resource_usage')return Response.json({archive_bytes:0});
   if(url.pathname==='/rest/v1/rpc/enqueue_storage_deletion'){queued++;return Response.json(null);}
   if(url.pathname.startsWith('/storage/v1/object/router-diagnostics/'))return Response.json({});
   throw new Error('Unexpected fixture request');
  });
  const response=await app.fetch(new Request(`https://router.nicx.me/api/v1/devices/${device}/diagnostics/${snapshot}/archive`,{method:'POST',headers:{Authorization:'Bearer user.jwt.fixture-signature'}}),env);
  expect(queued).toBe(0);expect(response.status).toBe(confirmed?200:503);
  expect(await response.json()).toEqual(confirmed?{object_path:stored}:{error:'archive_commit_unconfirmed'});
 });
 for(const failure of ['deleted','deleted-after-lost-response','ambiguous-upload'] as const)it('queues orphan cleanup after '+failure,async()=>{
  let queued='';
  let deleted=false;
  const app=createApp(async(input,options)=>{
   const url=new URL(String(input));
   if(url.pathname==='/auth/v1/user')return Response.json({id:owner});
   if(url.pathname==='/rest/v1/devices')return Response.json([{id:device}]);
   if(url.pathname==='/rest/v1/diagnostics'){
    if(options?.method==='PATCH'){
     deleted=true;
     if(failure==='deleted-after-lost-response')throw new Error('Registration response lost after snapshot deletion');
    }
    return Response.json(deleted?[]:[{payload:{kind:'fixture'},object_path:null}]);
   }
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
  expect(response.status).toBe(failure==='ambiguous-upload'?503:409);
  expect(queued).toMatch(new RegExp('^'+device+'/[a-f0-9-]{36}\\.json\\.gz$'));
 });
});
