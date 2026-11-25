import { Database, type Env, type Fetcher } from './db';
import { redact } from '@nicx/shared';

interface Notification {id:string;device_id:string;owner_id:string;message:string;severity:string;event:string}
export async function runScheduled(env:Env,fetcher:Fetcher=fetch):Promise<void>{
  const db=new Database(env,fetcher);
  await db.rpc('maintenance');
  // Do not lease messages when no delivery destination is configured.
  if(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && env.TELEGRAM_OWNER_ID){
    const rows=await db.rpc<Notification[]>('claim_notifications',{p_limit:3});
    for(const row of rows){
      let ok=false,error='notification_destination_not_configured_for_owner';
      if(row.owner_id===env.TELEGRAM_OWNER_ID){
        try{
          const r=await fetcher('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text:redact(`Nicx Router Monitor · ${row.severity} · ${row.event}\n${row.device_id}\n${row.message}`).slice(0,3000),disable_web_page_preview:true}),signal:AbortSignal.timeout(8000),redirect:'manual'});
          const body=await r.json() as {ok?:boolean};ok=r.ok&&body.ok===true;error=ok?'':'provider_rejected';
        }catch{error='provider_unavailable';}
      }
      await db.rpc('finish_notification',{p_id:row.id,p_ok:ok,p_error:ok?null:error});
    }
  }
  const deletions=await db.rpc<{id:string;object_path:string}[]>('claim_storage_deletions',{p_limit:3});
  if(deletions.length){
    // Paths come from the diagnostic deletion trigger, still validate before Storage API.
    const safe=deletions.filter(x=>/^[a-f0-9-]{36}\/[a-f0-9-]{36}\.json\.gz$/i.test(x.object_path));
    let ok=false;
    if(safe.length){try{await db.call('/storage/v1/object/router-diagnostics',{method:'DELETE',body:JSON.stringify({prefixes:safe.map(x=>x.object_path)})});ok=true;}catch{}}
    for(const row of deletions)await db.rpc('finish_storage_deletion',{p_id:row.id,p_ok:ok&&safe.includes(row),p_error:ok?null:'storage_delete_failed'});
  }
}
