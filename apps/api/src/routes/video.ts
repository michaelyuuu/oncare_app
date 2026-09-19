import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { makeTransitionEvent } from "@oncare/core";
import type { FastifyInstance } from "fastify";
import { requireRole } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import { actionRole } from "../services/access";
import { grantsFor } from "../services/video";

const TOKEN_TTL_SECONDS = 600;

export async function videoRoutes(app: FastifyInstance, opts: { db: Db; now?: () => Date }) {
  const { db } = opts;

  app.post("/visits/:id/camera", { preHandler: requireRole("staff") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ paused: z.boolean() }).strict().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    const visit = app.visits.get(id);
    if (!visit) return reply.code(404).send({ error: "not_found" });
    if (!["connecting", "active"].includes(visit.state)) return reply.code(409).send({ error: "not_callable" });
    const device = visit.robotId && db.select().from(t.device).where(and(eq(t.device.robotId, visit.robotId), eq(t.device.residentId, visit.residentId))).get();
    if (!device) return reply.code(409).send({ error: "camera_unavailable" });
    const p = req.principal;
    if (p.kind !== "user") return reply.code(403).send({ error: "forbidden" });
    let cameraState;
    try { cameraState = await app.video.setCameraPaused(id, device.id, parsed.data.paused); }
    catch { return reply.code(503).send({ error: "camera_control_failed" }); }
    if (cameraState === "unavailable") return reply.code(409).send({ error: "camera_unavailable" });
    if (cameraState !== (parsed.data.paused ? "paused" : "on")) return reply.code(503).send({ error: "camera_control_failed" });
    if (!["connecting", "active"].includes(app.visits.get(id)?.state ?? "")) return reply.code(409).send({ error: "not_callable" });
    const event = makeTransitionEvent({ actorType: "staff", actorId: p.id, entityType: "visit", entityId: id, fromState: null, toState: null, reason: parsed.data.paused ? "staff_camera_paused" : "staff_camera_resumed", correlationId: id, ...(opts.now ? { now: opts.now } : {}) });
    db.insert(t.auditEvent).values(event).run();
    app.transitions.emit(event);
    return { ok: true, cameraState };
  });

  app.post("/visits/:id/token", { preHandler: requireRole("family", "staff", "device") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const visit = app.visits.get(id);
    if (!visit) return reply.code(404).send({ error: "not_found" });
    if (!app.visits.canView(req.principal, visit)) return reply.code(403).send({ error: "forbidden" });

    const principal = req.principal;
    const role = actionRole(principal);
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
