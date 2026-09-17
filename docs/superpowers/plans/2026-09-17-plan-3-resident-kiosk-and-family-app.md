# Plan 3: Resident iPad Kiosk and Family Web App (visit flow)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Implementers of Tasks 3–5 must load the `frontend-design` skill before writing UI** and follow the spec's UX rules (section 4) — calm, warm, medical-grade; not an admin dashboard.

**Goal:** A daughter logs into the family web app, requests a visit, the resident's iPad shows a large incoming-call screen and speaks a prompt, the resident answers with one tap, both sides see the call screen (video itself arrives in Plan 4), and the family app shows live visit progress.

**Architecture:** Two Vite + React apps plus a small shared package (`packages/web-common`) holding the API client, the `/events` hook, and i18n. The kiosk never infers state: it renders whatever `GET /device/state` and `/events` say. All screen-selection logic is a pure function with unit tests; components are thin.

**Tech Stack:** Vite 6, React 19, TypeScript, vitest + @testing-library/react + jsdom, `@oncare/core` types. No CSS framework; hand-written CSS with design tokens (the frontend-design skill governs the look).

**Spec:** `docs/superpowers/specs/2026-09-17-oncare-platform-design.md` (sections 2 device routes, 4 resident kiosk + family app)

**Depends on:** Plans 1–2 complete.

## Global Constraints

- ESM; TypeScript `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- Tests: `npx vitest run <path>` from the repo root. UI tests run in `jsdom` via a per-app `vitest.config.ts` (`test.environment = "jsdom"`).
- Resident kiosk rules (spec §4): one primary action per screen; minimum font 32 px; primary buttons at least 120 px tall; WCAG AA contrast; no pure-black backgrounds; no gestures, long-press (except the PIN entry: press-and-hold the bottom-left logo for 3 s), or multi-touch; camera/mic status always visible as icon + text; any error or 90 s of inactivity returns to `home`; the client never infers state.
- Family app: no robot control UI of any kind.
- All user-visible strings go through `t("key")` with English in `packages/web-common/src/i18n/en.json`; no hard-coded UI strings in components.
- No secrets in the repo. The iPad's device token is entered once in the PIN-protected settings screen and stored in `localStorage` (wrapped in try/catch).
- Commit after every task with the trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC
  ```
- Do not modify anything under `D:/ontaru/AGI carehouse/on_software_all`.

## File structure produced by this plan

```
apps/api/src/routes/device.ts        GET /device/state, POST /device/call-caregiver, POST /device/unlock
apps/api/test/device.test.ts
packages/web-common/
  package.json, tsconfig.json, vitest.config.ts
  src/api.ts                         createApi(baseUrl, getToken): typed fetch helpers
  src/events.ts                      connectEvents(baseUrl, token, onEvent): WebSocket with reconnect
  src/i18n/en.json, src/i18n/index.ts  t(key, vars), setLocale
  src/index.ts
  test/api.test.ts, test/events.test.ts, test/i18n.test.ts
apps/resident/
  index.html, package.json, tsconfig.json, vite.config.ts, vitest.config.ts
  src/main.tsx, src/App.tsx
  src/screen.ts                      selectScreen(deviceState): Screen  (pure)
  src/idle.ts                        useIdleReturn(ms, onIdle)
  src/speech.ts                      speak(text) wrapper around SpeechSynthesis (no-op if unavailable)
  src/screens/{Home,Incoming,InCall,DeliveryArrived,CaregiverCalled,Settings}.tsx
  src/components/{BigButton,StatusBar,PinPad}.tsx
  src/styles.css
  test/screen.test.ts, test/idle.test.tsx, test/App.test.tsx
apps/family/
  index.html, package.json, tsconfig.json, vite.config.ts, vitest.config.ts
  src/main.tsx, src/App.tsx
  src/progress.ts                    visitSteps(state): { steps, currentIndex, failed?: string } (pure)
  src/pages/{Login,Residents,Visit}.tsx
  src/styles.css
  test/progress.test.ts, test/App.test.tsx
package.json (root)                  scripts: dev (concurrently api + resident + family)
```

---

### Task 1: Device routes — `GET /device/state`, `POST /device/call-caregiver`, `POST /device/unlock`

**Files:**
- Create: `apps/api/src/routes/device.ts`
- Modify: `apps/api/src/app.ts` — register `deviceRoutes`
- Test: `apps/api/test/device.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // GET /device/state  (device)
  // -> 200 { resident: { id, displayName }, screen: "home"|"incoming"|"in_call"|"delivery_arrived", visit: VisitRow|null, task: null, robot: { adapter: "mock"|"navweb"|null, connected: boolean } }
  //   screen is derived from the resident's most recent non-terminal visit:
  //     awaiting_resident_consent -> "incoming"; connecting|active|ending -> "in_call"; otherwise "home"
  //   (delivery_arrived is wired in Plan 5 when tasks exist; until then always null task / never that screen)
  // POST /device/call-caregiver (device) -> 200 { ok: true }; writes audit_event { actorType:"device", entityType:"robot", entityId: device.robotId, fromState:null, toState:null, reason:"call_caregiver", correlationId: device.id }
  // POST /device/unlock (device) body { pin } -> 200 { ok: true } | 401 { error:"invalid_pin" }; verifies against any staff user's pinHash; writes audit_event reason "device_unlock" on success and "device_unlock_failed" on failure
  export type DeviceScreen = "home" | "incoming" | "in_call" | "delivery_arrived";
  export function screenForVisitState(state: string | null): DeviceScreen;   // exported for reuse/tests
  ```
- `GET /device/state` also includes `visit.requesterName` (the family user's `displayName`) so the incoming screen can say who is calling. Add it as a separate field `caller: { displayName } | null`, not by mutating the visit row.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/device.test.ts
import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS, SEED_SECRETS } from "../src/db/seed";
import { screenForVisitState } from "../src/routes/device";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("screenForVisitState", () => {
  test("maps visit states to kiosk screens", () => {
    expect(screenForVisitState(null)).toBe("home");
    expect(screenForVisitState("accepted")).toBe("home");
    expect(screenForVisitState("robot_en_route")).toBe("home");
    expect(screenForVisitState("awaiting_resident_consent")).toBe("incoming");
    for (const s of ["connecting", "active", "ending"]) expect(screenForVisitState(s)).toBe("in_call");
    expect(screenForVisitState("completed")).toBe("home");
  });
});

describe("GET /device/state", () => {
  test("home when there is no visit", async () => {
    const { app, tokens } = await makeTestApp();
    const res = await app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.device) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ resident: { id: SEED_IDS.resident, displayName: "Demo Resident" }, screen: "home", visit: null, caller: null, task: null, robot: { adapter: null, connected: false } });
  });

  test("incoming with caller name when a visit awaits resident consent", async () => {
    const { app, db, tokens } = await makeTestApp();
    const created = await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } });
    const id = created.json().visit.id;
    db.update(t.visitSession).set({ state: "awaiting_resident_consent" }).where(eq(t.visitSession.id, id)).run();
    const res = await app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.device) });
    expect(res.json()).toMatchObject({ screen: "incoming", visit: { id, state: "awaiting_resident_consent" }, caller: { displayName: "Demo Daughter" } });
  });

  test("terminal visits do not affect the screen", async () => {
    const { app, db, tokens } = await makeTestApp();
    const id = (await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } })).json().visit.id;
    db.update(t.visitSession).set({ state: "completed" }).where(eq(t.visitSession.id, id)).run();
    expect((await app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.device) })).json()).toMatchObject({ screen: "home", visit: null });
  });

  test("robot block reflects the hub heartbeat", async () => {
    const { app, tokens } = await makeTestApp();
    app.hub.attach(SEED_IDS.robot, { send() {} });
    app.hub.receive(SEED_IDS.robot, { type: "heartbeat", at: new Date().toISOString(), robotReady: true, adapter: "mock", pose: null, navState: "idle", estop: false, lift: "unknown", battery: "unknown", activeCorrelationId: null, gatewayVersion: "0.0.1" });
    expect((await app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.device) })).json().robot).toEqual({ adapter: "mock", connected: true });
  });

  test("family token is 403", async () => {
    const { app, tokens } = await makeTestApp();
    expect((await app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.family) })).statusCode).toBe(403);
  });
});

