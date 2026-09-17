# Plan 5: Item Delivery Task Flow, Tray Mode in the Gateway, Staff Console

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. UI tasks (5, 6) load the `frontend-design` skill first.

**Goal:** During a call the family member says or types "bring Mom the water bottle"; the API turns it into a schema-validated, policy-checked proposal; the family member confirms; staff approve and load the tray; the robot (mock now, real in Plan 6) drives to the pickup station and then to the resident; the iPad shows "Your water bottle is here"; the resident taps "I have it"; the task completes with a full audit trail. Staff get a console to approve, load, watch, stop, and audit.

**Architecture:** `TaskService` owns creation (parser → policy → state), confirmation and staff/device actions; `DispatchService` (Plan 2) is extended to dispatch `deliver_item` intents and map gateway task events; the Python `GatewayCore` gains a multi-leg `deliver_item` executor that waits for `staff_event`s between legs. The staff console is a third Vite app on the same `web-common` package.

**Tech Stack:** as Plans 1–4.

**Spec:** `docs/superpowers/specs/2026-09-17-oncare-platform-design.md` (sections 1 tray table, 2 task routes, 3 `deliver_item`, 4 family "Ask the robot", staff console)

**Depends on:** Plans 1–4 complete.

## Global Constraints

- Zero physical executions without explicit confirmation: a `deliver_item` intent is created only by a transition to `queued`, which is reachable only through `awaiting_user_confirmation` (family confirm) and `awaiting_policy_or_staff` (staff approve). This is asserted by tests in Task 2.
- Parsing is the deterministic `KeywordParser`; no model provider. Policy is `evaluateProposal` with the catalogue loaded from the `item` table and `authorizedRecipients` from the requester's `family_relationship` rows with `consentItemDelivery = true`.
- Tray mode (`task_request.mode = "tray"`): the manipulation states are driven by staff/device actions; the gateway never commands an arm. Events carry `mode: "tray"` in `detail`.
- Staff STOP never auto-resumes; resume requires the staff PIN.
- Audit rows contain IDs and fixed reason codes only; the utterance text is never stored (the proposal JSON holds catalogue ids only).
- All UI strings via `t()`; add keys to `packages/web-common/src/i18n/en.json` in the task that first uses them.
- Test commands: `npx vitest run <path>` from the repo root; Python: `cd robot_gateway && .venv/Scripts/python -m pytest -m "not hardware" -q`.
- Commit trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC
  ```
- Do not modify anything under `D:/ontaru/AGI carehouse/on_software_all`.

## File structure produced by this plan

```
apps/api/src/services/tasks.ts          createTaskService(): create (parse+policy), confirm, act (approve/deny/loaded/received/stop/cancel), get, canView, listQueue
apps/api/src/services/dispatch.ts       + deliver_item intents; task event mapping; staff_event forwarding
apps/api/src/routes/tasks.ts            POST /tasks, GET /tasks/:id, POST /tasks/:id/{confirm,cancel,approve,deny,loaded,received,stop}
apps/api/src/routes/staff.ts            GET /queue, GET /audit, POST /robots/:id/{stop,resume,standby}, PATCH /residents/:id/availability
apps/api/src/routes/device.ts           + task in /device/state (screen delivery_arrived)
apps/api/test/tasks.test.ts, task-dispatch.test.ts, staff.test.ts, e2e-task.test.ts
robot_gateway/gateway/core.py           + deliver_item legs, staff_event handling
robot_gateway/tests/test_core_deliver.py
apps/family/src/components/AskRobot.tsx  text + Web Speech input, clarification chips, confirmation card, task stepper
apps/family/src/task-progress.ts        taskProgress(state) (pure)
apps/resident/src/App.tsx               + delivery_arrived wiring (item label, received action)
apps/staff/                             new Vite app: Login, Queue, RobotPanel, Streaming, AuditTable
docs/demo-task-flow.md
```

---

### Task 1: `TaskService.create` — parse, policy, and the confirmation gate; `POST /tasks`, `GET /tasks/:id`

**Files:**
- Create: `apps/api/src/services/tasks.ts`, `apps/api/src/routes/tasks.ts`
- Modify: `apps/api/src/app.ts` — create and expose `app.tasks`; register `taskRoutes`
- Test: `apps/api/test/tasks.test.ts`

**Interfaces:**
- Consumes: `KeywordParser`, `evaluateProposal`, `parseTaskProposal`, `DEMO_CATALOGUE` types from `@oncare/core`; `TransitionService`; tables.
- Produces:
  ```ts
  export type TaskRow = typeof t.taskRequest.$inferSelect;
  export type CreateOutcome =
    | { kind: "clarification"; question: string; options: string[] }
    | { kind: "rejected"; task: TaskRow; code: PolicyCode; reason: string }
    | { kind: "proposal"; task: TaskRow };
  export interface TaskService {
    create(input: { requesterId: string; residentId: string; text: string; visitId?: string }): { ok: true; outcome: CreateOutcome } | { ok: false; error: "no_relationship" | "consent_missing" | "visit_mismatch" };
    get(id: string): TaskRow | undefined;
    canView(principal: Principal, task: TaskRow): boolean;
  }
  export function createTaskService(db: Db, transitions: TransitionService, opts?: { now?: () => Date; id?: () => string; parser?: IntentParser }): TaskService;
  // Routes
  POST /tasks        family  body { residentId, text, visitId? }
     -> 200 { kind: "clarification", question, options } | 200 { kind: "proposal", task } | 200 { kind: "rejected", task, code, reason }
     -> 403 { error: "no_relationship" } | 409 { error: "consent_missing" | "visit_mismatch" } | 400
  GET  /tasks/:id    family (own) | staff | device (same resident) -> 200 { task } | 403 | 404
  ```
- `create` steps: (1) relationship must exist; `consentItemDelivery` must be true else `consent_missing`; if `visitId` given it must belong to the same requester+resident else `visit_mismatch`. (2) `ParseContext`: `recipientId = residentId`, `defaultDestinationId` = the resident's room location id **suffixed** as the approved surface: the catalogue's approved destinations are surfaces (`bedside_table_demo`), not rooms, so use `DEMO_CATALOGUE.approvedDestinations[0].id` for the demo and record that as a ruling in the code comment; `catalogue` = `{ approvedItems: items where approved, prohibitedItems: items where prohibited, approvedDestinations: DEMO_CATALOGUE.approvedDestinations }`. (3) parser clarification → return it, no row. (4) proposal → insert `task_request` in `draft` with `mode: "tray"`, `correlationId = "task_" + id`, apply `draft → parsed`. (5) `evaluateProposal` with `authorizedRecipients` = resident ids from the requester's relationships with `consentItemDelivery`; on reject apply `parsed → rejected` with reason = policy code and return `rejected`; on allow apply `parsed → awaiting_user_confirmation` and return `proposal`.
- The task row's `proposal` column stores the `TaskProposal` JSON exactly (catalogue ids only).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/tasks.test.ts
import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const post = (app: any, token: string, body: unknown) => app.inject({ method: "POST", url: "/tasks", headers: auth(token), payload: body });

describe("POST /tasks", () => {
  test("the handover sentence becomes a proposal awaiting confirmation, with an audit trail and no utterance stored", async () => {
    const { app, db, tokens } = await makeTestApp();
    const res = await post(app, tokens.family, { residentId: SEED_IDS.resident, text: "Could you bring Mom the water bottle?" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe("proposal");
    expect(body.task).toMatchObject({ state: "awaiting_user_confirmation", mode: "tray", residentId: SEED_IDS.resident, requesterId: SEED_IDS.familyUser,
      proposal: { task_type: "deliver_item", item: "water_bottle", recipient: SEED_IDS.resident, destination: "bedside_table_demo", requires_confirmation: true } });
    const trail = db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, body.task.id)).all();
    expect(trail.map((e) => e.toState)).toEqual(["parsed", "awaiting_user_confirmation"]);
    expect(JSON.stringify(db.select().from(t.taskRequest).all())).not.toContain("Could you");
  });

  test("an ambiguous request returns a clarification and creates no row", async () => {
    const { app, db, tokens } = await makeTestApp();
    const res = await post(app, tokens.family, { residentId: SEED_IDS.resident, text: "can you help her?" });
    expect(res.json()).toMatchObject({ kind: "clarification", options: ["water_bottle", "tissue_box", "tv_remote"] });
    expect(db.select().from(t.taskRequest).all()).toHaveLength(0);
  });

  test("a prohibited item is rejected by policy with the prohibited_item code and a rejected task row", async () => {
    const { app, db, tokens } = await makeTestApp();
    const res = await post(app, tokens.family, { residentId: SEED_IDS.resident, text: "bring her medication" });
    expect(res.json()).toMatchObject({ kind: "rejected", code: "prohibited_item", task: { state: "rejected" } });
    const last = db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, res.json().task.id)).all().at(-1);
    expect(last).toMatchObject({ toState: "rejected", reason: "prohibited_item" });
  });

  test("consentItemDelivery false is 409 consent_missing; unrelated resident is 403", async () => {
    const { app, db, tokens } = await makeTestApp();
    db.update(t.familyRelationship).set({ consentItemDelivery: false }).where(eq(t.familyRelationship.userId, SEED_IDS.familyUser)).run();
    expect((await post(app, tokens.family, { residentId: SEED_IDS.resident, text: "water" })).statusCode).toBe(409);
    db.insert(t.resident).values({ id: "resident_demo_02", facilityId: SEED_IDS.facility, displayName: "Other", roomLocationId: SEED_IDS.roomLocation }).run();
    expect((await post(app, tokens.family, { residentId: "resident_demo_02", text: "water" })).statusCode).toBe(403);
  });

  test("a visitId that belongs to someone else is 409 visit_mismatch", async () => {
    const { app, db, tokens } = await makeTestApp();
    db.insert(t.resident).values({ id: "resident_demo_02", facilityId: SEED_IDS.facility, displayName: "Other", roomLocationId: SEED_IDS.roomLocation }).run();
    db.insert(t.visitSession).values({ id: "visit_other", residentId: "resident_demo_02", requesterId: SEED_IDS.staffUser, robotId: null, state: "active", livekitRoom: null, requestedAt: new Date().toISOString(), connectedAt: null, endedAt: null }).run();
    expect((await post(app, tokens.family, { residentId: SEED_IDS.resident, text: "water", visitId: "visit_other" })).json()).toEqual({ error: "visit_mismatch" });
  });

  test("staff and device cannot create tasks; empty text is 400", async () => {
    const { app, tokens } = await makeTestApp();
    expect((await post(app, tokens.staff, { residentId: SEED_IDS.resident, text: "water" })).statusCode).toBe(403);
    expect((await post(app, tokens.device, { residentId: SEED_IDS.resident, text: "water" })).statusCode).toBe(403);
    expect((await post(app, tokens.family, { residentId: SEED_IDS.resident, text: "" })).statusCode).toBe(400);
  });
});

describe("GET /tasks/:id", () => {
  test("owner, staff and the resident's device can read; another family user cannot", async () => {
    const { app, db, tokens } = await makeTestApp();
    const id = (await post(app, tokens.family, { residentId: SEED_IDS.resident, text: "water bottle" })).json().task.id;
    for (const tok of [tokens.family, tokens.staff, tokens.device]) expect((await app.inject({ method: "GET", url: `/tasks/${id}`, headers: auth(tok) })).statusCode).toBe(200);
    const { hashSecret } = await import("../src/auth/password");
    db.insert(t.user).values({ id: "family_demo_02", role: "family", username: "family2", displayName: "Other", passwordHash: await hashSecret("pw"), pinHash: null }).run();
    const other = (await app.inject({ method: "POST", url: "/auth/login", payload: { username: "family2", password: "pw" } })).json().token;
    expect((await app.inject({ method: "GET", url: `/tasks/${id}`, headers: auth(other) })).statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/tasks.test.ts`
Expected: FAIL — routes 404.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/tasks.ts
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { DEMO_CATALOGUE, KeywordParser, evaluateProposal, type IntentParser, type ItemCatalogue, type PolicyCode, type TaskState } from "@oncare/core";
import type { Principal } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import { TransitionError } from "./transitions";
import type { TransitionService } from "./visits";

export type TaskRow = typeof t.taskRequest.$inferSelect;
export type CreateOutcome =
  | { kind: "clarification"; question: string; options: string[] }
  | { kind: "rejected"; task: TaskRow; code: PolicyCode; reason: string }
  | { kind: "proposal"; task: TaskRow };
export type CreateError = "no_relationship" | "consent_missing" | "visit_mismatch";

export interface TaskService {
  create(input: { requesterId: string; residentId: string; text: string; visitId?: string }): { ok: true; outcome: CreateOutcome } | { ok: false; error: CreateError };
  get(id: string): TaskRow | undefined;
  canView(principal: Principal, task: TaskRow): boolean;
}

