import {createContext,useCallback,useContext,useId,useRef,useState,type ButtonHTMLAttributes,type FormEvent,type ReactNode} from 'react';
import {CheckCircle2,Loader2,TriangleAlert,X} from 'lucide-react';
import {actionError,withTimeout} from '../lib/async';
import {Button} from './ui/primitives';
export interface ActionContext {signal:AbortSignal}
export interface ActionState {status:'pending'|'success'|'error';message:string;updatedAt:number;previousError?:string}
interface ActionLabels {pending:string;success:string|((value:unknown)=>string)}
type Outcome<T>={ok:true;value:T}|{ok:false};
interface ActionHub {states:Record<string,ActionState>;run:<T>(key:string,labels:ActionLabels,work:(context:ActionContext)=>PromiseLike<T>|T)=>Promise<Outcome<T>|null>;dismiss:(key:string)=>void}
const Context=createContext<ActionHub|null>(null);
export function ActionProvider({children}:{children:ReactNode}) {
  const [states,setStates]=useState<Record<string,ActionState>>({});
  const locked=useRef(new Set<string>());
  const run=useCallback(async<T,>(key:string,labels:ActionLabels,work:(context:ActionContext)=>PromiseLike<T>|T):Promise<Outcome<T>|null>=>{
    if(locked.current.has(key))return null;
    locked.current.add(key);const controller=new AbortController();
    setStates(old=>({...old,[key]:{status:'pending',message:labels.pending,updatedAt:Date.now(),previousError:old[key]?.status==='error'?old[key].message:old[key]?.previousError}}));
    try {
      const value=await withTimeout(Promise.resolve().then(()=>work({signal:controller.signal})));
      setStates(old=>({...old,[key]:{status:'success',message:typeof labels.success==='function'?labels.success(value):labels.success,updatedAt:Date.now()}}));
      return {ok:true,value};
    } catch(error) {
      controller.abort(error);
      setStates(old=>({...old,[key]:{status:'error',message:actionError(error),updatedAt:Date.now()}}));
      return {ok:false};
    } finally {locked.current.delete(key);}
  },[]);
  const dismiss=useCallback((key:string)=>setStates(old=>{if(old[key]?.status==='pending')return old;const next={...old};delete next[key];return next;}),[]);
  const active=Object.entries(states).sort((a,b)=>Number(b[1].status==='pending')-Number(a[1].status==='pending')||b[1].updatedAt-a[1].updatedAt).slice(0,3);
  return <Context.Provider value={{states,run,dismiss}}>{children}<aside className="action-activity" aria-label="Action activity" aria-live="polite" aria-relevant="additions text">{active.map(([key,state])=><div key={key} className={`action-toast ${state.status}`} data-action-state={state.status} role={state.status==='error'?'alert':'status'}><ActionIcon state={state}/><div><strong>{state.status==='pending'?'Working…':state.status==='error'?'Action needs attention':'Completed'}</strong><p>{state.message}{state.status==='pending'&&state.previousError&&<small>Previous attempt: {state.previousError}</small>}</p></div>{state.status!=='pending'&&<button aria-label="Dismiss action message" onClick={()=>dismiss(key)}><X size={15}/></button>}</div>)}</aside></Context.Provider>;
}
export function useAction(key?:string) {
  const id=useId();const hub=useContext(Context);const actionKey=key||id;
  const [local,setLocal]=useState<ActionState|null>(null);const locked=useRef(false);
  const run=async<T,>(labels:ActionLabels,work:(context:ActionContext)=>PromiseLike<T>|T):Promise<Outcome<T>|null>=>{
    if(hub)return hub.run(actionKey,labels,work);
    if(locked.current)return null;locked.current=true;const controller=new AbortController();
    setLocal({status:'pending',message:labels.pending,updatedAt:Date.now(),previousError:local?.status==='error'?local.message:local?.previousError});
    try {const value=await withTimeout(Promise.resolve().then(()=>work({signal:controller.signal})));setLocal({status:'success',message:typeof labels.success==='function'?labels.success(value):labels.success,updatedAt:Date.now()});return {ok:true,value};}
    catch(error){controller.abort(error);setLocal({status:'error',message:actionError(error),updatedAt:Date.now()});return {ok:false};}
    finally{locked.current=false;}
  };
  const state=hub?.states[actionKey]||local;
  return {run,state,pending:state?.status==='pending',global:!!hub};
}
export type ActionController=ReturnType<typeof useAction>;
function ActionIcon({state}:{state:ActionState}) {return state.status==='pending'?<Loader2 className="pending-spin" size={16}/>:state.status==='error'?<TriangleAlert size={16}/>:<CheckCircle2 size={16}/>;}
export function ActionStatus({action,compact=false}:{action:ActionController;compact?:boolean}) {
  return action.state?<div className={`action-status ${action.state.status} ${compact?'compact':''}`} role={action.global?undefined:action.state.status==='error'?'alert':'status'} aria-live={action.global?'off':'polite'} data-action-state={action.state.status}><ActionIcon state={action.state}/><span>{action.state.message}{action.state.status==='pending'&&action.state.previousError&&<small>Previous attempt: {action.state.previousError}</small>}</span></div>:null;
}
export function ActionButton({onAction,pendingLabel='Working…',successMessage,children,actionKey,variant,disabled,...props}:Omit<ButtonHTMLAttributes<HTMLButtonElement>,'onClick'>&{onAction:(context:ActionContext)=>PromiseLike<unknown>|unknown;pendingLabel?:string;successMessage:string;actionKey?:string;variant?:'default'|'outline'|'ghost'|'destructive'}) {
  const action=useAction(actionKey);
  return <span className="action-control"><Button {...props} variant={variant} disabled={disabled||action.pending} aria-busy={action.pending} onClick={()=>void action.run({pending:pendingLabel,success:successMessage},onAction)}>{action.pending?<><Loader2 size={14} className="pending-spin"/>{pendingLabel}</>:children}</Button><ActionStatus action={action} compact/></span>;
}
const FormContext=createContext<ActionController|null>(null);
export function ActionForm({children,onSubmit,pending,success,className,actionKey}:{children:ReactNode;onSubmit:(form:HTMLFormElement,context:ActionContext)=>PromiseLike<unknown>|unknown;pending:string;success:string;className?:string;actionKey?:string}) {
  const action=useAction(actionKey);
  const submit=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const form=event.currentTarget;void action.run({pending,success},context=>onSubmit(form,context));};
  return <FormContext.Provider value={action}><form className={className} onSubmit={submit} aria-busy={action.pending}><fieldset disabled={action.pending} className="action-fieldset">{children}</fieldset><ActionStatus action={action}/></form></FormContext.Provider>;
}
export function ActionSubmit({children,pendingLabel='Working…',...props}:ButtonHTMLAttributes<HTMLButtonElement>&{pendingLabel?:string}) {const action=useContext(FormContext);return <Button {...props} type="submit" disabled={props.disabled||action?.pending} aria-busy={action?.pending}>{action?.pending?<><Loader2 className="pending-spin" size={14}/>{pendingLabel}</>:children}</Button>;}
