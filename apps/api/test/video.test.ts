import { describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";
import { grantsFor, LiveKitProvider } from "../src/services/video";
import { RoomServiceClient, ParticipantInfo, TrackInfo, TrackSource, TrackType, ServerError } from "livekit-server-sdk";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("staff camera media control", () => {
  test("only staff can pause/resume the resident camera; reports state, audits and never sends physical commands", async () => {
    const { app, db, video, tokens, id } = await visitIn("active");
    const sent: unknown[] = []; app.hub.attach(SEED_IDS.robot, { send: m => sent.push(m) });
    const events: unknown[] = []; app.transitions.subscribe(e => events.push(e));
    // The fake has no media until an explicit camera fixture is supplied.
    video.cameras.set(`${id}:${SEED_IDS.device}`, "on");
    const camera = (paused: unknown, token = tokens.staff, visit = id) => app.inject({ method: "POST", url: `/visits/${visit}/camera`, headers: auth(token), payload: { paused } });
    expect((await camera(true, tokens.family)).statusCode).toBe(403);
    expect((await camera(true, tokens.device)).statusCode).toBe(403);
    expect((await camera(true, tokens.staff, "missing")).statusCode).toBe(404);
    expect((await camera("true")).statusCode).toBe(400);
    expect((await camera(true)).json()).toEqual({ ok: true, cameraState: "paused" });
    expect((await app.inject({ method: "GET", url: "/queue", headers: auth(tokens.staff) })).json().activeVisits[0].cameraState).toBe("paused");
    expect((await camera(false)).json()).toEqual({ ok: true, cameraState: "on" });
    expect(events).toEqual([expect.objectContaining({ reason: "staff_camera_paused", entityType: "visit", entityId: id, fromState: null, toState: null }), expect.objectContaining({ reason: "staff_camera_resumed" })]);
    expect(app.visits.get(id)?.state).toBe("active");
    expect(sent).toEqual([]); expect(video.closed).toEqual([]);
    db.update(t.visitSession).set({ state: "ending" }).where(eq(t.visitSession.id, id)).run();
    expect((await camera(true)).statusCode).toBe(409);
  });
  test("no camera is unavailable and provider failure is unknown, with no success audit", async () => {
    const { app, video, tokens, id } = await visitIn("active");
    const camera = () => app.inject({ method: "POST", url: `/visits/${id}/camera`, headers: auth(tokens.staff), payload: { paused: true } });
    expect((await camera()).json()).toEqual({ error: "camera_unavailable" });
    const queue = async () => (await app.inject({ method: "GET", url: "/queue", headers: auth(tokens.staff) })).json();
    expect((await queue()).activeVisits[0].cameraState).toBe("unavailable");
    vi.spyOn(video, "setCameraPaused").mockRejectedValue(new Error("secret upstream failure"));
    vi.spyOn(video, "cameraState").mockRejectedValue(new Error("secret upstream failure"));
    const failed = await camera();
    expect(failed.statusCode).toBe(503); expect(failed.json()).toEqual({ error: "camera_control_failed" });
    expect((await queue()).activeVisits[0].cameraState).toBe("unknown");
    expect((await app.inject({ method: "GET", url: "/audit", headers: auth(tokens.staff) })).json().events.filter((e: { reason: string }) => e.reason?.startsWith("staff_camera"))).toEqual([]);
  });
  test("provider changes only CAMERA video tracks and verifies the returned mute result", async () => {
    const tracks = [new TrackInfo({ sid: "cam", source: TrackSource.CAMERA, type: TrackType.VIDEO, muted: false }), new TrackInfo({ sid: "mic", source: TrackSource.MICROPHONE, type: TrackType.AUDIO }), new TrackInfo({ sid: "screen", source: TrackSource.SCREEN_SHARE, type: TrackType.VIDEO })];
    const get = vi.spyOn(RoomServiceClient.prototype, "getParticipant").mockResolvedValue(new ParticipantInfo({ identity: "device", tracks }));
    const mute = vi.spyOn(RoomServiceClient.prototype, "mutePublishedTrack").mockImplementation(async (_room, _identity, sid, muted) => new TrackInfo({ sid, source: TrackSource.CAMERA, type: TrackType.VIDEO, muted }));
    try {
      const provider = new LiveKitProvider("wss://example.invalid", "key", "secret");
      expect(await provider.cameraState("visit", "device")).toBe("on");
      expect(await provider.setCameraPaused("visit", "device", true)).toBe("paused");
      expect(mute.mock.calls).toEqual([["visit", "device", "cam", true]]);
      expect(await provider.setCameraPaused("visit", "device", false)).toBe("on");
      mute.mockResolvedValueOnce(new TrackInfo({ sid: "cam", source: TrackSource.CAMERA, type: TrackType.VIDEO, muted: true }));
      await expect(provider.setCameraPaused("visit", "device", false)).rejects.toThrow("camera_control_failed");
      get.mockResolvedValueOnce(new ParticipantInfo({ identity: "device", tracks: tracks.slice(1) }));
      expect(await provider.setCameraPaused("visit", "device", true)).toBe("unavailable");
      get.mockResolvedValueOnce(new ParticipantInfo({ identity: "device", tracks: [new TrackInfo({ ...tracks[0], muted: true })] }));
      expect(await provider.cameraState("visit", "device")).toBe("paused");
      get.mockRejectedValueOnce(new ServerError("not_found", "participant missing", 404, "not_found"));
      expect(await provider.cameraState("visit", "device")).toBe("unavailable");
    } finally { get.mockRestore(); mute.mockRestore(); }
  });
  test("a camera operation finishing after the call ends cannot report a current camera success", async () => {
    const { app, video, tokens, id } = await visitIn("active");
    let finish!: (state: "paused") => void;
    const operation = vi.spyOn(video, "setCameraPaused").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = app.inject({ method: "POST", url: `/visits/${id}/camera`, headers: auth(tokens.staff), payload: { paused: true } });
    const response = pending.then(res => res);
    await vi.waitFor(() => expect(operation).toHaveBeenCalled());
    await app.inject({ method: "POST", url: `/visits/${id}/end`, headers: auth(tokens.staff) });
    finish("paused");
    expect((await response).statusCode).toBe(409);
  });
});

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
