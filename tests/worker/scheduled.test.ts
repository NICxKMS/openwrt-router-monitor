import {describe,it,expect} from 'vitest';
import {runScheduled} from '../../apps/worker/src/scheduled';
const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'private',APP_ORIGIN:'https://router.nicx.me'};
describe('cloud notification delivery',()=>{
 it('runs maintenance and storage cleanup without leasing undeliverable notifications',async()=>{
  const calls:string[]=[];
  await runScheduled(env,async(input)=>{const u=String(input);calls.push(u);return Response.json(u.endsWith('claim_storage_deletions')?[]:{});});
  expect(calls.some(x=>x.endsWith('maintenance'))).toBe(true);expect(calls.some(x=>x.endsWith('claim_notifications'))).toBe(false);
 });
 it('never sends another owners private alert to the configured recipient',async()=>{
  const calls:string[]=[];let finish:any;
  await runScheduled({...env,TELEGRAM_BOT_TOKEN:'bot-secret',TELEGRAM_CHAT_ID:'123',TELEGRAM_OWNER_ID:'owner-a'},async(input,options)=>{
   const u=String(input);calls.push(u);
   if(u.endsWith('claim_notifications'))return Response.json([{id:'n1',owner_id:'owner-b',message:'private other-router info'}]);
   if(u.endsWith('finish_notification'))finish=JSON.parse(String(options?.body));
   return Response.json(u.endsWith('claim_storage_deletions')?[]:{});
  });
  expect(calls.some(x=>x.startsWith('https://api.telegram.org'))).toBe(false);expect(finish.p_ok).toBe(false);
 });
 it('marks delivery only after a provider success response',async()=>{
  let finish:any;
  await runScheduled({...env,TELEGRAM_BOT_TOKEN:'bot-secret',TELEGRAM_CHAT_ID:'123',TELEGRAM_OWNER_ID:'owner-a'},async(input,options)=>{
   const u=String(input);
   if(u.endsWith('claim_notifications'))return Response.json([{id:'n1',device_id:'d1',owner_id:'owner-a',message:'High CPU',severity:'warning',event:'opened'}]);
   if(u.startsWith('https://api.telegram.org'))return Response.json({ok:false},{status:429});
   if(u.endsWith('finish_notification'))finish=JSON.parse(String(options?.body));
   return Response.json(u.endsWith('claim_storage_deletions')?[]:{});
  });expect(finish.p_ok).toBe(false);
 });
});
