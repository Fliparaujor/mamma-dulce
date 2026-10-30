import { app } from './app';
import { log } from './lib/log';
import { runScheduler } from './scheduler/run';
import type { Env } from './env';

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runScheduler(env, 'cron')
        .then((r) => {
          if (r.runId !== null) log('info', 'scheduler.run', { runId: r.runId, status: r.status, summary: r.summary });
        })
        .catch((e: unknown) => log('error', 'scheduler.crash', { error: (e as Error).message, cron: controller.cron })),
    );
  },
} satisfies ExportedHandler<Env>;
