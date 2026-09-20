import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { makeTransitionEvent, type AuditEvent } from "@oncare/core";
import { requireRole } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import type { CameraState } from "../services/video";

export type QueueVisit = typeof t.visitSession.$inferSelect & { streaming: boolean; cameraState: CameraState | "unknown" };

export async function staffRoutes(app: FastifyInstance, opts: { db: Db; now?: () => Date }) {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());
  const staffOnly = { preHandler: requireRole("staff", "admin") };
  type Observation = {
    pending?: Promise<QueueVisit["cameraState"]>;
    result?: QueueVisit["cameraState"];
    observedAt: number;
    version: number;
  };
  const cameraLookups = new Map<string, Observation>();
  const unsubscribe = app.transitions.subscribe(event => {
    if (event.entityType !== "visit") return;
    // A camera action or lifecycle transition invalidates any older sample,
    // including an observation still in flight when the transition happened.
    for (const [key, observation] of cameraLookups) {
      if (key.startsWith(`${event.entityId}:`)) {
        observation.version += 1;
        delete observation.result;
      }
    }
  });
  app.addHook("onClose", async () => { unsubscribe(); cameraLookups.clear(); });
  async function observeCamera(visitId: string, deviceId: string): Promise<QueueVisit["cameraState"]> {
    const key = `${visitId}:${deviceId}`;
    let observation = cameraLookups.get(key);
    if (!observation) {
      observation = { observedAt: 0, version: 0 };
      cameraLookups.set(key, observation);
    }
    const entry = observation;
    if (!entry.pending) {
      const version = entry.version;
      entry.pending = Promise.resolve().then(() => app.video.cameraState(visitId, deviceId))
        .catch(() => "unknown" as const)
        .then(result => {
          if (cameraLookups.get(key) !== entry || entry.version !== version) return "unknown" as const;
          entry.result = result;
          entry.observedAt = Date.now();
          return result;
        })
        .finally(() => { delete entry.pending; });
    }
    // Media must not hold up physical controls. Keep the underlying lookup
    // shared until it settles, even after our observation budget expires.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([entry.pending, new Promise<QueueVisit["cameraState"]>(resolve => {
        // Let a slow completed sample reach the next poll, but never represent
        // a stale cached sample as the current camera state indefinitely.
        timer = setTimeout(() => resolve(Date.now() - entry.observedAt <= 6000 ? entry.result ?? "unknown" : "unknown"), 100);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }
  app.get("/queue", staffOnly, async (req, reply) => {
    const p = req.principal;
    const visible = new Set(app.access.residentIdsVisibleTo(p));
    const assistance = app.assistance.listForStaff(p);
    if (!assistance.ok) return reply.code(403).send({ error: assistance.error });
    const robot = p.facilityId ? db.select().from(t.robot).where(eq(t.robot.facilityId, p.facilityId)).get() : undefined;
    const visits = db.select().from(t.visitSession).all().filter(v => visible.has(v.residentId));
    const tasks = db.select().from(t.taskRequest).all().filter(k => visible.has(k.residentId));
    const observedKeys = new Set<string>();
    const activeVisits: QueueVisit[] = await Promise.all(visits.filter(v => ["connecting", "active", "ending"].includes(v.state)).map(async v => {
      const device = v.robotId && db.select().from(t.device).where(and(eq(t.device.robotId, v.robotId), eq(t.device.residentId, v.residentId))).get();
      let cameraState: QueueVisit["cameraState"] = "unavailable";
      if (device && v.state !== "ending") {
        observedKeys.add(`${v.id}:${device.id}`);
        cameraState = await observeCamera(v.id, device.id);
      }
      return { ...v, streaming: v.state === "connecting" || v.state === "active", cameraState };
    }));
    for (const [key, observation] of cameraLookups) {
      if (!observedKeys.has(key)) {
        observation.version += 1;
        delete observation.result;
        if (!observation.pending) cameraLookups.delete(key);
      }
    }
    return {
      visitsAwaitingApproval: visits.filter(v => v.state === "awaiting_policy_or_staff"),
      tasksAwaitingApproval: tasks.filter(k => k.state === "awaiting_policy_or_staff"),
      tasksAwaitingLoad: tasks.filter(k => k.state === "locating_item"),
      tasksAwaitingHandoff: tasks.filter(k => k.state === "placing"),
      assistanceRequests: assistance.requests,
      activeVisits,
      caregiverCalls: db.select().from(t.auditEvent).where(and(eq(t.auditEvent.reason, "call_caregiver"), gte(t.auditEvent.at, new Date(now().getTime() - 30 * 60_000).toISOString()))).orderBy(desc(t.auditEvent.at)).all().map(event => ({
        ...event,
        residentId: event.actorType === "device" ? db.select().from(t.device).where(eq(t.device.id, event.actorId)).get()?.residentId ?? null : null,
      })).filter(call => call.residentId === null || visible.has(call.residentId)),
      robot: robot ? { robotId: robot.id, ...app.hub.status(robot.id) } : null,
    };
  });
  app.get("/audit", staffOnly, async (req, reply) => {
    const parsed = z.object({ residentId: z.string().min(1).optional(), since: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    const q = parsed.data;
    const p = req.principal;
    const visible = new Set(app.access.residentIdsVisibleTo(p));
    if (q.residentId && !visible.has(q.residentId)) return reply.code(403).send({ error: "forbidden" });
    let rows = db.select().from(t.auditEvent).orderBy(desc(t.auditEvent.at), desc(t.auditEvent.id)).all()
      .filter(e => app.access.auditVisibleTo(p, e as AuditEvent, visible));
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
    const p = req.principal;
    if (!app.access.canAccessResident(p, id)) return reply.code(403).send({ error: "forbidden" });
    const resident = db.select().from(t.resident).where(eq(t.resident.id, id)).get()!;
    if (p.kind !== "user") return reply.code(403).send({ error: "forbidden" });
    const event = makeTransitionEvent({ actorType: p.role === "admin" ? "admin" : "staff", actorId: p.id, entityType: "resident", entityId: id, fromState: resident.availability, toState: parsed.data.availability, reason: "availability_changed", correlationId: id, now });
    db.transaction(tx => {
      tx.update(t.resident).set({ availability: parsed.data.availability }).where(eq(t.resident.id, id)).run();
      tx.insert(t.auditEvent).values(event).run();
    });
    app.transitions.emit(event);
    return { resident: { ...resident, availability: parsed.data.availability } };
  });
}
