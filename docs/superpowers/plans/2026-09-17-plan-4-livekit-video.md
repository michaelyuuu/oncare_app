# Plan 4: LiveKit Video Behind a VideoProvider Adapter

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. UI tasks (3–4) load the `frontend-design` skill first.

**Goal:** A real two-way video call between the family browser and the resident iPad, issued through short-lived per-identity LiveKit tokens from the API, with the visit state driven by actual call events and a defined failure path when the call drops.

**Architecture:** `VideoProvider` is the only place that knows LiveKit exists on the server; `LiveKitProvider` wraps `livekit-server-sdk`, `FakeVideoProvider` serves tests. Room name = visit id. Clients get a token from `POST /visits/:id/token` and connect with `livekit-client`. The client reports `connected` when a remote participant is present, and `connection_lost` when the SDK gives up reconnecting; the API turns those into `active` / `connection_failed`. When a visit enters `ending` or any terminal state, the API closes the room so nobody lingers on camera.

**Tech Stack:** `livekit-server-sdk` (API), `livekit-client` (browsers), Node 24 `process.loadEnvFile` for `.env`.

**Spec:** `docs/superpowers/specs/2026-09-17-oncare-platform-design.md` (section 4 "Video", section 1 rule 1)

**Depends on:** Plans 1–3 complete. Owner input: `apps/api/.env` already holds `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (git-ignored).

## Global Constraints

- Video traffic and robot command traffic use separately authorized paths: a LiveKit token never grants anything about the robot, and the `/gateway` socket never carries media.
- Token grants: family `canPublish + canSubscribe`; device `canPublish + canSubscribe`; staff `canSubscribe` only. TTL 10 minutes. Identity = principal id; `name` = display name (no other personal data in the token).
- A token is issued only while the visit is in `awaiting_resident_consent` (device only, so the call is ready the instant the resident taps Answer), `connecting`, or `active`. Otherwise 409.
- No video or audio is ever recorded or stored by our code.
- Secrets only in `apps/api/.env`; tests use `FakeVideoProvider`, never the network.
- Test commands: `npx vitest run <path>` from the repo root.
- Commit trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC
  ```
- Do not modify anything under `D:/ontaru/AGI carehouse/on_software_all`.

## File structure produced by this plan

```
apps/api/src/services/video.ts        VideoProvider, LiveKitProvider, FakeVideoProvider, grantsFor(role)
apps/api/src/routes/video.ts          POST /visits/:id/token
apps/api/src/services/visits.ts       + "connection_lost" action; closeRoom on ending/terminal
apps/api/src/app.ts                   video provider wiring (env → LiveKit, tests → fake)
apps/api/src/server.ts                process.loadEnvFile("apps/api/.env") when present
apps/api/test/video.test.ts
packages/web-common/src/call.ts       createCall(url, token, opts): thin livekit-client wrapper with callbacks
packages/web-common/test/call.test.ts (mocks livekit-client)
apps/resident/src/screens/InCall.tsx  real call: remote video fills the stage, volume applies to remote audio
apps/family/src/pages/Visit.tsx       call panel while connecting/active; mute controls; replaces the auto "connected" stand-in
docs/demo-visit-flow.md               updated for real video
```

---

### Task 1: `VideoProvider` with LiveKit and fake implementations; `POST /visits/:id/token`

**Files:**
- Create: `apps/api/src/services/video.ts`, `apps/api/src/routes/video.ts`
- Modify: `apps/api/src/app.ts` (accept `video?: VideoProvider` in `AppOptions`; default to `FakeVideoProvider` when no LiveKit env is present, `LiveKitProvider` otherwise), `apps/api/src/server.ts` (load `.env`), `apps/api/package.json` (add `"livekit-server-sdk": "^2.7.0"`)
- Modify: `apps/api/test/helpers.ts` — `makeTestApp()` returns `video: FakeVideoProvider`
- Test: `apps/api/test/video.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // services/video.ts
  export interface VideoGrant { room: string; identity: string; name: string; canPublish: boolean; canSubscribe: boolean; ttlSeconds: number }
  export interface VideoProvider {
    url: string;
    issueToken(grant: VideoGrant): Promise<string>;
    closeRoom(room: string): Promise<void>;     // idempotent; unknown room is not an error
  }
  export function grantsFor(role: "family" | "device" | "staff"): { canPublish: boolean; canSubscribe: boolean };
  export class LiveKitProvider implements VideoProvider { constructor(url: string, apiKey: string, apiSecret: string) }
  export class FakeVideoProvider implements VideoProvider {
    url = "wss://fake.livekit.local";
    issued: VideoGrant[] = []; closed: string[] = [];
    issueToken(g) -> `fake.${g.room}.${g.identity}.${g.canPublish ? "pub" : "sub"}`
  }
  // routes/video.ts
  POST /visits/:id/token  (family owner | device same resident | staff)
    -> 200 { url, token, room: visitId } | 403 | 404 | 409 { error: "not_callable" }
    device is also allowed while awaiting_resident_consent; family and staff only from connecting onward
  ```
