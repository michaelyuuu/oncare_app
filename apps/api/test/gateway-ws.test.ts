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

describe("WS /gateway", () => {
  test("valid robot token attaches the robot and heartbeats show in staff status", async () => {
    const { app, tokens } = await makeTestApp();
    const srv = await listen(app); closers.push(srv.close);
    const ws = await open(`${srv.url.replace("http", "ws")}/gateway?token=${SEED_SECRETS.robotToken}`);
    ws.send(JSON.stringify({ type: "heartbeat", at: "2026-09-17T00:00:00.000Z", robotReady: true, adapter: "mock", pose: null, navState: "idle", estop: false, lift: "rest", battery: "unknown", activeCorrelationId: null, gatewayVersion: "0.0.1" }));
    await new Promise((r) => setTimeout(r, 100));
    const res = await app.inject({ method: "GET", url: `/robots/${SEED_IDS.robot}/status`, headers: auth(tokens.staff) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ robotId: SEED_IDS.robot, connected: true, lastHeartbeat: { robotReady: true } });
    ws.close();
    await closed(ws);
    await new Promise((r) => setTimeout(r, 100));
    expect((await app.inject({ method: "GET", url: `/robots/${SEED_IDS.robot}/status`, headers: auth(tokens.staff) })).json().connected).toBe(false);
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
});
