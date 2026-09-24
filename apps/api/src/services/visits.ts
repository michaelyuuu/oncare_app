import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { VISIT_TERMINAL_STATES, makeTransitionEvent, type ActorType, type VisitState } from "@oncare/core";
import type { Principal } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import { actionRole, createAccess, type ActionRole } from "./access";
import { TransitionError, type createTransitionService } from "./transitions";
import type { VideoProvider } from "./video";

export type TransitionService = ReturnType<typeof createTransitionService>;
export type VisitRow = typeof t.visitSession.$inferSelect;
export type CreateVisitError = "no_relationship" | "consent_missing" | "resident_unavailable" | "forbidden" | "invalid_reservation";
export type VisitAction = "approve" | "deny" | "answer" | "answer_family" | "decline" | "connected" | "connection_lost" | "end" | "cancel";
export type ActError = "not_found" | "forbidden" | "illegal_transition";
type CreateResult = { ok: true; visit: VisitRow } | { ok: false; error: CreateVisitError };
export interface CreateNowInput { residentId: string; familyUserId: string; initiator: { kind: "family" | "device"; id: string } }
export interface CreateScheduledInput { residentId: string; familyUserId: string; scheduledStartAt: string; reservationId: string }

const ACTIONS: Record<VisitAction, { roles: ActionRole[]; to: VisitState[] }> = {
  approve:   { roles: ["staff"],                     to: ["accepted"] },
  deny:      { roles: ["staff"],                     to: ["denied"] },
  answer:    { roles: ["device"],                    to: ["connecting"] },
  answer_family: { roles: ["family"],                to: ["connecting"] },
  decline:   { roles: ["device"],                    to: ["resident_unavailable"] },
  connected: { roles: ["family", "device"],          to: ["active"] },
  connection_lost: { roles: ["family", "device"],   to: ["connection_failed"] },
  end:       { roles: ["family", "device", "staff"], to: ["ending", "completed"] },
  cancel:    { roles: ["family", "staff", "device"], to: ["cancelled"] },
};

export const VISIT_ACTIONS = Object.keys(ACTIONS) as VisitAction[];

function roleOf(p: Principal): ActionRole { return actionRole(p); }
function actorTypeOf(p: Principal): ActorType { return p.kind === "device" ? "device" : p.role; }

export interface VisitService {
  stop(): void;
  create(input: { requesterId: string; residentId: string }): { ok: true; visit: VisitRow } | { ok: false; error: CreateVisitError };
  createNow(input: CreateNowInput): CreateResult;
  createScheduled(input: CreateScheduledInput): CreateResult;
  incoming(principal: Principal): VisitRow[];
  hasCallConsent(visit: VisitRow): boolean;
  get(id: string): VisitRow | undefined;
  canView(principal: Principal, visit: VisitRow): boolean;
  act(input: { visitId: string; action: VisitAction; principal: Principal }): { ok: true; visit: VisitRow } | { ok: false; error: ActError; detail?: string };
}

