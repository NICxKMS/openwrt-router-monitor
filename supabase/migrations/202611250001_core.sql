-- UTC data, owner-isolated reads, and service-only atomic writes.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;
revoke create on schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema private revoke execute on functions from public;

create table public.devices (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 name text not null check(length(name) between 1 and 100), model text check(length(model)<=160),
 created_at timestamptz not null default now(), last_seen_at timestamptz, last_boot_id uuid,
 config jsonb not null default '{"sample_interval":10,"upload_interval":30,"wifi_interval":30,"process_interval":60,"detail_interval":300,"buffer_kb":2048,"logs_enabled":true,"log_severity":5,"privacy_addresses":false,"diagnostics_enabled":false,"retention_raw_days":3,"retention_logs_days":7,"monthly_quota_gb":0,"billing_day":1}'::jsonb,
 revoked_at timestamptz,dropped_samples bigint not null default 0,dropped_logs bigint not null default 0,storage_degraded_at timestamptz
);
create index devices_owner on public.devices(owner_id);
create table public.enrollment_tokens (
 id uuid primary key default gen_random_uuid(),owner_id uuid not null references auth.users(id) on delete cascade,
 token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),expires_at timestamptz not null,
 name text not null check(length(name) between 1 and 100),created_at timestamptz not null default now(),consumed_at timestamptz,
 check(expires_at<=created_at+interval '15 minutes')
);
create table private.device_credentials (
 device_id uuid primary key references public.devices(id) on delete cascade,
 token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),
 window_start timestamptz not null default now(),window_count int not null default 0,
 rotated_at timestamptz not null default now()
);
create table private.ingest_batches (
 device_id uuid references public.devices(id) on delete cascade,batch_id uuid,payload_hash text not null,
 received_at timestamptz not null default now(),primary key(device_id,batch_id)
);
create table public.boot_sessions (
 device_id uuid references public.devices(id) on delete cascade,boot_id uuid,
 first_seen_at timestamptz not null default now(),last_seen_at timestamptz not null default now(),inventory jsonb,discarded_through_seq bigint not null default -1,discarded_log_through_seq bigint not null default -1,uptime_origin_at timestamptz,
 primary key(device_id,boot_id)
);
create table public.device_latest (
 device_id uuid primary key references public.devices(id) on delete cascade,received_at timestamptz not null,
 boot_id uuid not null,seq bigint not null,observed_at timestamptz,uptime_s double precision not null,
 cpu_pct double precision,load1 double precision,mem_total_kb bigint,mem_available_kb bigint,temp_c double precision,
 rx_bytes_delta bigint,tx_bytes_delta bigint,elapsed_s double precision,detail jsonb,interfaces jsonb
);
create table public.metric_samples (
 device_id uuid references public.devices(id) on delete cascade,boot_id uuid not null,seq bigint not null check(seq>=0),
 observed_at timestamptz,received_at timestamptz not null default now(),effective_at timestamptz not null,
 uptime_s double precision not null check(uptime_s>=0),cpu_pct double precision check(cpu_pct between 0 and 100),
 load1 double precision check(load1>=0),mem_total_kb bigint check(mem_total_kb>=0),mem_available_kb bigint check(mem_available_kb>=0),
 mem_free_kb bigint,cached_kb bigint,slab_kb bigint,sreclaimable_kb bigint,sunreclaim_kb bigint,temp_c double precision,
 rx_bytes_delta bigint check(rx_bytes_delta>=0),tx_bytes_delta bigint check(tx_bytes_delta>=0),elapsed_s double precision check(elapsed_s>0),
 detail jsonb,interfaces jsonb,primary key(device_id,boot_id,seq),
 check(detail is null or octet_length(detail::text)<=16384)
);
create index metric_samples_time on public.metric_samples(device_id,effective_at desc);
create table public.system_logs (
 id uuid not null default gen_random_uuid() primary key,device_id uuid not null references public.devices(id) on delete cascade,
 boot_id uuid not null,seq bigint not null check(seq>=0),observed_at timestamptz,received_at timestamptz not null default now(),
 uptime_s double precision not null check(uptime_s>=0),severity smallint not null check(severity between 0 and 7),
 service text not null check(length(service)<=64),message text not null check(length(message)<=1024),
 count int not null check(count between 1 and 100000),first_at timestamptz,last_at timestamptz,unique(device_id,boot_id,seq)
);
create index logs_cursor on public.system_logs(device_id,received_at desc,id desc);
create table public.diagnostics (
 id uuid primary key default gen_random_uuid(),device_id uuid not null references public.devices(id) on delete cascade,
 boot_id uuid not null,created_at timestamptz not null default now(),payload jsonb not null,
 object_path text,check(octet_length(payload::text)<=16384)
);
create index diagnostics_time on public.diagnostics(device_id,created_at desc);
create table public.alert_rules (
 id uuid primary key default gen_random_uuid(),device_id uuid not null references public.devices(id) on delete cascade,
 metric text not null check(metric in ('cpu_pct','temp_c','mem_available_kb','latency_ms','loss_pct','memory_psi_full_avg10','conntrack_pct')),operator text not null check(operator in ('gt','lt')),
 threshold double precision not null,sustain_s int not null default 60 check(sustain_s between 0 and 86400),
 hysteresis double precision not null default 5 check(hysteresis>=0),cooldown_s int not null default 300 check(cooldown_s between 0 and 604800),
 enabled bool not null default true
);
create table public.alerts (
 id uuid primary key default gen_random_uuid(),device_id uuid not null references public.devices(id) on delete cascade,
 rule_key text not null,severity text not null check(severity in ('info','warning','critical')),
 message text not null,opened_at timestamptz not null default now(),resolved_at timestamptz,acknowledged_at timestamptz
);
create unique index alerts_active on public.alerts(device_id,rule_key) where resolved_at is null;
create index alerts_time on public.alerts(device_id,opened_at desc);
create table private.connectivity_state (
 device_id uuid references public.devices(id) on delete cascade,family text check(family in ('ipv4','ipv6','dns')),
 failures int not null default 0,last_sample_at timestamptz,primary key(device_id,family)
);
create table private.alert_state (
 rule_id uuid primary key references public.alert_rules(id) on delete cascade,
 breached_since timestamptz,last_notified_at timestamptz,last_sample_at timestamptz
);
create table public.metric_rollups (
 device_id uuid references public.devices(id) on delete cascade,resolution_s int check(resolution_s in (60,900,3600,86400)),bucket timestamptz,
 sample_count bigint not null,cpu_min double precision,cpu_max double precision,cpu_sum double precision,cpu_count bigint not null,
 mem_available_min bigint,mem_available_max bigint,mem_available_sum numeric,mem_available_count bigint not null,
 temp_min double precision,temp_max double precision,temp_sum double precision,temp_count bigint not null,
 rx_bytes numeric,tx_bytes numeric,coverage_s double precision,primary key(device_id,resolution_s,bucket)
);
create table public.bandwidth_daily (
 device_id uuid references public.devices(id) on delete cascade,day date,interface_name text,role text check(role in ('wan','usbwan')),
 rx_bytes numeric,tx_bytes numeric,coverage_s double precision,primary key(device_id,day,interface_name,role)
);
create table public.client_names (
 device_id uuid references public.devices(id) on delete cascade,client_id text check(length(client_id)<=128),name text not null check(length(name)<=100),primary key(device_id,client_id)
);
create table private.notification_queue (
 id uuid primary key default gen_random_uuid(),device_id uuid not null references public.devices(id) on delete cascade,
 alert_id uuid references public.alerts(id) on delete cascade,event text not null check(event in ('opened','resolved')),
 created_at timestamptz not null default now(),available_at timestamptz not null default now(),claimed_until timestamptz,
 attempts int not null default 0,delivered_at timestamptz,last_error text,unique(alert_id,event)
);
create table private.maintenance_state (
 singleton bool primary key default true check(singleton),last_run_at timestamptz,last_duration_ms numeric
);
insert into private.maintenance_state(singleton) values(true);