export function createTaskService(db: Db, transitions: TransitionService, opts: { now?: () => Date; id?: () => string; parser?: IntentParser } = {}): TaskService {
  const now = opts.now ?? (() => new Date());
  const id = opts.id ?? (() => `task_${randomUUID()}`);
  const parser = opts.parser ?? new KeywordParser();

  function catalogue(): ItemCatalogue {
    const items = db.select().from(t.item).all();
    return {
      approvedItems: items.filter((i) => i.approved).map((i) => i.id),
      prohibitedItems: items.filter((i) => i.prohibited).map((i) => i.id),
      // Ruling: destinations are surfaces, not rooms. The demo has one approved surface per resident room; Plan 6 may key this by resident.
      approvedDestinations: DEMO_CATALOGUE.approvedDestinations,
    };
  }

  function get(taskId: string): TaskRow | undefined {
    return db.select().from(t.taskRequest).where(eq(t.taskRequest.id, taskId)).get();
  }

  function apply(taskId: string, to: TaskState, actorType: "system" | "family" | "staff" | "device" | "robot", actorId: string, reason?: string) {
    transitions.apply({ entityType: "task", entityId: taskId, to, actorType, actorId, ...(reason ? { reason } : {}) });
  }

  function create(input: { requesterId: string; residentId: string; text: string; visitId?: string }) {
    const rel = db.select().from(t.familyRelationship).where(and(eq(t.familyRelationship.userId, input.requesterId), eq(t.familyRelationship.residentId, input.residentId))).get();
    if (!rel) return { ok: false as const, error: "no_relationship" as const };
    if (!rel.consentItemDelivery) return { ok: false as const, error: "consent_missing" as const };
    if (input.visitId) {
      const v = db.select().from(t.visitSession).where(eq(t.visitSession.id, input.visitId)).get();
      if (!v || v.requesterId !== input.requesterId || v.residentId !== input.residentId) return { ok: false as const, error: "visit_mismatch" as const };
    }
    const cat = catalogue();
    const parsed = parser.parse(input.text, { recipientId: input.residentId, defaultDestinationId: cat.approvedDestinations[0]!.id, catalogue: cat });
    if (parsed.kind === "clarification") return { ok: true as const, outcome: parsed };

    const taskId = id();
    db.insert(t.taskRequest).values({
      id: taskId, visitId: input.visitId ?? null, requesterId: input.requesterId, residentId: input.residentId,
      proposal: parsed.proposal, state: "draft", mode: "tray", correlationId: taskId, createdAt: now().toISOString(),
    }).run();
    apply(taskId, "parsed", "system", "api");

    const authorizedRecipients = db.select().from(t.familyRelationship)
      .where(and(eq(t.familyRelationship.userId, input.requesterId), eq(t.familyRelationship.consentItemDelivery, true))).all().map((r) => r.residentId);
    const verdict = evaluateProposal(parsed.proposal, { catalogue: cat, authorizedRecipients });
    if (!verdict.allowed) {
      apply(taskId, "rejected", "system", "api", verdict.code);
      return { ok: true as const, outcome: { kind: "rejected" as const, task: get(taskId)!, code: verdict.code, reason: verdict.reason } };
    }
    apply(taskId, "awaiting_user_confirmation", "system", "api");
    return { ok: true as const, outcome: { kind: "proposal" as const, task: get(taskId)! } };
  }

  function canView(p: Principal, task: TaskRow): boolean {
    if (p.kind === "device") return p.residentId === task.residentId;
    if (p.role === "staff") return true;
    return p.id === task.requesterId;
  }

  return { create, get, canView };
}
export { TransitionError };
```

```ts
// apps/api/src/routes/tasks.ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/plugin";

