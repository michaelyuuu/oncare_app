import { describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";
import { AuditEventSchema } from "@oncare/core";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
describe("staff operations", () => {
  test("queue returns robot controls promptly during a hung camera lookup without overlapping provider calls", async () => {
    const { app, db, video, tokens } = await makeTestApp();
    const visit = (await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } })).json().visit;
    db.update(t.visitSession).set({ state: "active" }).where(eq(t.visitSession.id, visit.id)).run();
    let finish!: (state: "on") => void;
    const lookup = vi.spyOn(video, "cameraState").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const getQueue = () => app.inject({ method: "GET", url: "/queue", headers: auth(tokens.staff) }).then(res => res.json());
    try {
      // Independent upper bound: controls must arrive before the media provider resolves.
      const first = await Promise.race([getQueue(), new Promise<null>(resolve => setTimeout(() => resolve(null), 500))]);
      expect(first).toMatchObject({ robot: { robotId: SEED_IDS.robot }, activeVisits: [expect.objectContaining({ cameraState: "unknown" })] });
      const next = await Promise.all([getQueue(), getQueue()]);
      expect(next.every(result => result.robot.robotId === SEED_IDS.robot)).toBe(true);
      expect(lookup).toHaveBeenCalledTimes(1);
      finish("on");
      await new Promise(resolve => setTimeout(resolve, 0));
      // The next observation is also slow: the completed first observation
      // still needs to reach the UI instead of being thrown away at timeout.
      expect((await getQueue()).activeVisits[0].cameraState).toBe("on");
      expect(lookup).toHaveBeenCalledTimes(2);
      const later = Date.now() + 7000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(later);
      try { expect((await getQueue()).activeVisits[0].cameraState).toBe("unknown"); }
      finally { clock.mockRestore(); }
      video.cameras.set(`${visit.id}:${SEED_IDS.device}`, "on");
      await app.inject({ method: "POST", url: `/visits/${visit.id}/camera`, headers: auth(tokens.staff), payload: { paused: true } });
      expect((await getQueue()).activeVisits[0].cameraState).toBe("unknown");
      // The pre-pause sample must not reintroduce "on" after the action.
      finish("on");
      await new Promise(resolve => setTimeout(resolve, 0));
      expect((await getQueue()).activeVisits[0].cameraState).toBe("unknown");
      expect(lookup).toHaveBeenCalledTimes(3);
      db.update(t.visitSession).set({ state: "ending" }).where(eq(t.visitSession.id, visit.id)).run();
      expect((await getQueue()).activeVisits[0].cameraState).toBe("unavailable");
      finish("on");
      expect((await getQueue()).activeVisits[0].cameraState).toBe("unavailable");
      expect(lookup).toHaveBeenCalledTimes(3);
    } finally {
      finish?.("on");
      await app.close();
    }
  });
  test("caregiver queue resolves resident from device actor and preserves historical audit IDs", async () => {
    const { app, db, tokens } = await makeTestApp();
    await app.inject({ method: "POST", url: "/device/call-caregiver", headers: auth(tokens.device) });
    const original = db.select().from(t.auditEvent).get()!;
    db.insert(t.auditEvent).values({ ...original, id: "historical", actorId: "deleted_device", correlationId: "deleted_device" }).run();
    const result = (await app.inject({ method: "GET", url: "/queue", headers: auth(tokens.staff) })).json();
    expect(result.caregiverCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: original.id, residentId: SEED_IDS.resident, correlationId: SEED_IDS.device }),
      expect.objectContaining({ id: "historical", residentId: null, correlationId: "deleted_device" }),
    ]));
    expect(db.select().from(t.auditEvent).where(eq(t.auditEvent.id, original.id)).get()).toEqual(original);
  });
  test("queue includes scoped assistance requests for staff handling", async () => {
    const { app, tokens } = await makeTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/assistance-requests",
      headers: { ...auth(tokens.device), "idempotency-key": "staff-queue-test" },
      payload: { category: "general_assistance" },
    });
    expect(created.statusCode).toBe(201);
    const requestId = created.json().request.id;
    const result = await app.inject({ method: "GET", url: "/queue", headers: auth(tokens.staff) });
    expect(result.statusCode).toBe(200);
    expect(result.json().assistanceRequests).toEqual([
      expect.objectContaining({
        id: requestId,
        residentId: SEED_IDS.resident,
        persistenceState: "recorded",
        deliveryState: "pending",
        handlingState: "open",
        version: 1,
      }),
    ]);
  });
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
    expect((await patch("missing", "available")).statusCode).toBe(403);
  });
  test("audit validates filters, sorts newest first and includes resident events", async () => {
    const { app, db, tokens } = await makeTestApp();
    for (const [id, at] of [["a", "2030-01-01T10:00:00.000Z"], ["b", "2030-01-01T11:00:00.000Z"]]) db.insert(t.auditEvent).values({ id: id!, at: at!, actorType: "staff", actorId: SEED_IDS.staffUser, entityType: "resident", entityId: SEED_IDS.resident, correlationId: SEED_IDS.resident, reason: "availability_changed" }).run();
    const get = (query: string) => app.inject({ method: "GET", url: `/audit${query}`, headers: auth(tokens.staff) });
    expect((await get(`?residentId=${SEED_IDS.resident}&limit=1`)).json().events.map((e: { id: string }) => e.id)).toEqual(["b"]);
    expect((await get("?since=2030-01-01T10:30:00Z")).json().events.map((e: { id: string }) => e.id)).toEqual(["b"]);
    expect((await get("?residentId=missing")).statusCode).toBe(403);
    for (const query of ["?since=no", "?limit=0", "?limit=1001", "?limit=2.5", "?limit=no"]) expect((await get(query)).statusCode).toBe(400);
  });
  test("staff routes reject family and device principals", async () => {
    const { app, tokens } = await makeTestApp();
    for (const token of [tokens.family, tokens.device]) for (const url of ["/queue", "/audit"]) expect((await app.inject({ method: "GET", url, headers: auth(token) })).statusCode).toBe(403);
    for (const token of [tokens.family, tokens.device]) expect((await app.inject({ method: "PATCH", url: `/residents/${SEED_IDS.resident}/availability`, headers: auth(token), payload: { availability: "resting" } })).statusCode).toBe(403);
  });
});