-- Every public relation has RLS; credential/enrollment reads are never exposed.
do $$ declare t text; begin
 foreach t in array array['devices','device_latest','metric_samples','system_logs','diagnostics','boot_sessions','alerts','alert_rules','metric_rollups','bandwidth_daily','client_names','enrollment_tokens'] loop
  execute format('alter table public.%I enable row level security',t);
  if t='devices' then
   execute 'create policy owner_read on public.devices for select to authenticated using(owner_id=(select auth.uid()))';
  elsif t<>'enrollment_tokens' then
   execute format('create policy owner_read on public.%I for select to authenticated using(exists(select 1 from public.devices d where d.id=device_id and d.owner_id=(select auth.uid())))',t);
  end if;
 end loop;
end $$;
create policy owner_insert on public.alert_rules for insert to authenticated with check(exists(select 1 from public.devices d where d.id=device_id and d.owner_id=(select auth.uid())));
create policy owner_update on public.alert_rules for update to authenticated using(exists(select 1 from public.devices d where d.id=device_id and d.owner_id=(select auth.uid()))) with check(exists(select 1 from public.devices d where d.id=device_id and d.owner_id=(select auth.uid())));
create policy owner_delete on public.alert_rules for delete to authenticated using(exists(select 1 from public.devices d where d.id=device_id and d.owner_id=(select auth.uid())));
create policy owner_write on public.client_names for all to authenticated using(exists(select 1 from public.devices d where d.id=device_id and d.owner_id=(select auth.uid()))) with check(exists(select 1 from public.devices d where d.id=device_id and d.owner_id=(select auth.uid())));
revoke all on all tables in schema public from public,anon,authenticated;
grant select on public.devices,public.device_latest,public.metric_samples,public.system_logs,public.diagnostics,public.boot_sessions,public.alerts,public.alert_rules,public.metric_rollups,public.bandwidth_daily,public.client_names to authenticated;
grant insert,update,delete on public.alert_rules,public.client_names to authenticated;
grant all on all tables in schema public to service_role;
grant all on all tables in schema private to service_role;
alter table private.device_credentials enable row level security;
alter table private.ingest_batches enable row level security;
alter table private.alert_state enable row level security;
alter table private.connectivity_state enable row level security;
alter table private.notification_queue enable row level security;
alter table private.maintenance_state enable row level security;