export async function taskRoutes(app: FastifyInstance) {
  app.post("/tasks", { preHandler: requireRole("family") }, async (req, reply) => {
    const body = z.object({ residentId: z.string().min(1), text: z.string().trim().min(1).max(500), visitId: z.string().min(1).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const p = req.principal;
    if (p.kind !== "user") return reply.code(403).send({ error: "forbidden" });
    const r = app.tasks.create({ requesterId: p.id, residentId: body.data.residentId, text: body.data.text, ...(body.data.visitId ? { visitId: body.data.visitId } : {}) });
    if (!r.ok) return reply.code(r.error === "no_relationship" ? 403 : 409).send({ error: r.error });
    return r.outcome;
  });

  app.get("/tasks/:id", { preHandler: requireRole("family", "staff", "device") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = app.tasks.get(id);
    if (!task) return reply.code(404).send({ error: "not_found" });
    if (!app.tasks.canView(req.principal, task)) return reply.code(403).send({ error: "forbidden" });
    return { task };
  });
}
```

`app.ts`: `app.decorate("tasks", createTaskService(opts.db, transitions, opts.now ? { now: opts.now } : {}));` augment `FastifyInstance` with `tasks: TaskService`; `app.register(taskRoutes)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/api/test/tasks.test.ts && npx vitest run apps/api && npx tsc -b`
Expected: PASS (7 new tests); earlier tests green; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/tasks.ts apps/api/src/routes/tasks.ts apps/api/src/app.ts apps/api/test/tasks.test.ts
git commit -m "feat(api): task creation with keyword parsing, deterministic policy and confirmation gate" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 2: Task actions and `deliver_item` dispatch (confirm → approve → tray legs → received → completed)

**Files:**
- Modify: `apps/api/src/services/tasks.ts` — add `act()`; `apps/api/src/routes/tasks.ts` — action routes
- Modify: `apps/api/src/services/dispatch.ts` — task intents, task event mapping, `staff_event` forwarding, `stop`
- Test: `apps/api/test/task-dispatch.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type TaskAction = "confirm" | "cancel" | "approve" | "deny" | "loaded" | "received" | "stop";
  act(input: { taskId: string; action: TaskAction; principal: Principal; reason?: string }): { ok: true; task: TaskRow } | { ok: false; error: "not_found" | "forbidden" | "illegal_transition"; detail?: string };
  // Routes: POST /tasks/:id/<action> -> 200 { task } | 403 | 404 | 409
  ```
- Action table:

| action | roles | transitions | side effect |
|---|---|---|---|
| confirm | family (owner) | `awaiting_user_confirmation → awaiting_policy_or_staff` | writes `task_approval { decision: "confirmed" }` |
| cancel | family (owner), staff | any non-terminal → `cancelled` | if a robot command exists and is not finished: hub `cancel` |
| approve | staff | `awaiting_policy_or_staff → queued` | writes `task_approval { decision: "approved" }`; dispatch creates the intent (see below) |
| deny | staff | `awaiting_policy_or_staff → rejected` (reason `staff_denied`) | writes `task_approval { decision: "denied" }` |
| loaded | staff | `locating_item → grasping → verifying_grasp → navigating_to_delivery` (reason `tray_mode`) | hub `staff_event staff_loaded` |
| received | device (same resident), staff | `placing → verifying_delivery → completed` (reason `tray_mode`) | hub `staff_event received` |
| stop | staff | any physical state or `queued` → `safety_stopped` (reason `staff_stop`) | hub `stop { reason: "staff_stop" }` |

- Dispatch additions (`dispatch.ts`) — note `flushPending` now (Plan 2 fix C1) only re-sends commands whose visit is `accepted`; extend that check so task commands are re-sent only when the task is `queued`, and mark others `stale`:
  - On task transition to `queued`: build `IntentDeliverItem { correlationId: task.correlationId, expiresAt: now + ttl, payload: { itemId: proposal.item, pickupLocationId: <location kind pickup_station>, destinationLocationId: resident.roomLocationId, standbyLocationId: <location kind standby>, mode: "tray" } }`; insert `robot_command { taskId }`; `hub.send`.
  - Task-scoped gateway messages are matched by `robot_command.taskId` via `correlationId === task.correlationId`. `ack accepted` → `navigating_to_pickup`; `ack expired|rejected|busy` → `operator_required` (reason = ack result). `state_event`: `arrived_pickup` → `locating_item`; `arrived_delivery` → `placing`; `navigation_failed` → `navigation_failed`; `safety_stopped` → `safety_stopped`; `cancelled` → `cancelled` (no-op if already); `expired` → `operator_required`; `completed_leg` → no task transition (robot back at standby; audit only as entity `robot`).
  - Task transitions caused by the robot use `actorType: "robot"`; illegal ones are swallowed (already audited as `rejected_transition`).
  - Robot command lookup must handle both visit and task commands: extend the lookup to `where(and(eq(robotId), or(eq(visitId, corr), eq(taskCorrelation...))))` — simplest: add a `correlationId` column to `robot_command` (migration `0001_robot_command_correlation.sql` via `drizzle-kit generate`) set to the visit id or the task's `correlationId`, and look up by it. Update Plan 2's `flushPending` and `onVisitCancelled` to the new column.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/task-dispatch.test.ts
import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import type { GatewayDown } from "@oncare/contracts";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function proposal() {
  const ctx = await makeTestApp();
  const sent: GatewayDown[] = [];
  ctx.app.hub.attach(SEED_IDS.robot, { send: (m) => { sent.push(m); } });
  const res = await ctx.app.inject({ method: "POST", url: "/tasks", headers: auth(ctx.tokens.family), payload: { residentId: SEED_IDS.resident, text: "water bottle" } });
  const task = res.json().task;
  const act = (action: string, token: string) => ctx.app.inject({ method: "POST", url: `/tasks/${task.id}/${action}`, headers: auth(token) });
  const state = () => ctx.db.select().from(t.taskRequest).where(eq(t.taskRequest.id, task.id)).get()!.state;
  const robot = (msg: any) => ctx.app.hub.receive(SEED_IDS.robot, msg);
  const ev = (event: string) => robot({ type: "state_event", correlationId: task.correlationId, at: new Date().toISOString(), event });
  return { ...ctx, sent, task, act, state, robot, ev };
}

describe("task actions and dispatch", () => {
  test("no intent is ever sent before both family confirmation and staff approval", async () => {
    const { sent, act, tokens, state } = await proposal();
    expect(sent).toHaveLength(0);
    expect((await act("approve", tokens.staff)).statusCode).toBe(409);      // not confirmed yet
    expect(sent).toHaveLength(0);
    expect((await act("confirm", tokens.family)).json().task.state).toBe("awaiting_policy_or_staff");
    expect(sent).toHaveLength(0);
    expect((await act("loaded", tokens.staff)).statusCode).toBe(409);       // not queued yet
    expect((await act("approve", tokens.staff)).json().task.state).toBe("queued");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "intent", intent: "deliver_item", payload: { itemId: "water_bottle", pickupLocationId: SEED_IDS.pickupLocation, destinationLocationId: SEED_IDS.roomLocation, standbyLocationId: SEED_IDS.standbyLocation, mode: "tray" } });
    expect(state()).toBe("queued");
  });

  test("confirm and approve write task_approval rows with the right actors", async () => {
    const { db, act, tokens, task } = await proposal();
    await act("confirm", tokens.family); await act("approve", tokens.staff);
    expect(db.select().from(t.taskApproval).where(eq(t.taskApproval.taskId, task.id)).all().map((a) => [a.decision, a.actorId])).toEqual([["confirmed", SEED_IDS.familyUser], ["approved", SEED_IDS.staffUser]]);
  });

  test("full tray flow: ack -> arrived_pickup -> staff loaded -> arrived_delivery -> device received -> completed", async () => {
    const { db, sent, act, tokens, task, state, robot, ev } = await proposal();
    await act("confirm", tokens.family); await act("approve", tokens.staff);
    robot({ type: "ack", correlationId: task.correlationId, result: "accepted" });
    expect(state()).toBe("navigating_to_pickup");
    ev("arrived_pickup");
    expect(state()).toBe("locating_item");
    expect((await act("loaded", tokens.staff)).json().task.state).toBe("navigating_to_delivery");
    expect(sent.at(-1)).toEqual({ type: "staff_event", correlationId: task.correlationId, event: "staff_loaded" });
    ev("arrived_delivery");
    expect(state()).toBe("placing");
    expect((await act("received", tokens.device)).json().task.state).toBe("completed");
    expect(sent.at(-1)).toEqual({ type: "staff_event", correlationId: task.correlationId, event: "received" });
    ev("completed_leg");
    expect(state()).toBe("completed");
    const trail = db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, task.id)).all();
    expect(trail.map((e) => e.toState)).toEqual(["parsed", "awaiting_user_confirmation", "awaiting_policy_or_staff", "queued", "navigating_to_pickup", "locating_item", "grasping", "verifying_grasp", "navigating_to_delivery", "placing", "verifying_delivery", "completed"]);
    expect(trail.filter((e) => e.reason === "tray_mode")).toHaveLength(5);
  });

  test("staff stop from a physical state sends stop and ends in safety_stopped; deny ends in rejected", async () => {
    const a = await proposal();
    await a.act("confirm", a.tokens.family); await a.act("approve", a.tokens.staff);
    a.robot({ type: "ack", correlationId: a.task.correlationId, result: "accepted" });
    expect((await a.act("stop", a.tokens.staff)).json().task.state).toBe("safety_stopped");
    expect(a.sent.at(-1)).toEqual({ type: "stop", reason: "staff_stop" });
    const b = await proposal();
    await b.act("confirm", b.tokens.family);
    expect((await b.act("deny", b.tokens.staff)).json().task.state).toBe("rejected");
    expect(b.sent).toHaveLength(0);
  });

  test("robot failures map to task failure states; ack busy -> operator_required", async () => {
    const a = await proposal();
    await a.act("confirm", a.tokens.family); await a.act("approve", a.tokens.staff);
    a.robot({ type: "ack", correlationId: a.task.correlationId, result: "accepted" });
    a.ev("navigation_failed");
    expect(a.state()).toBe("navigation_failed");
    const b = await proposal();
    await b.act("confirm", b.tokens.family); await b.act("approve", b.tokens.staff);
    b.robot({ type: "ack", correlationId: b.task.correlationId, result: "busy" });
    expect(b.state()).toBe("operator_required");
  });

  test("family cancel while queued sends cancel; device cannot approve; family cannot load", async () => {
    const { sent, act, tokens, task, state } = await proposal();
    await act("confirm", tokens.family); await act("approve", tokens.staff);
    expect((await act("approve", tokens.device)).statusCode).toBe(403);
    expect((await act("loaded", tokens.family)).statusCode).toBe(403);
    expect((await act("cancel", tokens.family)).json().task.state).toBe("cancelled");
    expect(sent.at(-1)).toEqual({ type: "cancel", correlationId: task.correlationId });
    expect(state()).toBe("cancelled");
  });

  test("visit dispatch still works after the correlationId column change", async () => {
    const { app, db, sent, tokens } = await proposal();
    const visitId = (await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } })).json().visit.id;
    expect(sent.at(-1)).toMatchObject({ type: "intent", intent: "request_visit", correlationId: visitId });
    app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: visitId, result: "accepted" });
    expect(db.select().from(t.visitSession).where(eq(t.visitSession.id, visitId)).get()?.state).toBe("robot_en_route");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/task-dispatch.test.ts`
Expected: FAIL — action routes 404.

- [ ] **Step 3: Write the implementation**

Schema: add `correlationId: text("correlation_id").notNull()` to `robotCommand` in `apps/api/src/db/schema.ts`; run `cd apps/api && npx drizzle-kit generate` (produces `drizzle/0001_*.sql`); commit the migration.

`tasks.ts` additions (inside `createTaskService`; also add `hub: GatewayHub` as a fourth constructor parameter and pass it from `app.ts`):

```ts
export type TaskAction = "confirm" | "cancel" | "approve" | "deny" | "loaded" | "received" | "stop";
type Role = "family" | "staff" | "device";
const ACTIONS: Record<TaskAction, { roles: Role[]; to: TaskState[]; reason?: string; approval?: "confirmed" | "approved" | "denied" | "cancelled" }> = {
  confirm:  { roles: ["family"],          to: ["awaiting_policy_or_staff"], approval: "confirmed" },
  cancel:   { roles: ["family", "staff"], to: ["cancelled"], approval: "cancelled" },
  approve:  { roles: ["staff"],           to: ["queued"], approval: "approved" },
  deny:     { roles: ["staff"],           to: ["rejected"], reason: "staff_denied", approval: "denied" },
  loaded:   { roles: ["staff"],           to: ["grasping", "verifying_grasp", "navigating_to_delivery"], reason: "tray_mode" },
  received: { roles: ["device", "staff"], to: ["verifying_delivery", "completed"], reason: "tray_mode" },
  stop:     { roles: ["staff"],           to: ["safety_stopped"], reason: "staff_stop" },
};

function act(input: { taskId: string; action: TaskAction; principal: Principal }) {
  const task = get(input.taskId);
  if (!task) return { ok: false as const, error: "not_found" as const };
  const spec = ACTIONS[input.action];
  const role: Role = input.principal.kind === "device" ? "device" : input.principal.role;
  if (!spec.roles.includes(role) || !canView(input.principal, task)) return { ok: false as const, error: "forbidden" as const };
  const actorType = role; // "family" | "staff" | "device" are all ActorType values
  try {
    for (const to of spec.to) apply(task.id, to, actorType, input.principal.id, spec.reason);
  } catch (e) {
    if (e instanceof TransitionError) return { ok: false as const, error: "illegal_transition" as const, detail: e.reason };
    throw e;
  }
  if (spec.approval) db.insert(t.taskApproval).values({ id: `appr_${randomUUID()}`, taskId: task.id, actorId: input.principal.id, decision: spec.approval, reason: null, at: now().toISOString() }).run();
  const robotId = db.select().from(t.robot).get()?.id;
  if (robotId) {
    if (input.action === "loaded") hub.send(robotId, { type: "staff_event", correlationId: task.correlationId, event: "staff_loaded" });
    if (input.action === "received") hub.send(robotId, { type: "staff_event", correlationId: task.correlationId, event: "received" });
    if (input.action === "stop") hub.send(robotId, { type: "stop", reason: "staff_stop" });
  }
  return { ok: true as const, task: get(task.id)! };
}
```
Note: `cancel` for tasks is sent by the dispatch service (it knows whether a command is live), mirroring visits. Export `TASK_ACTIONS = Object.keys(ACTIONS) as TaskAction[]` and add `act` to the interface/return.

Routes (`tasks.ts`): `app.post("/tasks/:id/:action", { preHandler: requireRole("family","staff","device") }, ...)` identical in shape to the visit action route, mapping errors to 404/403/409.

`dispatch.ts` changes:
- `onVisitAccepted` inserts `correlationId: visit.id`; add `onTaskQueued(ev)`:
  ```ts
  function onTaskQueued(ev: AuditEvent) {
    const task = db.select().from(t.taskRequest).where(eq(t.taskRequest.id, ev.entityId)).get();
    const robot = db.select().from(t.robot).get();
    const resident = task && db.select().from(t.resident).where(eq(t.resident.id, task.residentId)).get();
    const pickup = db.select().from(t.location).where(and(eq(t.location.kind, "pickup_station"), eq(t.location.approved, true))).get();
    const standby = db.select().from(t.location).where(and(eq(t.location.kind, "standby"), eq(t.location.approved, true))).get();
    if (!task || !robot || !resident || !pickup || !standby) return;
    const proposal = task.proposal as { item: string };
    const issuedAt = now();
    const intent: Intent = { type: "intent", intent: "deliver_item", correlationId: task.correlationId, expiresAt: new Date(issuedAt.getTime() + ttl).toISOString(),
      payload: { itemId: proposal.item, pickupLocationId: pickup.id, destinationLocationId: resident.roomLocationId, standbyLocationId: standby.id, mode: task.mode } };
    db.insert(t.robotCommand).values({ id: id(), robotId: robot.id, visitId: null, taskId: task.id, correlationId: task.correlationId, intent, issuedAt: issuedAt.toISOString(), expiresAt: intent.expiresAt, ackedAt: null, result: null }).run();
    hub.send(robot.id, intent);
  }
  ```
- subscription: `if (ev.entityType === "task" && ev.toState === "queued") onTaskQueued(ev); if (ev.entityType === "task" && ev.toState === "cancelled") onCancelled(ev, "task");` (generalize `onVisitCancelled` to look up the command by `correlationId` — for tasks that is `task.correlationId`, for visits the visit id).
- `onUp`: look the command up by `and(eq(robotId), eq(correlationId, msg.correlationId))`; if `cmd.taskId` use the task map below, else the visit map from Plan 2.
  ```ts
  const STATE_EVENT_TO_TASK: Partial<Record<string, TaskState>> = { arrived_pickup: "locating_item", arrived_delivery: "placing", navigation_failed: "navigation_failed", safety_stopped: "safety_stopped", cancelled: "cancelled", expired: "operator_required" };
  // ack: accepted -> "navigating_to_pickup"; expired|rejected|busy -> "operator_required" (reason = result); duplicate -> nothing
  ```
  `robotApply` takes `entityType` as a parameter now.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/api && npx tsc -b`
Expected: PASS (7 new); Plan 2's dispatch and e2e tests still green after the column change.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/drizzle apps/api/test/task-dispatch.test.ts
git commit -m "feat(api): task actions, deliver_item dispatch and tray-mode legs driven by staff and device" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 3: Gateway `deliver_item` executor (multi-leg, waits for staff events)

**Files:**
- Modify: `robot_gateway/gateway/core.py`
- Test: `robot_gateway/tests/test_core_deliver.py`

**Interfaces:**
- `GatewayCore.handle()` accepts `deliver_item` (replacing the `not_implemented` rejection) when all three location ids are approved. Legs: `pickup` → emit `arrived_pickup`, wait for `staff_event staff_loaded` → `delivery` → emit `arrived_delivery`, wait for `staff_event received` → `standby` → emit `completed_leg`, clear active. A `staff_event` for a non-active correlation id is ignored. `cancel`/`stop`/link-loss behave as for visits at any point (including while waiting for a staff event — no adapter motion then, but the active intent is cleared and `cancelled`/`safety_stopped` is emitted). `heartbeat().activeCorrelationId` stays set during the waits.
- Internal: `self._active` becomes `{"correlationId", "kind": "visit"|"deliver", "leg": "pickup"|"await_loaded"|"delivery"|"await_received"|"standby", "payload"}`.

- [ ] **Step 1: Write the failing test**

```python
# robot_gateway/tests/test_core_deliver.py
import pytest
from gateway.core import GatewayCore
from gateway.messages import validate_up
from gateway.robot.mock import MockRobotAdapter

LOCS = {"type": "locations", "locations": [
    {"id": "pickup_station_demo", "name": "Nurse station", "kind": "pickup_station", "x": 0.0, "y": 0.0, "yaw": 0.0, "approved": True},
    {"id": "room_demo_01", "name": "Room", "kind": "resident_room", "x": 3.0, "y": 1.0, "yaw": 0.0, "approved": True},
    {"id": "standby_demo", "name": "Standby", "kind": "standby", "x": 1.0, "y": 1.0, "yaw": 0.0, "approved": True},
]}
def deliver(corr="task_1", pickup="pickup_station_demo", dest="room_demo_01", standby="standby_demo"):
    return {"type": "intent", "intent": "deliver_item", "correlationId": corr, "expiresAt": "2099-01-01T00:00:00.000Z",
            "payload": {"itemId": "water_bottle", "pickupLocationId": pickup, "destinationLocationId": dest, "standbyLocationId": standby, "mode": "tray"}}
def staff(corr, event): return {"type": "staff_event", "correlationId": corr, "event": event}
def kinds(msgs): return [(m["type"], m.get("result") or m.get("event")) for m in msgs]

@pytest.fixture
def core(clock):
    c = GatewayCore(MockRobotAdapter(travel_ms=1000), now_ms=clock.now_ms); c.on_connected(); c.handle(LOCS); return c

def test_full_tray_delivery(core, clock):
    out = core.handle(deliver())
    for m in out: validate_up(m)
    assert kinds(out) == [("ack", "accepted"), ("state_event", "robot_en_route")]
    clock.advance(1000)
    assert kinds(core.tick()) == [("state_event", "arrived_pickup")]
    clock.advance(5000)
    assert core.tick() == []                                   # waiting for staff; nothing moves
    assert core.heartbeat()["activeCorrelationId"] == "task_1"
    assert core.handle(staff("task_1", "staff_loaded")) == []
    clock.advance(1000)
    assert kinds(core.tick()) == [("state_event", "arrived_delivery")]
    assert core.handle(staff("task_1", "received")) == []
    clock.advance(1000)
    out = core.tick()
    assert kinds(out) == [("state_event", "completed_leg")]
    assert out[0]["detail"] == {"leg": "standby", "mode": "tray"}
    assert core.active_correlation_id is None

def test_unknown_location_in_any_leg_is_rejected(core):
    assert core.handle(deliver(standby="nowhere"))[0]["reason"] == "unknown_location"

def test_staff_event_for_other_correlation_is_ignored(core, clock):
    core.handle(deliver()); clock.advance(1000); core.tick()
    core.handle(staff("other", "staff_loaded"))
    clock.advance(1000)
    assert core.tick() == []

def test_cancel_while_waiting_for_staff(core, clock):
    core.handle(deliver()); clock.advance(1000); core.tick()
    core.handle({"type": "cancel", "correlationId": "task_1"})
    assert kinds(core.tick()) == [("state_event", "cancelled")]
    assert core.active_correlation_id is None

def test_stop_mid_delivery_leg(core, clock):
    core.handle(deliver()); clock.advance(1000); core.tick(); core.handle(staff("task_1", "staff_loaded"))
    out = core.handle({"type": "stop", "reason": "staff_stop"})
    assert kinds(out) == [("state_event", "safety_stopped")]
    assert core.heartbeat()["robotReady"] is False

def test_navigation_failure_on_delivery_leg(clock):
    adapter = MockRobotAdapter(travel_ms=100)
    c = GatewayCore(adapter, now_ms=clock.now_ms); c.on_connected(); c.handle(LOCS)
    c.handle(deliver()); clock.advance(100); c.tick(); c.handle(staff("task_1", "staff_loaded"))
    adapter.inject_failure("navigation_failed", reason="blocked")
    clock.advance(100)
    out = c.tick()
    assert kinds(out) == [("state_event", "navigation_failed")] and out[0]["detail"]["leg"] == "delivery"

def test_visit_intent_still_works_and_busy_during_delivery(core, clock):
    core.handle(deliver())
    assert core.handle({"type": "intent", "intent": "request_visit", "correlationId": "visit_9", "expiresAt": "2099-01-01T00:00:00.000Z", "payload": {"locationId": "room_demo_01"}})[0]["result"] == "busy"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd robot_gateway && .venv/Scripts/python -m pytest tests/test_core_deliver.py -q`
Expected: FAIL — `deliver_item` is acked `rejected/not_implemented`.

- [ ] **Step 3: Write the implementation**

In `core.py`, replace the `deliver_item` branch of `_handle_intent` and generalize the active record:

```python
    def _handle_intent(self, msg: dict) -> list[dict]:
        corr = msg["correlationId"]
        ack = lambda result, reason=None: {"type": "ack", "correlationId": corr, "result": result, **({"reason": reason} if reason else {})}
        if corr in self._seen: return [ack("duplicate")]
        if _parse_iso_ms(msg["expiresAt"]) <= self.now_ms(): return [ack("expired")]
        if self._active is not None: return [ack("busy")]
        if self._stopped: return [ack("rejected", "stopped")]
        p = msg["payload"]
        if msg["intent"] == "deliver_item":
            legs = {k: self.locations.get(p[k]) for k in ("pickupLocationId", "destinationLocationId", "standbyLocationId")}
            if any(v is None for v in legs.values()): return [ack("rejected", "unknown_location")]
            if not self.adapter.state()["ready"]: return [ack("rejected", "robot_not_ready")]
            self._remember(corr)
            self._active = {"correlationId": corr, "kind": "deliver", "leg": "pickup", "mode": p["mode"],
                            "pickup": legs["pickupLocationId"], "delivery": legs["destinationLocationId"], "standby": legs["standbyLocationId"]}
            self.adapter.start_goto(self._active["pickup"], self.now_ms())
            return [ack("accepted"), self._state_event(corr, "robot_en_route", {"leg": "pickup", "mode": p["mode"]})]
        loc = self.locations.get(p["locationId"])
        if loc is None: return [ack("rejected", "unknown_location")]
        if not self.adapter.state()["ready"]: return [ack("rejected", "robot_not_ready")]
        self._remember(corr)
        self.adapter.start_goto(loc, self.now_ms())
        self._active = {"correlationId": corr, "kind": "visit", "leg": "goto"}
        return [ack("accepted"), self._state_event(corr, "robot_en_route")]
```

`staff_event` in `handle()`:
```python
        if t == "staff_event":
            a = self._active
            if a is None or a["kind"] != "deliver" or a["correlationId"] != msg["correlationId"]: return []
            if msg["event"] == "staff_loaded" and a["leg"] == "await_loaded":
                a["leg"] = "delivery"; self.adapter.start_goto(a["delivery"], self.now_ms())
            elif msg["event"] == "received" and a["leg"] == "await_received":
                a["leg"] = "standby"; self.adapter.start_goto(a["standby"], self.now_ms())
            return []
```

`tick()` result handling (replace the tail after `result = self.adapter.poll(...)`):
```python
        a = self._active
        corr = a["correlationId"]
        if a["kind"] == "visit" or result.outcome != "arrived":
            self._active = None
            detail = {}
            if a["kind"] == "deliver": detail.update({"leg": a["leg"], "mode": a["mode"]})
            if result.reason: detail["reason"] = result.reason
            return [self._state_event(corr, result.outcome, detail or None)]
        # deliver + arrived
        if a["leg"] == "pickup":
            a["leg"] = "await_loaded"; return [self._state_event(corr, "arrived_pickup", {"leg": "pickup", "mode": a["mode"]})]
        if a["leg"] == "delivery":
            a["leg"] = "await_received"; return [self._state_event(corr, "arrived_delivery", {"leg": "delivery", "mode": a["mode"]})]
        self._active = None
        return [self._state_event(corr, "completed_leg", {"leg": "standby", "mode": a["mode"]})]
```
`cancel` while waiting (no goal on the adapter): in the `cancel` branch, if the active leg is `await_loaded`/`await_received`, clear `_active` and return `[self._state_event(corr, "cancelled", {...})]` directly, since the adapter has nothing to cancel. The `stop` branch already clears `_active` and emits `safety_stopped`; include the `leg`/`mode` detail when `kind == "deliver"`. Update `test_core.py::test_deliver_item_not_implemented_yet` to expect `accepted` now (rename it `test_deliver_item_is_accepted`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd robot_gateway && .venv/Scripts/python -m pytest -m "not hardware" -q`
Expected: all PASS (Plan 2's 27 + 7 new).

- [ ] **Step 5: Commit**

```bash
git add robot_gateway/gateway/core.py robot_gateway/tests/test_core_deliver.py robot_gateway/tests/test_core.py
git commit -m "feat(gateway): multi-leg deliver_item executor gated on staff events (tray mode)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 4: Device state carries the task; resident `delivery_arrived` screen wired

**Files:**
- Modify: `apps/api/src/routes/device.ts` — include the resident's most recent non-terminal task and set `screen = "delivery_arrived"` when it is in `placing`
- Modify: `apps/resident/src/screen.ts` (`DeviceState.task` typed), `apps/resident/src/App.tsx` (pass item label + `received` action to `DeliveryArrived`)
- Test: `apps/api/test/device.test.ts` (add cases), `apps/resident/test/App.test.tsx` (add case)

**Interfaces:**
- `GET /device/state` → `task: { id, state, item: { id, label } } | null`; `screen` precedence: `in_call` > `incoming` > `delivery_arrived` > `home` (a call in progress wins over a delivery notice; the tray stays until the call ends).
- Resident `DeliveryArrived` gets `itemLabel = task.item.label` and `onReceived` posts `/tasks/:id/received` then refreshes.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/test/device.test.ts`:

```ts
describe("GET /device/state with tasks", () => {
  async function taskIn(state: string) {
    const ctx = await makeTestApp();
    const id = (await ctx.app.inject({ method: "POST", url: "/tasks", headers: auth(ctx.tokens.family), payload: { residentId: SEED_IDS.resident, text: "water bottle" } })).json().task.id as string;
    ctx.db.update(t.taskRequest).set({ state }).where(eq(t.taskRequest.id, id)).run();
    return { ...ctx, id };
  }
  test("placing shows delivery_arrived with the item label", async () => {
    const { app, tokens, id } = await taskIn("placing");
    const res = await app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.device) });
    expect(res.json()).toMatchObject({ screen: "delivery_arrived", task: { id, state: "placing", item: { id: "water_bottle", label: "water bottle" } } });
  });
  test("an in-progress task that is not yet placing keeps the home screen", async () => {
    const { app, tokens } = await taskIn("navigating_to_delivery");
    expect((await app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.device) })).json().screen).toBe("home");
  });
  test("a call wins over a delivery notice", async () => {
    const { app, db, tokens } = await taskIn("placing");
    const v = (await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } })).json().visit.id;
    db.update(t.visitSession).set({ state: "active" }).where(eq(t.visitSession.id, v)).run();
    expect((await app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.device) })).json().screen).toBe("in_call");
  });
  test("device received completes the task", async () => {
    const { app, db, tokens, id } = await taskIn("placing");
    expect((await app.inject({ method: "POST", url: `/tasks/${id}/received`, headers: auth(tokens.device) })).json().task.state).toBe("completed");
    expect((await app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.device) })).json().task).toBeNull();
  });
});
```

Add to `apps/resident/test/App.test.tsx`:

```tsx
test("delivery arrived shows the item and 'I have it' posts received", async () => {
  const calls = installFetch((path) => {
    if (path === "/auth/device") return { status: 200, body: { token: "jwt", principal: {} } };
    if (path === "/device/state") return { status: 200, body: { ...base, screen: "delivery_arrived", visit: null, caller: null, task: { id: "t1", state: "placing", item: { id: "water_bottle", label: "water bottle" } } } };
    if (path === "/tasks/t1/received") return { status: 200, body: { task: { id: "t1", state: "completed" } } };
    return { status: 404, body: { error: "not_found" } };
  });
  render(<App apiBase="http://api" />);
  expect(await screen.findByText("Your water bottle is here")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "I have it" }));
  await waitFor(() => expect(calls.some((c) => c.path === "/tasks/t1/received" && c.method === "POST")).toBe(true));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/api/test/device.test.ts apps/resident/test/App.test.tsx`
Expected: the new cases FAIL (`task` is `null`; screen never `delivery_arrived`).

- [ ] **Step 3: Write the implementation**

`device.ts`: import `TASK_TERMINAL_STATES`; after loading `visit`, load `task = db.select().from(t.taskRequest).where(and(eq(residentId), notInArray(state, [...TASK_TERMINAL_STATES]))).orderBy(desc(t.taskRequest.createdAt)).get() ?? null`; `item = task ? db.select().from(t.item).where(eq(t.item.id, (task.proposal as { item: string }).item)).get() : null`; compute `screen`: `const visitScreen = screenForVisitState(visit?.state ?? null); const screen = visitScreen !== "home" ? visitScreen : task?.state === "placing" ? "delivery_arrived" : "home";` return `task: task ? { id: task.id, state: task.state, item: { id: item?.id ?? "", label: item?.label ?? "" } } : null`.

`apps/resident/src/screen.ts`: `task: { id: string; state: string; item: { id: string; label: string } } | null`.
`App.tsx`: `{screen === "delivery_arrived" && server?.task && <DeliveryArrived itemLabel={server.task.item.label} onReceived={async () => { try { await api.post(`/tasks/${server.task!.id}/received`); } catch {} void refresh(); }} />}`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/api/test/device.test.ts apps/resident && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/device.ts apps/api/test/device.test.ts apps/resident/src/screen.ts apps/resident/src/App.tsx apps/resident/test/App.test.tsx
git commit -m "feat(resident): delivery-arrived screen driven by task state; device received completes the task" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 5: Family "Ask the robot for help" — text or speech → clarification → confirmation → task progress

**Load the `frontend-design` skill first.**

**Files:**
- Create: `apps/family/src/components/AskRobot.tsx`, `apps/family/src/task-progress.ts`, `apps/family/src/speech-input.ts`
- Modify: `apps/family/src/pages/Visit.tsx` — enable the button; render `AskRobot` in a panel below the call; show the task stepper
- Modify: `packages/web-common/src/i18n/en.json` — add keys listed below
- Test: `apps/family/test/task-progress.test.ts`, `apps/family/test/AskRobot.test.tsx`

**Interfaces:**
- `task-progress.ts`: `TASK_STEPS = ["confirm", "approval", "pickup", "loading", "delivery", "handoff", "done"]`; `taskProgress(state)`: `awaiting_user_confirmation→0`, `awaiting_policy_or_staff→1`, `queued|navigating_to_pickup|locating_item→2`, `grasping|verifying_grasp→3`, `navigating_to_delivery→4`, `placing|verifying_delivery→5`, `completed→6`; failures: `rejected→1`, `clarification_required→0`, `item_not_found|grasp_failed→3`, `navigation_failed|operator_required→4`, `cancelled|safety_stopped→2`; `terminal` for completed and failures.
- `speech-input.ts`: `startDictation(lang, onResult: (text: string) => void, onEnd: () => void): { stop(): void } | null` — returns `null` when `window.SpeechRecognition ?? window.webkitSpeechRecognition` is absent. Single utterance, `interimResults = false`.
- `AskRobot({ api, residentId, visitId, residentName })` states: `idle` (text field + mic button if dictation is available + "Send") → `clarifying` (question + option chips; picking a chip re-posts with the option's label as text) → `confirming` (card "Send the robot with the **water bottle** to **Mom's bedside table**?" with Confirm / Cancel; Confirm → `POST /tasks/:id/confirm`) → `tracking` (task stepper, refetch on `/events` for that task id; Cancel visible until `queued`) → `rejected` (message from `family.task.rejected.<code>`; "Try again"). Utterance text is never sent anywhere but `POST /tasks`.
- i18n keys to add: `family.ask.placeholder` "Type what you need, e.g. \"bring the water bottle\"", `family.ask.send` "Send", `family.ask.speak` "Speak", `family.ask.listening` "Listening…", `family.ask.clarify.title` "Which one?", `family.ask.confirm.title` "Send the robot with the {item} to {destination}?", `family.ask.confirm.yes` "Yes, send the robot", `family.ask.confirm.no` "No", `family.ask.tryagain` "Try again", `family.task.step.confirm` "Confirm", `family.task.step.approval` "Care home approval", `family.task.step.pickup` "Robot to the station", `family.task.step.loading` "Item placed on the tray", `family.task.step.delivery` "On the way to {name}", `family.task.step.handoff` "Delivered", `family.task.step.done` "Done", `family.task.rejected.prohibited_item` "That item can't be delivered by the robot", `family.task.rejected.unknown_item` "That item isn't available", `family.task.rejected.unapproved_destination` "That place isn't allowed", `family.task.rejected.unauthorized_recipient` "You can't request this for that person", `family.task.rejected.staff_denied` "The care home declined this request", `family.task.failed.navigation_failed` "The robot could not reach its destination", `family.task.failed.operator_required` "The robot needs help from staff", `family.task.failed.safety_stopped` "The robot was stopped for safety", `family.task.failed.cancelled` "Cancelled", `family.task.cancel` "Cancel request", `item.water_bottle` "water bottle", `item.tissue_box` "tissue box", `item.tv_remote` "TV remote", `destination.bedside_table_demo` "{name}'s bedside table", `destination.delivery_tray_demo` "the delivery tray".

- [ ] **Step 1: Write the failing tests**

```ts
// apps/family/test/task-progress.test.ts
import { expect, test } from "vitest";
import { taskProgress } from "../src/task-progress";
test("happy path", () => {
  expect(taskProgress("awaiting_user_confirmation").currentIndex).toBe(0);
  expect(taskProgress("queued").currentIndex).toBe(2);
  expect(taskProgress("grasping").currentIndex).toBe(3);
  expect(taskProgress("placing").currentIndex).toBe(5);
  expect(taskProgress("completed")).toMatchObject({ currentIndex: 6, terminal: true, failed: null });
});
test("failures", () => {
  expect(taskProgress("rejected")).toMatchObject({ currentIndex: 1, failed: "rejected", terminal: true });
  expect(taskProgress("operator_required")).toMatchObject({ currentIndex: 4, failed: "operator_required" });
  expect(taskProgress("safety_stopped")).toMatchObject({ failed: "safety_stopped", terminal: true });
});
```

```tsx
// apps/family/test/AskRobot.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { AskRobot } from "../src/components/AskRobot";

class NoopSocket { onopen: any; onmessage: any; onclose: any; constructor(_u: string) {} close() {} }
beforeEach(() => vi.stubGlobal("WebSocket", NoopSocket));

function apiWith(handler: (path: string, body: any) => any) {
  return { get: vi.fn(async (p: string) => handler(p, null)), post: vi.fn(async (p: string, b?: any) => handler(p, b)) } as any;
}
const proposalTask = (state = "awaiting_user_confirmation") => ({ id: "t1", state, correlationId: "t1", proposal: { task_type: "deliver_item", item: "water_bottle", recipient: "r", destination: "bedside_table_demo", requires_confirmation: true } });

test("text -> clarification chips -> proposal card -> confirm -> tracking", async () => {
  let task = proposalTask();
  const api = apiWith((p, b) => {
    if (p === "/tasks" && b.text === "something") return { kind: "clarification", question: "Which item should the robot bring?", options: ["water_bottle", "tissue_box", "tv_remote"] };
    if (p === "/tasks") return { kind: "proposal", task };
    if (p === "/tasks/t1/confirm") { task = proposalTask("awaiting_policy_or_staff"); return { task }; }
    if (p === "/tasks/t1") return { task };
    throw new Error(p);
  });
  render(<AskRobot api={api} apiBase="http://api" token="jwt" residentId="r" visitId="v1" residentName="Mom" />);
  await userEvent.type(screen.getByPlaceholderText(/Type what you need/), "something");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText("Which one?")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "water bottle" }));
  expect(await screen.findByText("Send the robot with the water bottle to Mom's bedside table?")).toBeInTheDocument();
  expect(api.post).toHaveBeenLastCalledWith("/tasks", { residentId: "r", text: "water bottle", visitId: "v1" });
  await userEvent.click(screen.getByRole("button", { name: "Yes, send the robot" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith("/tasks/t1/confirm"));
  expect(await screen.findByText("Care home approval")).toHaveAttribute("aria-current", "step");
});

test("a policy rejection shows the reason and offers to try again", async () => {
  const api = apiWith((p) => p === "/tasks" ? { kind: "rejected", task: { ...proposalTask("rejected") }, code: "prohibited_item", reason: "x" } : {});
  render(<AskRobot api={api} apiBase="http://api" token="jwt" residentId="r" visitId="v1" residentName="Mom" />);
  await userEvent.type(screen.getByPlaceholderText(/Type what you need/), "medication");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText("That item can't be delivered by the robot")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByPlaceholderText(/Type what you need/)).toBeInTheDocument();
});

test("the Speak button is hidden when the browser has no SpeechRecognition", () => {
  render(<AskRobot api={apiWith(() => ({}))} apiBase="http://api" token="jwt" residentId="r" visitId="v1" residentName="Mom" />);
  expect(screen.queryByRole("button", { name: "Speak" })).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/family`
Expected: new tests FAIL — modules missing.

- [ ] **Step 3: Write the implementation**

```ts
// apps/family/src/task-progress.ts
export const TASK_STEPS = ["confirm", "approval", "pickup", "loading", "delivery", "handoff", "done"] as const;
export interface TaskProgress { steps: readonly (typeof TASK_STEPS)[number][]; currentIndex: number; failed: string | null; terminal: boolean }
const HAPPY: Record<string, number> = { draft: 0, parsed: 0, awaiting_user_confirmation: 0, awaiting_policy_or_staff: 1, queued: 2, navigating_to_pickup: 2, locating_item: 2, grasping: 3, verifying_grasp: 3, navigating_to_delivery: 4, placing: 5, verifying_delivery: 5, completed: 6 };
const FAILED: Record<string, number> = { rejected: 1, clarification_required: 0, item_not_found: 3, grasp_failed: 3, navigation_failed: 4, operator_required: 4, cancelled: 2, safety_stopped: 2 };
export function taskProgress(state: string): TaskProgress {
  if (state in FAILED) return { steps: TASK_STEPS, currentIndex: FAILED[state]!, failed: state, terminal: true };
  return { steps: TASK_STEPS, currentIndex: HAPPY[state] ?? 0, failed: null, terminal: state === "completed" };
}
```

```ts
// apps/family/src/speech-input.ts
type Recognition = { lang: string; interimResults: boolean; maxAlternatives: number; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: (() => void) | null; start(): void; stop(): void };
export function dictationAvailable(): boolean { const w = globalThis as any; return Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition); }
export function startDictation(lang: string, onResult: (text: string) => void, onEnd: () => void): { stop(): void } | null {
  const w = globalThis as any; const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) return null;
  const r: Recognition = new Ctor();
  r.lang = lang; r.interimResults = false; r.maxAlternatives = 1;
  r.onresult = (e) => { const text = e.results?.[0]?.[0]?.transcript; if (typeof text === "string") onResult(text); };
  r.onend = onEnd; r.onerror = onEnd;
  r.start();
  return { stop: () => r.stop() };
}
```

```tsx
// apps/family/src/components/AskRobot.tsx
import { useEffect, useState } from "react";
import { connectEvents, t, type Api } from "@oncare/web-common";
import { taskProgress, TASK_STEPS } from "../task-progress";
import { dictationAvailable, startDictation } from "../speech-input";

interface Task { id: string; state: string; correlationId: string; proposal: { item: string; destination: string } }
type Phase = { kind: "idle" } | { kind: "clarifying"; question: string; options: string[] } | { kind: "confirming"; task: Task } | { kind: "tracking"; task: Task } | { kind: "rejected"; code: string };
const STEP_KEY: Record<(typeof TASK_STEPS)[number], string> = { confirm: "family.task.step.confirm", approval: "family.task.step.approval", pickup: "family.task.step.pickup", loading: "family.task.step.loading", delivery: "family.task.step.delivery", handoff: "family.task.step.handoff", done: "family.task.step.done" };
const itemLabel = (id: string) => t(`item.${id}`) === `item.${id}` ? id.replace(/_/g, " ") : t(`item.${id}`);
const destLabel = (id: string, name: string) => t(`destination.${id}`, { name });

export function AskRobot({ api, apiBase, token, residentId, visitId, residentName }: { api: Api; apiBase: string; token: string; residentId: string; visitId: string; residentName: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (utterance: string) => {
    setError(null);
    try {
      const r = await api.post<any>("/tasks", { residentId, text: utterance, visitId });
      if (r.kind === "clarification") setPhase({ kind: "clarifying", question: r.question, options: r.options });
      else if (r.kind === "rejected") setPhase({ kind: "rejected", code: r.code });
      else setPhase({ kind: "confirming", task: r.task });
    } catch (e) { setError(String(e)); }
  };
  const confirm = async (task: Task) => {
    try { const r = await api.post<{ task: Task }>(`/tasks/${task.id}/confirm`); setPhase({ kind: "tracking", task: r.task }); } catch (e) { setError(String(e)); }
  };
  const speak = () => {
    const h = startDictation("en-US", (spoken) => { setText(spoken); void submit(spoken); }, () => setListening(false));
    if (h) setListening(true);
  };

  useEffect(() => {
    if (phase.kind !== "tracking") return;
    const id = phase.task.id;
    const refresh = () => api.get<{ task: Task }>(`/tasks/${id}`).then((r) => setPhase((p) => (p.kind === "tracking" && p.task.id === id ? { kind: "tracking", task: r.task } : p))).catch(() => {});
    const i = setInterval(refresh, 3000);
    const h = connectEvents(apiBase, token, (ev) => { if (ev.entityId === id) void refresh(); });
    return () => { clearInterval(i); h.close(); };
  }, [phase.kind === "tracking" ? phase.task.id : null, api, apiBase, token]);

  if (phase.kind === "idle") return (
    <form className="ask" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void submit(text.trim()); }}>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("family.ask.placeholder")} aria-label={t("family.ask.placeholder")} />
      <button type="submit" className="primary">{t("family.ask.send")}</button>
      {dictationAvailable() && <button type="button" onClick={speak} aria-pressed={listening}>{listening ? t("family.ask.listening") : t("family.ask.speak")}</button>}
      {error && <p role="alert" className="error">{error}</p>}
    </form>
  );
  if (phase.kind === "clarifying") return (
    <div className="ask ask--clarify"><h3>{t("family.ask.clarify.title")}</h3><p>{phase.question}</p>
      <div className="chips">{phase.options.map((o) => <button key={o} type="button" onClick={() => void submit(itemLabel(o))}>{itemLabel(o)}</button>)}</div>
      <button type="button" className="link" onClick={() => setPhase({ kind: "idle" })}>{t("family.ask.confirm.no")}</button></div>
  );
  if (phase.kind === "confirming") return (
    <div className="ask ask--confirm" role="dialog" aria-labelledby="ask-confirm-title">
      <h3 id="ask-confirm-title">{t("family.ask.confirm.title", { item: itemLabel(phase.task.proposal.item), destination: destLabel(phase.task.proposal.destination, residentName) })}</h3>
      <button type="button" className="primary" onClick={() => void confirm(phase.task)}>{t("family.ask.confirm.yes")}</button>
      <button type="button" onClick={() => { void api.post(`/tasks/${phase.task.id}/cancel`).catch(() => {}); setPhase({ kind: "idle" }); }}>{t("family.ask.confirm.no")}</button>
    </div>
  );
  if (phase.kind === "rejected") return (
    <div className="ask ask--rejected"><p role="alert">{t(`family.task.rejected.${phase.code}`)}</p><button type="button" onClick={() => { setText(""); setPhase({ kind: "idle" }); }}>{t("family.ask.tryagain")}</button></div>
  );
  const p = taskProgress(phase.task.state);
  return (
    <div className="ask ask--tracking">
      <ol className="stepper">{TASK_STEPS.map((s, i) => {
        const cls = i < p.currentIndex ? "done" : i === p.currentIndex ? (p.failed ? "failed" : "current") : "todo";
        return <li key={s} className={`step step--${cls}`} aria-current={i === p.currentIndex ? "step" : undefined}>{t(STEP_KEY[s], { name: residentName })}
          {i === p.currentIndex && p.failed && <p className="failed-reason">{t(`family.task.${p.failed === "rejected" ? "rejected.staff_denied" : `failed.${p.failed}`}`)}</p>}</li>;
      })}</ol>
      {!p.terminal && p.currentIndex < 2 && <button type="button" onClick={() => api.post(`/tasks/${phase.task.id}/cancel`).then(() => setPhase({ kind: "idle" })).catch(() => {})}>{t("family.task.cancel")}</button>}
      {p.terminal && <button type="button" onClick={() => { setText(""); setPhase({ kind: "idle" }); }}>{t("family.ask.tryagain")}</button>}
    </div>
  );
}
```

`Visit.tsx`: replace the disabled button with a toggle that shows `<AskRobot api={api} apiBase={apiBase} token={token} residentId={visit.residentId} visitId={visitId} residentName={residentName} />` while `visit.state` ∈ connecting|active (and also allow it after `completed` so a request can be made right after a call). Remove the tooltip.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/family packages/web-common && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/family packages/web-common/src/i18n/en.json
git commit -m "feat(family): ask-the-robot flow with clarification, confirmation card and task progress" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 6: Staff routes — queue, audit, robot stop/resume/standby, resident availability

> **Already present from Plan 2's final fix wave:** `apps/api/src/routes/robots.ts` with `GET /robots/:id/status`, `POST /robots/:id/stop` and `POST /robots/:id/resume` (PIN), plus `dispatch.sendStop(robotId, actorId)` / `dispatch.sendResume(robotId)`, and `dispatch.sweepExpired()`. Extend that file for `standby` and put the queue/audit/availability routes in `routes/staff.ts`; do not duplicate the stop/resume routes. Reuse the existing `robots.test.ts` and add cases rather than re-testing stop/resume.

**Files:**
- Create: `apps/api/src/routes/staff.ts`
- Modify: `apps/api/src/app.ts` — register `staffRoutes`
- Modify: `apps/api/src/services/dispatch.ts` — expose `sendStop(robotId, reason)`, `sendResume(robotId)`, `sendStandby(robotId)` (a `go_to_location` intent to the standby location, recorded as a `robot_command` with `correlationId = "standby_<uuid>"`, no visit/task)
- Test: `apps/api/test/staff.test.ts`

**Interfaces:**
```
GET  /queue   (staff) -> 200 {
   visitsAwaitingApproval: VisitRow[],            // state awaiting_policy_or_staff
   tasksAwaitingApproval: TaskRow[],              // awaiting_policy_or_staff
   tasksAwaitingLoad: TaskRow[],                  // locating_item
   tasksAwaitingHandoff: TaskRow[],               // placing
   activeVisits: Array<VisitRow & { streaming: boolean }>,   // connecting|active|ending; streaming = state in connecting|active
   caregiverCalls: AuditEvent[],                  // reason call_caregiver in the last 30 minutes
   robot: { robotId, connected, lastHeartbeat, lastSeenAt } }
GET  /audit?residentId=&since=&limit=   (staff) -> 200 { events: AuditEvent[] }   // newest first, default limit 200, max 1000
POST /robots/:id/stop     (staff) body { reason? } -> 200 { ok: true }; sends `stop`; any active task/visit command → task safety_stopped / visit safety_stopped via transitions with actor staff; audit row on entity robot reason "staff_stop"
POST /robots/:id/resume   (staff) body { pin }     -> 200 { ok: true } | 401 { error: "invalid_pin" }; verifies the caller's own pinHash; sends `resume`; audit "staff_resume"
POST /robots/:id/standby  (staff)                  -> 200 { ok: true } | 409 { error: "busy" } if a task or visit command is active; sends go_to_location standby; audit "standby"
PATCH /residents/:id/availability (staff) body { availability } -> 200 { resident } | 400
```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/staff.test.ts
import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import type { GatewayDown } from "@oncare/contracts";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS, SEED_SECRETS } from "../src/db/seed";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function setup() {
  const ctx = await makeTestApp();
  const sent: GatewayDown[] = [];
  ctx.app.hub.attach(SEED_IDS.robot, { send: (m) => { sent.push(m); } });
  return { ...ctx, sent };
}

describe("GET /queue", () => {
  test("lists the things staff must act on", async () => {
    const { app, db, tokens } = await setup();
    db.update(t.resident).set({ availability: "in_activity" }).where(eq(t.resident.id, SEED_IDS.resident)).run();
    const v = (await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } })).json().visit.id;
    const task = (await app.inject({ method: "POST", url: "/tasks", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident, text: "water" } })).json().task;
    await app.inject({ method: "POST", url: `/tasks/${task.id}/confirm`, headers: auth(tokens.family) });
    await app.inject({ method: "POST", url: "/device/call-caregiver", headers: auth(tokens.device) });
    const q = (await app.inject({ method: "GET", url: "/queue", headers: auth(tokens.staff) })).json();
    expect(q.visitsAwaitingApproval.map((x: any) => x.id)).toEqual([v]);
    expect(q.tasksAwaitingApproval.map((x: any) => x.id)).toEqual([task.id]);
    expect(q.tasksAwaitingLoad).toEqual([]);
    expect(q.caregiverCalls).toHaveLength(1);
    expect(q.robot).toMatchObject({ robotId: SEED_IDS.robot, connected: true });
  });

  test("active visits are flagged as streaming; family is 403", async () => {
    const { app, db, tokens } = await setup();
    const v = (await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } })).json().visit.id;
    db.update(t.visitSession).set({ state: "active" }).where(eq(t.visitSession.id, v)).run();
    const q = (await app.inject({ method: "GET", url: "/queue", headers: auth(tokens.staff) })).json();
    expect(q.activeVisits).toEqual([expect.objectContaining({ id: v, streaming: true })]);
    expect((await app.inject({ method: "GET", url: "/queue", headers: auth(tokens.family) })).statusCode).toBe(403);
  });
});

