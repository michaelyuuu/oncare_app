import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/plugin";
import { VISIT_ACTIONS, type VisitAction } from "../services/visits";

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
    return { visit: { ...visit, simulated: app.hub.status(visit.robotId ?? "").lastHeartbeat?.adapter === "mock" } };
  });

  app.post("/visits/:id/:action", { preHandler: requireRole("family", "staff", "device") }, async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string };
    if (!(VISIT_ACTIONS as string[]).includes(action)) return reply.code(404).send({ error: "not_found" });
    const result = app.visits.act({ visitId: id, action: action as VisitAction, principal: req.principal });
    if (!result.ok) {
      const status = result.error === "not_found" ? 404 : result.error === "forbidden" ? 403 : 409;
      return reply.code(status).send({ error: result.error, ...(result.detail ? { detail: result.detail } : {}) });
    }
    return { visit: result.visit };
  });
}
