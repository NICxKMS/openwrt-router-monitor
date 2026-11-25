import type {ButtonHTMLAttributes,InputHTMLAttributes,ReactNode} from 'react';
import {cva} from 'class-variance-authority';
import {clsx,type ClassValue} from 'clsx';
import {twMerge} from 'tailwind-merge';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {X} from 'lucide-react';
export const cn=(...v:ClassValue[])=>twMerge(clsx(v));
const variants=cva('button',{variants:{variant:{default:'primary',outline:'outline',ghost:'ghost',destructive:'destructive'}},defaultVariants:{variant:'outline'}});
export function Button({variant='outline',className,...props}:ButtonHTMLAttributes<HTMLButtonElement>&{variant?:'default'|'outline'|'ghost'|'destructive'}){return <button className={cn(variants({variant}),className)} {...props}/>;}
export function Input(props:InputHTMLAttributes<HTMLInputElement>){return <input {...props} className={cn('input',props.className)}/>;}
export function Card({title,description,children,action,className}:{title?:string;description?:string;children:ReactNode;action?:ReactNode;className?:string}){return <section className={cn('card',className)}>{title&&<div className="card-heading"><div><h2>{title}</h2>{description&&<p className="muted small">{description}</p>}</div>{action}</div>}{children}</section>;}
export function Empty({title='No observations yet',children}:{title?:string;children?:ReactNode}){return <div className="empty"><span className="empty-mark">⌁</span><h3>{title}</h3><p>{children||'Data will appear after this router sends its first observation.'}</p></div>;}
export function QueryState({loading,error,empty,children}:{loading:boolean;error?:string;empty?:boolean;children:ReactNode}){return loading?<div className="loading" role="status">Loading observations…</div>:error?<div className="notice danger" role="alert">{error}</div>:empty?<Empty/>:<>{children}</>;}
export function Dialog({title,description,trigger,children,onOpenChange}:{title:string;description:string;trigger:ReactNode;children:ReactNode;onOpenChange?:(open:boolean)=>void}){return <DialogPrimitive.Root onOpenChange={onOpenChange}><DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger><DialogPrimitive.Portal><DialogPrimitive.Overlay className="dialog-overlay"/><DialogPrimitive.Content className="dialog-content"><DialogPrimitive.Title>{title}</DialogPrimitive.Title><DialogPrimitive.Description className="muted">{description}</DialogPrimitive.Description><DialogPrimitive.Close className="dialog-close" aria-label="Close"><X size={18}/></DialogPrimitive.Close>{children}</DialogPrimitive.Content></DialogPrimitive.Portal></DialogPrimitive.Root>;}
export function Notice({children}:{children:ReactNode}){return <p className="notice">{children}</p>;}
