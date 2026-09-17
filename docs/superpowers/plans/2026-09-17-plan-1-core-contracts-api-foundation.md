# Plan 1: Core Completion, Contracts Package, API Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the pure domain package (audit events, keyword parser), define the Gateway ↔ API message contracts once for both TypeScript and Python, and stand up the API with a database, synthetic seed data, three-identity authentication, and the single state-transition writer.

**Architecture:** `packages/core` stays pure (no I/O). `packages/contracts` holds zod schemas and emits JSON Schema files into `robot_gateway/schema/` so the Python side validates the same shapes. `apps/api` is Fastify + Drizzle on SQLite; every state change goes through one `applyTransition()` that writes the audit row in the same transaction.

**Tech Stack:** TypeScript 5, Node 24, npm workspaces, vitest, zod 3, zod-to-json-schema, Fastify 5, @fastify/jwt, drizzle-orm + better-sqlite3 (fallback: @libsql/client), tsx for dev runs.

**Spec:** `docs/superpowers/specs/2026-09-17-oncare-platform-design.md` (sections 1, 2, 4 "Intent parsing", 5 "Audit")

## Global Constraints

- ESM everywhere (`"type": "module"`); TypeScript `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` (from `tsconfig.base.json`).
- Tests run with `npx vitest run <path>` from the repo root; the root `vitest.config.ts` includes `packages/*/test/**/*.test.ts` and `apps/*/test/**/*.test.ts`.
- Synthetic demo data only. IDs like `resident_demo_01`; never real names, room numbers, or credentials in code or fixtures.
- Audit rows contain IDs only: no names, no utterance text.
- Identifiers exchanged with the robot are lowercase snake_case (`IdentifierSchema` in `packages/core/src/intent.ts`).
- `requires_confirmation` is always literally `true` on a `TaskProposal`.
- Commit after every task with the attribution trailer used in this repo:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC
  ```
- Do not modify anything under `D:/ontaru/AGI carehouse/on_software_all`.

## File structure produced by this plan

```
packages/core/src/
  audit.ts                 AuditEvent type + schema + makeTransitionEvent()
  parser/types.ts          IntentParser interface, ParseContext, ParseOutcome
  parser/keyword.ts        KeywordParser implementation
  index.ts                 public exports
packages/contracts/
  package.json, tsconfig.json
  src/gateway.ts           zod schemas for /gateway messages (down + up)
  src/index.ts
  scripts/emit-json-schema.ts   writes robot_gateway/schema/*.json
  test/gateway.test.ts
robot_gateway/schema/     generated JSON Schema (committed)
apps/api/
  package.json, tsconfig.json, drizzle.config.ts
  src/db/schema.ts         Drizzle tables
  src/db/client.ts         openDb(path | ":memory:")
  src/db/seed.ts           synthetic seed
  src/auth/password.ts     scrypt hash/verify
  src/auth/plugin.ts       JWT + requireRole
  src/routes/auth.ts       POST /auth/login, POST /auth/device
  src/routes/me.ts         GET /me/residents
  src/services/transitions.ts   applyTransition()
  src/app.ts               buildApp({ db })
  src/server.ts            dev entry
  test/helpers.ts          makeTestApp()
  test/*.test.ts
```

---

### Task 1: Audit event model in core

**Files:**
- Create: `packages/core/src/audit.ts`
- Test: `packages/core/test/audit.test.ts`

**Interfaces:**
- Consumes: `VisitState` from `../src/visit-state`, `TaskState` from `../src/task-state`
- Produces:
  ```ts
  export type ActorType = "family" | "staff" | "device" | "robot" | "system";
  export type EntityType = "visit" | "task" | "robot" | "command";
  export interface AuditEvent { id: string; at: string /* ISO */; actorType: ActorType; actorId: string; entityType: EntityType; entityId: string; fromState: string | null; toState: string | null; reason: string | null; correlationId: string; }
  export const AuditEventSchema: z.ZodType<AuditEvent>;
  export function makeTransitionEvent(input: { actorType: ActorType; actorId: string; entityType: EntityType; entityId: string; fromState: string; toState: string; reason?: string; correlationId: string; now?: () => Date; id?: () => string }): AuditEvent;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/audit.test.ts
import { describe, expect, test } from "vitest";
import { AuditEventSchema, makeTransitionEvent } from "../src/audit";

