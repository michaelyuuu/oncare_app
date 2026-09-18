import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const callMocks = vi.hoisted(() => ({ createCall: vi.fn() }));
vi.mock("@oncare/web-common", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oncare/web-common")>();
  return { ...original, createCall: callMocks.createCall };
});
import { App, ScreenBoundary } from "../src/App";
import type { CallCallbacks } from "@oncare/web-common";
import type { DeviceState } from "../src/screen";
let state: DeviceState;
let failState = false, failAction = false, failAuth = false;
let calls: string[];
let callCallbacks: CallCallbacks;
let leaveCall: ReturnType<typeof vi.fn>;
class Socket { static current: Socket; onmessage?: (event: { data: string }) => void; constructor() { Socket.current = this; } close() {} }
beforeEach(() => {
  state = { resident: { id: "r", displayName: "Demo Resident" }, screen: "home", visit: null, caller: null, task: null, robot: { adapter: "mock", connected: true } };
  calls = []; failState = failAction = failAuth = false;
  leaveCall = vi.fn(async () => {});
  callMocks.createCall.mockReset().mockImplementation(async (_url, _token, callbacks) => {
    callCallbacks = callbacks;
    return { setVolume: vi.fn(), setMic: vi.fn(), setCamera: vi.fn(), localVideoElement: () => null, leave: leaveCall };
  });
  localStorage.setItem("oncare.deviceToken", "device-demo-token");
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("speechSynthesis", { cancel: vi.fn(), speak: vi.fn() });
  vi.stubGlobal("SpeechSynthesisUtterance", class { constructor(public text: string) {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = url.replace("http://api", ""); calls.push(path);
    const auth = path === "/auth/device", getState = path === "/device/state";
    const token = path.endsWith("/token");
    return new Response(JSON.stringify(auth ? { token: "jwt" } : getState ? state : token ? { url: "wss://x", token: "call-token", room: "v1" } : { ok: true }), { status: (auth ? failAuth : getState ? failState : failAction) ? 500 : 200 });
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
test("incoming speaks once, shows simulated status, and answers with one tap", async () => {
  state = { ...state, screen: "incoming", visit: { id: "v1", state: "awaiting_resident_consent" }, caller: { displayName: "Amy" } };
  render(<App apiBase="http://api"/>);
  fireEvent.click(await screen.findByRole("button", { name: "Answer" }));
  await waitFor(() => expect(calls).toContain("/visits/v1/answer"));
  expect(screen.getByText("Amy is calling")).toBeInTheDocument();
  expect(speechSynthesis.speak).toHaveBeenCalledTimes(1);
  expect(screen.getByText("SIMULATED ROBOT")).toBeInTheDocument();
  expect(screen.getByText("Microphone off")).toBeInTheDocument();
});
test("connecting calls disable End and never send the illegal end action", async () => {
  state = { ...state, screen: "in_call", visit: { id: "v1", state: "connecting" }, caller: { displayName: "Amy" } };
  render(<App apiBase="http://api"/>);
  const end = await screen.findByRole("button", { name: "End" });
  expect(end).toBeDisabled();
  fireEvent.click(end);
  await act(async () => {});
  expect(calls).not.toContain("/visits/v1/end");
});
test("the live call survives connecting to active, reports lifecycle, and drives privacy status", async () => {
  state = { ...state, screen: "in_call", visit: { id: "v1", state: "connecting" }, caller: { displayName: "Amy" } };
  render(<App apiBase="http://api"/>);
  await waitFor(() => expect(callMocks.createCall).toHaveBeenCalledTimes(1));
  act(() => callCallbacks.onLocalState({ camera: true, mic: true }));
  expect(screen.getByText("Camera on")).toBeInTheDocument();
  expect(screen.getByText("Microphone on")).toBeInTheDocument();
  act(() => callCallbacks.onRemoteParticipant(true));
  await waitFor(() => expect(calls).toContain("/visits/v1/connected"));

  state = { ...state, visit: { id: "v1", state: "active" } };
  act(() => Socket.current.onmessage?.({ data: JSON.stringify({ type: "visit.updated" }) }));
  await waitFor(() => expect(screen.getAllByText("Amy is on the call")).toHaveLength(2));
  expect(callMocks.createCall).toHaveBeenCalledTimes(1);
  expect(leaveCall).not.toHaveBeenCalled();

  act(() => callCallbacks.onLost());
  await waitFor(() => expect(calls).toContain("/visits/v1/connection_lost"));
  expect(leaveCall).toHaveBeenCalledTimes(1);
});
test("caregiver confirmation requires success; errors return home", async () => {
  render(<App apiBase="http://api"/>); await screen.findByText("Hello, Demo Resident");
  failAction = true; fireEvent.click(screen.getByRole("button", { name: "Call a caregiver" }));
  await screen.findByText("Please try again");
  expect(screen.queryByText("A caregiver has been notified")).not.toBeInTheDocument();
  failAction = false; fireEvent.click(screen.getByRole("button", { name: "Call a caregiver" }));
  expect(await screen.findByText("A caregiver has been notified")).toBeInTheDocument();
});
test("first setup skips PIN, saving exits settings and boots auth", async () => {
  localStorage.clear(); render(<App apiBase="http://api"/>);
  fireEvent.change(screen.getByLabelText("Device token"), { target: { value: "device-demo-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Hello, Demo Resident")).toBeInTheDocument();
  expect(localStorage.getItem("oncare.deviceToken")).toBe("device-demo-token");
});
test("failed fetch displays home content and reconnecting feedback", async () => {
  failState = true; render(<App apiBase="http://api"/>);
  expect(await screen.findByText("Reconnecting…")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Call a caregiver" })).toBeDisabled();
});
test("transient authentication retries and recovers", async () => {
  vi.useFakeTimers(); failAuth = true; render(<App apiBase="http://api"/>);
  await act(async () => {}); failAuth = false;
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(screen.getByText("Hello, Demo Resident")).toBeInTheDocument();
});
test("idle incoming returns home without mutation, a changed server screen resumes", async () => {
  vi.useFakeTimers(); state = { ...state, screen: "incoming", visit: { id: "v", state: "awaiting_resident_consent" }, caller: { displayName: "Amy" } };
  render(<App apiBase="http://api"/>); await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(90_000));
  expect(screen.getByText("Hello, Demo Resident")).toBeInTheDocument();
  expect(calls.filter((p) => p.startsWith("/visits/"))).toHaveLength(0);
  state = { ...state, screen: "in_call", visit: { id: "v", state: "active" } };
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(screen.getByTestId("video-stage")).toBeInTheDocument();
  await act(async () => vi.advanceTimersByTimeAsync(90_000));
  expect(screen.getByTestId("video-stage")).toBeInTheDocument();
});
test("a mistyped first token is never persisted and setup remains recoverable", async () => {
  localStorage.clear(); failAuth = true; render(<App apiBase="http://api"/>);
  fireEvent.change(screen.getByLabelText("Device token"), { target: { value: "typo" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Please try again"); expect(localStorage.getItem("oncare.deviceToken")).toBeNull();
  fireEvent.keyDown(screen.getByRole("button", { name: "Hold for staff settings" }), { key: "Enter" });
  expect(screen.getByLabelText("Device token")).toBeInTheDocument();
});
test("events refetch immediately and older state responses cannot overwrite newer ones", async () => {
  const originalFetch = fetch;
  let release: (response: Response) => void = () => {};
  let stateCalls = 0;
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/device/state") && ++stateCalls === 1) return new Promise<Response>((resolve) => { release = resolve; });
    return originalFetch(url, init);
  }));
  render(<App apiBase="http://api"/>);
  await waitFor(() => expect(stateCalls).toBe(1));
  act(() => Socket.current.onmessage?.({ data: JSON.stringify({ type: "visit.updated" }) }));
  await screen.findByText("Hello, Demo Resident");
  await act(async () => release(new Response(JSON.stringify({ ...state, screen: "incoming", visit: { id: "old", state: "awaiting_resident_consent" }, caller: { displayName: "Old" } }))));
  expect(screen.queryByText("Old is calling")).not.toBeInTheDocument();
});
test("render exceptions invoke the home fallback and clear overrides", () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const reset = vi.fn();
  function Broken(): React.ReactNode { throw new Error("screen failed"); }
  render(<ScreenBoundary onError={reset} fallback={<p>Home fallback</p>}><Broken/></ScreenBoundary>);
  expect(screen.getByText("Home fallback")).toBeInTheDocument(); expect(reset).toHaveBeenCalledTimes(1);
  logged.mockRestore();
});
