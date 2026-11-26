-- Null counts mark legacy buckets whose source samples may already have expired.
alter table public.metric_rollups
 add column rx_delta_count bigint,
 add column tx_delta_count bigint;

-- Retention can remove part of a bucket. Backfill only when all observations remain.
with retained as (
 select s.device_id,r,to_timestamp(floor(extract(epoch from s.effective_at)/r)*r) as bucket,
        count(*) as sample_count,count(s.rx_bytes_delta) as rx_count,count(s.tx_bytes_delta) as tx_count
 from public.metric_samples s cross join unnest(array[60,900,3600,86400]) as resolutions(r)
 group by 1,2,3
)
update public.metric_rollups a set rx_delta_count=retained.rx_count,tx_delta_count=retained.tx_count
from retained
where a.device_id=retained.device_id and a.resolution_s=retained.r and a.bucket=retained.bucket
  and a.sample_count=retained.sample_count;

create or replace function private.accumulate_sample(s public.metric_samples) returns void language plpgsql set search_path=pg_catalog,public,private as $$
declare r int; i jsonb; begin
 foreach r in array array[60,900,3600,86400] loop
 insert into public.metric_rollups as a(
  device_id,resolution_s,bucket,sample_count,cpu_min,cpu_max,cpu_sum,cpu_count,
  mem_available_min,mem_available_max,mem_available_sum,mem_available_count,
  temp_min,temp_max,temp_sum,temp_count,rx_bytes,tx_bytes,coverage_s,rx_delta_count,tx_delta_count
 ) values(s.device_id,r,to_timestamp(floor(extract(epoch from s.effective_at)/r)*r),1,
 s.cpu_pct,s.cpu_pct,s.cpu_pct,(s.cpu_pct is not null)::int,
 s.mem_available_kb,s.mem_available_kb,s.mem_available_kb,(s.mem_available_kb is not null)::int,
 s.temp_c,s.temp_c,s.temp_c,(s.temp_c is not null)::int,s.rx_bytes_delta,s.tx_bytes_delta,case when s.rx_bytes_delta is not null or s.tx_bytes_delta is not null then s.elapsed_s end,
 (s.rx_bytes_delta is not null)::int,(s.tx_bytes_delta is not null)::int)
 on conflict(device_id,resolution_s,bucket) do update set
 sample_count=a.sample_count+1,
 rx_delta_count=a.rx_delta_count+excluded.rx_delta_count,tx_delta_count=a.tx_delta_count+excluded.tx_delta_count,
 cpu_min=least(a.cpu_min,excluded.cpu_min),cpu_max=greatest(a.cpu_max,excluded.cpu_max),
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

drop function public.history(uuid,timestamptz,timestamptz);
create function public.history(p_device_id uuid,p_from timestamptz,p_to timestamptz)
returns table(bucket timestamptz,cpu_pct double precision,cpu_min double precision,cpu_max double precision,mem_available_kb numeric,temp_c double precision,rx_bytes_delta numeric,tx_bytes_delta numeric,elapsed_s double precision,sample_count bigint,rx_delta_count bigint,tx_delta_count bigint)
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
   return query select s.effective_at,s.cpu_pct,s.cpu_pct,s.cpu_pct,s.mem_available_kb::numeric,s.temp_c,s.rx_bytes_delta::numeric,s.tx_bytes_delta::numeric,s.elapsed_s,1::bigint,(s.rx_bytes_delta is not null)::int::bigint,(s.tx_bytes_delta is not null)::int::bigint
   from public.metric_samples s where s.device_id=p_device_id and s.effective_at>=p_from and s.effective_at<p_to order by s.effective_at limit 2160;
   return;
  end if;
  rollup_from:=first_minute;
 end if;
 r:=case when p_from>=now()-interval '30 days' and p_to-p_from<=interval '2 days' then 60 when p_from>=now()-interval '180 days' and p_to-p_from<=interval '14 days' then 900 when p_from>=now()-interval '365 days' then 3600 else 86400 end;
 return query select a.bucket,a.cpu_sum/nullif(a.cpu_count,0),a.cpu_min,a.cpu_max,a.mem_available_sum/nullif(a.mem_available_count,0),a.temp_sum/nullif(a.temp_count,0),a.rx_bytes,a.tx_bytes,a.coverage_s,a.sample_count,a.rx_delta_count,a.tx_delta_count
 from public.metric_rollups a where a.device_id=p_device_id and a.resolution_s=r and a.bucket>=rollup_from and a.bucket<p_to order by a.bucket;
end $$;

revoke execute on function public.history(uuid,timestamptz,timestamptz) from public,anon;
grant execute on function public.history(uuid,timestamptz,timestamptz) to authenticated;
