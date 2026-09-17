import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "../src/App";

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
beforeEach(() => { try { sessionStorage.clear(); } catch {} vi.stubGlobal("WebSocket", NoopSocket); });
afterEach(cleanup);

const resident = { id: "resident_demo_01", displayName: "Mom", availability: "available", relationship: { label: "daughter", consentVideo: true, consentRobotVisit: true, consentItemDelivery: true } };

test("login -> residents -> request a visit -> live stepper reaches the call and auto-reports connected", async () => {
  let state = "accepted";
  const calls = installFetch((path, init) => {
    if (path === "/auth/login") return init?.body?.toString().includes("family-demo-pass") ? { status: 200, body: { token: "jwt", principal: { kind: "user", id: "family_demo_01", role: "family", displayName: "Demo Daughter" } } } : { status: 401, body: { error: "invalid_credentials" } };
    if (path === "/me/residents") return { status: 200, body: { residents: [resident] } };
    if (path === "/visits" && init?.method === "POST") return { status: 201, body: { visit: { id: "v1", state, residentId: resident.id, simulated: true } } };
    if (path === "/visits/v1") return { status: 200, body: { visit: { id: "v1", state, residentId: resident.id, simulated: true } } };
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
  await waitFor(() => expect(calls.some((c) => c.path === "/visits/v1/connected" && c.method === "POST")).toBe(true), { timeout: 6000 });
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
