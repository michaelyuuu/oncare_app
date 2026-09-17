import Fastify, { type FastifyInstance } from "fastify";
import { authPlugin } from "./auth/plugin";
import type { Db } from "./db/client";
import { authRoutes } from "./routes/auth";
import { meRoutes } from "./routes/me";

export interface AppOptions { db: Db; jwtSecret: string }

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(authPlugin, { secret: opts.jwtSecret });
  app.register(authRoutes, { db: opts.db });
  app.register(meRoutes, { db: opts.db });
  app.get("/health", async () => ({ ok: true }));
  return app;
}
