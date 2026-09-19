import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "../src/App";
import { AuditTable } from "../src/components/AuditTable";
import { createApi } from "@oncare/web-common";
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
        if (path === "/locations") return new Response('{"locations":[]}');
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
test.each([["active", "Navigating"], ["succeeded", "Arrived"], ["canceled", "Canceled"]])(
    "navweb heartbeat %s has a localized staff navigation status", async (status, label) => {
        queue.robot!.lastHeartbeat.adapter = "navweb";
        queue.robot!.lastHeartbeat.navState = status;
        render(<App apiBase="http://api"/>);
        expect(await screen.findByText(label)).toBeInTheDocument();
    },
);
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
    expect(await screen.findByText("This account is not a staff or manager account")).toBeInTheDocument();
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

test("End call takes priority over pending camera control and stays locked through stale queue refreshes", async () => {
    const original = fetch;
    const waiting = new Map<string, (response: Response) => void>();
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith("/visits/v2/camera") || url.endsWith("/visits/v2/end")) {
            const path = url.replace("http://api", "");
            posts.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
            return new Promise<Response>(resolve => waiting.set(path, resolve));
        }
        return original(url, init);
    }));
    render(<App apiBase="http://api"/>);
    await userEvent.click(await screen.findByRole("button", { name: "Pause camera" }));
    const end = screen.getByRole("button", { name: "End call" });
    expect(end).toBeEnabled();
    await userEvent.dblClick(end);
    expect(posts.map(p => p.path)).toEqual(["/visits/v2/camera", "/visits/v2/end"]);
    expect(end).toBeDisabled();
    await act(async () => waiting.get("/visits/v2/camera")!(new Response('{"ok":true}')));
    expect(screen.getByRole("button", { name: "Pause camera" })).toBeDisabled();
    // Even an old active queue response after end succeeds must not reopen controls.
    await act(async () => waiting.get("/visits/v2/end")!(new Response('{"ok":true}')));
    expect(end).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pause camera" })).toBeDisabled();
    await userEvent.click(end);
    expect(posts).toHaveLength(2);
});

