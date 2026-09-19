import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "../src/App";

class Socket { onmessage?: (event: { data: string }) => void; close() {} }
const data = {
  "/admin/residents": { residents: [{ id: "r1", displayName: "Grandma Lin", roomLocationId: "room1", availability: "available", active: true, facilityId: "f" }] },
  "/admin/users": { users: [{ id: "s1", role: "staff", username: "nurse", displayName: "Nurse Chen", facilityId: "f", active: true }, { id: "fam1", role: "family", username: "daughter", displayName: "Amy", facilityId: null, active: true }] },
  "/admin/family-links": { links: [{ id: "l1", userId: "fam1", residentId: "r1", label: "daughter", consentVideo: true, consentRobotVisit: false, consentItemDelivery: false }] },
  "/admin/staff-assignments": { assignments: [{ id: "a1", userId: "s1", residentId: "r1", active: true, createdAt: "2026-09-19T00:00:00Z" }] },
  "/admin/devices": { devices: [{ id: "d1", residentId: "r1", robotId: null, active: true, assignmentVersion: 1, kind: "ipad", facilityId: "f" }] },
  "/locations": { locations: [{ id: "room1", name: "Room 101", kind: "resident_room" }, { id: "pick", name: "Station", kind: "pickup_station" }] },
  "/queue": { visitsAwaitingApproval: [], tasksAwaitingApproval: [], tasksAwaitingLoad: [], tasksAwaitingHandoff: [], caregiverCalls: [], activeVisits: [], robot: null },
  "/audit": { events: [] },
} as Record<string, unknown>;
let requests: Array<{ method: string; path: string; body: unknown }>;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => {
  sessionStorage.clear();
  requests = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace("http://api", "").split("?")[0]!;
    const method = init?.method ?? "GET";
    requests.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "POST" && path === "/admin/devices") return new Response(JSON.stringify({ device: { id: "d2" }, deviceToken: "tok-once-123" }), { status: 201 });
    if (method !== "GET") return new Response('{"ok":true}');
    return new Response(JSON.stringify(data[path] ?? {}));
  }));
});

const asAdmin = () => sessionStorage.setItem("oncare.staff", JSON.stringify({ token: "jwt", displayName: "Manager", role: "admin" }));

test("the facility admin tab is shown to admins only", async () => {
  sessionStorage.setItem("oncare.staff", JSON.stringify({ token: "jwt", displayName: "Nurse" }));
  render(<App apiBase="http://api" />);
  await screen.findByText("Staff console");
  expect(screen.queryByRole("tab", { name: "Facility admin" })).toBeNull();
});

test("an admin sees residents, people, links and iPads", async () => {
  asAdmin();
  render(<App apiBase="http://api" />);
  await userEvent.click(await screen.findByRole("tab", { name: "Facility admin" }));
  const residents = await screen.findByRole("region", { name: "Residents" });
  expect(within(residents).getByText("Grandma Lin")).toBeInTheDocument();
  expect(within(residents).getByRole("cell", { name: "Room 101" })).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Staff and family" })).getByText("Nurse Chen")).toBeInTheDocument();
  const links = screen.getByRole("region", { name: "Family links and nurse assignments" });
  expect(within(links).getByText(/Amy.*daughter.*Grandma Lin/)).toBeInTheDocument();
  expect(within(links).getByText(/Nurse Chen.*Grandma Lin/)).toBeInTheDocument();
});