- `LiveKitProvider.issueToken` uses `AccessToken(apiKey, apiSecret, { identity, name, ttl: ttlSeconds })` with `addGrant({ roomJoin: true, room, canPublish, canSubscribe, canPublishData: false })` and returns `await token.toJwt()`. `closeRoom` uses `RoomServiceClient(httpUrl, apiKey, apiSecret).deleteRoom(room)` where `httpUrl` is `url` with `wss://` → `https://`; swallow "not found" errors only.
- Visit service change: in `act()`, after a successful transition to `ending` or any state in `VISIT_TERMINAL_STATES`, call `video.closeRoom(visit.id)` (fire-and-forget with a caught promise). Add action `connection_lost` (roles family, device; transition `connecting|active → connection_failed`) to the `ACTIONS` table. `createVisitService` gains a `video: VideoProvider` parameter.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/video.test.ts
import { describe, expect, test } from "vitest";
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
    await new Promise((r) => setTimeout(r, 10));
    expect(video.closed).toEqual([id]);
  });

  test("connection_lost from connecting or active moves the visit to connection_failed and closes the room", async () => {
    const a = await visitIn("active");
    const res = await a.app.inject({ method: "POST", url: `/visits/${a.id}/connection_lost`, headers: auth(a.tokens.device) });
    expect(res.json().visit.state).toBe("connection_failed");
    await new Promise((r) => setTimeout(r, 10));
    expect(a.video.closed).toEqual([a.id]);
    const b = await visitIn("robot_en_route");
    expect((await b.app.inject({ method: "POST", url: `/visits/${b.id}/connection_lost`, headers: auth(b.tokens.family) })).statusCode).toBe(409);
  });

  test("cancelling before the call never touches the room", async () => {
    const { app, video, tokens, id } = await visitIn("accepted");
    await app.inject({ method: "POST", url: `/visits/${id}/cancel`, headers: auth(tokens.family) });
    await new Promise((r) => setTimeout(r, 10));
    expect(video.closed).toEqual([]);
  });
});
```

Note the last test: `closeRoom` is called only when the visit had reached `connecting` or later (`connectedAt` set or state ∈ connecting|active|ending). Implement that check, not "every terminal transition".

- [ ] **Step 2: Run test to verify it fails**

Run: `npm install --no-audit --no-fund` (after adding `livekit-server-sdk`) then `npx vitest run apps/api/test/video.test.ts`
Expected: FAIL — `../src/services/video` missing.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/video.ts
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";

export interface VideoGrant { room: string; identity: string; name: string; canPublish: boolean; canSubscribe: boolean; ttlSeconds: number }
export interface VideoProvider {
  url: string;
  issueToken(grant: VideoGrant): Promise<string>;
  closeRoom(room: string): Promise<void>;
}

export function grantsFor(role: "family" | "device" | "staff"): { canPublish: boolean; canSubscribe: boolean } {
  return role === "staff" ? { canPublish: false, canSubscribe: true } : { canPublish: true, canSubscribe: true };
}

export class LiveKitProvider implements VideoProvider {
  private rooms: RoomServiceClient;
  constructor(public url: string, private apiKey: string, private apiSecret: string) {
    this.rooms = new RoomServiceClient(url.replace(/^wss:/, "https:").replace(/^ws:/, "http:"), apiKey, apiSecret);
  }
  async issueToken(g: VideoGrant): Promise<string> {
    const at = new AccessToken(this.apiKey, this.apiSecret, { identity: g.identity, name: g.name, ttl: g.ttlSeconds });
    at.addGrant({ roomJoin: true, room: g.room, canPublish: g.canPublish, canSubscribe: g.canSubscribe, canPublishData: false });
    return at.toJwt();
  }
  async closeRoom(room: string): Promise<void> {
    try { await this.rooms.deleteRoom(room); }
    catch (e) { if (!/not found|404/i.test(String(e))) throw e; }
  }
}

export class FakeVideoProvider implements VideoProvider {
  url = "wss://fake.livekit.local";
  issued: VideoGrant[] = [];
  closed: string[] = [];
  async issueToken(g: VideoGrant): Promise<string> { this.issued.push(g); return `fake.${g.room}.${g.identity}.${g.canPublish ? "pub" : "sub"}`; }
  async closeRoom(room: string): Promise<void> { this.closed.push(room); }
}

export function videoProviderFromEnv(env: NodeJS.ProcessEnv): VideoProvider {
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = env;
  if (LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET) return new LiveKitProvider(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  return new FakeVideoProvider();
}
```