describe("robot controls", () => {
  test("stop sends stop, fails the active visit, audits; resume needs the staff PIN", async () => {
    const { app, db, sent, tokens } = await setup();
    const v = (await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } })).json().visit.id;
    app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: v, result: "accepted" });
    expect((await app.inject({ method: "POST", url: `/robots/${SEED_IDS.robot}/stop`, headers: auth(tokens.staff), payload: { reason: "hallway blocked" } })).json()).toEqual({ ok: true });
    expect(sent.at(-1)).toEqual({ type: "stop", reason: "staff_stop" });
    expect(db.select().from(t.visitSession).where(eq(t.visitSession.id, v)).get()?.state).toBe("safety_stopped");
    expect(db.select().from(t.auditEvent).all().at(-1)).toMatchObject({ entityType: "robot", entityId: SEED_IDS.robot, reason: "staff_stop", actorType: "staff" });
    expect((await app.inject({ method: "POST", url: `/robots/${SEED_IDS.robot}/resume`, headers: auth(tokens.staff), payload: { pin: "0000" } })).statusCode).toBe(401);
    expect(sent.at(-1)).toEqual({ type: "stop", reason: "staff_stop" });
    expect((await app.inject({ method: "POST", url: `/robots/${SEED_IDS.robot}/resume`, headers: auth(tokens.staff), payload: { pin: SEED_SECRETS.staffPin } })).json()).toEqual({ ok: true });
    expect(sent.at(-1)).toEqual({ type: "resume" });
  });

  test("standby sends a go_to_location intent when idle and 409 when a task is active", async () => {
    const { app, db, sent, tokens } = await setup();
    expect((await app.inject({ method: "POST", url: `/robots/${SEED_IDS.robot}/standby`, headers: auth(tokens.staff) })).json()).toEqual({ ok: true });
    expect(sent.at(-1)).toMatchObject({ type: "intent", intent: "go_to_location", payload: { locationId: SEED_IDS.standbyLocation } });
    expect(db.select().from(t.robotCommand).all().at(-1)?.correlationId).toMatch(/^standby_/);
    const task = (await app.inject({ method: "POST", url: "/tasks", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident, text: "water" } })).json().task;
    await app.inject({ method: "POST", url: `/tasks/${task.id}/confirm`, headers: auth(tokens.family) });
    await app.inject({ method: "POST", url: `/tasks/${task.id}/approve`, headers: auth(tokens.staff) });
    app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: task.correlationId, result: "accepted" });
    expect((await app.inject({ method: "POST", url: `/robots/${SEED_IDS.robot}/standby`, headers: auth(tokens.staff) })).statusCode).toBe(409);
  });
});