describe("audit events", () => {
  test("makeTransitionEvent fills id, timestamp and copies every field", () => {
    const ev = makeTransitionEvent({
      actorType: "staff",
      actorId: "staff_demo_01",
      entityType: "visit",
      entityId: "visit_1",
      fromState: "requested",
      toState: "awaiting_policy_or_staff",
      correlationId: "corr_1",
      now: () => new Date("2026-09-17T00:00:00.000Z"),
      id: () => "evt_fixed",
    });
    expect(ev).toEqual({
      id: "evt_fixed",
      at: "2026-09-17T00:00:00.000Z",
      actorType: "staff",
      actorId: "staff_demo_01",
      entityType: "visit",
      entityId: "visit_1",
      fromState: "requested",
      toState: "awaiting_policy_or_staff",
      reason: null,
      correlationId: "corr_1",
    });
  });

  test("reason defaults to null and is kept when given", () => {
    const ev = makeTransitionEvent({
      actorType: "system", actorId: "api", entityType: "task", entityId: "t1",
      fromState: "parsed", toState: "clarification_required", reason: "two items", correlationId: "c",
    });
    expect(ev.reason).toBe("two items");
  });

  test("generated ids are unique and timestamps are ISO strings", () => {
    const a = makeTransitionEvent({ actorType: "system", actorId: "api", entityType: "task", entityId: "t", fromState: "a", toState: "b", correlationId: "c" });
    const b = makeTransitionEvent({ actorType: "system", actorId: "api", entityType: "task", entityId: "t", fromState: "a", toState: "b", correlationId: "c" });
    expect(a.id).not.toBe(b.id);
    expect(() => new Date(a.at).toISOString()).not.toThrow();
  });

  test("schema rejects an unknown actor type", () => {
    const bad = { id: "x", at: new Date().toISOString(), actorType: "hacker", actorId: "1", entityType: "visit", entityId: "v", fromState: null, toState: null, reason: null, correlationId: "c" };
    expect(AuditEventSchema.safeParse(bad).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/audit.test.ts`
Expected: FAIL with "Failed to load url ../src/audit"

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/audit.ts
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const ACTOR_TYPES = ["family", "staff", "device", "robot", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const ENTITY_TYPES = ["visit", "task", "robot", "command"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const AuditEventSchema = z
  .object({
    id: z.string().min(1),
    at: z.string().datetime(),
    actorType: z.enum(ACTOR_TYPES),
    actorId: z.string().min(1),
    entityType: z.enum(ENTITY_TYPES),
    entityId: z.string().min(1),
    fromState: z.string().nullable(),
    toState: z.string().nullable(),
    reason: z.string().nullable(),
    correlationId: z.string().min(1),
  })
  .strict();

export type AuditEvent = z.infer<typeof AuditEventSchema>;

export interface TransitionEventInput {
  actorType: ActorType;
  actorId: string;
  entityType: EntityType;
  entityId: string;
  fromState: string;
  toState: string;
  reason?: string;
  correlationId: string;
  now?: () => Date;
  id?: () => string;
}

export function makeTransitionEvent(input: TransitionEventInput): AuditEvent {
  const now = input.now ?? (() => new Date());
  const id = input.id ?? (() => `evt_${randomUUID()}`);
  return {
    id: id(),
    at: now().toISOString(),
    actorType: input.actorType,
    actorId: input.actorId,
    entityType: input.entityType,
    entityId: input.entityId,
    fromState: input.fromState,
    toState: input.toState,
    reason: input.reason ?? null,
    correlationId: input.correlationId,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/audit.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/audit.ts packages/core/test/audit.test.ts
git commit -m "feat(core): audit event model with makeTransitionEvent" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 2: Keyword intent parser in core

**Files:**
- Create: `packages/core/src/parser/types.ts`
- Create: `packages/core/src/parser/keyword.ts`
- Test: `packages/core/test/parser-keyword.test.ts`

**Interfaces:**
- Consumes: `TaskProposal`, `parseTaskProposal` from `../intent`; `ItemCatalogue` from `../policy`
- Produces:
  ```ts
  export interface ParseContext { recipientId: string; defaultDestinationId: string; catalogue: ItemCatalogue; }
  export type ParseOutcome =
    | { kind: "proposal"; proposal: TaskProposal }
    | { kind: "clarification"; question: string; options: string[] };
  export interface IntentParser { parse(text: string, ctx: ParseContext): ParseOutcome; }
  export class KeywordParser implements IntentParser { constructor(synonyms?: Record<string, string[]>); parse(...): ParseOutcome }
  export const DEFAULT_SYNONYMS: Record<string, string[]>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/parser-keyword.test.ts
import { describe, expect, test } from "vitest";
import { KeywordParser } from "../src/parser/keyword";
import type { ParseContext } from "../src/parser/types";
import { DEMO_CATALOGUE } from "../src/policy";

const ctx: ParseContext = {
  recipientId: "resident_demo_01",
  defaultDestinationId: "bedside_table_demo",
  catalogue: DEMO_CATALOGUE,
};
const parser = new KeywordParser();

describe("KeywordParser", () => {
  test("turns the handover sentence into the handover proposal", () => {
    const out = parser.parse("Could you bring Mom the water bottle?", ctx);
    expect(out).toEqual({
      kind: "proposal",
      proposal: {
        task_type: "deliver_item",
        item: "water_bottle",
        recipient: "resident_demo_01",
        destination: "bedside_table_demo",
        requires_confirmation: true,
      },
    });
  });

  test("matches the bare synonym 'water' and Chinese 水瓶", () => {
    expect(parser.parse("some water please", ctx).kind).toBe("proposal");
    expect(parser.parse("幫媽媽拿水瓶", ctx).kind).toBe("proposal");
  });

  test("is case-insensitive and ignores punctuation", () => {
    const out = parser.parse("WATER   BOTTLE!!!", ctx);
    expect(out.kind).toBe("proposal");
  });

  test("asks for clarification when no approved item is mentioned", () => {
    const out = parser.parse("can you help her?", ctx);
    expect(out.kind).toBe("clarification");
    if (out.kind === "clarification") {
      expect(out.options).toEqual([...DEMO_CATALOGUE.approvedItems]);
    }
  });

  test("asks for clarification when two approved items are mentioned", () => {
    const out = parser.parse("bring the water bottle and the tissue box", ctx);
    expect(out.kind).toBe("clarification");
    if (out.kind === "clarification") {
      expect(out.options.sort()).toEqual(["tissue_box", "water_bottle"]);
    }
  });

  test("a prohibited item still becomes a proposal so policy can reject it with the right code", () => {
    const out = parser.parse("bring her medication", ctx);
    expect(out.kind).toBe("proposal");
    if (out.kind === "proposal") expect(out.proposal.item).toBe("medication");
  });

  test("empty input asks for clarification", () => {
    expect(parser.parse("   ", ctx).kind).toBe("clarification");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/parser-keyword.test.ts`
Expected: FAIL with "Failed to load url ../src/parser/keyword"

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/parser/types.ts
import type { TaskProposal } from "../intent";
import type { ItemCatalogue } from "../policy";

export interface ParseContext {
  recipientId: string;
  defaultDestinationId: string;
  catalogue: ItemCatalogue;
}

export type ParseOutcome =
  | { kind: "proposal"; proposal: TaskProposal }
  | { kind: "clarification"; question: string; options: string[] };

export interface IntentParser {
  parse(text: string, ctx: ParseContext): ParseOutcome;
}
```

```ts
// packages/core/src/parser/keyword.ts
import { parseTaskProposal } from "../intent";
import type { IntentParser, ParseContext, ParseOutcome } from "./types";

/**
 * Deterministic parser: matches item synonyms in the text. No network, no model.
 * Prohibited items are matched too, on purpose, so the policy layer can reject
 * them with `prohibited_item` instead of a vague clarification.
 */
export const DEFAULT_SYNONYMS: Record<string, string[]> = {
  water_bottle: ["water bottle", "bottle of water", "water", "水瓶", "水"],
  tissue_box: ["tissue box", "tissues", "tissue", "面紙", "衛生紙"],
  tv_remote: ["tv remote", "remote control", "remote", "遙控器"],
  medication: ["medication", "medicine", "pills", "藥"],
  hot_tea: ["hot tea", "tea", "熱茶"],
  coffee: ["coffee", "咖啡"],
  knife: ["knife", "刀"],
  scissors: ["scissors", "剪刀"],
};

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

export class KeywordParser implements IntentParser {
  constructor(private readonly synonyms: Record<string, string[]> = DEFAULT_SYNONYMS) {}

  parse(text: string, ctx: ParseContext): ParseOutcome {
    const clarify = (question: string, options: string[]): ParseOutcome => ({ kind: "clarification", question, options });
    const norm = normalize(text);
    if (norm === "") return clarify("What would you like the robot to bring?", [...ctx.catalogue.approvedItems]);

    const found = new Set<string>();
    // Longest synonyms first so "water bottle" wins over "water" for the same item.
    for (const [itemId, words] of Object.entries(this.synonyms)) {
      for (const w of [...words].sort((a, b) => b.length - a.length)) {
        const needle = normalize(w);
        const hit = /[a-z]/.test(needle)
          ? new RegExp(`(^|\\s)${needle}(\\s|$)`).test(norm)
          : norm.includes(needle);
        if (hit) { found.add(itemId); break; }
      }
    }

    if (found.size === 0) return clarify("Which item should the robot bring?", [...ctx.catalogue.approvedItems]);
    if (found.size > 1) return clarify("Which one item should the robot bring?", [...found]);

    const [item] = found;
    const result = parseTaskProposal({
      task_type: "deliver_item",
      item,
      recipient: ctx.recipientId,
      destination: ctx.defaultDestinationId,
      requires_confirmation: true,
    });
    if (!result.ok) return clarify("Sorry, I could not understand that request.", [...ctx.catalogue.approvedItems]);
    return { kind: "proposal", proposal: result.proposal };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/parser-keyword.test.ts`
Expected: PASS (7 tests). If the Chinese 水 test fails because 水瓶 matched twice, confirm `break` exits after the first synonym hit per item.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/parser packages/core/test/parser-keyword.test.ts
git commit -m "feat(core): deterministic keyword intent parser" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 3: Core public index and typecheck

**Files:**
- Create: `packages/core/src/index.ts`
- Modify: `package.json` (root) scripts — add `"typecheck": "tsc -b"` already present; verify
- Test: `packages/core/test/index.test.ts`

**Interfaces:**
- Produces: `import { ... } from "@oncare/core"` exposing everything from `state-machine`, `visit-state`, `task-state`, `intent`, `policy`, `audit`, `parser/types`, `parser/keyword`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/index.test.ts
import { expect, test } from "vitest";
import * as core from "../src/index";

test("index exports the public surface", () => {
  for (const name of [
    "VISIT_STATES", "transitionVisit", "TASK_STATES", "transitionTask",
    "parseTaskProposal", "TaskProposalSchema", "evaluateProposal", "DEMO_CATALOGUE",
    "makeTransitionEvent", "AuditEventSchema", "KeywordParser",
  ]) {
    expect(core, name).toHaveProperty(name);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/index.test.ts`
Expected: FAIL with "Failed to load url ../src/index"

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/index.ts
export * from "./state-machine";
export * from "./visit-state";
export * from "./task-state";
export * from "./intent";
export * from "./policy";
export * from "./audit";
export * from "./parser/types";
export * from "./parser/keyword";
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run && npx tsc -b`
Expected: all core tests PASS; `tsc -b` exits 0 with no output. If `tsc` complains about `import.meta`/module settings, keep `module: ESNext`, `moduleResolution: Bundler` from `tsconfig.base.json`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/core/test/index.test.ts
git commit -m "feat(core): public index" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 4: Contracts package — Gateway message schemas and JSON Schema emission

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/gateway.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/scripts/emit-json-schema.ts`
- Create (generated, committed): `robot_gateway/schema/gateway-down.json`, `robot_gateway/schema/gateway-up.json`
- Modify: `tsconfig.json` (root) — add `{ "path": "packages/contracts" }` to `references`
- Test: `packages/contracts/test/gateway.test.ts`

**Interfaces:**
- Produces (all zod, exported with inferred types of the same name without `Schema`):
  ```ts
  // Down (API -> Gateway)
  IntentRequestVisitSchema   { type:"intent", intent:"request_visit", correlationId, expiresAt (ISO), payload:{ locationId } }
  IntentGoToLocationSchema   { type:"intent", intent:"go_to_location", correlationId, expiresAt, payload:{ locationId } }
  IntentDeliverItemSchema    { type:"intent", intent:"deliver_item", correlationId, expiresAt, payload:{ itemId, pickupLocationId, destinationLocationId, standbyLocationId, mode:"tray"|"manipulation"|"mock" } }
  CancelSchema               { type:"cancel", correlationId }
  StopSchema                 { type:"stop", reason }
  StaffEventSchema           { type:"staff_event", correlationId, event:"staff_loaded"|"received" }
  LocationsSchema            { type:"locations", locations: Array<{ id, name, kind:"resident_room"|"pickup_station"|"standby", x, y, yaw, approved:boolean }> }
  GatewayDownSchema = discriminatedUnion("type", [...])   // intent is itself a union on "intent"
  // Up (Gateway -> API)
  HeartbeatSchema  { type:"heartbeat", at, robotReady:boolean, adapter:"navweb"|"mock", pose:{x,y,yaw}|null, navState:string, estop:boolean, lift:string, battery:number|"unknown", activeCorrelationId:string|null, gatewayVersion:string }
  AckSchema        { type:"ack", correlationId, result:"accepted"|"expired"|"busy"|"duplicate"|"rejected", reason?: string }
  StateEventSchema { type:"state_event", correlationId, at, event: "robot_en_route"|"arrived"|"arrived_pickup"|"arrived_delivery"|"completed_leg"|"navigation_failed"|"cancelled"|"safety_stopped"|"expired", detail?: Record<string, unknown> }
  GatewayUpSchema = discriminatedUnion("type", [...])
  ```

- [ ] **Step 1: Scaffold the package (config, no test needed)**

```json
// packages/contracts/package.json
{
  "name": "@oncare/contracts",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "emit": "tsx scripts/emit-json-schema.ts" },
  "dependencies": { "zod": "^3.23.0", "zod-to-json-schema": "^3.23.0" }
}
```

```json
// packages/contracts/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": ".", "outDir": "dist", "types": ["node"] },
  "include": ["src", "test", "scripts"]
}
```

Add `"tsx": "^4.19.0"` to root `devDependencies`, add `{ "path": "packages/contracts" }` to root `tsconfig.json` references, then run `npm install --no-audit --no-fund` from the repo root. If npm reports `ECONNRESET`, re-run once.

- [ ] **Step 2: Write the failing test**

```ts
// packages/contracts/test/gateway.test.ts
import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { GatewayDownSchema, GatewayUpSchema } from "../src/gateway";

describe("gateway contracts", () => {
  test("accepts a deliver_item intent in tray mode", () => {
    const msg = {
      type: "intent", intent: "deliver_item", correlationId: "corr_1",
      expiresAt: "2026-09-17T00:05:00.000Z",
      payload: { itemId: "water_bottle", pickupLocationId: "pickup_station_demo", destinationLocationId: "room_demo_01", standbyLocationId: "standby_demo", mode: "tray" },
    };
    expect(GatewayDownSchema.safeParse(msg).success).toBe(true);
  });

  test("rejects an intent carrying raw coordinates", () => {
    const msg = {
      type: "intent", intent: "go_to_location", correlationId: "c", expiresAt: "2026-09-17T00:05:00.000Z",
      payload: { x: 1.0, y: 2.0, yaw: 0 },
    };
    expect(GatewayDownSchema.safeParse(msg).success).toBe(false);
  });

  test("rejects an unknown message type", () => {
    expect(GatewayDownSchema.safeParse({ type: "joy", vx: 1 }).success).toBe(false);
  });

  test("accepts a heartbeat with unknown battery", () => {
    const hb = {
      type: "heartbeat", at: "2026-09-17T00:00:00.000Z", robotReady: false, adapter: "mock",
      pose: null, navState: "idle", estop: false, lift: "unknown", battery: "unknown",
      activeCorrelationId: null, gatewayVersion: "0.0.1",
    };
    expect(GatewayUpSchema.safeParse(hb).success).toBe(true);
  });

  test("rejects a state_event with an unknown event name", () => {
    const ev = { type: "state_event", correlationId: "c", at: "2026-09-17T00:00:00.000Z", event: "completed" };
    expect(GatewayUpSchema.safeParse(ev).success).toBe(false);
  });

  test("JSON Schema files are emitted and mention the discriminator", () => {
    for (const f of ["robot_gateway/schema/gateway-down.json", "robot_gateway/schema/gateway-up.json"]) {
      expect(existsSync(f), f).toBe(true);
      const json = JSON.parse(readFileSync(f, "utf8"));
      expect(JSON.stringify(json)).toContain('"type"');
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/contracts/test/gateway.test.ts`
Expected: FAIL with "Failed to load url ../src/gateway"

- [ ] **Step 4: Write the schemas and the emitter**

```ts
// packages/contracts/src/gateway.ts
import { z } from "zod";

const Id = z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
const Iso = z.string().datetime();
const Corr = z.string().min(1);

const intentBase = { type: z.literal("intent"), correlationId: Corr, expiresAt: Iso };

export const IntentRequestVisitSchema = z.object({ ...intentBase, intent: z.literal("request_visit"), payload: z.object({ locationId: Id }).strict() }).strict();
export const IntentGoToLocationSchema = z.object({ ...intentBase, intent: z.literal("go_to_location"), payload: z.object({ locationId: Id }).strict() }).strict();
export const IntentDeliverItemSchema = z.object({
  ...intentBase,
  intent: z.literal("deliver_item"),
  payload: z.object({
    itemId: Id, pickupLocationId: Id, destinationLocationId: Id, standbyLocationId: Id,
    mode: z.enum(["tray", "manipulation", "mock"]),
  }).strict(),
}).strict();
export const IntentSchema = z.discriminatedUnion("intent", [IntentRequestVisitSchema, IntentGoToLocationSchema, IntentDeliverItemSchema]);

export const CancelSchema = z.object({ type: z.literal("cancel"), correlationId: Corr }).strict();
export const StopSchema = z.object({ type: z.literal("stop"), reason: z.string().min(1) }).strict();
export const StaffEventSchema = z.object({ type: z.literal("staff_event"), correlationId: Corr, event: z.enum(["staff_loaded", "received"]) }).strict();
export const LocationSchema = z.object({
  id: Id, name: z.string().min(1), kind: z.enum(["resident_room", "pickup_station", "standby"]),
  x: z.number(), y: z.number(), yaw: z.number(), approved: z.boolean(),
}).strict();
export const LocationsSchema = z.object({ type: z.literal("locations"), locations: z.array(LocationSchema) }).strict();

// `intent` messages share type:"intent"; wrap the inner union so the outer discriminator stays "type".
export const GatewayDownSchema = z.union([IntentSchema, CancelSchema, StopSchema, StaffEventSchema, LocationsSchema]);

export const HeartbeatSchema = z.object({
  type: z.literal("heartbeat"), at: Iso, robotReady: z.boolean(), adapter: z.enum(["navweb", "mock"]),
  pose: z.object({ x: z.number(), y: z.number(), yaw: z.number() }).strict().nullable(),
  navState: z.string(), estop: z.boolean(), lift: z.string(),
  battery: z.union([z.number().min(0).max(100), z.literal("unknown")]),
  activeCorrelationId: z.string().nullable(), gatewayVersion: z.string().min(1),
}).strict();
export const AckSchema = z.object({
  type: z.literal("ack"), correlationId: Corr,
  result: z.enum(["accepted", "expired", "busy", "duplicate", "rejected"]), reason: z.string().optional(),
}).strict();
export const STATE_EVENTS = ["robot_en_route", "arrived", "arrived_pickup", "arrived_delivery", "completed_leg", "navigation_failed", "cancelled", "safety_stopped", "expired"] as const;
export const StateEventSchema = z.object({
  type: z.literal("state_event"), correlationId: Corr, at: Iso, event: z.enum(STATE_EVENTS),
  detail: z.record(z.unknown()).optional(),
}).strict();
export const GatewayUpSchema = z.discriminatedUnion("type", [HeartbeatSchema, AckSchema, StateEventSchema]);

export type Intent = z.infer<typeof IntentSchema>;
export type GatewayDown = z.infer<typeof GatewayDownSchema>;
export type GatewayUp = z.infer<typeof GatewayUpSchema>;
export type Heartbeat = z.infer<typeof HeartbeatSchema>;
export type Ack = z.infer<typeof AckSchema>;
export type StateEvent = z.infer<typeof StateEventSchema>;
export type Location = z.infer<typeof LocationSchema>;
```

```ts
// packages/contracts/src/index.ts
export * from "./gateway";
```

```ts
// packages/contracts/scripts/emit-json-schema.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { zodToJsonSchema } from "zod-to-json-schema";
import { GatewayDownSchema, GatewayUpSchema } from "../src/gateway";

const outDir = new URL("../../../robot_gateway/schema/", import.meta.url);
mkdirSync(outDir, { recursive: true });
const write = (name: string, schema: object) =>
  writeFileSync(new URL(name, outDir), JSON.stringify(schema, null, 2) + "\n");
write("gateway-down.json", zodToJsonSchema(GatewayDownSchema, "GatewayDown"));
write("gateway-up.json", zodToJsonSchema(GatewayUpSchema, "GatewayUp"));
console.log("wrote robot_gateway/schema/gateway-{down,up}.json");
```

Run: `npx tsx packages/contracts/scripts/emit-json-schema.ts`
Expected: prints the "wrote" line; two JSON files exist.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/contracts/test/gateway.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/contracts robot_gateway/schema tsconfig.json package.json package-lock.json
git commit -m "feat(contracts): gateway message schemas with JSON Schema emission" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 5: API scaffold, Drizzle schema, in-memory DB client, synthetic seed

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/drizzle.config.ts`
- Create: `apps/api/src/db/schema.ts`, `apps/api/src/db/client.ts`, `apps/api/src/db/seed.ts`
- Modify: `tsconfig.json` (root) — add `{ "path": "apps/api" }`
- Test: `apps/api/test/db.test.ts`
- Existing, keep: `apps/api/.env` (gitignored LiveKit credentials), `apps/api/.env.example`

**Interfaces:**
- Produces:
  ```ts
  // src/db/client.ts
  export type Db = BetterSQLite3Database<typeof schema>;
  export function openDb(path: string = ":memory:"): Db;   // runs migrations (drizzle `migrate` from ./drizzle) or `pushSchema` for :memory:
  // src/db/seed.ts
  export const SEED_IDS = { facility: "facility_demo", resident: "resident_demo_01", familyUser: "family_demo_01", staffUser: "staff_demo_01", robot: "robot_demo_01", device: "ipad_demo_01", roomLocation: "room_demo_01", pickupLocation: "pickup_station_demo", standbyLocation: "standby_demo" } as const;
  export const SEED_SECRETS = { familyPassword: "family-demo-pass", staffPassword: "staff-demo-pass", staffPin: "2468", deviceToken: "device-demo-token", robotToken: "robot-demo-token" } as const;
  export async function seed(db: Db): Promise<void>;   // idempotent: skips if facility exists
  ```
- Tables (Drizzle `sqliteTable`): `facility`, `resident`, `user`, `familyRelationship`, `robot`, `robotDevice`, `location`, `item`, `visitSession`, `taskRequest`, `taskApproval`, `robotCommand`, `auditEvent`, `benchmarkRun`, `benchmarkTrial` with the columns listed in spec section 2. All ids are `text` primary keys; timestamps are ISO `text`; JSON columns are `text` with `{ mode: "json" }`.

- [ ] **Step 1: Scaffold (config only)**

```json
// apps/api/package.json
{
  "name": "@oncare/api",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "seed": "tsx src/seed-cli.ts",
    "db:generate": "drizzle-kit generate"
  },
  "dependencies": {
    "@oncare/contracts": "*",
    "@oncare/core": "*",
    "@fastify/jwt": "^9.0.0",
    "@fastify/websocket": "^11.0.0",
    "better-sqlite3": "^12.0.0",
    "drizzle-orm": "^0.44.0",
    "fastify": "^5.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "drizzle-kit": "^0.31.0"
  }
}
```

```json
// apps/api/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": ".", "outDir": "dist", "types": ["node"] },
  "include": ["src", "test"],
  "references": [{ "path": "../../packages/core" }, { "path": "../../packages/contracts" }]
}
```

```ts
// apps/api/drizzle.config.ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
```

Run from repo root: `npm install --no-audit --no-fund`. If `better-sqlite3` fails to build on Windows (no prebuilt binary), replace it with `@libsql/client` and use `drizzle-orm/libsql` in `client.ts`; the rest of the plan is unchanged.

- [ ] **Step 2: Write the failing test**

```ts
// apps/api/test/db.test.ts
import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { openDb } from "../src/db/client";
import * as t from "../src/db/schema";
import { SEED_IDS, seed } from "../src/db/seed";

describe("database and seed", () => {
  test("seed creates one facility, resident, family + staff users, robot, device, three locations and the catalogue", async () => {
    const db = openDb(":memory:");
    await seed(db);
    expect(db.select().from(t.facility).all()).toHaveLength(1);
    expect(db.select().from(t.resident).all()).toHaveLength(1);
    expect(db.select().from(t.user).all().map((u) => u.role).sort()).toEqual(["family", "staff"]);
    expect(db.select().from(t.robot).all()).toHaveLength(1);
    expect(db.select().from(t.robotDevice).all()).toHaveLength(1);
    expect(db.select().from(t.location).all().map((l) => l.kind).sort()).toEqual(["pickup_station", "resident_room", "standby"]);
    expect(db.select().from(t.item).all().filter((i) => i.approved)).toHaveLength(3);
  });

  test("seed is idempotent", async () => {
    const db = openDb(":memory:");
    await seed(db);
    await seed(db);
    expect(db.select().from(t.resident).all()).toHaveLength(1);
  });

  test("family user is related to the demo resident with all consents on", async () => {
    const db = openDb(":memory:");
    await seed(db);
    const rel = db.select().from(t.familyRelationship).where(eq(t.familyRelationship.userId, SEED_IDS.familyUser)).get();
    expect(rel?.residentId).toBe(SEED_IDS.resident);
    expect(rel?.consentVideo && rel?.consentRobotVisit && rel?.consentItemDelivery).toBe(true);
  });

  test("seed stores no plaintext secrets", async () => {
    const db = openDb(":memory:");
    await seed(db);
    const u = db.select().from(t.user).where(eq(t.user.id, SEED_IDS.familyUser)).get();
    expect(u?.passwordHash).not.toContain("family-demo-pass");
    const r = db.select().from(t.robot).get();
    expect(r?.tokenHash).not.toContain("robot-demo-token");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run apps/api/test/db.test.ts`
Expected: FAIL with "Failed to load url ../src/db/client"

- [ ] **Step 4: Write schema, client, seed**

```ts
// apps/api/src/db/schema.ts
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const facility = sqliteTable("facility", {
  id: text("id").primaryKey(), name: text("name").notNull(), timezone: text("timezone").notNull(),
});
export const resident = sqliteTable("resident", {
  id: text("id").primaryKey(), facilityId: text("facility_id").notNull().references(() => facility.id),
  displayName: text("display_name").notNull(), roomLocationId: text("room_location_id").notNull(),
  availability: text("availability", { enum: ["available", "in_activity", "resting", "not_available"] }).notNull().default("available"),
});
export const user = sqliteTable("user", {
  id: text("id").primaryKey(), role: text("role", { enum: ["family", "staff"] }).notNull(),
  username: text("username").notNull().unique(), displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(), pinHash: text("pin_hash"),
});
export const familyRelationship = sqliteTable("family_relationship", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => user.id),
  residentId: text("resident_id").notNull().references(() => resident.id), label: text("label").notNull(),
  consentVideo: integer("consent_video", { mode: "boolean" }).notNull().default(false),
  consentRobotVisit: integer("consent_robot_visit", { mode: "boolean" }).notNull().default(false),
  consentItemDelivery: integer("consent_item_delivery", { mode: "boolean" }).notNull().default(false),
});
export const robot = sqliteTable("robot", {
  id: text("id").primaryKey(), facilityId: text("facility_id").notNull().references(() => facility.id),
  name: text("name").notNull(), tokenHash: text("token_hash").notNull(),
});
export const robotDevice = sqliteTable("robot_device", {
  id: text("id").primaryKey(), robotId: text("robot_id").notNull().references(() => robot.id),
  kind: text("kind", { enum: ["ipad"] }).notNull(), residentId: text("resident_id").notNull().references(() => resident.id),
  deviceTokenHash: text("device_token_hash").notNull(),
});
export const location = sqliteTable("location", {
  id: text("id").primaryKey(), facilityId: text("facility_id").notNull().references(() => facility.id),
  name: text("name").notNull(), kind: text("kind", { enum: ["resident_room", "pickup_station", "standby"] }).notNull(),
  x: real("x").notNull(), y: real("y").notNull(), yaw: real("yaw").notNull(),
  approved: integer("approved", { mode: "boolean" }).notNull().default(false),
});
export const item = sqliteTable("item", {
  id: text("id").primaryKey(), label: text("label").notNull(),
  approved: integer("approved", { mode: "boolean" }).notNull().default(false),
  prohibited: integer("prohibited", { mode: "boolean" }).notNull().default(false),
});
export const visitSession = sqliteTable("visit_session", {
  id: text("id").primaryKey(), residentId: text("resident_id").notNull().references(() => resident.id),
  requesterId: text("requester_id").notNull().references(() => user.id), robotId: text("robot_id").references(() => robot.id),
  state: text("state").notNull(), livekitRoom: text("livekit_room"),
  requestedAt: text("requested_at").notNull(), connectedAt: text("connected_at"), endedAt: text("ended_at"),
});
export const taskRequest = sqliteTable("task_request", {
  id: text("id").primaryKey(), visitId: text("visit_id").references(() => visitSession.id),
  requesterId: text("requester_id").notNull().references(() => user.id), residentId: text("resident_id").notNull().references(() => resident.id),
  proposal: text("proposal", { mode: "json" }).notNull(), state: text("state").notNull(),
  mode: text("mode", { enum: ["tray", "manipulation", "mock"] }).notNull(), correlationId: text("correlation_id").notNull().unique(),
  createdAt: text("created_at").notNull(),
});
export const taskApproval = sqliteTable("task_approval", {
  id: text("id").primaryKey(), taskId: text("task_id").notNull().references(() => taskRequest.id),
  actorId: text("actor_id").notNull(), decision: text("decision", { enum: ["confirmed", "approved", "denied", "cancelled"] }).notNull(),
  reason: text("reason"), at: text("at").notNull(),
});
export const robotCommand = sqliteTable("robot_command", {
  id: text("id").primaryKey(), robotId: text("robot_id").notNull().references(() => robot.id),
  taskId: text("task_id").references(() => taskRequest.id), visitId: text("visit_id").references(() => visitSession.id),
  intent: text("intent", { mode: "json" }).notNull(), issuedAt: text("issued_at").notNull(), expiresAt: text("expires_at").notNull(),
  ackedAt: text("acked_at"), result: text("result"),
});
export const auditEvent = sqliteTable("audit_event", {
  id: text("id").primaryKey(), at: text("at").notNull(), actorType: text("actor_type").notNull(), actorId: text("actor_id").notNull(),
  entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(),
  fromState: text("from_state"), toState: text("to_state"), reason: text("reason"), correlationId: text("correlation_id").notNull(),
});
export const benchmarkRun = sqliteTable("benchmark_run", {
  id: text("id").primaryKey(), kind: text("kind", { enum: ["visit", "task"] }).notNull(), entityId: text("entity_id").notNull(),
  startedAt: text("started_at").notNull(), metrics: text("metrics", { mode: "json" }).notNull(),
});
export const benchmarkTrial = sqliteTable("benchmark_trial", {
  id: text("id").primaryKey(), runId: text("run_id").notNull().references(() => benchmarkRun.id),
  name: text("name").notNull(), value: real("value"), unit: text("unit"), at: text("at").notNull(),
});
```

```ts
// apps/api/src/db/client.ts
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

export function openDb(path: string = ":memory:"): Db {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  return db;
}
```

Generate the first migration once: `cd apps/api && npx drizzle-kit generate` (creates `apps/api/drizzle/0000_*.sql` and `meta/`). Commit the `drizzle/` folder.

```ts
// apps/api/src/db/seed.ts
import { eq } from "drizzle-orm";
import { DEMO_CATALOGUE } from "@oncare/core";
import { hashSecret } from "../auth/password";
import type { Db } from "./client";
import * as t from "./schema";

export const SEED_IDS = {
  facility: "facility_demo", resident: "resident_demo_01", familyUser: "family_demo_01", staffUser: "staff_demo_01",
  robot: "robot_demo_01", device: "ipad_demo_01", roomLocation: "room_demo_01", pickupLocation: "pickup_station_demo", standbyLocation: "standby_demo",
} as const;

export const SEED_SECRETS = {
  familyPassword: "family-demo-pass", staffPassword: "staff-demo-pass", staffPin: "2468",
  deviceToken: "device-demo-token", robotToken: "robot-demo-token",
} as const;

export async function seed(db: Db): Promise<void> {
  if (db.select().from(t.facility).where(eq(t.facility.id, SEED_IDS.facility)).get()) return;
  db.insert(t.facility).values({ id: SEED_IDS.facility, name: "Demo Care House", timezone: "Asia/Taipei" }).run();
  db.insert(t.location).values([
    { id: SEED_IDS.roomLocation, facilityId: SEED_IDS.facility, name: "Demo room", kind: "resident_room", x: 0, y: 0, yaw: 0, approved: true },
    { id: SEED_IDS.pickupLocation, facilityId: SEED_IDS.facility, name: "Nurse station", kind: "pickup_station", x: 0, y: 0, yaw: 0, approved: true },
    { id: SEED_IDS.standbyLocation, facilityId: SEED_IDS.facility, name: "Standby", kind: "standby", x: 0, y: 0, yaw: 0, approved: true },
  ]).run();
  db.insert(t.resident).values({ id: SEED_IDS.resident, facilityId: SEED_IDS.facility, displayName: "Demo Resident", roomLocationId: SEED_IDS.roomLocation }).run();
  db.insert(t.user).values([
    { id: SEED_IDS.familyUser, role: "family", username: "family", displayName: "Demo Daughter", passwordHash: await hashSecret(SEED_SECRETS.familyPassword), pinHash: null },
    { id: SEED_IDS.staffUser, role: "staff", username: "staff", displayName: "Demo Nurse", passwordHash: await hashSecret(SEED_SECRETS.staffPassword), pinHash: await hashSecret(SEED_SECRETS.staffPin) },
  ]).run();
  db.insert(t.familyRelationship).values({ id: "rel_demo_01", userId: SEED_IDS.familyUser, residentId: SEED_IDS.resident, label: "daughter", consentVideo: true, consentRobotVisit: true, consentItemDelivery: true }).run();
  db.insert(t.robot).values({ id: SEED_IDS.robot, facilityId: SEED_IDS.facility, name: "Demo Robot", tokenHash: await hashSecret(SEED_SECRETS.robotToken) }).run();
  db.insert(t.robotDevice).values({ id: SEED_IDS.device, robotId: SEED_IDS.robot, kind: "ipad", residentId: SEED_IDS.resident, deviceTokenHash: await hashSecret(SEED_SECRETS.deviceToken) }).run();
  db.insert(t.item).values([
    ...DEMO_CATALOGUE.approvedItems.map((id) => ({ id, label: id.replace(/_/g, " "), approved: true, prohibited: false })),
    ...DEMO_CATALOGUE.prohibitedItems.map((id) => ({ id, label: id.replace(/_/g, " "), approved: false, prohibited: true })),
  ]).run();
}
```

`hashSecret` comes from Task 6; to keep this task green on its own, create `apps/api/src/auth/password.ts` now with the implementation shown in Task 6 Step 3 (Task 6 then adds its tests).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run apps/api/test/db.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/api tsconfig.json package.json package-lock.json
git commit -m "feat(api): drizzle schema, sqlite client, synthetic seed" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 6: Password hashing and JWT auth plugin with three identities

**Files:**
- Create: `apps/api/src/auth/password.ts` (if not created in Task 5), `apps/api/src/auth/plugin.ts`, `apps/api/src/routes/auth.ts`, `apps/api/src/app.ts`, `apps/api/src/server.ts`, `apps/api/src/seed-cli.ts`
- Create: `apps/api/test/helpers.ts`
- Test: `apps/api/test/password.test.ts`, `apps/api/test/auth.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/auth/password.ts
  export async function hashSecret(secret: string): Promise<string>;           // "scrypt$<saltHex>$<hashHex>"
  export async function verifySecret(secret: string, stored: string): Promise<boolean>;
  // src/auth/plugin.ts
  export type Principal = { kind: "user"; id: string; role: "family" | "staff" } | { kind: "device"; id: string; residentId: string; robotId: string };
  export function requireRole(...roles: Array<"family" | "staff" | "device">): preHandlerHookHandler;   // 401 if no token, 403 if wrong role
  declare module "fastify" { interface FastifyRequest { principal: Principal } }
  // src/app.ts
  export interface AppOptions { db: Db; jwtSecret: string }
  export function buildApp(opts: AppOptions): FastifyInstance;
  // src/routes/auth.ts
  POST /auth/login  { username, password } -> 200 { token, principal } | 401
  POST /auth/device { deviceToken }        -> 200 { token, principal } | 401
  // test/helpers.ts
  export async function makeTestApp(): Promise<{ app: FastifyInstance; db: Db; tokens: { family: string; staff: string; device: string } }>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/test/password.test.ts
import { expect, test } from "vitest";
import { hashSecret, verifySecret } from "../src/auth/password";

test("hash verifies the original and rejects a different secret", async () => {
  const stored = await hashSecret("correct horse");
  expect(stored.startsWith("scrypt$")).toBe(true);
  expect(await verifySecret("correct horse", stored)).toBe(true);
  expect(await verifySecret("wrong", stored)).toBe(false);
});

test("two hashes of the same secret differ (random salt)", async () => {
  expect(await hashSecret("x")).not.toBe(await hashSecret("x"));
});
```

```ts
// apps/api/test/auth.test.ts
import { describe, expect, test } from "vitest";
import { makeTestApp } from "./helpers";
import { SEED_SECRETS } from "../src/db/seed";

describe("authentication", () => {
  test("family login returns a token and principal", async () => {
    const { app } = await makeTestApp();
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "family", password: SEED_SECRETS.familyPassword } });
    expect(res.statusCode).toBe(200);
    expect(res.json().principal).toMatchObject({ kind: "user", role: "family" });
    expect(typeof res.json().token).toBe("string");
  });

  test("wrong password is 401 and does not reveal which field failed", async () => {
    const { app } = await makeTestApp();
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "family", password: "nope" } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_credentials" });
  });

  test("device token login returns a device principal bound to its resident", async () => {
    const { app } = await makeTestApp();
    const res = await app.inject({ method: "POST", url: "/auth/device", payload: { deviceToken: SEED_SECRETS.deviceToken } });
    expect(res.statusCode).toBe(200);
    expect(res.json().principal).toMatchObject({ kind: "device", residentId: "resident_demo_01" });
  });

  test("protected route without a token is 401", async () => {
    const { app } = await makeTestApp();
    const res = await app.inject({ method: "GET", url: "/me/residents" });
    expect(res.statusCode).toBe(401);
  });

  test("protected route with the wrong role is 403", async () => {
    const { app, tokens } = await makeTestApp();
    const res = await app.inject({ method: "GET", url: "/me/residents", headers: { authorization: `Bearer ${tokens.device}` } });
    expect(res.statusCode).toBe(403);
  });
});
```

Note: `/me/residents` is implemented in Task 8; in this task register a placeholder route in `app.ts` that is guarded by `requireRole("family")` and returns `{ residents: [] }` so the 401/403 tests are meaningful now. Task 8 replaces the handler body.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/api/test/password.test.ts apps/api/test/auth.test.ts`
Expected: FAIL with "Failed to load url ../src/auth/password" / "./helpers"

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/auth/password.ts
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(secret, salt, 32);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [algo, saltHex, hashHex] = stored.split("$");
  if (algo !== "scrypt" || !saltHex || !hashHex) return false;
  const hash = await scrypt(secret, Buffer.from(saltHex, "hex"), 32);
  const expected = Buffer.from(hashHex, "hex");
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}
```

```ts
// apps/api/src/auth/plugin.ts
import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";

export type Principal =
  | { kind: "user"; id: string; role: "family" | "staff" }
  | { kind: "device"; id: string; residentId: string; robotId: string };

declare module "fastify" {
  interface FastifyRequest { principal: Principal }
}
declare module "@fastify/jwt" {
  interface FastifyJWT { payload: Principal; user: Principal }
}

export const authPlugin = fp(async (app: FastifyInstance, opts: { secret: string }) => {
  await app.register(fastifyJwt, { secret: opts.secret, sign: { expiresIn: "12h" } });
  app.decorateRequest("principal", null);
});

export function requireRole(...roles: Array<"family" | "staff" | "device">): preHandlerHookHandler {
  return async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const p = req.user;
    const role = p.kind === "device" ? "device" : p.role;
    if (!roles.includes(role)) return reply.code(403).send({ error: "forbidden" });
    req.principal = p;
  };
}
```

Add `"fastify-plugin": "^5.0.0"` to `apps/api/package.json` dependencies and run `npm install --no-audit --no-fund`.

```ts
// apps/api/src/routes/auth.ts
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { verifySecret } from "../auth/password";
import type { Db } from "../db/client";
import * as t from "../db/schema";

export async function authRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  app.post("/auth/login", async (req, reply) => {
    const body = z.object({ username: z.string().min(1), password: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const u = db.select().from(t.user).where(eq(t.user.username, body.data.username)).get();
    if (!u || !(await verifySecret(body.data.password, u.passwordHash))) return reply.code(401).send({ error: "invalid_credentials" });
    const principal = { kind: "user", id: u.id, role: u.role } as const;
    return { token: app.jwt.sign(principal), principal };
  });

  app.post("/auth/device", async (req, reply) => {
    const body = z.object({ deviceToken: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    for (const d of db.select().from(t.robotDevice).all()) {
      if (await verifySecret(body.data.deviceToken, d.deviceTokenHash)) {
        const principal = { kind: "device", id: d.id, residentId: d.residentId, robotId: d.robotId } as const;
        return { token: app.jwt.sign(principal), principal };
      }
    }
    return reply.code(401).send({ error: "invalid_credentials" });
  });
}
```

```ts
// apps/api/src/app.ts
import Fastify, { type FastifyInstance } from "fastify";
import { authPlugin, requireRole } from "./auth/plugin";
import type { Db } from "./db/client";
import { authRoutes } from "./routes/auth";

export interface AppOptions { db: Db; jwtSecret: string }

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(authPlugin, { secret: opts.jwtSecret });
  app.register(authRoutes, { db: opts.db });
  // Placeholder until Task 8 replaces the body.
  app.get("/me/residents", { preHandler: requireRole("family") }, async () => ({ residents: [] }));
  app.get("/health", async () => ({ ok: true }));
  return app;
}
```

```ts
// apps/api/src/server.ts
import { buildApp } from "./app";
import { openDb } from "./db/client";
import { seed } from "./db/seed";

const db = openDb(process.env.DATABASE_PATH ?? "./oncare.db");
await seed(db);
const app = buildApp({ db, jwtSecret: process.env.JWT_SECRET ?? "dev-only-secret-change-me" });
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
console.log(`api listening on :${port}`);
```

```ts
// apps/api/src/seed-cli.ts
import { openDb } from "./db/client";
import { seed } from "./db/seed";
const db = openDb(process.env.DATABASE_PATH ?? "./oncare.db");
await seed(db);
console.log("seeded");
```

```ts
// apps/api/test/helpers.ts
import { buildApp } from "../src/app";
import { openDb } from "../src/db/client";
import { SEED_SECRETS, seed } from "../src/db/seed";

export async function makeTestApp() {
  const db = openDb(":memory:");
  await seed(db);
  const app = buildApp({ db, jwtSecret: "test-secret" });
  await app.ready();
  const login = async (username: string, password: string) =>
    (await app.inject({ method: "POST", url: "/auth/login", payload: { username, password } })).json().token as string;
  const device = (await app.inject({ method: "POST", url: "/auth/device", payload: { deviceToken: SEED_SECRETS.deviceToken } })).json().token as string;
  return { app, db, tokens: { family: await login("family", SEED_SECRETS.familyPassword), staff: await login("staff", SEED_SECRETS.staffPassword), device } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/api/test/password.test.ts apps/api/test/auth.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api package.json package-lock.json
git commit -m "feat(api): scrypt password hashing, JWT auth with user and device identities" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 7: `applyTransition()` — the single state writer with audit in the same transaction

**Files:**
- Create: `apps/api/src/services/transitions.ts`
- Test: `apps/api/test/transitions.test.ts`

**Interfaces:**
- Consumes: `transitionVisit`, `transitionTask`, `makeTransitionEvent`, `AuditEvent`, `ActorType` from `@oncare/core`; `Db`, tables from `../db`
- Produces:
  ```ts
  export class TransitionError extends Error { readonly status = 409; constructor(public readonly reason: string) }
  export interface TransitionInput { entityType: "visit" | "task"; entityId: string; to: string; actorType: ActorType; actorId: string; reason?: string; }
  export type Listener = (ev: AuditEvent) => void;
  export function createTransitionService(db: Db, opts?: { now?: () => Date }): {
    apply(input: TransitionInput): AuditEvent;      // throws TransitionError on illegal transition (after writing a rejected_transition audit row)
    subscribe(listener: Listener): () => void;      // used by /events in Plan 2
  };
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/transitions.test.ts
import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { openDb } from "../src/db/client";
import * as t from "../src/db/schema";
import { SEED_IDS, seed } from "../src/db/seed";
import { createTransitionService, TransitionError } from "../src/services/transitions";

async function setup() {
  const db = openDb(":memory:");
  await seed(db);
  db.insert(t.visitSession).values({ id: "visit_1", residentId: SEED_IDS.resident, requesterId: SEED_IDS.familyUser, robotId: SEED_IDS.robot, state: "requested", requestedAt: "2026-09-17T00:00:00.000Z" }).run();
  db.insert(t.taskRequest).values({ id: "task_1", requesterId: SEED_IDS.familyUser, residentId: SEED_IDS.resident, proposal: {}, state: "parsed", mode: "mock", correlationId: "corr_task_1", createdAt: "2026-09-17T00:00:00.000Z" }).run();
  return { db, svc: createTransitionService(db, { now: () => new Date("2026-09-17T00:00:01.000Z") }) };
}

describe("applyTransition", () => {
  test("legal visit transition updates state and writes one audit row", async () => {
    const { db, svc } = await setup();
    const ev = svc.apply({ entityType: "visit", entityId: "visit_1", to: "awaiting_policy_or_staff", actorType: "system", actorId: "api" });
    expect(db.select().from(t.visitSession).where(eq(t.visitSession.id, "visit_1")).get()?.state).toBe("awaiting_policy_or_staff");
    const rows = db.select().from(t.auditEvent).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityId: "visit_1", fromState: "requested", toState: "awaiting_policy_or_staff", correlationId: "visit_1" });
    expect(ev.id).toBe(rows[0]?.id);
  });

  test("illegal transition throws 409, leaves state unchanged, and records rejected_transition", async () => {
    const { db, svc } = await setup();
    expect(() => svc.apply({ entityType: "visit", entityId: "visit_1", to: "active", actorType: "family", actorId: SEED_IDS.familyUser })).toThrow(TransitionError);
    expect(db.select().from(t.visitSession).where(eq(t.visitSession.id, "visit_1")).get()?.state).toBe("requested");
    const rows = db.select().from(t.auditEvent).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe("rejected_transition");
    expect(rows[0]?.toState).toBe("active");
  });

  test("task transitions use the task machine and the task correlation id", async () => {
    const { db, svc } = await setup();
    svc.apply({ entityType: "task", entityId: "task_1", to: "awaiting_user_confirmation", actorType: "system", actorId: "api" });
    expect(db.select().from(t.auditEvent).all()[0]?.correlationId).toBe("corr_task_1");
    expect(() => svc.apply({ entityType: "task", entityId: "task_1", to: "queued", actorType: "family", actorId: SEED_IDS.familyUser })).toThrow(/awaiting_user_confirmation.*queued/);
  });

  test("unknown entity throws a 409 TransitionError", async () => {
    const { svc } = await setup();
    expect(() => svc.apply({ entityType: "visit", entityId: "nope", to: "cancelled", actorType: "system", actorId: "api" })).toThrow(TransitionError);
  });

  test("subscribers receive every successful event and none of the rejected ones", async () => {
    const { svc } = await setup();
    const seen: string[] = [];
    const unsubscribe = svc.subscribe((ev) => seen.push(`${ev.entityId}:${ev.toState}`));
    svc.apply({ entityType: "visit", entityId: "visit_1", to: "awaiting_policy_or_staff", actorType: "system", actorId: "api" });
    try { svc.apply({ entityType: "visit", entityId: "visit_1", to: "active", actorType: "system", actorId: "api" }); } catch {}
    unsubscribe();
    svc.apply({ entityType: "visit", entityId: "visit_1", to: "accepted", actorType: "staff", actorId: SEED_IDS.staffUser });
    expect(seen).toEqual(["visit_1:awaiting_policy_or_staff"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/transitions.test.ts`
Expected: FAIL with "Failed to load url ../src/services/transitions"

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/transitions.ts
import { eq } from "drizzle-orm";
import {
  makeTransitionEvent, transitionTask, transitionVisit,
  type ActorType, type AuditEvent, type TaskState, type VisitState,
} from "@oncare/core";
import type { Db } from "../db/client";
import * as t from "../db/schema";

export class TransitionError extends Error {
  readonly status = 409;
  constructor(public readonly reason: string) { super(reason); }
}

export interface TransitionInput {
  entityType: "visit" | "task";
  entityId: string;
  to: string;
  actorType: ActorType;
  actorId: string;
  reason?: string;
}

export type Listener = (ev: AuditEvent) => void;

export function createTransitionService(db: Db, opts: { now?: () => Date } = {}) {
  const now = opts.now ?? (() => new Date());
  const listeners = new Set<Listener>();

  function load(input: TransitionInput): { from: string; correlationId: string } {
    if (input.entityType === "visit") {
      const row = db.select().from(t.visitSession).where(eq(t.visitSession.id, input.entityId)).get();
      if (!row) throw new TransitionError(`visit "${input.entityId}" not found`);
      return { from: row.state, correlationId: row.id };
    }
    const row = db.select().from(t.taskRequest).where(eq(t.taskRequest.id, input.entityId)).get();
    if (!row) throw new TransitionError(`task "${input.entityId}" not found`);
    return { from: row.state, correlationId: row.correlationId };
  }

  function writeAudit(ev: AuditEvent) {
    db.insert(t.auditEvent).values(ev).run();
  }

  function apply(input: TransitionInput): AuditEvent {
    const { from, correlationId } = load(input);
    const result = input.entityType === "visit"
      ? transitionVisit(from as VisitState, input.to as VisitState)
      : transitionTask(from as TaskState, input.to as TaskState);

    const base = { actorType: input.actorType, actorId: input.actorId, entityType: input.entityType, entityId: input.entityId, fromState: from, toState: input.to, correlationId, now } as const;

    if (!result.ok) {
      writeAudit(makeTransitionEvent({ ...base, reason: "rejected_transition" }));
      throw new TransitionError(result.error);
    }

    const ev = makeTransitionEvent({ ...base, ...(input.reason !== undefined ? { reason: input.reason } : {}) });
    db.transaction((tx) => {
      if (input.entityType === "visit") tx.update(t.visitSession).set({ state: input.to }).where(eq(t.visitSession.id, input.entityId)).run();
      else tx.update(t.taskRequest).set({ state: input.to }).where(eq(t.taskRequest.id, input.entityId)).run();
      tx.insert(t.auditEvent).values(ev).run();
    });
    for (const l of listeners) l(ev);
    return ev;
  }

  function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  return { apply, subscribe };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/api/test/transitions.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/transitions.ts apps/api/test/transitions.test.ts
git commit -m "feat(api): applyTransition service writing audit rows in one transaction" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 8: `GET /me/residents` with relationship filtering

**Files:**
- Create: `apps/api/src/routes/me.ts`
- Modify: `apps/api/src/app.ts` — remove the placeholder route, register `meRoutes`
- Test: `apps/api/test/me.test.ts`

**Interfaces:**
- Produces: `GET /me/residents` (family only) → `200 { residents: Array<{ id, displayName, availability, relationship: { label, consentVideo, consentRobotVisit, consentItemDelivery } }> }`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/me.test.ts
import { describe, expect, test } from "vitest";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";
import { hashSecret } from "../src/auth/password";

describe("GET /me/residents", () => {
  test("returns only residents the family user is related to", async () => {
    const { app, db, tokens } = await makeTestApp();
    // A second resident with no relationship to the demo family user.
    db.insert(t.resident).values({ id: "resident_demo_02", facilityId: SEED_IDS.facility, displayName: "Other Resident", roomLocationId: SEED_IDS.roomLocation }).run();
    const res = await app.inject({ method: "GET", url: "/me/residents", headers: { authorization: `Bearer ${tokens.family}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().residents).toEqual([
      { id: SEED_IDS.resident, displayName: "Demo Resident", availability: "available",
        relationship: { label: "daughter", consentVideo: true, consentRobotVisit: true, consentItemDelivery: true } },
    ]);
  });

  test("a family user with no relationships gets an empty list, not an error", async () => {
    const { app, db } = await makeTestApp();
    db.insert(t.user).values({ id: "family_demo_02", role: "family", username: "family2", displayName: "Unrelated", passwordHash: await hashSecret("pw"), pinHash: null }).run();
    const token = (await app.inject({ method: "POST", url: "/auth/login", payload: { username: "family2", password: "pw" } })).json().token;
    const res = await app.inject({ method: "GET", url: "/me/residents", headers: { authorization: `Bearer ${token}` } });
    expect(res.json()).toEqual({ residents: [] });
  });

  test("staff token is 403 on a family route", async () => {
    const { app, tokens } = await makeTestApp();
    const res = await app.inject({ method: "GET", url: "/me/residents", headers: { authorization: `Bearer ${tokens.staff}` } });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/me.test.ts`
Expected: first test FAILS (placeholder returns `[]`), third PASSES already. That is expected: the guard exists, the body does not.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/routes/me.ts
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { requireRole } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";

export async function meRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  app.get("/me/residents", { preHandler: requireRole("family") }, async (req) => {
    const p = req.principal;
    if (p.kind !== "user") return { residents: [] };
    const rows = db
      .select({
        id: t.resident.id, displayName: t.resident.displayName, availability: t.resident.availability,
        label: t.familyRelationship.label, consentVideo: t.familyRelationship.consentVideo,
        consentRobotVisit: t.familyRelationship.consentRobotVisit, consentItemDelivery: t.familyRelationship.consentItemDelivery,
      })
      .from(t.familyRelationship)
      .innerJoin(t.resident, eq(t.resident.id, t.familyRelationship.residentId))
      .where(eq(t.familyRelationship.userId, p.id))
      .all();
    return {
      residents: rows.map((r) => ({
        id: r.id, displayName: r.displayName, availability: r.availability,
        relationship: { label: r.label, consentVideo: r.consentVideo, consentRobotVisit: r.consentRobotVisit, consentItemDelivery: r.consentItemDelivery },
      })),
    };
  });
}
```

In `apps/api/src/app.ts` delete the placeholder `app.get("/me/residents", ...)` line and add `app.register(meRoutes, { db: opts.db });` with `import { meRoutes } from "./routes/me";`.

- [ ] **Step 4: Run the whole suite and typecheck**

Run: `npx vitest run && npx tsc -b`
Expected: all tests PASS (core 40 + audit 4 + parser 7 + index 1 + contracts 6 + api 4 + 7 + 5 + 3), `tsc -b` exits 0.

- [ ] **Step 5: Smoke-run the dev server**

Run from repo root: `npm run dev -w @oncare/api` in one shell, then `curl -s localhost:3000/health`.
Expected: `{"ok":true}`. Stop the server. Delete `apps/api/oncare.db*` if created (they are gitignored by `*.db`).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/me.ts apps/api/src/app.ts apps/api/test/me.test.ts
git commit -m "feat(api): GET /me/residents filtered by family relationship" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

## Plan self-review

**Spec coverage (Plan 1 scope only):**
- Section 2 data model: Task 5 creates all 15 tables listed in the spec (`media_asset`, `notification` deliberately deferred by the spec).
- Section 2 auth: Task 6 covers family/staff password login and device token; robot token verification on the `/gateway` WebSocket belongs to Plan 2 (Gateway) and is not in this plan.
- Section 2 single writer: Task 7.
- Section 2 routes: only `GET /me/residents` here (Task 8). Visit, task, device, staff, video, and `/events` routes are Plans 2–5.
- Section 4 intent parsing: Task 2.
- Section 5 audit: Tasks 1 and 7 (IDs only; `reason` strings are fixed codes, never utterance text).
- Section 1 contracts: Task 4 (JSON Schema emitted for the Python gateway; the Python validator is Plan 2).

**Placeholder scan:** none. The only intentional stub is the Task 6 `/me/residents` placeholder, which Task 8 replaces and says so.

**Type consistency:** `hashSecret`/`verifySecret` (Tasks 5, 6, 8); `SEED_IDS`/`SEED_SECRETS` (5, 6, 7, 8); `createTransitionService(db, { now })` returning `{ apply, subscribe }` (7); `requireRole` and `req.principal` (6, 8); `makeTestApp()` returning `{ app, db, tokens }` (6, 8); `GatewayDownSchema`/`GatewayUpSchema` (4). `ParseContext.catalogue` uses `ItemCatalogue` from `policy.ts` (2).

## Plans that follow

| Plan | Scope | Spec sections |
|---|---|---|
| 2 | Visit flow routes, `/events` WebSocket, `/gateway` WebSocket with robot token, Python gateway skeleton with `MockRobotAdapter`, heartbeat, `request_visit` | 2, 3 |
| 3 | Resident kiosk (five screens) and family app (login → request visit → answer) | 4 |
| 4 | LiveKit `VideoProvider`, token routes, disconnect handling | 4 |
| 5 | Task flow (parse → confirm → staff approve → tray mode → progress), staff console | 2, 3, 4 |
| 6 | `NavWebAdapter` on the Jetson, location table sync, stop/resume | 3 |
| 7 | Rehearsals, benchmark export, iPad kiosk setup doc | 5 |
