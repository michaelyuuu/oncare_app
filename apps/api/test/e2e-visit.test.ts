// apps/api/test/e2e-visit.test.ts
import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { eq } from "drizzle-orm";
import { listen, makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS, SEED_SECRETS } from "../src/db/seed";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });
async function waitFor<T>(condition: () => T | false | null | undefined, description: string, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

/** A gateway that behaves like GatewayCore + MockRobotAdapter, scripted in the test. */
function scriptedGateway(url: string, token: string) {
  const ws = new WebSocket(`${url.replace("http", "ws")}/gateway?token=${token}`);
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  const now = () => new Date().toISOString();
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "intent" && m.intent === "request_visit") {
      send({ type: "ack", correlationId: m.correlationId, result: "accepted" });
      send({ type: "state_event", correlationId: m.correlationId, at: now(), event: "robot_en_route" });
      setTimeout(() => send({ type: "state_event", correlationId: m.correlationId, at: now(), event: "arrived" }), 60);
    }
  });
  return new Promise<WebSocket>((resolve) => ws.once("open", () => resolve(ws)));
}

describe("end-to-end visit (handover section 8, steps 1-5 without video)", () => {
  test("request -> robot -> resident answers -> connected -> end, with a complete audit trail", async () => {
    const { app, db, tokens } = await makeTestApp();
    const srv = await listen(app); closers.push(srv.close);
    const gw = await scriptedGateway(srv.url, SEED_SECRETS.robotToken);
    const familyEvents: any[] = [];
    const fam = new WebSocket(`${srv.url.replace("http", "ws")}/events?token=${tokens.family}`);
    fam.on("message", (d) => familyEvents.push(JSON.parse(d.toString())));
    await new Promise((r) => fam.once("open", r));

    // 1. daughter requests a visit
    const created = await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } });
    const visitId = created.json().visit.id as string;
    // 2. robot goes to the resident
    const state = () => db.select().from(t.visitSession).where(eq(t.visitSession.id, visitId)).get()!.state;
    expect(await waitFor(() => state() === "awaiting_resident_consent", "the scripted robot arrival")).toBe(true);
    // 3-4. iPad shows the incoming call; resident answers with one tap
    expect((await app.inject({ method: "GET", url: `/visits/${visitId}`, headers: auth(tokens.device) })).json().visit.state).toBe("awaiting_resident_consent");
    expect((await app.inject({ method: "POST", url: `/visits/${visitId}/answer`, headers: auth(tokens.device) })).json().visit.state).toBe("connecting");
    // 5. call connects (LiveKit in Plan 4; the client reports it here)
    expect((await app.inject({ method: "POST", url: `/visits/${visitId}/connected`, headers: auth(tokens.family) })).json().visit.state).toBe("active");
    expect((await app.inject({ method: "POST", url: `/visits/${visitId}/end`, headers: auth(tokens.family) })).json().visit.state).toBe("completed");
    await waitFor(() => familyEvents.filter((event) => event.type !== "hello").length === 8, "the final family audit event");

    const trail = db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, visitId)).all();
    expect(trail.map((e) => e.toState)).toEqual([
      "awaiting_policy_or_staff", "accepted", "robot_en_route", "awaiting_resident_consent", "connecting", "active", "ending", "completed",
    ]);
    expect(trail.map((e) => e.actorType)).toEqual(["system", "system", "robot", "robot", "device", "family", "family", "family"]);
    expect(familyEvents.filter((e) => e.type !== "hello").map((e) => e.toState)).toEqual(trail.map((e) => e.toState));
    expect(db.select().from(t.robotCommand).where(eq(t.robotCommand.visitId, visitId)).get()?.result).toBe("accepted");

    gw.close(); fam.close();
  });

  test("family cancels while the robot is en route: robot receives cancel and the visit ends cancelled", async () => {
    const { app, db, tokens } = await makeTestApp();
    const srv = await listen(app); closers.push(srv.close);
    const gwMessages: any[] = [];
    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/gateway?token=${SEED_SECRETS.robotToken}`);
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "locations") return; // sent first on every connect; not part of this script's exchange
      gwMessages.push(m);
      if (m.type === "intent") ws.send(JSON.stringify({ type: "ack", correlationId: m.correlationId, result: "accepted" }));
      if (m.type === "cancel") ws.send(JSON.stringify({ type: "state_event", correlationId: m.correlationId, at: new Date().toISOString(), event: "cancelled" }));
    });
    await new Promise((r) => ws.once("open", r));
    const visitId = (await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } })).json().visit.id;
    await waitFor(() => gwMessages.some((message) => message.type === "intent"), "the visit intent");
    expect((await app.inject({ method: "POST", url: `/visits/${visitId}/cancel`, headers: auth(tokens.family) })).json().visit.state).toBe("cancelled");
    await waitFor(() => gwMessages.some((message) => message.type === "cancel"), "the visit cancellation");
    expect(gwMessages.map((m) => m.type)).toEqual(["intent", "cancel"]);
    expect(db.select().from(t.visitSession).where(eq(t.visitSession.id, visitId)).get()?.state).toBe("cancelled");
    ws.close();
  });
});