describe("GET /audit and PATCH availability", () => {
  test("audit is newest first, filterable by resident, capped", async () => {
    const { app, db, tokens } = await setup();
    await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } });
    const all = (await app.inject({ method: "GET", url: "/audit", headers: auth(tokens.staff) })).json().events;
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(new Date(all[0].at).getTime()).toBeGreaterThanOrEqual(new Date(all[1].at).getTime());
    const some = (await app.inject({ method: "GET", url: `/audit?residentId=${SEED_IDS.resident}&limit=1`, headers: auth(tokens.staff) })).json().events;
    expect(some).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/audit?residentId=nobody`, headers: auth(tokens.staff) })).json().events).toEqual([]);
    expect(db.select().from(t.auditEvent).all().every((e) => !JSON.stringify(e).includes("Demo Daughter"))).toBe(true);
  });

  test("staff sets availability; invalid value is 400", async () => {
    const { app, tokens } = await setup();
    expect((await app.inject({ method: "PATCH", url: `/residents/${SEED_IDS.resident}/availability`, headers: auth(tokens.staff), payload: { availability: "resting" } })).json().resident.availability).toBe("resting");
    expect((await app.inject({ method: "PATCH", url: `/residents/${SEED_IDS.resident}/availability`, headers: auth(tokens.staff), payload: { availability: "asleep" } })).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/staff.test.ts`
Expected: FAIL — routes 404.

- [ ] **Step 3: Write the implementation**

`dispatch.ts` additions:
```ts
function activeCommand(robotId: string) {
  // a command is active when acked "accepted" and its visit/task is in a non-terminal state
  const cmds = db.select().from(t.robotCommand).where(and(eq(t.robotCommand.robotId, robotId), eq(t.robotCommand.result, "accepted"))).all();
  for (const c of cmds) {
    if (c.visitId) { const v = db.select().from(t.visitSession).where(eq(t.visitSession.id, c.visitId)).get(); if (v && !VISIT_TERMINAL_STATES.includes(v.state as VisitState)) return c; }
    if (c.taskId) { const k = db.select().from(t.taskRequest).where(eq(t.taskRequest.id, c.taskId)).get(); if (k && !TASK_TERMINAL_STATES.includes(k.state as TaskState)) return c; }
  }
  return null;
}
function sendStop(robotId: string, actorId: string, reason: string) {
  hub.send(robotId, { type: "stop", reason: "staff_stop" });
  const c = activeCommand(robotId);
  if (c?.visitId) staffApply("visit", c.visitId, "safety_stopped", actorId, reason);
  if (c?.taskId) staffApply("task", c.taskId, "safety_stopped", actorId, reason);
}
function sendResume(robotId: string) { hub.send(robotId, { type: "resume" }); }
function sendStandby(robotId: string): "sent" | "busy" | "offline" {
  if (activeCommand(robotId)) return "busy";
  const standby = db.select().from(t.location).where(and(eq(t.location.kind, "standby"), eq(t.location.approved, true))).get();
  if (!standby) return "offline";
  const issuedAt = now(); const corr = `standby_${randomUUID()}`;
  const intent: Intent = { type: "intent", intent: "go_to_location", correlationId: corr, expiresAt: new Date(issuedAt.getTime() + ttl).toISOString(), payload: { locationId: standby.id } };
  db.insert(t.robotCommand).values({ id: id(), robotId, visitId: null, taskId: null, correlationId: corr, intent, issuedAt: issuedAt.toISOString(), expiresAt: intent.expiresAt, ackedAt: null, result: null }).run();
  return hub.send(robotId, intent) ? "sent" : "offline";
}
```
where `staffApply` is `robotApply` with `actorType: "staff"`. Return them from `createDispatchService`. In `onUp`, commands without visit/task (standby) only update `ackedAt/result`.

```ts
// apps/api/src/routes/staff.ts
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import { makeTransitionEvent } from "@oncare/core";
import { requireRole } from "../auth/plugin";
import { verifySecret } from "../auth/password";
import type { Db } from "../db/client";
import * as t from "../db/schema";

export async function staffRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  const staffOnly = { preHandler: requireRole("staff") };
  const audit = (actorId: string, robotId: string, reason: string) =>
    db.insert(t.auditEvent).values(makeTransitionEvent({ actorType: "staff", actorId, entityType: "robot", entityId: robotId, fromState: null, toState: null, reason, correlationId: robotId })).run();

  app.get("/queue", staffOnly, async () => {
    const robot = db.select().from(t.robot).get();
    const since = new Date(Date.now() - 30 * 60_000).toISOString();
    const visits = db.select().from(t.visitSession).all();
    const tasks = db.select().from(t.taskRequest).all();
    return {
      visitsAwaitingApproval: visits.filter((v) => v.state === "awaiting_policy_or_staff"),
      tasksAwaitingApproval: tasks.filter((k) => k.state === "awaiting_policy_or_staff"),
      tasksAwaitingLoad: tasks.filter((k) => k.state === "locating_item"),
      tasksAwaitingHandoff: tasks.filter((k) => k.state === "placing"),
      activeVisits: visits.filter((v) => ["connecting", "active", "ending"].includes(v.state)).map((v) => ({ ...v, streaming: v.state === "connecting" || v.state === "active" })),
      caregiverCalls: db.select().from(t.auditEvent).where(and(eq(t.auditEvent.reason, "call_caregiver"), gte(t.auditEvent.at, since))).orderBy(desc(t.auditEvent.at)).all(),
      robot: robot ? { robotId: robot.id, ...app.hub.status(robot.id) } : null,
    };
  });

  app.get("/audit", staffOnly, async (req) => {
    const q = z.object({ residentId: z.string().optional(), since: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }).parse(req.query);
    let rows = db.select().from(t.auditEvent).orderBy(desc(t.auditEvent.at)).all();
    if (q.since) rows = rows.filter((e) => e.at >= q.since!);
    if (q.residentId) {
      const visitIds = new Set(db.select({ id: t.visitSession.id }).from(t.visitSession).where(eq(t.visitSession.residentId, q.residentId)).all().map((r) => r.id));
      const taskIds = new Set(db.select({ id: t.taskRequest.id }).from(t.taskRequest).where(eq(t.taskRequest.residentId, q.residentId)).all().map((r) => r.id));
      rows = rows.filter((e) => (e.entityType === "visit" && visitIds.has(e.entityId)) || (e.entityType === "task" && taskIds.has(e.entityId)));
    }
    return { events: rows.slice(0, q.limit) };
  });

  app.post("/robots/:id/stop", staffOnly, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!db.select().from(t.robot).where(eq(t.robot.id, id)).get()) return reply.code(404).send({ error: "not_found" });
    app.dispatch.sendStop(id, req.principal.id, "staff_stop");
    audit(req.principal.id, id, "staff_stop");
    return { ok: true };
  });

  app.post("/robots/:id/resume", staffOnly, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ pin: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const me = db.select().from(t.user).where(eq(t.user.id, req.principal.id)).get();
    if (!me?.pinHash || !(await verifySecret(body.data.pin, me.pinHash))) { audit(req.principal.id, id, "staff_resume_failed"); return reply.code(401).send({ error: "invalid_pin" }); }
    app.dispatch.sendResume(id);
    audit(req.principal.id, id, "staff_resume");
    return { ok: true };
  });

  app.post("/robots/:id/standby", staffOnly, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = app.dispatch.sendStandby(id);
    if (r === "busy") return reply.code(409).send({ error: "busy" });
    audit(req.principal.id, id, "standby");
    return { ok: true, delivered: r === "sent" };
  });

  app.patch("/residents/:id/availability", staffOnly, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ availability: z.enum(["available", "in_activity", "resting", "not_available"]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    db.update(t.resident).set({ availability: body.data.availability }).where(eq(t.resident.id, id)).run();
    const resident = db.select().from(t.resident).where(eq(t.resident.id, id)).get();
    if (!resident) return reply.code(404).send({ error: "not_found" });
    return { resident };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/api && npx tsc -b`
Expected: PASS (7 new).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/staff.ts apps/api/src/services/dispatch.ts apps/api/src/app.ts apps/api/test/staff.test.ts
git commit -m "feat(api): staff queue, audit query, robot stop/resume/standby, resident availability" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 7: Staff console app (`apps/staff`)

**Load the `frontend-design` skill first.** Calm and legible under stress: large STOP, clear "streaming now" list, nothing decorative.

**Files:**
- Create: `apps/staff/index.html`, `package.json` (port 5175), `tsconfig.json`, `vite.config.ts`, `src/main.tsx`, `src/App.tsx`, `src/pages/Login.tsx`, `src/pages/Console.tsx`, `src/components/Queue.tsx`, `src/components/RobotPanel.tsx`, `src/components/Streaming.tsx`, `src/components/AuditTable.tsx`, `src/styles.css`
- Modify: root `package.json` `dev` script — add the staff app; root `tsconfig.json` references
- Modify: `packages/web-common/src/i18n/en.json` — `staff.*` keys below
- Test: `apps/staff/test/App.test.tsx`

**Interfaces / behaviour:**
- Login reuses the family login form logic but requires `principal.role === "staff"` (otherwise shows `staff.login.not_staff`).
- `Console` polls `GET /queue` every 3 s and refetches on any `/events` message. Three columns + footer as the spec: **Pending** (visit approve/deny buttons; task approve/deny; "Loaded on tray" for `tasksAwaitingLoad`; "Received" for `tasksAwaitingHandoff`; caregiver calls with resident id and time), **Robot** (connected/ready pills, adapter badge `SIMULATED ROBOT` when mock, pose, nav state, e-stop, battery, current correlation id; large red STOP → `POST /robots/:id/stop`; "Release stop" opens a PIN prompt → `/resume`; "Return to standby" → `/standby`, disabled when busy), **Streaming now** (each `activeVisits` row: resident id, requester id, state, "End call" → `/visits/:id/end`), footer **Audit** (last 200 rows from `/audit`, filter by resident id text box, "Export CSV" builds a Blob client-side from the loaded rows).
- i18n keys: `staff.login.title` "Staff sign in", `staff.login.not_staff` "This account is not a staff account", `staff.queue.title` "Pending", `staff.queue.visit` "Visit request", `staff.queue.task` "Delivery request", `staff.queue.approve` "Approve", `staff.queue.deny` "Deny", `staff.queue.loaded` "Loaded on tray", `staff.queue.received` "Received", `staff.queue.caregiver` "Caregiver call", `staff.queue.empty` "Nothing pending", `staff.robot.title` "Robot", `staff.robot.connected` "Connected", `staff.robot.disconnected` "Offline", `staff.robot.ready` "Ready", `staff.robot.not_ready` "Not ready", `staff.robot.stop` "STOP ROBOT", `staff.robot.release` "Release stop", `staff.robot.standby` "Return to standby", `staff.robot.pin` "Staff PIN", `staff.robot.simulated` "SIMULATED ROBOT", `staff.streaming.title` "Streaming now", `staff.streaming.end` "End call", `staff.streaming.none` "No robot is streaming", `staff.audit.title` "Audit log", `staff.audit.filter` "Resident id", `staff.audit.export` "Export CSV".

- [ ] **Step 1: Write the failing test**

```tsx
// apps/staff/test/App.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { App } from "../src/App";

type Handler = (path: string, init?: RequestInit) => { status: number; body: unknown };
function installFetch(handler: Handler) {
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace("http://api", ""); calls.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: String(init.body) } : {}) });
    const r = handler(path, init); return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }));
  return calls;
}
class NoopSocket { onopen: any; onmessage: any; onclose: any; constructor(_u: string) {} close() {} }
beforeEach(() => { try { sessionStorage.setItem("oncare.staff", JSON.stringify({ token: "jwt", displayName: "Demo Nurse" })); } catch {} vi.stubGlobal("WebSocket", NoopSocket); });

const queue = {
  visitsAwaitingApproval: [{ id: "v1", residentId: "resident_demo_01", requesterId: "family_demo_01", state: "awaiting_policy_or_staff" }],
  tasksAwaitingApproval: [], tasksAwaitingLoad: [{ id: "t1", residentId: "resident_demo_01", state: "locating_item", proposal: { item: "water_bottle" } }], tasksAwaitingHandoff: [],
  activeVisits: [{ id: "v2", residentId: "resident_demo_01", requesterId: "family_demo_01", state: "active", streaming: true }],
  caregiverCalls: [],
  robot: { robotId: "robot_demo_01", connected: true, lastHeartbeat: { robotReady: true, adapter: "mock", pose: { x: 1, y: 2, yaw: 0 }, navState: "idle", estop: false, battery: "unknown", activeCorrelationId: null }, lastSeenAt: "2026-09-17T00:00:00.000Z" },
};

test("staff console shows pending items, robot state, streaming list; approve, load, stop and end work", async () => {
  const calls = installFetch((path) => {
    if (path === "/queue") return { status: 200, body: queue };
    if (path === "/audit") return { status: 200, body: { events: [] } };
    if (path.startsWith("/visits/v1/approve") || path.startsWith("/tasks/t1/loaded") || path.startsWith("/robots/robot_demo_01/stop") || path.startsWith("/visits/v2/end")) return { status: 200, body: { ok: true } };
    return { status: 404, body: {} };
  });
  render(<App apiBase="http://api" />);
  expect(await screen.findByText("Visit request")).toBeInTheDocument();
  expect(screen.getByText("SIMULATED ROBOT")).toBeInTheDocument();
  expect(screen.getByText("Ready")).toBeInTheDocument();
  await userEvent.click(screen.getAllByRole("button", { name: "Approve" })[0]!);
  await userEvent.click(screen.getByRole("button", { name: "Loaded on tray" }));
  await userEvent.click(screen.getByRole("button", { name: "STOP ROBOT" }));
  await userEvent.click(screen.getByRole("button", { name: "End call" }));
  await waitFor(() => {
    const posts = calls.filter((c) => c.method === "POST").map((c) => c.path);
    expect(posts).toEqual(expect.arrayContaining(["/visits/v1/approve", "/tasks/t1/loaded", "/robots/robot_demo_01/stop", "/visits/v2/end"]));
  });
});

test("release stop asks for the PIN and posts it", async () => {
  const calls = installFetch((path) => path === "/queue" ? { status: 200, body: queue } : path === "/audit" ? { status: 200, body: { events: [] } } : { status: 200, body: { ok: true } });
  render(<App apiBase="http://api" />);
  await userEvent.click(await screen.findByRole("button", { name: "Release stop" }));
  await userEvent.type(screen.getByLabelText("Staff PIN"), "2468{enter}");
  await waitFor(() => expect(calls.find((c) => c.path === "/robots/robot_demo_01/resume")?.body).toBe(JSON.stringify({ pin: "2468" })));
});

test("a family account cannot use the console", async () => {
  try { sessionStorage.clear(); } catch {}
  installFetch((path) => path === "/auth/login" ? { status: 200, body: { token: "jwt", principal: { kind: "user", id: "f", role: "family", displayName: "Fam" } } } : { status: 403, body: {} });
  render(<App apiBase="http://api" />);
  await userEvent.type(screen.getByLabelText("Username"), "family");
  await userEvent.type(screen.getByLabelText("Password"), "x");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByText("This account is not a staff account")).toBeInTheDocument();
});
```

- [ ] **Step 2: Scaffold and run to verify failure**

Mirror `apps/family` scaffolding with name `@oncare/staff`, dev port 5175, title "OnCare Staff". Add to root `dev` script and `tsconfig.json`. `npm install --no-audit --no-fund`, then `npx vitest run apps/staff` → FAIL (modules missing).

- [ ] **Step 3: Write the implementation**

`App.tsx`: session in `sessionStorage` key `oncare.staff`; `Login` identical to the family one but after login checks `principal.role === "staff"` else shows `staff.login.not_staff` and does not store. `Console` receives `api`, `apiBase`, `token`.

```tsx
// apps/staff/src/pages/Console.tsx
import { useCallback, useEffect, useState } from "react";
import { connectEvents, t, type Api } from "@oncare/web-common";
import { Queue } from "../components/Queue";
import { RobotPanel } from "../components/RobotPanel";
import { Streaming } from "../components/Streaming";
import { AuditTable } from "../components/AuditTable";
export function Console({ api, apiBase, token }: { api: Api; apiBase: string; token: string }) {
  const [queue, setQueue] = useState<any>(null);
  const refresh = useCallback(() => api.get<any>("/queue").then(setQueue).catch(() => {}), [api]);
  useEffect(() => { void refresh(); const i = setInterval(() => void refresh(), 3000); const h = connectEvents(apiBase, token, () => void refresh()); return () => { clearInterval(i); h.close(); }; }, [apiBase, token, refresh]);
  const post = (path: string, body?: unknown) => api.post(path, body).then(() => void refresh()).catch(() => void refresh());
  if (!queue) return <main className="console"><p>…</p></main>;
  return (
    <main className="console">
      <section className="col col--queue"><h2>{t("staff.queue.title")}</h2><Queue queue={queue} onAction={post} /></section>
      <section className="col col--robot"><h2>{t("staff.robot.title")}</h2><RobotPanel robot={queue.robot} onStop={() => post(`/robots/${queue.robot.robotId}/stop`)} onResume={(pin) => post(`/robots/${queue.robot.robotId}/resume`, { pin })} onStandby={() => post(`/robots/${queue.robot.robotId}/standby`)} /></section>
      <section className="col col--streaming"><h2>{t("staff.streaming.title")}</h2><Streaming visits={queue.activeVisits} onEnd={(id) => post(`/visits/${id}/end`)} /></section>
      <footer className="audit"><h2>{t("staff.audit.title")}</h2><AuditTable api={api} /></footer>
    </main>
  );
}
```

```tsx
// apps/staff/src/components/Queue.tsx
import { t } from "@oncare/web-common";
export function Queue({ queue, onAction }: { queue: any; onAction: (path: string) => void }) {
  const rows: Array<{ key: string; label: string; meta: string; actions: Array<[string, string]> }> = [
    ...queue.visitsAwaitingApproval.map((v: any) => ({ key: v.id, label: t("staff.queue.visit"), meta: v.residentId, actions: [[t("staff.queue.approve"), `/visits/${v.id}/approve`], [t("staff.queue.deny"), `/visits/${v.id}/deny`]] })),
    ...queue.tasksAwaitingApproval.map((k: any) => ({ key: k.id, label: t("staff.queue.task"), meta: `${k.residentId} · ${k.proposal?.item ?? ""}`, actions: [[t("staff.queue.approve"), `/tasks/${k.id}/approve`], [t("staff.queue.deny"), `/tasks/${k.id}/deny`]] })),
    ...queue.tasksAwaitingLoad.map((k: any) => ({ key: k.id, label: t("staff.queue.task"), meta: `${k.residentId} · ${k.proposal?.item ?? ""}`, actions: [[t("staff.queue.loaded"), `/tasks/${k.id}/loaded`]] })),
    ...queue.tasksAwaitingHandoff.map((k: any) => ({ key: k.id, label: t("staff.queue.task"), meta: `${k.residentId} · ${k.proposal?.item ?? ""}`, actions: [[t("staff.queue.received"), `/tasks/${k.id}/received`]] })),
    ...queue.caregiverCalls.map((e: any) => ({ key: e.id, label: t("staff.queue.caregiver"), meta: `${e.correlationId} · ${new Date(e.at).toLocaleTimeString()}`, actions: [] })),
  ];
  if (rows.length === 0) return <p className="empty">{t("staff.queue.empty")}</p>;
  return <ul className="queue">{rows.map((r) => <li key={r.key} className="queue-row"><div><strong>{r.label}</strong><span className="meta">{r.meta}</span></div><div className="row-actions">{r.actions.map(([label, path]) => <button key={path} type="button" onClick={() => onAction(path)}>{label}</button>)}</div></li>)}</ul>;
}
```

```tsx
// apps/staff/src/components/RobotPanel.tsx
import { useState } from "react";
import { t } from "@oncare/web-common";
export function RobotPanel({ robot, onStop, onResume, onStandby }: { robot: any; onStop: () => void; onResume: (pin: string) => void; onStandby: () => void }) {
  const [askPin, setAskPin] = useState(false); const [pin, setPin] = useState("");
  const hb = robot?.lastHeartbeat;
  return (
    <div className="robot-panel">
      <div className="pills">
        <span className={`pill ${robot?.connected ? "pill--ok" : "pill--bad"}`}>{t(robot?.connected ? "staff.robot.connected" : "staff.robot.disconnected")}</span>
        <span className={`pill ${hb?.robotReady ? "pill--ok" : "pill--warn"}`}>{t(hb?.robotReady ? "staff.robot.ready" : "staff.robot.not_ready")}</span>
        {hb?.adapter === "mock" && <span className="badge-sim">{t("staff.robot.simulated")}</span>}
      </div>
      <dl className="robot-facts">
        <dt>nav</dt><dd>{hb?.navState ?? "—"}</dd><dt>e-stop</dt><dd>{String(hb?.estop ?? "—")}</dd><dt>battery</dt><dd>{String(hb?.battery ?? "—")}</dd>
        <dt>pose</dt><dd>{hb?.pose ? `${hb.pose.x.toFixed(2)}, ${hb.pose.y.toFixed(2)}` : "—"}</dd><dt>task</dt><dd>{hb?.activeCorrelationId ?? "—"}</dd>
      </dl>
      <button type="button" className="stop" onClick={onStop}>{t("staff.robot.stop")}</button>
      {!askPin ? <button type="button" onClick={() => setAskPin(true)}>{t("staff.robot.release")}</button> : (
        <form onSubmit={(e) => { e.preventDefault(); onResume(pin); setPin(""); setAskPin(false); }}>
          <label htmlFor="staff-pin">{t("staff.robot.pin")}</label><input id="staff-pin" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} autoFocus />
        </form>
      )}
      <button type="button" onClick={onStandby} disabled={Boolean(hb?.activeCorrelationId)}>{t("staff.robot.standby")}</button>
    </div>
  );
}
```

```tsx
// apps/staff/src/components/Streaming.tsx
import { t } from "@oncare/web-common";
export function Streaming({ visits, onEnd }: { visits: any[]; onEnd: (id: string) => void }) {
  const live = visits.filter((v) => v.streaming);
  if (live.length === 0) return <p className="empty">{t("staff.streaming.none")}</p>;
  return <ul className="streaming">{live.map((v) => <li key={v.id} className="streaming-row"><span className="dot" aria-hidden="true">●</span><span>{v.residentId} ⇄ {v.requesterId} · {v.state}</span><button type="button" onClick={() => onEnd(v.id)}>{t("staff.streaming.end")}</button></li>)}</ul>;
}
```

```tsx
// apps/staff/src/components/AuditTable.tsx
import { useEffect, useState } from "react";
import { t, type Api } from "@oncare/web-common";
export function AuditTable({ api }: { api: Api }) {
  const [rows, setRows] = useState<any[]>([]); const [resident, setResident] = useState("");
  useEffect(() => { const q = resident ? `?residentId=${encodeURIComponent(resident)}` : ""; api.get<{ events: any[] }>(`/audit${q}`).then((r) => setRows(r.events)).catch(() => {}); }, [api, resident]);
  const exportCsv = () => {
    const header = ["at", "actorType", "actorId", "entityType", "entityId", "fromState", "toState", "reason", "correlationId"];
    const csv = [header.join(","), ...rows.map((r) => header.map((h) => JSON.stringify(r[h] ?? "")).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); const a = document.createElement("a"); a.href = url; a.download = "audit.csv"; a.click(); URL.revokeObjectURL(url);
  };
  return (
    <div className="audit-table">
      <div className="audit-controls"><label htmlFor="audit-resident">{t("staff.audit.filter")}</label><input id="audit-resident" value={resident} onChange={(e) => setResident(e.target.value)} /><button type="button" onClick={exportCsv}>{t("staff.audit.export")}</button></div>
      <table><thead><tr><th>at</th><th>actor</th><th>entity</th><th>from</th><th>to</th><th>reason</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td>{new Date(r.at).toLocaleTimeString()}</td><td>{r.actorType}:{r.actorId}</td><td>{r.entityType}:{r.entityId}</td><td>{r.fromState ?? ""}</td><td>{r.toState ?? ""}</td><td>{r.reason ?? ""}</td></tr>)}</tbody></table>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/staff && npx vitest run && npx tsc -b`
Expected: PASS (3 new); everything green.

- [ ] **Step 5: Commit**

```bash
git add apps/staff packages/web-common/src/i18n/en.json package.json package-lock.json tsconfig.json
git commit -m "feat(staff): console with pending queue, robot panel (stop/resume/standby), streaming list and audit export" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 8: End-to-end task test and demo doc

**Files:**
- Test: `apps/api/test/e2e-task.test.ts`
- Create: `docs/demo-task-flow.md`

- [ ] **Step 1: Write the test**

```ts
// apps/api/test/e2e-task.test.ts
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

/** Scripted tray-mode gateway: navigates instantly, waits for staff events exactly like GatewayCore. */
function trayGateway(url: string, token: string) {
  const ws = new WebSocket(`${url.replace("http", "ws")}/gateway?token=${token}`);
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  const now = () => new Date().toISOString();
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "intent" && m.intent === "deliver_item") { send({ type: "ack", correlationId: m.correlationId, result: "accepted" }); setTimeout(() => send({ type: "state_event", correlationId: m.correlationId, at: now(), event: "arrived_pickup", detail: { leg: "pickup", mode: "tray" } }), 30); }
    if (m.type === "staff_event" && m.event === "staff_loaded") setTimeout(() => send({ type: "state_event", correlationId: m.correlationId, at: now(), event: "arrived_delivery", detail: { leg: "delivery", mode: "tray" } }), 30);
    if (m.type === "staff_event" && m.event === "received") setTimeout(() => send({ type: "state_event", correlationId: m.correlationId, at: now(), event: "completed_leg", detail: { leg: "standby", mode: "tray" } }), 30);
  });
  return new Promise<WebSocket>((resolve) => ws.once("open", () => resolve(ws)));
}

