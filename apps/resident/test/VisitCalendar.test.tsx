import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Api, VisitReservationView, VisitSlot } from "@oncare/web-common";
import "../src/styles.css";
import { VisitReservationCard } from "../src/components/VisitReservationCard";
import { VisitCalendar } from "../src/screens/VisitCalendar";

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
  id: "reservation-1",
  residentId: "resident-1",
  residentDisplayName: "Demo Resident",
  familyUserId: "family-1",
  familyDisplayName: "Amy",
  robotId: "robot-1",
  robotName: "ON 0",
  proposerKind: "device",
  proposerId: "device-1",
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

afterEach(() => { cleanup(); vi.useRealTimers(); });

test("renders a landscape date rail, blocked periods, and one-contact request action", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-22T00:00:00.000Z"));
  const post = vi.fn().mockResolvedValue({ reservation });
  const api = {
    get: vi.fn().mockResolvedValue({ timeZone: "Asia/Taipei", slots: [slot(540), slot(720, "blocked", "lunch"), slot(780)] }),
    post,
  } as unknown as Api;
  const onChanged = vi.fn();
  render(<VisitCalendar
    api={api}
    residentId="resident-1"
    timeZone="Asia/Taipei"
    contacts={[
      { userId: "family-1", displayName: "Amy", label: "daughter" },
      { userId: "blocked", displayName: "Not Approved", label: "friend", consentVideo: false },
    ]}
    reservations={[]}
    onClose={vi.fn()}
    onChanged={onChanged}
  />);

  expect(await screen.findByRole("heading", { name: "Choose a visit time" })).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: /Amy/ })).toBeInTheDocument();
  expect(screen.queryByRole("radio", { name: /Not Approved/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /12:00 PM, Lunch/ })).toBeDisabled();

  fireEvent.click(screen.getByRole("radio", { name: /Amy/ }));
  fireEvent.click(screen.getByRole("button", { name: "9:00 AM" }));
  fireEvent.click(screen.getByRole("button", { name: "Request this time" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/visit-reservations", {
    contactUserId: "family-1",
    localDate: "2026-09-22",
    startMinute: 540,
  }));
  expect(onChanged).toHaveBeenCalledTimes(1);
});

test("does not duplicate a pending reservation request", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-22T00:00:00.000Z"));
  let resolve: (value: unknown) => void = () => {};
  const post = vi.fn(() => new Promise((done) => { resolve = done; }));
  const api = {
    get: vi.fn().mockResolvedValue({ timeZone: "Asia/Taipei", slots: [slot(540)] }),
    post,
  } as unknown as Api;
  render(<VisitCalendar
    api={api}
    residentId="resident-1"
    timeZone="Asia/Taipei"
    contacts={[{ userId: "family-1", displayName: "Amy", label: "daughter" }]}
    reservations={[]}
    onClose={vi.fn()}
    onChanged={vi.fn()}
  />);
  fireEvent.click(await screen.findByRole("radio", { name: /Amy/ }));
  fireEvent.click(screen.getByRole("button", { name: "9:00 AM" }));
  const request = screen.getByRole("button", { name: "Request this time" });
  fireEvent.click(request);
  fireEvent.click(request);
  expect(post).toHaveBeenCalledTimes(1);
  resolve({ reservation });
});

test("shows the five-minute pending countdown and reservation actions", async () => {
  const post = vi.fn().mockResolvedValue({ reservation });
  const api = { post } as unknown as Api;
  render(<VisitReservationCard api={api} reservation={reservation} now={Date.parse("2026-09-22T00:00:00.000Z")} onChanged={vi.fn()} />);

  expect(screen.getByRole("status")).toHaveTextContent("05:00");
  fireEvent.click(screen.getByRole("button", { name: "Confirm time" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/visit-reservations/reservation-1/confirm", {}));
});

test("keeps the resident date rail bounded and vertically scrollable", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-22T00:00:00.000Z"));
  const api = { get: vi.fn().mockResolvedValue({ timeZone: "Asia/Taipei", slots: [] }) } as unknown as Api;
  const { container } = render(<VisitCalendar
    api={api}
    residentId="resident-1"
    timeZone="Asia/Taipei"
    contacts={[]}
    reservations={[]}
    onClose={vi.fn()}
    onChanged={vi.fn()}
  />);

  const dateRail = screen.getByRole("navigation", { name: "Visit dates" });
  const rail = container.querySelector(".visit-calendar__rail");
  expect(dateRail.querySelectorAll(".visit-date-rail__day")).toHaveLength(14);
  expect(rail).not.toBeNull();
  expect(getComputedStyle(rail!).maxHeight).toBe("calc(100dvh - 150px)");
  expect(getComputedStyle(dateRail).overflowY).toBe("auto");
  expect(getComputedStyle(dateRail).flexGrow).toBe("1");
});

test("resident date rail stays anchored when selecting the final date in its booking window", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-22T00:00:00.000Z"));
  const windowSlots = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 8, 22 + index)).toISOString().slice(0, 10);
    return { ...slot(540), localDate: date };
  });
  const get = vi.fn().mockImplementation(async (path: string) => {
    const from = new URLSearchParams(path.split("?")[1] ?? "").get("from") ?? "2026-09-22";
    return { timeZone: "Asia/Taipei", slots: windowSlots.filter((item) => item.localDate >= from) };
  });
  const api = { get } as unknown as Api;
  render(<VisitCalendar
    api={api}
    residentId="resident-1"
    timeZone="Asia/Taipei"
    contacts={[]}
    reservations={[]}
    onClose={vi.fn()}
    onChanged={vi.fn()}
  />);

  const firstDate = "resident-date-2026-09-22";
  const finalDate = "resident-date-2026-10-05";
  fireEvent.click(await screen.findByTestId(finalDate));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(screen.getByTestId(firstDate)).toBeInTheDocument();
  expect(screen.getByTestId(finalDate)).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByTestId(firstDate));
  expect(screen.getByTestId(firstDate)).toHaveAttribute("aria-pressed", "true");
  const slotQueries = get.mock.calls.map(([path]) => path);
  expect(slotQueries.every((path) => path.endsWith("from=2026-09-22"))).toBe(true);
});
