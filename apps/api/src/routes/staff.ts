import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { makeTransitionEvent } from "@oncare/core";
import { requireRole } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import type { CameraState } from "../services/video";

export type QueueVisit = typeof t.visitSession.$inferSelect & { streaming: boolean; cameraState: CameraState | "unknown" };

export async function staffRoutes(app: FastifyInstance, opts: { db: Db; now?: () => Date }) {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());
  const staffOnly = { preHandler: requireRole("staff") };
  app.get("/queue", staffOnly, async () => {
    const robot = db.select().from(t.robot).get();
    const visits = db.select().from(t.visitSession).all();
    const tasks = db.select().from(t.taskRequest).all();
    const activeVisits: QueueVisit[] = await Promise.all(visits.filter(v => ["connecting", "active", "ending"].includes(v.state)).map(async v => {
      const device = v.robotId && db.select().from(t.robotDevice).where(and(eq(t.robotDevice.robotId, v.robotId), eq(t.robotDevice.residentId, v.residentId))).get();
      let cameraState: QueueVisit["cameraState"] = "unavailable";
      if (device && v.state !== "ending") {
        try { cameraState = await app.video.cameraState(v.id, device.id); }
        catch { cameraState = "unknown"; }
      }
      return { ...v, streaming: v.state === "connecting" || v.state === "active", cameraState };
    }));
    return {
      visitsAwaitingApproval: visits.filter(v => v.state === "awaiting_policy_or_staff"),
      tasksAwaitingApproval: tasks.filter(k => k.state === "awaiting_policy_or_staff"),
      tasksAwaitingLoad: tasks.filter(k => k.state === "locating_item"),
      tasksAwaitingHandoff: tasks.filter(k => k.state === "placing"),
      activeVisits,
      caregiverCalls: db.select().from(t.auditEvent).where(and(eq(t.auditEvent.reason, "call_caregiver"), gte(t.auditEvent.at, new Date(now().getTime() - 30 * 60_000).toISOString()))).orderBy(desc(t.auditEvent.at)).all(),
      robot: robot ? { robotId: robot.id, ...app.hub.status(robot.id) } : null,
    };
  });
  app.get("/audit", staffOnly, async (req, reply) => {
    const parsed = z.object({ residentId: z.string().min(1).optional(), since: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    const q = parsed.data;
    let rows = db.select().from(t.auditEvent).orderBy(desc(t.auditEvent.at), desc(t.auditEvent.id)).all();
    if (q.since) rows = rows.filter(e => Date.parse(e.at) >= Date.parse(q.since!));
    if (q.residentId) {
      const visits = new Set(db.select().from(t.visitSession).where(eq(t.visitSession.residentId, q.residentId)).all().map(v => v.id));
      const tasks = new Set(db.select().from(t.taskRequest).where(eq(t.taskRequest.residentId, q.residentId)).all().map(k => k.id));
      rows = rows.filter(e => (e.entityType === "resident" && e.entityId === q.residentId) || (e.entityType === "visit" && visits.has(e.entityId)) || (e.entityType === "task" && tasks.has(e.entityId)));
    }
    return { events: rows.slice(0, q.limit) };
  });
  app.patch("/residents/:id/availability", staffOnly, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ availability: z.enum(["available", "in_activity", "resting", "not_available"]) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    const resident = db.select().from(t.resident).where(eq(t.resident.id, id)).get();
    if (!resident) return reply.code(404).send({ error: "not_found" });
    const p = req.principal;
    if (p.kind !== "user") return reply.code(403).send({ error: "forbidden" });
    const event = makeTransitionEvent({ actorType: "staff", actorId: p.id, entityType: "resident", entityId: id, fromState: resident.availability, toState: parsed.data.availability, reason: "availability_changed", correlationId: id, now });
    db.transaction(tx => {
      tx.update(t.resident).set({ availability: parsed.data.availability }).where(eq(t.resident.id, id)).run();
      tx.insert(t.auditEvent).values(event).run();
    });
    app.transitions.emit(event);
    return { resident: { ...resident, availability: parsed.data.availability } };
  });
}