test("a failed end can retry while camera is pending, and late old-session actions cannot lock the new session", async () => {
    const original = fetch;
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => url === "http://api/visits/v2/camera"
        ? new Promise<Response>(resolve => { finish = resolve; })
        : original(url.replace("http://new-session", "http://api"), init)));
    const view = render(<App apiBase="http://api"/>);
    await userEvent.click(await screen.findByRole("button", { name: "Pause camera" }));
    response = { status: 503, body: { error: "request" } };
    await userEvent.click(screen.getByRole("button", { name: "End call" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End call" })).toBeEnabled();
    response = { status: 200, body: { ok: true } };
    await userEvent.click(screen.getByRole("button", { name: "End call" }));
    expect(posts.filter(p => p.path === "/visits/v2/end")).toHaveLength(2);
    view.rerender(<App apiBase="http://new-session"/>);
    expect(await screen.findByRole("button", { name: "End call" })).toBeEnabled();
    await act(async () => finish(new Response('{"error":"camera_control_failed"}', { status: 503 })));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Pause camera" })).toBeEnabled();
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

test("slow queue and audit responses complete despite repeated polling and event refreshes", async () => {
    vi.useFakeTimers();
    queue.activeVisits[0]!.cameraState = "unknown";
    const waiting: Array<{ path: string; resolve: (response: Response) => void }> = [];
    vi.stubGlobal("fetch", vi.fn((url: string) => new Promise<Response>(resolve => {
        waiting.push({ path: url.replace("http://api", ""), resolve });
    })));
    render(<App apiBase="http://api"/>);
    await act(async () => {
        await vi.advanceTimersByTimeAsync(9000);
        for (let i = 0; i < 4; i++) Socket.current.onmessage?.({ data: '{"id":"refresh"}' });
    });
    await act(async () => {
        waiting.find(r => r.path === "/queue")!.resolve(new Response(JSON.stringify(queue)));
        waiting.find(r => r.path === "/audit")!.resolve(new Response(JSON.stringify({ events: [{ id: "slow-audit", reason: "first_slow_result" }] })));
    });
    expect(screen.getByRole("button", { name: "STOP ROBOT" })).toBeEnabled();
    expect(screen.getByText("first_slow_result")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeEnabled();
    // Many triggers produce only one current request and one coalesced follow-up.
    expect(waiting.filter(r => r.path === "/queue")).toHaveLength(2);
    expect(waiting.filter(r => r.path === "/audit")).toHaveLength(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    await act(async () => {
        waiting.filter(r => r.path === "/queue")[1]!.resolve(new Response(JSON.stringify({ ...queue, robot: null })));
        waiting.filter(r => r.path === "/audit")[1]!.resolve(new Response(JSON.stringify({ events: [{ id: "new-audit", reason: "second_slow_result" }] })));
    });
    expect(screen.getByText("No robot configured")).toBeInTheDocument();
    expect(screen.getByText("second_slow_result")).toBeInTheDocument();
    expect(screen.queryByText("first_slow_result")).toBeNull();
});

test("late audit responses cannot cross a resident filter or API session change", async () => {
    const waiting: Array<{ url: string; resolve: (response: Response) => void }> = [];
    vi.stubGlobal("fetch", vi.fn((url: string) => new Promise<Response>(resolve => waiting.push({ url, resolve }))));
    const api = createApi("http://old-session", () => "old-token");
    const view = render(<AuditTable api={api} revision={0}/>);
    fireEvent.change(screen.getByLabelText("Resident id"), { target: { value: "resident-a" } });
    fireEvent.change(screen.getByLabelText("Resident id"), { target: { value: "resident-b" } });
    await act(async () => {
        waiting.find(r => r.url.endsWith("residentId=resident-b"))!.resolve(new Response(JSON.stringify({ events: [{ id: "b", reason: "resident_b_event" }] })));
    });
    expect(screen.getByText("resident_b_event")).toBeInTheDocument();
    await act(async () => {
        waiting.find(r => r.url.endsWith("residentId=resident-a"))!.resolve(new Response(JSON.stringify({ events: [{ id: "a", reason: "resident_a_event" }] })));
    });
    expect(screen.queryByText("resident_a_event")).toBeNull();
    view.rerender(<AuditTable api={createApi("http://new-session", () => "new-token")} revision={0}/>);
    expect(screen.queryByText("resident_b_event")).toBeNull();
    await act(async () => {
        waiting.find(r => r.url === "http://old-session/audit")!.resolve(new Response(JSON.stringify({ events: [{ id: "old", reason: "old_session_event" }] })));
        waiting.find(r => r.url.startsWith("http://new-session"))!.resolve(new Response(JSON.stringify({ events: [{ id: "new", reason: "new_session_event" }] })));
    });
    expect(screen.getByText("new_session_event")).toBeInTheDocument();
    expect(screen.queryByText("old_session_event")).toBeNull();
});

test("an old queue response cannot replace the new API session's robot state", async () => {
    const waiting: Array<{ url: string; resolve: (response: Response) => void }> = [];
    vi.stubGlobal("fetch", vi.fn((url: string) => url.endsWith("/queue")
        ? new Promise<Response>(resolve => waiting.push({ url, resolve }))
        : Promise.resolve(new Response('{"events":[]}'))));
    const view = render(<App apiBase="http://old-session"/>);
    view.rerender(<App apiBase="http://new-session"/>);
    await act(async () => {
        waiting.find(r => r.url === "http://new-session/queue")!.resolve(new Response(JSON.stringify({ ...queue, robot: null })));
    });
    expect(screen.getByText("No robot configured")).toBeInTheDocument();
    await act(async () => {
        waiting.find(r => r.url === "http://old-session/queue")!.resolve(new Response(JSON.stringify(queue)));
    });
    expect(screen.getByText("No robot configured")).toBeInTheDocument();
    expect(screen.queryByText("SIMULATED ROBOT")).toBeNull();
});

test("pose capture expires independently of pending queue refresh and rejects stale or invalid heartbeat times", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-18T00:00:00Z");
    vi.setSystemTime(now);
    let seen: string | null = new Date(now.getTime() - 7000).toISOString();
    let hold = false;
    let finish!: (response: Response) => void;
    const snapshot = () => ({ ...queue, robot: { ...queue.robot, lastSeenAt: seen } });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (url.endsWith("/queue")) return hold ? new Promise<Response>(resolve => { finish = resolve; }) : new Response(JSON.stringify(snapshot()));
        if (url.endsWith("/locations")) return new Response(JSON.stringify({ locations: [{ id: "standby", name: "Standby", x: 0, y: 0, yaw: 0, approved: true }] }));
        return new Response('{"events":[]}');
    }));
    render(<App apiBase="http://api"/>);
    await act(async () => {});
    const capture = () => screen.getByRole("button", { name: "Use robot's position here" });
    expect(capture()).toBeDisabled();
    for (const timestamp of [null, "invalid", new Date(now.getTime() + 10000).toISOString()]) {
        seen = timestamp;
        await act(async () => Socket.current.onmessage?.({ data: '{"id":"fresh-queue"}' }));
        expect(capture()).toBeDisabled();
    }
    seen = now.toISOString();
    await act(async () => Socket.current.onmessage?.({ data: '{"id":"fresh-heartbeat"}' }));
    expect(capture()).toBeEnabled();
    hold = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(5999); });
    expect(capture()).toBeEnabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(capture()).toBeDisabled();
    hold = false;
    seen = new Date(Date.now()).toISOString();
    await act(async () => finish(new Response(JSON.stringify(snapshot()))));
    expect(capture()).toBeEnabled();
});