test("registering an iPad reveals its token once and removing a link calls DELETE", async () => {
  asAdmin();
  render(<App apiBase="http://api" />);
  await userEvent.click(await screen.findByRole("tab", { name: "Facility admin" }));
  const devices = await screen.findByRole("region", { name: "Resident iPads" });
  await userEvent.selectOptions(within(devices).getByLabelText("Resident"), "r1");
  await userEvent.click(within(devices).getByRole("button", { name: "Register iPad" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("tok-once-123")).toBeInTheDocument();
  expect(requests).toContainEqual({ method: "POST", path: "/admin/devices", body: { residentId: "r1" } });
  await userEvent.click(within(dialog).getByRole("button", { name: "I have saved it" }));
  expect(screen.queryByText("tok-once-123")).toBeNull();

  const links = screen.getByRole("region", { name: "Family links and nurse assignments" });
  await userEvent.click(within(links).getAllByRole("button", { name: "Remove" })[0]!);
  expect(requests).toContainEqual({ method: "DELETE", path: "/admin/family-links/l1", body: undefined });
});

test("linking a family member defaults video, robot-visit and item consent all on", async () => {
  asAdmin();
  render(<App apiBase="http://api" />);
  await userEvent.click(await screen.findByRole("tab", { name: "Facility admin" }));
  const links = screen.getByRole("region", { name: "Family links and nurse assignments" });
  await userEvent.selectOptions(within(links).getByLabelText("Family member"), "fam1");
  await userEvent.selectOptions(within(links).getAllByLabelText("Resident")[0]!, "r1");
  await userEvent.type(within(links).getByLabelText("Relationship"), "daughter");
  await userEvent.click(within(links).getByRole("button", { name: "Link family" }));
  expect(requests).toContainEqual({
    method: "POST", path: "/admin/family-links",
    body: { userId: "fam1", residentId: "r1", label: "daughter", consentVideo: true, consentRobotVisit: true, consentItemDelivery: true },
  });
});

test("unticking a family-link consent checkbox sends it as false", async () => {
  asAdmin();
  render(<App apiBase="http://api" />);
  await userEvent.click(await screen.findByRole("tab", { name: "Facility admin" }));
  const links = screen.getByRole("region", { name: "Family links and nurse assignments" });
  await userEvent.selectOptions(within(links).getByLabelText("Family member"), "fam1");
  await userEvent.selectOptions(within(links).getAllByLabelText("Resident")[0]!, "r1");
  await userEvent.type(within(links).getByLabelText("Relationship"), "daughter");
  await userEvent.click(within(links).getByLabelText("May request robot visits"));
  await userEvent.click(within(links).getByRole("button", { name: "Link family" }));
  expect(requests).toContainEqual({
    method: "POST", path: "/admin/family-links",
    body: { userId: "fam1", residentId: "r1", label: "daughter", consentVideo: true, consentRobotVisit: false, consentItemDelivery: true },
  });
});

test("deactivating a person and an iPad posts to the exact routes", async () => {
  asAdmin();
  render(<App apiBase="http://api" />);
  await userEvent.click(await screen.findByRole("tab", { name: "Facility admin" }));
  const people = await screen.findByRole("region", { name: "Staff and family" });
  await userEvent.click(within(people).getAllByRole("button", { name: "Deactivate" })[0]!);
  const devices = screen.getByRole("region", { name: "Resident iPads" });
  await userEvent.click(within(devices).getByRole("button", { name: "Deactivate" }));
  expect(requests.filter((r) => r.method === "POST").map((r) => r.path)).toEqual(["/admin/users/s1/deactivate", "/admin/devices/d1/deactivate"]);
});

test("a failed change keeps the error banner up after the follow-up reload, and a later success clears it", async () => {
  asAdmin();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace("http://api", "").split("?")[0]!;
    const method = init?.method ?? "GET";
    requests.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "POST" && path === "/admin/users") return new Response(JSON.stringify({ error: "username_taken" }), { status: 409 });
    if (method === "POST" && path === "/admin/devices") return new Response(JSON.stringify({ device: { id: "d2" }, deviceToken: "tok-once-123" }), { status: 201 });
    if (method !== "GET") return new Response('{"ok":true}');
    return new Response(JSON.stringify(data[path] ?? {}));
  }));
  render(<App apiBase="http://api" />);
  await userEvent.click(await screen.findByRole("tab", { name: "Facility admin" }));
  const people = await screen.findByRole("region", { name: "Staff and family" });

  await userEvent.type(within(people).getByLabelText("Username"), "newnurse");
  await userEvent.type(within(people).getByLabelText("Display name"), "New Nurse");
  await userEvent.type(within(people).getByLabelText("Temporary password"), "secret1");
  const getsBeforeSubmit = requests.filter((r) => r.method === "GET").length;
  await userEvent.click(within(people).getByRole("button", { name: "Add person" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("The change was not saved. Check the connection and try again.");
  // Wait for the mutation's follow-up reload GETs to land, then confirm the banner is still up.
  await waitFor(() => expect(requests.filter((r) => r.method === "GET").length).toBeGreaterThan(getsBeforeSubmit));
  expect(screen.getByRole("alert")).toHaveTextContent("The change was not saved. Check the connection and try again.");

  await userEvent.click(within(people).getAllByRole("button", { name: "Deactivate" })[0]!);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
