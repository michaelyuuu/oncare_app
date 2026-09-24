import type { FastifyInstance, FastifyReply } from "fastify";
import { requireRole } from "../auth/plugin";
import type { ToolResult } from "../tools/registry";

function send(reply: FastifyReply, r: ToolResult) {
  if (!r.ok) return reply.code(r.status).send({ error: r.error, ...(r.detail !== undefined ? { detail: r.detail } : {}) });
  const { ok: _ok, ...body } = r;
  return body;
}

export async function toolRoutes(app: FastifyInstance) {
  const anyone = { preHandler: requireRole("family", "staff", "admin", "device") };
  app.get("/tools", anyone, async (req) => ({ tools: app.tools.list(req.principal) }));
  app.post("/tools/:name/invoke", anyone, async (req, reply) => {
    const { name } = req.params as { name: string };
    return send(reply, await app.tools.invoke(req.principal, name, req.body));
  });
  app.post("/tools/actions/:id/confirm", anyone, async (req, reply) => {
    const { id } = req.params as { id: string };
    return send(reply, await app.tools.confirm(req.principal, id));
  });
  app.post("/tools/actions/:id/cancel", anyone, async (req, reply) => {
    const { id } = req.params as { id: string };
    return send(reply, app.tools.cancel(req.principal, id));
  });
}
