import {existsSync,readFileSync} from 'node:fs';
const required=['apps/worker/wrangler.jsonc','supabase/migrations/202611250001_core.sql','supabase/migrations/202611250002_storage.sql','supabase/migrations/202611250003_cron.sql','openwrt/nicx-telemetry/Makefile','openwrt/luci-app-nicx-telemetry/Makefile'];
let failed=false;
for(const path of required){if(!existsSync(path)){console.error('Missing project file:',path);failed=true;}}
const frontend=process.env.VITE_SUPABASE_ANON_KEY??'';
if(frontend.startsWith('sb_secret_')){console.error('A secret Supabase key was assigned to a browser variable.');failed=true;}
if(frontend.split('.').length===3){try{const payload=JSON.parse(Buffer.from(frontend.split('.')[1],'base64url').toString());if(payload.role==='service_role'){console.error('The service role key must never be used by the dashboard.');failed=true;}}catch{}}
const config=readFileSync('apps/worker/wrangler.jsonc','utf8');
if(/SUPABASE_SECRET_KEY\s*["']?\s*:/.test(config)){console.error('Privileged database credentials must be Worker secrets.');failed=true;}
console.log(failed?'Preflight failed.':'Project file and environment separation checks passed. This does not provision or contact cloud resources.');
process.exit(failed?1:0);
