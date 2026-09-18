import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("benchmark", () => {
  test("a visit produces one metrics row with notify latency, one resident action, and ack latency", async () => {
    let clock = Date.parse("2026-09-17T00:00:00.000Z");
    const { app, db, tokens } = await makeTestApp({ now: () => new Date(clock) });
    app.hub.attach(SEED_IDS.robot, { send() {} });
    const v = (await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } })).json().visit.id;
    clock += 400; app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: v, result: "accepted" });
    clock += 1000; app.hub.receive(SEED_IDS.robot, { type: "state_event", correlationId: v, at: new Date(clock).toISOString(), event: "arrived" });
    clock += 800; await app.inject({ method: "POST", url: "/device/screen-shown", headers: auth(tokens.device), payload: { screen: "incoming", entityId: v } });
    await app.inject({ method: "POST", url: "/device/screen-shown", headers: auth(tokens.device), payload: { screen: "incoming", entityId: v } });
    clock += 3000; await app.inject({ method: "POST", url: `/visits/${v}/answer`, headers: auth(tokens.device) });
    clock += 1500; await app.inject({ method: "POST", url: `/visits/${v}/connected`, headers: auth(tokens.family) });
    clock += 60000; await app.inject({ method: "POST", url: `/visits/${v}/end`, headers: auth(tokens.family) });
    const m = app.benchmark.visit(v)!;
    expect(m).toMatchObject({ finalState: "completed", residentActions: 1, commandAckMs: 400, notifyMs: 2200 });
    expect(db.select().from(t.benchmarkRun).where(eq(t.benchmarkRun.entityId, v)).all()).toHaveLength(1);
    expect(db.select().from(t.benchmarkTrial).all().filter((x) => x.name === "screen_shown:incoming")).toHaveLength(1);
  });

  test("task metrics carry per-stage timestamps and total time", async () => {
    let clock = Date.parse("2026-09-17T00:00:00.000Z");
    const { app, tokens } = await makeTestApp({ now: () => new Date(clock) });
    app.hub.attach(SEED_IDS.robot, { send() {} });
    const task = (await app.inject({ method: "POST", url: "/tasks", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident, text: "water" } })).json().task;
    clock += 1000; await app.inject({ method: "POST", url: `/tasks/${task.id}/confirm`, headers: auth(tokens.family) });
    clock += 1000; await app.inject({ method: "POST", url: `/tasks/${task.id}/approve`, headers: auth(tokens.staff) });
    app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: task.correlationId, result: "accepted" });
    clock += 5000; app.hub.receive(SEED_IDS.robot, { type: "state_event", correlationId: task.correlationId, at: new Date(clock).toISOString(), event: "arrived_pickup" });
    clock += 2000; await app.inject({ method: "POST", url: `/tasks/${task.id}/loaded`, headers: auth(tokens.staff) });
    clock += 5000; app.hub.receive(SEED_IDS.robot, { type: "state_event", correlationId: task.correlationId, at: new Date(clock).toISOString(), event: "arrived_delivery" });
    clock += 1000; await app.inject({ method: "POST", url: `/tasks/${task.id}/received`, headers: auth(tokens.device) });
    app.hub.receive(SEED_IDS.robot, { type: "state_event", correlationId: task.correlationId, at: new Date(clock).toISOString(), event: "completed_leg" });
    const m = app.benchmark.task(task.id)!;
    expect(m.finalState).toBe("completed");
    expect(m.totalMs).toBe(15000);
    expect([m.confirmedAt, m.approvedAt, m.pickupArrivedAt, m.loadedAt, m.deliveryArrivedAt, m.receivedAt].every((x) => typeof x === "string")).toBe(true);
  });

  test("CSV export is staff-only and has a header plus one line per run", async () => {
    const { app, tokens } = await makeTestApp();
    await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } });
    expect((await app.inject({ method: "GET", url: "/benchmark.csv", headers: auth(tokens.family) })).statusCode).toBe(403);
    const res = await app.inject({ method: "GET", url: "/benchmark.csv", headers: auth(tokens.staff) });
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.body.trim().split("\n");
    expect(lines[0]).toContain("kind,entityId,finalState");
    expect(lines).toHaveLength(2);
    expect(res.body).not.toContain("Demo Daughter");
  });
});
