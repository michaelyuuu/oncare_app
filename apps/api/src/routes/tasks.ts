import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/plugin";
import { TASK_ACTIONS, type TaskAction } from "../services/tasks";

export async function taskRoutes(app: FastifyInstance) {
  app.post("/tasks", { preHandler: requireRole("family") }, async (req, reply) => {
    const body = z.object({
      residentId: z.string().min(1),
      text: z.string().trim().min(1).max(500),
      visitId: z.string().min(1).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const principal = req.principal;
    if (principal.kind !== "user") return reply.code(403).send({ error: "forbidden" });
    const result = app.tasks.create({
      requesterId: principal.id,
      residentId: body.data.residentId,
      text: body.data.text,
      ...(body.data.visitId ? { visitId: body.data.visitId } : {}),
    });
    if (!result.ok) return reply.code(result.error === "no_relationship" ? 403 : 409).send({ error: result.error });
    return result.outcome;
  });

  app.get("/tasks/:id", { preHandler: requireRole("family", "staff", "admin", "device") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = app.tasks.get(id);
    if (!task) return reply.code(404).send({ error: "not_found" });
    if (!app.tasks.canView(req.principal, task)) return reply.code(403).send({ error: "forbidden" });
    return { task };
  });

  app.post("/tasks/:id/:action", { preHandler: requireRole("family", "staff", "admin", "device") }, async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string };
    if (!TASK_ACTIONS.includes(action as TaskAction)) return reply.code(404).send({ error: "not_found" });
    const result = app.tasks.act({ taskId: id, action: action as TaskAction, principal: req.principal });
    if (!result.ok) {
      const status = result.error === "not_found" ? 404 : result.error === "forbidden" ? 403 : 409;
      return reply.code(status).send({ error: result.error, ...(result.detail ? { detail: result.detail } : {}) });
    }
    return { task: result.task };
  });
}