describe("POST /device/call-caregiver and /device/unlock", () => {
  test("call-caregiver writes an audit row with reason call_caregiver", async () => {
    const { app, db, tokens } = await makeTestApp();
    expect((await app.inject({ method: "POST", url: "/device/call-caregiver", headers: auth(tokens.device) })).json()).toEqual({ ok: true });
    const row = db.select().from(t.auditEvent).all().at(-1);
    expect(row).toMatchObject({ actorType: "device", actorId: SEED_IDS.device, entityType: "robot", entityId: SEED_IDS.robot, reason: "call_caregiver", correlationId: SEED_IDS.device });
  });

  test("unlock accepts the staff PIN and rejects a wrong one, auditing both", async () => {
    const { app, db, tokens } = await makeTestApp();
    expect((await app.inject({ method: "POST", url: "/device/unlock", headers: auth(tokens.device), payload: { pin: "0000" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/device/unlock", headers: auth(tokens.device), payload: { pin: SEED_SECRETS.staffPin } })).json()).toEqual({ ok: true });
    const reasons = db.select().from(t.auditEvent).all().map((e) => e.reason);
    expect(reasons.slice(-2)).toEqual(["device_unlock_failed", "device_unlock"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/device.test.ts`
Expected: FAIL — cannot import `screenForVisitState`; routes 404.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/routes/device.ts
import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import { z } from "zod";
import { VISIT_TERMINAL_STATES, makeTransitionEvent } from "@oncare/core";
import { requireRole } from "../auth/plugin";
import { verifySecret } from "../auth/password";
import type { Db } from "../db/client";
import * as t from "../db/schema";

export type DeviceScreen = "home" | "incoming" | "in_call" | "delivery_arrived";

export function screenForVisitState(state: string | null): DeviceScreen {
  if (state === "awaiting_resident_consent") return "incoming";
  if (state === "connecting" || state === "active" || state === "ending") return "in_call";
  return "home";
}

export async function deviceRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  function audit(deviceId: string, robotId: string, reason: string) {
    db.insert(t.auditEvent).values(makeTransitionEvent({
      actorType: "device", actorId: deviceId, entityType: "robot", entityId: robotId,
      fromState: null as unknown as string, toState: null as unknown as string, reason, correlationId: deviceId,
    })).run();
  }

  app.get("/device/state", { preHandler: requireRole("device") }, async (req) => {
    const p = req.principal;
    if (p.kind !== "device") return { error: "forbidden" };
    const resident = db.select().from(t.resident).where(eq(t.resident.id, p.residentId)).get()!;
    const visit = db.select().from(t.visitSession)
      .where(and(eq(t.visitSession.residentId, p.residentId), notInArray(t.visitSession.state, [...VISIT_TERMINAL_STATES])))
      .orderBy(desc(t.visitSession.requestedAt)).get() ?? null;
    const caller = visit ? db.select({ displayName: t.user.displayName }).from(t.user).where(eq(t.user.id, visit.requesterId)).get() ?? null : null;
    const status = app.hub.status(p.robotId);
    return {
      resident: { id: resident.id, displayName: resident.displayName },
      screen: screenForVisitState(visit?.state ?? null),
      visit, caller, task: null,
      robot: { adapter: status.lastHeartbeat?.adapter ?? null, connected: status.connected },
    };
  });

  app.post("/device/call-caregiver", { preHandler: requireRole("device") }, async (req) => {
    const p = req.principal;
    if (p.kind !== "device") return { error: "forbidden" };
    audit(p.id, p.robotId, "call_caregiver");
    return { ok: true };
  });

  app.post("/device/unlock", { preHandler: requireRole("device") }, async (req, reply) => {
    const p = req.principal;
    if (p.kind !== "device") return reply.code(403).send({ error: "forbidden" });
    const body = z.object({ pin: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const staff = db.select().from(t.user).where(eq(t.user.role, "staff")).all();
    for (const s of staff) {
      if (s.pinHash && (await verifySecret(body.data.pin, s.pinHash))) { audit(p.id, p.robotId, "device_unlock"); return { ok: true }; }
    }
    audit(p.id, p.robotId, "device_unlock_failed");
    return reply.code(401).send({ error: "invalid_pin" });
  });
}
```

Note on the `null as unknown as string` casts: `makeTransitionEvent` types `fromState`/`toState` as `string` while the schema and table allow `null`. Instead of the cast, **extend `TransitionEventInput` in `packages/core/src/audit.ts` to `fromState: string | null; toState: string | null`** (the `AuditEvent` type already allows null), update the core test if needed, and use plain `null` here. Include that core change in this task's commit.

Register in `app.ts`: `import { deviceRoutes } from "./routes/device";` and `app.register(deviceRoutes, { db: opts.db });`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/api/test/device.test.ts && npx vitest run && npx tsc -b`
Expected: PASS (8 new tests), whole suite green, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/device.ts apps/api/src/app.ts apps/api/test/device.test.ts packages/core/src/audit.ts packages/core/test/audit.test.ts
git commit -m "feat(api): device state, call-caregiver and PIN unlock routes for the resident kiosk" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 2: `packages/web-common` — API client, events hook, i18n

**Files:**
- Create: `packages/web-common/package.json`, `packages/web-common/tsconfig.json`, `packages/web-common/vitest.config.ts`
- Create: `packages/web-common/src/api.ts`, `src/events.ts`, `src/i18n/en.json`, `src/i18n/index.ts`, `src/index.ts`
- Modify: root `package.json` devDependencies — add `"jsdom": "^25.0.0"`, `"@testing-library/react": "^16.0.0"`, `"@testing-library/jest-dom": "^6.5.0"`, `"@testing-library/user-event": "^14.5.0"`; root `tsconfig.json` references — add `packages/web-common`
- Modify: root `vitest.config.ts` — switch to `workspace`-style projects so `packages/web-common`, `apps/resident`, `apps/family` run under jsdom while everything else stays node:
  ```ts
  import { defineConfig } from "vitest/config";
  export default defineConfig({
    test: {
      projects: [
        { test: { name: "node", include: ["packages/core/test/**/*.test.ts", "packages/contracts/test/**/*.test.ts", "apps/api/test/**/*.test.ts"], environment: "node" } },
        { test: { name: "web", include: ["packages/web-common/test/**/*.test.ts", "apps/resident/test/**/*.test.{ts,tsx}", "apps/family/test/**/*.test.{ts,tsx}"], environment: "jsdom", setupFiles: ["./vitest.setup.web.ts"] } },
      ],
    },
  });
  ```
  and create `vitest.setup.web.ts` at the root containing `import "@testing-library/jest-dom/vitest";`.
- Test: `packages/web-common/test/api.test.ts`, `test/events.test.ts`, `test/i18n.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/api.ts
  export class ApiError extends Error { constructor(public status: number, public code: string) }
  export interface Api {
    get<T>(path: string): Promise<T>;
    post<T>(path: string, body?: unknown): Promise<T>;
  }
  export function createApi(baseUrl: string, getToken: () => string | null, fetchImpl?: typeof fetch): Api;
  //   sends Authorization: Bearer <token> when present; non-2xx -> throws ApiError(status, json.error ?? "http_error")
  // src/events.ts
  export interface EventsHandle { close(): void }
  export function connectEvents(baseUrl: string, token: string, onEvent: (ev: AuditEvent) => void, opts?: { WebSocketImpl?: typeof WebSocket; reconnectMs?: number; onStatus?: (s: "open" | "closed") => void }): EventsHandle;
  //   opens `${baseUrl.replace(/^http/, "ws")}/events?token=...`; ignores the {type:"hello"} message; reconnects after reconnectMs (default 2000) until close() is called
  // src/i18n/index.ts
  export type Locale = "en";
  export function t(key: string, vars?: Record<string, string | number>): string;   // "{name}" interpolation; missing key returns the key itself
  export function setLocale(locale: Locale): void;
  ```
- `en.json` keys used by Plans 3–5 (define all now so components never invent strings):
  ```json
  {
    "app.title": "OnCare",
    "resident.home.greeting": "Hello, {name}",
    "resident.home.status.camera_off": "Camera off",
    "resident.home.status.camera_on": "Camera on",
    "resident.home.status.mic_on": "Microphone on",
    "resident.incoming.title": "{name} is calling",
    "resident.incoming.spoken": "{name} is calling",
    "resident.incoming.answer": "Answer",
    "resident.incoming.decline": "Not now",
    "resident.incall.connected": "{name} is on the call",
    "resident.incall.connecting": "Connecting…",
    "resident.incall.end": "End",
    "resident.incall.louder": "Louder",
    "resident.incall.quieter": "Quieter",
    "resident.delivery.title": "Your {item} is here",
    "resident.delivery.received": "I have it",
    "resident.caregiver.title": "A caregiver has been notified",
    "resident.caregiver.button": "Call a caregiver",
    "resident.settings.title": "Staff settings",
    "resident.settings.pin": "Enter staff PIN",
    "resident.settings.device_token": "Device token",
    "resident.settings.save": "Save",
    "resident.settings.back": "Back to resident view",
    "resident.badge.simulated": "SIMULATED ROBOT",
    "resident.error.reconnecting": "Reconnecting…",
    "family.login.title": "Sign in",
    "family.login.username": "Username",
    "family.login.password": "Password",
    "family.login.submit": "Sign in",
    "family.login.failed": "Wrong username or password",
    "family.residents.title": "Your family",
    "family.residents.availability.available": "Available",
    "family.residents.availability.in_activity": "In an activity",
    "family.residents.availability.resting": "Resting",
    "family.residents.availability.not_available": "Not available",
    "family.residents.visit": "Send the robot to visit",
    "family.visit.title": "Visit with {name}",
    "family.visit.step.requested": "Requested",
    "family.visit.step.approval": "Waiting for the care home",
    "family.visit.step.robot": "Robot is on its way",
    "family.visit.step.ringing": "Ringing on the iPad",
    "family.visit.step.connecting": "Connecting",
    "family.visit.step.active": "On the call",
    "family.visit.step.completed": "Finished",
    "family.visit.failed.denied": "The care home declined this visit",
    "family.visit.failed.resident_unavailable": "{name} is not available right now",
    "family.visit.failed.robot_unavailable": "The robot is not available",
    "family.visit.failed.navigation_failed": "The robot could not reach the room",
    "family.visit.failed.connection_failed": "The call could not connect",
    "family.visit.failed.cancelled": "Cancelled",
    "family.visit.failed.safety_stopped": "The robot was stopped for safety",
    "family.visit.cancel": "Cancel visit",
    "family.visit.end": "End call",
    "family.visit.ask_robot": "Ask the robot for help",
    "family.badge.simulated": "SIMULATED ROBOT"
  }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/web-common/test/api.test.ts
import { describe, expect, test, vi } from "vitest";
import { ApiError, createApi } from "../src/api";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

describe("createApi", () => {
  test("adds the bearer token and parses JSON", async () => {
    const f = fakeFetch(200, { visit: { id: "v1" } });
    const api = createApi("http://api", () => "tok", f);
    await expect(api.get<{ visit: { id: string } }>("/visits/v1")).resolves.toEqual({ visit: { id: "v1" } });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("http://api/visits/v1");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  test("omits the header without a token and posts JSON bodies", async () => {
    const f = fakeFetch(201, { ok: true });
    const api = createApi("http://api", () => null, f);
    await api.post("/auth/login", { username: "a", password: "b" });
    const [, init] = (f as any).mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ username: "a", password: "b" }));
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  test("throws ApiError with the server's error code on non-2xx", async () => {
    const api = createApi("http://api", () => null, fakeFetch(409, { error: "resident_unavailable" }));
    await expect(api.post("/visits", {})).rejects.toMatchObject({ status: 409, code: "resident_unavailable" });
    await expect(api.post("/visits", {})).rejects.toBeInstanceOf(ApiError);
  });
});
```

```ts
// packages/web-common/test/events.test.ts
import { describe, expect, test, vi } from "vitest";
import { connectEvents } from "../src/events";

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  close() { this.closed = true; this.onclose?.(); }
  emit(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

describe("connectEvents", () => {
  test("connects to /events with the token, skips hello, forwards audit events", () => {
    FakeSocket.instances = [];
    const seen: unknown[] = [];
    const h = connectEvents("http://api", "tok", (e) => seen.push(e), { WebSocketImpl: FakeSocket as unknown as typeof WebSocket });
    const s = FakeSocket.instances[0]!;
    expect(s.url).toBe("ws://api/events?token=tok");
    s.onopen?.();
    s.emit({ type: "hello", principal: {} });
    s.emit({ id: "e1", toState: "accepted" });
    expect(seen).toEqual([{ id: "e1", toState: "accepted" }]);
    h.close();
    expect(s.closed).toBe(true);
  });

  test("reconnects after an unexpected close until close() is called", () => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    const statuses: string[] = [];
    const h = connectEvents("http://api", "tok", () => {}, { WebSocketImpl: FakeSocket as unknown as typeof WebSocket, reconnectMs: 500, onStatus: (s) => statuses.push(s) });
    FakeSocket.instances[0]!.onopen?.();
    FakeSocket.instances[0]!.onclose?.();
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(FakeSocket.instances).toHaveLength(2);
    h.close();
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(statuses).toEqual(["open", "closed"]);
    vi.useRealTimers();
  });
});
```

```ts
// packages/web-common/test/i18n.test.ts
import { expect, test } from "vitest";
import { t } from "../src/i18n";

test("interpolates variables", () => {
  expect(t("resident.incoming.title", { name: "Amy" })).toBe("Amy is calling");
});
test("returns the key when missing so a gap is visible, not blank", () => {
  expect(t("nope.key")).toBe("nope.key");
});
test("every value in en.json is a non-empty string", async () => {
  const en = (await import("../src/i18n/en.json")).default as Record<string, string>;
  for (const [k, v] of Object.entries(en)) expect(typeof v === "string" && v.length > 0, k).toBe(true);
});
```

- [ ] **Step 2: Scaffold and run to verify failure**

```json
// packages/web-common/package.json
{ "name": "@oncare/web-common", "version": "0.0.1", "private": true, "type": "module",
  "main": "./src/index.ts", "types": "./src/index.ts", "exports": { ".": "./src/index.ts" },
  "dependencies": { "@oncare/core": "*" } }
```
```json
// packages/web-common/tsconfig.json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "rootDir": ".", "outDir": "dist", "lib": ["ES2022", "DOM"], "resolveJsonModule": true, "types": ["vitest/globals"] }, "include": ["src", "test"], "references": [{ "path": "../core" }] }
```
Run `npm install --no-audit --no-fund` after editing the root `package.json`, then `npx vitest run packages/web-common`.
Expected: FAIL — modules missing.

- [ ] **Step 3: Write the implementation**

```ts
// packages/web-common/src/api.ts
export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(`${status} ${code}`); }
}
export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}
export function createApi(baseUrl: string, getToken: () => string | null, fetchImpl: typeof fetch = fetch): Api {
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    const token = getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetchImpl(`${baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, (json && typeof json.error === "string") ? json.error : "http_error");
    return json as T;
  }
  return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b) };
}
```

```ts
// packages/web-common/src/events.ts
import type { AuditEvent } from "@oncare/core";
export interface EventsHandle { close(): void }
export function connectEvents(baseUrl: string, token: string, onEvent: (ev: AuditEvent) => void,
  opts: { WebSocketImpl?: typeof WebSocket; reconnectMs?: number; onStatus?: (s: "open" | "closed") => void } = {}): EventsHandle {
  const Impl = opts.WebSocketImpl ?? WebSocket;
  const url = `${baseUrl.replace(/^http/, "ws")}/events?token=${encodeURIComponent(token)}`;
  let socket: WebSocket | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  function open() {
    socket = new Impl(url);
    socket.onopen = () => opts.onStatus?.("open");
    socket.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg && msg.type === "hello") return;
      onEvent(msg as AuditEvent);
    };
    socket.onclose = () => {
      opts.onStatus?.("closed");
      if (!stopped) timer = setTimeout(open, opts.reconnectMs ?? 2000);
    };
  }
  open();
  return { close() { stopped = true; if (timer) clearTimeout(timer); socket?.close(); } };
}
```

```ts
// packages/web-common/src/i18n/index.ts
import en from "./en.json";
export type Locale = "en";
const tables: Record<Locale, Record<string, string>> = { en };
let current: Locale = "en";
export function setLocale(locale: Locale): void { current = locale; }
export function t(key: string, vars: Record<string, string | number> = {}): string {
  const raw = tables[current][key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));
}
```

```ts
// packages/web-common/src/index.ts
export * from "./api";
export * from "./events";
export * from "./i18n";
```

`en.json` is the table shown in the Interfaces block, verbatim.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/web-common && npx vitest run && npx tsc -b`
Expected: PASS (8 new tests); every earlier project still green under the new `projects` config; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/web-common package.json package-lock.json tsconfig.json vitest.config.ts vitest.setup.web.ts
git commit -m "feat(web-common): api client, events socket with reconnect, i18n table" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 3: Resident kiosk app (`apps/resident`)

**Load the `frontend-design` skill before writing any JSX or CSS.** The logic below is fixed; the visual craft (type scale, warmth, spacing, motion) is yours within the spec's rules.

**Files:**
- Create: `apps/resident/index.html`, `package.json`, `tsconfig.json`, `vite.config.ts`
- Create: `apps/resident/src/main.tsx`, `src/App.tsx`, `src/screen.ts`, `src/idle.ts`, `src/speech.ts`, `src/storage.ts`
- Create: `apps/resident/src/screens/Home.tsx`, `Incoming.tsx`, `InCall.tsx`, `DeliveryArrived.tsx`, `CaregiverCalled.tsx`, `Settings.tsx`
- Create: `apps/resident/src/components/BigButton.tsx`, `StatusBar.tsx`, `PinPad.tsx`, `HoldToUnlock.tsx`
- Create: `apps/resident/src/styles.css`
- Modify: root `package.json` — add `"react": "^19.0.0"`, `"react-dom": "^19.0.0"` to dependencies of `apps/resident/package.json`; root devDependencies add `"vite": "^6.0.0"`, `"@vitejs/plugin-react": "^4.3.0"`, `"@types/react": "^19.0.0"`, `"@types/react-dom": "^19.0.0"`, `"concurrently": "^9.0.0"`; root scripts add `"dev": "concurrently -n api,resident,family \"npm run dev -w @oncare/api\" \"npm run dev -w @oncare/resident\" \"npm run dev -w @oncare/family\""`
- Test: `apps/resident/test/screen.test.ts`, `test/idle.test.tsx`, `test/App.test.tsx`

**Interfaces:**
- Consumes: `createApi`, `connectEvents`, `t` from `@oncare/web-common`; `GET /device/state` shape from Task 1; visit actions from Plan 2.
- Produces:
  ```ts
  // src/screen.ts
  export type Screen = "home" | "incoming" | "in_call" | "delivery_arrived" | "caregiver_called" | "settings" | "disconnected";
  export interface DeviceState { resident: { id: string; displayName: string }; screen: "home"|"incoming"|"in_call"|"delivery_arrived"; visit: { id: string; state: string } | null; caller: { displayName: string } | null; task: unknown; robot: { adapter: "mock"|"navweb"|null; connected: boolean } }
  export interface UiOverrides { caregiverCalledUntil: number | null; settingsOpen: boolean; apiReachable: boolean }
  export function selectScreen(server: DeviceState | null, ui: UiOverrides, now: number): Screen;
  //   precedence: settingsOpen -> "settings"; !apiReachable || server===null -> "disconnected";
  //   caregiverCalledUntil > now -> "caregiver_called"; else server.screen
  // src/idle.ts
  export function useIdleReturn(ms: number, onIdle: () => void, enabled: boolean): void;   // resets on pointerdown/keydown; fires once per idle period
  // src/speech.ts
  export function speak(text: string, lang?: string): void;   // uses window.speechSynthesis if present; cancels any queued utterance first; no-op otherwise
  // src/storage.ts
  export function readDeviceToken(): string | null; export function writeDeviceToken(token: string): void;   // localStorage "oncare.deviceToken", try/catch both
  ```
- App behaviour:
  - Boot: read device token; if none → `settings` (PIN not required on first setup because nothing is configured yet; PIN is required afterwards). Exchange the device token for a JWT with `POST /auth/device`; store the JWT in memory only.
  - Poll `GET /device/state` every 5 s AND refetch immediately on every `/events` message; `apiReachable=false` after a failed fetch, back to true on success.
  - `incoming`: on entering the screen call `speak(t("resident.incoming.spoken", { name }))` once per visit id. Answer → `POST /visits/:id/answer`; Not now → `/decline`.
  - `in_call`: shows caller name via `t("resident.incall.connected")` when `visit.state === "active"`, `t("resident.incall.connecting")` otherwise; a large video placeholder region with `data-testid="video-stage"` (LiveKit fills it in Plan 4); End → `POST /visits/:id/end`. Louder/Quieter adjust a `volume` state 0–100 in steps of 10 and render it as text (`aria-live="polite"`).
  - `home`: greeting, big clock, family photo wall (use three neutral placeholder SVG portraits generated inline; no real photos), one secondary button "Call a caregiver" → `POST /device/call-caregiver` then `caregiverCalledUntil = now + 8000`.
  - `settings`: PIN pad → `POST /device/unlock`; on success show the device-token field with Save (writes storage, re-boots auth) and "Back to resident view". A wrong PIN shows nothing except a gentle shake; after 3 wrong attempts the pad locks for 30 s.
  - `HoldToUnlock`: bottom-left 64×64 logo; `pointerdown` starts a 3000 ms timer, `pointerup`/`pointerleave` clears it; on fire → `settingsOpen = true`.
  - `StatusBar` (always visible, top): camera and mic status as icon + text: "Camera on"/"Microphone on" during `in_call`, "Camera off" otherwise; when `robot.adapter === "mock"` show the `resident.badge.simulated` badge.
  - `useIdleReturn(90_000, ...)` enabled on `caregiver_called`, `settings` (returns to server screen by clearing overrides), and `in_call` is NOT idle-returned (a call is an activity).
  - Any thrown error inside a screen is caught by an error boundary that resets overrides and renders `home` content.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/resident/test/screen.test.ts
import { describe, expect, test } from "vitest";
import { selectScreen, type DeviceState, type UiOverrides } from "../src/screen";

const server = (screen: DeviceState["screen"]): DeviceState => ({ resident: { id: "r", displayName: "R" }, screen, visit: null, caller: null, task: null, robot: { adapter: "mock", connected: true } });
const ui = (o: Partial<UiOverrides> = {}): UiOverrides => ({ caregiverCalledUntil: null, settingsOpen: false, apiReachable: true, ...o });

describe("selectScreen precedence", () => {
  test("server screen when nothing overrides", () => {
    expect(selectScreen(server("incoming"), ui(), 1000)).toBe("incoming");
    expect(selectScreen(server("in_call"), ui(), 1000)).toBe("in_call");
  });
  test("settings beats everything", () => {
    expect(selectScreen(server("incoming"), ui({ settingsOpen: true, apiReachable: false }), 1000)).toBe("settings");
  });
  test("disconnected when the API is unreachable or state is missing", () => {
    expect(selectScreen(server("home"), ui({ apiReachable: false }), 1000)).toBe("disconnected");
    expect(selectScreen(null, ui(), 1000)).toBe("disconnected");
  });
  test("caregiver_called only while its timer is in the future", () => {
    expect(selectScreen(server("home"), ui({ caregiverCalledUntil: 2000 }), 1000)).toBe("caregiver_called");
    expect(selectScreen(server("home"), ui({ caregiverCalledUntil: 2000 }), 2000)).toBe("home");
  });
  test("an incoming call is never hidden by the caregiver banner", () => {
    expect(selectScreen(server("incoming"), ui({ caregiverCalledUntil: 5000 }), 1000)).toBe("incoming");
  });
});
```

```tsx
// apps/resident/test/idle.test.tsx
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useIdleReturn } from "../src/idle";

function Probe({ onIdle, enabled }: { onIdle: () => void; enabled: boolean }) { useIdleReturn(1000, onIdle, enabled); return null; }

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("fires after the idle period and resets on interaction", () => {
  const onIdle = vi.fn();
  render(<Probe onIdle={onIdle} enabled />);
  act(() => { vi.advanceTimersByTime(900); });
  act(() => { window.dispatchEvent(new Event("pointerdown")); });
  act(() => { vi.advanceTimersByTime(900); });
  expect(onIdle).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(100); });
  expect(onIdle).toHaveBeenCalledTimes(1);
});

test("does nothing when disabled", () => {
  const onIdle = vi.fn();
  render(<Probe onIdle={onIdle} enabled={false} />);
  act(() => { vi.advanceTimersByTime(5000); });
  expect(onIdle).not.toHaveBeenCalled();
});
```

```tsx
// apps/resident/test/App.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { App } from "../src/App";

type Handler = (path: string, init?: RequestInit) => { status: number; body: unknown };
function installFetch(handler: Handler) {
  const calls: Array<{ path: string; method: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace("http://api", "");
    calls.push({ path, method: init?.method ?? "GET" });
    const r = handler(path, init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }));
  return calls;
}
class NoopSocket { onopen: any; onmessage: any; onclose: any; constructor(_u: string) {} close() {} }

beforeEach(() => {
  try { localStorage.setItem("oncare.deviceToken", "device-demo-token"); } catch {}
  vi.stubGlobal("WebSocket", NoopSocket);
  vi.stubGlobal("speechSynthesis", { cancel: vi.fn(), speak: vi.fn() });
  vi.stubGlobal("SpeechSynthesisUtterance", class { constructor(public text: string) {} lang = ""; });
});

const base = { resident: { id: "resident_demo_01", displayName: "Demo Resident" }, task: null, robot: { adapter: "mock", connected: true } };

test("shows the incoming screen with the caller's name, speaks it, and answers with one tap", async () => {
  const calls = installFetch((path, init) => {
    if (path === "/auth/device") return { status: 200, body: { token: "jwt", principal: {} } };
    if (path === "/device/state") return { status: 200, body: { ...base, screen: "incoming", visit: { id: "v1", state: "awaiting_resident_consent" }, caller: { displayName: "Amy" } } };
    if (path === "/visits/v1/answer") return { status: 200, body: { visit: { id: "v1", state: "connecting" } } };
    return { status: 404, body: { error: "not_found" } };
  });
  render(<App apiBase="http://api" />);
  const answer = await screen.findByRole("button", { name: "Answer" });
  expect(screen.getByText("Amy is calling")).toBeInTheDocument();
  expect((globalThis as any).speechSynthesis.speak).toHaveBeenCalledTimes(1);
  expect(screen.getByText("SIMULATED ROBOT")).toBeInTheDocument();
  await userEvent.click(answer);
  await waitFor(() => expect(calls.some((c) => c.path === "/visits/v1/answer" && c.method === "POST")).toBe(true));
});

test("home shows the greeting and a caregiver button that posts and shows confirmation", async () => {
  const calls = installFetch((path) => {
    if (path === "/auth/device") return { status: 200, body: { token: "jwt", principal: {} } };
    if (path === "/device/state") return { status: 200, body: { ...base, screen: "home", visit: null, caller: null } };
    if (path === "/device/call-caregiver") return { status: 200, body: { ok: true } };
    return { status: 404, body: { error: "not_found" } };
  });
  render(<App apiBase="http://api" />);
  expect(await screen.findByText("Hello, Demo Resident")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Call a caregiver" }));
  expect(await screen.findByText("A caregiver has been notified")).toBeInTheDocument();
  expect(calls.some((c) => c.path === "/device/call-caregiver")).toBe(true);
});

test("without a device token the settings screen is shown first", async () => {
  try { localStorage.removeItem("oncare.deviceToken"); } catch {}
  installFetch(() => ({ status: 404, body: { error: "not_found" } }));
  render(<App apiBase="http://api" />);
  expect(await screen.findByText("Staff settings")).toBeInTheDocument();
  expect(screen.getByLabelText("Device token")).toBeInTheDocument();
});

test("API unreachable shows the reconnecting screen, never a stale call screen", async () => {
  installFetch((path) => {
    if (path === "/auth/device") return { status: 200, body: { token: "jwt", principal: {} } };
    return { status: 500, body: { error: "boom" } };
  });
  render(<App apiBase="http://api" />);
  expect(await screen.findByText("Reconnecting…")).toBeInTheDocument();
});
```

- [ ] **Step 2: Scaffold and run to verify failure**

```json
// apps/resident/package.json
{ "name": "@oncare/resident", "version": "0.0.1", "private": true, "type": "module",
  "scripts": { "dev": "vite --host --port 5173", "build": "vite build", "preview": "vite preview" },
  "dependencies": { "@oncare/core": "*", "@oncare/web-common": "*", "react": "^19.0.0", "react-dom": "^19.0.0" } }
```
```json
// apps/resident/tsconfig.json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "rootDir": ".", "outDir": "dist", "jsx": "react-jsx", "lib": ["ES2022", "DOM", "DOM.Iterable"], "resolveJsonModule": true, "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"] }, "include": ["src", "test"], "references": [{ "path": "../../packages/core" }, { "path": "../../packages/web-common" }] }
```
```ts
// apps/resident/vite.config.ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({ plugins: [react()], server: { proxy: { "/api": { target: "http://127.0.0.1:3000", rewrite: (p) => p.replace(/^\/api/, ""), ws: true } } } });
```
```html
<!-- apps/resident/index.html -->
<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"/><meta name="apple-mobile-web-app-capable" content="yes"/><title>OnCare</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
```
Add `apps/resident` to root `tsconfig.json` references. Run `npm install --no-audit --no-fund`, then `npx vitest run apps/resident`.
Expected: FAIL — modules missing.

- [ ] **Step 3: Write the implementation**

```ts
// apps/resident/src/screen.ts
export type Screen = "home" | "incoming" | "in_call" | "delivery_arrived" | "caregiver_called" | "settings" | "disconnected";
export interface DeviceState {
  resident: { id: string; displayName: string };
  screen: "home" | "incoming" | "in_call" | "delivery_arrived";
  visit: { id: string; state: string } | null;
  caller: { displayName: string } | null;
  task: unknown;
  robot: { adapter: "mock" | "navweb" | null; connected: boolean };
}
export interface UiOverrides { caregiverCalledUntil: number | null; settingsOpen: boolean; apiReachable: boolean }
export function selectScreen(server: DeviceState | null, ui: UiOverrides, now: number): Screen {
  if (ui.settingsOpen) return "settings";
  if (!ui.apiReachable || server === null) return "disconnected";
  if (server.screen === "incoming" || server.screen === "in_call" || server.screen === "delivery_arrived") return server.screen;
  if (ui.caregiverCalledUntil !== null && ui.caregiverCalledUntil > now) return "caregiver_called";
  return server.screen;
}
```

```ts
// apps/resident/src/idle.ts
import { useEffect } from "react";
export function useIdleReturn(ms: number, onIdle: () => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let timer = setTimeout(onIdle, ms);
    const reset = () => { clearTimeout(timer); timer = setTimeout(onIdle, ms); };
    window.addEventListener("pointerdown", reset);
    window.addEventListener("keydown", reset);
    return () => { clearTimeout(timer); window.removeEventListener("pointerdown", reset); window.removeEventListener("keydown", reset); };
  }, [ms, onIdle, enabled]);
}
```

```ts
// apps/resident/src/speech.ts
export function speak(text: string, lang = "en-US"): void {
  const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  const Utt = (globalThis as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance }).SpeechSynthesisUtterance;
  if (!synth || !Utt) return;
  try { synth.cancel(); const u = new Utt(text); u.lang = lang; synth.speak(u); } catch { /* speech is best-effort */ }
}
```

```ts
// apps/resident/src/storage.ts
const KEY = "oncare.deviceToken";
export function readDeviceToken(): string | null { try { return localStorage.getItem(KEY); } catch { return null; } }
export function writeDeviceToken(token: string): void { try { localStorage.setItem(KEY, token); } catch { /* private mode */ } }
```

```tsx
// apps/resident/src/App.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectEvents, createApi, t } from "@oncare/web-common";
import { selectScreen, type DeviceState, type UiOverrides } from "./screen";
import { useIdleReturn } from "./idle";
import { speak } from "./speech";
import { readDeviceToken, writeDeviceToken } from "./storage";
import { StatusBar } from "./components/StatusBar";
import { HoldToUnlock } from "./components/HoldToUnlock";
import { Home } from "./screens/Home";
import { Incoming } from "./screens/Incoming";
import { InCall } from "./screens/InCall";
import { DeliveryArrived } from "./screens/DeliveryArrived";
import { CaregiverCalled } from "./screens/CaregiverCalled";
import { Settings } from "./screens/Settings";

const POLL_MS = 5000;
const IDLE_MS = 90_000;

export function App({ apiBase }: { apiBase: string }) {
  const [deviceToken, setDeviceToken] = useState<string | null>(() => readDeviceToken());
  const [jwt, setJwt] = useState<string | null>(null);
  const [server, setServer] = useState<DeviceState | null>(null);
  const [ui, setUi] = useState<UiOverrides>({ caregiverCalledUntil: null, settingsOpen: deviceToken === null, apiReachable: true });
  const [now, setNow] = useState(() => Date.now());
  const api = useMemo(() => createApi(apiBase, () => jwt), [apiBase, jwt]);
  const spokenFor = useRef<string | null>(null);

  // 1 Hz clock for the caregiver banner and the home-screen clock
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, []);

  // device token -> jwt
  useEffect(() => {
    if (!deviceToken) return;
    let cancelled = false;
    createApi(apiBase, () => null).post<{ token: string }>("/auth/device", { deviceToken })
      .then((r) => { if (!cancelled) setJwt(r.token); })
      .catch(() => { if (!cancelled) setUi((u) => ({ ...u, apiReachable: false })); });
    return () => { cancelled = true; };
  }, [apiBase, deviceToken]);

  const refresh = useCallback(async () => {
    if (!jwt) return;
    try {
      const s = await api.get<DeviceState>("/device/state");
      setServer(s);
      setUi((u) => (u.apiReachable ? u : { ...u, apiReachable: true }));
    } catch {
      setUi((u) => ({ ...u, apiReachable: false }));
    }
  }, [api, jwt]);

  // poll + events
  useEffect(() => {
    if (!jwt) return;
    void refresh();
    const i = setInterval(() => void refresh(), POLL_MS);
    const h = connectEvents(apiBase, jwt, () => void refresh());
    return () => { clearInterval(i); h.close(); };
  }, [apiBase, jwt, refresh]);

  const screen = selectScreen(server, ui, now);

  // speak the incoming prompt once per visit
  useEffect(() => {
    if (screen === "incoming" && server?.visit && spokenFor.current !== server.visit.id) {
      spokenFor.current = server.visit.id;
      speak(t("resident.incoming.spoken", { name: server.caller?.displayName ?? "" }));
    }
  }, [screen, server]);

  const backToServer = useCallback(() => setUi((u) => ({ ...u, caregiverCalledUntil: null, settingsOpen: false })), []);
  useIdleReturn(IDLE_MS, backToServer, screen === "caregiver_called" || screen === "settings");

  const visitId = server?.visit?.id ?? null;
  const act = (action: string) => async () => { if (visitId) { try { await api.post(`/visits/${visitId}/${action}`); } catch { /* server state wins on next refresh */ } void refresh(); } };
  const callCaregiver = async () => { try { await api.post("/device/call-caregiver"); } catch { /* shown as disconnected on next refresh */ } setUi((u) => ({ ...u, caregiverCalledUntil: Date.now() + 8000 })); };

  const inCall = screen === "in_call";
  return (
    <div className="kiosk" data-screen={screen}>
      <StatusBar cameraOn={inCall} micOn={inCall} simulated={server?.robot.adapter === "mock"} callerName={inCall && server?.visit?.state === "active" ? server?.caller?.displayName ?? null : null} />
      <main className="stage">
        {screen === "home" && <Home name={server?.resident.displayName ?? ""} now={now} onCallCaregiver={callCaregiver} />}
        {screen === "incoming" && <Incoming callerName={server?.caller?.displayName ?? ""} onAnswer={act("answer")} onDecline={act("decline")} />}
        {screen === "in_call" && <InCall callerName={server?.caller?.displayName ?? ""} active={server?.visit?.state === "active"} onEnd={act("end")} />}
        {screen === "delivery_arrived" && <DeliveryArrived itemLabel="" onReceived={() => void refresh()} />}
        {screen === "caregiver_called" && <CaregiverCalled />}
        {screen === "disconnected" && <div className="disconnected"><p>{t("resident.error.reconnecting")}</p></div>}
        {screen === "settings" && (
          <Settings api={api} requirePin={deviceToken !== null} currentToken={deviceToken}
            onSaveToken={(tok) => { writeDeviceToken(tok); setDeviceToken(tok); setJwt(null); }}
            onBack={backToServer} />
        )}
      </main>
      <HoldToUnlock onUnlock={() => setUi((u) => ({ ...u, settingsOpen: true }))} />
    </div>
  );
}
```

```tsx
// apps/resident/src/main.tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
const apiBase = import.meta.env.VITE_API_BASE ?? "/api";
createRoot(document.getElementById("root")!).render(<React.StrictMode><App apiBase={apiBase} /></React.StrictMode>);
```

Screens and components (logic fixed; markup/CSS is yours under the frontend-design skill):

```tsx
// apps/resident/src/components/BigButton.tsx
export function BigButton({ children, onClick, tone = "primary", ...rest }: { children: React.ReactNode; onClick: () => void; tone?: "primary" | "secondary" | "danger" } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`big-button big-button--${tone}`} onClick={onClick} {...rest}>{children}</button>;
}
```
```tsx
// apps/resident/src/components/StatusBar.tsx
import { t } from "@oncare/web-common";
export function StatusBar({ cameraOn, micOn, simulated, callerName }: { cameraOn: boolean; micOn: boolean; simulated: boolean; callerName: string | null }) {
  return (
    <header className="status-bar" aria-live="polite">
      <span className={`status ${cameraOn ? "status--on" : ""}`}><span aria-hidden="true">●</span> {t(cameraOn ? "resident.home.status.camera_on" : "resident.home.status.camera_off")}</span>
      {micOn && <span className="status status--on"><span aria-hidden="true">●</span> {t("resident.home.status.mic_on")}</span>}
      {callerName && <span className="status status--caller">{t("resident.incall.connected", { name: callerName })}</span>}
      {simulated && <span className="badge-sim">{t("resident.badge.simulated")}</span>}
    </header>
  );
}
```
```tsx
// apps/resident/src/components/HoldToUnlock.tsx
import { useRef } from "react";
export function HoldToUnlock({ onUnlock, holdMs = 3000 }: { onUnlock: () => void; holdMs?: number }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = () => { timer.current = setTimeout(onUnlock, holdMs); };
  const stop = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  return <div className="hold-logo" role="presentation" aria-hidden="true" onPointerDown={start} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}>OnCare</div>;
}
```
```tsx
// apps/resident/src/components/PinPad.tsx
import { useState } from "react";
export function PinPad({ onSubmit, disabled }: { onSubmit: (pin: string) => void; disabled: boolean }) {
  const [pin, setPin] = useState("");
  const press = (d: string) => { if (disabled) return; const next = (pin + d).slice(0, 6); setPin(next); if (next.length === 4) { onSubmit(next); setPin(""); } };
  return (
    <div className="pin-pad" role="group" aria-label="PIN">
      <div className="pin-dots" aria-live="polite">{"●".repeat(pin.length)}</div>
      {["1","2","3","4","5","6","7","8","9","","0","⌫"].map((k, i) => k === "" ? <span key={i} /> :
        <button key={i} type="button" className="pin-key" disabled={disabled} onClick={() => k === "⌫" ? setPin(pin.slice(0, -1)) : press(k)}>{k}</button>)}
    </div>
  );
}
```
```tsx
// apps/resident/src/screens/Home.tsx
import { t } from "@oncare/web-common";
import { BigButton } from "../components/BigButton";
const PORTRAITS = ["#c9a87c", "#8fb3a3", "#b39bc8"];
export function Home({ name, now, onCallCaregiver }: { name: string; now: number; onCallCaregiver: () => void }) {
  const time = new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <section className="screen screen--home">
      <h1>{t("resident.home.greeting", { name })}</h1>
      <p className="clock">{time}</p>
      <div className="photo-wall" aria-hidden="true">{PORTRAITS.map((c) => <svg key={c} viewBox="0 0 100 100" className="portrait"><circle cx="50" cy="38" r="22" fill={c} /><ellipse cx="50" cy="90" rx="34" ry="24" fill={c} /></svg>)}</div>
      <BigButton tone="secondary" onClick={onCallCaregiver}>{t("resident.caregiver.button")}</BigButton>
    </section>
  );
}
```
```tsx
// apps/resident/src/screens/Incoming.tsx
import { t } from "@oncare/web-common";
import { BigButton } from "../components/BigButton";
export function Incoming({ callerName, onAnswer, onDecline }: { callerName: string; onAnswer: () => void; onDecline: () => void }) {
  return (
    <section className="screen screen--incoming">
      <svg viewBox="0 0 100 100" className="portrait portrait--xl" aria-hidden="true"><circle cx="50" cy="38" r="22" fill="#c9a87c" /><ellipse cx="50" cy="90" rx="34" ry="24" fill="#c9a87c" /></svg>
      <h1>{t("resident.incoming.title", { name: callerName })}</h1>
      <BigButton tone="primary" onClick={onAnswer}>{t("resident.incoming.answer")}</BigButton>
      <button type="button" className="quiet-button" onClick={onDecline}>{t("resident.incoming.decline")}</button>
    </section>
  );
}
```
```tsx
// apps/resident/src/screens/InCall.tsx
import { useState } from "react";
import { t } from "@oncare/web-common";
import { BigButton } from "../components/BigButton";
export function InCall({ callerName, active, onEnd }: { callerName: string; active: boolean; onEnd: () => void }) {
  const [volume, setVolume] = useState(70);
  return (
    <section className="screen screen--incall">
      <div className="video-stage" data-testid="video-stage" aria-label={active ? t("resident.incall.connected", { name: callerName }) : t("resident.incall.connecting")}>
        <p className="video-caption">{active ? t("resident.incall.connected", { name: callerName }) : t("resident.incall.connecting")}</p>
      </div>
      <div className="call-controls">
        <button type="button" className="quiet-button" onClick={() => setVolume((v) => Math.max(0, v - 10))}>{t("resident.incall.quieter")}</button>
        <span className="volume" aria-live="polite">{volume}%</span>
        <button type="button" className="quiet-button" onClick={() => setVolume((v) => Math.min(100, v + 10))}>{t("resident.incall.louder")}</button>
      </div>
      <BigButton tone="danger" onClick={onEnd}>{t("resident.incall.end")}</BigButton>
    </section>
  );
}
```
```tsx
// apps/resident/src/screens/DeliveryArrived.tsx
import { t } from "@oncare/web-common";
import { BigButton } from "../components/BigButton";
export function DeliveryArrived({ itemLabel, onReceived }: { itemLabel: string; onReceived: () => void }) {
  return <section className="screen screen--delivery"><h1>{t("resident.delivery.title", { item: itemLabel })}</h1><BigButton onClick={onReceived}>{t("resident.delivery.received")}</BigButton></section>;
}
```
```tsx
// apps/resident/src/screens/CaregiverCalled.tsx
import { t } from "@oncare/web-common";
export function CaregiverCalled() { return <section className="screen screen--caregiver"><h1>{t("resident.caregiver.title")}</h1></section>; }
```
```tsx
// apps/resident/src/screens/Settings.tsx
import { useState } from "react";
import { t, type Api } from "@oncare/web-common";
import { PinPad } from "../components/PinPad";
export function Settings({ api, requirePin, currentToken, onSaveToken, onBack }: { api: Api; requirePin: boolean; currentToken: string | null; onSaveToken: (t: string) => void; onBack: () => void }) {
  const [unlocked, setUnlocked] = useState(!requirePin);
  const [failures, setFailures] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [shake, setShake] = useState(false);
  const [token, setToken] = useState(currentToken ?? "");
  const submitPin = async (pin: string) => {
    if (Date.now() < lockedUntil) return;
    try { await api.post("/device/unlock", { pin }); setUnlocked(true); setFailures(0); }
    catch { setShake(true); setTimeout(() => setShake(false), 400); const f = failures + 1; setFailures(f); if (f >= 3) { setLockedUntil(Date.now() + 30_000); setFailures(0); } }
  };
  return (
    <section className={`screen screen--settings ${shake ? "shake" : ""}`}>
      <h1>{t("resident.settings.title")}</h1>
      {!unlocked ? (<><p>{t("resident.settings.pin")}</p><PinPad onSubmit={(p) => void submitPin(p)} disabled={Date.now() < lockedUntil} /></>) : (
        <form onSubmit={(e) => { e.preventDefault(); if (token.trim()) onSaveToken(token.trim()); }}>
          <label htmlFor="device-token">{t("resident.settings.device_token")}</label>
          <input id="device-token" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          <button type="submit" className="quiet-button">{t("resident.settings.save")}</button>
        </form>
      )}
      <button type="button" className="quiet-button" onClick={onBack}>{t("resident.settings.back")}</button>
    </section>
  );
}
```

`styles.css` must define tokens on `:root` (warm off-white background, deep green primary, soft coral danger, ink text at AA contrast), a type scale with `html { font-size: 32px }` as the floor, `.big-button { min-height: 120px; min-width: 60%; font-size: 1.25rem }`, `.stage` as a centered column, `.badge-sim` as a high-visibility amber badge, and `touch-action: manipulation; user-select: none` on `.kiosk`. Design the rest with the frontend-design skill.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/resident && npx vitest run && npx tsc -b`
Expected: PASS (5 + 2 + 4 tests); whole suite green; typecheck clean.

- [ ] **Step 5: Manual check in a browser**

From the repo root: `npm run dev`. Open `http://localhost:5173`, enter the seed device token `device-demo-token` in Settings, save, confirm the home screen renders with the SIMULATED ROBOT badge (mock gateway running per Plan 2 Task 7 smoke). Resize to 1024×768 (iPad landscape) and confirm no horizontal scroll and every primary button is at least 120 px tall (inspect). Stop the servers.

- [ ] **Step 6: Commit**

```bash
git add apps/resident package.json package-lock.json tsconfig.json
git commit -m "feat(resident): kiosk app with server-driven screens, incoming call, PIN settings" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 4: Family web app (`apps/family`) — login, residents, request visit, live progress

**Load the `frontend-design` skill before writing any JSX or CSS.** Responsive (phone first), calm, trustworthy; not a dashboard.

**Files:**
- Create: `apps/family/index.html`, `package.json`, `tsconfig.json`, `vite.config.ts`
- Create: `apps/family/src/main.tsx`, `src/App.tsx`, `src/progress.ts`, `src/session.ts`
- Create: `apps/family/src/pages/Login.tsx`, `Residents.tsx`, `Visit.tsx`
- Create: `apps/family/src/styles.css`
- Modify: root `tsconfig.json` references — add `apps/family`
- Test: `apps/family/test/progress.test.ts`, `test/App.test.tsx`

**Interfaces:**
- Consumes: `createApi`, `connectEvents`, `t`, `ApiError` from `@oncare/web-common`; `GET /me/residents`, `POST /visits`, `GET /visits/:id`, `POST /visits/:id/{cancel,end,connected}`; `VISIT_TERMINAL_STATES` from `@oncare/core`.
- Produces:
  ```ts
  // src/progress.ts
  export const VISIT_STEPS = ["requested", "approval", "robot", "ringing", "connecting", "active", "completed"] as const;
  export type VisitStep = (typeof VISIT_STEPS)[number];
  export interface VisitProgress { steps: readonly VisitStep[]; currentIndex: number; failed: string | null; terminal: boolean }
  export function visitProgress(state: string): VisitProgress;
  //   requested->0, awaiting_policy_or_staff->1, accepted|robot_en_route->2, awaiting_resident_consent->3, connecting->4, active|ending->5, completed->6
  //   failure states: currentIndex = index of the step that failed (denied->1, resident_unavailable->3, robot_unavailable|navigation_failed->2, connection_failed->4, cancelled|safety_stopped -> last non-terminal index reached is unknown, use 2), failed = state, terminal = true
  // src/session.ts
  export function readSession(): { token: string; displayName: string } | null; export function writeSession(s | null): void;   // sessionStorage "oncare.family", try/catch
  ```
- App behaviour:
  - Routes by simple state (no router library): `login` → `residents` → `visit/:id`. Back link on the visit page.
  - `Login`: username + password → `POST /auth/login`; on 401 show `family.login.failed`. Stores `{ token, displayName }` in `sessionStorage`.
  - `Residents`: `GET /me/residents`; each card shows name, availability label (`family.residents.availability.<value>`), and "Send the robot to visit" button, disabled unless `availability !== "not_available"` and `relationship.consentRobotVisit`. Clicking posts `/visits` and navigates to the visit page. On `ApiError` show its code as a short inline message via `t("family.visit.failed." + code)` when a key exists, otherwise the code itself.
  - `Visit`: loads `GET /visits/:id`, subscribes to `/events` and refetches on any event whose `entityId` equals the visit id; renders a vertical stepper from `visitProgress(state)` (past steps checked, current highlighted, failed step red with `family.visit.failed.<state>`); buttons: "Cancel visit" while not terminal and state before `connecting`; "End call" while `active`; "Ask the robot for help" disabled with a tooltip until Plan 5. When the API reports `robot.adapter === "mock"`... the family API has no robot block; instead show the `family.badge.simulated` badge if `GET /visits/:id` returns `visit.simulated === true` — **add that field**: in Plan 2's `GET /visits/:id` handler include `simulated: app.hub.status(visit.robotId ?? "").lastHeartbeat?.adapter === "mock"` inside the returned `visit` object (a computed field, not a column). Include that API change and a one-line test assertion in `apps/api/test/visits.test.ts` in this task.
  - The `connected` action is posted automatically by the Visit page the first time it sees state `connecting` (stand-in for LiveKit's join until Plan 4), so the demo flow reaches `active` without manual steps.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/family/test/progress.test.ts
import { describe, expect, test } from "vitest";
import { visitProgress } from "../src/progress";

describe("visitProgress", () => {
  test("happy path indices", () => {
    expect(visitProgress("requested").currentIndex).toBe(0);
    expect(visitProgress("awaiting_policy_or_staff").currentIndex).toBe(1);
    expect(visitProgress("accepted").currentIndex).toBe(2);
    expect(visitProgress("robot_en_route").currentIndex).toBe(2);
    expect(visitProgress("awaiting_resident_consent").currentIndex).toBe(3);
    expect(visitProgress("connecting").currentIndex).toBe(4);
    expect(visitProgress("active")).toMatchObject({ currentIndex: 5, failed: null, terminal: false });
    expect(visitProgress("completed")).toMatchObject({ currentIndex: 6, failed: null, terminal: true });
  });
  test("failures point at the step that failed and are terminal", () => {
    expect(visitProgress("denied")).toMatchObject({ currentIndex: 1, failed: "denied", terminal: true });
    expect(visitProgress("resident_unavailable")).toMatchObject({ currentIndex: 3, failed: "resident_unavailable" });
    expect(visitProgress("navigation_failed")).toMatchObject({ currentIndex: 2, failed: "navigation_failed" });
    expect(visitProgress("connection_failed")).toMatchObject({ currentIndex: 4, failed: "connection_failed" });
    expect(visitProgress("cancelled")).toMatchObject({ failed: "cancelled", terminal: true });
    expect(visitProgress("safety_stopped")).toMatchObject({ failed: "safety_stopped", terminal: true });
  });
  test("unknown state is treated as requested and not failed", () => {
    expect(visitProgress("???")).toMatchObject({ currentIndex: 0, failed: null, terminal: false });
  });
});
```

```tsx
// apps/family/test/App.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { App } from "../src/App";

type Handler = (path: string, init?: RequestInit) => { status: number; body: unknown };
function installFetch(handler: Handler) {
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace("http://api", "");
    calls.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: String(init.body) } : {}) });
    const r = handler(path, init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }));
  return calls;
}
class NoopSocket { onopen: any; onmessage: any; onclose: any; constructor(_u: string) {} close() {} }
beforeEach(() => { try { sessionStorage.clear(); } catch {} vi.stubGlobal("WebSocket", NoopSocket); });

const resident = { id: "resident_demo_01", displayName: "Mom", availability: "available", relationship: { label: "daughter", consentVideo: true, consentRobotVisit: true, consentItemDelivery: true } };

test("login -> residents -> request a visit -> live stepper reaches the call and auto-reports connected", async () => {
  let state = "accepted";
  const calls = installFetch((path, init) => {
    if (path === "/auth/login") return init?.body?.toString().includes("family-demo-pass") ? { status: 200, body: { token: "jwt", principal: { kind: "user", id: "family_demo_01", role: "family", displayName: "Demo Daughter" } } } : { status: 401, body: { error: "invalid_credentials" } };
    if (path === "/me/residents") return { status: 200, body: { residents: [resident] } };
    if (path === "/visits" && init?.method === "POST") return { status: 201, body: { visit: { id: "v1", state, residentId: resident.id, simulated: true } } };
    if (path === "/visits/v1") return { status: 200, body: { visit: { id: "v1", state, residentId: resident.id, simulated: true } } };
    if (path === "/visits/v1/connected") { state = "active"; return { status: 200, body: { visit: { id: "v1", state } } }; }
    return { status: 404, body: { error: "not_found" } };
  });
  render(<App apiBase="http://api" />);
  await userEvent.type(screen.getByLabelText("Username"), "family");
  await userEvent.type(screen.getByLabelText("Password"), "wrong");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByText("Wrong username or password")).toBeInTheDocument();
  await userEvent.clear(screen.getByLabelText("Password"));
  await userEvent.type(screen.getByLabelText("Password"), "family-demo-pass");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByText("Mom")).toBeInTheDocument();
  expect(screen.getByText("Available")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Send the robot to visit" }));
  expect(await screen.findByText("Visit with Mom")).toBeInTheDocument();
  expect(screen.getByText("SIMULATED ROBOT")).toBeInTheDocument();
  expect(screen.getByText("Robot is on its way")).toHaveAttribute("aria-current", "step");
  // server moves to connecting; the page refetches (simulate by re-rendering via the events callback is not possible with NoopSocket, so trigger the poll)
  state = "connecting";
  await waitFor(() => expect(calls.some((c) => c.path === "/visits/v1/connected" && c.method === "POST")).toBe(true), { timeout: 6000 });
  expect(await screen.findByText("On the call")).toHaveAttribute("aria-current", "step");
});

test("a failed visit shows the reason on the failed step and no robot controls exist anywhere", async () => {
  try { sessionStorage.setItem("oncare.family", JSON.stringify({ token: "jwt", displayName: "Demo Daughter" })); } catch {}
  installFetch((path) => {
    if (path === "/me/residents") return { status: 200, body: { residents: [resident] } };
    if (path === "/visits/v9") return { status: 200, body: { visit: { id: "v9", state: "navigation_failed", residentId: resident.id, simulated: false } } };
    return { status: 404, body: { error: "not_found" } };
  });
  render(<App apiBase="http://api" initialVisitId="v9" />);
  expect(await screen.findByText("The robot could not reach the room")).toBeInTheDocument();
  expect(screen.queryByText(/joystick|drive|arm|joint/i)).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel visit" })).toBeNull();
});

test("resident not available disables the visit button", async () => {
  try { sessionStorage.setItem("oncare.family", JSON.stringify({ token: "jwt", displayName: "Demo Daughter" })); } catch {}
  installFetch((path) => path === "/me/residents" ? { status: 200, body: { residents: [{ ...resident, availability: "not_available" }] } } : { status: 404, body: {} });
  render(<App apiBase="http://api" />);
  expect(await screen.findByRole("button", { name: "Send the robot to visit" })).toBeDisabled();
  expect(screen.getByText("Not available")).toBeInTheDocument();
});
```

- [ ] **Step 2: Scaffold and run to verify failure**

`apps/family/package.json`, `tsconfig.json`, `vite.config.ts` (port 5174), `index.html` mirror Task 3's with the name `@oncare/family` and title "OnCare Family". Run `npm install --no-audit --no-fund`, then `npx vitest run apps/family`.
Expected: FAIL — modules missing.

- [ ] **Step 3: Write the implementation**

```ts
// apps/family/src/progress.ts
export const VISIT_STEPS = ["requested", "approval", "robot", "ringing", "connecting", "active", "completed"] as const;
export type VisitStep = (typeof VISIT_STEPS)[number];
export interface VisitProgress { steps: readonly VisitStep[]; currentIndex: number; failed: string | null; terminal: boolean }
const HAPPY: Record<string, number> = { requested: 0, awaiting_policy_or_staff: 1, accepted: 2, robot_en_route: 2, awaiting_resident_consent: 3, connecting: 4, active: 5, ending: 5, completed: 6 };
const FAILED: Record<string, number> = { denied: 1, resident_unavailable: 3, robot_unavailable: 2, navigation_failed: 2, connection_failed: 4, cancelled: 2, safety_stopped: 2 };
export function visitProgress(state: string): VisitProgress {
  if (state in FAILED) return { steps: VISIT_STEPS, currentIndex: FAILED[state]!, failed: state, terminal: true };
  const idx = HAPPY[state] ?? 0;
  return { steps: VISIT_STEPS, currentIndex: idx, failed: null, terminal: state === "completed" };
}
```

```ts
// apps/family/src/session.ts
const KEY = "oncare.family";
export interface Session { token: string; displayName: string }
export function readSession(): Session | null { try { const raw = sessionStorage.getItem(KEY); return raw ? (JSON.parse(raw) as Session) : null; } catch { return null; } }
export function writeSession(s: Session | null): void { try { if (s) sessionStorage.setItem(KEY, JSON.stringify(s)); else sessionStorage.removeItem(KEY); } catch { /* ignore */ } }
```

```tsx
// apps/family/src/App.tsx
import { useMemo, useState } from "react";
import { createApi } from "@oncare/web-common";
import { readSession, writeSession, type Session } from "./session";
import { Login } from "./pages/Login";
import { Residents } from "./pages/Residents";
import { Visit } from "./pages/Visit";

type Route = { name: "residents" } | { name: "visit"; id: string };

export function App({ apiBase, initialVisitId }: { apiBase: string; initialVisitId?: string }) {
  const [session, setSession] = useState<Session | null>(() => readSession());
  const [route, setRoute] = useState<Route>(initialVisitId ? { name: "visit", id: initialVisitId } : { name: "residents" });
  const api = useMemo(() => createApi(apiBase, () => session?.token ?? null), [apiBase, session]);
  if (!session) return <Login api={api} onLoggedIn={(s) => { writeSession(s); setSession(s); }} />;
  if (route.name === "visit") return <Visit api={api} apiBase={apiBase} token={session.token} visitId={route.id} onBack={() => setRoute({ name: "residents" })} />;
  return <Residents api={api} displayName={session.displayName} onVisitCreated={(id) => setRoute({ name: "visit", id })} onLogout={() => { writeSession(null); setSession(null); }} />;
}
```

```tsx
// apps/family/src/pages/Login.tsx
import { useState } from "react";
import { ApiError, t, type Api } from "@oncare/web-common";
export function Login({ api, onLoggedIn }: { api: Api; onLoggedIn: (s: { token: string; displayName: string }) => void }) {
  const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    try {
      const r = await api.post<{ token: string; principal: { displayName?: string } }>("/auth/login", { username, password });
      onLoggedIn({ token: r.token, displayName: r.principal.displayName ?? username });
    } catch (err) { setError(err instanceof ApiError && err.status === 401 ? t("family.login.failed") : String(err)); }
  };
  return (
    <main className="page page--login"><h1>{t("family.login.title")}</h1>
      <form onSubmit={submit}>
        <label htmlFor="username">{t("family.login.username")}</label><input id="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <label htmlFor="password">{t("family.login.password")}</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p role="alert" className="error">{error}</p>}
        <button type="submit" className="primary">{t("family.login.submit")}</button>
      </form>
    </main>
  );
}
```

```tsx
// apps/family/src/pages/Residents.tsx
import { useEffect, useState } from "react";
import { ApiError, t, type Api } from "@oncare/web-common";
interface ResidentCard { id: string; displayName: string; availability: string; relationship: { consentRobotVisit: boolean } }
export function Residents({ api, displayName, onVisitCreated, onLogout }: { api: Api; displayName: string; onVisitCreated: (id: string) => void; onLogout: () => void }) {
  const [residents, setResidents] = useState<ResidentCard[]>([]); const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get<{ residents: ResidentCard[] }>("/me/residents").then((r) => setResidents(r.residents)).catch((e) => setError(String(e))); }, [api]);
  const request = async (residentId: string) => {
    setError(null);
    try { const r = await api.post<{ visit: { id: string } }>("/visits", { residentId }); onVisitCreated(r.visit.id); }
    catch (e) { const code = e instanceof ApiError ? e.code : "http_error"; const key = `family.visit.failed.${code}`; const msg = t(key); setError(msg === key ? code : msg); }
  };
  return (
    <main className="page page--residents">
      <header><h1>{t("family.residents.title")}</h1><button type="button" className="link" onClick={onLogout}>{displayName}</button></header>
      {error && <p role="alert" className="error">{error}</p>}
      <ul className="cards">{residents.map((r) => (
        <li key={r.id} className="card">
          <h2>{r.displayName}</h2>
          <p className={`availability availability--${r.availability}`}>{t(`family.residents.availability.${r.availability}`)}</p>
          <button type="button" className="primary" disabled={r.availability === "not_available" || !r.relationship.consentRobotVisit} onClick={() => void request(r.id)}>{t("family.residents.visit")}</button>
        </li>))}</ul>
    </main>
  );
}
```

```tsx
// apps/family/src/pages/Visit.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { connectEvents, t, type Api } from "@oncare/web-common";
import { visitProgress, VISIT_STEPS } from "../progress";
interface VisitView { id: string; state: string; residentId: string; simulated?: boolean }
const STEP_KEY: Record<(typeof VISIT_STEPS)[number], string> = { requested: "family.visit.step.requested", approval: "family.visit.step.approval", robot: "family.visit.step.robot", ringing: "family.visit.step.ringing", connecting: "family.visit.step.connecting", active: "family.visit.step.active", completed: "family.visit.step.completed" };
export function Visit({ api, apiBase, token, visitId, onBack }: { api: Api; apiBase: string; token: string; visitId: string; onBack: () => void }) {
  const [visit, setVisit] = useState<VisitView | null>(null); const [residentName, setResidentName] = useState("");
  const reportedConnected = useRef(false);
  const refresh = useCallback(async () => { try { const r = await api.get<{ visit: VisitView }>(`/visits/${visitId}`); setVisit(r.visit); } catch { /* keep last */ } }, [api, visitId]);
  useEffect(() => { void refresh(); const i = setInterval(() => void refresh(), 3000); const h = connectEvents(apiBase, token, (ev) => { if (ev.entityId === visitId) void refresh(); }); return () => { clearInterval(i); h.close(); }; }, [apiBase, token, visitId, refresh]);
  useEffect(() => { api.get<{ residents: Array<{ id: string; displayName: string }> }>("/me/residents").then((r) => setResidentName(r.residents.find((x) => x.id === visit?.residentId)?.displayName ?? "")).catch(() => {}); }, [api, visit?.residentId]);
  useEffect(() => { if (visit?.state === "connecting" && !reportedConnected.current) { reportedConnected.current = true; api.post(`/visits/${visitId}/connected`).then(() => void refresh()).catch(() => {}); } }, [api, visit?.state, visitId, refresh]);
  if (!visit) return <main className="page"><p>…</p></main>;
  const p = visitProgress(visit.state);
  const canCancel = !p.terminal && p.currentIndex < 4;
  return (
    <main className="page page--visit">
      <button type="button" className="link" onClick={onBack}>←</button>
      <h1>{t("family.visit.title", { name: residentName })}</h1>
      {visit.simulated && <span className="badge-sim">{t("family.badge.simulated")}</span>}
      <ol className="stepper">{VISIT_STEPS.map((s, i) => {
        const cls = i < p.currentIndex ? "done" : i === p.currentIndex ? (p.failed ? "failed" : "current") : "todo";
        return <li key={s} className={`step step--${cls}`} aria-current={i === p.currentIndex ? "step" : undefined}>{t(STEP_KEY[s])}{i === p.currentIndex && p.failed && <p className="failed-reason">{t(`family.visit.failed.${p.failed}`, { name: residentName })}</p>}</li>;
      })}</ol>
      <div className="actions">
        {canCancel && <button type="button" onClick={() => api.post(`/visits/${visitId}/cancel`).then(() => void refresh())}>{t("family.visit.cancel")}</button>}
        {visit.state === "active" && <button type="button" className="danger" onClick={() => api.post(`/visits/${visitId}/end`).then(() => void refresh())}>{t("family.visit.end")}</button>}
        <button type="button" className="primary" disabled title="Available in the next release">{t("family.visit.ask_robot")}</button>
      </div>
    </main>
  );
}
```

`main.tsx` mirrors the resident app (`VITE_API_BASE ?? "/api"`). `styles.css`: mobile-first, 16 px gutters, max-width 40rem, tokens on `:root`, stepper with a vertical line, `.badge-sim` amber; design with the frontend-design skill.

API change (in this task): in `apps/api/src/routes/visits.ts` `GET /visits/:id`, return `{ visit: { ...visit, simulated: app.hub.status(visit.robotId ?? "").lastHeartbeat?.adapter === "mock" } }` and add to `apps/api/test/visits.test.ts`: after attaching a mock heartbeat via `app.hub.receive(...)`, `expect(res.json().visit.simulated).toBe(true)`; without a heartbeat it is `false`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/family apps/api/test/visits.test.ts && npx vitest run && npx tsc -b`
Expected: PASS (3 + 3 tests + the API addition); whole suite green; typecheck clean.

- [ ] **Step 5: Manual check**

`npm run dev`, open `http://localhost:5174` on a phone-width viewport, log in with `family` / `family-demo-pass`, request a visit; with the mock gateway running (Plan 2 Task 7) the stepper should advance to "Ringing on the iPad" within a few seconds, and the resident app at `:5173` should show the incoming screen. Stop the servers.

- [ ] **Step 6: Commit**

```bash
git add apps/family apps/api/src/routes/visits.ts apps/api/test/visits.test.ts package.json package-lock.json tsconfig.json
git commit -m "feat(family): login, resident cards, visit request and live progress stepper" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 5: Kiosk setup doc and cross-app demo script

**Files:**
- Create: `docs/ipad-kiosk-setup.md`
- Create: `docs/demo-visit-flow.md`
- Create: `scripts/demo-check.mjs` — starts nothing; probes `http://127.0.0.1:3000/health`, `:5173`, `:5174` and prints which are up (used before every rehearsal)

**Interfaces:** none new.

- [ ] **Step 1: Write the docs**

`docs/ipad-kiosk-setup.md` must contain, in order: (1) network prerequisite (iPad and the dev machine on the same LAN; the API URL uses the dev machine's LAN IP, not localhost); (2) building the resident app for LAN use (`VITE_API_BASE=http://<lan-ip>:3000 npm run build -w @oncare/resident` then `npm run preview -w @oncare/resident -- --host`); (3) Safari steps: open the URL, Share → Add to Home Screen; (4) Guided Access: Settings → Accessibility → Guided Access → on, set passcode; open the home-screen app, triple-click the side button, disable touch on the bottom-left logo area is NOT required (the in-app PIN covers it), Start; (5) entering the device token once in Settings (long-press bottom-left logo 3 s → PIN `2468` for the demo → paste `device-demo-token`); (6) exiting: triple-click → passcode → End; (7) known limits: Safari may pause audio/video when the screen locks — set Auto-Lock to Never during the demo.

`docs/demo-visit-flow.md`: the four terminals to start (`npm run dev`, mock gateway command from Plan 2 Task 7), then the numbered click-through matching handover section 8 steps 1–5, with the expected screen on each device at each step and the expected audit trail (the 8 `toState` values from Plan 2 Task 8).

```js
// scripts/demo-check.mjs
const targets = [["api", "http://127.0.0.1:3000/health"], ["resident", "http://127.0.0.1:5173/"], ["family", "http://127.0.0.1:5174/"]];
for (const [name, url] of targets) {
  try { const r = await fetch(url); console.log(`${name.padEnd(9)} ${r.ok ? "up" : `http ${r.status}`}  ${url}`); }
  catch { console.log(`${name.padEnd(9)} DOWN ${url}`); }
}
```
Add root script `"demo:check": "node scripts/demo-check.mjs"`.

- [ ] **Step 2: Verify**

Run: `npm run demo:check` with nothing running → three `DOWN` lines; with `npm run dev` running → three `up` lines.

- [ ] **Step 3: Commit**

```bash
git add docs/ipad-kiosk-setup.md docs/demo-visit-flow.md scripts/demo-check.mjs package.json
git commit -m "docs: iPad kiosk setup, demo visit flow, and a readiness check script" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

## Plan self-review

**Spec coverage (Plan 3 scope):** §2 device routes (Task 1); §4 resident kiosk five screens, spoken prompt, PIN long-press, status bar, idle return, no gestures (Task 3); §4 family login → resident card → request visit → progress with failure reasons, Web Speech deferred to Plan 5 with the task flow, no robot controls (Task 4); `SIMULATED ROBOT` badge on both clients (Tasks 3–4); i18n keys for everything (Task 2); kiosk setup doc (Task 5, pulled forward from Plan 7 because the iPad is needed for rehearsals).

**Placeholder scan:** the `Ask the robot for help` button is intentionally disabled until Plan 5 and says so in the tooltip; `DeliveryArrived` receives an empty `itemLabel` until Plan 5 wires tasks. Both are stated, bounded stubs.

**Type consistency:** `DeviceState` shape (Task 1 response ↔ Task 3 `screen.ts`); `visit.simulated` (Task 4 API addition ↔ `VisitView`); i18n keys used in Tasks 3–4 all exist in Task 2's `en.json`; `createApi`/`connectEvents`/`t`/`ApiError` signatures (Task 2 ↔ 3 ↔ 4); `useIdleReturn(ms, onIdle, enabled)` (Task 3 idle.ts ↔ App.tsx ↔ test).
