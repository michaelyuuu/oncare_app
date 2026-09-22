import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { GatewayUp, Intent } from "@oncare/contracts";
import { REASON_CODE, TASK_TERMINAL_STATES, VISIT_TERMINAL_STATES, makeTransitionEvent, type ActorType, type AuditEvent, type TaskState, type VisitState } from "@oncare/core";
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
const STATE_EVENT_TO_TASK: Partial<Record<string, TaskState>> = {
  arrived_pickup: "locating_item",
  arrived_delivery: "placing",
  navigation_failed: "navigation_failed",
  safety_stopped: "safety_stopped",
  cancelled: "cancelled",
  expired: "operator_required",
  completed_leg: "completed",
};

export function createDispatchService(db: Db, transitions: TransitionService, hub: GatewayHub,
  opts: { now?: () => Date; id?: () => string; intentTtlMs?: number } = {}) {
  const now = opts.now ?? (() => new Date());
  const id = opts.id ?? (() => `cmd_${randomUUID()}`);
  const ttl = opts.intentTtlMs ?? 120_000;

  function applyQuietly(input: { entityType: "visit" | "task"; entityId: string; to: VisitState | TaskState; actorType: ActorType; actorId: string; reason?: string }) {
    try {
      transitions.apply({
        entityType: input.entityType, entityId: input.entityId, to: input.to, actorType: input.actorType, actorId: input.actorId,
        ...(input.reason ? { reason: input.reason } : {}),
      });
    } catch (e) {
      if (!(e instanceof TransitionError)) throw e; // rejected_transition already audited
    }
  }

  function robotApply(robotId: string, entityType: "visit" | "task", entityId: string, to: VisitState | TaskState, reason?: string) {
    applyQuietly({ entityType, entityId, to, actorType: "robot", actorId: robotId, ...(reason ? { reason } : {}) });
  }

  function onVisitAccepted(ev: AuditEvent) {
    ensureVisitCommand(ev.entityId);
  }

  function ensureVisitCommand(visitId: string) {
    // Serialize the command claim across listeners, recovery ticks and API
    // workers. An existing command retains its identity and original expiry;
    // pending transport delivery uses the gateway's existing flush/replay path.
    const claimed = db.transaction((tx) => {
      const visit = tx.select().from(t.visitSession).where(eq(t.visitSession.id, visitId)).get();
      if (!visit?.robotId || visit.state !== "accepted") return;
      const existing = tx.select().from(t.robotCommand).where(eq(t.robotCommand.visitId, visitId)).get();
      if (existing) return { command: existing, created: false };
      const resident = tx.select().from(t.resident).where(eq(t.resident.id, visit.residentId)).get();
      if (!resident) return;
      const issuedAt = now();
      const intent: Intent = {
        type: "intent", intent: "request_visit", correlationId: visit.id,
        expiresAt: new Date(issuedAt.getTime() + ttl).toISOString(), payload: { locationId: resident.roomLocationId },
      };
      // Preserve refusal when the robot has explicitly reported it is unsafe.
      const result = hub.status(visit.robotId).lastHeartbeat?.robotReady === false ? "robot_not_ready" : null;
      const command = { id: id(), robotId: visit.robotId, visitId, taskId: null, correlationId: visitId,
        intent, issuedAt: issuedAt.toISOString(), expiresAt: intent.expiresAt, ackedAt: null, result };
      tx.insert(t.robotCommand).values(command).run();
      return { command, created: true };
    }, { behavior: "immediate" });
    if (!claimed) return;
    const { command, created } = claimed;
    if (command.result === "robot_not_ready") {
      applyQuietly({ entityType: "visit", entityId: visitId, to: "robot_unavailable", actorType: "system", actorId: "api", reason: "robot_not_ready" });
      return;
    }
    if (created) hub.send(command.robotId, command.intent as Intent);
  }

  function onTaskQueued(ev: AuditEvent) {
    const task = db.select().from(t.taskRequest).where(eq(t.taskRequest.id, ev.entityId)).get();
    const robot = db.select().from(t.robot).get();
    const resident = task && db.select().from(t.resident).where(eq(t.resident.id, task.residentId)).get();
    const pickup = db.select().from(t.location).where(and(eq(t.location.kind, "pickup_station"), eq(t.location.approved, true))).get();
    const standby = db.select().from(t.location).where(and(eq(t.location.kind, "standby"), eq(t.location.approved, true))).get();
    if (!task || !robot || !resident || !pickup || !standby) return;
    const issuedAt = now();
    const intent: Intent = { type: "intent", intent: "deliver_item", correlationId: task.correlationId, expiresAt: new Date(issuedAt.getTime() + ttl).toISOString(), payload: { itemId: task.proposal.item, pickupLocationId: pickup.id, destinationLocationId: resident.roomLocationId, standbyLocationId: standby.id, mode: task.mode } };
    if (hub.status(robot.id).lastHeartbeat?.robotReady === false) {
      db.insert(t.robotCommand).values({ id: id(), robotId: robot.id, visitId: null, taskId: task.id, correlationId: task.correlationId, intent, issuedAt: issuedAt.toISOString(), expiresAt: intent.expiresAt, ackedAt: null, result: "robot_not_ready" }).run();
      applyQuietly({ entityType: "task", entityId: task.id, to: "operator_required", actorType: "system", actorId: "api", reason: "robot_not_ready" });
      return;
    }
    db.insert(t.robotCommand).values({ id: id(), robotId: robot.id, visitId: null, taskId: task.id, correlationId: task.correlationId, intent, issuedAt: issuedAt.toISOString(), expiresAt: intent.expiresAt, ackedAt: null, result: null }).run();
    hub.send(robot.id, intent);
  }

  function onCancelled(ev: AuditEvent) {
    // The robot told us it cancelled: it does not need to be told back.
    if (ev.actorType === "robot") return;
    const correlationId = ev.entityType === "task"
      ? db.select().from(t.taskRequest).where(eq(t.taskRequest.id, ev.entityId)).get()?.correlationId
      : ev.entityId;
    if (!correlationId) return;
    cancelCommand(correlationId);
  }

  function cancelCommand(correlationId: string) {
    const cmd = db.select().from(t.robotCommand).where(eq(t.robotCommand.correlationId, correlationId)).get();
    if (!cmd || ["expired", "rejected", "busy", "stale", "cancelled"].includes(cmd.result ?? "")) return;
    // Settle before transport I/O: an offline or broken connection must not
    // leave a cancelled command available for replay or block the safety exit.
    if (cmd.result === null || cmd.result === "accepted") {
      db.update(t.robotCommand).set({ result: "cancelled" }).where(eq(t.robotCommand.id, cmd.id)).run();
    }
    try { hub.send(cmd.robotId, { type: "cancel", correlationId }); }
    catch { /* The local safety decision remains effective if delivery fails. */ }
  }

  const unsubTransitions = transitions.subscribe((ev) => {
    if (ev.entityType === "visit" && ev.toState === "accepted") onVisitAccepted(ev);
    if (ev.entityType === "task" && ev.toState === "queued") onTaskQueued(ev);
    if ((ev.entityType === "visit" || ev.entityType === "task") && ev.toState === "cancelled") onCancelled(ev);
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
  /**
   * Record something that happened to the robot itself rather than to a visit.
   * These rows are not state transitions, so they cannot go through
   * `transitions.apply`: write the row, then fan it out by hand.
   */
  function auditRobotEvent(input: { robotId: string; actorType: ActorType; actorId: string; reason: string; correlationId?: string }): AuditEvent {
    const ev = makeTransitionEvent({
      actorType: input.actorType, actorId: input.actorId, entityType: "robot", entityId: input.robotId,
      fromState: null, toState: null, reason: input.reason, correlationId: input.correlationId ?? input.robotId, now,
    });
    db.insert(t.auditEvent).values(ev).run();
    transitions.emit(ev);
    return ev;
  }

  function auditUnknownCorrelation(robotId: string, correlationId: string) {
    auditRobotEvent({ robotId, actorType: "robot", actorId: robotId, reason: "unknown_correlation", correlationId });
  }

  /** Staff-facing audit hook for actions that never reach the robot (e.g. a refused PIN). */
  function auditRobot(robotId: string, actorId: string, reason: string): void {
    auditRobotEvent({ robotId, actorType: "staff", actorId, reason });
  }

  /** Pending acknowledgements and the delivery return leg still occupy the robot. */
  function activeCommands(robotId: string) {
    return db.select().from(t.robotCommand).where(eq(t.robotCommand.robotId, robotId)).all().filter(c => {
      if (c.result !== null && c.result !== "accepted") return false;
      if (c.taskId) {
        const task = db.select().from(t.taskRequest).where(eq(t.taskRequest.id, c.taskId)).get();
        return !!task && !(TASK_TERMINAL_STATES as readonly string[]).includes(task.state);
      }
      if (c.visitId) {
        const visit = db.select().from(t.visitSession).where(eq(t.visitSession.id, c.visitId)).get();
        return !!visit && !(VISIT_TERMINAL_STATES as readonly string[]).includes(visit.state);
      }
      return c.intent.intent === "go_to_location";
    });
  }

  /**
   * Staff pressed stop. The robot is told to stop and the visit it is driving
   * is safety-stopped whether or not the message got through: the stop is a
   * decision about the visit, and `delivered` only reports whether the robot
   * was reachable.
   */
  function sendStop(robotId: string, actorId: string): boolean {
    const delivered = hub.send(robotId, { type: "stop", reason: "staff_stop" });
    const commands = activeCommands(robotId);
    for (const c of commands) {
      // Settle before emitting transitions so no listener can replay a pending intent.
      db.update(t.robotCommand).set({ result: "safety_stopped" }).where(eq(t.robotCommand.id, c.id)).run();
      if (c.taskId || c.visitId) applyQuietly({ entityType: c.taskId ? "task" : "visit", entityId: (c.taskId ?? c.visitId)!, to: "safety_stopped", actorType: "staff", actorId, reason: "staff_stop" });
    }
    const active = commands.at(-1);
    auditRobotEvent({ robotId, actorType: "staff", actorId, reason: "staff_stop", ...(active ? { correlationId: active.correlationId } : {}) });
    return delivered;
  }

  /** Staff cleared the stop (PIN already verified by the route). */
  function sendResume(robotId: string, actorId: string): boolean {
    const delivered = hub.send(robotId, { type: "resume" });
    auditRobotEvent({ robotId, actorType: "staff", actorId, reason: "staff_resume" });
    return delivered;
  }

  function sendStandby(robotId: string, actorId: string): "sent" | "busy" | "offline" | "unavailable" {
    sweepExpired();
    if (activeCommands(robotId).length) return "busy";
    const robot = db.select().from(t.robot).where(eq(t.robot.id, robotId)).get();
    const standby = robot && db.select().from(t.location).where(and(eq(t.location.facilityId, robot.facilityId), eq(t.location.kind, "standby"), eq(t.location.approved, true))).get();
    if (!standby || hub.status(robotId).lastHeartbeat?.robotReady === false) return "unavailable";
    const issuedAt = now();
    const correlationId = `standby_${randomUUID()}`;
    const intent: Intent = { type: "intent", intent: "go_to_location", correlationId, expiresAt: new Date(issuedAt.getTime() + ttl).toISOString(), payload: { locationId: standby.id } };
    const commandId = id();
    db.insert(t.robotCommand).values({ id: commandId, robotId, taskId: null, visitId: null, correlationId, intent, issuedAt: issuedAt.toISOString(), expiresAt: intent.expiresAt, ackedAt: null, result: null }).run();
    const delivered = hub.send(robotId, intent);
    // Standby is an immediate staff action, never an offline job for later replay.
    if (!delivered) db.update(t.robotCommand).set({ result: "offline" }).where(eq(t.robotCommand.id, commandId)).run();
    auditRobotEvent({ robotId, actorType: "staff", actorId, reason: delivered ? "standby" : "standby_offline", correlationId });
    return delivered ? "sent" : "offline";
  }

  function onUp(robotId: string, msg: GatewayUp) {
    if (msg.type === "heartbeat") return;
    const cmd = db.select().from(t.robotCommand).where(and(eq(t.robotCommand.robotId, robotId), eq(t.robotCommand.correlationId, msg.correlationId))).get();
    if (!cmd) { auditUnknownCorrelation(robotId, msg.correlationId); return; }
    if (msg.type === "ack") {
      // The first ack settles the command. A later one (a duplicate the robot
      // sends after a re-flush, or a stray retry) must never overwrite the
      // recorded outcome, nor drive a second visit transition off it.
      if (cmd.result !== null) return;
      db.update(t.robotCommand).set({ ackedAt: now().toISOString(), result: msg.result }).where(eq(t.robotCommand.id, cmd.id)).run();
      if (cmd.taskId) {
        if (msg.result === "accepted") robotApply(robotId, "task", cmd.taskId, "navigating_to_pickup");
        else if (msg.result !== "duplicate") robotApply(robotId, "task", cmd.taskId, "operator_required", reasonCode(msg.reason) ?? msg.result);
      } else if (cmd.visitId) {
        if (msg.result === "accepted") robotApply(robotId, "visit", cmd.visitId, "robot_en_route");
        else if (msg.result !== "duplicate") robotApply(robotId, "visit", cmd.visitId, "robot_unavailable", reasonCode(msg.reason) ?? msg.result);
      }
      return;
    }
    if (cmd.taskId) {
      const to = STATE_EVENT_TO_TASK[msg.event];
      if (!to) return;
      const task = db.select().from(t.taskRequest).where(eq(t.taskRequest.id, cmd.taskId)).get();
      if (to === "cancelled" && task?.state === "cancelled") return;
      robotApply(robotId, "task", cmd.taskId, to, reasonCode(msg.detail?.["reason"]) ?? msg.event);
      if (msg.event === "completed_leg" && task?.state === "verifying_delivery") {
        db.update(t.robotCommand).set({ result: "completed" }).where(eq(t.robotCommand.id, cmd.id)).run();
      }
      return;
    }
    if (!cmd.visitId) {
      if (cmd.result !== "accepted" && cmd.result !== null) return;
      if (["arrived", "completed_leg", "navigation_failed", "safety_stopped", "cancelled", "expired"].includes(msg.event)) {
        db.update(t.robotCommand).set({ result: msg.event === "arrived" || msg.event === "completed_leg" ? "completed" : msg.event }).where(eq(t.robotCommand.id, cmd.id)).run();
        auditRobotEvent({ robotId, actorType: "robot", actorId: robotId, reason: msg.event, correlationId: cmd.correlationId });
      }
      return;
    }
    const visit = db.select().from(t.visitSession).where(eq(t.visitSession.id, cmd.visitId)).get();
    const to = msg.event === "arrived" && visit?.initiatorKind === "device" && !visit.scheduledStartAt
      ? "awaiting_family_consent" : STATE_EVENT_TO_VISIT[msg.event];
    if (!to) return;
    if (to === "cancelled" && visit?.state === "cancelled") return;
    robotApply(robotId, "visit", cmd.visitId, to, reasonCode(msg.detail?.["reason"]) ?? msg.event);
  }
  const unsubHub = hub.onUp(onUp);

  /**
   * Send every still-dispatchable command for `robotId`. A command is only
   * dispatchable while its visit is still `accepted`: anything else (cancelled,
   * denied, already failed over to robot_unavailable, ...) means the robot must
   * not be sent on this errand at all, so the row is settled as `stale` instead
   * of being sent -- and, because settled rows are not candidates, it is never
   * considered again. Rows are settled but never acked here: `ackedAt` records
   * what the *robot* said.
   */
  function flushPending(robotId: string): number {
    const nowIso = now().toISOString();
    const pending = db.select().from(t.robotCommand)
      .where(and(eq(t.robotCommand.robotId, robotId), isNull(t.robotCommand.ackedAt), isNull(t.robotCommand.result))).all()
      .filter((c) => c.expiresAt > nowIso);
    let n = 0;
    for (const c of pending) {
      // A standalone action may already be moving before its ack arrives.
      // Never replay it, and retain its busy reservation until ack/expiry/STOP.
      if (!c.taskId && !c.visitId) continue;
      const dispatchable = c.taskId
        ? db.select().from(t.taskRequest).where(eq(t.taskRequest.id, c.taskId)).get()?.state === "queued"
        : c.visitId ? db.select().from(t.visitSession).where(eq(t.visitSession.id, c.visitId)).get()?.state === "accepted" : false;
      if (!dispatchable) {
        db.update(t.robotCommand).set({ result: "stale" }).where(eq(t.robotCommand.id, c.id)).run();
        continue;
      }
      if (hub.send(robotId, c.intent as Intent)) n++;
    }
    return n;
  }

  /**
   * Reconcile commands whose TTL ran out with no ack: the robot either never
   * saw the intent or never answered, so the visit would otherwise sit
   * `accepted` forever. Settles the row as `expired` and fails the visit over
   * to robot_unavailable. Safe to call on a timer -- settled rows are not
   * candidates, so each command is swept at most once.
   */
  function sweepExpired(at: Date = now()): number {
    const nowIso = at.toISOString();
    const due = db.select().from(t.robotCommand)
      .where(and(isNull(t.robotCommand.ackedAt), isNull(t.robotCommand.result))).all()
      .filter((c) => c.expiresAt <= nowIso);
    let n = 0;
    for (const c of due) {
      const dispatchable = c.taskId
        ? db.select().from(t.taskRequest).where(eq(t.taskRequest.id, c.taskId)).get()?.state === "queued"
        : c.visitId ? db.select().from(t.visitSession).where(eq(t.visitSession.id, c.visitId)).get()?.state === "accepted" : c.intent.intent === "go_to_location";
      if (!dispatchable) continue;
      db.update(t.robotCommand).set({ result: "expired" }).where(eq(t.robotCommand.id, c.id)).run();
      if (c.taskId) applyQuietly({ entityType: "task", entityId: c.taskId, to: "operator_required", actorType: "system", actorId: "api", reason: "expired" });
      else if (c.visitId) applyQuietly({ entityType: "visit", entityId: c.visitId, to: "robot_unavailable", actorType: "system", actorId: "api", reason: "expired" });
      n++;
    }
    return n;
  }

  return { ensureVisitCommand, flushPending, sweepExpired, sendStop, sendResume, sendStandby, auditRobot, cancelVisit: cancelCommand, stop() { unsubTransitions(); unsubHub(); } };
}
