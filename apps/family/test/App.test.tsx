import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError, type Api } from "@oncare/web-common";

const callMock = vi.hoisted(() => ({ createCall: vi.fn(), callbacks: undefined as any }));
vi.mock("@oncare/web-common", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oncare/web-common")>();
  return { ...original, createCall: callMock.createCall };
});

import { App } from "../src/App";
import { Visit } from "../src/pages/Visit";

type Handler = (path: string, init?: RequestInit) => { status: number; body: unknown };
function installFetch(handler: Handler) {
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace("http://api", "");
    calls.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: String(init.body) } : {}) });
    const r = handler(path, init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }));
  return calls;
}
class NoopSocket { onopen: unknown; onmessage: unknown; onclose: unknown; constructor(_url: string) {} close() {} }
beforeEach(() => {
  try { sessionStorage.clear(); } catch {}
  vi.stubGlobal("WebSocket", NoopSocket);
  callMock.callbacks = undefined;
  callMock.createCall.mockReset().mockImplementation(async (_url, _token, callbacks) => {
    callMock.callbacks = callbacks;
    callbacks.onLocalState({ camera: true, mic: true });
    return { setVolume: vi.fn(), setMic: vi.fn(async () => {}), setCamera: vi.fn(async () => {}), localVideoElement: () => document.createElement("video"), leave: vi.fn(async () => {}) };
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const resident = { id: "resident_demo_01", displayName: "Mom", availability: "available", relationship: { label: "daughter", consentVideo: true, consentRobotVisit: true, consentItemDelivery: true } };

test("login -> residents -> request a visit -> remote presence advances the live stepper", async () => {
  let state = "accepted";
  const calls = installFetch((path, init) => {
    if (path === "/auth/login") return init?.body?.toString().includes("family-demo-pass") ? { status: 200, body: { token: "jwt", principal: { kind: "user", id: "family_demo_01", role: "family", displayName: "Demo Daughter" } } } : { status: 401, body: { error: "invalid_credentials" } };
    if (path === "/me/residents") return { status: 200, body: { residents: [resident] } };
    if (path === "/visits" && init?.method === "POST") return { status: 201, body: { visit: { id: "v1", state, residentId: resident.id, simulated: true } } };
    if (path === "/visits/v1") return { status: 200, body: { visit: { id: "v1", state, residentId: resident.id, simulated: true } } };
    if (path === "/visits/v1/token") return { status: 200, body: { url: "wss://video.example", token: "token", room: "v1" } };
    if (path === "/visits/v1/connected") { state = "active"; return { status: 200, body: { visit: { id: "v1", state } } }; }
    return { status: 404, body: { error: "not_found" } };
  });
  render(<App apiBase="http://api" />);
  await userEvent.type(screen.getByLabelText("Username"), "family");
  await userEvent.type(screen.getByLabelText("Password"), "wrong");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByText("Wrong username or password")).toBeInTheDocument();
  await userEvent.clear(screen.getByLabelText("Password"));
  await userEvent.type(screen.getByLabelText("Password"), "family-demo-pass");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByText("Mom")).toBeInTheDocument();
  expect(screen.getByText("Available")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Send the robot to visit" }));
  expect(await screen.findByText("Visit with Mom")).toBeInTheDocument();
  expect(screen.getByText("SIMULATED ROBOT")).toBeInTheDocument();
  expect(screen.getByText("Robot is on its way")).toHaveAttribute("aria-current", "step");
  state = "connecting";
  await waitFor(() => expect(callMock.createCall).toHaveBeenCalled(), { timeout: 6000 });
  expect(calls.some((c) => c.path === "/visits/v1/connected")).toBe(false);
  act(() => callMock.callbacks.onRemoteParticipant(true));
  await waitFor(() => expect(calls.some((c) => c.path === "/visits/v1/connected" && c.method === "POST")).toBe(true));
  expect(await screen.findByText("On the call")).toHaveAttribute("aria-current", "step");
});

test("a failed visit shows the reason on the failed step and no robot controls exist anywhere", async () => {
  try { sessionStorage.setItem("oncare.family", JSON.stringify({ token: "jwt", displayName: "Demo Daughter" })); } catch {}
  installFetch((path) => {
    if (path === "/me/residents") return { status: 200, body: { residents: [resident] } };
    if (path === "/visits/v9") return { status: 200, body: { visit: { id: "v9", state: "navigation_failed", residentId: resident.id, simulated: false } } };
    return { status: 404, body: { error: "not_found" } };
  });
  render(<App apiBase="http://api" initialVisitId="v9" />);
  expect(await screen.findByText("The robot could not reach the room")).toBeInTheDocument();
  expect(screen.queryByText(/joystick|drive|arm|joint/i)).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel visit" })).toBeNull();
});

test("resident not available disables the visit button", async () => {
  try { sessionStorage.setItem("oncare.family", JSON.stringify({ token: "jwt", displayName: "Demo Daughter" })); } catch {}
  installFetch((path) => path === "/me/residents" ? { status: 200, body: { residents: [{ ...resident, availability: "not_available" }] } } : { status: 404, body: {} });
  render(<App apiBase="http://api" />);
  expect(await screen.findByRole("button", { name: "Send the robot to visit" })).toBeDisabled();
  expect(screen.getByText("Not available")).toBeInTheDocument();
});

test("an unknown visit API error displays its raw code", async () => {
  try { sessionStorage.setItem("oncare.family", JSON.stringify({ token: "jwt", displayName: "Demo Daughter" })); } catch {}
  installFetch((path, init) => {
    if (path === "/me/residents") return { status: 200, body: { residents: [resident] } };
    if (path === "/visits" && init?.method === "POST") return { status: 409, body: { error: "future_policy_code" } };
    return { status: 404, body: {} };
  });
  render(<App apiBase="http://api" />);
  await userEvent.click(await screen.findByRole("button", { name: "Send the robot to visit" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("future_policy_code");
});

test("a known visit API error retains its localized message", async () => {
  try { sessionStorage.setItem("oncare.family", JSON.stringify({ token: "jwt", displayName: "Demo Daughter" })); } catch {}
  installFetch((path, init) => {
    if (path === "/me/residents") return { status: 200, body: { residents: [resident] } };
    if (path === "/visits" && init?.method === "POST") return { status: 409, body: { error: "robot_unavailable" } };
    return { status: 404, body: {} };
  });
  render(<App apiBase="http://api" />);
  await userEvent.click(await screen.findByRole("button", { name: "Send the robot to visit" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("The robot is not available");
});

test("a resident-unavailable visit error includes the resident's name", async () => {
  try { sessionStorage.setItem("oncare.family", JSON.stringify({ token: "jwt", displayName: "Demo Daughter" })); } catch {}
  installFetch((path, init) => {
    if (path === "/me/residents") return { status: 200, body: { residents: [resident] } };
    if (path === "/visits" && init?.method === "POST") return { status: 409, body: { error: "resident_unavailable" } };
    return { status: 404, body: {} };
  });
  render(<App apiBase="http://api" />);
  await userEvent.click(await screen.findByRole("button", { name: "Send the robot to visit" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Mom is not available right now");
});

test("shows connection feedback when the real-presence acknowledgement fails without retrying", async () => {
  const get: Api["get"] = async <T,>(path: string): Promise<T> => (path === "/me/residents"
    ? { residents: [resident] }
    : { visit: { id: "v1", state: "connecting", residentId: resident.id } }) as T;
  const post = vi.fn((path: string, _body?: unknown) => path.endsWith("/token")
    ? Promise.resolve({ url: "wss://video.example", token: "token", room: "v1" })
    : Promise.reject(new ApiError(503, "unavailable")));
  const api: Api = {
    get,
    patch: vi.fn(),
    post: async <T,>(path: string, body?: unknown): Promise<T> => post(path, body) as Promise<T>,
    del: vi.fn(),
  };
  const view = render(<Visit api={api} apiBase="http://api" token="jwt" visitId="v1" onBack={vi.fn()} />);
  await waitFor(() => expect(callMock.callbacks).toBeDefined());
  act(() => callMock.callbacks.onRemoteParticipant(true));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The call status could not be updated. Please reload the page."));
  expect(screen.getByRole("alert")).toHaveTextContent("The call status could not be updated. Please reload the page.");
  expect(post).toHaveBeenCalledTimes(2);
  view.unmount();
});

test("early loss leaves the late call handle even when reporting loss fails and the panel stays mounted", async () => {
  let resolveHandle!: (value: any) => void;
  const handle = { setVolume: vi.fn(), setMic: vi.fn(async () => {}), setCamera: vi.fn(async () => {}), localVideoElement: vi.fn(() => document.createElement("video")), leave: vi.fn(async () => {}) };
  callMock.createCall.mockImplementation((_url, _token, callbacks) => {
    callMock.callbacks = callbacks;
    return new Promise((resolve) => { resolveHandle = resolve; });
  });
  const get: Api["get"] = async <T,>(path: string): Promise<T> => (path === "/me/residents"
    ? { residents: [resident] }
    : { visit: { id: "v1", state: "active", residentId: resident.id } }) as T;
  const post = vi.fn((path: string, _body?: unknown) => path.endsWith("/token")
    ? Promise.resolve({ url: "wss://video.example", token: "token", room: "v1" })
    : Promise.reject(new ApiError(503, "unavailable")));
  const api: Api = { get, post: (path, body) => post(path, body) as any, patch: vi.fn(), del: vi.fn() };
  render(<Visit api={api} apiBase="http://api" token="jwt" visitId="v1" onBack={vi.fn()} />);
  await waitFor(() => expect(callMock.callbacks).toBeDefined());

  act(() => callMock.callbacks.onLost());
  await waitFor(() => expect(post).toHaveBeenCalledWith("/visits/v1/connection_lost", undefined));
  expect(screen.getByRole("alert")).toHaveTextContent("The call status could not be updated. Please reload the page.");
  await act(async () => resolveHandle(handle));
  expect(screen.getByRole("region", { name: "Video call" })).toBeInTheDocument();
  expect(handle.leave).toHaveBeenCalledTimes(1);
  expect(handle.localVideoElement).not.toHaveBeenCalled();
});
