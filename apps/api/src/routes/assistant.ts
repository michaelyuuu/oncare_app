import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/plugin";

const emptyBody = z.object({}).strict();

function sendFailure(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, result: { ok: false; status: number; error: string }) {
  return reply.code(result.status).send({ error: result.error });
}

export async function assistantRoutes(app: FastifyInstance) {
  app.post("/assistant/sessions", { preHandler: requireRole("device") }, async (req, reply) => {
    const body = z.object({ mode: z.enum(["simulated", "live"]).optional() }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const result = app.assistant.start(req.principal, body.data.mode ?? "simulated");
    if (!result.ok) return sendFailure(reply, result);
    return reply.code(201).send({ session: result.session });
  });

  app.post("/assistant/sessions/:id/input", { preHandler: requireRole("device") }, async (req, reply) => {
    const body = z.object({ text: z.string().trim().min(1).max(4000) }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const { id } = req.params as { id: string };
    const result = await app.assistant.input(req.principal, id, body.data.text);
    if (!result.ok) return sendFailure(reply, result);
    return { session: result.session, result: result.result };
  });

  app.post("/assistant/sessions/:id/interrupt", { preHandler: requireRole("device") }, async (req, reply) => {
    if (!emptyBody.safeParse(req.body).success) return reply.code(400).send({ error: "bad_request" });
    const { id } = req.params as { id: string };
    const result = app.assistant.interrupt(req.principal, id);
    if (!result.ok) return sendFailure(reply, result);
    return { session: result.session };
  });

  app.post("/assistant/sessions/:id/close", { preHandler: requireRole("device") }, async (req, reply) => {
    if (!emptyBody.safeParse(req.body).success) return reply.code(400).send({ error: "bad_request" });
    const { id } = req.params as { id: string };
    const result = app.assistant.close(req.principal, id);
    if (!result.ok) return sendFailure(reply, result);
    return { session: result.session };
  });

  app.post("/assistant/realtime/calls", { preHandler: requireRole("device") }, async (req, reply) => {
    const body = z.object({ sdp: z.string().min(1), sessionId: z.string().min(1).optional() }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const result = await app.assistant.createRealtimeCall(
      req.principal,
      body.data.sdp,
      body.data.sessionId,
    );
    if (!result.ok) return sendFailure(reply, result);
    return reply.code(201).send({ session: result.session, sdp: result.sdp });
  });

  app.get("/assistant/realtime/sessions/:id", { preHandler: requireRole("device") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = app.assistant.getRealtimeSession(req.principal, id);
    if (!result.ok) return sendFailure(reply, result);
    return { session: result.session };
  });

  app.post("/assistant/realtime/sessions/:id/tool", { preHandler: requireRole("device") }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(1),
      arguments: z.record(z.unknown()),
    }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const { id } = req.params as { id: string };
    const result = await app.assistant.relayTool(req.principal, id, body.data.name, body.data.arguments);
    if (!result.ok) return sendFailure(reply, result);
    return { result: result.result, session: result.session };
  });
}
