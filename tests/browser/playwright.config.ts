import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'.',testMatch:'*.spec.ts',timeout:30000,use:{baseURL:'http://127.0.0.1:4173',headless:true},
  webServer:{command:'VITE_SUPABASE_URL=https://fixture.supabase.co VITE_SUPABASE_ANON_KEY=fixture-public-key pnpm --filter @nicx/dashboard dev --port 4173',url:'http://127.0.0.1:4173',reuseExistingServer:false,timeout:30000},
  projects:[{name:'desktop',use:{viewport:{width:1440,height:1000}}},{name:'mobile',use:{viewport:{width:390,height:844},isMobile:true,hasTouch:true}}],
});
