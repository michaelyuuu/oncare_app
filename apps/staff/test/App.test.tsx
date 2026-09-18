import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "../src/App";
class Socket {
    static current: Socket;
    onmessage?: (event: {
        data: string;
    }) => void;
    constructor() { Socket.current = this; }
    close() { }
}
const initial = { visitsAwaitingApproval: [{ id: "v1", residentId: "r1", requesterId: "f1", state: "awaiting_policy_or_staff" }], tasksAwaitingApproval: [{ id: "t0", residentId: "r1", state: "awaiting_policy_or_staff" }], tasksAwaitingLoad: [{ id: "t1", residentId: "r1", state: "locating_item", proposal: { item: "water_bottle" } }], tasksAwaitingHandoff: [{ id: "t2", residentId: "r1", state: "placing" }], caregiverCalls: [{ id: "c1", correlationId: "r2", at: "2026-09-17T00:00:00Z" }], activeVisits: [{ id: "v2", residentId: "r1", requesterId: "f1", state: "active", streaming: true, cameraState: "on" }], robot: { robotId: "robot1", connected: true, lastHeartbeat: { robotReady: true, adapter: "mock", pose: { x: 1, y: 2, yaw: 0 }, navState: "idle", estop: false, battery: "unknown", activeCorrelationId: null } } };
let queue: typeof initial | (Omit<typeof initial, "robot"> & {
    robot: null;
});
let posts: {
    path: string;
    body: unknown;
}[];
let gets: string[];
let response: {
    status: number;
    body: unknown;
};
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem("oncare.staff", JSON.stringify({ token: "jwt", displayName: "Nurse" }));
    queue = structuredClone(initial);
    posts = [];
    gets = [];
    response = { status: 200, body: { ok: true, delivered: true } };
    vi.stubGlobal("WebSocket", Socket);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        const path = url.replace("http://api", "");
        if (init?.method === "POST") {
            posts.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
            return new Response(JSON.stringify(response.body), { status: response.status });
        }
        gets.push(path);
        return new Response(JSON.stringify(path === "/queue" ? queue : { events: [{ id: "a1", at: "2026-09-17T00:00:00Z", actorType: "staff", actorId: "s1", entityType: "visit", entityId: "v2", fromState: null, toState: null, reason: 'a,"b"\nnext', correlationId: "v2" }] }));
    }));
});
test("approval, denial, tray actions, emergency stop and end call use their exact routes", async () => {
    render(<App apiBase="http://api"/>);
    expect(await screen.findByText("SIMULATED ROBOT")).toBeInTheDocument();
    for (const name of ["Approve", "Deny", "Loaded on tray", "Received", "STOP ROBOT", "End call"])
        await userEvent.click(screen.getAllByRole("button", { name })[0]!);
    expect(posts.map(p => p.path)).toEqual(["/visits/v1/approve", "/visits/v1/deny", "/tasks/t1/loaded", "/tasks/t2/received", "/robots/robot1/stop", "/visits/v2/end"]);
});
test("PIN is reentered each time and a control failure survives refresh", async () => {
    render(<App apiBase="http://api"/>);
    await userEvent.click(await screen.findByRole("button", { name: "Release stop" }));
    response = { status: 403, body: { error: "invalid_pin" } };
    await userEvent.type(screen.getByLabelText("Staff PIN"), "2468{enter}");
    expect(posts[0]).toEqual({ path: "/robots/robot1/resume", body: { pin: "2468" } });
    expect(await screen.findByRole("alert")).toHaveTextContent(/PIN/);
    act(() => Socket.current.onmessage?.({ data: '{"id":"e1"}' }));
    await waitFor(() => expect(gets.filter(p => p === "/queue").length).toBeGreaterThan(1));
    expect(screen.getByRole("alert")).toHaveTextContent(/PIN/);
    await userEvent.click(screen.getByRole("button", { name: "Release stop" }));
    expect(screen.getByLabelText("Staff PIN")).toHaveValue("");
    expect(sessionStorage.getItem("oncare.staff")).not.toContain("2468");
});
test("nonstaff login is rejected without persisting a session", async () => {
    sessionStorage.clear();
    response = { status: 200, body: { token: "jwt", principal: { role: "family", displayName: "Family" } } };
    render(<App apiBase="http://api"/>);
    await userEvent.type(screen.getByLabelText("Username"), "family");
    await userEvent.type(screen.getByLabelText("Password"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("This account is not a staff account")).toBeInTheDocument();
    expect(sessionStorage.getItem("oncare.staff")).toBeNull();
});
test("staff login persists session and logout removes it", async () => {
    sessionStorage.clear();
    response = { status: 200, body: { token: "jwt", principal: { role: "staff", displayName: "Nurse" } } };
    render(<App apiBase="http://api"/>);
    await userEvent.type(screen.getByLabelText("Username"), "nurse");
    await userEvent.type(screen.getByLabelText("Password"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("SIMULATED ROBOT");
    expect(sessionStorage.getItem("oncare.staff")).toContain("jwt");
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(sessionStorage.getItem("oncare.staff")).toBeNull();
});
test("camera pause and resume use media route and unavailable state has no toggle", async () => {
    render(<App apiBase="http://api"/>);
    await userEvent.click(await screen.findByRole("button", { name: "Pause camera" }));
    expect(posts[0]).toEqual({ path: "/visits/v2/camera", body: { paused: true } });
    queue.activeVisits[0]!.cameraState = "paused";
    act(() => Socket.current.onmessage?.({ data: '{"id":"e2"}' }));
    await userEvent.click(await screen.findByRole("button", { name: "Resume camera" }));
    expect(posts[1]?.body).toEqual({ paused: false });
    queue.activeVisits[0]!.cameraState = "unavailable";
    act(() => Socket.current.onmessage?.({ data: '{"id":"e3"}' }));
    await screen.findByText("Camera unavailable");
    expect(screen.queryByRole("button", { name: "Resume camera" })).toBeNull();
    expect(screen.getByRole("button", { name: "End call" })).toBeEnabled();
});
test("camera refusal is actionable and delivered false is never success", async () => {
    render(<App apiBase="http://api"/>);
    response = { status: 503, body: { error: "camera_control_failed" } };
    await userEvent.click(await screen.findByRole("button", { name: "Pause camera" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/remote-unmute/);
    response = { status: 200, body: { ok: true, delivered: false } };
    await userEvent.click(screen.getByRole("button", { name: "STOP ROBOT" }));
    expect(await screen.findByText(/not delivered/)).toBeInTheDocument();
    expect(screen.getByText(/remote-unmute/)).toBeInTheDocument();
});
test("CSV export preserves commas, quotes and newlines and reports export failures", async () => {
    let blob: Blob | undefined;
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn((value: Blob) => { blob = value; return "blob:audit"; }), revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => { });
    render(<App apiBase="http://api"/>);
    const button = await screen.findByRole("button", { name: "Export CSV" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    const csv = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob!); });
    expect(csv).toContain('"a,""b""\nnext"');
    expect(csv).toContain('\r\n');
    expect(click).toHaveBeenCalledOnce();
    vi.mocked(URL.createObjectURL).mockImplementation(() => { throw new Error("export blocked"); });
    await userEvent.click(button);
    expect(await screen.findByText(/CSV export failed/)).toBeInTheDocument();
    click.mockRestore();
});
test("pending approval blocks duplicate actions while emergency stop stays available", async () => {
    const original = fetch;
    let finish: ((value: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => url.endsWith("/visits/v1/approve") ? new Promise<Response>(resolve => { finish = resolve; posts.push({ path: "/visits/v1/approve", body: undefined }); }) : original(url, init)));
    render(<App apiBase="http://api"/>);
    const approve = (await screen.findAllByRole("button", { name: "Approve" }))[0]!;
    await userEvent.dblClick(approve);
    expect(approve).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Deny" })[0]).toBeDisabled();
    expect(posts).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "STOP ROBOT" }));
    expect(posts.map(p => p.path)).toContain("/robots/robot1/stop");
    await act(async () => { finish!(new Response('{"ok":true}')); });
});
test("offline, busy and missing robot disable standby", async () => {
    queue.activeVisits = []; queue.tasksAwaitingLoad = []; queue.tasksAwaitingHandoff = [];
    queue.robot!.lastHeartbeat.activeCorrelationId = "task1" as unknown as null;
    render(<App apiBase="http://api"/>);
    expect(await screen.findByRole("button", { name: "Return to standby" })).toBeDisabled();
    queue.robot = null;
    act(() => Socket.current.onmessage?.({ data: '{"id":"e4"}' }));
    await screen.findByText("No robot configured");
    expect(screen.getByRole("button", { name: "STOP ROBOT" })).toBeDisabled();
});
test("standby sends the command when ready but respects offline and not-ready status", async () => {
    queue.activeVisits = []; queue.tasksAwaitingLoad = []; queue.tasksAwaitingHandoff = [];
    render(<App apiBase="http://api"/>);
    await userEvent.click(await screen.findByRole("button",{name:"Return to standby"}));
    expect(posts[0]?.path).toBe("/robots/robot1/standby");
    queue.robot!.connected=false;act(()=>Socket.current.onmessage?.({data:'{"id":"offline"}'}));
    await waitFor(()=>expect(screen.getByRole("button",{name:"Return to standby"})).toBeDisabled());
    queue.robot!.connected=true;queue.robot!.lastHeartbeat.robotReady=false;act(()=>Socket.current.onmessage?.({data:'{"id":"not-ready"}'}));
    await screen.findByText("Not ready");expect(screen.getByRole("button",{name:"Return to standby"})).toBeDisabled();
});
test("caregiver calls never label a device correlation id as a resident",async()=>{
    render(<App apiBase="http://api"/>);
    expect(await screen.findByText("Resident unknown; check the calling device")).toBeInTheDocument();
    expect(screen.queryByText("Resident: r2")).toBeNull();
});
test("audit filters are encoded and audit refreshes on events and polling", async () => {
    render(<App apiBase="http://api"/>);
    await screen.findByText('a,"b" next');
    fireEvent.change(screen.getByLabelText("Resident id"), { target: { value: "r & 1" } });
    fireEvent.change(screen.getByLabelText("Since"), { target: { value: "2026-09-17T01:00" } });
    await waitFor(() => expect(gets.some(p => p.includes("residentId=r+%26+1") && p.includes("since="))).toBe(true));
    const count = gets.length;
    act(() => Socket.current.onmessage?.({ data: '{"id":"e5"}' }));
    await waitFor(() => expect(gets.length).toBeGreaterThan(count + 1));
    const before = gets.length;
    await waitFor(() => expect(gets.length).toBeGreaterThan(before), { timeout: 3500 });
});
