import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { Queue } from "../src/components/Queue";
import type { QueueData } from "../src/types";

afterEach(cleanup);

test("staff can acknowledge a recorded assistance request with its current version", async () => {
  const onAction = vi.fn(async () => {});
  const queue = {
    visitsAwaitingApproval: [],
    tasksAwaitingApproval: [],
    tasksAwaitingLoad: [],
    tasksAwaitingHandoff: [],
    activeVisits: [],
    caregiverCalls: [],
    robot: null,
    assistanceRequests: [{
      id: "help_1",
      residentId: "resident_1",
      category: "general_assistance",
      note: null,
      persistenceState: "recorded",
      deliveryState: "pending",
      handlingState: "open",
      withdrawalState: "none",
      version: 1,
      createdAt: "2026-09-19T00:00:00.000Z",
      updatedAt: "2026-09-19T00:00:00.000Z",
    }],
  } as QueueData;

  render(<Queue queue={queue} onAction={onAction} pending={[]} errors={{}} />);
  expect(screen.getByText("Request recorded")).toBeInTheDocument();
  expect(screen.getByText("Resident ID")).toBeInTheDocument();
  expect(screen.getByText("resident_1")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Acknowledge request" }));
  expect(onAction).toHaveBeenCalledWith("/staff/assistance-requests/help_1/acknowledge", { version: 1 });
});
