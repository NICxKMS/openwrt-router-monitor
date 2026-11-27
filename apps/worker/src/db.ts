import { ApiError } from './security';
export type Fetcher = (input:RequestInfo|URL,init?:RequestInit)=>Promise<Response>;
export interface Env {
  SUPABASE_URL:string;
  SUPABASE_SECRET_KEY?:string;
  SUPABASE_SERVICE_ROLE_KEY?:string;
  APP_ORIGIN:string;
  DEV_LOOPBACK_SUPABASE?:string;
  ADMIN_USER_ID?:string;
  TELEGRAM_BOT_TOKEN?:string;
  TELEGRAM_CHAT_ID?:string;
  TELEGRAM_OWNER_ID?:string;
  EMAIL_API_KEY?:string;
  EMAIL_FROM?:string;
  EMAIL_TO?:string;
  ASSETS?:{fetch(request:Request):Promise<Response>};
  API_RATE_LIMITER?:{limit(options:{key:string}):Promise<{success:boolean}>};
}
export class Database {
  constructor(public env:Env,private fetcher:Fetcher=fetch){}
  private url(path:string):string{
    let url:URL;try{url=new URL(this.env.SUPABASE_URL);}catch{throw new ApiError(503,'backend_not_configured');}
    const local=this.env.DEV_LOOPBACK_SUPABASE==='1' && url.protocol==='http:'
      && url.hostname==='127.0.0.1' && !!url.port && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(this.env.APP_ORIGIN);
    if((url.protocol!=='https:' && !local) || !backendKey(this.env))throw new ApiError(503,'backend_not_configured');
    return url.origin+path;
  }
  async call<T=unknown>(path:string,options:RequestInit={},authToken?:string):Promise<T>{
    try{
      const headers=new Headers(options.headers);applySupabaseAuth(headers,this.env,authToken);headers.set('Content-Type','application/json');
      const performFetch=this.fetcher;
      const response=await performFetch(this.url(path),{...options,headers,signal:AbortSignal.timeout(12000),redirect:'manual'});
      if(!response.ok){
        let message='',code='';try{const data=await response.json() as {message?:string;code?:string};message=data.message??'';code=data.code??'';}catch{}
        if(/unauthorized|invalid (?:device )?credential|invalid.token|revoked|expired.enrollment/i.test(message)||response.status===401)throw new ApiError(401,'unauthorized');
        if(/rate.limit|quota|too.many|storage.budget|storage.limit|device limit/i.test(message)||response.status===429)throw new ApiError(429,'rate_limited');
        if(['22023','23514','22P02','22007','22008'].includes(code))throw new ApiError(400,'validation_failed');
        if(response.status===404&&code==='PGRST202'&&path.startsWith('/rest/v1/rpc/'))throw new ApiError(503,'backend_rpc_unavailable');
        if(/not.found/i.test(message))throw new ApiError(404,'not_found');
        if(response.status===403)throw new ApiError(403,'forbidden');
        console.warn(JSON.stringify({event:'supabase_request_failed',status:response.status,code:/^[A-Z0-9_]{1,24}$/.test(code)?code:'unknown'}));
        throw new ApiError(503,'backend_unavailable');
      }
      if(response.status===204||response.headers.get('Content-Length')==='0')return undefined as T;
      const text=await response.text();return (text?JSON.parse(text):undefined) as T;
    }catch(error){if(error instanceof ApiError)throw error;const message=error instanceof Error?error.message:'';const reason=/redirect/i.test(message)?'redirect_mode':/Illegal invocation|receiver|incorrect.*this/i.test(message)?'fetch_receiver':/timeout|AbortSignal/i.test(message)?'timeout_signal':/header|ByteString|character/i.test(message)?'header_value':/URL/i.test(message)?'url_value':/JSON|json/i.test(message)?'json_response':/fetch|network|connection/i.test(message)?'network':'unknown';console.warn(JSON.stringify({event:'supabase_transport_failed',kind:error instanceof Error?error.name:'unknown',reason}));throw new ApiError(503,'backend_unavailable');}
  }
  rpc<T=unknown>(name:string,args:Record<string,unknown>={}):Promise<T>{return this.call('/rest/v1/rpc/'+name,{method:'POST',body:JSON.stringify(args)});}
  async user(token:string):Promise<{id:string}>{
    if(token.startsWith('nxd_')||token.startsWith('nxe_'))throw new ApiError(401,'unauthorized');
    const user=await this.call<{id?:string}>('/auth/v1/user',{method:'GET'},token);
    if(!user?.id || !/^[a-f0-9-]{36}$/i.test(user.id))throw new ApiError(401,'unauthorized');
    return {id:user.id};
  }
  async ownedDevice(id:string,owner:string):Promise<Record<string,unknown>>{
    const rows=await this.call<Record<string,unknown>[]>('/rest/v1/devices?id=eq.'+id+'&owner_id=eq.'+owner+'&select=id,name,config');
    if(!rows?.[0])throw new ApiError(404,'not_found');return rows[0];
  }
  async patch(table:string,query:string,values:Record<string,unknown>):Promise<void>{await this.call('/rest/v1/'+table+'?'+query,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify(values)});}
}

export function backendKey(env:Env):string{return env.SUPABASE_SECRET_KEY??env.SUPABASE_SERVICE_ROLE_KEY??'';}
export function applySupabaseAuth(headers:Headers,env:Env,userToken?:string):void{
  const key=backendKey(env);if(!key)throw new ApiError(503,'backend_not_configured');
  headers.set('apikey',key);
  // Opaque modern keys belong only in apikey. Authorization carries actual JWTs.
  if(userToken)headers.set('Authorization','Bearer '+userToken);
  else if(!key.startsWith('sb_secret_'))headers.set('Authorization','Bearer '+key);
  else headers.delete('Authorization');
}
