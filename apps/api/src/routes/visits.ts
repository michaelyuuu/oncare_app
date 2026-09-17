import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/plugin";

export async function visitRoutes(app: FastifyInstance) {
  app.post("/visits", { preHandler: requireRole("family") }, async (req, reply) => {
    const body = z.object({ residentId: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const p = req.principal;
    if (p.kind !== "user") return reply.code(403).send({ error: "forbidden" });
    const result = app.visits.create({ requesterId: p.id, residentId: body.data.residentId });
    if (!result.ok) return reply.code(result.error === "no_relationship" ? 403 : 409).send({ error: result.error });
    return reply.code(201).send({ visit: result.visit });
  });

  app.get("/visits/:id", { preHandler: requireRole("family", "staff", "device") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const visit = app.visits.get(id);
    if (!visit) return reply.code(404).send({ error: "not_found" });
    if (!app.visits.canView(req.principal, visit)) return reply.code(403).send({ error: "forbidden" });
    return { visit };
  });
}