```ts
// apps/api/src/routes/video.ts
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { requireRole } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import { grantsFor } from "../services/video";

const TOKEN_TTL_SECONDS = 600;

export async function videoRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  app.post("/visits/:id/token", { preHandler: requireRole("family", "staff", "device") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const visit = app.visits.get(id);
    if (!visit) return reply.code(404).send({ error: "not_found" });
    const p = req.principal;
    if (!app.visits.canView(p, visit)) return reply.code(403).send({ error: "forbidden" });
    const role = p.kind === "device" ? "device" : p.role;
    const callable = role === "device"
      ? ["awaiting_resident_consent", "connecting", "active"].includes(visit.state)
      : ["connecting", "active"].includes(visit.state);
    if (!callable) return reply.code(409).send({ error: "not_callable" });
    const name = p.kind === "device"
      ? db.select({ n: t.resident.displayName }).from(t.resident).where(eq(t.resident.id, p.residentId)).get()?.n ?? "Resident"
      : db.select({ n: t.user.displayName }).from(t.user).where(eq(t.user.id, p.id)).get()?.n ?? role;
    const token = await app.video.issueToken({ room: visit.id, identity: p.id, name, ...grantsFor(role), ttlSeconds: TOKEN_TTL_SECONDS });
    return { url: app.video.url, token, room: visit.id };
  });
}
```

Visit service changes (`apps/api/src/services/visits.ts`):
- signature: `createVisitService(db, transitions, video: VideoProvider, opts)`.
- `ACTIONS` gains `connection_lost: { roles: ["family", "device"], to: ["connection_failed"] }`.
- after the transition loop in `act()`: `const reached = ["connecting", "active", "ending"].includes(visit.state) || visit.connectedAt !== null; if (reached && (input.action === "end" || input.action === "connection_lost" || input.action === "cancel")) void video.closeRoom(visit.id).catch(() => {});` (`visit` here is the row loaded before the transition; `ending → completed` happens inside the `end` action so this fires once).

`app.ts`: `AppOptions` gains `video?: VideoProvider`; `const video = opts.video ?? videoProviderFromEnv(process.env); app.decorate("video", video);` (augment `FastifyInstance` with `video: VideoProvider`); pass `video` to `createVisitService`; register `videoRoutes`.
`server.ts`: at the top, `try { process.loadEnvFile(new URL("../.env", import.meta.url)); } catch { /* no .env: fake video */ }` and log which provider is active (`fake` vs `livekit`) without printing secrets.
`test/helpers.ts`: create `const video = new FakeVideoProvider()` and pass it to `buildApp`; return it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/api && npx tsc -b`
Expected: PASS (8 new tests), all existing API tests still green (`makeTestApp` signature change is backward compatible).

- [ ] **Step 5: Real-token smoke (no network media)**

Run from the repo root: `npm run dev -w @oncare/api`; in another shell, log in as `family`, create a visit, force it to `active` with `sqlite3` or by walking the actions, then `curl -X POST localhost:3000/visits/<id>/token -H "authorization: Bearer <jwt>"`. Expected: a JWT whose payload (decode at jwt.io or with `node -e`) shows `video.room = <visit id>`, `canPublish: true`, `exp - iat = 600`. Do not paste the token into any report.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/video.ts apps/api/src/routes/video.ts apps/api/src/services/visits.ts apps/api/src/app.ts apps/api/src/server.ts apps/api/package.json package-lock.json apps/api/test/helpers.ts apps/api/test/video.test.ts
git commit -m "feat(api): LiveKit video provider adapter and per-identity visit tokens" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 2: `createCall()` — a thin, testable wrapper around `livekit-client`

**Files:**
- Create: `packages/web-common/src/call.ts`
- Modify: `packages/web-common/package.json` — add `"livekit-client": "^2.5.0"`; `src/index.ts` — export `./call`
- Test: `packages/web-common/test/call.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CallCallbacks {
    onRemoteVideo(el: HTMLVideoElement | null): void;      // attached element for the first remote camera track, null when it leaves
    onRemoteAudio(el: HTMLAudioElement | null): void;
    onRemoteParticipant(present: boolean): void;            // true when >=1 remote participant is in the room
    onLocalState(s: { camera: boolean; mic: boolean }): void;
    onLost(): void;                                         // SDK gave up reconnecting (RoomEvent.Disconnected after a failed reconnect) or explicit server disconnect
  }
  export interface CallHandle {
    setVolume(v0to100: number): void;                       // applies to every remote audio track
    setMic(on: boolean): Promise<void>;
    setCamera(on: boolean): Promise<void>;
    localVideoElement(): HTMLVideoElement | null;           // for the family app's self-preview
    leave(): Promise<void>;
  }
  export async function createCall(url: string, token: string, cb: CallCallbacks, opts?: { publish: boolean; RoomImpl?: typeof Room }): Promise<CallHandle>;
  ```
- Uses `Room`, `RoomEvent`, `Track` from `livekit-client`. `publish: false` (staff) subscribes only. On `RoomEvent.TrackSubscribed` with `track.kind === Track.Kind.Video` → `cb.onRemoteVideo(track.attach())`; audio → `track.attach()` + volume applied + `cb.onRemoteAudio`. On `TrackUnsubscribed` → detach, callback `null`. `ParticipantConnected/Disconnected` → `cb.onRemoteParticipant(room.remoteParticipants.size > 0)`. `RoomEvent.Disconnected` → `cb.onLost()` unless `leave()` was called. `RoomEvent.Reconnecting`/`Reconnected` are logged only; the SDK handles up to its own timeout.

- [ ] **Step 1: Write the failing test**

```ts
// packages/web-common/test/call.test.ts
import { describe, expect, test, vi } from "vitest";
import { createCall } from "../src/call";

