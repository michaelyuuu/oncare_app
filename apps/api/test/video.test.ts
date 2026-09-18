import { describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";
import { grantsFor } from "../src/services/video";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function visitIn(state: string) {
  const ctx = await makeTestApp();
  const id = (await ctx.app.inject({ method: "POST", url: "/visits", headers: auth(ctx.tokens.family), payload: { residentId: SEED_IDS.resident } })).json().visit.id as string;
  ctx.db.update(t.visitSession).set({ state }).where(eq(t.visitSession.id, id)).run();
  const token = (tok: string) => ctx.app.inject({ method: "POST", url: `/visits/${id}/token`, headers: auth(tok) });
  return { ...ctx, id, token };
}

describe("grantsFor", () => {
  test("family and device publish+subscribe, staff subscribe only", () => {
    expect(grantsFor("family")).toEqual({ canPublish: true, canSubscribe: true });
    expect(grantsFor("device")).toEqual({ canPublish: true, canSubscribe: true });
    expect(grantsFor("staff")).toEqual({ canPublish: false, canSubscribe: true });
  });
});

describe("POST /visits/:id/token", () => {
  test("missing visits return 404 and unrelated devices return 403 without issuing tokens", async () => {
    const { app, video, tokens, token } = await visitIn("connecting");
    expect((await app.inject({ method: "POST", url: "/visits/missing/token", headers: auth(tokens.family) })).statusCode).toBe(404);
    const otherDevice = app.jwt.sign({ kind: "device", id: "other_device", residentId: "other_resident", robotId: SEED_IDS.robot });
    expect((await token(otherDevice)).statusCode).toBe(403);
    expect(video.issued).toEqual([]);
  });
  test("device gets a publishing token while the call is ringing; family does not yet", async () => {
    const { video, tokens, id, token } = await visitIn("awaiting_resident_consent");
    const d = await token(tokens.device);
    expect(d.statusCode).toBe(200);
    expect(d.json()).toEqual({ url: video.url, token: `fake.${id}.${SEED_IDS.device}.pub`, room: id });
    expect(video.issued[0]).toMatchObject({ room: id, identity: SEED_IDS.device, canPublish: true, canSubscribe: true, ttlSeconds: 600 });
    expect((await token(tokens.family)).statusCode).toBe(409);
  });

  test("family and staff get tokens once connecting; staff cannot publish", async () => {
    const { video, tokens, token } = await visitIn("connecting");
    expect((await token(tokens.family)).statusCode).toBe(200);
    expect((await token(tokens.staff)).json().token).toMatch(/\.sub$/);
    expect(video.issued.find((g) => g.identity === SEED_IDS.staffUser)).toMatchObject({ canPublish: false, canSubscribe: true });
  });

  test("no token for a completed visit, and never for an unrelated family user", async () => {
    const { db, app, tokens, token } = await visitIn("completed");
    expect((await token(tokens.family)).statusCode).toBe(409);
    const { hashSecret } = await import("../src/auth/password");
    db.insert(t.user).values({ id: "family_demo_02", role: "family", username: "family2", displayName: "Other", passwordHash: await hashSecret("pw"), pinHash: null }).run();
    const other = (await app.inject({ method: "POST", url: "/auth/login", payload: { username: "family2", password: "pw" } })).json().token;
    expect((await token(other)).statusCode).toBe(403);
  });

  test("token name carries the display name and nothing else personal", async () => {
    const { video, tokens, token } = await visitIn("active");
    await token(tokens.family);
    expect(video.issued[0]?.name).toBe("Demo Daughter");
    expect(Object.keys(video.issued[0]!).sort()).toEqual(["canPublish", "canSubscribe", "identity", "name", "room", "ttlSeconds"]);
  });
});

describe("room lifecycle", () => {
  test("ending the call closes the room exactly once", async () => {
    const { app, video, tokens, id } = await visitIn("active");
    await app.inject({ method: "POST", url: `/visits/${id}/end`, headers: auth(tokens.family) });
    expect(video.closed).toEqual([id]);
  });

  test.each(["connecting", "active"])("connection_lost from %s moves the visit to connection_failed and closes the room", async (state) => {
    const a = await visitIn(state);
    const res = await a.app.inject({ method: "POST", url: `/visits/${a.id}/connection_lost`, headers: auth(a.tokens.device) });
    expect(res.json().visit.state).toBe("connection_failed");
    expect(a.video.closed).toEqual([a.id]);
    const b = await visitIn("robot_en_route");
    expect((await b.app.inject({ method: "POST", url: `/visits/${b.id}/connection_lost`, headers: auth(b.tokens.family) })).statusCode).toBe(409);
  });

  test("cancelling before the call never touches the room", async () => {
    const { app, video, tokens, id } = await visitIn("accepted");
    await app.inject({ method: "POST", url: `/visits/${id}/cancel`, headers: auth(tokens.family) });
    expect(video.closed).toEqual([]);
  });

  test("declining while the device could hold a prejoin token closes the room", async () => {
    const { app, video, tokens, id } = await visitIn("awaiting_resident_consent");
    await app.inject({ method: "POST", url: `/visits/${id}/decline`, headers: auth(tokens.device) });
    expect(video.closed).toEqual([id]);
  });

  test("an invalid or repeated terminal action does not close the room again", async () => {
    const { app, video, tokens, id } = await visitIn("active");
    expect((await app.inject({ method: "POST", url: `/visits/${id}/end`, headers: auth(tokens.family) })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/visits/${id}/end`, headers: auth(tokens.family) })).statusCode).toBe(409);
    expect(video.closed).toEqual([id]);
  });

  test("background close failures are logged with the visit id", async () => {
    const { app, video, tokens, id } = await visitIn("active");
    vi.spyOn(video, "closeRoom").mockRejectedValueOnce(new Error("close failed"));
    const log = vi.spyOn(app.log, "error").mockImplementation(() => undefined);
    await app.inject({ method: "POST", url: `/visits/${id}/end`, headers: auth(tokens.family) });
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith({ visitId: id }, "failed to close video room"));
  });

  test.each(["awaiting_resident_consent", "connecting", "active"])("staff stop closes a %s room once", async (state) => {
    const { app, db, video, id } = await visitIn(state);
    db.update(t.robotCommand).set({ result: "accepted", ackedAt: new Date().toISOString() }).where(eq(t.robotCommand.visitId, id)).run();
    app.dispatch.sendStop(SEED_IDS.robot, SEED_IDS.staffUser);
    expect(app.visits.get(id)?.state).toBe("safety_stopped");
    app.dispatch.sendStop(SEED_IDS.robot, SEED_IDS.staffUser);
    expect(video.closed).toEqual([id]);
  });

  test.each([
    ["connecting", "safety_stopped"], ["active", "safety_stopped"],
    ["connecting", "cancelled"], ["active", "cancelled"],
  ] as const)("gateway %s -> %s closes the room once", async (state, event) => {
    const { app, video, id } = await visitIn(state);
    app.hub.receive(SEED_IDS.robot, { type: "state_event", correlationId: id, at: new Date().toISOString(), event });
    expect(app.visits.get(id)?.state).toBe(event);
    app.hub.receive(SEED_IDS.robot, { type: "state_event", correlationId: id, at: new Date().toISOString(), event });
    expect(video.closed).toEqual([id]);
  });

  test("API close disposes the room transition subscription", async () => {
    const { app, db, video, id } = await visitIn("active");
    db.insert(t.visitSession).values({ ...app.visits.get(id)!, id: "visit_after_close" }).run();
    app.transitions.apply({ entityType: "visit", entityId: id, to: "ending", actorType: "system", actorId: "api" });
    expect(video.closed).toEqual([id]);
    await app.close();
    app.transitions.apply({ entityType: "visit", entityId: "visit_after_close", to: "ending", actorType: "system", actorId: "api" });
    app.transitions.apply({ entityType: "visit", entityId: id, to: "completed", actorType: "system", actorId: "api" });
    expect(video.closed).toEqual([id]);
  });
});
