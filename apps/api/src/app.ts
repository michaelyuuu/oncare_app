import Fastify, { type FastifyInstance } from "fastify";
import { authPlugin } from "./auth/plugin";
import type { Db } from "./db/client";
import { authRoutes } from "./routes/auth";
import { meRoutes } from "./routes/me";
import { visitRoutes } from "./routes/visits";
import { createDispatchService } from "./services/dispatch";
import { GatewayHub } from "./services/gateway-hub";
import { createTransitionService } from "./services/transitions";
import { createVisitService, type TransitionService, type VisitService } from "./services/visits";

export interface AppOptions { db: Db; jwtSecret: string; now?: () => Date }

declare module "fastify" {
  interface FastifyInstance {
    transitions: TransitionService; visits: VisitService;
    hub: GatewayHub; dispatch: ReturnType<typeof createDispatchService>;
  }
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const transitions = createTransitionService(opts.db, opts.now ? { now: opts.now } : {});
  app.decorate("transitions", transitions);
  const hub = new GatewayHub();
  app.decorate("hub", hub);
  app.decorate("dispatch", createDispatchService(opts.db, transitions, hub, opts.now ? { now: opts.now } : {}));
  app.decorate("visits", createVisitService(opts.db, transitions, opts.now ? { now: opts.now } : {}));
  app.register(authPlugin, { secret: opts.jwtSecret });
  app.register(authRoutes, { db: opts.db });
  app.register(meRoutes, { db: opts.db });
  app.register(visitRoutes);
  app.get("/health", async () => ({ ok: true }));
  return app;
}
