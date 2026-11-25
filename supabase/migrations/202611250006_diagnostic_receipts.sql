-- No Supabase CLI is installed in this checkout; follows existing sequential migration
-- naming under the parent-authorized fallback. Does not modify applied migrations.
-- NULL deliberately preserves unknown historical dispositions; never infer stored
-- diagnostics from generic batch acceptance or current retention state.
alter table private.ingest_batches
 add column diagnostics_accepted boolean,
 add column diagnostics_request_id text,
 add column diagnostics_reason text;

create or replace function public.ingest_batch(p_token_hash text,p_batch jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare d public.devices; c private.device_credentials; h text; b uuid; bid uuid; j jsonb; s public.metric_samples; max_u float8; effective timestamptz; first_boot bool; changed int;low_storage bool;inserted_log uuid;diag_accepted bool:=false;diag_request_id text;diag_reason text:='no_diagnostics';
begin
 -- Lock credential then device everywhere ingest/rotation overlaps: device lock first prevents lock inversion.
 select x.* into d from public.devices x join private.device_credentials y on x.id=y.device_id where y.token_hash=p_token_hash and x.revoked_at is null for update of x;
 if not found then raise exception 'invalid device credential' using errcode='28000'; end if;
 select * into c from private.device_credentials where device_id=d.id and token_hash=p_token_hash for update;
 if not found then raise exception 'invalid device credential' using errcode='28000'; end if;
 if p_batch->>'schema_version' is distinct from '1' or (p_batch->>'device_id')::uuid is distinct from d.id or octet_length(p_batch::text)>98304
 or jsonb_typeof(p_batch->'samples') is distinct from 'array' or jsonb_array_length(p_batch->'samples')>12
 or jsonb_typeof(p_batch->'logs') is distinct from 'array' or jsonb_array_length(p_batch->'logs')>100 then raise exception 'invalid batch' using errcode='22023'; end if;
 b:=(p_batch->>'boot_id')::uuid; bid:=(p_batch->>'batch_id')::uuid;
 if b is null or bid is null then raise exception 'missing batch identity' using errcode='22023'; end if;
 select payload_hash,diagnostics_accepted,diagnostics_request_id,diagnostics_reason into h,diag_accepted,diag_request_id,diag_reason from private.ingest_batches where device_id=d.id and batch_id=bid;
 if found then
  if h<>md5(p_batch::text) then raise exception 'batch replay payload mismatch' using errcode='22023'; end if;
  update public.devices set last_seen_at=now() where id=d.id;
  return jsonb_build_object('accepted',true,'duplicate',true,'config',d.config,'diagnostics_accepted',diag_accepted,'diagnostics_request_id',coalesce(diag_request_id,p_batch#>>'{diagnostics,request_id}'),'diagnostics_reason',coalesce(diag_reason,'historical_unknown'));
 end if;
 -- SELECT INTO clears targets on NOT FOUND, so reinitialize the new receipt.
 diag_accepted:=false;diag_request_id:=null;diag_reason:='no_diagnostics';
 if c.window_start<=now()-interval '1 minute' then c.window_start:=now();c.window_count:=0;end if;
 if c.window_count>=10 then raise exception 'device rate limit exceeded' using errcode='P0001';end if;
 update private.device_credentials set window_start=c.window_start,window_count=c.window_count+1 where device_id=d.id;
 low_storage:=(select live_bytes>=335544320 from private.storage_budget where singleton);
 if (select live_bytes>=419430400 from private.storage_budget where singleton) then
  update public.devices set last_seen_at=now() where id=d.id;
  return jsonb_build_object('accepted',false,'duplicate',false,'reason','storage_budget','config',d.config,'diagnostics_accepted',false,'diagnostics_request_id',p_batch#>>'{diagnostics,request_id}','diagnostics_reason','storage_budget');
 end if;
 insert into private.ingest_batches(device_id,batch_id,payload_hash) values(d.id,bid,md5(p_batch::text));
 first_boot:=not exists(select 1 from public.boot_sessions where device_id=d.id and boot_id=b);
 if p_batch ? 'inventory' and octet_length((p_batch->'inventory')::text)>16384 then raise exception 'inventory too large';end if;
 select max((value->>'uptime_s')::float8) into max_u from jsonb_array_elements(p_batch->'samples');
 insert into public.boot_sessions(device_id,boot_id,inventory,uptime_origin_at) values(d.id,b,p_batch->'inventory',now()-make_interval(secs=>max_u)) on conflict(device_id,boot_id) do update set last_seen_at=now(),inventory=coalesce(excluded.inventory,boot_sessions.inventory),uptime_origin_at=coalesce(boot_sessions.uptime_origin_at,excluded.uptime_origin_at);
 -- Known previous sessions cannot supersede the current boot when delivered late.
 if first_boot and d.last_boot_id is not null then
  perform private.set_alert(d.id,'reboot:'||b::text,true,'New boot session observed; reboot timing is inferred from receipt','info');
  update private.alert_state set breached_since=null,last_sample_at=null where rule_id in(select id from public.alert_rules where device_id=d.id);
  delete from private.connectivity_state where device_id=d.id;
 end if;
 if d.last_boot_id is null or first_boot then d.last_boot_id:=b;end if;
 select max((value->>'uptime_s')::float8) into max_u from jsonb_array_elements(p_batch->'samples');
 for j in select value from jsonb_array_elements(p_batch->'samples') order by (value->>'uptime_s')::float8,(value->>'seq')::bigint loop
  if low_storage then j:=j-'detail';end if;
  if (j->>'seq') is null or (j->>'uptime_s') is null then raise exception 'missing sample identity';end if;
  if (j->>'seq')::bigint <= (select discarded_through_seq from public.boot_sessions where device_id=d.id and boot_id=b) then continue;end if;
  effective:=case when (p_batch->>'clock_synced')::bool and (j->>'observed_at')::timestamptz between now()-interval '3 days' and now()+interval '5 minutes' then (j->>'observed_at')::timestamptz else least(now(),(select uptime_origin_at from public.boot_sessions where device_id=d.id and boot_id=b)+make_interval(secs=>(j->>'uptime_s')::float8)) end;
  insert into public.metric_samples(device_id,boot_id,seq,observed_at,received_at,effective_at,uptime_s,cpu_pct,load1,mem_total_kb,mem_available_kb,mem_free_kb,cached_kb,slab_kb,sreclaimable_kb,sunreclaim_kb,temp_c,rx_bytes_delta,tx_bytes_delta,elapsed_s,detail,interfaces)
  values(d.id,b,(j->>'seq')::bigint,(j->>'observed_at')::timestamptz,now(),effective,(j->>'uptime_s')::float8,(j->>'cpu_pct')::float8,(j->>'load1')::float8,(j->>'mem_total_kb')::bigint,(j->>'mem_available_kb')::bigint,(j->>'mem_free_kb')::bigint,(j->>'cached_kb')::bigint,(j->>'slab_kb')::bigint,(j->>'sreclaimable_kb')::bigint,(j->>'sunreclaim_kb')::bigint,(j->>'temp_c')::float8,(j->>'rx_bytes_delta')::bigint,(j->>'tx_bytes_delta')::bigint,(j->>'elapsed_s')::float8,j->'detail',j->'interfaces')
  on conflict(device_id,boot_id,seq) do nothing returning * into s;
  if found then
   perform private.accumulate_sample(s);
   if b=d.last_boot_id then
    insert into public.device_latest as a values(d.id,now(),b,s.seq,s.observed_at,s.uptime_s,s.cpu_pct,s.load1,s.mem_total_kb,s.mem_available_kb,s.temp_c,s.rx_bytes_delta,s.tx_bytes_delta,s.elapsed_s,s.detail,s.interfaces)
    on conflict(device_id) do update set received_at=excluded.received_at,boot_id=excluded.boot_id,seq=excluded.seq,observed_at=excluded.observed_at,uptime_s=excluded.uptime_s,cpu_pct=excluded.cpu_pct,load1=excluded.load1,mem_total_kb=excluded.mem_total_kb,mem_available_kb=excluded.mem_available_kb,temp_c=excluded.temp_c,rx_bytes_delta=excluded.rx_bytes_delta,tx_bytes_delta=excluded.tx_bytes_delta,elapsed_s=excluded.elapsed_s,detail=case when a.boot_id=excluded.boot_id then private.merge_detail(a.detail,excluded.detail) else excluded.detail end,interfaces=excluded.interfaces
    where a.boot_id<>excluded.boot_id or (excluded.uptime_s>=a.uptime_s and excluded.seq>a.seq);
    get diagnostics changed=row_count;
    if changed>0 then perform private.evaluate_sample_rules(s,d.config);end if;
   end if;
  end if;
 end loop;
 for j in select value from jsonb_array_elements(case when low_storage then '[]'::jsonb else p_batch->'logs' end) loop
  if (j->>'seq')::bigint <= (select discarded_log_through_seq from public.boot_sessions where device_id=d.id and boot_id=b) then continue;end if;
  insert into public.system_logs(device_id,boot_id,seq,observed_at,uptime_s,severity,service,message,count,first_at,last_at)
  values(d.id,b,(j->>'seq')::bigint,(j->>'observed_at')::timestamptz,(j->>'uptime_s')::float8,(j->>'severity')::smallint,j->>'service',j->>'message',(j->>'count')::int,(j->>'first_at')::timestamptz,(j->>'last_at')::timestamptz) on conflict(device_id,boot_id,seq) do nothing returning id into inserted_log;
  if inserted_log is not null then
   if j->>'message' ~* '(out of memory|oom-kill|invoked oom-killer|page allocation failure)' then
    perform private.set_alert(d.id,'oom:'||b::text,true,'Kernel reported an out-of-memory or allocation failure event','critical');
   end if;
   if (coalesce(j->>'service','')||' '||coalesce(j->>'message','')) ~* 'ath11k.*(crash|restart|failed to start)' then
    perform private.set_alert(d.id,'ath11k:'||b::text,true,'ath11k reported a crash, restart or start failure','critical');
   end if;
  end if;
 end loop;
 if p_batch ? 'diagnostics' and p_batch->'diagnostics'<>'null'::jsonb then
  diag_request_id:=p_batch#>>'{diagnostics,request_id}';
  if low_storage then
   diag_accepted:=false;diag_reason:='storage_budget';
  elsif not coalesce((d.config->>'diagnostics_enabled')::bool,false) then
   diag_accepted:=false;diag_reason:='cloud_diagnostics_disabled';
  else
   insert into public.diagnostics(device_id,boot_id,payload) values(d.id,b,p_batch->'diagnostics');
   diag_accepted:=true;diag_reason:='stored';
  end if;
 end if;
 update private.ingest_batches set diagnostics_accepted=diag_accepted,diagnostics_request_id=diag_request_id,diagnostics_reason=diag_reason where device_id=d.id and batch_id=bid;
 update public.devices set last_seen_at=now(),last_boot_id=d.last_boot_id,
 dropped_samples=dropped_samples+coalesce((p_batch->>'dropped_samples')::bigint,0),
 dropped_logs=dropped_logs+case when low_storage then jsonb_array_length(p_batch->'logs') else 0 end,
 storage_degraded_at=case when low_storage then now() else storage_degraded_at end where id=d.id;
 return jsonb_build_object('accepted',true,'duplicate',false,'config',d.config,'storage_degraded',low_storage,'diagnostics_accepted',diag_accepted,'diagnostics_request_id',diag_request_id,'diagnostics_reason',diag_reason);
end $$;

revoke execute on function public.ingest_batch(text,jsonb) from public,anon,authenticated;
grant execute on function public.ingest_batch(text,jsonb) to service_role;
