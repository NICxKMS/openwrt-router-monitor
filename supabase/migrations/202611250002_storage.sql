-- Supabase Storage exists on hosted/local Supabase; standalone test DB uses stubs.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('router-diagnostics','router-diagnostics',false,1048576,array['application/json','application/gzip'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy router_diagnostics_owner_read on storage.objects for select to authenticated
using(bucket_id='router-diagnostics' and exists(select 1 from public.devices d where d.id::text=lower(split_part(storage.objects.name,'/',1)) and d.owner_id=(select auth.uid())));
-- Browser uploads and deletes intentionally have no policy. Worker service uploads only.

-- Storage metadata is the current object size reported by Supabase, not DB row size.
create or replace function public.resource_usage() returns jsonb language sql security definer set search_path=pg_catalog,public,private as $$
 select jsonb_build_object('database_bytes',pg_database_size(current_database()),
 'logical_budget_bytes',(select live_bytes from private.storage_budget where singleton),
 'table_bytes',(select coalesce(sum(pg_total_relation_size(c.oid)),0) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind='r'),
 'archive_bytes',(select case when count(*)=0 then 0 when count(*)=count(metadata->>'size') then sum((metadata->>'size')::numeric) else null end from storage.objects where bucket_id='router-diagnostics'),
 'archive_objects',(select count(*) from storage.objects where bucket_id='router-diagnostics'),
 'devices',(select count(*) from public.devices),'samples',(select count(*) from public.metric_samples),
 'logs',(select count(*) from public.system_logs),'notification_pending',(select count(*) from private.notification_queue where delivered_at is null),
 'storage_deletions_pending',(select count(*) from private.storage_deletions),
 'last_maintenance_at',(select last_run_at from private.maintenance_state where singleton))
$$;
revoke execute on function public.resource_usage() from public,anon,authenticated;
grant execute on function public.resource_usage() to service_role;
-- Restrictive guards preserve isolation even if another bucket later gets broad policies.
create policy router_diagnostics_read_guard on storage.objects as restrictive for select to authenticated
using(bucket_id<>'router-diagnostics' or exists(select 1 from public.devices d where d.id::text=lower(split_part(storage.objects.name,'/',1)) and d.owner_id=(select auth.uid())));
create policy router_diagnostics_anon_guard on storage.objects as restrictive for all to anon
using(bucket_id<>'router-diagnostics') with check(bucket_id<>'router-diagnostics');
create policy router_diagnostics_insert_guard on storage.objects as restrictive for insert to authenticated
with check(bucket_id<>'router-diagnostics');
create policy router_diagnostics_update_guard on storage.objects as restrictive for update to authenticated
using(bucket_id<>'router-diagnostics') with check(bucket_id<>'router-diagnostics');
create policy router_diagnostics_delete_guard on storage.objects as restrictive for delete to authenticated
using(bucket_id<>'router-diagnostics');
