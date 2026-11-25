-- Concurrent archive attempts use distinct immutable object names. Queue replaced objects.
create or replace function private.queue_storage_deletion() returns trigger language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 if old.object_path is not null then
  insert into private.storage_deletions(object_path) values(old.object_path) on conflict(object_path) do nothing;
 end if;
 if tg_op='DELETE' then return old;end if;
 return new;
end $$;
create trigger diagnostics_archive_replaced before update of object_path on public.diagnostics
for each row when (old.object_path is distinct from new.object_path) execute function private.queue_storage_deletion();
