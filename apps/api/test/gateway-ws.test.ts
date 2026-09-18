import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { listen, makeTestApp } from "./helpers";
import { SEED_IDS, SEED_SECRETS } from "../src/db/seed";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

// The server can send several messages back-to-back in the same tick (e.g. the
// initial `locations` push followed immediately by a flushed pending intent).
// Both frames can arrive in the same TCP read on the client, so a plain
// `ws.once("message", ...)` per call is racy: the second frame's "message"
// event can fire before the test re-attaches its next `.once` listener, and
// that event is then lost for good (EventEmitter.emit with no listeners never
// buffers). Queue every inbound message on a listener attached once per
// socket, and hand messages out FIFO, so ordering is preserved without depending
// on when each `nextMessage()` call happens to run.
const queues = new WeakMap<WebSocket, { messages: unknown[]; waiters: Array<(v: unknown) => void> }>();
function nextMessage(ws: WebSocket): Promise<any> {
  let q = queues.get(ws);
  if (!q) {
    q = { messages: [], waiters: [] };
    queues.set(ws, q);
    ws.on("message", (d) => {
      const msg = JSON.parse(d.toString());
      const waiter = q!.waiters.shift();
      if (waiter) waiter(msg);
      else q!.messages.push(msg);
    });
  }
  return new Promise((resolve) => {
    if (q!.messages.length > 0) resolve(q!.messages.shift());
    else q!.waiters.push(resolve as (v: unknown) => void);
  });
}

function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once("close", (code) => resolve(code)));
}

