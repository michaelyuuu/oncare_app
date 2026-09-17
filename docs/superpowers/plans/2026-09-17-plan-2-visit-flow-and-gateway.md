# Plan 2: Visit Flow, Realtime Events, Gateway Link, Python Gateway Skeleton

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A family user can request a visit, the API drives the visit state machine, dispatches a `request_visit` intent to the robot over the `/gateway` WebSocket, the Python gateway (mock robot) executes it and reports back, and every web client can follow the visit live over `/events`.

**Architecture:** The API owns all state; the gateway reports events. A `GatewayHub` holds live robot sockets and the latest heartbeat. A `DispatchService` subscribes to transitions and turns `accepted` into a `robot_command` row plus an intent message; gateway `ack` and `state_event` messages come back through the hub and become transitions. The Python gateway is split into a pure `GatewayCore` (deterministic, unit-tested with a fake clock) and a thin asyncio runner that owns the socket.

**Tech Stack:** Fastify 5, @fastify/websocket, `ws` (test client), drizzle, zod, @oncare/core, @oncare/contracts; Python 3.12, `websockets`, `jsonschema`, `pytest`, `pytest-asyncio`.

**Spec:** `docs/superpowers/specs/2026-09-17-oncare-platform-design.md` (sections 1, 2, 3)

**Depends on:** Plan 1 complete (`createTransitionService`, `requireRole`, `makeTestApp`, `SEED_IDS`/`SEED_SECRETS`, `GatewayDownSchema`/`GatewayUpSchema`, `robot_gateway/schema/*.json`).

## Global Constraints

- ESM everywhere; TypeScript `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- Tests: `npx vitest run <path>` from the repo root; Python tests: `python -m pytest robot_gateway -m "not hardware"` from the repo root.
- `visit_session.state` and `task_request.state` are written only through `createTransitionService().apply()`; the gateway never declares a state.
- Cloud → gateway messages are only the shapes in `GatewayDownSchema`; the gateway rejects anything else and never receives raw coordinates from an intent (locations arrive separately via the `locations` message).
- Every intent carries `expiresAt`; a re-sent `correlationId` is acked `duplicate` and not re-executed; one intent executes at a time (`busy`).
- WebSocket to the API down for more than 10 s → gateway calls the adapter's `cancel()` and enters `safety_stopped`.
- The gateway never calls `/joy`, `console_web`, or any arm port; there is no such code path.
- Audit rows contain IDs only. Synthetic demo data only.
- Commit after every task with the trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC
  ```
- Do not modify anything under `D:/ontaru/AGI carehouse/on_software_all`.

## File structure produced by this plan

```
apps/api/src/
  services/visits.ts        createVisitService(): create, get, canView, policy auto-accept
  services/gateway-hub.ts   GatewayHub: live sockets, latest heartbeat, pending flush
  services/dispatch.ts      DispatchService: transitions -> intents, gateway messages -> transitions
  routes/visits.ts          POST /visits, GET /visits/:id, approve/deny/answer/decline/connected/end/cancel
  routes/gateway-ws.ts      WS /gateway (robot token), GET /robots/:id/status
  routes/events-ws.ts       WS /events (JWT, filtered)
  app.ts                    wires the above; exposes app.transitions, app.hub for tests
apps/api/test/
  visits.test.ts, visit-actions.test.ts, dispatch.test.ts, gateway-ws.test.ts, events-ws.test.ts, e2e-visit.test.ts
robot_gateway/
  pyproject.toml
  gateway/__init__.py
  gateway/messages.py       load JSON Schema, validate down/up messages
  gateway/robot/base.py     RobotAdapter protocol + NavResult
  gateway/robot/mock.py     MockRobotAdapter
  gateway/core.py           GatewayCore (pure): handle(), tick(), heartbeat()
  gateway/runner.py         asyncio WebSocket runner
  gateway/config.py         load config.toml / env
  gateway/__main__.py       python -m gateway
  config.example.toml
  tests/test_messages.py, test_mock_adapter.py, test_core.py, test_runner.py
```

---

### Task 1: Visit creation and read with relationship and consent checks

**Files:**
- Create: `apps/api/src/services/visits.ts`
- Create: `apps/api/src/routes/visits.ts`
- Modify: `apps/api/src/app.ts` — register `visitRoutes`; create and expose the transition service
- Test: `apps/api/test/visits.test.ts`

**Interfaces:**
- Consumes: `createTransitionService` (Plan 1 Task 7), `requireRole`, `Principal` (Plan 1 Task 6), tables.
- Produces:
  ```ts
  // src/services/visits.ts
  export type VisitRow = typeof t.visitSession.$inferSelect;
  export type CreateVisitError = "no_relationship" | "consent_missing" | "resident_unavailable";
  export interface VisitService {
    create(input: { requesterId: string; residentId: string }): { ok: true; visit: VisitRow } | { ok: false; error: CreateVisitError };
    get(id: string): VisitRow | undefined;
    canView(principal: Principal, visit: VisitRow): boolean;
  }
  export function createVisitService(db: Db, transitions: TransitionService, opts?: { now?: () => Date; id?: () => string }): VisitService;
  // src/app.ts additions
  export interface AppOptions { db: Db; jwtSecret: string; now?: () => Date }
  declare module "fastify" { interface FastifyInstance { transitions: TransitionService; visits: VisitService } }
  // where TransitionService = ReturnType<typeof createTransitionService>
  // Routes
  POST /visits            family  body { residentId }  -> 201 { visit } | 403 {error:"no_relationship"} | 409 {error:"consent_missing"|"resident_unavailable"}
  GET  /visits/:id        family (own) | staff | device (same resident) -> 200 { visit } | 403 | 404
  ```
