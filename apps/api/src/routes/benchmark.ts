import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/plugin";
import type { Db } from "../db/client";

export async function benchmarkRoutes(app: FastifyInstance, opts: { db: Db; now?: () => Date }) {
  app.post("/device/screen-shown", { preHandler: requireRole("device") }, async (req, reply) => {
    if (req.principal.kind !== "device") return reply.code(403).send({ error: "forbidden" });
    const parsed = z.object({ screen: z.enum(["incoming", "delivery_arrived"]), entityId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    if (!app.benchmark.recordScreenShown(req.principal.id, parsed.data.screen, parsed.data.entityId, (opts.now ?? (() => new Date()))().toISOString())) {
      return reply.code(403).send({ error: "forbidden" });
    }
    return { ok: true };
  });

  app.get("/benchmark.csv", { preHandler: requireRole("staff") }, async (_req, reply) => {
    return reply.type("text/csv").send(app.benchmark.toCsv());
  });
}
