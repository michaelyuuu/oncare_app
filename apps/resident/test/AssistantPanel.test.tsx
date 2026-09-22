import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, type Api } from "@oncare/web-common";
import * as assistantModule from "../src/assistant";
import { AssistantActionConfirmation } from "../src/components/AssistantActionConfirmation";
import { AssistantPanel } from "../src/components/AssistantPanel";
import { requestStaffHelp } from "../src/assistant";
import { Home } from "../src/screens/Home";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function apiFor(inputResult: unknown = {
  kind: "tool_result",
  tool: "request_staff_help",
  status: 200,
  response: {
    ok: true,
    result: {
      requestId: "help_" + "a".repeat(32),
      request: { deliveryState: "pending", handlingState: "open", persistenceState: "recorded" },
    },
  },
}) {
  const post = vi.fn(async (path: string, _body?: unknown) => {
    if (path === "/assistant/sessions") return { session: { sessionId: "conv_1", state: "listening", mode: "simulated", provider: "fake" } };
    if (path.includes("/input")) return { session: { sessionId: "conv_1", state: "responding" }, result: inputResult };
    return { session: { sessionId: "conv_1", state: "closed" } };
  });
  const api = {
    get: vi.fn(async (path: string) => path === "/capabilities" ? { voice_conversation: { state: "available" } } : {}),
    post,
    patch: vi.fn(),
    del: vi.fn(),
  } as unknown as Api;
  return { api, post };
}

const futureExpiry = () => new Date(Date.now() + 60_000).toISOString();

