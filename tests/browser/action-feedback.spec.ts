import {test,expect,type Page} from '@playwright/test';
// Synthetic browser fixtures only. Never bundled or uploaded.
async function signInFixture(page:Page){
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
  await page.goto('/');
  await page.getByLabel('Email address').fill('fixture@example.test');
  await page.getByLabel('Password',{exact:true}).fill('fixture-password');
  await page.getByRole('button',{name:'Sign in securely'}).click();
  await expect(page.getByRole('heading',{name:'Overview',exact:true})).toBeVisible();
  return router;
}

async function visibleActivity(page:Page){const panel=page.getByLabel('Action activity');await expect(panel).toBeVisible();const box=await panel.boundingBox(),size=page.viewportSize()!;expect(box).not.toBeNull();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.y).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(size.width+1);expect(box!.y+box!.height).toBeLessThanOrEqual(size.height+1);return panel;}
test('real pending and completed feedback remains visible on screen',async({page},info)=>{
 const router=await signInFixture(page);let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});let writes=0,fail=false;
 await page.route('**/api/v1/devices/**',async route=>{
  const headers={'Access-Control-Allow-Origin':'*'};
  if(route.request().method()==='OPTIONS'){await route.fulfill({status:204,headers:{...headers,'Access-Control-Allow-Headers':'Authorization,Content-Type','Access-Control-Allow-Methods':'PATCH,POST'}});return;}
  writes++;if(fail){await route.fulfill({status:503,contentType:'application/json',headers,body:JSON.stringify({error:'backend_unavailable'})});return;}
  await barrier;router.name='RENAMED SYNTHETIC FIXTURE';await route.fulfill({status:200,contentType:'application/json',headers,body:'{"ok":true}'});
 });
 if(info.project.name==='mobile')await page.getByRole('button',{name:'Open navigation'}).click();
 await page.getByRole('link',{name:'Settings',exact:true}).click();
 await page.getByLabel('Friendly name',{exact:true}).first().fill('RENAMED SYNTHETIC FIXTURE');await page.getByRole('button',{name:'Save router name'}).click();
 const pending=page.getByRole('button',{name:'Saving name…'});await expect(pending).toBeDisabled();await pending.dispatchEvent('click');await expect.poll(()=>writes).toBe(1);
 let panel=await visibleActivity(page);await expect(panel.getByText('Saving the router name…',{exact:true})).toBeVisible();
 release();await expect(panel.getByText('Router name saved in the cloud.',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Save router name'})).toBeEnabled();
 await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));panel=await visibleActivity(page);await expect(panel.getByText('Router name saved in the cloud.',{exact:true})).toBeVisible();
 fail=true;await page.getByRole('button',{name:'Save router name'}).click();await expect(panel.getByRole('alert')).toContainText('Refresh to check whether the action completed before retrying.');await visibleActivity(page);expect(writes).toBe(2);
 await page.screenshot({path:`test-results/${info.project.name}-action-feedback-fixture.png`,fullPage:true});
});
test('enrollment shows creation and clipboard rejection honestly',async({page})=>{
 await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new DOMException('Write permission denied','NotAllowedError'))}}));
 await signInFixture(page);
 await page.route('**/api/v1/enrollment',async route=>route.fulfill({status:201,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({token:'nxe_'+('f'.repeat(64)),expires_at:new Date(Date.now()+600000).toISOString()})}));
 await page.getByRole('button',{name:'Add router'}).click();const dialog=page.getByRole('dialog');await dialog.getByLabel('Router name').fill('SYNTHETIC ENROLLMENT');await dialog.getByRole('button',{name:'Create enrollment code'}).click();
 await expect(dialog.getByLabel('One-use enrollment code')).toBeVisible();await expect(page.getByLabel('Action activity')).toContainText('Enrollment code created.');await dialog.getByRole('button',{name:'Copy code'}).click();await expect(page.getByLabel('Action activity').getByRole('alert')).toContainText('Select the text and copy it manually.');await visibleActivity(page);
});