export function createVisitService(
  db: Db,
  transitions: TransitionService,
  video: VideoProvider,
  opts: { now?: () => Date; id?: () => string; onVideoCloseError?: (visitId: string) => void } = {},
): VisitService {
  const now = opts.now ?? (() => new Date());
  const id = opts.id ?? (() => `visit_${randomUUID()}`);
  const access = createAccess(db);

  function get(visitId: string): VisitRow | undefined {
    return db.select().from(t.visitSession).where(eq(t.visitSession.id, visitId)).get();
  }

  // Remember only rooms closed at ending until their terminal transition.
  // All writers (including dispatch) share this successful-transition stream.
  const closedAtEnding = new Set<string>();
  const unsubscribe = transitions.subscribe((event) => {
    if (event.entityType !== "visit") return;
    const terminal = (VISIT_TERMINAL_STATES as readonly string[]).includes(event.toState ?? "");
    if (event.toState !== "ending" && !terminal) return;
    const alreadyClosed = closedAtEnding.has(event.entityId);
    if (terminal) closedAtEnding.delete(event.entityId);
    if (alreadyClosed) return;
    const visit = get(event.entityId);
    const tokenEligibleBefore = ["awaiting_resident_consent", "awaiting_family_consent", "connecting", "active", "ending"].includes(event.fromState ?? "")
      || visit?.connectedAt != null;
    if (!tokenEligibleBefore) return;
    if (event.toState === "ending") closedAtEnding.add(event.entityId);
    void video.closeRoom(event.entityId).catch(() => opts.onVideoCloseError?.(event.entityId));
  });

  function validateParticipants(residentId: string, familyUserId: string) {
    const family = db.select().from(t.user).where(eq(t.user.id, familyUserId)).get();
    const rel = family?.active && family.role === "family" ? access.familyLink(familyUserId, residentId) : undefined;
    if (!rel) return { ok: false as const, error: "no_relationship" as const };
    if (!(rel.consentVideo && rel.consentRobotVisit)) return { ok: false as const, error: "consent_missing" as const };
    // An inactive resident has no family link (access.familyLink filters on resident.active), so
    // `rel` above already refused that case; this lookup is only for the availability gate.
    const resident = db.select().from(t.resident).where(eq(t.resident.id, residentId)).get();
    if (!resident || resident.availability === "not_available") return { ok: false as const, error: "resident_unavailable" as const };
    return { ok: true as const, resident };
  }

  function finishCreation(visitId: string, availability: string): CreateResult {
    // A scheduled reservation may already be linked when a previous process
    // exited. Resume only the creation steps that are still outstanding.
    if (get(visitId)?.state === "requested") {
      transitions.apply({ entityType: "visit", entityId: visitId, to: "awaiting_policy_or_staff", actorType: "system", actorId: "api" });
    }
    if (availability === "available" && get(visitId)?.state === "awaiting_policy_or_staff") {
      transitions.apply({ entityType: "visit", entityId: visitId, to: "accepted", actorType: "system", actorId: "api", reason: "auto_policy" });
    }
    return { ok: true, visit: get(visitId)! };
  }

  function createNow(input: CreateNowInput): CreateResult {
    const checked = validateParticipants(input.residentId, input.familyUserId);
    if (!checked.ok) return checked;
    const resident = checked.resident;
    const device = db.select().from(t.device).where(and(
      eq(t.device.residentId, resident.id), eq(t.device.facilityId, resident.facilityId), eq(t.device.active, true),
      input.initiator.kind === "device" ? eq(t.device.id, input.initiator.id) : undefined,
    )).get();
    if (input.initiator.kind === "device" ? !device : input.initiator.id !== input.familyUserId) return { ok: false, error: "forbidden" };
    const robot = db.select().from(t.robot).where(and(
      eq(t.robot.facilityId, resident.facilityId), device?.robotId ? eq(t.robot.id, device.robotId) : undefined,
    )).get();
    const visitId = id();
    db.insert(t.visitSession).values({
      id: visitId, residentId: input.residentId, requesterId: input.familyUserId, robotId: robot?.id ?? null,
      state: "requested", livekitRoom: null, requestedAt: now().toISOString(), connectedAt: null, endedAt: null,
      scheduledStartAt: null, initiatorKind: input.initiator.kind, initiatorId: input.initiator.id,
    }).run();
    return finishCreation(visitId, resident.availability);
  }

  function create(input: { requesterId: string; residentId: string }): CreateResult {
    return createNow({ residentId: input.residentId, familyUserId: input.requesterId, initiator: { kind: "family", id: input.requesterId } });
  }

  function createScheduled(input: CreateScheduledInput): CreateResult {
    // Claim and insert under one write lock. No transition listeners or robot I/O
    // run until the reservation link has committed (including across API workers).
    const claimed = db.transaction((tx) => {
      const reservation = tx.select().from(t.visitReservation).where(eq(t.visitReservation.id, input.reservationId)).get();
      const at = now().toISOString();
      if (!reservation || reservation.status !== "confirmed"
        || reservation.residentId !== input.residentId || reservation.familyUserId !== input.familyUserId
        || reservation.startAt !== input.scheduledStartAt) {
        return { ok: false as const, error: "invalid_reservation" as const };
      }
      const checked = validateParticipants(input.residentId, input.familyUserId);
      if (!checked.ok) return checked;
      if (reservation.visitId !== null) {
        return { ok: true as const, visitId: reservation.visitId, availability: checked.resident.availability };
      }
      const visitId = id();
      tx.insert(t.visitSession).values({
        id: visitId, residentId: input.residentId, requesterId: input.familyUserId, robotId: reservation.robotId,
        state: "requested", requestedAt: at, scheduledStartAt: input.scheduledStartAt,
        // Both parties already agreed to the slot; the resident still answers at start.
        initiatorKind: "family", initiatorId: input.familyUserId,
      }).run();
      tx.update(t.visitReservation).set({ visitId, updatedAt: at }).where(and(
        eq(t.visitReservation.id, reservation.id), eq(t.visitReservation.status, "confirmed"), isNull(t.visitReservation.visitId),
      )).run();
      return { ok: true as const, visitId, availability: checked.resident.availability };
    }, { behavior: "immediate" });
    if (!claimed.ok) return claimed;
    return finishCreation(claimed.visitId, claimed.availability);
  }

  function hasCallConsent(visit: VisitRow): boolean {
    const family = db.select().from(t.user).where(eq(t.user.id, visit.requesterId)).get();
    const rel = access.familyLink(visit.requesterId, visit.residentId);
    return !!(family?.active && family.role === "family" && rel?.consentVideo && rel.consentRobotVisit);
  }

  function incoming(principal: Principal): VisitRow[] {
    if (principal.kind !== "user" || principal.role !== "family") return [];
    return db.select().from(t.visitSession).where(and(
      eq(t.visitSession.requesterId, principal.id), eq(t.visitSession.initiatorKind, "device"),
      eq(t.visitSession.state, "awaiting_family_consent"),
    )).all().filter(visit => canView(principal, visit) && hasCallConsent(visit));
  }

  function canView(principal: Principal, visit: VisitRow): boolean {
    if (principal.kind === "device") return principal.residentId === visit.residentId;
    if (principal.role === "family") return principal.id === visit.requesterId && access.canAccessResident(principal, visit.residentId);
    return access.canAccessResident(principal, visit.residentId);
  }

  function act(input: { visitId: string; action: VisitAction; principal: Principal }): { ok: true; visit: VisitRow } | { ok: false; error: ActError; detail?: string } {
    const visit = get(input.visitId);
    if (!visit) return { ok: false as const, error: "not_found" as const };
    const spec = ACTIONS[input.action];
    if (!spec.roles.includes(roleOf(input.principal)) || !canView(input.principal, visit)) return { ok: false as const, error: "forbidden" as const };
    if (["answer", "answer_family", "connected"].includes(input.action) && !hasCallConsent(visit)) return { ok: false, error: "forbidden" };
    if (input.action === "cancel" && input.principal.kind === "device"
      && (visit.initiatorKind !== "device" || visit.initiatorId !== input.principal.id)) return { ok: false, error: "forbidden" };
    const wrongConsent = (input.action === "answer" && visit.state !== "awaiting_resident_consent")
      || (input.action === "answer_family" && (visit.state !== "awaiting_family_consent" || visit.initiatorKind !== "device"));
    const beforeStart = ["answer", "answer_family", "connected"].includes(input.action)
      && visit.scheduledStartAt !== null && now().getTime() < Date.parse(visit.scheduledStartAt);
    if (wrongConsent || beforeStart) {
      db.insert(t.auditEvent).values(makeTransitionEvent({ entityType: "visit", entityId: visit.id,
        actorType: actorTypeOf(input.principal), actorId: input.principal.id, fromState: visit.state,
        toState: spec.to[0]!, reason: "rejected_transition", correlationId: visit.id, now,
      })).run();
      return { ok: false, error: "illegal_transition" };
    }
    try {
      const last = spec.to.length - 1;
      spec.to.forEach((to, i) => {
        // A multi-step action (end: active -> ending -> completed) may be
        // asked of a visit that is already part-way through it -- a retried
        // tap, or a client that reported `ending` itself. A step whose state
        // the visit already holds is satisfied, so skip it rather than
        // failing the whole action on an illegal ending -> ending.
        if (get(visit.id)?.state === to) return;
        const isFinal = i === last;
        const patch = isFinal
          ? input.action === "connected" ? { connectedAt: now().toISOString() }
          : input.action === "end" ? { endedAt: now().toISOString() }
          : undefined
          : undefined;
        transitions.apply({
          entityType: "visit", entityId: visit.id, to, actorType: actorTypeOf(input.principal), actorId: input.principal.id,
          ...(patch ? { patch } : {}),
        });
      });
    } catch (e) {
      if (e instanceof TransitionError) return { ok: false as const, error: "illegal_transition" as const, detail: e.reason };
      throw e;
    }
    const updated = get(visit.id)!;
    return { ok: true as const, visit: updated };
  }

  return { create, createNow, createScheduled, incoming, hasCallConsent, get, canView, act, stop() { unsubscribe(); closedAtEnding.clear(); } };
}
