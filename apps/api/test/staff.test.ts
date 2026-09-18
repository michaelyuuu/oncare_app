import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";
import { AuditEventSchema } from "@oncare/core";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
describe("staff operations", () => {
  test("queue groups work, includes only recent caregiver calls using the injected clock", async () => {
    const { app, db, tokens } = await makeTestApp({ now: () => new Date("2030-01-01T12:00:00Z") });
    db.update(t.resident).set({ availability: "in_activity" }).run();
    const visit = (await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } })).json().visit;
    const task = (await app.inject({ method: "POST", url: "/tasks", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident, text: "water" } })).json().task;
    await app.inject({ method: "POST", url: `/tasks/${task.id}/confirm`, headers: auth(tokens.family) });
    for (const [id, at] of [["old", "2030-01-01T11:29:59Z"], ["recent", "2030-01-01T11:30:00Z"]]) db.insert(t.auditEvent).values({ id: id!, at: at!, actorType: "device", actorId: SEED_IDS.device, entityType: "resident", entityId: SEED_IDS.resident, correlationId: SEED_IDS.resident, reason: "call_caregiver" }).run();
    const response = await app.inject({ method: "GET", url: "/queue", headers: auth(tokens.staff) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ visitsAwaitingApproval: [expect.objectContaining({ id: visit.id })], tasksAwaitingApproval: [expect.objectContaining({ id: task.id })], tasksAwaitingLoad: [], tasksAwaitingHandoff: [], caregiverCalls: [expect.objectContaining({ id: "recent" })], robot: { robotId: SEED_IDS.robot, connected: false } });
    db.update(t.visitSession).set({ state: "active" }).where(eq(t.visitSession.id, visit.id)).run();
    db.update(t.taskRequest).set({ state: "placing" }).where(eq(t.taskRequest.id, task.id)).run();
    const active = (await app.inject({ method: "GET", url: "/queue", headers: auth(tokens.staff) })).json();
    expect(active.activeVisits).toEqual([expect.objectContaining({ id: visit.id, streaming: true })]);
    expect(active.tasksAwaitingHandoff).toEqual([expect.objectContaining({ id: task.id })]);
  });
  test("availability is validated, persisted, audited with IDs and broadcast", async () => {
    const { app, db, tokens } = await makeTestApp();
    const events: unknown[] = []; app.transitions.subscribe(e => events.push(e));
    const patch = (id: string, availability: unknown) => app.inject({ method: "PATCH", url: `/residents/${id}/availability`, headers: auth(tokens.staff), payload: { availability } });
    expect((await patch(SEED_IDS.resident, "resting")).json().resident.availability).toBe("resting");
    expect(events).toEqual([expect.objectContaining({ entityType: "resident", entityId: SEED_IDS.resident, actorType: "staff", reason: "availability_changed", fromState: "available", toState: "resting" })]);
    expect(AuditEventSchema.safeParse(events[0]).success).toBe(true);
    expect(db.select().from(t.resident).get()?.availability).toBe("resting");
    expect((await patch(SEED_IDS.resident, "asleep")).statusCode).toBe(400);
    expect((await patch("missing", "available")).statusCode).toBe(404);
  });
  test("audit validates filters, sorts newest first and includes resident events", async () => {
    const { app, db, tokens } = await makeTestApp();
    for (const [id, at] of [["a", "2030-01-01T10:00:00.000Z"], ["b", "2030-01-01T11:00:00.000Z"]]) db.insert(t.auditEvent).values({ id: id!, at: at!, actorType: "staff", actorId: SEED_IDS.staffUser, entityType: "resident", entityId: SEED_IDS.resident, correlationId: SEED_IDS.resident, reason: "availability_changed" }).run();
    const get = (query: string) => app.inject({ method: "GET", url: `/audit${query}`, headers: auth(tokens.staff) });
    expect((await get(`?residentId=${SEED_IDS.resident}&limit=1`)).json().events.map((e: { id: string }) => e.id)).toEqual(["b"]);
    expect((await get("?since=2030-01-01T10:30:00Z")).json().events.map((e: { id: string }) => e.id)).toEqual(["b"]);
    expect((await get("?residentId=missing")).json().events).toEqual([]);
    for (const query of ["?since=no", "?limit=0", "?limit=1001", "?limit=2.5", "?limit=no"]) expect((await get(query)).statusCode).toBe(400);
  });
  test("staff routes reject family and device principals", async () => {
    const { app, tokens } = await makeTestApp();
    for (const token of [tokens.family, tokens.device]) for (const url of ["/queue", "/audit"]) expect((await app.inject({ method: "GET", url, headers: auth(token) })).statusCode).toBe(403);
    for (const token of [tokens.family, tokens.device]) expect((await app.inject({ method: "PATCH", url: `/residents/${SEED_IDS.resident}/availability`, headers: auth(token), payload: { availability: "resting" } })).statusCode).toBe(403);
  });
});