-- Conservative live logical budget: full JSON bytes plus per-row/index overhead.
-- Transactional deltas avoid scanning telemetry at ingest and ignore reusable dead pages.
create table private.storage_budget(singleton bool primary key default true check(singleton),live_bytes bigint not null default 0);
insert into private.storage_budget(singleton) values(true);
alter table private.storage_budget enable row level security;
grant all on private.storage_budget to service_role;
create function private.account_storage() returns trigger language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare delta bigint:=0;begin
 if tg_op<>'DELETE' then delta:=octet_length(to_jsonb(new)::text)+256;end if;
 if tg_op<>'INSERT' then delta:=delta-octet_length(to_jsonb(old)::text)-256;end if;
 update private.storage_budget set live_bytes=greatest(0,live_bytes+delta) where singleton;
 return null;
end $$;
do $$ declare t text;begin
 foreach t in array array['devices','device_latest','metric_samples','system_logs','diagnostics','boot_sessions','alerts','alert_rules','metric_rollups','bandwidth_daily','client_names','enrollment_tokens'] loop
 execute format('create trigger storage_accounting after insert or update or delete on public.%I for each row execute function private.account_storage()',t);
 end loop;
 foreach t in array array['device_credentials','ingest_batches','alert_state','notification_queue','connectivity_state'] loop
 execute format('create trigger storage_accounting after insert or update or delete on private.%I for each row execute function private.account_storage()',t);
 end loop;
end $$;