// Minimal fake of livekit-client's Room with the event names the wrapper uses.
class FakeTrack {
  el: any = { play: vi.fn(), remove: vi.fn(), volume: 1 };
  constructor(public kind: "video" | "audio") {}
  attach() { return this.el; }
  detach() { return [this.el]; }
  setVolume = vi.fn();
}
class FakeRoom {
  static last: FakeRoom;
  handlers = new Map<string, Function[]>();
  remoteParticipants = new Map<string, unknown>();
  localParticipant = { setMicrophoneEnabled: vi.fn(async () => {}), setCameraEnabled: vi.fn(async () => {}), videoTrackPublications: new Map() };
  connected = false;
  constructor() { FakeRoom.last = this; }
  on(ev: string, h: Function) { (this.handlers.get(ev) ?? this.handlers.set(ev, []).get(ev)!).push(h); return this; }
  emit(ev: string, ...args: unknown[]) { for (const h of this.handlers.get(ev) ?? []) h(...args); }
  async connect(_url: string, _token: string) { this.connected = true; }
  async disconnect() { this.connected = false; this.emit("disconnected"); }
}
vi.mock("livekit-client", () => ({
  Room: FakeRoom,
  RoomEvent: { TrackSubscribed: "trackSubscribed", TrackUnsubscribed: "trackUnsubscribed", ParticipantConnected: "participantConnected", ParticipantDisconnected: "participantDisconnected", Disconnected: "disconnected", Reconnecting: "reconnecting", Reconnected: "reconnected" },
  Track: { Kind: { Video: "video", Audio: "audio" } },
}));

function callbacks() {
  return { onRemoteVideo: vi.fn(), onRemoteAudio: vi.fn(), onRemoteParticipant: vi.fn(), onLocalState: vi.fn(), onLost: vi.fn() };
}

