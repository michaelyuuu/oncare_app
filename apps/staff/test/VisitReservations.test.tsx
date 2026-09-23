import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import type { VisitReservationView } from "@oncare/web-common";
import { Queue } from "../src/components/Queue";
import type { QueueData } from "../src/types";

const reservation: VisitReservationView = {
  id: "reservation-1",
  residentId: "resident-1",
  residentDisplayName: "Demo Resident",
  familyUserId: "family-1",
  familyDisplayName: "Demo Daughter",
  robotId: "robot-1",
  robotName: "ON 0",
  proposerKind: "family",
  proposerId: "family-1",
  status: "confirmed",
  startAt: "2026-09-23T01:00:00.000Z",
  endAt: "2026-09-23T02:00:00.000Z",
  timeZone: "Asia/Taipei",
  expiresAt: "2026-09-22T00:05:00.000Z",
  reminderAt: "2026-09-22T00:50:00.000Z",
  dispatchAt: "2026-09-22T00:55:00.000Z",
  confirmedAt: "2026-09-22T00:01:00.000Z",
  confirmedByKind: "device",
  confirmedById: "resident-1",
  cancelledAt: null,
  cancelledByKind: null,
  cancelledById: null,
  cancellationReason: null,
  supersedesId: null,
  visitId: "visit-1",
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: "2026-09-22T00:01:00.000Z",
};

afterEach(cleanup);

test("staff sees upcoming reservations, can cancel one, and sees dispatch failure evidence", async () => {
  const onAction = vi.fn(async () => {});
  const queue = {
    visitsAwaitingApproval: [],
    tasksAwaitingApproval: [],
    tasksAwaitingLoad: [],
    tasksAwaitingHandoff: [],
    activeVisits: [],
    caregiverCalls: [],
    reservations: [reservation],
    dispatchFailures: [{
      id: "failure-1",
      reservationId: reservation.id,
      visitId: reservation.visitId,
      residentId: reservation.residentId,
      residentDisplayName: reservation.residentDisplayName,
      at: "2026-09-22T00:56:00.000Z",
      reason: "robot_not_ready",
    }],
    robot: null,
  } as unknown as QueueData;

  render(<Queue queue={queue} onAction={onAction} pending={[]} errors={{}} />);
  expect(screen.getByText("Upcoming visit")).toBeInTheDocument();
  expect(screen.getAllByText("Resident: Demo Resident")).toHaveLength(2);
  expect(screen.getByText("Family: Demo Daughter")).toBeInTheDocument();
  expect(screen.getByText("Robot dispatch failed")).toBeInTheDocument();
  expect(screen.getByText("Reason: robot_not_ready")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Cancel reservation" }));
  expect(onAction).toHaveBeenCalledWith("/visit-reservations/reservation-1/cancel");
});
