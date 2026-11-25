-- Run as project postgres in a dedicated test/production Supabase SQL editor after migrations.
-- Read-only checks. No credentials or sample telemetry are inserted.
begin read only;
do $$
declare t text;begin
 foreach t in array array['devices','device_latest','metric_samples','system_logs','diagnostics','boot_sessions','alerts','alert_rules','metric_rollups','bandwidth_daily','client_names','enrollment_tokens'] loop
  if not (select relrowsecurity from pg_class where oid=('public.'||t)::regclass) then raise exception 'RLS missing: %',t;end if;
  if t<>'device_latest' and exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then
   raise exception 'monitor table incorrectly published: %',t;
  end if;
 end loop;
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private') and p.prosecdef and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'))) then raise exception 'privileged RPC exposed';end if;
 if not has_function_privilege('authenticated','public.history(uuid,timestamptz,timestamptz)','execute') then raise exception 'owner history missing';end if;
 if not exists(select 1 from storage.buckets where id='router-diagnostics' and not public) then raise exception 'private bucket missing';end if;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='device_latest') then raise exception 'latest publication missing';end if;
 if not exists(select 1 from cron.job where jobname='nicx-router-maintenance' and active and schedule='* * * * *') then raise exception 'maintenance cron missing';end if;
 if not exists(select 1 from cron.job where jobname='nicx-router-cron-log-retention' and active) then raise exception 'cron log cleanup missing';end if;
end $$;
select * from public.resource_usage();
rollback;
