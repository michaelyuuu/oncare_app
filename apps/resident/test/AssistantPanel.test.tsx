import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Api } from "@oncare/web-common";
import { AssistantPanel } from "../src/components/AssistantPanel";
import { requestStaffHelp } from "../src/assistant";
import { Home } from "../src/screens/Home";

afterEach(cleanup);

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
  const post = vi.fn(async (path: string) => {
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

describe("resident assistant surface", () => {
  test("Home exposes Talk to Ontaru while keeping family and staff actions available", () => {
    const onAssistant = vi.fn();
    const onCaregiver = vi.fn();
    const onHelp = vi.fn();
    render(<Home name="Demo Resident" now={0} onOpenAssistant={onAssistant} onCallCaregiver={onCaregiver} onHelpStaff={onHelp} />);
    expect(screen.getByRole("button", { name: "Talk to Ontaru" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Call a caregiver" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "I need help" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Talk to Ontaru" }));
    expect(onAssistant).toHaveBeenCalledTimes(1);
  });

  test("panel offers text fallback and Stop, and calls the fake session", async () => {
    const { api, post } = apiFor();
    render(<AssistantPanel api={api} residentName="Demo Resident" disabled={false} onClose={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Talk to Ontaru" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Type a message" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Type a message" }), { target: { value: "Please get staff help" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/assistant/sessions/conv_1/input", { text: "Please get staff help" }));
    expect(await screen.findByText(/Request recorded/)).toBeInTheDocument();
    expect(screen.queryByText(/acknowledged/i)).not.toBeInTheDocument();
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