- Policy in `create`: relationship must exist with `consentVideo && consentRobotVisit`, otherwise `consent_missing`; resident `availability === "not_available"` → `resident_unavailable`; insert row in `requested`, apply `→ awaiting_policy_or_staff` (actor `system`/`api`); if `availability === "available"` apply `→ accepted` with reason `auto_policy`, else leave for staff.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/visits.test.ts
import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("POST /visits", () => {
  test("family user with consent creates a visit that is auto-accepted when the resident is available", async () => {
    const { app, db, tokens } = await makeTestApp();
    const res = await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } });
    expect(res.statusCode).toBe(201);
    const visit = res.json().visit;
    expect(visit).toMatchObject({ residentId: SEED_IDS.resident, requesterId: SEED_IDS.familyUser, state: "accepted" });
    const audit = db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, visit.id)).all().map((e) => e.toState);
    expect(audit).toEqual(["awaiting_policy_or_staff", "accepted"]);
  });

  test("resident in_activity leaves the visit awaiting staff", async () => {
    const { app, db, tokens } = await makeTestApp();
    db.update(t.resident).set({ availability: "in_activity" }).where(eq(t.resident.id, SEED_IDS.resident)).run();
    const res = await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } });
    expect(res.statusCode).toBe(201);
    expect(res.json().visit.state).toBe("awaiting_policy_or_staff");
  });

  test("resident not_available is 409 and creates nothing", async () => {
    const { app, db, tokens } = await makeTestApp();
    db.update(t.resident).set({ availability: "not_available" }).where(eq(t.resident.id, SEED_IDS.resident)).run();
    const res = await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "resident_unavailable" });
    expect(db.select().from(t.visitSession).all()).toHaveLength(0);
  });

  test("family user without a relationship to the resident is 403", async () => {
    const { app, db, tokens } = await makeTestApp();
    db.insert(t.resident).values({ id: "resident_demo_02", facilityId: SEED_IDS.facility, displayName: "Other", roomLocationId: SEED_IDS.roomLocation }).run();
    const res = await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: "resident_demo_02" } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "no_relationship" });
  });

  test("relationship without robot-visit consent is 409 consent_missing", async () => {
    const { app, db, tokens } = await makeTestApp();
    db.update(t.familyRelationship).set({ consentRobotVisit: false }).where(eq(t.familyRelationship.userId, SEED_IDS.familyUser)).run();
    const res = await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "consent_missing" });
  });

  test("staff cannot create visits", async () => {
    const { app, tokens } = await makeTestApp();
    const res = await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.staff), payload: { residentId: SEED_IDS.resident } });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /visits/:id", () => {
  async function created() {
    const ctx = await makeTestApp();
    const res = await ctx.app.inject({ method: "POST", url: "/visits", headers: auth(ctx.tokens.family), payload: { residentId: SEED_IDS.resident } });
    return { ...ctx, visitId: res.json().visit.id as string };
  }

  test("owner, staff, and the resident's device can read it", async () => {
    const { app, tokens, visitId } = await created();
    for (const tok of [tokens.family, tokens.staff, tokens.device]) {
      const res = await app.inject({ method: "GET", url: `/visits/${visitId}`, headers: auth(tok) });
      expect(res.statusCode).toBe(200);
      expect(res.json().visit.id).toBe(visitId);
    }
  });

  test("another family user is 403 and an unknown id is 404", async () => {
    const { app, db, tokens, visitId } = await created();
    const { hashSecret } = await import("../src/auth/password");
    db.insert(t.user).values({ id: "family_demo_02", role: "family", username: "family2", displayName: "Other", passwordHash: await hashSecret("pw"), pinHash: null }).run();
    const other = (await app.inject({ method: "POST", url: "/auth/login", payload: { username: "family2", password: "pw" } })).json().token;
    expect((await app.inject({ method: "GET", url: `/visits/${visitId}`, headers: auth(other) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/visits/nope`, headers: auth(tokens.family) })).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/visits.test.ts`
Expected: FAIL — `POST /visits` returns 404 (route missing).

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/visits.ts
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Principal } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import type { createTransitionService } from "./transitions";

export type TransitionService = ReturnType<typeof createTransitionService>;
export type VisitRow = typeof t.visitSession.$inferSelect;
export type CreateVisitError = "no_relationship" | "consent_missing" | "resident_unavailable";

export interface VisitService {
  create(input: { requesterId: string; residentId: string }): { ok: true; visit: VisitRow } | { ok: false; error: CreateVisitError };
  get(id: string): VisitRow | undefined;
  canView(principal: Principal, visit: VisitRow): boolean;
}

export function createVisitService(db: Db, transitions: TransitionService, opts: { now?: () => Date; id?: () => string } = {}): VisitService {
  const now = opts.now ?? (() => new Date());
  const id = opts.id ?? (() => `visit_${randomUUID()}`);

  function get(visitId: string): VisitRow | undefined {
    return db.select().from(t.visitSession).where(eq(t.visitSession.id, visitId)).get();
  }

  function create(input: { requesterId: string; residentId: string }) {
    const rel = db.select().from(t.familyRelationship)
      .where(and(eq(t.familyRelationship.userId, input.requesterId), eq(t.familyRelationship.residentId, input.residentId))).get();
    if (!rel) return { ok: false as const, error: "no_relationship" as const };
    if (!(rel.consentVideo && rel.consentRobotVisit)) return { ok: false as const, error: "consent_missing" as const };
    const resident = db.select().from(t.resident).where(eq(t.resident.id, input.residentId)).get();
    if (!resident || resident.availability === "not_available") return { ok: false as const, error: "resident_unavailable" as const };

    const robot = db.select().from(t.robot).where(eq(t.robot.facilityId, resident.facilityId)).get();
    const visitId = id();
    db.insert(t.visitSession).values({
      id: visitId, residentId: input.residentId, requesterId: input.requesterId, robotId: robot?.id ?? null,
      state: "requested", livekitRoom: null, requestedAt: now().toISOString(), connectedAt: null, endedAt: null,
    }).run();
    transitions.apply({ entityType: "visit", entityId: visitId, to: "awaiting_policy_or_staff", actorType: "system", actorId: "api" });
    if (resident.availability === "available") {
      transitions.apply({ entityType: "visit", entityId: visitId, to: "accepted", actorType: "system", actorId: "api", reason: "auto_policy" });
    }
    return { ok: true as const, visit: get(visitId)! };
  }

  function canView(principal: Principal, visit: VisitRow): boolean {
    if (principal.kind === "device") return principal.residentId === visit.residentId;
    if (principal.role === "staff") return true;
    return principal.id === visit.requesterId;
  }

  return { create, get, canView };
}
```

```ts
// apps/api/src/routes/visits.ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/plugin";

export async function visitRoutes(app: FastifyInstance) {
  app.post("/visits", { preHandler: requireRole("family") }, async (req, reply) => {
    const body = z.object({ residentId: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const p = req.principal;
    if (p.kind !== "user") return reply.code(403).send({ error: "forbidden" });
    const result = app.visits.create({ requesterId: p.id, residentId: body.data.residentId });
    if (!result.ok) return reply.code(result.error === "no_relationship" ? 403 : 409).send({ error: result.error });
    return reply.code(201).send({ visit: result.visit });
  });

  app.get("/visits/:id", { preHandler: requireRole("family", "staff", "device") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const visit = app.visits.get(id);
    if (!visit) return reply.code(404).send({ error: "not_found" });
    if (!app.visits.canView(req.principal, visit)) return reply.code(403).send({ error: "forbidden" });
    return { visit };
  });
}
```

Modify `apps/api/src/app.ts`:

```ts
import Fastify, { type FastifyInstance } from "fastify";
import { authPlugin } from "./auth/plugin";
import type { Db } from "./db/client";
import { authRoutes } from "./routes/auth";
import { meRoutes } from "./routes/me";
import { visitRoutes } from "./routes/visits";
import { createTransitionService } from "./services/transitions";
import { createVisitService, type TransitionService, type VisitService } from "./services/visits";

export interface AppOptions { db: Db; jwtSecret: string; now?: () => Date }

declare module "fastify" {
  interface FastifyInstance { transitions: TransitionService; visits: VisitService }
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const transitions = createTransitionService(opts.db, opts.now ? { now: opts.now } : {});
  app.decorate("transitions", transitions);
  app.decorate("visits", createVisitService(opts.db, transitions, opts.now ? { now: opts.now } : {}));
  app.register(authPlugin, { secret: opts.jwtSecret });
  app.register(authRoutes, { db: opts.db });
  app.register(meRoutes, { db: opts.db });
  app.register(visitRoutes);
  app.get("/health", async () => ({ ok: true }));
  return app;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/api/test/visits.test.ts && npx vitest run apps/api`
Expected: PASS (8 new tests) and all earlier API tests still green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/visits.ts apps/api/src/routes/visits.ts apps/api/src/app.ts apps/api/test/visits.test.ts
git commit -m "feat(api): create and read visits with relationship, consent and availability policy" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 2: Visit actions — approve, deny, answer, decline, connected, end, cancel

**Files:**
- Modify: `apps/api/src/routes/visits.ts` — add the action routes
- Modify: `apps/api/src/services/visits.ts` — add `act()`
- Test: `apps/api/test/visit-actions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // services/visits.ts additions
  export type VisitAction = "approve" | "deny" | "answer" | "decline" | "connected" | "end" | "cancel";
  export type ActError = "not_found" | "forbidden" | "illegal_transition";
  act(input: { visitId: string; action: VisitAction; principal: Principal }): { ok: true; visit: VisitRow } | { ok: false; error: ActError; detail?: string };
  // Routes: POST /visits/:id/<action> -> 200 { visit } | 403 | 404 | 409 { error:"illegal_transition", detail }
  ```
- Action table (who may call it, from → to):

| action | roles | transition(s) |
|---|---|---|
| approve | staff | `awaiting_policy_or_staff → accepted` |
| deny | staff | `awaiting_policy_or_staff → denied` |
| answer | device (same resident) | `awaiting_resident_consent → connecting` |
| decline | device (same resident) | `awaiting_resident_consent → resident_unavailable` |
| connected | family (owner), device | `connecting → active` and sets `connectedAt` |
| end | family (owner), device, staff | `active → ending` then `ending → completed`, sets `endedAt` |
| cancel | family (owner), staff | any non-terminal → `cancelled` |

Actor recorded in audit: `actorType` = `staff` / `device` / `family`, `actorId` = principal id.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/visit-actions.test.ts
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
    db.insert(t.robotDevice).values({ id: "ipad_demo_02", robotId: SEED_IDS.robot, kind: "ipad", residentId: "resident_demo_02", deviceTokenHash: await hashSecret("other-device") }).run();
    const tok = (await app.inject({ method: "POST", url: "/auth/device", payload: { deviceToken: "other-device" } })).json().token;
    expect((await act("answer", tok)).statusCode).toBe(403);
  });

  test("unknown action is 404", async () => {
    const { tokens, act } = await visitIn("active");
    expect((await act("teleport", tokens.staff)).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/visit-actions.test.ts`
Expected: FAIL — action routes return 404.

- [ ] **Step 3: Write the implementation**

Add to `apps/api/src/services/visits.ts` (inside `createVisitService`, and export the types):

```ts
export type VisitAction = "approve" | "deny" | "answer" | "decline" | "connected" | "end" | "cancel";
export type ActError = "not_found" | "forbidden" | "illegal_transition";

const ACTIONS: Record<VisitAction, { roles: Array<"family" | "staff" | "device">; to: VisitState[] }> = {
  approve:   { roles: ["staff"],                     to: ["accepted"] },
  deny:      { roles: ["staff"],                     to: ["denied"] },
  answer:    { roles: ["device"],                    to: ["connecting"] },
  decline:   { roles: ["device"],                    to: ["resident_unavailable"] },
  connected: { roles: ["family", "device"],          to: ["active"] },
  end:       { roles: ["family", "device", "staff"], to: ["ending", "completed"] },
  cancel:    { roles: ["family", "staff"],           to: ["cancelled"] },
};

function roleOf(p: Principal): "family" | "staff" | "device" { return p.kind === "device" ? "device" : p.role; }
function actorTypeOf(p: Principal): ActorType { return p.kind === "device" ? "device" : p.role; }

function act(input: { visitId: string; action: VisitAction; principal: Principal }) {
  const visit = get(input.visitId);
  if (!visit) return { ok: false as const, error: "not_found" as const };
  const spec = ACTIONS[input.action];
  if (!spec.roles.includes(roleOf(input.principal)) || !canView(input.principal, visit)) return { ok: false as const, error: "forbidden" as const };
  try {
    for (const to of spec.to) {
      transitions.apply({ entityType: "visit", entityId: visit.id, to, actorType: actorTypeOf(input.principal), actorId: input.principal.id });
    }
  } catch (e) {
    if (e instanceof TransitionError) return { ok: false as const, error: "illegal_transition" as const, detail: e.reason };
    throw e;
  }
  const stamp = input.action === "connected" ? { connectedAt: now().toISOString() } : input.action === "end" ? { endedAt: now().toISOString() } : null;
  if (stamp) db.update(t.visitSession).set(stamp).where(eq(t.visitSession.id, visit.id)).run();
  return { ok: true as const, visit: get(visit.id)! };
}
```

Imports needed at the top of `visits.ts`: `import { TransitionError } from "./transitions";`, `import type { ActorType, VisitState } from "@oncare/core";`. Add `act` to the `VisitService` interface and to the returned object. Export `VISIT_ACTIONS = Object.keys(ACTIONS) as VisitAction[]`.

Add to `apps/api/src/routes/visits.ts`:

```ts
import { VISIT_ACTIONS, type VisitAction } from "../services/visits";

app.post("/visits/:id/:action", { preHandler: requireRole("family", "staff", "device") }, async (req, reply) => {
  const { id, action } = req.params as { id: string; action: string };
  if (!(VISIT_ACTIONS as string[]).includes(action)) return reply.code(404).send({ error: "not_found" });
  const result = app.visits.act({ visitId: id, action: action as VisitAction, principal: req.principal });
  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : result.error === "forbidden" ? 403 : 409;
    return reply.code(status).send({ error: result.error, ...(result.detail ? { detail: result.detail } : {}) });
  }
  return { visit: result.visit };
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/api/test/visit-actions.test.ts && npx vitest run apps/api`
Expected: PASS (11 new tests); earlier API tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/visits.ts apps/api/src/routes/visits.ts apps/api/test/visit-actions.test.ts
git commit -m "feat(api): visit actions with role checks and machine-enforced transitions" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 3: GatewayHub and DispatchService (transitions ↔ robot intents)

**Files:**
- Create: `apps/api/src/services/gateway-hub.ts`
- Create: `apps/api/src/services/dispatch.ts`
- Modify: `apps/api/src/app.ts` — create hub + dispatch, expose `app.hub`
- Test: `apps/api/test/dispatch.test.ts`

**Interfaces:**
- Consumes: `GatewayDown`, `GatewayUp`, `Heartbeat`, `Intent` types from `@oncare/contracts`; `TransitionService`; tables.
- Produces:
  ```ts
  // services/gateway-hub.ts
  export interface RobotLink { send(msg: GatewayDown): void }
  export interface RobotStatus { connected: boolean; lastHeartbeat: Heartbeat | null; lastSeenAt: string | null }
  export class GatewayHub {
    attach(robotId: string, link: RobotLink): void;      // replaces any previous link
    detach(robotId: string): void;
    recordHeartbeat(robotId: string, hb: Heartbeat, at: string): void;
    send(robotId: string, msg: GatewayDown): boolean;    // false when not connected
    status(robotId: string): RobotStatus;
    onUp(listener: (robotId: string, msg: GatewayUp) => void): () => void;
    receive(robotId: string, msg: GatewayUp): void;      // called by the WS route; fans out to onUp listeners and records heartbeats
  }
  // services/dispatch.ts
  export function createDispatchService(db: Db, transitions: TransitionService, hub: GatewayHub, opts?: { now?: () => Date; id?: () => string; intentTtlMs?: number }): {
    flushPending(robotId: string): number;   // re-sends unacked, unexpired commands; returns count
    stop(): void;
  };
  ```
- Behaviour:
  - On visit transition to `accepted`: look up resident room location; insert `robot_command` `{ id: "cmd_<uuid>", robotId, visitId, intent: <IntentRequestVisit>, issuedAt, expiresAt = now + intentTtlMs (default 120000) }`; send `intent` via hub if connected. `correlationId` of the intent = the visit id.
  - On `ack` for a known command: set `ackedAt`, `result`. `accepted` → visit `robot_en_route`. `expired`/`rejected`/`busy` → visit `robot_unavailable` (reason = ack result). `duplicate` → no transition.
  - On `state_event` for a known command (by `correlationId` = visit id): `arrived` → `awaiting_resident_consent`; `navigation_failed` → `navigation_failed`; `safety_stopped` → `safety_stopped`; `cancelled` → no-op if the visit is already `cancelled`, else `cancelled`; `expired` → `robot_unavailable`. Unknown correlation ids are ignored (logged to audit as `robot` actor with reason `unknown_correlation` on entity `robot`).
  - On visit transition to `cancelled` with an unacked-or-active command: send `{ type: "cancel", correlationId }`.
  - Transitions caused by robot messages use `actorType: "robot"`, `actorId: robotId`.
  - Illegal transitions from robot messages are caught (the transition service already wrote `rejected_transition`) and do not throw out of the listener.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/dispatch.test.ts
import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import type { GatewayDown } from "@oncare/contracts";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function fakeLink() {
  const sent: GatewayDown[] = [];
  return { sent, link: { send: (m: GatewayDown) => { sent.push(m); } } };
}

async function acceptedVisit(connect = true) {
  const ctx = await makeTestApp();
  const { sent, link } = fakeLink();
  if (connect) ctx.app.hub.attach(SEED_IDS.robot, link);
  const res = await ctx.app.inject({ method: "POST", url: "/visits", headers: auth(ctx.tokens.family), payload: { residentId: SEED_IDS.resident } });
  const visitId = res.json().visit.id as string;
  const state = () => ctx.db.select().from(t.visitSession).where(eq(t.visitSession.id, visitId)).get()!.state;
  return { ...ctx, sent, link, visitId, state };
}

describe("dispatch service", () => {
  test("visit accepted -> robot_command row + request_visit intent sent to the connected robot", async () => {
    const { db, sent, visitId } = await acceptedVisit();
    const cmd = db.select().from(t.robotCommand).where(eq(t.robotCommand.visitId, visitId)).get();
    expect(cmd).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "intent", intent: "request_visit", correlationId: visitId, payload: { locationId: SEED_IDS.roomLocation } });
    expect(new Date((sent[0] as any).expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  test("robot not connected: command is stored and flushed on attach", async () => {
    const { app, sent, link, visitId, state } = await acceptedVisit(false);
    expect(sent).toHaveLength(0);
    expect(state()).toBe("accepted");
    app.hub.attach(SEED_IDS.robot, link);
    expect(app.dispatch.flushPending(SEED_IDS.robot)).toBe(1);
    expect(sent[0]).toMatchObject({ type: "intent", correlationId: visitId });
  });

  test("ack accepted -> robot_en_route; state_event arrived -> awaiting_resident_consent", async () => {
    const { app, db, visitId, state } = await acceptedVisit();
    app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: visitId, result: "accepted" });
    expect(state()).toBe("robot_en_route");
    expect(db.select().from(t.robotCommand).where(eq(t.robotCommand.visitId, visitId)).get()?.result).toBe("accepted");
    app.hub.receive(SEED_IDS.robot, { type: "state_event", correlationId: visitId, at: new Date().toISOString(), event: "arrived" });
    expect(state()).toBe("awaiting_resident_consent");
    const last = db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, visitId)).all().at(-1);
    expect(last).toMatchObject({ actorType: "robot", actorId: SEED_IDS.robot });
  });

  test("ack expired or busy -> robot_unavailable with the ack result as reason", async () => {
    const { app, db, visitId, state } = await acceptedVisit();
    app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: visitId, result: "busy" });
    expect(state()).toBe("robot_unavailable");
    expect(db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, visitId)).all().at(-1)?.reason).toBe("busy");
  });

  test("navigation_failed and safety_stopped map to their visit states", async () => {
    const a = await acceptedVisit();
    a.app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: a.visitId, result: "accepted" });
    a.app.hub.receive(SEED_IDS.robot, { type: "state_event", correlationId: a.visitId, at: new Date().toISOString(), event: "navigation_failed" });
    expect(a.state()).toBe("navigation_failed");
    const b = await acceptedVisit();
    b.app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: b.visitId, result: "accepted" });
    b.app.hub.receive(SEED_IDS.robot, { type: "state_event", correlationId: b.visitId, at: new Date().toISOString(), event: "safety_stopped" });
    expect(b.state()).toBe("safety_stopped");
  });

  test("family cancel while the robot is en route sends a cancel message", async () => {
    const { app, tokens, sent, visitId, state } = await acceptedVisit();
    app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: visitId, result: "accepted" });
    await app.inject({ method: "POST", url: `/visits/${visitId}/cancel`, headers: auth(tokens.family) });
    expect(state()).toBe("cancelled");
    expect(sent.at(-1)).toEqual({ type: "cancel", correlationId: visitId });
    // the robot's own cancelled event afterwards does not throw or double-transition
    app.hub.receive(SEED_IDS.robot, { type: "state_event", correlationId: visitId, at: new Date().toISOString(), event: "cancelled" });
    expect(state()).toBe("cancelled");
  });

  test("a robot message with an unknown correlation id is ignored without throwing", async () => {
    const { app, state } = await acceptedVisit();
    expect(() => app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: "nope", result: "accepted" })).not.toThrow();
    expect(state()).toBe("accepted");
  });

  test("heartbeat is recorded on the hub status", async () => {
    const { app } = await acceptedVisit();
    app.hub.receive(SEED_IDS.robot, { type: "heartbeat", at: "2026-09-17T00:00:00.000Z", robotReady: true, adapter: "mock", pose: { x: 0, y: 0, yaw: 0 }, navState: "idle", estop: false, lift: "rest", battery: "unknown", activeCorrelationId: null, gatewayVersion: "0.0.1" });
    expect(app.hub.status(SEED_IDS.robot)).toMatchObject({ connected: true, lastHeartbeat: { robotReady: true } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/dispatch.test.ts`
Expected: FAIL — `app.hub` is undefined.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/gateway-hub.ts
import type { GatewayDown, GatewayUp, Heartbeat } from "@oncare/contracts";

export interface RobotLink { send(msg: GatewayDown): void }
export interface RobotStatus { connected: boolean; lastHeartbeat: Heartbeat | null; lastSeenAt: string | null }
type UpListener = (robotId: string, msg: GatewayUp) => void;

export class GatewayHub {
  private links = new Map<string, RobotLink>();
  private heartbeats = new Map<string, { hb: Heartbeat; at: string }>();
  private listeners = new Set<UpListener>();

  attach(robotId: string, link: RobotLink): void { this.links.set(robotId, link); }
  detach(robotId: string): void { this.links.delete(robotId); }

  send(robotId: string, msg: GatewayDown): boolean {
    const link = this.links.get(robotId);
    if (!link) return false;
    link.send(msg);
    return true;
  }

  recordHeartbeat(robotId: string, hb: Heartbeat, at: string): void { this.heartbeats.set(robotId, { hb, at }); }

  status(robotId: string): RobotStatus {
    const h = this.heartbeats.get(robotId);
    return { connected: this.links.has(robotId), lastHeartbeat: h?.hb ?? null, lastSeenAt: h?.at ?? null };
  }

  onUp(listener: UpListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  receive(robotId: string, msg: GatewayUp): void {
    if (msg.type === "heartbeat") this.recordHeartbeat(robotId, msg, new Date().toISOString());
    for (const l of this.listeners) l(robotId, msg);
  }
}
```

```ts
// apps/api/src/services/dispatch.ts
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { GatewayUp, Intent } from "@oncare/contracts";
import type { AuditEvent, VisitState } from "@oncare/core";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import type { GatewayHub } from "./gateway-hub";
import { TransitionError } from "./transitions";
import type { TransitionService } from "./visits";

const STATE_EVENT_TO_VISIT: Partial<Record<string, VisitState>> = {
  arrived: "awaiting_resident_consent",
  navigation_failed: "navigation_failed",
  safety_stopped: "safety_stopped",
  cancelled: "cancelled",
  expired: "robot_unavailable",
};

export function createDispatchService(db: Db, transitions: TransitionService, hub: GatewayHub,
  opts: { now?: () => Date; id?: () => string; intentTtlMs?: number } = {}) {
  const now = opts.now ?? (() => new Date());
  const id = opts.id ?? (() => `cmd_${randomUUID()}`);
  const ttl = opts.intentTtlMs ?? 120_000;

  function robotApply(robotId: string, visitId: string, to: VisitState, reason?: string) {
    try {
      transitions.apply({ entityType: "visit", entityId: visitId, to, actorType: "robot", actorId: robotId, ...(reason ? { reason } : {}) });
    } catch (e) {
      if (!(e instanceof TransitionError)) throw e; // rejected_transition already audited
    }
  }

  function onVisitAccepted(ev: AuditEvent) {
    const visit = db.select().from(t.visitSession).where(eq(t.visitSession.id, ev.entityId)).get();
    if (!visit?.robotId) return;
    const resident = db.select().from(t.resident).where(eq(t.resident.id, visit.residentId)).get();
    if (!resident) return;
    const issuedAt = now();
    const intent: Intent = {
      type: "intent", intent: "request_visit", correlationId: visit.id,
      expiresAt: new Date(issuedAt.getTime() + ttl).toISOString(), payload: { locationId: resident.roomLocationId },
    };
    db.insert(t.robotCommand).values({ id: id(), robotId: visit.robotId, visitId: visit.id, taskId: null, intent, issuedAt: issuedAt.toISOString(), expiresAt: intent.expiresAt, ackedAt: null, result: null }).run();
    hub.send(visit.robotId, intent);
  }

  function onVisitCancelled(ev: AuditEvent) {
    const cmd = db.select().from(t.robotCommand).where(eq(t.robotCommand.visitId, ev.entityId)).get();
    if (!cmd || cmd.result === "expired" || cmd.result === "rejected" || cmd.result === "busy") return;
    hub.send(cmd.robotId, { type: "cancel", correlationId: ev.entityId });
  }

  const unsubTransitions = transitions.subscribe((ev) => {
    if (ev.entityType !== "visit") return;
    if (ev.toState === "accepted") onVisitAccepted(ev);
    if (ev.toState === "cancelled") onVisitCancelled(ev);
  });

  function onUp(robotId: string, msg: GatewayUp) {
    if (msg.type === "heartbeat") return;
    const cmd = db.select().from(t.robotCommand).where(and(eq(t.robotCommand.robotId, robotId), eq(t.robotCommand.visitId, msg.correlationId))).get();
    if (!cmd?.visitId) return;
    if (msg.type === "ack") {
      db.update(t.robotCommand).set({ ackedAt: now().toISOString(), result: msg.result }).where(eq(t.robotCommand.id, cmd.id)).run();
      if (msg.result === "accepted") robotApply(robotId, cmd.visitId, "robot_en_route");
      else if (msg.result !== "duplicate") robotApply(robotId, cmd.visitId, "robot_unavailable", msg.result);
      return;
    }
    const to = STATE_EVENT_TO_VISIT[msg.event];
    if (!to) return;
    const visit = db.select().from(t.visitSession).where(eq(t.visitSession.id, cmd.visitId)).get();
    if (to === "cancelled" && visit?.state === "cancelled") return;
    robotApply(robotId, cmd.visitId, to, msg.event);
  }
  const unsubHub = hub.onUp(onUp);

  function flushPending(robotId: string): number {
    const nowIso = now().toISOString();
    const pending = db.select().from(t.robotCommand).where(and(eq(t.robotCommand.robotId, robotId), isNull(t.robotCommand.ackedAt))).all()
      .filter((c) => c.expiresAt > nowIso);
    let n = 0;
    for (const c of pending) if (hub.send(robotId, c.intent as Intent)) n++;
    return n;
  }

  return { flushPending, stop() { unsubTransitions(); unsubHub(); } };
}
```

In `apps/api/src/app.ts`: import `GatewayHub` and `createDispatchService`; after creating `transitions`, do `const hub = new GatewayHub(); app.decorate("hub", hub); app.decorate("dispatch", createDispatchService(opts.db, transitions, hub, opts.now ? { now: opts.now } : {}));` and extend the `FastifyInstance` module augmentation with `hub: GatewayHub; dispatch: ReturnType<typeof createDispatchService>`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/api/test/dispatch.test.ts && npx vitest run apps/api`
Expected: PASS (8 new tests); earlier API tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/gateway-hub.ts apps/api/src/services/dispatch.ts apps/api/src/app.ts apps/api/test/dispatch.test.ts
git commit -m "feat(api): gateway hub and dispatch service linking visit transitions to robot intents" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 4: `/gateway` WebSocket with robot-token auth, and `GET /robots/:id/status`

**Files:**
- Create: `apps/api/src/routes/gateway-ws.ts`
- Modify: `apps/api/src/app.ts` — register `@fastify/websocket` and `gatewayRoutes`
- Modify: `apps/api/package.json` — add devDependency `"ws": "^8.18.0"`, `"@types/ws": "^8.5.0"`
- Modify: `apps/api/test/helpers.ts` — add `listen()` helper returning a base URL for real socket tests
- Test: `apps/api/test/gateway-ws.test.ts`

**Interfaces:**
- Produces:
  ```
  WS  /gateway?token=<robotToken>     robot identity by verifying the token against robot.tokenHash
                                       on open: hub.attach(robotId, link); dispatch.flushPending(robotId)
                                       on message: parse JSON, GatewayUpSchema.safeParse; invalid -> send {type:"error", reason:"invalid_message"} and ignore
                                                   valid -> hub.receive(robotId, msg)
                                       on close: hub.detach(robotId)
                                       bad/missing token: close with code 4401 before attaching
  GET /robots/:id/status   staff       -> 200 { robotId, connected, lastHeartbeat, lastSeenAt } | 404
  // test/helpers.ts addition
  export async function listen(app: FastifyInstance): Promise<{ url: string; close: () => Promise<void> }>;  // listens on 127.0.0.1:0
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/gateway-ws.test.ts
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
function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => ws.once("message", (d) => resolve(JSON.parse(d.toString()))));
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
    await new Promise((r) => setTimeout(r, 50));
    const res = await app.inject({ method: "GET", url: `/robots/${SEED_IDS.robot}/status`, headers: auth(tokens.staff) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ robotId: SEED_IDS.robot, connected: true, lastHeartbeat: { robotReady: true } });
    ws.close();
    await closed(ws);
    await new Promise((r) => setTimeout(r, 50));
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
    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({ type: "intent", intent: "request_visit", correlationId: visitId });
    ws.close();
  });

  test("family cannot read robot status", async () => {
    const { app, tokens } = await makeTestApp();
    expect((await app.inject({ method: "GET", url: `/robots/${SEED_IDS.robot}/status`, headers: auth(tokens.family) })).statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm install --no-audit --no-fund` (after adding `ws` + `@types/ws` to `apps/api/package.json` devDependencies) then `npx vitest run apps/api/test/gateway-ws.test.ts`
Expected: FAIL — `listen` is not exported / socket upgrade fails with 404.

- [ ] **Step 3: Write the implementation**

Add to `apps/api/test/helpers.ts`:

```ts
export async function listen(app: FastifyInstance) {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => app.close() };
}
```
(import `type { FastifyInstance } from "fastify"` at the top.)

```ts
// apps/api/src/routes/gateway-ws.ts
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { GatewayUpSchema, type GatewayDown } from "@oncare/contracts";
import { requireRole } from "../auth/plugin";
import { verifySecret } from "../auth/password";
import type { Db } from "../db/client";
import * as t from "../db/schema";

export async function gatewayRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  async function robotIdForToken(token: string | undefined): Promise<string | null> {
    if (!token) return null;
    for (const r of db.select().from(t.robot).all()) {
      if (await verifySecret(token, r.tokenHash)) return r.id;
    }
    return null;
  }

  app.get("/gateway", { websocket: true }, async (socket, req) => {
    const { token } = req.query as { token?: string };
    const robotId = await robotIdForToken(token);
    if (!robotId) { socket.close(4401, "unauthorized"); return; }

    const link = { send: (msg: GatewayDown) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg)); } };
    app.hub.attach(robotId, link);
    app.dispatch.flushPending(robotId);

    socket.on("message", (raw) => {
      let parsed: unknown;
      try { parsed = JSON.parse(raw.toString()); } catch { socket.send(JSON.stringify({ type: "error", reason: "invalid_message" })); return; }
      const result = GatewayUpSchema.safeParse(parsed);
      if (!result.success) { socket.send(JSON.stringify({ type: "error", reason: "invalid_message" })); return; }
      app.hub.receive(robotId, result.data);
    });
    socket.on("close", () => { app.hub.detach(robotId); });
  });

  app.get("/robots/:id/status", { preHandler: requireRole("staff") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const robot = db.select().from(t.robot).where(eq(t.robot.id, id)).get();
    if (!robot) return reply.code(404).send({ error: "not_found" });
    return { robotId: id, ...app.hub.status(id) };
  });
}
```

In `apps/api/src/app.ts`: `import fastifyWebsocket from "@fastify/websocket"; import { gatewayRoutes } from "./routes/gateway-ws";` then `app.register(fastifyWebsocket); app.register(gatewayRoutes, { db: opts.db });` — the websocket plugin must be registered before any route with `{ websocket: true }`. Note: `@fastify/websocket` v11 handlers receive `(socket, req)` where `socket` is a `ws` WebSocket.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/api/test/gateway-ws.test.ts && npx vitest run apps/api`
Expected: PASS (5 new tests); earlier tests green. If the first test is flaky on the 50 ms waits, raise them to 100 ms — do not remove them.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/gateway-ws.ts apps/api/src/app.ts apps/api/package.json package-lock.json apps/api/test/helpers.ts apps/api/test/gateway-ws.test.ts
git commit -m "feat(api): /gateway websocket with robot token auth and staff robot status" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 5: `/events` WebSocket with per-identity filtering

