import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Api, VisitReservationView, VisitSlot } from "@oncare/web-common";
import { ScheduleVisit } from "../src/pages/ScheduleVisit";
import { IncomingVisit } from "../src/pages/IncomingVisit";
import { VisitReservationCard } from "../src/components/VisitReservationCard";

const slot = (startMinute: number, state: VisitSlot["state"] = "available", reason?: VisitSlot["reason"]): VisitSlot => ({
  localDate: "2026-09-22",
  startMinute,
  endMinute: startMinute + 60,
  startAt: new Date(Date.UTC(2026, 8, 22, Math.floor((startMinute - 480) / 60), (startMinute - 480) % 60)).toISOString(),
  endAt: new Date(Date.UTC(2026, 8, 22, Math.floor((startMinute - 480) / 60) + 1, (startMinute - 480) % 60)).toISOString(),
  state,
  ...(reason ? { reason } : {}),
});

const reservation: VisitReservationView = {
  id: "family-reservation-1",
  residentId: "resident-1",
  residentDisplayName: "Mom",
  familyUserId: "family-1",
  familyDisplayName: "Amy",
  robotId: "robot-1",
  robotName: "ON 0",
  proposerKind: "family",
  proposerId: "family-1",
  status: "pending",
  startAt: "2026-09-23T01:00:00.000Z",
  endAt: "2026-09-23T02:00:00.000Z",
  timeZone: "Asia/Taipei",
  expiresAt: "2026-09-22T00:05:00.000Z",
  reminderAt: null,
  dispatchAt: null,
  confirmedAt: null,
  confirmedByKind: null,
  confirmedById: null,
  cancelledAt: null,
  cancelledByKind: null,
  cancelledById: null,
  cancellationReason: null,
  supersedesId: null,
  visitId: null,
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: "2026-09-22T00:00:00.000Z",
};

afterEach(cleanup);

test("renders the family landscape calendar and proposes one selected slot", async () => {
  const post = vi.fn().mockResolvedValue({ reservation });
  const api = {
    get: vi.fn().mockImplementation(async (path: string) => path === "/visit-reservations"
      ? { reservations: [] }
      : { timeZone: "Asia/Taipei", slots: [slot(540), slot(600), slot(660), slot(720, "blocked", "lunch"), slot(780), slot(840), slot(900), slot(960, "blocked", "staff_handoff"), slot(1020, "blocked", "dinner_quiet")] }),
    post,
  } as unknown as Api;
  render(<ScheduleVisit api={api} residentId="resident-1" residentName="Mom" onBack={vi.fn()} onCreated={vi.fn()} onImmediate={vi.fn()} />);

  expect(await screen.findByRole("heading", { name: "Schedule a visit with Mom" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "9:00 AM" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /12:00 PM, Lunch/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "9:00 AM" }));
  fireEvent.click(screen.getByRole("button", { name: "Request this time" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/visit-reservations", { residentId: "resident-1", localDate: "2026-09-22", startMinute: 540 }));
});

test("family reservation card posts confirm and cancel actions", async () => {
  const post = vi.fn().mockResolvedValue({ reservation });
  const api = { post } as unknown as Api;
  render(<VisitReservationCard api={api} reservation={reservation} now={Date.parse("2026-09-22T00:00:00.000Z")} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Confirm time" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/visit-reservations/family-reservation-1/confirm", {}));
  cleanup();
  render(<VisitReservationCard api={api} reservation={{ ...reservation, status: "confirmed" }} now={Date.parse("2026-09-22T00:00:00.000Z")} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/visit-reservations/family-reservation-1/cancel", {}));
});

test("incoming resident call answers through the family-specific action", async () => {
  const post = vi.fn().mockResolvedValue({ visit: { id: "visit-1", state: "connecting" } });
  const api = {
    get: vi.fn().mockResolvedValue({ visit: { id: "visit-1", state: "awaiting_family_consent", residentId: "resident-1" } }),
    post,
  } as unknown as Api;
  const onAnswered = vi.fn();
  render(<IncomingVisit api={api} visitId="visit-1" residentName="Mom" onAnswered={onAnswered} onDeclined={vi.fn()} />);
  expect(await screen.findByText("Mom is calling from ON 0")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Answer" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/visits/visit-1/answer_family", {}));
  expect(onAnswered).toHaveBeenCalledWith("visit-1");
});
