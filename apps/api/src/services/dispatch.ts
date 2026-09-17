import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { GatewayUp, Intent } from "@oncare/contracts";
import { REASON_CODE, makeTransitionEvent, type AuditEvent, type VisitState } from "@oncare/core";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import type { GatewayHub } from "./gateway-hub";
import { TransitionError } from "./transitions";
import type { TransitionService } from "./visits";

const STATE_EVENT_TO_VISIT: Partial<Record<string, VisitState>> = {
  arrived: "awaiting_resident_consent",
  navigation_failed: "navigation_failed",
  safety_stopped: "safety_stopped",
  cancelled: "cancelled",
  expired: "robot_unavailable",
};

export function createDispatchService(db: Db, transitions: TransitionService, hub: GatewayHub,
  opts: { now?: () => Date; id?: () => string; intentTtlMs?: number } = {}) {
  const now = opts.now ?? (() => new Date());
  const id = opts.id ?? (() => `cmd_${randomUUID()}`);
  const ttl = opts.intentTtlMs ?? 120_000;

  function robotApply(robotId: string, visitId: string, to: VisitState, reason?: string) {
    try {
      transitions.apply({ entityType: "visit", entityId: visitId, to, actorType: "robot", actorId: robotId, ...(reason ? { reason } : {}) });
    } catch (e) {
      if (!(e instanceof TransitionError)) throw e; // rejected_transition already audited
    }
  }

  function onVisitAccepted(ev: AuditEvent) {
    const visit = db.select().from(t.visitSession).where(eq(t.visitSession.id, ev.entityId)).get();
    if (!visit?.robotId) return;
    const resident = db.select().from(t.resident).where(eq(t.resident.id, visit.residentId)).get();
    if (!resident) return;
    const issuedAt = now();
    const intent: Intent = {
      type: "intent", intent: "request_visit", correlationId: visit.id,
      expiresAt: new Date(issuedAt.getTime() + ttl).toISOString(), payload: { locationId: resident.roomLocationId },
    };
    db.insert(t.robotCommand).values({ id: id(), robotId: visit.robotId, visitId: visit.id, taskId: null, intent, issuedAt: issuedAt.toISOString(), expiresAt: intent.expiresAt, ackedAt: null, result: null }).run();
    hub.send(visit.robotId, intent);
  }

  function onVisitCancelled(ev: AuditEvent) {
    const cmd = db.select().from(t.robotCommand).where(eq(t.robotCommand.visitId, ev.entityId)).get();
    if (!cmd || cmd.result === "expired" || cmd.result === "rejected" || cmd.result === "busy") return;
    hub.send(cmd.robotId, { type: "cancel", correlationId: ev.entityId });
  }

  const unsubTransitions = transitions.subscribe((ev) => {
    if (ev.entityType !== "visit") return;
    if (ev.toState === "accepted") onVisitAccepted(ev);
    if (ev.toState === "cancelled") onVisitCancelled(ev);
  });

  /** The robot's own diagnostic code, kept only when it is a real reason code. */
  function reasonCode(value: unknown): string | undefined {
    return typeof value === "string" && REASON_CODE.test(value) ? value : undefined;
  }

  /**
   * A message we have no command row for: the robot and this API disagree about
   * what is in flight (an intent issued by a previous process, a replayed
   * message, a bug). Record it against the robot so staff can see it, rather
   * than dropping it silently.
   */
  function auditUnknownCorrelation(robotId: string, correlationId: string) {
    const ev = makeTransitionEvent({
      actorType: "robot", actorId: robotId, entityType: "robot", entityId: robotId,
      fromState: null, toState: null, reason: "unknown_correlation", correlationId, now,
    });
    db.insert(t.auditEvent).values(ev).run();
    transitions.emit(ev);
  }

  function onUp(robotId: string, msg: GatewayUp) {
    if (msg.type === "heartbeat") return;
    const cmd = db.select().from(t.robotCommand).where(and(eq(t.robotCommand.robotId, robotId), eq(t.robotCommand.visitId, msg.correlationId))).get();
    if (!cmd) { auditUnknownCorrelation(robotId, msg.correlationId); return; }
    if (!cmd.visitId) return;   // Plan 5 adds the task analogue
    if (msg.type === "ack") {
      // The first ack settles the command. A later one (a duplicate the robot
      // sends after a re-flush, or a stray retry) must never overwrite the
      // recorded outcome, nor drive a second visit transition off it.
      if (cmd.result !== null) return;
      db.update(t.robotCommand).set({ ackedAt: now().toISOString(), result: msg.result }).where(eq(t.robotCommand.id, cmd.id)).run();
      if (msg.result === "accepted") robotApply(robotId, cmd.visitId, "robot_en_route");
      else if (msg.result !== "duplicate") robotApply(robotId, cmd.visitId, "robot_unavailable", reasonCode(msg.reason) ?? msg.result);
      return;
    }
    const to = STATE_EVENT_TO_VISIT[msg.event];
    if (!to) return;
    const visit = db.select().from(t.visitSession).where(eq(t.visitSession.id, cmd.visitId)).get();
    if (to === "cancelled" && visit?.state === "cancelled") return;
    robotApply(robotId, cmd.visitId, to, reasonCode(msg.detail?.["reason"]) ?? msg.event);
  }
  const unsubHub = hub.onUp(onUp);

  function flushPending(robotId: string): number {
    const nowIso = now().toISOString();
    const pending = db.select().from(t.robotCommand).where(and(eq(t.robotCommand.robotId, robotId), isNull(t.robotCommand.ackedAt))).all()
      .filter((c) => c.expiresAt > nowIso);
    let n = 0;
    for (const c of pending) if (hub.send(robotId, c.intent as Intent)) n++;
    return n;
  }

  return { flushPending, stop() { unsubTransitions(); unsubHub(); } };
}
