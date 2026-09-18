import type { FastifyInstance } from "fastify";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { z } from "zod";
import { TASK_TERMINAL_STATES, VISIT_TERMINAL_STATES, makeTransitionEvent } from "@oncare/core";
import { requireRole } from "../auth/plugin";
import { verifySecret } from "../auth/password";
import type { Db } from "../db/client";
import * as t from "../db/schema";

export type DeviceScreen = "home" | "incoming" | "in_call" | "delivery_arrived";

export function screenForVisitState(state: string | null): DeviceScreen {
  if (state === "awaiting_resident_consent") return "incoming";
  if (state === "connecting" || state === "active" || state === "ending") return "in_call";
  return "home";
}

export async function deviceRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  function audit(deviceId: string, robotId: string, reason: string) {
    db.insert(t.auditEvent).values(makeTransitionEvent({
      actorType: "device", actorId: deviceId, entityType: "robot", entityId: robotId,
      fromState: null, toState: null, reason, correlationId: deviceId,
    })).run();
  }

  app.get("/device/state", { preHandler: requireRole("device") }, async (req) => {
    const principal = req.principal;
    if (principal.kind !== "device") return { error: "forbidden" };

    const resident = db.select().from(t.resident).where(eq(t.resident.id, principal.residentId)).get()!;
    const visit = db.select().from(t.visitSession)
      .where(and(
        eq(t.visitSession.residentId, principal.residentId),
        notInArray(t.visitSession.state, [...VISIT_TERMINAL_STATES]),
      ))
      .orderBy(desc(t.visitSession.requestedAt))
      .get() ?? null;
    const caller = visit
      ? db.select({ displayName: t.user.displayName }).from(t.user).where(eq(t.user.id, visit.requesterId)).get() ?? null
      : null;
    const task = db.select().from(t.taskRequest)
      .where(and(
        eq(t.taskRequest.residentId, principal.residentId),
        notInArray(t.taskRequest.state, [...TASK_TERMINAL_STATES]),
      ))
      .orderBy(desc(t.taskRequest.createdAt))
      .get() ?? null;
    const itemId = task ? (task.proposal as { item: string }).item : null;
    const item = itemId ? db.select().from(t.item).where(eq(t.item.id, itemId)).get() ?? null : null;
    const status = app.hub.status(principal.robotId);
    const visitScreen = screenForVisitState(visit?.state ?? null);
    const screen = visitScreen !== "home" ? visitScreen : task?.state === "placing" ? "delivery_arrived" : "home";

    return {
      resident: { id: resident.id, displayName: resident.displayName },
      screen,
      visit,
      caller,
      task: task ? { id: task.id, state: task.state, item: { id: item?.id ?? "", label: item?.label ?? "" } } : null,
      robot: { adapter: status.lastHeartbeat?.adapter ?? null, connected: status.connected },
    };
  });

  app.post("/device/call-caregiver", { preHandler: requireRole("device") }, async (req) => {
    const principal = req.principal;
    if (principal.kind !== "device") return { error: "forbidden" };
    audit(principal.id, principal.robotId, "call_caregiver");
    return { ok: true };
  });

  app.post("/device/unlock", { preHandler: requireRole("device") }, async (req, reply) => {
    const principal = req.principal;
    if (principal.kind !== "device") return reply.code(403).send({ error: "forbidden" });
    const body = z.object({ pin: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });

    const staff = db.select().from(t.user).where(eq(t.user.role, "staff")).all();
    for (const user of staff) {
      if (user.pinHash && await verifySecret(body.data.pin, user.pinHash)) {
        audit(principal.id, principal.robotId, "device_unlock");
        return { ok: true };
      }
    }

    audit(principal.id, principal.robotId, "device_unlock_failed");
    return reply.code(401).send({ error: "invalid_pin" });
  });
}
