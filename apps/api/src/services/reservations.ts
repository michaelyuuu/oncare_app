import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, lt, lte, ne, or } from "drizzle-orm";
import {
  DEMO_VISIT_POLICY,
  buildVisitSlotDefinitions,
  isVisitDateInWindow,
  localSlotToIso,
  makeTransitionEvent,
  type ActorType,
  type AuditEvent,
} from "@oncare/core";
import type { Principal } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import type { Access } from "./access";
import { createDirectory } from "./directory";
import type { TransitionService } from "./visits";

export type ReservationServiceError =
  | "not_found"
  | "forbidden"
  | "consent_missing"
  | "invalid_slot"
  | "conflict"
  | "expired"
  | "invalid_action";

type ReservationRow = typeof t.visitReservation.$inferSelect;
type ReservationInsert = typeof t.visitReservation.$inferInsert;
type ParticipantKind = "family" | "device";
type CancellationKind = ParticipantKind | "staff" | "admin";
type Result<T> = { ok: true; value: T } | { ok: false; error: ReservationServiceError };

interface ReservationContext {
  facilityId: string;
  timeZone: string;
  residentId: string;
  robotId: string;
}

interface SlotInput {
  localDate: string;
  startMinute: number;
}

interface ValidSlot {
  startAt: string;
  endAt: string;
}

export interface ReservationServiceOptions {
  now?: () => Date;
  id?: () => string;
}

