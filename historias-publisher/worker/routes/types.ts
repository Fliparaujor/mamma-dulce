import type { Hono } from 'hono';
import type { Session } from '../auth/session';
import type { Env } from '../env';

export type AppEnv = { Bindings: Env; Variables: { session: Session } };
export type App = Hono<AppEnv>;
