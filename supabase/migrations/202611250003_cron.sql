-- Official Supabase Cron installation: pg_cron is installed in pg_catalog.
-- Apply on Supabase, after the core migration; do not silently ignore failure.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('nicx-router-maintenance','* * * * *','select public.maintenance();');
-- Bound pg_cron execution logs as well as application history.
select cron.schedule('nicx-router-cron-log-retention','17 3 * * *',
 $$delete from cron.job_run_details where runid in (select runid from cron.job_run_details where end_time < now()-interval '7 days' order by end_time limit 10000);$$);
