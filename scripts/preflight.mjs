import {existsSync,readFileSync} from 'node:fs';
import {loadDashboardEnv} from '../apps/dashboard/build-env.ts';
const required=['apps/worker/wrangler.jsonc','supabase/migrations/202611250001_core.sql','supabase/migrations/202611250002_storage.sql','supabase/migrations/202611250003_cron.sql','openwrt/nicx-telemetry/Makefile','openwrt/luci-app-nicx-telemetry/Makefile'];
let failed=false;
for(const path of required){if(!existsSync(path)){console.error('Missing project file:',path);failed=true;}}
for(const mode of ['development','production']){
 try{loadDashboardEnv(mode);}catch(error){console.error(error.message);failed=true;}
}
const config=readFileSync('apps/worker/wrangler.jsonc','utf8');
if(/SUPABASE_SECRET_KEY\s*["']?\s*:/.test(config)){console.error('Privileged database credentials must be Worker secrets.');failed=true;}
console.log(failed?'Preflight failed.':'Project file and environment separation checks passed. This does not provision or contact cloud resources.');
process.exit(failed?1:0);
