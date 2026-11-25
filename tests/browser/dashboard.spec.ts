import {test,expect} from '@playwright/test';

// Synthetic network responses exist only in this browser-test harness. Never bundled.
test('owner can log in, inspect real-query pages and use mobile navigation',async({page},testInfo)=>{
  const owner='00000000-0000-4000-8000-000000000001',device='10000000-0000-4000-8000-000000000001',boot='20000000-0000-4000-8000-000000000001';
  const now=new Date().toISOString();
  const user={id:owner,aud:'authenticated',role:'authenticated',email:'fixture@example.test',app_metadata:{provider:'email'},user_metadata:{},created_at:now};
  const token=['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',Buffer.from(JSON.stringify({sub:owner,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000)})).toString('base64url'),'fixture-signature'].join('.');
  const router={id:device,name:'SIMULATED FIXTURE · JIDU6111',model:'JIDU6111 · browser test data',last_seen_at:now,created_at:now,revoked_at:null,config:{upload_interval:30,sample_interval:10,billing_day:1,monthly_quota_gb:0}};
  const sample={device_id:device,boot_id:boot,seq:1,observed_at:now,received_at:now,bucket:now,uptime_s:3600,cpu_pct:25,load1:0.5,mem_total_kb:400000,mem_available_kb:200000,temp_c:55,rx_bytes_delta:100000,tx_bytes_delta:20000,elapsed_s:10,detail:{capabilities:{fixture:'SIMULATED ONLY'},cpu:{cores:{cpu0:25}},processes:[{name:'dnsmasq',pid:100,rss_kb:2048}],services:{dnsmasq:true},wifi:{radios:[]}},interfaces:[]};
  await page.route('https://fixture.supabase.co/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    let body:unknown=[];
    if(path.includes('/auth/v1/token'))body={access_token:token,refresh_token:'fixture-refresh-token',token_type:'bearer',expires_in:3600,user};
    else if(path.includes('/auth/v1/user'))body=user;
    else if(path.endsWith('/devices'))body=[router];
    else if(path.endsWith('/device_latest'))body=sample;
    else if(path.endsWith('/metric_samples')||path.endsWith('/rpc/history'))body=[sample];
    else if(path.endsWith('/boot_sessions'))body=[{device_id:device,boot_id:boot,first_seen_at:now,last_seen_at:now,inventory:{firmware:'SIMULATED FIXTURE'}}];
    await route.fulfill({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*','Content-Range':'0-0/1'},body:JSON.stringify(body)});
  });
  await page.routeWebSocket('wss://fixture.supabase.co/**',socket=>socket.close());
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('Email address').fill('fixture@example.test');
  await page.getByLabel('Password',{exact:true}).fill('fixture-password');
  await page.getByRole('button',{name:'Sign in securely'}).click();
  await expect(page.getByRole('heading',{name:'Overview',exact:true})).toBeVisible();
  await expect(page.locator('.device-strip strong')).toHaveText('SIMULATED FIXTURE · JIDU6111');
  if(testInfo.project.name==='mobile')await page.getByRole('button',{name:'Open navigation'}).click();
  await page.getByRole('link',{name:'Memory',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Memory',exact:true})).toBeVisible();
  if(testInfo.project.name==='mobile')await page.getByRole('button',{name:'Open navigation'}).click();
  await page.getByRole('link',{name:'Logs',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Logs',exact:true})).toBeVisible();
  if(testInfo.project.name==='mobile')await page.getByRole('button',{name:'Open navigation'}).click();
  await page.getByRole('link',{name:'Overview',exact:true}).click();
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await expect(page.getByRole('button',{name:'Resume',exact:true})).toBeVisible();
  await expect(page.locator('canvas').first()).toBeVisible({timeout:20000});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`test-results/${testInfo.project.name}-simulated-fixture.png`,fullPage:true});
  expect(errors).toEqual([]);
});
