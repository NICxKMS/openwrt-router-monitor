import {createClient} from '@supabase/supabase-js';
import {boundedFetch,withTimeout} from './async';
const url=import.meta.env.VITE_SUPABASE_URL as string|undefined;
const key=import.meta.env.VITE_SUPABASE_ANON_KEY as string|undefined;
export const apiUrl=(import.meta.env.VITE_API_URL as string|undefined)?.replace(/\/$/,'')||'';
function validConfiguration(url:string|undefined,key:string|undefined){if(!url||!key||/YOUR_|CHANGE_ME|REPLACE_ME/i.test(url+' '+key))return false;try{return new URL(url).protocol==='https:';}catch{return false;}}
export const configured=validConfiguration(url,key);
export const db=configured?createClient(url!,key!,{auth:{flowType:'pkce',detectSessionInUrl:true,autoRefreshToken:true,persistSession:true},global:{fetch:boundedFetch}}):null;
export async function ownerApi(path:string,body?:unknown,method='POST',signal?:AbortSignal) {
 if(!db)throw new Error('Connect the dashboard to Supabase first.');
 const {data}=await withTimeout(db.auth.getSession());
 if(!data.session)throw new Error('Please sign in again.');
 signal?.throwIfAborted();
 let response:Response;
 try{response=await boundedFetch(apiUrl+path,{method,signal,headers:{Authorization:`Bearer ${data.session.access_token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});}
 catch(error){if(error instanceof Error&&/took too long/.test(error.message))throw error;throw new Error(method==='GET'?'Could not read the monitoring service. Check your connection and retry.':'Could not confirm completion. The connection was interrupted; refresh to check the result before trying again.');}
 const result=await response.json().catch(()=>null);
 if(response.ok&&(!result||typeof result!=='object'||Array.isArray(result))){
  throw new Error(method==='GET'?'The monitoring service returned an unreadable response. Try again.':'Could not confirm completion. Refresh to check the result before trying again.');
 }
 if(!response.ok){const code=result?.error?.message||result?.error;const messages:Record<string,string>={backend_unavailable:'The cloud service is temporarily unavailable. Refresh to check whether the action completed before retrying.',validation_failed:'Some values were not accepted. Check the displayed limits and try again.',internal_error:'The service could not confirm this action. Refresh to check the result before retrying.',forbidden:'This account does not have permission for that action.',rate_limited:'Too many requests were sent. Wait a minute, then refresh to check the result before retrying.',admin_required:'Project usage is available only to the configured project administrator.',archive_commit_unconfirmed:'Archive uploaded, but registration could not be confirmed. Refresh to check it before retrying.',archive_budget_exceeded:'The diagnostic archive storage budget has been reached.',storage_usage_unavailable:'Archive storage usage could not be checked. Try again later.',not_found:'This item is no longer available.',unauthorized:'Your session is no longer authorized. Please sign in again.'};throw new Error(typeof code==='string'?(messages[code]||code.replaceAll('_',' ')):`Request failed (${response.status})`);}
 return result;
}
