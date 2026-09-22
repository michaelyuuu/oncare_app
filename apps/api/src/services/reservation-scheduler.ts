import { and, eq, isNull, lte } from "drizzle-orm";
import { makeTransitionEvent, VISIT_TERMINAL_STATES, type AuditEvent } from "@oncare/core";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import type { createDispatchService } from "./dispatch";
import type { ReservationService } from "./reservations";
import type { TransitionService, VisitService } from "./visits";

export function createReservationScheduler(opts: {
  db: Db;
  reservations: ReservationService;
  visits: VisitService;
  transitions: TransitionService;
  dispatch: ReturnType<typeof createDispatchService>;
  now?: () => Date;
  intervalMs?: number;
}) {
  const { db, reservations, visits, transitions, dispatch } = opts;
  const now = opts.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;

  function reservationEvent(id: string, reason: string, at: Date, failed = false) {
    // The durable audit marker survives restarts; an immediate transaction
    // serializes reminder claims across independent scheduler instances.
    const event = db.transaction((tx) => {
      const row = tx.select().from(t.visitReservation).where(eq(t.visitReservation.id, id)).get();
      if (!row || row.status !== "confirmed" || (failed && row.visitId !== null)) return;
      if (tx.select().from(t.auditEvent).where(and(
        eq(t.auditEvent.entityType, "visit_reservation"), eq(t.auditEvent.entityId, id), eq(t.auditEvent.reason, reason),
      )).get()) return;
      const event = makeTransitionEvent({ entityType: "visit_reservation", entityId: id,
        fromState: "confirmed", toState: failed ? "cancelled" : "confirmed", reason,
        actorType: "system", actorId: "reservation_scheduler", correlationId: id, now: () => at,
      });
      if (failed) tx.update(t.visitReservation).set({ status: "cancelled", cancelledAt: at.toISOString(),
        cancellationReason: reason, updatedAt: at.toISOString(),
      }).where(eq(t.visitReservation.id, id)).run();
      tx.insert(t.auditEvent).values(event).run();
      return event;
    }, { behavior: "immediate" });
    if (event) transitions.emit(event);
  }

  function onTransition(event: AuditEvent) {
    if (event.entityType !== "visit_reservation" || event.toState !== "cancelled") return;
    const reservation = db.select().from(t.visitReservation).where(eq(t.visitReservation.id, event.entityId)).get();
    const visit = reservation?.visitId ? visits.get(reservation.visitId) : undefined;
    if (!visit || (VISIT_TERMINAL_STATES as readonly string[]).includes(visit.state)) return;
    // A targeted cancel uses the existing gateway safety path and cannot stop
    // an unrelated task on this robot. The visit event also notifies staff.
    dispatch.cancelVisit(visit.id);
    transitions.apply({ entityType: "visit", entityId: visit.id, to: "safety_stopped",
      actorType: "system", actorId: "reservation_scheduler", reason: "reservation_cancelled_after_dispatch",
    });
  }
  let unsubscribe: (() => void) | undefined = transitions.subscribe(onTransition);

  function tick(at: Date = now()): void {
    if (ticking) return;
    ticking = true;
    try {
      reservations.expirePending(at);
      const atIso = at.toISOString();
      const reminders = db.select().from(t.visitReservation).where(and(
        eq(t.visitReservation.status, "confirmed"), lte(t.visitReservation.reminderAt, atIso),
      )).all();
      for (const row of reminders) reservationEvent(row.id, "reservation_reminder", at);
      const due = db.select().from(t.visitReservation).where(and(
        eq(t.visitReservation.status, "confirmed"), isNull(t.visitReservation.visitId), lte(t.visitReservation.dispatchAt, atIso),
      )).all();
      for (const row of due) {
        const result = visits.createScheduled({ residentId: row.residentId, familyUserId: row.familyUserId,
          scheduledStartAt: row.startAt, reservationId: row.id,
        });
        if (result.ok) reservationEvent(row.id, "reservation_activated", at);
        else if (result.error !== "invalid_reservation") reservationEvent(row.id, "reservation_activation_failed", at, true);
      }
    } finally { ticking = false; }
  }

  function start() {
    if (timer) return;
    unsubscribe ??= transitions.subscribe(onTransition);
    timer = setInterval(() => tick(), opts.intervalMs ?? 1000);
    timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
  }

  return { tick, start, stop };
}
