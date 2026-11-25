// Explicit operator-run read-only checks after deployment. Never prints credentials.
const base=process.env.MONITOR_URL??'https://router.nicx.me';
const parsed=new URL(base);if(parsed.protocol!=='https:')throw new Error('Use verified HTTPS.');
const health=await fetch(new URL('/api/v1/health',parsed),{signal:AbortSignal.timeout(10000),redirect:'error'});
if(!health.ok)throw new Error('Worker health endpoint failed: '+health.status);
const value=await health.json();if(value.schema_version!==1)throw new Error('Unsupported server schema');
const forbidden=await fetch(new URL('/api/v1/device/config',parsed),{signal:AbortSignal.timeout(10000),redirect:'error'});
if(forbidden.status!==401)throw new Error('Device endpoint did not reject an anonymous request');
const page=await fetch(parsed,{signal:AbortSignal.timeout(10000),redirect:'error'});
if(!page.ok || !page.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"))throw new Error('Dashboard or security headers missing');
console.log('HTTPS health, anonymous rejection and dashboard security headers passed. Enrollment, RLS, cron, notifications and physical-router checks remain separate.');
