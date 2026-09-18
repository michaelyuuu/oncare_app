import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { authPlugin } from "./auth/plugin";
import type { Db } from "./db/client";
import { authRoutes } from "./routes/auth";
import { deviceRoutes } from "./routes/device";
import { eventsRoutes } from "./routes/events-ws";
import { gatewayRoutes } from "./routes/gateway-ws";
import { meRoutes } from "./routes/me";
import { locationRoutes } from "./routes/locations";
import { robotRoutes } from "./routes/robots";
import { staffRoutes } from "./routes/staff";
import { taskRoutes } from "./routes/tasks";
import { visitRoutes } from "./routes/visits";
import { videoRoutes } from "./routes/video";
import { createDispatchService } from "./services/dispatch";
import { GatewayHub } from "./services/gateway-hub";
import { createTransitionService } from "./services/transitions";
import { createTaskService, type TaskService } from "./services/tasks";
import { createVisitService, type TransitionService, type VisitService } from "./services/visits";
import { videoProviderFromEnv, type VideoProvider } from "./services/video";
import { createBenchmarkService } from "./services/benchmark";
import { benchmarkRoutes } from "./routes/benchmark";

export interface AppOptions { db: Db; jwtSecret: string; now?: () => Date; video?: VideoProvider }

declare module "fastify" {
  interface FastifyInstance {
    transitions: TransitionService; visits: VisitService;
    hub: GatewayHub; dispatch: ReturnType<typeof createDispatchService>;
    tasks: TaskService;
    video: VideoProvider;
    benchmark: ReturnType<typeof createBenchmarkService>;
  }
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const transitions = createTransitionService(opts.db, opts.now ? { now: opts.now } : {});
  const video = opts.video ?? videoProviderFromEnv(process.env);
  app.decorate("video", video);
  app.decorate("transitions", transitions);
  const hub = new GatewayHub();
  app.decorate("hub", hub);
  app.decorate("tasks", createTaskService(opts.db, transitions, opts.now ? { now: opts.now } : {}, hub));
  app.decorate("dispatch", createDispatchService(opts.db, transitions, hub, opts.now ? { now: opts.now } : {}));
  app.decorate("benchmark", createBenchmarkService(opts.db, transitions, opts.now ? { now: opts.now } : {}));
  app.decorate("visits", createVisitService(opts.db, transitions, video, {
    ...(opts.now ? { now: opts.now } : {}),
    onVideoCloseError: (visitId) => app.log.error({ visitId }, "failed to close video room"),
  }));
  app.addHook("onClose", async () => app.visits.stop());
  app.register(authPlugin, { secret: opts.jwtSecret });
  app.register(fastifyWebsocket);
  app.register(authRoutes, { db: opts.db });
  app.register(deviceRoutes, { db: opts.db });
  app.register(meRoutes, { db: opts.db });
  app.register(locationRoutes, { db: opts.db, ...(opts.now ? { now: opts.now } : {}) });
  app.register(visitRoutes);
  app.register(videoRoutes, { db: opts.db, ...(opts.now ? { now: opts.now } : {}) });
  app.register(gatewayRoutes, { db: opts.db });
  app.register(robotRoutes, { db: opts.db });
  app.register(staffRoutes, { db: opts.db, ...(opts.now ? { now: opts.now } : {}) });
  app.register(taskRoutes);
  app.register(benchmarkRoutes, { db: opts.db, ...(opts.now ? { now: opts.now } : {}) });
  app.register(eventsRoutes, { db: opts.db });
  app.get("/health", async () => ({ ok: true }));
  return app;
}
