import Fastify, { type FastifyInstance } from "fastify";
import { authPlugin, requireRole } from "./auth/plugin";
import type { Db } from "./db/client";
import { authRoutes } from "./routes/auth";

export interface AppOptions { db: Db; jwtSecret: string }

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(authPlugin, { secret: opts.jwtSecret });
  app.register(authRoutes, { db: opts.db });
  // Placeholder until Task 8 replaces the body.
  app.get("/me/residents", { preHandler: requireRole("family") }, async () => ({ residents: [] }));
  app.get("/health", async () => ({ ok: true }));
  return app;
}