async function waitFor<T>(condition: () => T | false | null | undefined | Promise<T | false | null | undefined>, description: string, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describe("WS /gateway", () => {
  test("valid robot token attaches the robot and heartbeats show in staff status", async () => {
    const { app, tokens } = await makeTestApp();
    const srv = await listen(app); closers.push(srv.close);
    const ws = await open(`${srv.url.replace("http", "ws")}/gateway?token=${SEED_SECRETS.robotToken}`);
    ws.send(JSON.stringify({ type: "heartbeat", at: "2026-09-17T00:00:00.000Z", robotReady: true, adapter: "mock", pose: null, navState: "idle", estop: false, lift: "rest", battery: "unknown", activeCorrelationId: null, gatewayVersion: "0.0.1" }));
    const res = await waitFor(async () => {
      const response = await app.inject({ method: "GET", url: `/robots/${SEED_IDS.robot}/status`, headers: auth(tokens.staff) });
      return response.json().lastHeartbeat ? response : null;
    }, "the robot heartbeat to reach status");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ robotId: SEED_IDS.robot, connected: true, lastHeartbeat: { robotReady: true } });
    ws.close();
    await closed(ws);
    const detached = await waitFor(async () => !(await app.inject({ method: "GET", url: `/robots/${SEED_IDS.robot}/status`, headers: auth(tokens.staff) })).json().connected, "the robot to detach");
    expect(detached).toBe(true);
  });

  test("wrong token is closed with 4401 and never attaches", async () => {
    const { app } = await makeTestApp();
    const srv = await listen(app); closers.push(srv.close);
    const ws = await open(`${srv.url.replace("http", "ws")}/gateway?token=wrong`);
    expect(await closed(ws)).toBe(4401);
    expect(app.hub.status(SEED_IDS.robot).connected).toBe(false);
  });

  test("invalid message gets an error reply and is not fanned out", async () => {
    const { app } = await makeTestApp();
    const srv = await listen(app); closers.push(srv.close);
    const seen: unknown[] = [];
    app.hub.onUp((_r, m) => seen.push(m));
    const ws = await open(`${srv.url.replace("http", "ws")}/gateway?token=${SEED_SECRETS.robotToken}`);
    await nextMessage(ws); // initial locations table, sent to every connecting robot before anything else
    ws.send(JSON.stringify({ type: "state_event", correlationId: "c", at: "x", event: "teleported" }));
    expect(await nextMessage(ws)).toEqual({ type: "error", reason: "invalid_message" });
    ws.send("not json");
    expect(await nextMessage(ws)).toEqual({ type: "error", reason: "invalid_message" });
    expect(seen).toHaveLength(0);
    ws.close();
  });

  test("pending intent is flushed to the robot when it connects", async () => {
    const { app, tokens } = await makeTestApp();
    const srv = await listen(app); closers.push(srv.close);
    const created = await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } });
    const visitId = created.json().visit.id;
    const ws = await open(`${srv.url.replace("http", "ws")}/gateway?token=${SEED_SECRETS.robotToken}`);
    const first = await nextMessage(ws);
    expect(first).toMatchObject({ type: "locations" });
    expect(first.locations.map((l: any) => l.id).sort()).toEqual([SEED_IDS.pickupLocation, SEED_IDS.roomLocation, SEED_IDS.standbyLocation].sort());
    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({ type: "intent", intent: "request_visit", correlationId: visitId });
    ws.close();
  });

  test("family cannot read robot status", async () => {
    const { app, tokens } = await makeTestApp();
    expect((await app.inject({ method: "GET", url: `/robots/${SEED_IDS.robot}/status`, headers: auth(tokens.family) })).statusCode).toBe(403);
  });

  test("a second connection for the same robot supersedes the first, and the stale close does not detach the live link", async () => {
    const { app } = await makeTestApp();
    const srv = await listen(app); closers.push(srv.close);
    const ws1 = await open(`${srv.url.replace("http", "ws")}/gateway?token=${SEED_SECRETS.robotToken}`);
    // Wait for ws1's own attach to complete (the `locations` push only happens
    // after hub.attach) before opening ws2, so ws2 is deterministically the
    // *later* attach and therefore the current link -- otherwise, under heavy
    // parallel load, two concurrent token verifications (scrypt) can finish in
    // either order and this test would flake on which socket ends up "current".
    await nextMessage(ws1);
    const ws2 = await open(`${srv.url.replace("http", "ws")}/gateway?token=${SEED_SECRETS.robotToken}`);
    await nextMessage(ws2);
    ws1.close();
    await closed(ws1);
    await new Promise((r) => setTimeout(r, 200));
    expect(app.hub.status(SEED_IDS.robot).connected).toBe(true);
    ws2.send(JSON.stringify({ type: "heartbeat", at: "2026-09-17T00:00:00.000Z", robotReady: true, adapter: "mock", pose: null, navState: "idle", estop: false, lift: "rest", battery: "unknown", activeCorrelationId: null, gatewayVersion: "0.0.1" }));
    expect(await waitFor(() => app.hub.status(SEED_IDS.robot).lastHeartbeat, "the replacement heartbeat")).toMatchObject({ robotReady: true });
    ws2.close();
    await closed(ws2);
    expect(await waitFor(() => !app.hub.status(SEED_IDS.robot).connected, "the replacement robot link to detach")).toBe(true);
  });

  test("a superseded gateway socket is closed with 4409 and the new one stays attached", async () => {
    const { app } = await makeTestApp();
    const srv = await listen(app); closers.push(srv.close);
    const ws1 = await open(`${srv.url.replace("http", "ws")}/gateway?token=${SEED_SECRETS.robotToken}`);
    await nextMessage(ws1);   // ws1's own `locations` push: it is attached
    const ws2 = await open(`${srv.url.replace("http", "ws")}/gateway?token=${SEED_SECRETS.robotToken}`);
    await nextMessage(ws2);   // ws2 attached, superseding ws1
    expect(await closed(ws1)).toBe(4409);
    await new Promise((r) => setTimeout(r, 100));
    expect(app.hub.status(SEED_IDS.robot).connected).toBe(true);
    ws2.close();
    await closed(ws2);
  });

  test("closing during token verification never leaves the robot attached", async () => {
    const { app } = await makeTestApp();
    const srv = await listen(app); closers.push(srv.close);
    const ws = await open(`${srv.url.replace("http", "ws")}/gateway?token=${SEED_SECRETS.robotToken}`);
    ws.close();
    await new Promise((r) => setTimeout(r, 500));
    expect(app.hub.status(SEED_IDS.robot).connected).toBe(false);
  });
});
