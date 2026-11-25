import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdirSync} from 'node:fs';
const worker=fileURLToPath(new URL('../apps/worker/',import.meta.url));
const logs=fileURLToPath(new URL('../apps/worker/.wrangler/logs/',import.meta.url));
mkdirSync(logs,{recursive:true});
const cli=fileURLToPath(new URL('../apps/worker/node_modules/wrangler/bin/wrangler.js',import.meta.url));
const result=spawnSync(process.execPath,[cli,'deploy','--dry-run','--outdir','dist'],{cwd:worker,stdio:'inherit',env:{...process.env,WRANGLER_LOG_PATH:logs,WRANGLER_SEND_METRICS:'false'}});
process.exit(result.status??1);