export function createReservationService(
  db: Db,
  access: Access,
  transitions: TransitionService,
  opts: ReservationServiceOptions = {},
) {
  const now = opts.now ?? (() => new Date());
  const id = opts.id ?? (() => "reservation_" + randomUUID());
  const directory = createDirectory(db);

  const viewSelection = {
    id: t.visitReservation.id,
    residentId: t.visitReservation.residentId,
    residentDisplayName: t.resident.displayName,
    familyUserId: t.visitReservation.familyUserId,
    familyDisplayName: t.user.displayName,
    robotId: t.visitReservation.robotId,
    robotName: t.robot.name,
    proposerKind: t.visitReservation.proposerKind,
    proposerId: t.visitReservation.proposerId,
    status: t.visitReservation.status,
    startAt: t.visitReservation.startAt,
    endAt: t.visitReservation.endAt,
    timeZone: t.visitReservation.timeZone,
    expiresAt: t.visitReservation.expiresAt,
    reminderAt: t.visitReservation.reminderAt,
    dispatchAt: t.visitReservation.dispatchAt,
    confirmedAt: t.visitReservation.confirmedAt,
    confirmedByKind: t.visitReservation.confirmedByKind,
    confirmedById: t.visitReservation.confirmedById,
    cancelledAt: t.visitReservation.cancelledAt,
    cancelledByKind: t.visitReservation.cancelledByKind,
    cancelledById: t.visitReservation.cancelledById,
    cancellationReason: t.visitReservation.cancellationReason,
    supersedesId: t.visitReservation.supersedesId,
    visitId: t.visitReservation.visitId,
    createdAt: t.visitReservation.createdAt,
    updatedAt: t.visitReservation.updatedAt,
  };

  function allViews() {
    return db.select(viewSelection)
      .from(t.visitReservation)
      .innerJoin(t.resident, eq(t.resident.id, t.visitReservation.residentId))
      .innerJoin(t.user, eq(t.user.id, t.visitReservation.familyUserId))
      .innerJoin(t.robot, eq(t.robot.id, t.visitReservation.robotId))
      .orderBy(asc(t.visitReservation.startAt), asc(t.visitReservation.createdAt))
      .all();
  }

  function view(reservationId: string) {
    return db.select(viewSelection)
      .from(t.visitReservation)
      .innerJoin(t.resident, eq(t.resident.id, t.visitReservation.residentId))
      .innerJoin(t.user, eq(t.user.id, t.visitReservation.familyUserId))
      .innerJoin(t.robot, eq(t.robot.id, t.visitReservation.robotId))
      .where(eq(t.visitReservation.id, reservationId))
      .get();
  }

  function row(reservationId: string): ReservationRow | undefined {
    return db.select().from(t.visitReservation).where(eq(t.visitReservation.id, reservationId)).get();
  }

  function resolveContext(residentId: string): ReservationContext | undefined {
    return db.select({
      facilityId: t.facility.id,
      timeZone: t.facility.timezone,
      residentId: t.resident.id,
      robotId: t.robot.id,
    })
      .from(t.resident)
      .innerJoin(t.facility, eq(t.facility.id, t.resident.facilityId))
      .innerJoin(t.device, and(
        eq(t.device.residentId, t.resident.id),
        eq(t.device.facilityId, t.facility.id),
        eq(t.device.active, true),
      ))
      .innerJoin(t.robot, and(
        eq(t.robot.id, t.device.robotId),
        eq(t.robot.facilityId, t.facility.id),
      ))
      .where(and(eq(t.resident.id, residentId), eq(t.resident.active, true)))
      .get();
  }

  function localDateAt(instant: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return values.year + "-" + values.month + "-" + values.day;
  }

  function addLocalDays(localDate: string, days: number): string {
    const value = new Date(localDate + "T00:00:00.000Z");
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  }

  function validateSlot(context: ReservationContext, input: SlotInput): ValidSlot | undefined {
    const current = now();
    const today = localDateAt(current, context.timeZone);
    if (!isVisitDateInWindow(input.localDate, today)) return undefined;
    const definition = buildVisitSlotDefinitions(input.localDate)
      .find((candidate) => candidate.startMinute === input.startMinute && candidate.state === "available");
    if (!definition) return undefined;
    const startAt = localSlotToIso(input.localDate, definition.startMinute, context.timeZone);
    if (Date.parse(startAt) <= current.getTime()) return undefined;
    return {
      startAt,
      endAt: localSlotToIso(input.localDate, definition.endMinute, context.timeZone),
    };
  }

  function relationshipError(familyUserId: string, residentId: string): ReservationServiceError | undefined {
    const relationship = access.familyLink(familyUserId, residentId);
    if (!relationship) return "forbidden";
    const familyUser = db.select({ role: t.user.role, active: t.user.active })
      .from(t.user)
      .where(eq(t.user.id, familyUserId))
      .get();
    if (!familyUser || !familyUser.active || familyUser.role !== "family") return "forbidden";
    if (!relationship.consentVideo || !relationship.consentRobotVisit) return "consent_missing";
    return undefined;
  }

  function actor(principal: Principal): { kind: CancellationKind; type: ActorType; id: string } {
    if (principal.kind === "device") return { kind: "device", type: "device", id: principal.id };
    return { kind: principal.role, type: principal.role, id: principal.id };
  }

  function eventFor(
    reservationId: string,
    fromState: string | null,
    toState: string,
    reason: string,
    actorType: ActorType,
    actorId: string,
    at: Date = now(),
  ): AuditEvent {
    return makeTransitionEvent({
      entityType: "visit_reservation",
      entityId: reservationId,
      fromState,
      toState,
      reason,
      correlationId: reservationId,
      actorType,
      actorId,
      now: () => at,
    });
  }

  function visibleTo(
    principal: Principal,
    reservation: Pick<ReservationRow, "residentId" | "familyUserId">,
  ): boolean {
    if (principal.kind === "device") return principal.residentId === reservation.residentId;
    if (principal.role === "family") {
      return principal.id === reservation.familyUserId && access.canAccessResident(principal, reservation.residentId);
    }
    return access.canAccessResident(principal, reservation.residentId);
  }

  function isParticipant(principal: Principal, reservation: ReservationRow): boolean {
    if (principal.kind === "device") return principal.residentId === reservation.residentId;
    return principal.role === "family" && principal.id === reservation.familyUserId;
  }

  function isReceiver(principal: Principal, reservation: ReservationRow): boolean {
    if (reservation.proposerKind === "family") {
      return principal.kind === "device" && principal.residentId === reservation.residentId;
    }
    return principal.kind === "user" && principal.role === "family" && principal.id === reservation.familyUserId;
  }

  function hasConflict(
    executor: Pick<Db, "select">,
    input: { residentId: string; familyUserId: string; robotId: string; startAt: string; endAt: string; excludeId?: string },
  ): boolean {
    return executor.select({ id: t.visitReservation.id })
      .from(t.visitReservation)
      .where(and(
        inArray(t.visitReservation.status, ["pending", "confirmed"]),
        lt(t.visitReservation.startAt, input.endAt),
        gt(t.visitReservation.endAt, input.startAt),
        or(
          eq(t.visitReservation.residentId, input.residentId),
          eq(t.visitReservation.familyUserId, input.familyUserId),
          eq(t.visitReservation.robotId, input.robotId),
        ),
        input.excludeId ? ne(t.visitReservation.id, input.excludeId) : undefined,
      ))
      .get() !== undefined;
  }

  function insertProposal(
    input: {
      context: ReservationContext;
      familyUserId: string;
      proposerKind: ParticipantKind;
      proposerId: string;
      slot: ValidSlot;
      supersedesId?: string;
    },
  ): { reservation: ReservationInsert; event: AuditEvent } {
    const created = now();
    const reservationId = id();
    const reservation: ReservationInsert = {
      id: reservationId,
      facilityId: input.context.facilityId,
      residentId: input.context.residentId,
      familyUserId: input.familyUserId,
      robotId: input.context.robotId,
      proposerKind: input.proposerKind,
      proposerId: input.proposerId,
      status: "pending",
      startAt: input.slot.startAt,
      endAt: input.slot.endAt,
      timeZone: input.context.timeZone,
      expiresAt: new Date(created.getTime() + 5 * 60_000).toISOString(),
      reminderAt: new Date(Date.parse(input.slot.startAt) - 10 * 60_000).toISOString(),
      dispatchAt: new Date(Date.parse(input.slot.startAt) - 5 * 60_000).toISOString(),
      confirmedAt: null,
      confirmedByKind: null,
      confirmedById: null,
      cancelledAt: null,
      cancelledByKind: null,
      cancelledById: null,
      cancellationReason: null,
      supersedesId: input.supersedesId ?? null,
      visitId: null,
      createdAt: created.toISOString(),
      updatedAt: created.toISOString(),
    };
    return {
      reservation,
      event: eventFor(reservationId, null, "pending", "reservation_proposed", input.proposerKind, input.proposerId, created),
    };
  }

  function expirePending(at: Date = now()): number {
    const atIso = at.toISOString();
    const candidates = db.select().from(t.visitReservation).where(and(
      eq(t.visitReservation.status, "pending"),
      lte(t.visitReservation.expiresAt, atIso),
    )).all();
    const events: AuditEvent[] = [];
    db.transaction((tx) => {
      for (const candidate of candidates) {
        const result = tx.update(t.visitReservation)
          .set({ status: "expired", updatedAt: atIso })
          .where(and(eq(t.visitReservation.id, candidate.id), eq(t.visitReservation.status, "pending")))
          .run();
        if (result.changes === 0) continue;
        const event = eventFor(candidate.id, "pending", "expired", "reservation_expired", "system", "api", at);
        tx.insert(t.auditEvent).values(event).run();
        events.push(event);
      }
    });
    for (const event of events) transitions.emit(event);
    return events.length;
  }

  function contacts(principal: Principal): Result<ReturnType<typeof directory.familyContacts>> {
    if (principal.kind !== "device") return { ok: false, error: "forbidden" };
    if (!resolveContext(principal.residentId)) return { ok: false, error: "not_found" };
    return { ok: true, value: directory.familyContacts(principal.residentId) };
  }

  function slots(input: { principal: Principal; residentId: string; from: string }) {
    const context = resolveContext(input.residentId);
    if (!context) return { ok: false as const, error: "not_found" as const };
    if (!access.canAccessResident(input.principal, input.residentId)) return { ok: false as const, error: "forbidden" as const };
    if (input.principal.kind === "user" && input.principal.role === "family") {
      const error = relationshipError(input.principal.id, input.residentId);
      if (error) return { ok: false as const, error };
    }
    const today = localDateAt(now(), context.timeZone);
    if (!isVisitDateInWindow(input.from, today)) return { ok: false as const, error: "invalid_slot" as const };
    expirePending();
    const active = db.select().from(t.visitReservation)
      .where(inArray(t.visitReservation.status, ["pending", "confirmed"]))
      .all();
    const definitions = Array.from({ length: DEMO_VISIT_POLICY.windowDays }, (_, offset) => addLocalDays(input.from, offset))
      .filter((localDate) => isVisitDateInWindow(localDate, today))
      .flatMap((localDate) => buildVisitSlotDefinitions(localDate));
    const value = definitions.map((definition) => {
      const startAt = localSlotToIso(definition.localDate, definition.startMinute, context.timeZone);
      const endAt = localSlotToIso(definition.localDate, definition.endMinute, context.timeZone);
      if (definition.state === "blocked") return { ...definition, startAt, endAt };
      const conflict = active.find((candidate) =>
        candidate.startAt < endAt && candidate.endAt > startAt && (
          candidate.residentId === input.residentId
          || candidate.robotId === context.robotId
          || (input.principal.kind === "user" && input.principal.role === "family" && candidate.familyUserId === input.principal.id)
        ));
      if (!conflict) return { ...definition, startAt, endAt };
      return {
        ...definition,
        startAt,
        endAt,
        state: conflict.status,
        ...(visibleTo(input.principal, conflict) ? { reservationId: conflict.id } : {}),
      };
    });
    return { ok: true as const, value: { timeZone: context.timeZone, slots: value } };
  }

  function list(principal: Principal) {
    expirePending();
    return allViews().filter((reservation) => visibleTo(principal, reservation));
  }

  function createProposal(input: { principal: Principal; residentId?: string; familyUserId?: string } & SlotInput) {
    const residentId = input.principal.kind === "device" ? input.principal.residentId : input.residentId;
    const familyUserId = input.principal.kind === "device" ? input.familyUserId : input.principal.id;
    if (!residentId || !familyUserId) return { ok: false as const, error: "forbidden" as const };
    if (input.principal.kind === "device" && input.principal.residentId !== residentId) {
      return { ok: false as const, error: "forbidden" as const };
    }
    if (input.principal.kind === "user" && input.principal.role !== "family") {
      return { ok: false as const, error: "forbidden" as const };
    }
    const context = resolveContext(residentId);
    if (!context) return { ok: false as const, error: "not_found" as const };
    const relationship = relationshipError(familyUserId, residentId);
    if (relationship) return { ok: false as const, error: relationship };
    const slot = validateSlot(context, input);
    if (!slot) return { ok: false as const, error: "invalid_slot" as const };
    expirePending();
    const proposerKind = input.principal.kind === "device" ? "device" : "family";
    const proposal = insertProposal({
      context,
      familyUserId,
      proposerKind,
      proposerId: input.principal.id,
      slot,
    });
    const inserted = db.transaction((tx) => {
      if (hasConflict(tx, { residentId, familyUserId, robotId: context.robotId, ...slot })) return false;
      tx.insert(t.visitReservation).values(proposal.reservation).run();
      tx.insert(t.auditEvent).values(proposal.event).run();
      return true;
    });
    if (!inserted) return { ok: false as const, error: "conflict" as const };
    transitions.emit(proposal.event);
    return { ok: true as const, value: view(proposal.reservation.id)! };
  }

  function confirm(input: { principal: Principal; reservationId: string }) {
    expirePending();
    const current = row(input.reservationId);
    if (!current) return { ok: false as const, error: "not_found" as const };
    if (!visibleTo(input.principal, current) || !isReceiver(input.principal, current)) {
      return { ok: false as const, error: "forbidden" as const };
    }
    if (current.status === "expired") return { ok: false as const, error: "expired" as const };
    if (current.status !== "pending") return { ok: false as const, error: "invalid_action" as const };
    const relationship = relationshipError(current.familyUserId, current.residentId);
    if (relationship) return { ok: false as const, error: relationship };
    const actionAt = now();
    const principalActor = actor(input.principal);
    const event = eventFor(current.id, "pending", "confirmed", "reservation_confirmed", principalActor.type, principalActor.id, actionAt);
    const changed = db.transaction((tx) => {
      const result = tx.update(t.visitReservation).set({
        status: "confirmed",
        confirmedAt: actionAt.toISOString(),
        confirmedByKind: principalActor.kind as ParticipantKind,
        confirmedById: principalActor.id,
        updatedAt: actionAt.toISOString(),
      }).where(and(
        eq(t.visitReservation.id, current.id),
        eq(t.visitReservation.status, "pending"),
        gt(t.visitReservation.expiresAt, actionAt.toISOString()),
      )).run();
      if (result.changes === 0) return false;
      tx.insert(t.auditEvent).values(event).run();
      return true;
    });
    if (!changed) {
      expirePending(actionAt);
      return { ok: false as const, error: "expired" as const };
    }
    transitions.emit(event);
    return { ok: true as const, value: view(current.id)! };
  }

  function suggest(input: { principal: Principal; reservationId: string } & SlotInput) {
    expirePending();
    const current = row(input.reservationId);
    if (!current) return { ok: false as const, error: "not_found" as const };
    if (!visibleTo(input.principal, current) || !isReceiver(input.principal, current)) {
      return { ok: false as const, error: "forbidden" as const };
    }
    if (current.status === "expired") return { ok: false as const, error: "expired" as const };
    if (current.status !== "pending") return { ok: false as const, error: "invalid_action" as const };
    const relationship = relationshipError(current.familyUserId, current.residentId);
    if (relationship) return { ok: false as const, error: relationship };
    const context = resolveContext(current.residentId);
    if (!context) return { ok: false as const, error: "not_found" as const };
    const slot = validateSlot(context, input);
    if (!slot) return { ok: false as const, error: "invalid_slot" as const };
    const principalActor = actor(input.principal);
    const proposal = insertProposal({
      context,
      familyUserId: current.familyUserId,
      proposerKind: principalActor.kind as ParticipantKind,
      proposerId: principalActor.id,
      slot,
      supersedesId: current.id,
    });
    const actionAt = now();
    const supersededEvent = eventFor(current.id, "pending", "cancelled", "reservation_superseded", principalActor.type, principalActor.id, actionAt);
    const inserted = db.transaction((tx) => {
      if (hasConflict(tx, {
        residentId: current.residentId,
        familyUserId: current.familyUserId,
        robotId: context.robotId,
        ...slot,
        excludeId: current.id,
      })) return false;
      const changed = tx.update(t.visitReservation).set({
        status: "cancelled",
        cancelledAt: actionAt.toISOString(),
        cancelledByKind: principalActor.kind,
        cancelledById: principalActor.id,
        cancellationReason: "superseded",
        updatedAt: actionAt.toISOString(),
      }).where(and(eq(t.visitReservation.id, current.id), eq(t.visitReservation.status, "pending"))).run();
      if (changed.changes === 0) return false;
      tx.insert(t.visitReservation).values(proposal.reservation).run();
      tx.insert(t.auditEvent).values(supersededEvent).run();
      tx.insert(t.auditEvent).values(proposal.event).run();
      return true;
    });
    if (!inserted) return { ok: false as const, error: "conflict" as const };
    transitions.emit(supersededEvent);
    transitions.emit(proposal.event);
    return { ok: true as const, value: view(proposal.reservation.id)! };
  }

  function cancel(input: { principal: Principal; reservationId: string }) {
    expirePending();
    const current = row(input.reservationId);
    if (!current) return { ok: false as const, error: "not_found" as const };
    const staffLike = input.principal.kind === "user" && (input.principal.role === "staff" || input.principal.role === "admin");
    if (!visibleTo(input.principal, current) || (!isParticipant(input.principal, current) && !staffLike)) {
      return { ok: false as const, error: "forbidden" as const };
    }
    if (current.status === "expired") return { ok: false as const, error: "expired" as const };
    if (current.status !== "pending" && current.status !== "confirmed") {
      return { ok: false as const, error: "invalid_action" as const };
    }
    const actionAt = now();
    const principalActor = actor(input.principal);
    const event = eventFor(current.id, current.status, "cancelled", "reservation_cancelled", principalActor.type, principalActor.id, actionAt);
    const changed = db.transaction((tx) => {
      const result = tx.update(t.visitReservation).set({
        status: "cancelled",
        cancelledAt: actionAt.toISOString(),
        cancelledByKind: principalActor.kind,
        cancelledById: principalActor.id,
        cancellationReason: "participant_cancelled",
        updatedAt: actionAt.toISOString(),
      }).where(and(
        eq(t.visitReservation.id, current.id),
        inArray(t.visitReservation.status, ["pending", "confirmed"]),
      )).run();
      if (result.changes === 0) return false;
      tx.insert(t.auditEvent).values(event).run();
      return true;
    });
    if (!changed) return { ok: false as const, error: "invalid_action" as const };
    transitions.emit(event);
    return { ok: true as const, value: view(current.id)! };
  }

  return { contacts, slots, list, createProposal, confirm, suggest, cancel, expirePending };
}

export type ReservationService = ReturnType<typeof createReservationService>;
