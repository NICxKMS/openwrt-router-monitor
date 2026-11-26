-- Report boundary precision without changing which points the history chart receives.
drop function public.history(uuid,timestamptz,timestamptz);
create function public.history(p_device_id uuid,p_from timestamptz,p_to timestamptz)
returns table(bucket timestamptz,cpu_pct double precision,cpu_min double precision,cpu_max double precision,mem_available_kb numeric,temp_c double precision,rx_bytes_delta numeric,tx_bytes_delta numeric,elapsed_s double precision,sample_count bigint,rx_delta_count bigint,tx_delta_count bigint,traffic_window_exact boolean)
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
   return query select s.effective_at,s.cpu_pct,s.cpu_pct,s.cpu_pct,s.mem_available_kb::numeric,s.temp_c,s.rx_bytes_delta::numeric,s.tx_bytes_delta::numeric,s.elapsed_s,1::bigint,(s.rx_bytes_delta is not null)::int::bigint,(s.tx_bytes_delta is not null)::int::bigint,
    coalesce(s.effective_at-make_interval(secs=>s.elapsed_s)>=p_from,false)
   from public.metric_samples s where s.device_id=p_device_id and s.effective_at>=p_from and s.effective_at<p_to order by s.effective_at limit 2160;
   return;
  end if;
  rollup_from:=first_minute;
 end if;
 r:=case when p_from>=now()-interval '30 days' and p_to-p_from<=interval '2 days' then 60 when p_from>=now()-interval '180 days' and p_to-p_from<=interval '14 days' then 900 when p_from>=now()-interval '365 days' then 3600 else 86400 end;
 -- Rollups retain aggregate elapsed time, with no start bound for the deltas.
 return query select a.bucket,a.cpu_sum/nullif(a.cpu_count,0),a.cpu_min,a.cpu_max,a.mem_available_sum/nullif(a.mem_available_count,0),a.temp_sum/nullif(a.temp_count,0),a.rx_bytes,a.tx_bytes,a.coverage_s,a.sample_count,a.rx_delta_count,a.tx_delta_count,
  false
 from public.metric_rollups a where a.device_id=p_device_id and a.resolution_s=r and a.bucket>=rollup_from and a.bucket<p_to order by a.bucket;
end $$;

revoke execute on function public.history(uuid,timestamptz,timestamptz) from public,anon;
grant execute on function public.history(uuid,timestamptz,timestamptz) to authenticated;
