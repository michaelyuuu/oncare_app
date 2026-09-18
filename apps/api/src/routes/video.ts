import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireRole } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import { grantsFor } from "../services/video";

const TOKEN_TTL_SECONDS = 600;

export async function videoRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  app.post("/visits/:id/token", { preHandler: requireRole("family", "staff", "device") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const visit = app.visits.get(id);
    if (!visit) return reply.code(404).send({ error: "not_found" });
    if (!app.visits.canView(req.principal, visit)) return reply.code(403).send({ error: "forbidden" });

    const principal = req.principal;
    const role = principal.kind === "device" ? "device" : principal.role;
    const callable = role === "device"
      ? ["awaiting_resident_consent", "connecting", "active"].includes(visit.state)
      : ["connecting", "active"].includes(visit.state);
    if (!callable) return reply.code(409).send({ error: "not_callable" });

    const name = principal.kind === "device"
      ? db.select({ name: t.resident.displayName }).from(t.resident).where(eq(t.resident.id, principal.residentId)).get()?.name ?? "Resident"
      : db.select({ name: t.user.displayName }).from(t.user).where(eq(t.user.id, principal.id)).get()?.name ?? role;
    const token = await app.video.issueToken({
      room: visit.id,
      identity: principal.id,
      name,
      ...grantsFor(role),
      ttlSeconds: TOKEN_TTL_SECONDS,
    });
    return { url: app.video.url, token, room: visit.id };
  });
}
