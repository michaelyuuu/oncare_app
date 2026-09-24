import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** Creates a visit and forces it into `state` directly (bypassing the machine) so each action can be tested in isolation. */
async function visitIn(state: string) {
  const ctx = await makeTestApp();
  const res = await ctx.app.inject({ method: "POST", url: "/visits", headers: auth(ctx.tokens.family), payload: { residentId: SEED_IDS.resident } });
  const id = res.json().visit.id as string;
  ctx.db.update(t.visitSession).set({ state }).where(eq(t.visitSession.id, id)).run();
  const act = (action: string, token: string) => ctx.app.inject({ method: "POST", url: `/visits/${id}/${action}`, headers: auth(token) });
  return { ...ctx, id, act };
}

describe("visit actions", () => {
  test("staff approve moves awaiting_policy_or_staff to accepted with staff as actor", async () => {
    const { db, tokens, id, act } = await visitIn("awaiting_policy_or_staff");
    const res = await act("approve", tokens.staff);
    expect(res.statusCode).toBe(200);
    expect(res.json().visit.state).toBe("accepted");
    const last = db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, id)).all().at(-1);
    expect(last).toMatchObject({ actorType: "staff", actorId: SEED_IDS.staffUser, toState: "accepted" });
  });

  test("family cannot approve", async () => {
    const { tokens, act } = await visitIn("awaiting_policy_or_staff");
    expect((await act("approve", tokens.family)).statusCode).toBe(403);
  });

  test("staff deny moves to denied", async () => {
    const { tokens, act } = await visitIn("awaiting_policy_or_staff");
    expect((await act("deny", tokens.staff)).json().visit.state).toBe("denied");
  });

  test("device answer moves awaiting_resident_consent to connecting", async () => {
    const { tokens, act } = await visitIn("awaiting_resident_consent");
    const res = await act("answer", tokens.device);
    expect(res.json().visit.state).toBe("connecting");
  });

  test("device decline moves to resident_unavailable", async () => {
    const { tokens, act } = await visitIn("awaiting_resident_consent");
    expect((await act("decline", tokens.device)).json().visit.state).toBe("resident_unavailable");
  });

  test("answer in the wrong state is 409 illegal_transition and records rejected_transition", async () => {
    const { db, tokens, id, act } = await visitIn("accepted");
    const res = await act("answer", tokens.device);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("illegal_transition");
    expect(db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, id)).all().at(-1)?.reason).toBe("rejected_transition");
  });

  test("connected moves connecting to active and stamps connectedAt", async () => {
    const { tokens, act } = await visitIn("connecting");
    const res = await act("connected", tokens.family);
    expect(res.json().visit.state).toBe("active");
    expect(typeof res.json().visit.connectedAt).toBe("string");
  });

  test("end moves active through ending to completed and stamps endedAt", async () => {
    const { db, tokens, id, act } = await visitIn("active");
    const res = await act("end", tokens.device);
    expect(res.json().visit.state).toBe("completed");
    expect(typeof res.json().visit.endedAt).toBe("string");
    const states = db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, id)).all().map((e) => e.toState);
    expect(states.slice(-2)).toEqual(["ending", "completed"]);
  });

  test("end from ending completes instead of 409: the satisfied step is skipped", async () => {
    const { db, tokens, id, act } = await visitIn("ending");
    const res = await act("end", tokens.family);
    expect(res.statusCode).toBe(200);
    expect(res.json().visit.state).toBe("completed");
    expect(typeof res.json().visit.endedAt).toBe("string");
    const states = db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, id)).all().map((e) => e.toState);
    expect(states.at(-1)).toBe("completed");
    expect(states.filter((s) => s === "ending")).toHaveLength(0);
  });

  test("family cancel works from robot_en_route and is refused once completed", async () => {
    const a = await visitIn("robot_en_route");
    expect((await a.act("cancel", a.tokens.family)).json().visit.state).toBe("cancelled");
    const b = await visitIn("completed");
    expect((await b.act("cancel", b.tokens.family)).statusCode).toBe(409);
  });

  test("a device for another resident cannot answer", async () => {
    const { db, app, act } = await visitIn("awaiting_resident_consent");
    const { hashSecret } = await import("../src/auth/password");
    db.insert(t.resident).values({ id: "resident_demo_02", facilityId: SEED_IDS.facility, displayName: "Other", roomLocationId: SEED_IDS.roomLocation }).run();
    db.insert(t.device).values({ id: "ipad_demo_02", facilityId: SEED_IDS.facility, robotId: SEED_IDS.robot, kind: "ipad", residentId: "resident_demo_02", deviceTokenHash: await hashSecret("other-device") }).run();
    const tok = (await app.inject({ method: "POST", url: "/auth/device", payload: { deviceToken: "other-device" } })).json().token;
    expect((await act("answer", tok)).statusCode).toBe(403);
  });

  test("unknown action is 404", async () => {
    const { tokens, act } = await visitIn("active");
    expect((await act("teleport", tokens.staff)).statusCode).toBe(404);
  });
});
