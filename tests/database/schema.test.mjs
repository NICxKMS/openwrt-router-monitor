import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
const root = new URL('../../supabase/migrations/', import.meta.url);
const files = readdirSync(root).filter(x => x.endsWith('.sql')).sort();
const sql = files.map(x => readFileSync(new URL(x, root),'utf8')).join('\n');
test('database implements every contract RPC and isolates privileged execution', () => {
  for (const name of ['enroll_device','ingest_batch','device_config','rotate_device_token','maintenance','claim_notification_attempts','finish_notification','resource_usage','history']) {
    assert.match(sql,new RegExp(`(?:function public\\.${name}\\(|rename to ${name};)`));
  }
  assert.match(sql,/revoke execute on all functions in schema public from public, anon, authenticated/i);
  assert.match(sql,/create extension if not exists pg_cron with schema pg_catalog/i);
});
