import {describe,it,expect} from 'vitest';
import {runScheduled} from '../../apps/worker/src/scheduled';
const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'private',APP_ORIGIN:'https://router.nicx.me'};
describe('cloud notification delivery',()=>{
 it('runs maintenance and storage cleanup without leasing undeliverable notifications',async()=>{
  const calls:string[]=[];
  await runScheduled(env,async(input)=>{const u=String(input);calls.push(u);return Response.json(u.endsWith('claim_storage_deletions')?[]:{});});
  expect(calls.some(x=>x.endsWith('maintenance'))).toBe(true);expect(calls.some(x=>x.endsWith('claim_notification_attempts'))).toBe(false);
 });
 it('keeps storage cleanup active against a database without scoped notification leases',async()=>{
  const calls:string[]=[];
  await runScheduled({...env,TELEGRAM_BOT_TOKEN:'bot-secret',TELEGRAM_CHAT_ID:'123',TELEGRAM_OWNER_ID:'owner-a'},async input=>{
   const url=new URL(String(input));
   calls.push(url.pathname);
   if(url.pathname.endsWith('claim_notification_attempts'))return Response.json({code:'PGRST202'},{status:404});
   return Response.json(url.pathname.endsWith('claim_storage_deletions')?[]:{});
  });
  expect(calls).toEqual(['/rest/v1/rpc/maintenance','/rest/v1/rpc/claim_notification_attempts','/rest/v1/rpc/claim_storage_deletions']);
 });
 it('never sends another owners private alert to the configured recipient',async()=>{
  const calls:string[]=[];let finish:any;
  await runScheduled({...env,TELEGRAM_BOT_TOKEN:'bot-secret',TELEGRAM_CHAT_ID:'123',TELEGRAM_OWNER_ID:'owner-a'},async(input,options)=>{
   const u=String(input);calls.push(u);
   if(u.endsWith('claim_notification_attempts'))return Response.json([{id:'n1',attempts:2,owner_id:'owner-b',message:'private other-router info'}]);
   if(u.endsWith('finish_notification'))finish=JSON.parse(String(options?.body));
   return Response.json(u.endsWith('claim_storage_deletions')?[]:{});
  });
  expect(calls.some(x=>x.startsWith('https://api.telegram.org'))).toBe(false);
  expect(finish).toMatchObject({p_id:'n1',p_attempt:2,p_ok:false});
 });
 it('marks delivery only after a provider success response',async()=>{
  let finish:any;
  await runScheduled({...env,TELEGRAM_BOT_TOKEN:'bot-secret',TELEGRAM_CHAT_ID:'123',TELEGRAM_OWNER_ID:'owner-a'},async(input,options)=>{
   const u=String(input);
   if(u.endsWith('claim_notification_attempts'))return Response.json([{id:'n1',attempts:1,device_id:'d1',owner_id:'owner-a',message:'High CPU',severity:'warning',event:'opened'}]);
   if(u.startsWith('https://api.telegram.org'))return Response.json({ok:false},{status:429});
   if(u.endsWith('finish_notification'))finish=JSON.parse(String(options?.body));
   return Response.json(u.endsWith('claim_storage_deletions')?[]:{});
  });expect(finish.p_ok).toBe(false);
 });
});
