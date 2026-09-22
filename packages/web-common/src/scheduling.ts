import type { VisitBlockReason } from "@oncare/core";

export const RESERVATION_STATUSES = ["pending", "confirmed", "expired", "cancelled"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const VISIT_SLOT_STATES = ["available", "blocked", "pending", "confirmed"] as const;
export type VisitSlotState = (typeof VISIT_SLOT_STATES)[number];

export type ReservationParticipantKind = "family" | "device";
export type ReservationCancellationActorKind = ReservationParticipantKind | "staff" | "admin";

export interface VisitContact {
  userId: string;
  displayName: string;
  label: string;
}

export interface VisitSlot {
  localDate: string;
  startMinute: number;
  endMinute: number;
  startAt: string;
  endAt: string;
  state: VisitSlotState;
  reason?: VisitBlockReason;
  reservationId?: string;
}

export interface VisitReservationView {
  id: string;
  residentId: string;
  residentDisplayName: string;
  familyUserId: string;
  familyDisplayName: string;
  robotId: string;
  robotName: string;
  proposerKind: ReservationParticipantKind;
  proposerId: string;
  status: ReservationStatus;
  startAt: string;
  endAt: string;
  timeZone: string;
  expiresAt: string;
  reminderAt: string | null;
  dispatchAt: string | null;
  confirmedAt: string | null;
  confirmedByKind: ReservationParticipantKind | null;
  confirmedById: string | null;
  cancelledAt: string | null;
  cancelledByKind: ReservationCancellationActorKind | null;
  cancelledById: string | null;
  cancellationReason: string | null;
  supersedesId: string | null;
  visitId: string | null;
  createdAt: string;
  updatedAt: string;
}
