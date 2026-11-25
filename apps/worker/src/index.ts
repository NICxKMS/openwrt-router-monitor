import { createApp } from './app';
import { type Env } from './db';
import { runScheduled } from './scheduled';
const app=createApp();
export default {
  async fetch(request:Request,env:Env,context:ExecutionContext):Promise<Response>{
    if(new URL(request.url).pathname.startsWith('/api/'))return app.fetch(request,env,context);
    return env.ASSETS?env.ASSETS.fetch(request):new Response('Dashboard assets are not built.',{status:503});
  },
  async scheduled(_event:ScheduledController,env:Env,_context:ExecutionContext):Promise<void>{
    // Failure causes a failed scheduled invocation visible in Cloudflare metrics; never print credentials.
    await runScheduled(env);
  },
};
