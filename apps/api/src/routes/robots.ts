import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireRole } from "../auth/plugin";
import { verifySecret } from "../auth/password";
import type { Db } from "../db/client";
import * as t from "../db/schema";

/** Staff-only controls for one robot: what it is doing, and the two safety buttons. */
export async function robotRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  const robotExists = (id: string) => db.select().from(t.robot).where(eq(t.robot.id, id)).get() !== undefined;

  app.get("/robots/:id/status", { preHandler: requireRole("staff") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!robotExists(id)) return reply.code(404).send({ error: "not_found" });
    return { robotId: id, ...app.hub.status(id) };
  });

  app.post("/robots/:id/stop", { preHandler: requireRole("staff") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    // A free-text `reason` may be sent for the operator's own notes, but it
    // never reaches the wire or the audit trail: both carry the fixed
    // `staff_stop` code, because audit reasons are codes, never prose.
    const body = z.object({ reason: z.string().min(1).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (!robotExists(id)) return reply.code(404).send({ error: "not_found" });
    const p = req.principal;
    if (p.kind !== "user") return reply.code(403).send({ error: "forbidden" });
    return { ok: true, delivered: app.dispatch.sendStop(id, p.id) };
  });

  app.post("/robots/:id/resume", { preHandler: requireRole("staff") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ pin: z.string().min(1) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (!robotExists(id)) return reply.code(404).send({ error: "not_found" });
    const p = req.principal;
    if (p.kind !== "user") return reply.code(403).send({ error: "forbidden" });
    // The PIN is the caller's own second factor: a resume is a decision that
    // the area is clear, so it is checked against the staff member pressing
    // the button, never against a shared code.
    const user = db.select().from(t.user).where(eq(t.user.id, p.id)).get();
    if (!user?.pinHash || !(await verifySecret(body.data.pin, user.pinHash))) {
      app.dispatch.auditRobot(id, p.id, "staff_resume_failed");
      return reply.code(401).send({ error: "invalid_pin" });
    }
    return { ok: true, delivered: app.dispatch.sendResume(id, p.id) };
  });
}
