import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/plugin";

const bodySchema = z.object({
  question: z.string().trim().min(1).max(500),
}).strict();

export async function laundryAssistantRoutes(app: FastifyInstance) {
  app.post("/admin/laundry/ask", { preHandler: requireRole("admin") }, async (req, reply) => {
    const body = bodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_input" });
    try {
      return await app.laundryAssistant.ask(req.principal, body.data.question);
    } catch {
      return reply.code(503).send({ error: "assistant_unavailable" });
    }
  });
}
