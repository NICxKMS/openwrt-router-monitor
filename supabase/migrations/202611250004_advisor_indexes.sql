-- Follow-up after hosted advisor review. Original applied migrations remain immutable.
create index if not exists notification_queue_device on private.notification_queue(device_id);
create index if not exists alert_rules_device on public.alert_rules(device_id);
create index if not exists enrollment_tokens_owner on public.enrollment_tokens(owner_id);