**Files:**
- Create: `apps/api/src/routes/events-ws.ts`
- Modify: `apps/api/src/app.ts` — register `eventsRoutes`
- Test: `apps/api/test/events-ws.test.ts`

**Interfaces:**
- Produces:
  ```
  WS /events?token=<jwt>    verifies the JWT (family/staff/device); bad token -> close 4401
                            sends every AuditEvent from transitions.subscribe() as JSON, filtered:
                              staff  -> all events
                              family -> events whose entity (visit or task) has requesterId === principal.id
                              device -> events whose entity has residentId === principal.residentId
                            also sends {type:"hello", principal} once on open so clients can confirm identity
  ```
- Filtering looks the entity up by `entityType`/`entityId` at send time (visit_session or task_request). Events for `entityType` `robot`/`command` go to staff only.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/events-ws.test.ts
import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { listen, makeTestApp } from "./helpers";
import { SEED_IDS } from "../src/db/seed";
import * as t from "../src/db/schema";
import { hashSecret } from "../src/auth/password";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

function connect(url: string, token: string): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url.replace("http", "ws")}/events?token=${token}`);
    const messages: any[] = [];
    ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
    ws.once("open", () => resolve({ ws, messages }));
    ws.once("error", reject);
  });
}
const settle = () => new Promise((r) => setTimeout(r, 80));

describe("WS /events", () => {
  test("staff receives all visit transitions; family receives only its own; device only its resident's", async () => {
    const { app, db, tokens } = await makeTestApp();
    const srv = await listen(app); closers.push(srv.close);
    // second family user related to a second resident
    db.insert(t.resident).values({ id: "resident_demo_02", facilityId: SEED_IDS.facility, displayName: "Other", roomLocationId: SEED_IDS.roomLocation }).run();
    db.insert(t.user).values({ id: "family_demo_02", role: "family", username: "family2", displayName: "Other", passwordHash: await hashSecret("pw"), pinHash: null }).run();
    db.insert(t.familyRelationship).values({ id: "rel_2", userId: "family_demo_02", residentId: "resident_demo_02", label: "son", consentVideo: true, consentRobotVisit: true, consentItemDelivery: true }).run();
    const family2 = (await app.inject({ method: "POST", url: "/auth/login", payload: { username: "family2", password: "pw" } })).json().token;

    const staff = await connect(srv.url, tokens.staff);
    const fam1 = await connect(srv.url, tokens.family);
    const fam2 = await connect(srv.url, family2);
    const dev = await connect(srv.url, tokens.device);
    await settle();
    expect(staff.messages[0]).toMatchObject({ type: "hello" });

    await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } });
    await app.inject({ method: "POST", url: "/visits", headers: auth(family2), payload: { residentId: "resident_demo_02" } });
    await settle();

    const states = (m: any[]) => m.filter((x) => x.type !== "hello").map((x) => x.toState);
    expect(states(staff.messages)).toEqual(["awaiting_policy_or_staff", "accepted", "awaiting_policy_or_staff", "accepted"]);
    expect(states(fam1.messages)).toEqual(["awaiting_policy_or_staff", "accepted"]);
    expect(states(fam2.messages)).toEqual(["awaiting_policy_or_staff", "accepted"]);
    expect(fam1.messages.filter((x) => x.type !== "hello").every((x) => x.correlationId === fam1.messages[1].correlationId)).toBe(true);
    expect(states(dev.messages)).toEqual(["awaiting_policy_or_staff", "accepted"]);
    for (const c of [staff, fam1, fam2, dev]) c.ws.close();
  });

  test("bad token is closed with 4401", async () => {
    const { app } = await makeTestApp();
    const srv = await listen(app); closers.push(srv.close);
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${srv.url.replace("http", "ws")}/events?token=bad`);
      ws.once("close", (c) => resolve(c));
      ws.once("error", () => {});
    });
    expect(code).toBe(4401);
  });

  test("closing the socket unsubscribes (no send on a closed socket throws)", async () => {
    const { app, tokens } = await makeTestApp();
    const srv = await listen(app); closers.push(srv.close);
    const c = await connect(srv.url, tokens.staff);
    c.ws.close();
    await settle();
    await expect(app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } })).resolves.toMatchObject({ statusCode: 201 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/events-ws.test.ts`
Expected: FAIL — upgrade to `/events` is refused (404).

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/routes/events-ws.ts
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { AuditEvent } from "@oncare/core";
import type { Principal } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";

export async function eventsRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  function visibleTo(p: Principal, ev: AuditEvent): boolean {
    if (p.kind === "user" && p.role === "staff") return true;
    if (ev.entityType === "visit") {
      const v = db.select().from(t.visitSession).where(eq(t.visitSession.id, ev.entityId)).get();
      if (!v) return false;
      return p.kind === "device" ? v.residentId === p.residentId : v.requesterId === p.id;
    }
    if (ev.entityType === "task") {
      const task = db.select().from(t.taskRequest).where(eq(t.taskRequest.id, ev.entityId)).get();
      if (!task) return false;
      return p.kind === "device" ? task.residentId === p.residentId : task.requesterId === p.id;
    }
    return false;
  }

  app.get("/events", { websocket: true }, (socket, req) => {
    const { token } = req.query as { token?: string };
    let principal: Principal;
    try { principal = app.jwt.verify<Principal>(token ?? ""); } catch { socket.close(4401, "unauthorized"); return; }

    socket.send(JSON.stringify({ type: "hello", principal }));
    const unsubscribe = app.transitions.subscribe((ev) => {
      if (socket.readyState !== socket.OPEN) return;
      if (visibleTo(principal, ev)) socket.send(JSON.stringify(ev));
    });
    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
  });
}
```

In `apps/api/src/app.ts`: `import { eventsRoutes } from "./routes/events-ws";` and `app.register(eventsRoutes, { db: opts.db });` after the websocket plugin.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/api/test/events-ws.test.ts && npx vitest run apps/api`
Expected: PASS (3 new tests); earlier tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/events-ws.ts apps/api/src/app.ts apps/api/test/events-ws.test.ts
git commit -m "feat(api): /events websocket streaming audit events filtered per identity" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 6: Python gateway — message validation, MockRobotAdapter, pure GatewayCore

**Files:**
- Create: `robot_gateway/pyproject.toml`, `robot_gateway/gateway/__init__.py`, `robot_gateway/gateway/messages.py`, `robot_gateway/gateway/robot/__init__.py`, `robot_gateway/gateway/robot/base.py`, `robot_gateway/gateway/robot/mock.py`, `robot_gateway/gateway/core.py`
- Create: `robot_gateway/tests/conftest.py`, `robot_gateway/tests/test_messages.py`, `robot_gateway/tests/test_mock_adapter.py`, `robot_gateway/tests/test_core.py`
- Uses (read-only, generated in Plan 1 Task 4): `robot_gateway/schema/gateway-down.json`, `robot_gateway/schema/gateway-up.json`

**Interfaces:**
- Produces:
  ```python
  # gateway/messages.py
  class MessageError(ValueError): ...
  def validate_down(msg: dict) -> None      # raises MessageError
  def validate_up(msg: dict) -> None        # raises MessageError (used in tests to check what the core emits)

  # gateway/robot/base.py
  @dataclass(frozen=True) class NavResult: outcome: Literal["arrived", "navigation_failed", "cancelled"]; reason: str | None = None
  class RobotAdapter(Protocol):
      name: str                                     # "mock" | "navweb"
      def start_goto(self, location: dict) -> None  # non-blocking; location has x, y, yaw, id
      def poll(self, now_ms: int) -> NavResult | None
      def cancel(self) -> None
      def resume(self) -> None
      def safety_stop(self) -> None
      def state(self) -> dict                       # {"ready": bool, "pose": {...}|None, "navState": str, "estop": bool, "lift": str, "battery": float|"unknown"}

  # gateway/robot/mock.py
  class MockRobotAdapter(RobotAdapter):
      def __init__(self, travel_ms: int = 2000, ready: bool = True): ...
      def inject_failure(self, outcome: Literal["navigation_failed"], reason: str = "injected") -> None   # next goto fails at arrival time

  # gateway/core.py
  class GatewayCore:
      def __init__(self, adapter: RobotAdapter, now_ms: Callable[[], int], version: str = "0.0.1", disconnect_grace_ms: int = 10_000): ...
      def handle(self, msg: dict) -> list[dict]     # validated down message -> up messages to send
      def tick(self) -> list[dict]                  # poll adapter, expire, link check -> up messages
      def heartbeat(self) -> dict
      def on_connected(self) -> None
      def on_disconnected(self) -> None
      @property def active_correlation_id(self) -> str | None
  ```
- Core rules (each tested): `duplicate` ack for a seen `correlationId`; `expired` ack when `expiresAt` ≤ now; `busy` ack while another intent is active; `rejected` with reason `unknown_location` for an unapproved or unknown location id, `robot_not_ready` when the adapter reports not ready, `not_implemented` for `deliver_item` (Plan 5 adds it); on accept emit `ack accepted` and `state_event robot_en_route`; `tick()` turns adapter results into `state_event arrived|navigation_failed|cancelled` and clears the active intent; `cancel` for the active id calls `adapter.cancel()`; `stop` calls `adapter.safety_stop()`, emits `state_event safety_stopped` for an active intent, and further intents are `rejected` with reason `stopped` until a `resume` message arrives (`{ "type": "resume" }` — **add this variant to `GatewayDownSchema` in `packages/contracts/src/gateway.ts` as `ResumeSchema = z.object({ type: z.literal("resume") }).strict()`, add it to the union, re-run `npx tsx packages/contracts/scripts/emit-json-schema.ts`, and commit the regenerated JSON in this task**); disconnected longer than `disconnect_grace_ms` with an active intent → `adapter.cancel()`, emit `safety_stopped`, adapter left stopped.
- ISO timestamps: parse `expiresAt` with `datetime.fromisoformat` (Python 3.11+ accepts the `Z` suffix); emit `at` as `datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")`.

- [ ] **Step 1: Scaffold the package (config only)**

```toml
# robot_gateway/pyproject.toml
[project]
name = "oncare-gateway"
version = "0.0.1"
description = "OnCare Robot Gateway: translates cloud intents into robot actions on the Jetson"
requires-python = ">=3.12,<3.13"
dependencies = ["websockets>=13.0", "jsonschema>=4.23"]

[project.optional-dependencies]
dev = ["pytest>=8.0", "pytest-asyncio>=0.24"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["gateway"]

[tool.pytest.ini_options]
testpaths = ["tests"]
asyncio_mode = "auto"
markers = ["hardware: requires the physical robot; deselect with -m 'not hardware'"]
```

Setup on this machine (once): `cd robot_gateway && python -m venv .venv && .venv/Scripts/python -m pip install -e ".[dev]"`. Add `robot_gateway/.venv/` and `__pycache__/` and `.pytest_cache/` to the root `.gitignore`. Run tests from `robot_gateway/` with `.venv/Scripts/python -m pytest -m "not hardware"`.

```python
# robot_gateway/tests/conftest.py
import pytest

class FakeClock:
    def __init__(self, start_ms: int = 1_000_000):
        self.ms = start_ms
    def now_ms(self) -> int:
        return self.ms
    def advance(self, ms: int) -> None:
        self.ms += ms

@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()
```

- [ ] **Step 2: Write the failing tests**

```python
# robot_gateway/tests/test_messages.py
import pytest
from gateway.messages import MessageError, validate_down, validate_up

INTENT = {"type": "intent", "intent": "request_visit", "correlationId": "visit_1",
          "expiresAt": "2026-09-17T00:05:00.000Z", "payload": {"locationId": "room_demo_01"}}

def test_valid_intent_passes():
    validate_down(INTENT)

def test_raw_coordinates_are_rejected():
    with pytest.raises(MessageError):
        validate_down({**INTENT, "payload": {"x": 1.0, "y": 2.0, "yaw": 0.0}})

def test_unknown_type_is_rejected():
    with pytest.raises(MessageError):
        validate_down({"type": "joy", "vx": 1})

def test_resume_is_a_valid_down_message():
    validate_down({"type": "resume"})

def test_up_heartbeat_validates_and_unknown_event_fails():
    validate_up({"type": "heartbeat", "at": "2026-09-17T00:00:00.000Z", "robotReady": True, "adapter": "mock",
                 "pose": None, "navState": "idle", "estop": False, "lift": "unknown", "battery": "unknown",
                 "activeCorrelationId": None, "gatewayVersion": "0.0.1"})
    with pytest.raises(MessageError):
        validate_up({"type": "state_event", "correlationId": "c", "at": "2026-09-17T00:00:00.000Z", "event": "teleported"})
```

```python
# robot_gateway/tests/test_mock_adapter.py
from gateway.robot.mock import MockRobotAdapter

LOC = {"id": "room_demo_01", "x": 1.0, "y": 2.0, "yaw": 0.0}

def test_arrives_after_travel_time(clock):
    a = MockRobotAdapter(travel_ms=2000)
    a.start_goto(LOC)
    assert a.poll(clock.now_ms()) is None
    assert a.state()["navState"] == "navigating"
    clock.advance(1999)
    assert a.poll(clock.now_ms()) is None
    clock.advance(1)
    r = a.poll(clock.now_ms())
    assert r is not None and r.outcome == "arrived"
    assert a.state()["navState"] == "idle" and a.state()["pose"] == {"x": 1.0, "y": 2.0, "yaw": 0.0}

def test_injected_failure(clock):
    a = MockRobotAdapter(travel_ms=100)
    a.inject_failure("navigation_failed", reason="blocked")
    a.start_goto(LOC)
    clock.advance(100)
    r = a.poll(clock.now_ms())
    assert r is not None and r.outcome == "navigation_failed" and r.reason == "blocked"

def test_cancel_reports_cancelled_once(clock):
    a = MockRobotAdapter(travel_ms=5000)
    a.start_goto(LOC)
    a.cancel()
    r = a.poll(clock.now_ms())
    assert r is not None and r.outcome == "cancelled"
    assert a.poll(clock.now_ms()) is None

def test_safety_stop_makes_robot_not_ready_until_resume(clock):
    a = MockRobotAdapter()
    a.safety_stop()
    assert a.state()["estop"] is True and a.state()["ready"] is False
    a.resume()
    assert a.state()["estop"] is False and a.state()["ready"] is True

def test_poll_without_goal_is_none(clock):
    assert MockRobotAdapter().poll(clock.now_ms()) is None
```

```python
# robot_gateway/tests/test_core.py
import pytest
from gateway.core import GatewayCore
from gateway.messages import validate_up
from gateway.robot.mock import MockRobotAdapter

LOCATIONS = {"type": "locations", "locations": [
    {"id": "room_demo_01", "name": "Demo room", "kind": "resident_room", "x": 1.0, "y": 2.0, "yaw": 0.0, "approved": True},
    {"id": "old_room", "name": "Old", "kind": "resident_room", "x": 0.0, "y": 0.0, "yaw": 0.0, "approved": False},
]}

def intent(corr="visit_1", loc="room_demo_01", expires="2099-01-01T00:00:00.000Z", kind="request_visit"):
    return {"type": "intent", "intent": kind, "correlationId": corr, "expiresAt": expires, "payload": {"locationId": loc}}

@pytest.fixture
def core(clock):
    adapter = MockRobotAdapter(travel_ms=1000)
    c = GatewayCore(adapter, now_ms=clock.now_ms)
    c.on_connected()
    assert c.handle(LOCATIONS) == []
    return c

def types(msgs):
    return [(m["type"], m.get("result") or m.get("event")) for m in msgs]

def test_accepts_intent_and_reports_en_route_then_arrived(core, clock):
    out = core.handle(intent())
    for m in out: validate_up(m)
    assert types(out) == [("ack", "accepted"), ("state_event", "robot_en_route")]
    assert core.active_correlation_id == "visit_1"
    assert core.tick() == []
    clock.advance(1000)
    out = core.tick()
    assert types(out) == [("state_event", "arrived")]
    assert out[0]["correlationId"] == "visit_1"
    assert core.active_correlation_id is None

def test_duplicate_correlation_is_acked_duplicate_and_not_re_executed(core, clock):
    core.handle(intent())
    clock.advance(1000); core.tick()
    out = core.handle(intent())
    assert types(out) == [("ack", "duplicate")]
    assert core.active_correlation_id is None

def test_expired_intent(core):
    out = core.handle(intent(expires="2000-01-01T00:00:00.000Z"))
    assert types(out) == [("ack", "expired")]

def test_busy_while_active(core):
    core.handle(intent("visit_1"))
    out = core.handle(intent("visit_2"))
    assert types(out) == [("ack", "busy")]

def test_unknown_or_unapproved_location_is_rejected(core):
    assert core.handle(intent(loc="nowhere"))[0] == {"type": "ack", "correlationId": "visit_1", "result": "rejected", "reason": "unknown_location"}
    assert core.handle(intent("visit_2", loc="old_room"))[0]["reason"] == "unknown_location"

def test_deliver_item_not_implemented_yet(core):
    msg = {"type": "intent", "intent": "deliver_item", "correlationId": "task_1", "expiresAt": "2099-01-01T00:00:00.000Z",
           "payload": {"itemId": "water_bottle", "pickupLocationId": "room_demo_01", "destinationLocationId": "room_demo_01", "standbyLocationId": "room_demo_01", "mode": "tray"}}
    out = core.handle(msg)
    assert out[0]["result"] == "rejected" and out[0]["reason"] == "not_implemented"

def test_navigation_failure_is_reported(clock):
    adapter = MockRobotAdapter(travel_ms=100)
    adapter.inject_failure("navigation_failed", reason="blocked")
    c = GatewayCore(adapter, now_ms=clock.now_ms); c.on_connected(); c.handle(LOCATIONS)
    c.handle(intent())
    clock.advance(100)
    out = c.tick()
    assert types(out) == [("state_event", "navigation_failed")] and out[0]["detail"] == {"reason": "blocked"}

def test_cancel_active_intent(core):
    core.handle(intent())
    assert core.handle({"type": "cancel", "correlationId": "visit_1"}) == []
    out = core.tick()
    assert types(out) == [("state_event", "cancelled")]
    assert core.active_correlation_id is None

def test_cancel_unknown_id_is_ignored(core):
    core.handle(intent())
    assert core.handle({"type": "cancel", "correlationId": "other"}) == []
    assert core.active_correlation_id == "visit_1"

def test_stop_reports_safety_stopped_and_blocks_until_resume(core):
    core.handle(intent())
    out = core.handle({"type": "stop", "reason": "staff"})
    assert types(out) == [("state_event", "safety_stopped")]
    assert core.heartbeat()["robotReady"] is False and core.heartbeat()["estop"] is True
    assert core.handle(intent("visit_2"))[0] == {"type": "ack", "correlationId": "visit_2", "result": "rejected", "reason": "stopped"}
    assert core.handle({"type": "resume"}) == []
    assert core.heartbeat()["robotReady"] is True
    assert types(core.handle(intent("visit_3"))) == [("ack", "accepted"), ("state_event", "robot_en_route")]

def test_disconnect_longer_than_grace_cancels_and_safety_stops(core, clock):
    core.handle(intent())
    core.on_disconnected()
    clock.advance(9_999)
    assert core.tick() == []
    clock.advance(1)
    out = core.tick()
    assert types(out) == [("state_event", "safety_stopped")]
    assert core.active_correlation_id is None
    core.on_connected()
    assert core.heartbeat()["robotReady"] is False   # stays stopped until an explicit resume

def test_robot_not_ready_rejects(clock):
    c = GatewayCore(MockRobotAdapter(ready=False), now_ms=clock.now_ms); c.on_connected(); c.handle(LOCATIONS)
    assert c.handle(intent())[0]["reason"] == "robot_not_ready"

def test_heartbeat_shape(core):
    hb = core.heartbeat()
    validate_up(hb)
    assert hb["adapter"] == "mock" and hb["activeCorrelationId"] is None and hb["gatewayVersion"] == "0.0.1"

def test_invalid_down_message_raises(core):
    from gateway.messages import MessageError
    with pytest.raises(MessageError):
        core.handle({"type": "joy", "vx": 1.0})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd robot_gateway && .venv/Scripts/python -m pytest -m "not hardware" -q`
Expected: collection errors — `ModuleNotFoundError: No module named 'gateway'`.

- [ ] **Step 4: Write the implementation**

First, the contracts change: in `packages/contracts/src/gateway.ts` add `export const ResumeSchema = z.object({ type: z.literal("resume") }).strict();` and include it in `GatewayDownSchema`'s union; run `npx tsx packages/contracts/scripts/emit-json-schema.ts`; run `npx vitest run packages/contracts`.

```python
# robot_gateway/gateway/__init__.py
"""OnCare Robot Gateway."""
__version__ = "0.0.1"
```

```python
# robot_gateway/gateway/messages.py
"""Validate cloud <-> gateway messages against the JSON Schema emitted from packages/contracts."""
import json
from pathlib import Path
from jsonschema import Draft7Validator

SCHEMA_DIR = Path(__file__).resolve().parent.parent / "schema"

class MessageError(ValueError):
    pass

def _load(name: str) -> Draft7Validator:
    with open(SCHEMA_DIR / name, encoding="utf-8") as f:
        return Draft7Validator(json.load(f))

_DOWN = _load("gateway-down.json")
_UP = _load("gateway-up.json")

def _check(validator: Draft7Validator, msg: dict) -> None:
    errors = sorted(validator.iter_errors(msg), key=lambda e: list(e.path))
    if errors:
        raise MessageError("; ".join(e.message for e in errors[:3]))

def validate_down(msg: dict) -> None:
    _check(_DOWN, msg)

def validate_up(msg: dict) -> None:
    _check(_UP, msg)
```

```python
# robot_gateway/gateway/robot/__init__.py
```

```python
# robot_gateway/gateway/robot/base.py
from dataclasses import dataclass
from typing import Literal, Protocol

@dataclass(frozen=True)
class NavResult:
    outcome: Literal["arrived", "navigation_failed", "cancelled"]
    reason: str | None = None

class RobotAdapter(Protocol):
    name: str
    def start_goto(self, location: dict) -> None: ...
    def poll(self, now_ms: int) -> NavResult | None: ...
    def cancel(self) -> None: ...
    def resume(self) -> None: ...
    def safety_stop(self) -> None: ...
    def state(self) -> dict: ...
```

```python
# robot_gateway/gateway/robot/mock.py
"""Simulated robot. Clearly labelled: every heartbeat says adapter="mock"."""
from typing import Literal
from .base import NavResult, RobotAdapter

class MockRobotAdapter(RobotAdapter):
    name = "mock"

    def __init__(self, travel_ms: int = 2000, ready: bool = True):
        self.travel_ms = travel_ms
        self._ready = ready
        self._estop = False
        self._pose: dict | None = {"x": 0.0, "y": 0.0, "yaw": 0.0}
        self._goal: dict | None = None
        self._started_ms: int | None = None
        self._pending: NavResult | None = None
        self._failure: NavResult | None = None

    def inject_failure(self, outcome: Literal["navigation_failed"], reason: str = "injected") -> None:
        self._failure = NavResult(outcome, reason)

    def start_goto(self, location: dict) -> None:
        self._goal = location
        self._started_ms = None
        self._pending = None

    def poll(self, now_ms: int) -> NavResult | None:
        if self._pending is not None:
            r, self._pending = self._pending, None
            self._goal = None
            return r
        if self._goal is None:
            return None
        if self._started_ms is None:
            self._started_ms = now_ms
        if now_ms - self._started_ms < self.travel_ms:
            return None
        goal, self._goal = self._goal, None
        if self._failure is not None:
            f, self._failure = self._failure, None
            return f
        self._pose = {"x": float(goal["x"]), "y": float(goal["y"]), "yaw": float(goal["yaw"])}
        return NavResult("arrived")

    def cancel(self) -> None:
        if self._goal is not None:
            self._pending = NavResult("cancelled")

    def resume(self) -> None:
        self._estop = False
        self._ready = True

    def safety_stop(self) -> None:
        self._estop = True
        self._ready = False
        self._goal = None
        self._pending = None

    def state(self) -> dict:
        return {"ready": self._ready and not self._estop, "pose": self._pose,
                "navState": "navigating" if self._goal is not None else "idle",
                "estop": self._estop, "lift": "unknown", "battery": "unknown"}
```

```python
# robot_gateway/gateway/core.py
"""Pure gateway logic: no sockets, no clocks of its own. The runner feeds it messages and ticks."""
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Callable
from .messages import validate_down
from .robot.base import RobotAdapter

def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

def _parse_iso_ms(s: str) -> int:
    return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)

class GatewayCore:
    def __init__(self, adapter: RobotAdapter, now_ms: Callable[[], int], version: str = "0.0.1", disconnect_grace_ms: int = 10_000):
        self.adapter = adapter
        self.now_ms = now_ms
        self.version = version
        self.disconnect_grace_ms = disconnect_grace_ms
        self.locations: dict[str, dict] = {}
        self._active: dict | None = None            # {"correlationId": str}
        self._seen: OrderedDict[str, None] = OrderedDict()
        self._stopped = False
        self._disconnected_at: int | None = None

    # ---- lifecycle -------------------------------------------------------
    def on_connected(self) -> None:
        self._disconnected_at = None

    def on_disconnected(self) -> None:
        if self._disconnected_at is None:
            self._disconnected_at = self.now_ms()

    @property
    def active_correlation_id(self) -> str | None:
        return self._active["correlationId"] if self._active else None

    # ---- messages ----------------------------------------------------------
    def handle(self, msg: dict) -> list[dict]:
        validate_down(msg)
        t = msg["type"]
        if t == "locations":
            self.locations = {l["id"]: l for l in msg["locations"] if l["approved"]}
            return []
        if t == "intent":
            return self._handle_intent(msg)
        if t == "cancel":
            if self._active and self._active["correlationId"] == msg["correlationId"]:
                self.adapter.cancel()
            return []
        if t == "stop":
            self.adapter.safety_stop()
            self._stopped = True
            if self._active:
                corr = self._active["correlationId"]
                self._active = None
                return [self._state_event(corr, "safety_stopped", {"reason": msg["reason"]})]
            return []
        if t == "resume":
            self._stopped = False
            self.adapter.resume()
            return []
        if t == "staff_event":
            return []   # Plan 5 (tray mode) consumes these
        return []

    def _handle_intent(self, msg: dict) -> list[dict]:
        corr = msg["correlationId"]
        ack = lambda result, reason=None: {"type": "ack", "correlationId": corr, "result": result, **({"reason": reason} if reason else {})}
        if corr in self._seen:
            return [ack("duplicate")]
        if _parse_iso_ms(msg["expiresAt"]) <= self.now_ms():
            return [ack("expired")]
        if self._active is not None:
            return [ack("busy")]
        if self._stopped:
            return [ack("rejected", "stopped")]
        if msg["intent"] == "deliver_item":
            return [ack("rejected", "not_implemented")]
        loc = self.locations.get(msg["payload"]["locationId"])
        if loc is None:
            return [ack("rejected", "unknown_location")]
        if not self.adapter.state()["ready"]:
            return [ack("rejected", "robot_not_ready")]
        self._remember(corr)
        self.adapter.start_goto(loc)
        self._active = {"correlationId": corr}
        return [ack("accepted"), self._state_event(corr, "robot_en_route")]

    def _remember(self, corr: str) -> None:
        self._seen[corr] = None
        while len(self._seen) > 1000:
            self._seen.popitem(last=False)

    # ---- periodic ------------------------------------------------------------
    def tick(self) -> list[dict]:
        out: list[dict] = []
        if self._disconnected_at is not None and self._active is not None \
                and self.now_ms() - self._disconnected_at > self.disconnect_grace_ms:
            self.adapter.cancel()
            self.adapter.safety_stop()
            self._stopped = True
            corr = self._active["correlationId"]
            self._active = None
            out.append(self._state_event(corr, "safety_stopped", {"reason": "link_lost"}))
            return out
        if self._active is None:
            return out
        result = self.adapter.poll(self.now_ms())
        if result is None:
            return out
        corr = self._active["correlationId"]
        self._active = None
        detail = {"reason": result.reason} if result.reason else None
        out.append(self._state_event(corr, result.outcome, detail))
        return out

    def heartbeat(self) -> dict:
        s = self.adapter.state()
        return {"type": "heartbeat", "at": _iso_now(), "robotReady": bool(s["ready"]) and not self._stopped,
                "adapter": self.adapter.name, "pose": s["pose"], "navState": s["navState"], "estop": bool(s["estop"]) or self._stopped,
                "lift": s["lift"], "battery": s["battery"], "activeCorrelationId": self.active_correlation_id, "gatewayVersion": self.version}

    def _state_event(self, corr: str, event: str, detail: dict | None = None) -> dict:
        m = {"type": "state_event", "correlationId": corr, "at": _iso_now(), "event": event}
        if detail:
            m["detail"] = detail
        return m
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd robot_gateway && .venv/Scripts/python -m pytest -m "not hardware" -q` and, from the repo root, `npx vitest run packages/contracts`
Expected: all Python tests PASS (5 + 5 + 14), contracts tests PASS with the `resume` variant.

- [ ] **Step 6: Commit**

```bash
git add robot_gateway/pyproject.toml robot_gateway/gateway robot_gateway/tests robot_gateway/schema packages/contracts/src/gateway.ts .gitignore
git commit -m "feat(gateway): message validation, mock robot adapter, pure gateway core with safety rules" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 7: Python gateway runner — WebSocket client, heartbeat, reconnect, config, entry point

**Files:**
- Create: `robot_gateway/gateway/config.py`, `robot_gateway/gateway/runner.py`, `robot_gateway/gateway/__main__.py`, `robot_gateway/config.example.toml`
- Test: `robot_gateway/tests/test_runner.py`

**Interfaces:**
- Produces:
  ```python
  # gateway/config.py
  @dataclass(frozen=True) class Config: api_url: str; robot_token: str; adapter: Literal["mock", "navweb"]; heartbeat_ms: int = 1000; tick_ms: int = 250; mock_travel_ms: int = 2000
  def load_config(path: str | None = None) -> Config     # TOML file, then env overrides ONCARE_API_URL, ONCARE_ROBOT_TOKEN, ROBOT_ADAPTER
  # gateway/runner.py
  class GatewayRunner:
      def __init__(self, core: GatewayCore, api_url: str, robot_token: str, heartbeat_ms: int = 1000, tick_ms: int = 250, reconnect_min_s: float = 1.0, reconnect_max_s: float = 10.0): ...
      async def run(self, stop: asyncio.Event) -> None    # connect loop; exits when stop is set
  ```
- Behaviour: connects to `f"{api_url}/gateway?token={robot_token}"` (`ws://` or `wss://`); on open calls `core.on_connected()` and sends a heartbeat immediately; three concurrent loops per connection: receive (JSON → `core.handle` → send each reply; `MessageError` → log and continue), tick (`core.tick()` every `tick_ms`, send results), heartbeat (`core.heartbeat()` every `heartbeat_ms`). On close/error: `core.on_disconnected()`, keep calling `core.tick()` every `tick_ms` while disconnected (so the 10 s safe-stop fires without a socket) and queue any messages it produces; reconnect with exponential backoff between `reconnect_min_s` and `reconnect_max_s`; on reconnect flush the queue first. Logging via `logging.getLogger("gateway")`.

- [ ] **Step 1: Write the failing test**

```python
# robot_gateway/tests/test_runner.py
import asyncio, json, time
import pytest
import websockets
from gateway.core import GatewayCore
from gateway.robot.mock import MockRobotAdapter
from gateway.runner import GatewayRunner

LOCATIONS = {"type": "locations", "locations": [{"id": "room_demo_01", "name": "Demo room", "kind": "resident_room", "x": 1.0, "y": 2.0, "yaw": 0.0, "approved": True}]}

class FakeApi:
    """Minimal stand-in for the API's /gateway endpoint."""
    def __init__(self):
        self.received: list[dict] = []
        self.connections = 0
        self.server = None
        self.port = 0
        self._conn = None

    async def start(self):
        self.server = await websockets.serve(self._handler, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]

    async def _handler(self, ws):
        self.connections += 1
        self._conn = ws
        try:
            async for raw in ws:
                self.received.append(json.loads(raw))
        except websockets.ConnectionClosed:
            pass

    async def send(self, msg: dict):
        await self._conn.send(json.dumps(msg))

    async def drop(self):
        await self._conn.close()

    async def stop(self):
        self.server.close()
        await self.server.wait_closed()

async def wait_for(pred, timeout=3.0):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        if pred():
            return True
        await asyncio.sleep(0.02)
    return False

@pytest.fixture
async def api():
    a = FakeApi(); await a.start()
    yield a
    await a.stop()

def make_runner(api, travel_ms=200):
    core = GatewayCore(MockRobotAdapter(travel_ms=travel_ms), now_ms=lambda: int(time.monotonic() * 1000), disconnect_grace_ms=300)
    runner = GatewayRunner(core, api_url=f"ws://127.0.0.1:{api.port}", robot_token="robot-demo-token", heartbeat_ms=100, tick_ms=20, reconnect_min_s=0.05, reconnect_max_s=0.1)
    return core, runner

async def test_connects_heartbeats_and_executes_an_intent(api):
    core, runner = make_runner(api)
    stop = asyncio.Event()
    task = asyncio.create_task(runner.run(stop))
    assert await wait_for(lambda: any(m["type"] == "heartbeat" for m in api.received))
    await api.send(LOCATIONS)
    await api.send({"type": "intent", "intent": "request_visit", "correlationId": "visit_1", "expiresAt": "2099-01-01T00:00:00.000Z", "payload": {"locationId": "room_demo_01"}})
    assert await wait_for(lambda: any(m.get("event") == "arrived" for m in api.received))
    kinds = [(m["type"], m.get("result") or m.get("event")) for m in api.received if m["type"] != "heartbeat"]
    assert kinds == [("ack", "accepted"), ("state_event", "robot_en_route"), ("state_event", "arrived")]
    stop.set(); await task

async def test_reconnects_after_drop_and_flushes_queued_messages(api):
    core, runner = make_runner(api, travel_ms=5000)
    stop = asyncio.Event()
    task = asyncio.create_task(runner.run(stop))
    assert await wait_for(lambda: api.connections == 1 and api.received)
    await api.send(LOCATIONS)
    await api.send({"type": "intent", "intent": "request_visit", "correlationId": "visit_2", "expiresAt": "2099-01-01T00:00:00.000Z", "payload": {"locationId": "room_demo_01"}})
    assert await wait_for(lambda: any(m.get("event") == "robot_en_route" for m in api.received))
    await api.drop()
    # link lost longer than the 300 ms grace: the core safety-stops while offline, and the event arrives after reconnect
    assert await wait_for(lambda: api.connections == 2, timeout=5.0)
    assert await wait_for(lambda: any(m.get("event") == "safety_stopped" for m in api.received), timeout=5.0)
    assert core.active_correlation_id is None
    assert await wait_for(lambda: any(m["type"] == "heartbeat" and m["robotReady"] is False for m in api.received[-5:]))
    stop.set(); await task

async def test_invalid_message_from_api_is_ignored(api):
    core, runner = make_runner(api)
    stop = asyncio.Event()
    task = asyncio.create_task(runner.run(stop))
    assert await wait_for(lambda: api.received)
    await api.send({"type": "joy", "vx": 1})
    await api.send("not-a-dict") if False else None
    await asyncio.sleep(0.2)
    assert all(m["type"] in ("heartbeat",) for m in api.received)
    stop.set(); await task
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd robot_gateway && .venv/Scripts/python -m pytest tests/test_runner.py -q`
Expected: `ModuleNotFoundError: No module named 'gateway.runner'`.

- [ ] **Step 3: Write the implementation**

```python
# robot_gateway/gateway/config.py
import os, tomllib
from dataclasses import dataclass
from typing import Literal

@dataclass(frozen=True)
class Config:
    api_url: str
    robot_token: str
    adapter: Literal["mock", "navweb"] = "mock"
    heartbeat_ms: int = 1000
    tick_ms: int = 250
    mock_travel_ms: int = 2000

def load_config(path: str | None = None) -> Config:
    data: dict = {}
    if path:
        with open(path, "rb") as f:
            data = tomllib.load(f)
    api_url = os.environ.get("ONCARE_API_URL", data.get("api_url", "ws://127.0.0.1:3000"))
    token = os.environ.get("ONCARE_ROBOT_TOKEN", data.get("robot_token", ""))
    adapter = os.environ.get("ROBOT_ADAPTER", data.get("adapter", "mock"))
    if adapter not in ("mock", "navweb"):
        raise ValueError(f"unknown adapter {adapter!r}")
    if not token:
        raise ValueError("robot_token is required (config file or ONCARE_ROBOT_TOKEN)")
    return Config(api_url=api_url, robot_token=token, adapter=adapter,
                  heartbeat_ms=int(data.get("heartbeat_ms", 1000)), tick_ms=int(data.get("tick_ms", 250)),
                  mock_travel_ms=int(data.get("mock_travel_ms", 2000)))
```

```toml
# robot_gateway/config.example.toml
# Copy to config.toml (git-ignored) and fill in. Never commit a real token.
api_url = "ws://127.0.0.1:3000"
robot_token = "replace_me"
adapter = "mock"          # "mock" on a dev machine, "navweb" on the Jetson (Plan 6)
heartbeat_ms = 1000
tick_ms = 250
mock_travel_ms = 2000
```
Add `robot_gateway/config.toml` to the root `.gitignore`.

```python
# robot_gateway/gateway/runner.py
import asyncio, json, logging, random
import websockets
from websockets.exceptions import ConnectionClosed
from .core import GatewayCore
from .messages import MessageError

log = logging.getLogger("gateway")

class GatewayRunner:
    def __init__(self, core: GatewayCore, api_url: str, robot_token: str, heartbeat_ms: int = 1000, tick_ms: int = 250,
                 reconnect_min_s: float = 1.0, reconnect_max_s: float = 10.0):
        self.core = core
        self.url = f"{api_url.rstrip('/')}/gateway?token={robot_token}"
        self.heartbeat_s = heartbeat_ms / 1000
        self.tick_s = tick_ms / 1000
        self.reconnect_min_s = reconnect_min_s
        self.reconnect_max_s = reconnect_max_s
        self._queue: list[dict] = []

    async def run(self, stop: asyncio.Event) -> None:
        backoff = self.reconnect_min_s
        while not stop.is_set():
            try:
                async with websockets.connect(self.url, open_timeout=5) as ws:
                    backoff = self.reconnect_min_s
                    self.core.on_connected()
                    log.info("connected to %s", self.url.split("?")[0])
                    await self._flush(ws)
                    await ws.send(json.dumps(self.core.heartbeat()))
                    await self._session(ws, stop)
            except (OSError, ConnectionClosed, asyncio.TimeoutError) as e:
                log.warning("link down: %s", e)
            if stop.is_set():
                return
            self.core.on_disconnected()
            await self._offline_wait(stop, backoff)
            backoff = min(self.reconnect_max_s, backoff * 2)

    async def _session(self, ws, stop: asyncio.Event) -> None:
        async def recv():
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                    if not isinstance(msg, dict):
                        raise MessageError("not an object")
                    for out in self.core.handle(msg):
                        await ws.send(json.dumps(out))
                except (MessageError, json.JSONDecodeError) as e:
                    log.warning("ignored invalid message: %s", e)
        async def tick():
            while True:
                for out in self.core.tick():
                    await ws.send(json.dumps(out))
                await asyncio.sleep(self.tick_s)
        async def heartbeat():
            while True:
                await asyncio.sleep(self.heartbeat_s)
                await ws.send(json.dumps(self.core.heartbeat()))
        async def stopper():
            await stop.wait()
            await ws.close()
        tasks = [asyncio.create_task(c()) for c in (recv, tick, heartbeat, stopper)]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for d in done:
                d.result()   # re-raise ConnectionClosed etc.
        finally:
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _offline_wait(self, stop: asyncio.Event, seconds: float) -> None:
        """Keep ticking the core while offline so the disconnect grace timer can fire."""
        deadline = asyncio.get_event_loop().time() + seconds + random.uniform(0, seconds * 0.2)
        while not stop.is_set() and asyncio.get_event_loop().time() < deadline:
            self._queue.extend(self.core.tick())
            await asyncio.sleep(self.tick_s)

    async def _flush(self, ws) -> None:
        while self._queue:
            await ws.send(json.dumps(self._queue.pop(0)))
```

```python
# robot_gateway/gateway/__main__.py
import asyncio, logging, signal, sys, time
from .config import load_config
from .core import GatewayCore
from .robot.mock import MockRobotAdapter
from .runner import GatewayRunner
from . import __version__

def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    path = (argv or sys.argv[1:])[0] if (argv or sys.argv[1:]) else None
    cfg = load_config(path)
    if cfg.adapter == "mock":
        adapter = MockRobotAdapter(travel_ms=cfg.mock_travel_ms)
        logging.getLogger("gateway").warning("SIMULATED ROBOT: adapter=mock")
    else:
        raise SystemExit("navweb adapter arrives in Plan 6")
    core = GatewayCore(adapter, now_ms=lambda: int(time.monotonic() * 1000), version=__version__)
    runner = GatewayRunner(core, cfg.api_url, cfg.robot_token, cfg.heartbeat_ms, cfg.tick_ms)
    stop = asyncio.Event()
    async def _run():
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, stop.set)
            except NotImplementedError:   # Windows
                pass
        await runner.run(stop)
    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd robot_gateway && .venv/Scripts/python -m pytest -m "not hardware" -q`
Expected: all Python tests PASS including the 3 runner tests (they use real local sockets; allow up to ~10 s).

- [ ] **Step 5: Manual smoke (mock gateway against the real API)**

In one shell from the repo root: `npm run dev -w @oncare/api`. In another: `cd robot_gateway && ONCARE_ROBOT_TOKEN=robot-demo-token .venv/Scripts/python -m gateway`. Expected log lines: `SIMULATED ROBOT: adapter=mock` then `connected to ws://127.0.0.1:3000/gateway`. Stop both.

- [ ] **Step 6: Commit**

```bash
git add robot_gateway/gateway/config.py robot_gateway/gateway/runner.py robot_gateway/gateway/__main__.py robot_gateway/config.example.toml robot_gateway/tests/test_runner.py .gitignore
git commit -m "feat(gateway): websocket runner with heartbeat, reconnect and offline safe-stop" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 8: End-to-end visit test through the API with a scripted gateway client

**Files:**
- Test: `apps/api/test/e2e-visit.test.ts`

**Interfaces:**
- Consumes everything from Tasks 1–5. No production code changes expected; if the test exposes a defect, fix it in the file that owns the behaviour and mention it in the report.

- [ ] **Step 1: Write the test**

```ts
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
const settle = () => new Promise((r) => setTimeout(r, 80));

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
    await settle(); await settle();
    const state = () => db.select().from(t.visitSession).where(eq(t.visitSession.id, visitId)).get()!.state;
    expect(state()).toBe("awaiting_resident_consent");
    // 3-4. iPad shows the incoming call; resident answers with one tap
    expect((await app.inject({ method: "GET", url: `/visits/${visitId}`, headers: auth(tokens.device) })).json().visit.state).toBe("awaiting_resident_consent");
    expect((await app.inject({ method: "POST", url: `/visits/${visitId}/answer`, headers: auth(tokens.device) })).json().visit.state).toBe("connecting");
    // 5. call connects (LiveKit in Plan 4; the client reports it here)
    expect((await app.inject({ method: "POST", url: `/visits/${visitId}/connected`, headers: auth(tokens.family) })).json().visit.state).toBe("active");
    expect((await app.inject({ method: "POST", url: `/visits/${visitId}/end`, headers: auth(tokens.family) })).json().visit.state).toBe("completed");
    await settle();

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
      const m = JSON.parse(raw.toString()); gwMessages.push(m);
      if (m.type === "intent") ws.send(JSON.stringify({ type: "ack", correlationId: m.correlationId, result: "accepted" }));
      if (m.type === "cancel") ws.send(JSON.stringify({ type: "state_event", correlationId: m.correlationId, at: new Date().toISOString(), event: "cancelled" }));
    });
    await new Promise((r) => ws.once("open", r));
    const visitId = (await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } })).json().visit.id;
    await settle();
    expect((await app.inject({ method: "POST", url: `/visits/${visitId}/cancel`, headers: auth(tokens.family) })).json().visit.state).toBe("cancelled");
    await settle();
    expect(gwMessages.map((m) => m.type)).toEqual(["intent", "cancel"]);
    expect(db.select().from(t.visitSession).where(eq(t.visitSession.id, visitId)).get()?.state).toBe("cancelled");
    ws.close();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run apps/api/test/e2e-visit.test.ts`
Expected: PASS on the first run if Tasks 1–5 are correct. If it fails, the failure names the defective layer; fix the owning file, re-run, and describe the fix in the report.

- [ ] **Step 3: Run everything**

Run: `npx vitest run && npx tsc -b && (cd robot_gateway && .venv/Scripts/python -m pytest -m "not hardware" -q)`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/e2e-visit.test.ts
git commit -m "test(api): end-to-end visit flow with a scripted gateway client" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

## Plan self-review

**Spec coverage (Plan 2 scope):**
- Section 2 routes for visits (family create/get/cancel, device answer/decline, staff approve/deny, end): Tasks 1–2. `connected` is the stand-in for LiveKit's join signal until Plan 4.
- Section 2 `/events` filtered by identity: Task 5. `/gateway` with robot token: Task 4.
- Section 3 intent translation for `request_visit`, ack semantics, expiry, idempotency, busy, 10 s link-loss safe stop, heartbeat contents, `MockRobotAdapter`, the explicit `stop` (no auto-resume) and `resume`: Tasks 6–7. `deliver_item`, `staff_event`, lift, `/map.bin` double check and `NavWebAdapter` are Plans 5–6.
- Section 1 rule 4 (`cloud_online` vs `robot_ready`): `robotReady` in heartbeat + `connected` in `RobotStatus` (Tasks 3–4).
- Audit IDs only: transitions carry fixed reason codes (`auto_policy`, ack results, event names).

**Placeholder scan:** none. Task 8's "fix the owning file" is bounded by the e2e failure it names.

**Type consistency:** `VisitService.act` and `VISIT_ACTIONS` (Task 2 ↔ routes); `GatewayHub.attach/receive/status/onUp` (Task 3 ↔ 4 ↔ tests); `createDispatchService(...).flushPending` (3 ↔ 4); `listen()` helper (4 ↔ 5 ↔ 8); `ResumeSchema` added to `GatewayDownSchema` in Task 6 and used by `GatewayCore.handle`; Python `NavResult.outcome` ∈ arrived|navigation_failed|cancelled matches `STATE_EVENTS` in contracts; `state_event` names emitted by the core (`robot_en_route`, `arrived`, `navigation_failed`, `cancelled`, `safety_stopped`) all exist in `STATE_EVENTS`.

**Plans that follow:** 3 (resident kiosk + family app), 4 (LiveKit), 5 (task flow + staff console + tray mode in the gateway), 6 (NavWebAdapter on the Jetson), 7 (rehearsals + benchmark + docs).
