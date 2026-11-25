-- Follow-up to applied migrations. Keep historical definitions and receipts intact.

create or replace function public.rotate_device_token(p_device_id uuid,p_owner_id uuid,p_token_hash text) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid credential hash' using errcode='22023'; end if;
 perform 1 from public.devices where id=p_device_id and owner_id=p_owner_id and revoked_at is null for no key update;
 if not found then raise exception 'device not owned or revoked' using errcode='42501'; end if;
 update private.device_credentials set token_hash=p_token_hash,rotated_at=now() where device_id=p_device_id;
 return jsonb_build_object('rotated',true);
end $$;

create or replace function public.ingest_batch(p_token_hash text,p_batch jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare d public.devices; c private.device_credentials; h text; b uuid; bid uuid; j jsonb; s public.metric_samples; max_u float8; effective timestamptz; first_boot bool; changed int;low_storage bool;inserted_log uuid;diag_accepted bool:=false;diag_request_id text;diag_reason text:='no_diagnostics';
begin
 -- Lock the device before its credential. Key-share locks for maintenance foreign keys can proceed.
 select x.* into d from public.devices x join private.device_credentials y on x.id=y.device_id where y.token_hash=p_token_hash and x.revoked_at is null for no key update of x;
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

create or replace function public.history(p_device_id uuid,p_from timestamptz,p_to timestamptz)
returns table(bucket timestamptz,cpu_pct double precision,cpu_min double precision,cpu_max double precision,mem_available_kb numeric,temp_c double precision,rx_bytes_delta numeric,tx_bytes_delta numeric,elapsed_s double precision,sample_count bigint)
language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare r int; first_minute timestamptz; rollup_from timestamptz:=p_from; raw_incomplete bool;begin
 if not exists(select 1 from public.devices d where d.id=p_device_id and d.owner_id=auth.uid()) then raise exception 'device not owned' using errcode='42501';end if;
 if p_from is null or p_to is null or p_to<=p_from or p_to-p_from>interval '400 days' then raise exception 'invalid history range' using errcode='22023';end if;
 if p_to-p_from<=interval '3 hours' and p_from>=now()-make_interval(days=>(select least(7,greatest(1,coalesce((config->>'retention_raw_days')::int,3))) from public.devices where id=p_device_id)) then
  first_minute:=date_trunc('minute',p_from);
  -- Compare complete bucket counts, including the edges of the requested range.
  -- This also detects retained raw rows interleaved with older rows removed by the cap.
  select exists(
   select 1 from public.metric_rollups a
   left join (
    select date_trunc('minute',s.effective_at) as minute,count(*) as sample_count
    from public.metric_samples s
    where s.device_id=p_device_id and s.effective_at>=first_minute
      and s.effective_at<date_trunc('minute',p_to)+interval '1 minute'
    group by 1
   ) raw on raw.minute=a.bucket
   where a.device_id=p_device_id and a.resolution_s=60 and a.bucket>=first_minute and a.bucket<p_to
     and coalesce(raw.sample_count,0)<a.sample_count
  ) into raw_incomplete;
  if not raw_incomplete and not exists(
   select 1 from public.metric_samples s
   where s.device_id=p_device_id and s.effective_at>=p_from and s.effective_at<p_to
   offset 2160
  ) then
   return query select s.effective_at,s.cpu_pct,s.cpu_pct,s.cpu_pct,s.mem_available_kb::numeric,s.temp_c,s.rx_bytes_delta::numeric,s.tx_bytes_delta::numeric,s.elapsed_s,1::bigint
   from public.metric_samples s where s.device_id=p_device_id and s.effective_at>=p_from and s.effective_at<p_to order by s.effective_at limit 2160;
   return;
  end if;
  rollup_from:=first_minute;
 end if;
 r:=case when p_from>=now()-interval '30 days' and p_to-p_from<=interval '2 days' then 60 when p_from>=now()-interval '180 days' and p_to-p_from<=interval '14 days' then 900 when p_from>=now()-interval '365 days' then 3600 else 86400 end;
 return query select a.bucket,a.cpu_sum/nullif(a.cpu_count,0),a.cpu_min,a.cpu_max,a.mem_available_sum/nullif(a.mem_available_count,0),a.temp_sum/nullif(a.temp_count,0),a.rx_bytes,a.tx_bytes,a.coverage_s,a.sample_count
 from public.metric_rollups a where a.device_id=p_device_id and a.resolution_s=r and a.bucket>=rollup_from and a.bucket<p_to order by a.bucket;
end $$;

-- Publish a distinct claim RPC so a new Worker can detect an older database before leasing work.
alter function public.claim_notifications(int) rename to claim_notification_attempts;
drop function public.finish_notification(uuid,bool,text);
create function public.finish_notification(p_id uuid,p_attempt int,p_ok bool,p_error text) returns void language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 update private.notification_queue set delivered_at=case when p_ok then now() end,claimed_until=null,
 last_error=case when p_ok then null else left(p_error,500) end,
 available_at=now()+make_interval(secs=>least(3600,(30*power(2,least(attempts,7)))::int))
 where id=p_id and attempts=p_attempt and delivered_at is null and claimed_until>now();
end $$;
revoke execute on function public.claim_notification_attempts(int),public.finish_notification(uuid,int,bool,text) from public,anon,authenticated;
grant execute on function public.claim_notification_attempts(int),public.finish_notification(uuid,int,bool,text) to service_role;

-- A pending outbox entry blocks new references through the Storage HTTP deletion.
create index diagnostics_archive_path on public.diagnostics(object_path) where object_path is not null;

create function private.guard_diagnostic_archive_path() returns trigger language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 if new.object_path is null then return new;end if;
 if tg_op='UPDATE' and new.object_path is not distinct from old.object_path then return new;end if;
 perform pg_advisory_xact_lock(hashtextextended(new.object_path,42));
 if exists(select 1 from private.storage_deletions where object_path=new.object_path) then
  raise exception 'diagnostic archive path queued for deletion' using errcode='23514';
 end if;
 return new;
end $$;

revoke execute on function private.guard_diagnostic_archive_path() from public,anon,authenticated;
create trigger diagnostics_archive_path_guard before insert or update of object_path on public.diagnostics
for each row execute function private.guard_diagnostic_archive_path();

create or replace function private.queue_storage_deletion() returns trigger language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 if old.object_path is not null then
  perform pg_advisory_xact_lock(hashtextextended(old.object_path,42));
  insert into private.storage_deletions(object_path) values(old.object_path) on conflict(object_path) do nothing;
 end if;
 if tg_op='DELETE' then return old;end if;
 return new;
end $$;

create or replace function public.enqueue_storage_deletion(p_object_path text) returns void language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 if p_object_path is null or p_object_path !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.json\.gz$' then
 raise exception 'invalid archive object path' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_object_path,42));
 insert into private.storage_deletions(object_path)
 select p_object_path where not exists(select 1 from public.diagnostics where object_path=p_object_path)
 on conflict(object_path) do nothing;
end $$;

create or replace function public.claim_storage_deletions(p_limit int) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare result jsonb;begin
 with chosen as(
  select n.id from private.storage_deletions n
  where n.available_at<=now() and (n.claimed_until is null or n.claimed_until<now())
    and not exists(select 1 from public.diagnostics d where d.object_path=n.object_path)
  order by n.created_at for update skip locked limit least(50,greatest(1,p_limit))
 ),
 leased as(update private.storage_deletions n set claimed_until=now()+interval '2 minutes',attempts=attempts+1 from chosen where n.id=chosen.id returning n.id,n.object_path)
 select coalesce(jsonb_agg(to_jsonb(leased)),'[]'::jsonb) into result from leased;
 return result;
end $$;