create function public.enroll_device(p_enrollment_hash text,p_token_hash text,p_name text,p_model text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare e public.enrollment_tokens; d uuid; begin
 if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid credential hash' using errcode='22023'; end if;
 select * into e from public.enrollment_tokens where token_hash=p_enrollment_hash for update;
 if not found or e.consumed_at is not null or e.expires_at<=now() then raise exception 'invalid or expired enrollment' using errcode='28000'; end if;
 perform pg_advisory_xact_lock(hashtextextended(e.owner_id::text,0));
 if (select count(*) from public.devices where owner_id=e.owner_id)>=5 then raise exception 'device limit reached'; end if;
 insert into public.devices(owner_id,name,model) values(e.owner_id,coalesce(nullif(p_name,''),e.name),p_model) returning id into d;
 insert into private.device_credentials(device_id,token_hash) values(d,p_token_hash);
 update public.enrollment_tokens set consumed_at=now() where id=e.id;
 return jsonb_build_object('device_id',d);
end $$;
create function public.device_config(p_token_hash text) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare d public.devices; begin
 select x.* into d from public.devices x join private.device_credentials c on c.device_id=x.id where c.token_hash=p_token_hash and x.revoked_at is null;
 if not found then raise exception 'invalid device credential' using errcode='28000'; end if;
 return jsonb_build_object('device_id',d.id,'config',d.config);
end $$;
create function public.rotate_device_token(p_device_id uuid,p_owner_id uuid,p_token_hash text) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid credential hash' using errcode='22023'; end if;
 perform 1 from public.devices where id=p_device_id and owner_id=p_owner_id and revoked_at is null for update;
 if not found then raise exception 'device not owned or revoked' using errcode='42501'; end if;
 update private.device_credentials set token_hash=p_token_hash,rotated_at=now() where device_id=p_device_id;
 return jsonb_build_object('rotated',true);
end $$;

-- Additive rollups happen only after a new primary-key insertion, making retries harmless.
create function private.accumulate_sample(s public.metric_samples) returns void language plpgsql set search_path=pg_catalog,public,private as $$
declare r int; i jsonb; begin
 foreach r in array array[60,900,3600,86400] loop
 insert into public.metric_rollups as a values(s.device_id,r,to_timestamp(floor(extract(epoch from s.effective_at)/r)*r),1,
 s.cpu_pct,s.cpu_pct,s.cpu_pct,(s.cpu_pct is not null)::int,
 s.mem_available_kb,s.mem_available_kb,s.mem_available_kb,(s.mem_available_kb is not null)::int,
 s.temp_c,s.temp_c,s.temp_c,(s.temp_c is not null)::int,s.rx_bytes_delta,s.tx_bytes_delta,case when s.rx_bytes_delta is not null or s.tx_bytes_delta is not null then s.elapsed_s end)
 on conflict(device_id,resolution_s,bucket) do update set
 sample_count=a.sample_count+1,cpu_min=least(a.cpu_min,excluded.cpu_min),cpu_max=greatest(a.cpu_max,excluded.cpu_max),
 cpu_sum=case when a.cpu_sum is null and excluded.cpu_sum is null then null else coalesce(a.cpu_sum,0)+coalesce(excluded.cpu_sum,0) end,cpu_count=a.cpu_count+excluded.cpu_count,
 mem_available_min=least(a.mem_available_min,excluded.mem_available_min),mem_available_max=greatest(a.mem_available_max,excluded.mem_available_max),
 mem_available_sum=case when a.mem_available_sum is null and excluded.mem_available_sum is null then null else coalesce(a.mem_available_sum,0)+coalesce(excluded.mem_available_sum,0) end,mem_available_count=a.mem_available_count+excluded.mem_available_count,
 temp_min=least(a.temp_min,excluded.temp_min),temp_max=greatest(a.temp_max,excluded.temp_max),
 temp_sum=case when a.temp_sum is null and excluded.temp_sum is null then null else coalesce(a.temp_sum,0)+coalesce(excluded.temp_sum,0) end,temp_count=a.temp_count+excluded.temp_count,
 rx_bytes=case when a.rx_bytes is null and excluded.rx_bytes is null then null else coalesce(a.rx_bytes,0)+coalesce(excluded.rx_bytes,0) end,
 tx_bytes=case when a.tx_bytes is null and excluded.tx_bytes is null then null else coalesce(a.tx_bytes,0)+coalesce(excluded.tx_bytes,0) end,
 coverage_s=case when a.coverage_s is null and excluded.coverage_s is null then null else coalesce(a.coverage_s,0)+coalesce(excluded.coverage_s,0) end;
 end loop;
 for i in select value from jsonb_array_elements(coalesce(s.interfaces,'[]')) loop
 if i->>'role' in ('wan','usbwan') then
 insert into public.bandwidth_daily as a values(s.device_id,(s.effective_at at time zone 'UTC')::date,i->>'name',i->>'role',
 case when coalesce((i->>'reset')::bool,false) then null else (i->>'rx_delta')::numeric end,
 case when coalesce((i->>'reset')::bool,false) then null else (i->>'tx_delta')::numeric end,
 case when not coalesce((i->>'reset')::bool,false) and ((i->>'rx_delta') is not null or (i->>'tx_delta') is not null) then (i->>'elapsed_s')::float8 end)
 on conflict(device_id,day,interface_name,role) do update set
 rx_bytes=case when a.rx_bytes is null and excluded.rx_bytes is null then null else coalesce(a.rx_bytes,0)+coalesce(excluded.rx_bytes,0) end,
 tx_bytes=case when a.tx_bytes is null and excluded.tx_bytes is null then null else coalesce(a.tx_bytes,0)+coalesce(excluded.tx_bytes,0) end,
 coverage_s=case when a.coverage_s is null and excluded.coverage_s is null then null else coalesce(a.coverage_s,0)+coalesce(excluded.coverage_s,0) end;
 end if;
 end loop;
end $$;

-- Bound the latest cache even if collector names change over a device's lifetime.
create function private.merge_detail(p_old jsonb,p_new jsonb) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select case when octet_length((coalesce(nullif(p_old,'null'::jsonb),'{}'::jsonb)||coalesce(nullif(p_new,'null'::jsonb),'{}'::jsonb))::text)<=65536
 then coalesce(nullif(p_old,'null'::jsonb),'{}'::jsonb)||coalesce(nullif(p_new,'null'::jsonb),'{}'::jsonb)
 else coalesce(nullif(p_new,'null'::jsonb),'{}'::jsonb) end
$$;

create function public.ingest_batch(p_token_hash text,p_batch jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare d public.devices; c private.device_credentials; h text; b uuid; bid uuid; j jsonb; s public.metric_samples; max_u float8; effective timestamptz; first_boot bool; changed int;low_storage bool;inserted_log uuid;
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
 select payload_hash into h from private.ingest_batches where device_id=d.id and batch_id=bid;
 if found then
  if h<>md5(p_batch::text) then raise exception 'batch replay payload mismatch' using errcode='22023'; end if;
  update public.devices set last_seen_at=now() where id=d.id;
  return jsonb_build_object('accepted',true,'duplicate',true,'config',d.config);
 end if;
 if c.window_start<=now()-interval '1 minute' then c.window_start:=now();c.window_count:=0;end if;
 if c.window_count>=10 then raise exception 'device rate limit exceeded' using errcode='P0001';end if;
 update private.device_credentials set window_start=c.window_start,window_count=c.window_count+1 where device_id=d.id;
 low_storage:=(select live_bytes>=335544320 from private.storage_budget where singleton);
 if (select live_bytes>=419430400 from private.storage_budget where singleton) then
  update public.devices set last_seen_at=now() where id=d.id;
  return jsonb_build_object('accepted',false,'duplicate',false,'reason','storage_budget','config',d.config);
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
 if not low_storage and p_batch ? 'diagnostics' and p_batch->'diagnostics'<>'null'::jsonb then
  if not coalesce((d.config->>'diagnostics_enabled')::bool,false) then raise exception 'diagnostics disabled';end if;
  insert into public.diagnostics(device_id,boot_id,payload) values(d.id,b,p_batch->'diagnostics');
 end if;
 update public.devices set last_seen_at=now(),last_boot_id=d.last_boot_id,
 dropped_samples=dropped_samples+coalesce((p_batch->>'dropped_samples')::bigint,0),
 dropped_logs=dropped_logs+case when low_storage then jsonb_array_length(p_batch->'logs') else 0 end,
 storage_degraded_at=case when low_storage then now() else storage_degraded_at end where id=d.id;
 return jsonb_build_object('accepted',true,'duplicate',false,'config',d.config,'storage_degraded',low_storage);
end $$;

-- Authenticated read RPC executes with caller RLS and explicitly checks ownership.
create function public.history(p_device_id uuid,p_from timestamptz,p_to timestamptz)
returns table(bucket timestamptz,cpu_pct double precision,cpu_min double precision,cpu_max double precision,mem_available_kb numeric,temp_c double precision,rx_bytes_delta numeric,tx_bytes_delta numeric,elapsed_s double precision,sample_count bigint)
language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare r int;begin
 if not exists(select 1 from public.devices d where d.id=p_device_id and d.owner_id=auth.uid()) then raise exception 'device not owned' using errcode='42501';end if;
 if p_from is null or p_to is null or p_to<=p_from or p_to-p_from>interval '400 days' then raise exception 'invalid history range' using errcode='22023';end if;
 if p_to-p_from<=interval '3 hours' and p_from>=now()-make_interval(days=>(select least(7,greatest(1,coalesce((config->>'retention_raw_days')::int,3))) from public.devices where id=p_device_id)) then
  return query select s.effective_at,s.cpu_pct,s.cpu_pct,s.cpu_pct,s.mem_available_kb::numeric,s.temp_c,s.rx_bytes_delta::numeric,s.tx_bytes_delta::numeric,s.elapsed_s,1::bigint
  from public.metric_samples s where s.device_id=p_device_id and s.effective_at>=p_from and s.effective_at<p_to order by s.effective_at limit 2160;
 else
  r:=case when p_from>=now()-interval '30 days' and p_to-p_from<=interval '2 days' then 60 when p_from>=now()-interval '180 days' and p_to-p_from<=interval '14 days' then 900 when p_from>=now()-interval '365 days' then 3600 else 86400 end;
  return query select a.bucket,a.cpu_sum/nullif(a.cpu_count,0),a.cpu_min,a.cpu_max,a.mem_available_sum/nullif(a.mem_available_count,0),a.temp_sum/nullif(a.temp_count,0),a.rx_bytes,a.tx_bytes,a.coverage_s,a.sample_count
  from public.metric_rollups a where a.device_id=p_device_id and a.resolution_s=r and a.bucket>=p_from and a.bucket<p_to order by a.bucket;
 end if;
end $$;

create function private.set_alert(p_device uuid,p_key text,p_breach bool,p_message text,p_severity text default 'warning')
returns void language plpgsql set search_path=pg_catalog,public,private as $$
declare a uuid;begin
 if p_breach then
  insert into public.alerts(device_id,rule_key,severity,message) values(p_device,p_key,p_severity,p_message)
  on conflict(device_id,rule_key) where resolved_at is null do nothing returning id into a;
  if a is not null then insert into private.notification_queue(device_id,alert_id,event) values(p_device,a,'opened') on conflict do nothing;end if;
 else
  update public.alerts set resolved_at=now() where device_id=p_device and rule_key=p_key and resolved_at is null returning id into a;
  if a is not null then insert into private.notification_queue(device_id,alert_id,event) values(p_device,a,'resolved') on conflict do nothing;end if;
 end if;
end $$;


create function private.evaluate_sample_rules(s public.metric_samples,p_config jsonb) returns void language plpgsql set search_path=pg_catalog,public,private as $$
declare r public.alert_rules; st private.alert_state;v float8;breach bool;recover bool;t timestamptz:=least(now(),s.effective_at);probe_family text;probe jsonb;cs private.connectivity_state;begin
 for r in select * from public.alert_rules where device_id=s.device_id and enabled loop
  insert into private.alert_state(rule_id) values(r.id) on conflict do nothing;
  select * into st from private.alert_state where rule_id=r.id for update;
  if st.last_sample_at is not null and t<=st.last_sample_at then continue;end if;
  -- Sparse collectors retain state between their observations; an explicit null resets it.
  if (r.metric in ('latency_ms','loss_pct') and not coalesce(s.detail ? 'connectivity',false))
   or (r.metric='memory_psi_full_avg10' and not coalesce(s.detail ? 'memory',false))
   or (r.metric='conntrack_pct' and not coalesce(s.detail ? 'firewall',false)) then continue;end if;
  v:=case r.metric when 'cpu_pct' then s.cpu_pct when 'temp_c' then s.temp_c when 'mem_available_kb' then s.mem_available_kb
   when 'latency_ms' then case when jsonb_typeof(s.detail#>'{connectivity,ipv4,latency_ms}')='number' then (s.detail#>>'{connectivity,ipv4,latency_ms}')::float8 end
   when 'loss_pct' then case when jsonb_typeof(s.detail#>'{connectivity,ipv4,loss_pct}')='number' then (s.detail#>>'{connectivity,ipv4,loss_pct}')::float8 end
   when 'memory_psi_full_avg10' then case when jsonb_typeof(s.detail#>'{memory,psi,memory,full,avg10}')='number' then (s.detail#>>'{memory,psi,memory,full,avg10}')::float8 end
   when 'conntrack_pct' then case when jsonb_typeof(s.detail#>'{firewall,conntrack_count}')='number' and jsonb_typeof(s.detail#>'{firewall,conntrack_max}')='number' then 100*(s.detail#>>'{firewall,conntrack_count}')::float8/nullif((s.detail#>>'{firewall,conntrack_max}')::float8,0) end end;
  if v is null then
   update private.alert_state set breached_since=null,last_sample_at=t where rule_id=r.id;continue;
  end if;
  breach:=case r.operator when 'gt' then v>r.threshold else v<r.threshold end;
  recover:=case r.operator when 'gt' then v<=r.threshold-r.hysteresis else v>=r.threshold+r.hysteresis end;
  if breach then
   if st.breached_since is null or st.last_sample_at<t-make_interval(secs=>case when r.metric in ('memory_psi_full_avg10','conntrack_pct') then greatest(60,coalesce((p_config->>'detail_interval')::int,300)*2) when r.metric in ('latency_ms','loss_pct') then greatest(60,coalesce((p_config->>'wifi_interval')::int,30)*3) else greatest(30,coalesce((p_config->>'sample_interval')::int,10)*3) end) then st.breached_since:=t;end if;
   if t-st.breached_since>=make_interval(secs=>r.sustain_s) and (st.last_notified_at is null or t-st.last_notified_at>=make_interval(secs=>r.cooldown_s)) then
    perform private.set_alert(s.device_id,r.id::text,true,r.metric||' '||r.operator||' '||r.threshold::text);
    st.last_notified_at:=t;
   end if;
  else
   st.breached_since:=null;
   if recover then perform private.set_alert(s.device_id,r.id::text,false,'Threshold recovered');end if;
  end if;
  update private.alert_state set breached_since=st.breached_since,last_sample_at=t,last_notified_at=st.last_notified_at where rule_id=r.id;
 end loop;
 -- Require two explicit failed probes; unsupported or omitted capabilities never imply failure.
 foreach probe_family in array array['ipv4','ipv6','dns'] loop
  probe:=s.detail#>array['connectivity',probe_family];
  if probe->>'available'='true' and jsonb_typeof(probe->'reachable')='boolean' then
   insert into private.connectivity_state(device_id,family) values(s.device_id,probe_family) on conflict do nothing;
   select * into cs from private.connectivity_state x where x.device_id=s.device_id and x.family=probe_family for update;
   if cs.last_sample_at is not null and t<=cs.last_sample_at then continue;end if;
   if probe->>'reachable'='false' then
    if cs.last_sample_at<t-make_interval(secs=>greatest(60,coalesce((p_config->>'sample_interval')::int,10)*3)) then cs.failures:=0;end if;
    cs.failures:=cs.failures+1;
    if cs.failures>=2 then perform private.set_alert(s.device_id,'reachability:'||probe_family,true,case probe_family when 'dns' then 'DNS probe failed on consecutive observations' else upper(probe_family)||' public endpoint probes failed on consecutive observations; ISP cause is unconfirmed' end,'warning');end if;
   else
    cs.failures:=0;
    perform private.set_alert(s.device_id,'reachability:'||probe_family,false,'Probe recovered');
   end if;
   update private.connectivity_state x set failures=cs.failures,last_sample_at=t where x.device_id=s.device_id and x.family=probe_family;
  end if;
 end loop;
end $$;
create function public.maintenance() returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare d public.devices;r public.alert_rules;prev timestamptz;started timestamptz:=clock_timestamp();n int;deleted int:=0;cycle date;usage numeric;
begin
 if not pg_try_advisory_xact_lock(628193751) then return '{"skipped":true}'::jsonb;end if;
 select last_run_at into prev from private.maintenance_state where singleton for update;
 for d in select * from public.devices where revoked_at is null loop
  perform private.set_alert(d.id,'offline',coalesce(d.last_seen_at,d.created_at)<now()-make_interval(secs=>greatest(120,coalesce((d.config->>'upload_interval')::int,30)*3)),'Router has stopped sending telemetry','critical');
  perform private.set_alert(d.id,'cloud_gap',prev is not null and prev<now()-interval '5 minutes','Cloud maintenance was delayed; the outage may affect multiple devices','warning');
  -- Thresholds evaluate every new latest sample at ingest, never infer sustained load
  -- from wall time while the router is quiet. Maintenance closes disabled rules.
  for r in select * from public.alert_rules where device_id=d.id and not enabled loop
   perform private.set_alert(d.id,r.id::text,false,'Rule disabled');
   delete from private.alert_state where rule_id=r.id;
  end loop;
  if coalesce((d.config->>'monthly_quota_gb')::numeric,0)>0 then
   cycle:=(date_trunc('month',now() at time zone 'UTC')+make_interval(days=>least(28,greatest(1,coalesce((d.config->>'billing_day')::int,1)))-1))::date;
   if cycle>(now() at time zone 'UTC')::date then cycle:=(cycle-interval '1 month')::date;end if;
   select sum(coalesce(rx_bytes,0)+coalesce(tx_bytes,0)) into usage from public.bandwidth_daily where device_id=d.id and day>=cycle;
   perform private.set_alert(d.id,'monthly_quota',coalesce(usage,0)>=(d.config->>'monthly_quota_gb')::numeric*1000000000,'Configured monthly Internet traffic quota reached');
  else perform private.set_alert(d.id,'monthly_quota',false,'Quota disabled');end if;
 end loop;
 -- Bounded batches avoid a single maintenance transaction deleting an unbounded backlog.
 with doomed as materialized (
  select s.device_id,s.boot_id,s.seq from public.metric_samples s join public.devices retention_device on retention_device.id=s.device_id
  where s.received_at<now()-make_interval(days=>least(7,greatest(1,coalesce((retention_device.config->>'retention_raw_days')::int,3)))) order by s.received_at limit 5000),
 watermarks as (update public.boot_sessions b set discarded_through_seq=greatest(b.discarded_through_seq,x.seq) from (select device_id,boot_id,max(seq) seq from doomed group by device_id,boot_id)x where b.device_id=x.device_id and b.boot_id=x.boot_id)
 delete from public.metric_samples where(device_id,boot_id,seq) in(select device_id,boot_id,seq from doomed);
 get diagnostics n=row_count;deleted:=deleted+n;
 with doomed as materialized (select s.id,s.device_id,s.boot_id,s.seq from public.system_logs s join public.devices retention_device on retention_device.id=s.device_id
 where s.received_at<now()-make_interval(days=>least(30,greatest(1,coalesce((retention_device.config->>'retention_logs_days')::int,7)))) order by s.received_at limit 5000),
 watermarks as (update public.boot_sessions b set discarded_log_through_seq=greatest(b.discarded_log_through_seq,x.seq) from (select device_id,boot_id,max(seq) seq from doomed group by device_id,boot_id)x where b.device_id=x.device_id and b.boot_id=x.boot_id)
 delete from public.system_logs where id in(select id from doomed);
 get diagnostics n=row_count;deleted:=deleted+n;
 -- Hard per-device caps protect against log storms, separate from age retention.
 with doomed as materialized (select id,device_id,boot_id,seq from(select id,device_id,boot_id,seq,row_number() over(partition by device_id order by received_at desc,id desc) rn from public.system_logs)x where rn>10000 limit 5000),
 watermarks as (update public.boot_sessions b set discarded_log_through_seq=greatest(b.discarded_log_through_seq,x.seq) from (select device_id,boot_id,max(seq) seq from doomed group by device_id,boot_id)x where b.device_id=x.device_id and b.boot_id=x.boot_id)
 delete from public.system_logs where id in(select id from doomed);
 get diagnostics n=row_count;deleted:=deleted+n;
 with doomed as materialized (select device_id,boot_id,seq from(select device_id,boot_id,seq,row_number() over(partition by device_id order by received_at desc,seq desc) rn from public.metric_samples)x where rn>30000 limit 5000),
 watermarks as (update public.boot_sessions b set discarded_through_seq=greatest(b.discarded_through_seq,x.seq) from (select device_id,boot_id,max(seq) seq from doomed group by device_id,boot_id)x where b.device_id=x.device_id and b.boot_id=x.boot_id)
 delete from public.metric_samples where(device_id,boot_id,seq) in(select device_id,boot_id,seq from doomed);
 get diagnostics n=row_count;deleted:=deleted+n;
 -- Delete trigger preserves object paths in an outbox for Storage API cleanup.
 delete from public.diagnostics where id in(select id from(select id,object_path,created_at,row_number() over(partition by device_id order by created_at desc) rn from public.diagnostics)x where (created_at<now()-interval '7 days' or rn>50) limit 1000);
 get diagnostics n=row_count;deleted:=deleted+n;
 delete from public.metric_rollups where (device_id,resolution_s,bucket) in(select device_id,resolution_s,bucket from public.metric_rollups where bucket<now()-case resolution_s when 60 then interval '30 days' when 900 then interval '180 days' when 3600 then interval '365 days' else interval '400 days' end order by bucket limit 5000);
 delete from public.bandwidth_daily where (device_id,day,interface_name,role) in(select device_id,day,interface_name,role from public.bandwidth_daily where day<current_date-730 order by day limit 5000);
 delete from private.ingest_batches where (device_id,batch_id) in(select device_id,batch_id from private.ingest_batches where received_at<now()-interval '8 days' limit 5000);
 delete from public.enrollment_tokens where id in(select id from public.enrollment_tokens where expires_at<now()-interval '1 day' limit 1000);
 delete from public.alerts where id in(select id from public.alerts where resolved_at<now()-interval '90 days' limit 1000);
 delete from private.notification_queue where id in(select id from private.notification_queue where delivered_at<now()-interval '7 days' or created_at<now()-interval '30 days' limit 1000);
 update private.maintenance_state set last_run_at=now(),last_duration_ms=extract(epoch from clock_timestamp()-started)*1000 where singleton;
 return jsonb_build_object('deleted',deleted,'completed_at',now());
end $$;

create function public.claim_notifications(p_limit int) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare result jsonb;begin
 with chosen as(select id from private.notification_queue where delivered_at is null and attempts<8 and available_at<=now() and(claimed_until is null or claimed_until<now()) order by created_at for update skip locked limit least(50,greatest(1,p_limit))),
 leased as(update private.notification_queue n set claimed_until=now()+interval '2 minutes',attempts=attempts+1 from chosen where n.id=chosen.id returning n.*)
 select coalesce(jsonb_agg(jsonb_build_object('id',n.id,'device_id',n.device_id,'owner_id',d.owner_id,'alert_id',n.alert_id,'event',n.event,'message',a.message,'severity',a.severity,'created_at',n.created_at,'attempts',n.attempts)),'[]'::jsonb) into result from leased n join public.devices d on d.id=n.device_id join public.alerts a on a.id=n.alert_id;
 return result;
end $$;
create function public.finish_notification(p_id uuid,p_ok bool,p_error text) returns void language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 update private.notification_queue set delivered_at=case when p_ok then now() end,claimed_until=null,
 last_error=case when p_ok then null else left(p_error,500) end,
 available_at=now()+make_interval(secs=>least(3600,(30*power(2,least(attempts,7)))::int))
 where id=p_id and delivered_at is null and claimed_until>now();
end $$;
create function public.resource_usage() returns jsonb language sql security definer set search_path=pg_catalog,public,private as $$
 select jsonb_build_object('database_bytes',pg_database_size(current_database()),
 'logical_budget_bytes',(select live_bytes from private.storage_budget where singleton),
 'table_bytes',(select coalesce(sum(pg_total_relation_size(c.oid)),0) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind='r'),
 'archive_bytes',null,'archive_objects',(select count(*) from public.diagnostics where object_path is not null),
 'devices',(select count(*) from public.devices),'samples',(select count(*) from public.metric_samples),
 'logs',(select count(*) from public.system_logs),'notification_pending',(select count(*) from private.notification_queue where delivered_at is null),
 'last_maintenance_at',(select last_run_at from private.maintenance_state where singleton))
$$;

-- Enrollment token inserts are serialized by owner even when multiple Workers race.
create function private.limit_enrollments() returns trigger language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text,0));
 if (select count(*) from public.enrollment_tokens where owner_id=new.owner_id and consumed_at is null and expires_at>now())>=10 then raise exception 'enrollment rate limit exceeded';end if;
 return new;
end $$;
create trigger enrollment_limit before insert on public.enrollment_tokens for each row execute function private.limit_enrollments();


create table private.storage_deletions (
 id uuid primary key default gen_random_uuid(),object_path text not null unique,
 created_at timestamptz not null default now(),available_at timestamptz not null default now(),
 claimed_until timestamptz,attempts int not null default 0,last_error text
);
create function private.queue_storage_deletion() returns trigger language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 if old.object_path is not null then
  insert into private.storage_deletions(object_path) values(old.object_path) on conflict(object_path) do nothing;
 end if;
 return old;
end $$;
create trigger storage_accounting after insert or update or delete on private.storage_deletions for each row execute function private.account_storage();
create trigger diagnostics_storage_cleanup before delete on public.diagnostics for each row execute function private.queue_storage_deletion();
create function public.enqueue_storage_deletion(p_object_path text) returns void language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 if p_object_path is null or p_object_path !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.json\.gz$' then
 raise exception 'invalid archive object path' using errcode='22023';end if;
 insert into private.storage_deletions(object_path) values(p_object_path) on conflict(object_path) do nothing;
end $$;
create function public.claim_storage_deletions(p_limit int) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare result jsonb;begin
 with chosen as(select id from private.storage_deletions where available_at<=now() and (claimed_until is null or claimed_until<now()) order by created_at for update skip locked limit least(50,greatest(1,p_limit))),
 leased as(update private.storage_deletions n set claimed_until=now()+interval '2 minutes',attempts=attempts+1 from chosen where n.id=chosen.id returning n.id,n.object_path)
 select coalesce(jsonb_agg(to_jsonb(leased)),'[]'::jsonb) into result from leased;
 return result;
end $$;
create function public.finish_storage_deletion(p_id uuid,p_ok bool,p_error text) returns void language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 if p_ok then delete from private.storage_deletions where id=p_id and claimed_until>now();
 else update private.storage_deletions set claimed_until=null,last_error=left(p_error,500),available_at=now()+make_interval(secs=>least(3600,(30*power(2,least(attempts,7)))::int)) where id=p_id and claimed_until>now();end if;
end $$;
create function private.reset_changed_rule() returns trigger language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 perform private.set_alert(old.device_id,old.id::text,false,'Rule changed or removed');
 if tg_op='DELETE' then return old;end if;
 delete from private.alert_state where rule_id=old.id;
 return new;
end $$;
create trigger changed_rule before update or delete on public.alert_rules for each row execute function private.reset_changed_rule();

grant all on private.storage_deletions to service_role;
alter table private.storage_deletions enable row level security;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function public.history(uuid,timestamptz,timestamptz) to authenticated;
grant execute on function public.enroll_device(text,text,text,text),public.ingest_batch(text,jsonb),public.device_config(text),public.rotate_device_token(uuid,uuid,text),public.maintenance(),public.claim_notifications(int),public.finish_notification(uuid,bool,text),public.resource_usage(),public.enqueue_storage_deletion(text),public.claim_storage_deletions(int),public.finish_storage_deletion(uuid,bool,text) to service_role;
-- Only the small latest row is published. Historical data is read through bounded queries.
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
  alter publication supabase_realtime add table public.device_latest;
 end if;
end $$;
