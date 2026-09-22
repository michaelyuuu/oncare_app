import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { StrictMode } from "react";
import type { Api } from "@oncare/web-common";

const mocks = vi.hoisted(() => {
  const client = {
    startFakeSession: vi.fn(async () => ({ sessionId: "fake", state: "listening", mode: "simulated", provider: "fake" })),
    startRealtime: vi.fn(async () => ({ sessionId: "live", state: "listening", mode: "live", provider: "openai_realtime" })),
    sendText: vi.fn(async () => ({})),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    reset: vi.fn(),
  };
  return { client };
});

vi.mock("../src/assistant", () => ({
  createAssistantClient: () => mocks.client,
  requestStaffHelp: vi.fn(),
}));

import { AssistantPanel } from "../src/components/AssistantPanel";

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.clearAllMocks();
});

describe("resident assistant lifecycle", () => {
  test("opens one realtime session when React replays effects in StrictMode", async () => {
    render(<StrictMode><AssistantPanel api={{} as Api} residentName="Demo Resident" disabled={false} onClose={vi.fn()} /></StrictMode>);
    await waitFor(() => expect(mocks.client.startRealtime).toHaveBeenCalledTimes(1));
    expect(mocks.client.close).not.toHaveBeenCalled();
  });

  test("closes a realtime session that finishes starting after unmount", async () => {
    let finishStart: ((session: { sessionId: string; state: string; mode: string; provider: string }) => void) | undefined;
    mocks.client.startRealtime.mockImplementationOnce(() => new Promise((resolve) => { finishStart = resolve; }));
    const view = render(<AssistantPanel api={{} as Api} residentName="Demo Resident" disabled={false} onClose={vi.fn()} />);
    await waitFor(() => expect(mocks.client.startRealtime).toHaveBeenCalledTimes(1));

    view.unmount();
    await waitFor(() => expect(mocks.client.close).toHaveBeenCalledTimes(1));
    await act(async () => {
      finishStart?.({ sessionId: "live", state: "listening", mode: "live", provider: "openai_realtime" });
    });

    await waitFor(() => expect(mocks.client.close).toHaveBeenCalledTimes(2));
  });
});