describe("end-to-end item delivery (handover section 8, steps 6-11, tray mode)", () => {
  test("speech text -> proposal -> confirm -> approve -> pickup -> loaded -> delivery -> received -> completed", async () => {
    const { app, db, tokens } = await makeTestApp();
    const srv = await listen(app); closers.push(srv.close);
    const gw = await trayGateway(srv.url, SEED_SECRETS.robotToken);
    const created = await app.inject({ method: "POST", url: "/tasks", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident, text: "Could you bring Mom the water bottle?" } });
    expect(created.json().kind).toBe("proposal");
    const id = created.json().task.id as string;
    const state = () => db.select().from(t.taskRequest).where(eq(t.taskRequest.id, id)).get()!.state;
    await app.inject({ method: "POST", url: `/tasks/${id}/confirm`, headers: auth(tokens.family) });
    await app.inject({ method: "POST", url: `/tasks/${id}/approve`, headers: auth(tokens.staff) });
    await settle(); await settle();
    expect(state()).toBe("locating_item");
    await app.inject({ method: "POST", url: `/tasks/${id}/loaded`, headers: auth(tokens.staff) });
    await settle(); await settle();
    expect(state()).toBe("placing");
    expect((await app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.device) })).json().screen).toBe("delivery_arrived");
    await app.inject({ method: "POST", url: `/tasks/${id}/received`, headers: auth(tokens.device) });
    await settle(); await settle();
    expect(state()).toBe("completed");
    const trail = db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, id)).all();
    expect(trail.map((e) => e.toState)).toEqual(["parsed", "awaiting_user_confirmation", "awaiting_policy_or_staff", "queued", "navigating_to_pickup", "locating_item", "grasping", "verifying_grasp", "navigating_to_delivery", "placing", "verifying_delivery", "completed"]);
    expect(trail.map((e) => e.actorType)).toEqual(["system", "system", "family", "staff", "robot", "robot", "staff", "staff", "staff", "robot", "device", "device"]);
    gw.close();
  });

  test("zero physical executions without confirmation: approving an unconfirmed task never reaches the robot", async () => {
    const { app, db, tokens } = await makeTestApp();
    const srv = await listen(app); closers.push(srv.close);
    const seen: any[] = [];
    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/gateway?token=${SEED_SECRETS.robotToken}`);
    ws.on("message", (d) => seen.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.once("open", r));
    const id = (await app.inject({ method: "POST", url: "/tasks", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident, text: "tissue box" } })).json().task.id;
    expect((await app.inject({ method: "POST", url: `/tasks/${id}/approve`, headers: auth(tokens.staff) })).statusCode).toBe(409);
    await settle();
    expect(seen.filter((m) => m.type === "intent")).toEqual([]);
    expect(db.select().from(t.robotCommand).all()).toEqual([]);
    ws.close();
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run apps/api/test/e2e-task.test.ts && npx vitest run && npx tsc -b && (cd robot_gateway && .venv/Scripts/python -m pytest -m "not hardware" -q)`
Expected: all green. If the first test fails, the failing assertion names the layer; fix the owning file and describe it in the report.

- [ ] **Step 3: Write `docs/demo-task-flow.md`**

Numbered click-through for handover section 8 steps 6–11 with four screens (family phone, resident iPad, staff console, mock gateway log): what to type/say, what each screen shows at each step, the expected 12-entry audit trail, and the two failure demos (staff STOP mid-delivery → family sees "The robot was stopped for safety", staff releases with PIN; a "bring her medication" request → "That item can't be delivered by the robot" and a `rejected` audit row with reason `prohibited_item`).

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/e2e-task.test.ts docs/demo-task-flow.md
git commit -m "test(api): end-to-end tray-mode delivery and the no-execution-without-confirmation guard; demo doc" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

## Plan self-review

**Spec coverage (Plan 5):** §2 task routes (Tasks 1–2), staff routes (Task 6), device `received` (Task 4); §3 `deliver_item` translation with `arrived_pickup`/`staff_loaded`/`arrived_delivery`/`received`/standby and `stop` without auto-resume (Tasks 3, 6); §1 tray table (Tasks 2–4); §4 family "Ask the robot" with text and Web Speech, confirmation card, progress with failure reasons (Task 5); §4 staff console three columns + audit footer + CSV (Task 7); §5 audit IDs only (Tasks 1–2 tests assert no utterance/name leakage); handover section 8 steps 6–11 (Task 8).

**Placeholder scan:** none.

**Type consistency:** `TaskAction`/`TASK_ACTIONS` (Task 2 ↔ routes); `robot_command.correlationId` column (Task 2 migration ↔ dispatch ↔ Task 6 standby); `STATE_EVENT_TO_TASK` keys ⊂ `STATE_EVENTS` (contracts); gateway `detail.leg/mode` (Task 3 ↔ Task 8 scripted gateway); `GET /device/state.task.item.label` (Task 4 ↔ resident App); `/queue` shape (Task 6 ↔ Task 7 `Queue`/`RobotPanel`/`Streaming`); i18n keys added in Tasks 5 and 7 before use.
