export class ApiError extends Error {
  constructor(public status:400|401|403|404|409|413|415|429|500|503,public code:string){super(code);}
}
export async function sha256(value:string):Promise<string>{
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
}
export function issueToken(prefix:'nxd_'|'nxe_'):string{
  return prefix+Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
}
export function bearer(header:string|undefined):string{
  const m=header?.match(/^Bearer ([A-Za-z0-9_.-]{16,2048})$/);
  if(!m) throw new ApiError(401,'unauthorized');
  return m[1];
}
export function deviceToken(header:string|undefined):string{
  const token=bearer(header);
  if(!/^nxd_[a-f0-9]{64}$/.test(token)) throw new ApiError(401,'unauthorized');
  return token;
}
export async function readJson(request:Request,maxBytes:number):Promise<unknown>{
  if(!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get('content-type')??'')) throw new ApiError(415,'json_required');
  if(request.headers.has('content-encoding') && request.headers.get('content-encoding')!=='identity') throw new ApiError(415,'compressed_requests_not_supported');
  const declared=Number(request.headers.get('content-length'));
  if(Number.isFinite(declared)&&declared>maxBytes) throw new ApiError(413,'body_too_large');
  if(!request.body) throw new ApiError(400,'empty_body');
  const reader=request.body.getReader();let total=0;const chunks:Uint8Array[]=[];
  try{
    while(true){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>maxBytes){await reader.cancel();throw new ApiError(413,'body_too_large');}chunks.push(value);}
  }finally{reader.releaseLock();}
  const joined=new Uint8Array(total);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.byteLength;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(joined));}catch{throw new ApiError(400,'invalid_json');}
}