describe("resident assistant surface", () => {
  test("Home exposes Talk to Ontaru while keeping the help action available", () => {
    const onAssistant = vi.fn();
    const onHelp = vi.fn();
    render(<Home name="Demo Resident" now={0} onOpenAssistant={onAssistant} onHelpStaff={onHelp} />);
    expect(screen.getByRole("button", { name: "Talk to Ontaru" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "I need help" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Talk to Ontaru" }));
    expect(onAssistant).toHaveBeenCalledTimes(1);
  });

  test("confirmation visuals and handlers respect the parent disabled state", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<AssistantActionConfirmation
      actionId="act_disabled"
      summary="Propose a visit?"
      expiresAt={futureExpiry()}
      disabled
      onConfirm={onConfirm}
      onCancel={onCancel}
      onExpire={vi.fn()}
    />);

    const confirm = screen.getByRole("button", { name: "Confirm" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(confirm).toBeDisabled();
    expect(cancel).toBeDisabled();
    fireEvent.click(confirm);
    fireEvent.click(cancel);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  test("Talk uses the communication shell and keeps text fallback when live voice is unavailable", async () => {
    const { api, post } = apiFor();
    render(<AssistantPanel api={api} residentName="Demo Resident" disabled={false} onClose={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Stop listening" })).toBeInTheDocument();
    expect(await screen.findByTestId("assistant-text-fallback")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Type a message" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Type a message" }), { target: { value: "Please get staff help" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/assistant/sessions/conv_1/input", { text: "Please get staff help" }));
    expect(await screen.findByText(/Request recorded/)).toBeInTheDocument();
    expect(screen.queryByText(/acknowledged/i)).not.toBeInTheDocument();
  });

  test("simulated scheduling renders touch confirmation, confirms through the action endpoint, and does not open another microphone", async () => {
    const { api, post } = apiFor({
      kind: "tool_result",
      tool: "propose_visit_time",
      status: 200,
      response: {
        ok: true,
        needsConfirmation: true,
        actionId: "act_schedule_1",
        summary: "Propose a one-hour ON 0 visit with Demo Daughter on September 22, 2026 at 9:00 AM local time?",
        expiresAt: futureExpiry(),
      },
    });
    render(<AssistantPanel api={api} residentName="Demo Resident" disabled={false} onClose={vi.fn()} />);
    const input = await screen.findByRole("textbox", { name: "Type a message" });
    fireEvent.change(input, { target: { value: "Schedule a visit" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/one-hour ON 0 visit with Demo Daughter/)).toBeInTheDocument();
    expect(screen.getByText(/Expires/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/tools/actions/act_schedule_1/confirm", {}));
    expect(await screen.findByText("Visit proposal sent.")).toBeInTheDocument();
    expect(post.mock.calls.filter(([path, body]) => path === "/assistant/sessions" && (body as { mode?: string } | undefined)?.mode === "live")).toHaveLength(1);
  });

  test("a scheduling confirmation expires on screen, is cleared, and does not open another microphone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T00:00:00.000Z"));
    let realtimeOptions: assistantModule.AssistantRealtimeOptions | undefined;
    const startRealtime = vi.fn(async (options?: assistantModule.AssistantRealtimeOptions) => {
      realtimeOptions = options;
      return { sessionId: "live_expiry", state: "listening", mode: "live", provider: "openai_realtime" };
    });
    vi.spyOn(assistantModule, "createAssistantClient").mockReturnValue({
      startFakeSession: vi.fn(),
      startRealtime,
      sendText: vi.fn(),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      reset: vi.fn(),
    });
    const post = vi.fn();
    const api = { get: vi.fn(), post, patch: vi.fn(), del: vi.fn() } as unknown as Api;
    render(<AssistantPanel api={api} residentName="Demo Resident" disabled={false} onClose={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    act(() => realtimeOptions?.onToolResult?.({
      result: {
        ok: true,
        needsConfirmation: true,
        actionId: "act_expiring",
        summary: "Propose a one-hour ON 0 visit with Demo Daughter?",
        expiresAt: "2026-09-22T00:00:01.000Z",
      },
    }));
    expect(screen.getByRole("button", { name: "Confirm" })).toBeEnabled();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.queryByRole("group", { name: "Visit scheduling confirmation" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("expired");
    expect(post).not.toHaveBeenCalled();
    expect(startRealtime).toHaveBeenCalledTimes(1);
  });

  test("HTTP 410 clears the stale confirmation and announces that it expired", async () => {
    let realtimeOptions: assistantModule.AssistantRealtimeOptions | undefined;
    const startRealtime = vi.fn(async (options?: assistantModule.AssistantRealtimeOptions) => {
      realtimeOptions = options;
      return { sessionId: "live_410", state: "listening", mode: "live", provider: "openai_realtime" };
    });
    vi.spyOn(assistantModule, "createAssistantClient").mockReturnValue({
      startFakeSession: vi.fn(),
      startRealtime,
      sendText: vi.fn(),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      reset: vi.fn(),
    });
    const post = vi.fn(async () => { throw new ApiError(410, "expired"); });
    const api = { get: vi.fn(), post, patch: vi.fn(), del: vi.fn() } as unknown as Api;
    render(<AssistantPanel api={api} residentName="Demo Resident" disabled={false} onClose={vi.fn()} />);
    await waitFor(() => expect(startRealtime).toHaveBeenCalledTimes(1));

    act(() => realtimeOptions?.onToolResult?.({
      result: {
        ok: true,
        needsConfirmation: true,
        actionId: "act_server_expired",
        summary: "Propose a one-hour ON 0 visit with Demo Daughter?",
        expiresAt: futureExpiry(),
      },
    }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("expired"));
    expect(screen.queryByRole("group", { name: "Visit scheduling confirmation" })).toBeNull();
    expect(post).toHaveBeenCalledWith("/tools/actions/act_server_expired/confirm", {});
    expect(startRealtime).toHaveBeenCalledTimes(1);
  });

  test("simulated scheduling cancellation calls the cancel endpoint and announces the result", async () => {
    const { api, post } = apiFor({
      kind: "tool_result",
      tool: "propose_visit_time",
      status: 200,
      response: {
        ok: true,
        needsConfirmation: true,
        actionId: "act_schedule_2",
        summary: "Propose a one-hour ON 0 visit with Demo Daughter tomorrow at 10:00 AM local time?",
        expiresAt: futureExpiry(),
      },
    });
    render(<AssistantPanel api={api} residentName="Demo Resident" disabled={false} onClose={vi.fn()} />);
    const input = await screen.findByRole("textbox", { name: "Type a message" });
    fireEvent.change(input, { target: { value: "Schedule a visit" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/tools/actions/act_schedule_2/cancel", {}));
    expect(await screen.findByText("Visit proposal cancelled.")).toBeInTheDocument();
  });

  test("realtime tool results render the same confirmation without starting another voice session", async () => {
    let realtimeOptions: assistantModule.AssistantRealtimeOptions | undefined;
    const startRealtime = vi.fn(async (options?: assistantModule.AssistantRealtimeOptions) => {
      realtimeOptions = options;
      return { sessionId: "live_1", state: "listening", mode: "live", provider: "openai_realtime" };
    });
    vi.spyOn(assistantModule, "createAssistantClient").mockReturnValue({
      startFakeSession: vi.fn(),
      startRealtime,
      sendText: vi.fn(),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      reset: vi.fn(),
    });
    const post = vi.fn(async () => ({ result: { cancelled: true } }));
    const api = { get: vi.fn(), post, patch: vi.fn(), del: vi.fn() } as unknown as Api;
    render(<AssistantPanel api={api} residentName="Demo Resident" disabled={false} onClose={vi.fn()} />);
    await waitFor(() => expect(startRealtime).toHaveBeenCalledTimes(1));

    act(() => realtimeOptions?.onToolResult?.({
      result: {
        ok: true,
        needsConfirmation: true,
        actionId: "act_realtime_1",
        summary: "Propose a one-hour ON 0 visit with Demo Daughter at 11:00 AM local time?",
        expiresAt: futureExpiry(),
      },
    }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/tools/actions/act_realtime_1/cancel", {}));
    expect(startRealtime).toHaveBeenCalledTimes(1);
  });

  test("an auth failure clears the session context instead of retaining a request id", async () => {
    const { api, post } = apiFor();
    render(<AssistantPanel api={api} residentName="Demo Resident" disabled={false} onClose={vi.fn()} />);
    const input = await screen.findByRole("textbox", { name: "Type a message" });
    fireEvent.change(input, { target: { value: "Please get staff help" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/Request recorded/)).toBeInTheDocument();

    post.mockImplementation(async (path: string) => {
      if (path === "/assistant/sessions") return { session: { sessionId: "conv_1", state: "listening", mode: "simulated", provider: "fake" } };
      const error = new Error("401 unauthorized");
      Object.assign(error, { status: 401 });
      throw error;
    });
    fireEvent.change(input, { target: { value: "Try again" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/Assistant unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/help_[a-f0-9]{32}/)).not.toBeInTheDocument();
  });

  test("touch Help re-reads authoritative request evidence after creating the request", async () => {
    const post = vi.fn(async () => ({ request: { id: "help_1" } }));
    const get = vi.fn(async () => ({ request: { persistenceState: "recorded", deliveryState: "pending", handlingState: "open" } }));
    const api = { get, post, patch: vi.fn(), del: vi.fn() } as unknown as Api;
    await requestStaffHelp(api, "touch-1");
    expect(post).toHaveBeenCalledWith("/assistance-requests", { category: "general_assistance" }, { headers: { "Idempotency-Key": "touch-1" } });
    expect(get).toHaveBeenCalledWith("/assistance-requests/help_1");
  });
});
