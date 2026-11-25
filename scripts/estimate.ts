import {estimateUsage} from '../packages/shared/src/index';
const routers=Number(process.argv[2]??1);
if(!Number.isInteger(routers)||routers<1||routers>100)throw new Error('Router count must be 1–100');
console.log(JSON.stringify({note:'Planning estimate only. Row size must be replaced with pg_total_relation_size measurements. Excludes database baseline, rollups, logs, indexes beyond assumed row size, bloat, auth, archives and other egress.',...estimateUsage({routers,sampleInterval:10,uploadInterval:30,rawDays:3,rowBytes:1200,viewers:1})},null,2));