describe("createCall", () => {
  test("connects, publishes when asked, and reports remote video/audio attach and detach", async () => {
    const cb = callbacks();
    const handle = await createCall("wss://x", "tok", cb, { publish: true });
    const room = FakeRoom.last;
    expect(room.connected).toBe(true);
    expect(room.localParticipant.setCameraEnabled).toHaveBeenCalledWith(true);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(cb.onLocalState).toHaveBeenLastCalledWith({ camera: true, mic: true });
    const v = new FakeTrack("video"); const a = new FakeTrack("audio");
    room.emit("trackSubscribed", v, {}, {});
    room.emit("trackSubscribed", a, {}, {});
    expect(cb.onRemoteVideo).toHaveBeenCalledWith(v.el);
    expect(cb.onRemoteAudio).toHaveBeenCalledWith(a.el);
    handle.setVolume(30);
    expect(a.setVolume).toHaveBeenCalledWith(0.3);
    room.emit("trackUnsubscribed", v, {}, {});
    expect(cb.onRemoteVideo).toHaveBeenLastCalledWith(null);
    await handle.leave();
    expect(cb.onLost).not.toHaveBeenCalled();
  });

  test("subscribe-only never enables camera or mic", async () => {
    const cb = callbacks();
    await createCall("wss://x", "tok", cb, { publish: false });
    expect(FakeRoom.last.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
    expect(cb.onLocalState).toHaveBeenLastCalledWith({ camera: false, mic: false });
  });

  test("remote participant presence and unexpected disconnect", async () => {
    const cb = callbacks();
    await createCall("wss://x", "tok", cb, { publish: true });
    const room = FakeRoom.last;
    room.remoteParticipants.set("p1", {});
    room.emit("participantConnected", {});
    expect(cb.onRemoteParticipant).toHaveBeenLastCalledWith(true);
    room.remoteParticipants.clear();
    room.emit("participantDisconnected", {});
    expect(cb.onRemoteParticipant).toHaveBeenLastCalledWith(false);
    room.emit("disconnected");
    expect(cb.onLost).toHaveBeenCalledTimes(1);
  });

  test("setMic/setCamera toggle and report local state", async () => {
    const cb = callbacks();
    const h = await createCall("wss://x", "tok", cb, { publish: true });
    await h.setMic(false);
    expect(FakeRoom.last.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    expect(cb.onLocalState).toHaveBeenLastCalledWith({ camera: true, mic: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm install --no-audit --no-fund` then `npx vitest run packages/web-common/test/call.test.ts`
Expected: FAIL — `../src/call` missing.

- [ ] **Step 3: Write the implementation**

```ts
// packages/web-common/src/call.ts
import { Room, RoomEvent, Track, type RemoteTrack } from "livekit-client";

export interface CallCallbacks {
  onRemoteVideo(el: HTMLVideoElement | null): void;
  onRemoteAudio(el: HTMLAudioElement | null): void;
  onRemoteParticipant(present: boolean): void;
  onLocalState(s: { camera: boolean; mic: boolean }): void;
  onLost(): void;
}
export interface CallHandle {
  setVolume(v0to100: number): void;
  setMic(on: boolean): Promise<void>;
  setCamera(on: boolean): Promise<void>;
  localVideoElement(): HTMLVideoElement | null;
  leave(): Promise<void>;
}

export async function createCall(url: string, token: string, cb: CallCallbacks, opts: { publish: boolean; RoomImpl?: typeof Room } = { publish: true }): Promise<CallHandle> {
  const RoomCtor = opts.RoomImpl ?? Room;
  const room = new RoomCtor({ adaptiveStream: true, dynacast: true });
  const audioTracks = new Set<RemoteTrack>();
  let volume = 0.7;
  let leaving = false;
  const local = { camera: false, mic: false };

  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
    if (track.kind === Track.Kind.Video) cb.onRemoteVideo(track.attach() as HTMLVideoElement);
    else if (track.kind === Track.Kind.Audio) { const el = track.attach() as HTMLAudioElement; audioTracks.add(track); (track as { setVolume?: (v: number) => void }).setVolume?.(volume); cb.onRemoteAudio(el); }
  });
  room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
    for (const el of track.detach()) el.remove();
    if (track.kind === Track.Kind.Video) cb.onRemoteVideo(null);
    else if (track.kind === Track.Kind.Audio) { audioTracks.delete(track); cb.onRemoteAudio(null); }
  });
  const presence = () => cb.onRemoteParticipant(room.remoteParticipants.size > 0);
  room.on(RoomEvent.ParticipantConnected, presence);
  room.on(RoomEvent.ParticipantDisconnected, presence);
  room.on(RoomEvent.Disconnected, () => { if (!leaving) cb.onLost(); });

  await room.connect(url, token);
  if (opts.publish) {
    await room.localParticipant.setCameraEnabled(true);
    await room.localParticipant.setMicrophoneEnabled(true);
    local.camera = true; local.mic = true;
  }
  cb.onLocalState({ ...local });

  return {
    setVolume(v) { volume = Math.min(1, Math.max(0, v / 100)); for (const t of audioTracks) (t as { setVolume?: (v: number) => void }).setVolume?.(volume); },
    async setMic(on) { await room.localParticipant.setMicrophoneEnabled(on); local.mic = on; cb.onLocalState({ ...local }); },
    async setCamera(on) { await room.localParticipant.setCameraEnabled(on); local.camera = on; cb.onLocalState({ ...local }); },
    localVideoElement() {
      for (const pub of room.localParticipant.videoTrackPublications.values()) { const t = pub.track; if (t) return t.attach() as HTMLVideoElement; }
      return null;
    },
    async leave() { leaving = true; await room.disconnect(); },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/web-common && npx tsc -b`
Expected: PASS (4 new tests); typecheck clean (if `livekit-client` types complain about `setVolume` on `RemoteTrack`, keep the structural cast shown rather than `any`).

- [ ] **Step 5: Commit**

```bash
git add packages/web-common/src/call.ts packages/web-common/src/index.ts packages/web-common/package.json package-lock.json packages/web-common/test/call.test.ts
git commit -m "feat(web-common): createCall wrapper over livekit-client with volume, mute, presence and loss callbacks" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 3: Resident `InCall` screen uses the real call

**Load the `frontend-design` skill first.**

**Files:**
- Modify: `apps/resident/src/screens/InCall.tsx`, `apps/resident/src/App.tsx` (pass `api`, `apiBase`, `visitId`, `onConnected`, `onLost` into `InCall`; camera/mic status in `StatusBar` now comes from the call's `onLocalState`)
- Test: `apps/resident/test/InCall.test.tsx` (mocks `@oncare/web-common`'s `createCall`)

**Interfaces:**
- `InCall` props become: `{ api: Api; visitId: string; callerName: string; active: boolean; onConnected: () => void; onLost: () => void; onEnd: () => void; onLocalState: (s: { camera: boolean; mic: boolean }) => void }`.
- Behaviour: on mount, `POST /visits/:id/token` → `createCall(url, token, cb, { publish: true })`; remote video element is appended into the `video-stage` div (`ref`), remote audio element appended hidden; `onRemoteParticipant(true)` → `onConnected()` (App posts `/visits/:id/connected` once); `onLost` → App posts `/visits/:id/connection_lost` then refreshes; Louder/Quieter call `handle.setVolume`; End → `handle.leave()` then `onEnd()`. On unmount → `leave()`. If the token request fails with 409 (state moved on), do nothing and let the next refresh change the screen.
- App: remove any leftover automatic `connected` logic; `StatusBar` `cameraOn/micOn` come from the last `onLocalState` while on `in_call`, false otherwise.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/resident/test/InCall.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

const handle = { setVolume: vi.fn(), setMic: vi.fn(), setCamera: vi.fn(), localVideoElement: () => null, leave: vi.fn(async () => {}) };
let capturedCb: any;
vi.mock("@oncare/web-common", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@oncare/web-common")>();
  return { ...orig, createCall: vi.fn(async (_u: string, _t: string, cb: any) => { capturedCb = cb; return handle; }) };
});
import { createCall } from "@oncare/web-common";
import { InCall } from "../src/screens/InCall";

const api = { get: vi.fn(), post: vi.fn(async (p: string) => p.endsWith("/token") ? { url: "wss://x", token: "tok", room: "v1" } : {}) } as any;

test("requests a token, joins, attaches remote video, reports connected, applies volume, and leaves on End", async () => {
  const onConnected = vi.fn(); const onLost = vi.fn(); const onEnd = vi.fn(); const onLocalState = vi.fn();
  render(<InCall api={api} visitId="v1" callerName="Amy" active={false} onConnected={onConnected} onLost={onLost} onEnd={onEnd} onLocalState={onLocalState} />);
  await waitFor(() => expect(createCall).toHaveBeenCalledWith("wss://x", "tok", expect.anything(), { publish: true }));
  expect(api.post).toHaveBeenCalledWith("/visits/v1/token");
  const video = document.createElement("video");
  capturedCb.onRemoteVideo(video);
  expect(screen.getByTestId("video-stage").contains(video)).toBe(true);
  capturedCb.onRemoteParticipant(true);
  expect(onConnected).toHaveBeenCalledTimes(1);
  capturedCb.onLocalState({ camera: true, mic: true });
  expect(onLocalState).toHaveBeenLastCalledWith({ camera: true, mic: true });
  await userEvent.click(screen.getByRole("button", { name: "Louder" }));
  expect(handle.setVolume).toHaveBeenLastCalledWith(80);
  await userEvent.click(screen.getByRole("button", { name: "End" }));
  await waitFor(() => expect(handle.leave).toHaveBeenCalled());
  expect(onEnd).toHaveBeenCalled();
});

test("a lost connection is reported once", async () => {
  const onLost = vi.fn();
  render(<InCall api={api} visitId="v1" callerName="Amy" active onConnected={() => {}} onLost={onLost} onEnd={() => {}} onLocalState={() => {}} />);
  await waitFor(() => expect(createCall).toHaveBeenCalled());
  capturedCb.onLost();
  expect(onLost).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/resident/test/InCall.test.tsx`
Expected: FAIL — `InCall` does not accept these props / never calls `createCall`.

- [ ] **Step 3: Write the implementation**

```tsx
// apps/resident/src/screens/InCall.tsx
import { useEffect, useRef, useState } from "react";
import { createCall, t, type Api, type CallHandle } from "@oncare/web-common";
import { BigButton } from "../components/BigButton";

export function InCall({ api, visitId, callerName, active, onConnected, onLost, onEnd, onLocalState }: {
  api: Api; visitId: string; callerName: string; active: boolean;
  onConnected: () => void; onLost: () => void; onEnd: () => void; onLocalState: (s: { camera: boolean; mic: boolean }) => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const handleRef = useRef<CallHandle | null>(null);
  const [volume, setVolume] = useState(70);
  const connectedOnce = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { url, token } = await api.post<{ url: string; token: string; room: string }>(`/visits/${visitId}/token`);
        if (cancelled) return;
        const h = await createCall(url, token, {
          onRemoteVideo: (el) => { if (!stage.current) return; stage.current.querySelectorAll("video").forEach((v) => v.remove()); if (el) { el.setAttribute("playsinline", ""); el.autoplay = true; stage.current.appendChild(el); } },
          onRemoteAudio: (el) => { if (el) { el.autoplay = true; el.style.display = "none"; document.body.appendChild(el); } },
          onRemoteParticipant: (present) => { if (present && !connectedOnce.current) { connectedOnce.current = true; onConnected(); } },
          onLocalState,
          onLost,
        }, { publish: true });
        if (cancelled) { await h.leave(); return; }
        handleRef.current = h;
        h.setVolume(volume);
      } catch { /* 409 or network: the next state refresh decides the screen */ }
    })();
    return () => { cancelled = true; void handleRef.current?.leave(); handleRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, visitId]);

  const changeVolume = (delta: number) => setVolume((v) => { const n = Math.min(100, Math.max(0, v + delta)); handleRef.current?.setVolume(n); return n; });
  const end = async () => { await handleRef.current?.leave(); handleRef.current = null; onEnd(); };

  return (
    <section className="screen screen--incall">
      <div ref={stage} className="video-stage" data-testid="video-stage" aria-label={active ? t("resident.incall.connected", { name: callerName }) : t("resident.incall.connecting")}>
        {!active && <p className="video-caption">{t("resident.incall.connecting")}</p>}
      </div>
      <div className="call-controls">
        <button type="button" className="quiet-button" onClick={() => changeVolume(-10)}>{t("resident.incall.quieter")}</button>
        <span className="volume" aria-live="polite">{volume}%</span>
        <button type="button" className="quiet-button" onClick={() => changeVolume(10)}>{t("resident.incall.louder")}</button>
      </div>
      <BigButton tone="danger" onClick={() => void end()}>{t("resident.incall.end")}</BigButton>
    </section>
  );
}
```

`App.tsx`: add `const [local, setLocal] = useState({ camera: false, mic: false });` render `<InCall api={api} visitId={visitId!} callerName=… active=… onConnected={act("connected")} onLost={act("connection_lost")} onEnd={act("end")} onLocalState={setLocal} />` and pass `cameraOn={inCall && local.camera} micOn={inCall && local.mic}` to `StatusBar`. Reset `local` to false/false when leaving `in_call`. Update `apps/resident/test/App.test.tsx` expectations if they referenced the old `InCall` props (the existing tests do not render `in_call`; add nothing).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/resident && npx tsc -b`
Expected: PASS (2 new); earlier resident tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/resident/src/screens/InCall.tsx apps/resident/src/App.tsx apps/resident/test/InCall.test.tsx
git commit -m "feat(resident): real LiveKit call on the in-call screen with volume, status and loss handling" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 4: Family call panel

**Load the `frontend-design` skill first.**

**Files:**
- Create: `apps/family/src/components/CallPanel.tsx`
- Modify: `apps/family/src/pages/Visit.tsx` — render `CallPanel` while state ∈ connecting|active; remove the automatic `connected` post from Plan 3 (the panel reports it from real presence); on `onLost` post `/visits/:id/connection_lost`
- Modify: `apps/family/test/App.test.tsx` — the first test's "auto-connected" expectation changes: mock `createCall` (same pattern as Task 3's test) and drive `onRemoteParticipant(true)` to reach `active`
- Test: `apps/family/test/CallPanel.test.tsx`

**Interfaces:**
- `CallPanel({ api, visitId, onConnected, onLost })`: requests the token, `createCall(..., { publish: true })`, shows remote video large, local preview small (`handle.localVideoElement()` after `onLocalState`), buttons "Mute"/"Unmute" and "Camera off"/"Camera on" (i18n keys `family.call.mute`, `family.call.unmute`, `family.call.camera_off`, `family.call.camera_on` — add to `en.json`), and a status line (`family.call.waiting` = "Waiting for {name} to join…" / `family.call.connected` = "Connected"; add keys). Leaves on unmount.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/family/test/CallPanel.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
const handle = { setVolume: vi.fn(), setMic: vi.fn(async () => {}), setCamera: vi.fn(async () => {}), localVideoElement: () => document.createElement("video"), leave: vi.fn(async () => {}) };
let capturedCb: any;
vi.mock("@oncare/web-common", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@oncare/web-common")>();
  return { ...orig, createCall: vi.fn(async (_u: string, _t: string, cb: any) => { capturedCb = cb; return handle; }) };
});
import { CallPanel } from "../src/components/CallPanel";
const api = { get: vi.fn(), post: vi.fn(async () => ({ url: "wss://x", token: "tok", room: "v1" })) } as any;

test("joins, shows waiting then connected, mutes, and reports loss", async () => {
  const onConnected = vi.fn(); const onLost = vi.fn();
  render(<CallPanel api={api} visitId="v1" residentName="Mom" onConnected={onConnected} onLost={onLost} />);
  expect(await screen.findByText("Waiting for Mom to join…")).toBeInTheDocument();
  capturedCb.onLocalState({ camera: true, mic: true });
  capturedCb.onRemoteParticipant(true);
  expect(onConnected).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("Connected")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Mute" }));
  expect(handle.setMic).toHaveBeenCalledWith(false);
  capturedCb.onLocalState({ camera: true, mic: false });
  expect(await screen.findByRole("button", { name: "Unmute" })).toBeInTheDocument();
  capturedCb.onLost();
  expect(onLost).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/family/test/CallPanel.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation**

```tsx
// apps/family/src/components/CallPanel.tsx
import { useEffect, useRef, useState } from "react";
import { createCall, t, type Api, type CallHandle } from "@oncare/web-common";

export function CallPanel({ api, visitId, residentName, onConnected, onLost }: { api: Api; visitId: string; residentName: string; onConnected: () => void; onLost: () => void }) {
  const remote = useRef<HTMLDivElement>(null); const local = useRef<HTMLDivElement>(null);
  const handleRef = useRef<CallHandle | null>(null);
  const [present, setPresent] = useState(false);
  const [state, setState] = useState({ camera: false, mic: false });
  const connectedOnce = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { url, token } = await api.post<{ url: string; token: string; room: string }>(`/visits/${visitId}/token`);
        if (cancelled) return;
        const h = await createCall(url, token, {
          onRemoteVideo: (el) => { if (!remote.current) return; remote.current.querySelectorAll("video").forEach((v) => v.remove()); if (el) { el.autoplay = true; el.setAttribute("playsinline", ""); remote.current.appendChild(el); } },
          onRemoteAudio: (el) => { if (el) { el.autoplay = true; el.style.display = "none"; document.body.appendChild(el); } },
          onRemoteParticipant: (p) => { setPresent(p); if (p && !connectedOnce.current) { connectedOnce.current = true; onConnected(); } },
          onLocalState: (s) => { setState(s); const el = handleRef.current?.localVideoElement(); if (el && local.current && !local.current.contains(el)) { el.muted = true; el.autoplay = true; el.setAttribute("playsinline", ""); local.current.replaceChildren(el); } },
          onLost,
        }, { publish: true });
        if (cancelled) { await h.leave(); return; }
        handleRef.current = h;
      } catch { /* token refused: page state will change */ }
    })();
    return () => { cancelled = true; void handleRef.current?.leave(); handleRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, visitId]);

  return (
    <section className="call-panel">
      <div ref={remote} className="call-remote" aria-label={present ? t("family.call.connected") : t("family.call.waiting", { name: residentName })} />
      <div ref={local} className="call-local" aria-hidden="true" />
      <p className="call-status" aria-live="polite">{present ? t("family.call.connected") : t("family.call.waiting", { name: residentName })}</p>
      <div className="call-controls">
        <button type="button" onClick={() => void handleRef.current?.setMic(!state.mic)}>{t(state.mic ? "family.call.mute" : "family.call.unmute")}</button>
        <button type="button" onClick={() => void handleRef.current?.setCamera(!state.camera)}>{t(state.camera ? "family.call.camera_off" : "family.call.camera_on")}</button>
      </div>
    </section>
  );
}
```

Add to `en.json`: `"family.call.waiting": "Waiting for {name} to join…"`, `"family.call.connected": "Connected"`, `"family.call.mute": "Mute"`, `"family.call.unmute": "Unmute"`, `"family.call.camera_off": "Camera off"`, `"family.call.camera_on": "Camera on"`.

`Visit.tsx`: delete the `reportedConnected` effect; render `{(visit.state === "connecting" || visit.state === "active") && <CallPanel api={api} visitId={visitId} residentName={residentName} onConnected={() => api.post(`/visits/${visitId}/connected`).then(() => void refresh()).catch(() => {})} onLost={() => api.post(`/visits/${visitId}/connection_lost`).then(() => void refresh()).catch(() => {})} />}` above the stepper. Update `apps/family/test/App.test.tsx` first test: mock `createCall` as in `CallPanel.test.tsx`, and after `state = "connecting"` wait for `createCall` to be called, call `capturedCb.onRemoteParticipant(true)`, then assert the `/visits/v1/connected` POST and "On the call".

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/family packages/web-common && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Real call rehearsal**

With `apps/api/.env` populated: `npm run dev` + the mock gateway. Family app in Chrome on the PC, resident app in Safari on the iPad (or a second Chrome profile). Request a visit, tap Answer on the resident side, confirm two-way video and audio within 5 s, confirm the family stepper shows "On the call" and the resident status bar shows "Camera on". Pull the iPad's Wi-Fi for 20 s: the family page should show "The call could not connect" after LiveKit gives up (about 15 s), and the iPad returns to home on reconnect. Record the observed times in `docs/demo-visit-flow.md`.

- [ ] **Step 6: Commit**

```bash
git add apps/family/src/components/CallPanel.tsx apps/family/src/pages/Visit.tsx apps/family/test packages/web-common/src/i18n/en.json docs/demo-visit-flow.md
git commit -m "feat(family): live call panel with mute and camera controls; visit reaches active from real presence" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

## Plan self-review

**Spec coverage (Plan 4):** §4 Video — LiveKit behind `VideoProvider` with `issueToken`/`closeRoom` (spec's `createRoom` is implicit in LiveKit: rooms are created on first join, so it is omitted rather than stubbed); per-identity grants; room closed at `ending`; reconnection by the SDK and `connection_failed` after it gives up (Task 1 `connection_lost`, Tasks 3–4). §1 rule 1 separation: tokens are issued by a route that knows nothing about the gateway. No recording anywhere.

**Placeholder scan:** none.

**Type consistency:** `VideoGrant`/`grantsFor` (Task 1 ↔ tests); `createCall` signature and `CallCallbacks` (Task 2 ↔ 3 ↔ 4 mocks); `connection_lost` action (Task 1 ↔ Tasks 3–4 posts); `InCall` props (Task 3 ↔ App.tsx); i18n keys added in Task 4 exist before use.
