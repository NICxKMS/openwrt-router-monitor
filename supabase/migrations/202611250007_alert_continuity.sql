-- Additive follow-up; previously applied migrations remain immutable.
-- Existing sequential migration naming is used because the CLI is unavailable.
-- Cadence metadata is advisory and independently bounded before use.
create or replace function private.evaluate_sample_rules(s public.metric_samples,p_config jsonb) returns void language plpgsql set search_path=pg_catalog,public,private as $$
declare r public.alert_rules; st private.alert_state;v float8;breach bool;recover bool;t timestamptz:=least(now(),s.effective_at);probe_family text;probe jsonb;cs private.connectivity_state;
 sample_s float8;connectivity_s float8;detail_s float8;candidate numeric;gap_s float8;
begin
 -- Cloud intervals are requests; local safety settings and adaptive collection may
 -- deliberately be slower. Legacy samples retain the bounded monotonic interval.
 sample_s:=least(300,greatest(5,coalesce((p_config->>'sample_interval')::float8,10)));
 if s.elapsed_s between 5 and 300 then sample_s:=greatest(sample_s,s.elapsed_s);end if;
 if jsonb_typeof(s.detail#>'{cadence,sample_s}')='number' then
  candidate:=(s.detail#>>'{cadence,sample_s}')::numeric;
  if candidate between 5 and 300 then sample_s:=candidate::float8;end if;
 end if;
 connectivity_s:=greatest(sample_s,30);
 if jsonb_typeof(s.detail#>'{cadence,connectivity_s}')='number' then
  candidate:=(s.detail#>>'{cadence,connectivity_s}')::numeric;
  if candidate between 30 and 120 then connectivity_s:=greatest(sample_s,candidate::float8);end if;
 end if;
 detail_s:=greatest(sample_s,least(3600,greatest(60,coalesce((p_config->>'detail_interval')::float8,300))));
 if jsonb_typeof(s.detail#>'{cadence,detail_s}')='number' then
  candidate:=(s.detail#>>'{cadence,detail_s}')::numeric;
  if candidate between 60 and 3600 then detail_s:=greatest(sample_s,candidate::float8);end if;
 end if;
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
   gap_s:=3*case when r.metric in ('memory_psi_full_avg10','conntrack_pct') then detail_s when r.metric in ('latency_ms','loss_pct') then connectivity_s else sample_s end;
   if st.breached_since is null or st.last_sample_at<t-make_interval(secs=>gap_s) then st.breached_since:=t;end if;
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
    if cs.last_sample_at<t-make_interval(secs=>3*connectivity_s) then cs.failures:=0;end if;
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
create or replace function private.reset_changed_rule() returns trigger language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 -- During a device cascade the parent is already gone. Do not enqueue a
 -- resolution referencing that deleted device. A normal rule edit locks the
 -- surviving parent until its resolution notification has been recorded.
 perform 1 from public.devices where id=old.device_id for key share;
 if found then perform private.set_alert(old.device_id,old.id::text,false,'Rule changed or removed');end if;
 if tg_op='DELETE' then return old;end if;
 delete from private.alert_state where rule_id=old.id;
 return new;
end $$;

revoke execute on function private.evaluate_sample_rules(public.metric_samples,jsonb),private.reset_changed_rule() from public,anon,authenticated;
