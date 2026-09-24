import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/plugin";
import { ASSISTANCE_CATEGORIES, STAFF_ASSISTANCE_ACTIONS, type StaffAssistanceAction } from "../services/assistance";

const createBody = z.object({
  category: z.enum(ASSISTANCE_CATEGORIES),
  note: z.string().trim().min(1).max(500).optional(),
}).strict();

const versionBody = z.object({ version: z.number().int().positive() }).strict();

function failureStatus(error: string): number {
  if (error === "not_found") return 404;
  if (error === "forbidden") return 403;
  if (error === "invalid_transition" || error === "version_conflict" || error === "idempotency_conflict") return 409;
  return 400;
}

export async function assistanceRoutes(app: FastifyInstance) {
  app.post("/assistance-requests", { preHandler: requireRole("device") }, async (req, reply) => {
    const body = createBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const header = req.headers["idempotency-key"];
    const idempotencyKey = typeof header === "string" ? header.trim() : "";
    if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: "bad_request" });
    const result = app.assistance.create({
      principal: req.principal,
      category: body.data.category,
      note: body.data.note ?? null,
      idempotencyKey,
    });
    if (!result.ok) return reply.code(failureStatus(result.error)).send({ error: result.error });
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });

  app.get("/assistance-requests/:id", { preHandler: requireRole("device", "staff", "admin") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const request = app.assistance.get(id);
    if (!request) return reply.code(404).send({ error: "not_found" });
    if (!app.assistance.canView(req.principal, request)) return reply.code(403).send({ error: "forbidden" });
    return { request };
  });

  app.post("/assistance-requests/:id/withdrawal", { preHandler: requireRole("device") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = versionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const result = app.assistance.requestWithdrawal({ requestId: id, principal: req.principal, version: body.data.version });
    if (!result.ok) return reply.code(failureStatus(result.error)).send({ error: result.error });
    return { request: result.request };
  });

  app.get("/staff/assistance-requests", { preHandler: requireRole("staff", "admin") }, async (req, reply) => {
    const query = z.object({ residentId: z.string().min(1).optional() }).strict().safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "bad_request" });
    const result = app.assistance.listForStaff(req.principal, query.data.residentId ? { residentId: query.data.residentId } : {});
    if (!result.ok) return reply.code(failureStatus(result.error)).send({ error: result.error });
    return result;
  });

  app.post("/staff/assistance-requests/:id/:action", { preHandler: requireRole("staff", "admin") }, async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string };
    if (!STAFF_ASSISTANCE_ACTIONS.includes(action as StaffAssistanceAction)) return reply.code(404).send({ error: "not_found" });
    const body = versionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const result = app.assistance.act({
      requestId: id,
      principal: req.principal,
      action: action as StaffAssistanceAction,
      version: body.data.version,
    });
    if (!result.ok) return reply.code(failureStatus(result.error)).send({ error: result.error });
    return { request: result.request };
  });
}
