# OnCare Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give OnCare an admin role, per-facility and per-assignment scoping enforced by one access module that re-validates every request, iPads that do not need a robot, a care-house admin API and tab, and an AI tool registry that runs reads directly and writes only after confirmation.

**Architecture:** One new service, `apps/api/src/services/access.ts`, owns principal resolution and every "may this principal touch this resident / this audit event" decision. `requireRole` and the events WebSocket call it on every request. Existing routes and services replace their own checks with it. Admin routes and the tool registry are new Fastify plugins built on the same module.

**Tech Stack:** TypeScript 5.6, Node 24, Fastify 5, @fastify/jwt 9, Drizzle ORM 0.44 + better-sqlite3 12, zod 3.23, zod-to-json-schema 3.23, React 19 + Vite 6, Vitest 3, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-19-foundation-design.md`

## Global Constraints

- Branch: `integration/foundation`. Do not push.
- `user.role` values: `family | staff | admin`. Staff and admin carry `facility_id`; family may have `facility_id = null`.
- Every request re-reads the user or device row. Disabled user, disabled device, or changed `assignment_version` / `resident_id` → **401**.
- Resident-scoped resources outside the caller's scope → **403**, never 404.
- Robot controls (`stop`, `standby`, `resume`, `status`) and locations are facility-level: any active staff or admin of the robot's facility. STOP is never blocked by assignment scope.
- Audit reasons are fixed snake_case codes (`REASON_CODE` in `packages/core/src/audit.ts`).
- Admin audit rows: `actor_type = "admin"`, `correlation_id = <facility id>`.
- Tool audit rows: `actor_type = "ai"`, `actor_id = <principal id>`, `entity_type = "tool"`, `correlation_id = <principal facility id, or principal id when null>`.
- `pending_action` expires 2 minutes after creation.
- Device tokens are returned exactly once, at creation; only the scrypt hash is stored (`hashSecret` in `apps/api/src/auth/password.ts`).
- Tools never import the DB client; they use `ctx.access` and `ctx.directory`.
- TS config is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`: never pass `undefined` to an optional property; spread conditionally as the existing code does.
- All UI strings go through `t()` with keys in `packages/web-common/src/i18n/en.json`.
- The existing suites (`npx vitest run`, `npx tsc -b`, `pytest -q robot_gateway`) stay green after every task.

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/audit.ts` | Modify: add actor types `admin`, `ai`; entity types `user`, `device`, `family_link`, `staff_assignment`, `tool` |
| `apps/api/src/db/schema.ts` | Modify: `user.facility_id/active`, `resident.active`, `robot_device` → `device`, new `staff_assignment`, `pending_action` |
| `apps/api/drizzle/0002_foundation.sql` | Create: hand-written migration with data carry-over |
| `apps/api/src/db/seed.ts` | Modify: admin user, staff facility, staff assignment, `device` table |
| `apps/api/src/auth/plugin.ts` | Modify: new `Principal`, `requireRole` resolves via `access` |
| `apps/api/src/services/access.ts` | Create: `resolvePrincipal`, `residentIdsVisibleTo`, `canAccessResident`, `sameFacility`, `familyLink(s)`, `auditVisibleTo`, `actionRole` |
| `apps/api/src/services/directory.ts` | Create: read models for tools (resident summaries, family contacts) |
| `apps/api/src/routes/admin.ts` | Create: admin API |
| `apps/api/src/tools/registry.ts` | Create: `defineTool`, `createToolRegistry`, errors |
| `apps/api/src/tools/builtin.ts` | Create: `list_my_residents_or_contacts`, `get_resident_status` |
| `apps/api/src/routes/tools.ts` | Create: `/tools` HTTP surface |
| `apps/api/src/app.ts` | Modify: decorate `access`, `tools`; register admin + tools routes |
| existing routes/services | Modify: use `access` |
| `packages/web-common/src/api.ts` | Modify: add `del` |
| `apps/staff/src/App.tsx`, `pages/Login.tsx` | Modify: admin role, tab switch |
| `apps/staff/src/admin/*.tsx` | Create: admin tab |

---

### Task 1: Audit vocabulary for admins, AI and admin-managed entities

**Files:**
- Modify: `packages/core/src/audit.ts:4,10`
- Test: `packages/core/test/audit.test.ts`

**Interfaces:**
- Produces: `ActorType` includes `"admin" | "ai"`; `EntityType` includes `"user" | "device" | "family_link" | "staff_assignment" | "tool"`.

- [ ] **Step 1: Write the failing test** — append to `packages/core/test/audit.test.ts`:

```ts
import { ACTOR_TYPES, ENTITY_TYPES } from "../src/audit";

describe("foundation vocabulary", () => {
  test("admins and AI are actors; admin-managed records and tools are entities", () => {
    expect(ACTOR_TYPES).toEqual(expect.arrayContaining(["admin", "ai"]));
    expect(ENTITY_TYPES).toEqual(expect.arrayContaining(["user", "device", "family_link", "staff_assignment", "tool"]));
    const ev = makeTransitionEvent({ actorType: "ai", actorId: "u1", entityType: "tool", entityId: "get_resident_status", fromState: null, toState: null, reason: "tool_invoked", correlationId: "facility_demo" });
    expect(AuditEventSchema.safeParse(ev).success).toBe(true);
  });
});
```

(`describe`, `test`, `expect`, `makeTransitionEvent`, `AuditEventSchema` are already imported at the top of that file; add `ACTOR_TYPES, ENTITY_TYPES` to the existing `../src/audit` import instead of a second import line if you prefer.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/test/audit.test.ts`
Expected: FAIL — `"ai"` is not assignable / array does not contain `admin`.

- [ ] **Step 3: Implement** — in `packages/core/src/audit.ts`:

```ts
export const ACTOR_TYPES = ["family", "staff", "admin", "device", "robot", "system", "ai"] as const;
```

```ts
export const ENTITY_TYPES = ["visit", "task", "robot", "command", "resident", "user", "device", "family_link", "staff_assignment", "tool"] as const;
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run packages/core && npx tsc -b`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/audit.ts packages/core/test/audit.test.ts
git commit -m "feat(core): audit vocabulary for admins, AI and admin-managed entities"
```

---

### Task 2: Schema, migration 0002 and the `device` rename

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0002_foundation.sql` (+ generated `meta/0002_snapshot.json`, `meta/_journal.json` entry)
- Modify: `apps/api/src/db/seed.ts`, `apps/api/src/auth/plugin.ts:7`, `apps/api/src/routes/auth.ts:23-25`, `apps/api/src/routes/device.ts:21-26,54,71,84,89`, `apps/api/src/routes/staff.ts:74,97`, `apps/api/src/routes/video.ts:22`, `apps/api/src/services/benchmark.ts:88`
- Test: `apps/api/test/migration.test.ts` (create), `apps/api/test/db.test.ts`, `apps/api/test/visit-actions.test.ts:96`

**Interfaces:**
- Produces (Drizzle tables in `schema.ts`): `t.device` (`id, facilityId, robotId: string | null, kind, residentId, deviceTokenHash, active, assignmentVersion`), `t.staffAssignment` (`id, userId, residentId, active, createdAt`), `t.pendingAction` (`id, principalKind, principalId, tool, input, summary, createdAt, expiresAt, status`), `t.user.facilityId: string | null`, `t.user.active`, `t.user.role: "family" | "staff" | "admin"`, `t.resident.active`. `t.robotDevice` no longer exists.
- Produces (seed): `SEED_IDS.adminUser = "admin_demo_01"`, `SEED_SECRETS.adminPassword = "admin-demo-pass"`, staff assignment `sa_demo_01` (staff → demo resident).

- [ ] **Step 1: Write the failing migration test** — create `apps/api/test/migration.test.ts`:

```ts
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, test } from "vitest";

const real = fileURLToPath(new URL("../drizzle", import.meta.url));

/** A migrations folder holding only 0000 and 0001: the schema a deployed 0.1.0 database has. */
function legacyFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "oncare-mig-"));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(readFileSync(join(real, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  journal.entries = journal.entries.slice(0, 2);
  for (const entry of journal.entries) cpSync(join(real, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify(journal));
  return dir;
}

describe("migration 0002_foundation", () => {
  test("carries 0.1.0 data forward: devices, staff facility, and staff keep today's visibility", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: legacyFolder() });
    sqlite.exec(`
      INSERT INTO facility (id, name, timezone) VALUES ('f1', 'F', 'Asia/Taipei');
      INSERT INTO location (id, facility_id, name, kind, x, y, yaw, approved) VALUES ('l1', 'f1', 'Room', 'resident_room', 0, 0, 0, 1);
      INSERT INTO resident (id, facility_id, display_name, room_location_id) VALUES ('r1', 'f1', 'R1', 'l1'), ('r2', 'f1', 'R2', 'l1');
      INSERT INTO user (id, role, username, display_name, password_hash, pin_hash) VALUES ('s1', 'staff', 's', 'S', 'h', NULL), ('fam1', 'family', 'f', 'F', 'h', NULL);
      INSERT INTO robot (id, facility_id, name, token_hash) VALUES ('rb1', 'f1', 'Robot', 'h');
      INSERT INTO robot_device (id, robot_id, kind, resident_id, device_token_hash) VALUES ('d1', 'rb1', 'ipad', 'r1', 'dh');
    `);

    migrate(db, { migrationsFolder: real });

    expect(sqlite.prepare("SELECT * FROM device").all()).toEqual([
      { id: "d1", facility_id: "f1", robot_id: "rb1", kind: "ipad", resident_id: "r1", device_token_hash: "dh", active: 1, assignment_version: 1 },
    ]);
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'robot_device'").all()).toEqual([]);
    expect(sqlite.prepare("SELECT id, facility_id, active FROM user ORDER BY id").all()).toEqual([
      { id: "fam1", facility_id: null, active: 1 },
      { id: "s1", facility_id: "f1", active: 1 },
    ]);
    expect(sqlite.prepare("SELECT user_id, resident_id, active FROM staff_assignment ORDER BY resident_id").all()).toEqual([
      { user_id: "s1", resident_id: "r1", active: 1 },
      { user_id: "s1", resident_id: "r2", active: 1 },
    ]);
    expect(sqlite.prepare("SELECT active FROM resident ORDER BY id").all()).toEqual([{ active: 1 }, { active: 1 }]);
    expect(sqlite.prepare("SELECT count(*) AS n FROM pending_action").get()).toEqual({ n: 0 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/api/test/migration.test.ts`
Expected: FAIL — `no such table: device`.

- [ ] **Step 3: Update `apps/api/src/db/schema.ts`**

Change the import line to:

```ts
import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
```

Replace `resident`, `user`, and `robotDevice` with:

```ts
export const resident = sqliteTable("resident", {
  id: text("id").primaryKey(), facilityId: text("facility_id").notNull().references(() => facility.id),
  displayName: text("display_name").notNull(), roomLocationId: text("room_location_id").notNull(),
  availability: text("availability", { enum: ["available", "in_activity", "resting", "not_available"] }).notNull().default("available"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});
export const user = sqliteTable("user", {
  id: text("id").primaryKey(), role: text("role", { enum: ["family", "staff", "admin"] }).notNull(),
  username: text("username").notNull().unique(), displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(), pinHash: text("pin_hash"),
  /** Required for staff and admin (enforced in services); null for family. */
  facilityId: text("facility_id").references(() => facility.id),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});
```

```ts
/** A resident's iPad. A robot is optional: most rooms have an iPad and no robot. */
export const device = sqliteTable("device", {
  id: text("id").primaryKey(), facilityId: text("facility_id").notNull().references(() => facility.id),
  robotId: text("robot_id").references(() => robot.id),
  kind: text("kind", { enum: ["ipad"] }).notNull(), residentId: text("resident_id").notNull().references(() => resident.id),
  deviceTokenHash: text("device_token_hash").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  /** Incremented on every reassignment; a device JWT carrying an older value is rejected. */
  assignmentVersion: integer("assignment_version").notNull().default(1),
});
export const staffAssignment = sqliteTable("staff_assignment", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => user.id),
  residentId: text("resident_id").notNull().references(() => resident.id),
  active: integer("active", { mode: "boolean" }).notNull().default(true), createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("staff_assignment_user_resident").on(table.userId, table.residentId)]);
export const pendingAction = sqliteTable("pending_action", {
  id: text("id").primaryKey(), principalKind: text("principal_kind", { enum: ["user", "device"] }).notNull(),
  principalId: text("principal_id").notNull(), tool: text("tool").notNull(),
  input: text("input", { mode: "json" }).notNull(), summary: text("summary").notNull(),
  createdAt: text("created_at").notNull(), expiresAt: text("expires_at").notNull(),
  status: text("status", { enum: ["pending", "confirmed", "cancelled", "expired"] }).notNull(),
});
```

`device` references `robot`, so place it after the `robot` table (where `robotDevice` was).

- [ ] **Step 4: Generate an empty custom migration and its snapshot**

Run: `cd apps/api && npx drizzle-kit generate --custom --name foundation && cd ../..`
Expected: creates `apps/api/drizzle/0002_foundation.sql` (empty), `meta/0002_snapshot.json`, and a third `_journal.json` entry. (`--custom` avoids drizzle-kit's interactive rename prompt; the snapshot reflects the new `schema.ts`.)

- [ ] **Step 5: Write `apps/api/drizzle/0002_foundation.sql`**

```sql
ALTER TABLE `user` ADD `facility_id` text REFERENCES facility(id);
--> statement-breakpoint
ALTER TABLE `user` ADD `active` integer DEFAULT true NOT NULL;
--> statement-breakpoint
UPDATE `user` SET `facility_id` = (SELECT `id` FROM `facility` ORDER BY `id` LIMIT 1) WHERE `role` = 'staff';
--> statement-breakpoint
ALTER TABLE `resident` ADD `active` integer DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE TABLE `device` (
	`id` text PRIMARY KEY NOT NULL,
	`facility_id` text NOT NULL,
	`robot_id` text,
	`kind` text NOT NULL,
	`resident_id` text NOT NULL,
	`device_token_hash` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`assignment_version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`facility_id`) REFERENCES `facility`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`robot_id`) REFERENCES `robot`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resident_id`) REFERENCES `resident`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `device` (`id`, `facility_id`, `robot_id`, `kind`, `resident_id`, `device_token_hash`, `active`, `assignment_version`)
SELECT `robot_device`.`id`, `robot`.`facility_id`, `robot_device`.`robot_id`, `robot_device`.`kind`, `robot_device`.`resident_id`, `robot_device`.`device_token_hash`, 1, 1
FROM `robot_device` JOIN `robot` ON `robot`.`id` = `robot_device`.`robot_id`;
--> statement-breakpoint
DROP TABLE `robot_device`;
--> statement-breakpoint
CREATE TABLE `staff_assignment` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`resident_id` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resident_id`) REFERENCES `resident`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_assignment_user_resident` ON `staff_assignment` (`user_id`,`resident_id`);
--> statement-breakpoint
-- Existing staff saw every resident in 0.1.0. Assign them to every resident of their facility so an upgrade changes nothing.
INSERT INTO `staff_assignment` (`id`, `user_id`, `resident_id`, `active`, `created_at`)
SELECT 'sa_' || `user`.`id` || '_' || `resident`.`id`, `user`.`id`, `resident`.`id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `user` JOIN `resident` ON `resident`.`facility_id` = `user`.`facility_id`
WHERE `user`.`role` = 'staff';
--> statement-breakpoint
CREATE TABLE `pending_action` (
	`id` text PRIMARY KEY NOT NULL,
	`principal_kind` text NOT NULL,
	`principal_id` text NOT NULL,
	`tool` text NOT NULL,
	`input` text NOT NULL,
	`summary` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`status` text NOT NULL
);
```

- [ ] **Step 6: Verify the snapshot matches the schema**

Run: `cd apps/api && npx drizzle-kit generate && cd ../..`
Expected: `No schema changes, nothing to migrate`. If it proposes a migration, the SQL above and `schema.ts` disagree — fix the SQL, delete the proposed file and its journal entry, and rerun.

- [ ] **Step 7: Rename `robotDevice` → `device` and allow a robot-less device**

`apps/api/src/auth/plugin.ts:7` — the device principal's robot becomes optional (Task 3 replaces this type wholesale):

```ts
  | { kind: "device"; id: string; residentId: string; robotId: string | null };
```

`apps/api/src/routes/auth.ts:23` — replace `t.robotDevice` with `t.device` (only active devices may log in):

```ts
    for (const d of db.select().from(t.device).where(eq(t.device.active, true)).all()) {
```

`apps/api/src/routes/device.ts` — replace the `audit` helper and the three callers:

```ts
  function audit(deviceId: string, robotId: string | null, residentId: string, reason: string) {
    db.insert(t.auditEvent).values(makeTransitionEvent({
      actorType: "device", actorId: deviceId,
      entityType: robotId ? "robot" : "resident", entityId: robotId ?? residentId,
      fromState: null, toState: null, reason, correlationId: deviceId,
    })).run();
  }
```

Callers become `audit(principal.id, principal.robotId, principal.residentId, "call_caregiver")`, and likewise for `"device_unlock"` and `"device_unlock_failed"`. Line 54:

```ts
    const status = principal.robotId ? app.hub.status(principal.robotId) : { connected: false, lastHeartbeat: null, lastSeenAt: null };
```

`apps/api/src/routes/staff.ts:74,97`, `apps/api/src/routes/video.ts:22`, `apps/api/src/services/benchmark.ts:88`: replace every `t.robotDevice` with `t.device` (same column names).

- [ ] **Step 8: Update the seed** — in `apps/api/src/db/seed.ts`:

```ts
export const SEED_IDS = {
  facility: "facility_demo", resident: "resident_demo_01", familyUser: "family_demo_01", staffUser: "staff_demo_01", adminUser: "admin_demo_01",
  robot: "robot_demo_01", device: "ipad_demo_01", roomLocation: "room_demo_01", pickupLocation: "pickup_station_demo", standbyLocation: "standby_demo",
} as const;

export const SEED_SECRETS = {
  familyPassword: "family-demo-pass", staffPassword: "staff-demo-pass", adminPassword: "admin-demo-pass", staffPin: "2468",
  deviceToken: "device-demo-token", robotToken: "robot-demo-token",
} as const;
```

Replace the user insert, and the `robotDevice` insert, with:

```ts
  db.insert(t.user).values([
    { id: SEED_IDS.familyUser, role: "family", username: "family", displayName: "Demo Daughter", passwordHash: await hashSecret(SEED_SECRETS.familyPassword), pinHash: null, facilityId: null },
    { id: SEED_IDS.staffUser, role: "staff", username: "staff", displayName: "Demo Nurse", passwordHash: await hashSecret(SEED_SECRETS.staffPassword), pinHash: await hashSecret(SEED_SECRETS.staffPin), facilityId: SEED_IDS.facility },
    { id: SEED_IDS.adminUser, role: "admin", username: "admin", displayName: "Demo Manager", passwordHash: await hashSecret(SEED_SECRETS.adminPassword), pinHash: await hashSecret(SEED_SECRETS.staffPin), facilityId: SEED_IDS.facility },
  ]).run();
  db.insert(t.staffAssignment).values({ id: "sa_demo_01", userId: SEED_IDS.staffUser, residentId: SEED_IDS.resident, createdAt: new Date(0).toISOString() }).run();
```

```ts
  db.insert(t.device).values({ id: SEED_IDS.device, facilityId: SEED_IDS.facility, robotId: SEED_IDS.robot, kind: "ipad", residentId: SEED_IDS.resident, deviceTokenHash: await hashSecret(SEED_SECRETS.deviceToken) }).run();
```

The staff assignment insert must come after the resident insert; the device insert stays after the robot insert.

- [ ] **Step 9: Update existing tests that name the old table**

`apps/api/test/db.test.ts:8,13,15`:

```ts
  test("seed creates one facility, resident, family + staff + admin users, robot, device, three locations and the catalogue", async () => {
```

```ts
    expect(db.select().from(t.user).all().map((u) => u.role).sort()).toEqual(["admin", "family", "staff"]);
```

```ts
    expect(db.select().from(t.device).all()).toHaveLength(1);
    expect(db.select().from(t.staffAssignment).all()).toEqual([expect.objectContaining({ userId: SEED_IDS.staffUser, residentId: SEED_IDS.resident, active: true })]);
```

`apps/api/test/visit-actions.test.ts:96`:

```ts
    db.insert(t.device).values({ id: "ipad_demo_02", facilityId: SEED_IDS.facility, robotId: SEED_IDS.robot, kind: "ipad", residentId: "resident_demo_02", deviceTokenHash: await hashSecret("other-device") }).run();
```

- [ ] **Step 10: Run the API suite and typecheck**

Run: `npx vitest run --project node && npx tsc -b`
Expected: all PASS including `migration.test.ts`; no type errors. `grep -rn robotDevice apps packages` returns nothing.

- [ ] **Step 11: Commit**

```bash
git add apps/api packages
git commit -m "feat(api): admin role, facility scope columns, robot-optional device and migration 0002"
```

---

### Task 3: Access module and the new principal

**Files:**
- Create: `apps/api/src/services/access.ts`
- Modify: `apps/api/src/auth/plugin.ts`, `apps/api/src/routes/auth.ts`, `apps/api/src/services/visits.ts:29-30`, `apps/api/src/services/tasks.ts:166`, `apps/api/src/routes/video.ts:45`, `apps/api/src/app.ts`
- Test: `apps/api/test/access.test.ts` (create)

**Interfaces:**
- Consumes: tables from Task 2.
- Produces (`apps/api/src/auth/plugin.ts`):

```ts
export type UserRole = "family" | "staff" | "admin";
export type Principal =
  | { kind: "user"; id: string; role: UserRole; facilityId: string | null }
  | { kind: "device"; id: string; residentId: string; facilityId: string; robotId: string | null; assignmentVersion: number };
```

- Produces (`apps/api/src/services/access.ts`): `createAccess(db): Access` with
  - `resolvePrincipal(claims: Principal): Principal | null`
  - `residentIdsVisibleTo(p: Principal): string[]`
  - `canAccessResident(p: Principal, residentId: string): boolean`
  - `sameFacility(p: Principal, facilityId: string): boolean`
  - `familyLink(userId: string, residentId: string): FamilyLink | undefined`
  - `familyLinks(userId: string): FamilyLink[]`
  - `auditVisibleTo(p: Principal, ev: AuditEvent, visible?: Set<string>): boolean`
  - free function `actionRole(p: Principal): "family" | "staff" | "device"` (admin acts with staff powers)
- Produces: `app.access` (Fastify decoration).

- [ ] **Step 1: Write the failing access matrix test** — create `apps/api/test/access.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type Db } from "../src/db/client";
import * as t from "../src/db/schema";
import { SEED_IDS, seed } from "../src/db/seed";
import { actionRole, createAccess, type Access } from "../src/services/access";
import type { Principal } from "../src/auth/plugin";

const F = SEED_IDS.facility;
const R1 = SEED_IDS.resident;
let db: Db;
let access: Access;

const staff = (id = SEED_IDS.staffUser, facilityId: string | null = F): Principal => ({ kind: "user", id, role: "staff", facilityId });
const admin = (facilityId: string | null = F): Principal => ({ kind: "user", id: SEED_IDS.adminUser, role: "admin", facilityId });
const family = (id = SEED_IDS.familyUser): Principal => ({ kind: "user", id, role: "family", facilityId: null });
const device = (overrides: Partial<Extract<Principal, { kind: "device" }>> = {}): Principal => ({ kind: "device", id: SEED_IDS.device, residentId: R1, facilityId: F, robotId: SEED_IDS.robot, assignmentVersion: 1, ...overrides });

beforeEach(async () => {
  db = openDb(":memory:");
  await seed(db);
  access = createAccess(db);
  // A second resident in the same facility nobody is linked or assigned to, and a second facility.
  db.insert(t.resident).values({ id: "r2", facilityId: F, displayName: "Two", roomLocationId: SEED_IDS.roomLocation }).run();
  db.insert(t.facility).values({ id: "fb", name: "B", timezone: "Asia/Taipei" }).run();
  db.insert(t.resident).values({ id: "rb", facilityId: "fb", displayName: "B1", roomLocationId: SEED_IDS.roomLocation }).run();
});

describe("residentIdsVisibleTo / canAccessResident", () => {
  test.each<[string, () => Principal, string[]]>([
    ["admin sees every active resident of its facility", () => admin(), [R1, "r2"]],
    ["admin of another facility sees only that facility", () => admin("fb"), ["rb"]],
    ["admin with no facility sees nothing", () => admin(null), []],
    ["staff sees only assigned residents", () => staff(), [R1]],
    ["staff with no facility sees nothing", () => staff(SEED_IDS.staffUser, null), []],
    ["family sees linked residents", () => family(), [R1]],
    ["device sees only its resident", () => device(), [R1]],
  ])("%s", (_name, principal, expected) => {
    expect(access.residentIdsVisibleTo(principal()).sort()).toEqual(expected.sort());
    for (const id of [R1, "r2", "rb"]) expect(access.canAccessResident(principal(), id)).toBe(expected.includes(id));
  });

  test("an assignment to a resident of another facility grants nothing", () => {
    db.insert(t.staffAssignment).values({ id: "sa_x", userId: SEED_IDS.staffUser, residentId: "rb", createdAt: new Date(0).toISOString() }).run();
    expect(access.canAccessResident(staff(), "rb")).toBe(false);
  });

  test("inactive assignment and inactive resident grant nothing", () => {
    db.update(t.staffAssignment).set({ active: false }).run();
    expect(access.residentIdsVisibleTo(staff())).toEqual([]);
    db.update(t.resident).set({ active: false }).where(eq(t.resident.id, R1)).run();
    for (const p of [admin(), family(), device()]) expect(access.canAccessResident(p, R1)).toBe(false);
  });
});

describe("resolvePrincipal", () => {
  test("returns fresh user data and rejects missing or inactive users", () => {
    expect(access.resolvePrincipal(staff())).toEqual(staff());
    db.update(t.user).set({ role: "admin" }).where(eq(t.user.id, SEED_IDS.staffUser)).run();
    expect(access.resolvePrincipal(staff())).toMatchObject({ role: "admin" });
    db.update(t.user).set({ active: false }).where(eq(t.user.id, SEED_IDS.staffUser)).run();
    expect(access.resolvePrincipal(staff())).toBeNull();
    expect(access.resolvePrincipal(staff("nobody"))).toBeNull();
  });

  test("rejects a device that was reassigned, bumped or deactivated", () => {
    expect(access.resolvePrincipal(device())).toEqual(device());
    expect(access.resolvePrincipal(device({ residentId: "r2" }))).toBeNull();
    expect(access.resolvePrincipal(device({ assignmentVersion: 0 }))).toBeNull();
    db.update(t.device).set({ active: false }).run();
    expect(access.resolvePrincipal(device())).toBeNull();
  });

  test("rejects a 0.1.0-shaped device token with no assignment version", () => {
    const legacy = { kind: "device", id: SEED_IDS.device, residentId: R1, robotId: SEED_IDS.robot } as unknown as Principal;
    expect(access.resolvePrincipal(legacy)).toBeNull();
  });
});

describe("helpers", () => {
  test("sameFacility, familyLink and actionRole", () => {
    expect(access.sameFacility(staff(), F)).toBe(true);
    expect(access.sameFacility(family(), F)).toBe(false);
    expect(access.sameFacility(device(), F)).toBe(true);
    expect(access.familyLink(SEED_IDS.familyUser, R1)).toMatchObject({ label: "daughter" });
    expect(access.familyLink(SEED_IDS.familyUser, "r2")).toBeUndefined();
    expect(access.familyLinks(SEED_IDS.familyUser)).toHaveLength(1);
    expect([admin(), staff(), family(), device()].map(actionRole)).toEqual(["staff", "staff", "family", "device"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/api/test/access.test.ts`
Expected: FAIL — cannot resolve `../src/services/access`.

- [ ] **Step 3: Replace the principal type in `apps/api/src/auth/plugin.ts`**

```ts
import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";

export type UserRole = "family" | "staff" | "admin";
export type Principal =
  | { kind: "user"; id: string; role: UserRole; facilityId: string | null }
  | { kind: "device"; id: string; residentId: string; facilityId: string; robotId: string | null; assignmentVersion: number };
```

Keep the `declare module` blocks and `authPlugin` unchanged. Change `requireRole`'s parameter type only (Task 4 changes its body):

```ts
export function requireRole(...roles: Array<UserRole | "device">): preHandlerHookHandler {
```

- [ ] **Step 4: Create `apps/api/src/services/access.ts`**

```ts
import { and, eq } from "drizzle-orm";
import type { AuditEvent } from "@oncare/core";
import type { Principal } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";

export type FamilyLink = typeof t.familyRelationship.$inferSelect;

/** Visit and task action tables know three roles. An admin acts with staff powers inside its facility. */
export function actionRole(p: Principal): "family" | "staff" | "device" {
  if (p.kind === "device") return "device";
  return p.role === "admin" ? "staff" : p.role;
}

/**
 * The single answer to "may this principal touch this resident / see this audit event?".
 * Routes, the events WebSocket and AI tools all go through here.
 */
export function createAccess(db: Db) {
  function resolvePrincipal(claims: Principal): Principal | null {
    if (claims.kind === "user") {
      const u = db.select().from(t.user).where(eq(t.user.id, claims.id)).get();
      if (!u || !u.active) return null;
      return { kind: "user", id: u.id, role: u.role, facilityId: u.facilityId ?? null };
    }
    const d = db.select().from(t.device).where(eq(t.device.id, claims.id)).get();
    if (!d || !d.active || d.residentId !== claims.residentId || d.assignmentVersion !== claims.assignmentVersion) return null;
    return { kind: "device", id: d.id, residentId: d.residentId, facilityId: d.facilityId, robotId: d.robotId ?? null, assignmentVersion: d.assignmentVersion };
  }

  function residentIdsVisibleTo(p: Principal): string[] {
    if (p.kind === "device") {
      const r = db.select().from(t.resident).where(and(eq(t.resident.id, p.residentId), eq(t.resident.active, true))).get();
      return r ? [r.id] : [];
    }
    if (p.role === "admin") {
      if (!p.facilityId) return [];
      return db.select({ id: t.resident.id }).from(t.resident)
        .where(and(eq(t.resident.facilityId, p.facilityId), eq(t.resident.active, true))).all().map((r) => r.id);
    }
    if (p.role === "staff") {
      if (!p.facilityId) return [];
      return db.select({ id: t.resident.id }).from(t.staffAssignment)
        .innerJoin(t.resident, eq(t.resident.id, t.staffAssignment.residentId))
        .where(and(
          eq(t.staffAssignment.userId, p.id), eq(t.staffAssignment.active, true),
          eq(t.resident.facilityId, p.facilityId), eq(t.resident.active, true),
        )).all().map((r) => r.id);
    }
    return db.select({ id: t.resident.id }).from(t.familyRelationship)
      .innerJoin(t.resident, eq(t.resident.id, t.familyRelationship.residentId))
      .where(and(eq(t.familyRelationship.userId, p.id), eq(t.resident.active, true))).all().map((r) => r.id);
  }

  function canAccessResident(p: Principal, residentId: string): boolean {
    return residentIdsVisibleTo(p).includes(residentId);
  }

  function sameFacility(p: Principal, facilityId: string): boolean {
    return p.facilityId !== null && p.facilityId === facilityId;
  }

  function familyLink(userId: string, residentId: string): FamilyLink | undefined {
    return db.select().from(t.familyRelationship)
      .where(and(eq(t.familyRelationship.userId, userId), eq(t.familyRelationship.residentId, residentId))).get();
  }

  function familyLinks(userId: string): FamilyLink[] {
    return db.select().from(t.familyRelationship).where(eq(t.familyRelationship.userId, userId)).all();
  }

  function robotFacility(robotId: string): string | null {
    return db.select({ f: t.robot.facilityId }).from(t.robot).where(eq(t.robot.id, robotId)).get()?.f ?? null;
  }

  /**
   * Resident-bound events follow resident scope (family and devices only for their own visits/tasks);
   * robot and command events are facility-level for staff and admins; admin-managed records and tool
   * calls carry the facility id as correlation id and are visible to that facility's admins.
   */
  function auditVisibleTo(p: Principal, ev: AuditEvent, visible: Set<string> = new Set(residentIdsVisibleTo(p))): boolean {
    const isStaffLike = p.kind === "user" && (p.role === "staff" || p.role === "admin");
    switch (ev.entityType) {
      case "resident":
        return isStaffLike && visible.has(ev.entityId);
      case "visit": {
        const v = db.select().from(t.visitSession).where(eq(t.visitSession.id, ev.entityId)).get();
        if (!v || !visible.has(v.residentId)) return false;
        return p.kind === "device" || isStaffLike || v.requesterId === p.id;
      }
      case "task": {
        const k = db.select().from(t.taskRequest).where(eq(t.taskRequest.id, ev.entityId)).get();
        if (!k || !visible.has(k.residentId)) return false;
        return p.kind === "device" || isStaffLike || k.requesterId === p.id;
      }
      case "robot": {
        const f = robotFacility(ev.entityId);
        return isStaffLike && f !== null && sameFacility(p, f);
      }
      case "command": {
        const c = db.select().from(t.robotCommand).where(eq(t.robotCommand.id, ev.entityId)).get();
        const f = c ? robotFacility(c.robotId) : null;
        return isStaffLike && f !== null && sameFacility(p, f);
      }
      default:
        return p.kind === "user" && p.role === "admin" && p.facilityId !== null && ev.correlationId === p.facilityId;
    }
  }

  return { resolvePrincipal, residentIdsVisibleTo, canAccessResident, sameFacility, familyLink, familyLinks, auditVisibleTo };
}

export type Access = ReturnType<typeof createAccess>;
```

- [ ] **Step 5: Emit the new principal shape at login** — in `apps/api/src/routes/auth.ts`:

```ts
    const u = db.select().from(t.user).where(eq(t.user.username, body.data.username)).get();
    if (!u || !u.active || !(await verifySecret(body.data.password, u.passwordHash))) return reply.code(401).send({ error: "invalid_credentials" });
    const principal: Principal = { kind: "user", id: u.id, role: u.role, facilityId: u.facilityId ?? null };
```

```ts
        const principal: Principal = { kind: "device", id: d.id, residentId: d.residentId, facilityId: d.facilityId, robotId: d.robotId ?? null, assignmentVersion: d.assignmentVersion };
```

Add `import type { Principal } from "../auth/plugin";`.

- [ ] **Step 6: Route action roles through `actionRole`**

`apps/api/src/services/visits.ts:29-30`:

```ts
function roleOf(p: Principal): "family" | "staff" | "device" { return actionRole(p); }
function actorTypeOf(p: Principal): ActorType { return p.kind === "device" ? "device" : p.role; }
```

Add `import { actionRole } from "./access";`.

`apps/api/src/services/tasks.ts:166`:

```ts
    const role: ActionRole = actionRole(input.principal);
```

and at line 174 use the audited actor type: `actorType: input.principal.kind === "device" ? "device" : input.principal.role,`. Add `import { actionRole } from "./access";`.

`apps/api/src/routes/video.ts:45`:

```ts
    const role = actionRole(principal);
```

Add `import { actionRole } from "../services/access";`.

- [ ] **Step 7: Decorate `app.access`** — in `apps/api/src/app.ts`, add `import { createAccess, type Access } from "./services/access";`, add `access: Access;` to the `FastifyInstance` augmentation, and as the first decoration in `buildApp`:

```ts
  app.decorate("access", createAccess(opts.db));
```

- [ ] **Step 8: Fix the test that forges a device JWT** — `apps/api/test/video.test.ts:98`:

```ts
    const otherDevice = app.jwt.sign({ kind: "device", id: "other_device", residentId: "other_resident", facilityId: SEED_IDS.facility, robotId: SEED_IDS.robot, assignmentVersion: 1 });
```

(It still expects 403 here; Task 4 changes it.)

- [ ] **Step 9: Run tests and typecheck**

Run: `npx vitest run --project node && npx tsc -b`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/api
git commit -m "feat(api): single access module and facility-aware principal"
```

---

### Task 4: Re-validate the principal on every request

**Files:**
- Modify: `apps/api/src/auth/plugin.ts` (`requireRole` body, augmentation), `apps/api/src/routes/events-ws.ts`
- Test: `apps/api/test/revalidation.test.ts` (create), `apps/api/test/helpers.ts`, `apps/api/test/video.test.ts:95-101`

**Interfaces:**
- Consumes: `app.access.resolvePrincipal`, `app.access.auditVisibleTo` (Task 3).
- Produces: `makeTestApp()` returns `tokens.admin` as well; `requireRole` sets `req.principal` to the **freshly resolved** principal.

- [ ] **Step 1: Add the admin token to the test helper** — `apps/api/test/helpers.ts:16`:

```ts
  return { app, db, video, tokens: {
    family: await login("family", SEED_SECRETS.familyPassword), staff: await login("staff", SEED_SECRETS.staffPassword),
    admin: await login("admin", SEED_SECRETS.adminPassword), device,
  } };
```

- [ ] **Step 2: Write the failing test** — create `apps/api/test/revalidation.test.ts`:

```ts
import { afterEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import WebSocket from "ws";
import { listen, makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS, SEED_SECRETS } from "../src/db/seed";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

describe("per-request revalidation", () => {
  test("deactivating a user revokes its live token and blocks login", async () => {
    const { app, db, tokens } = await makeTestApp();
    expect((await app.inject({ method: "GET", url: "/queue", headers: auth(tokens.staff) })).statusCode).toBe(200);
    db.update(t.user).set({ active: false }).where(eq(t.user.id, SEED_IDS.staffUser)).run();
    expect((await app.inject({ method: "GET", url: "/queue", headers: auth(tokens.staff) })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { username: "staff", password: SEED_SECRETS.staffPassword } })).statusCode).toBe(401);
  });

  test("reassigning or deactivating an iPad revokes its live token", async () => {
    const { app, db, tokens } = await makeTestApp();
    const state = () => app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.device) });
    expect((await state()).statusCode).toBe(200);
    db.update(t.device).set({ assignmentVersion: 2 }).run();
    expect((await state()).statusCode).toBe(401);
    db.update(t.device).set({ assignmentVersion: 1, active: false }).run();
    expect((await state()).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/device", payload: { deviceToken: SEED_SECRETS.deviceToken } })).statusCode).toBe(401);
  });

  test("a role change takes effect without a new token", async () => {
    const { app, db, tokens } = await makeTestApp();
    db.update(t.user).set({ role: "family", facilityId: null }).where(eq(t.user.id, SEED_IDS.staffUser)).run();
    expect((await app.inject({ method: "GET", url: "/queue", headers: auth(tokens.staff) })).statusCode).toBe(403);
  });

  test("the events socket closes with 4401 once its principal is deactivated", async () => {
    const { app, db, tokens } = await makeTestApp();
    const srv = await listen(app); closers.push(srv.close);
    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/events?token=${tokens.staff}`);
    await new Promise((resolve) => ws.once("open", resolve));
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    db.update(t.user).set({ active: false }).where(eq(t.user.id, SEED_IDS.staffUser)).run();
    await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } });
    expect(await closed).toBe(4401);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run apps/api/test/revalidation.test.ts`
Expected: FAIL — deactivated staff still gets 200; socket stays open.

- [ ] **Step 4: Resolve in `requireRole`** — `apps/api/src/auth/plugin.ts`. Add `import type { Access } from "../services/access";` and inside the existing `declare module "fastify"` block add `interface FastifyInstance { access: Access }`. Remove `access: Access;` from the augmentation in `app.ts` (it now lives here). Replace the body of `requireRole`:

```ts
export function requireRole(...roles: Array<UserRole | "device">): preHandlerHookHandler {
  return async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
    // JWT claims only say who the caller was at login. Authority is re-read on every request so that
    // disabling a user, disabling an iPad or moving it to another resident takes effect immediately.
    const p = req.server.access.resolvePrincipal(req.user);
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    const role = p.kind === "device" ? "device" : p.role;
    if (!roles.includes(role)) return reply.code(403).send({ error: "forbidden" });
    req.principal = p;
  };
}
```

- [ ] **Step 5: Re-resolve on the events socket** — replace `apps/api/src/routes/events-ws.ts` with:

```ts
import type { FastifyInstance } from "fastify";
import type { Principal } from "../auth/plugin";
import type { Db } from "../db/client";

export async function eventsRoutes(app: FastifyInstance, _opts: { db: Db }) {
  app.get("/events", { websocket: true }, (socket, req) => {
    const { token } = req.query as { token?: string };
    let claims: Principal;
    try { claims = app.jwt.verify<Principal>(token ?? ""); } catch { socket.close(4401, "unauthorized"); return; }
    const principal = app.access.resolvePrincipal(claims);
    if (!principal) { socket.close(4401, "unauthorized"); return; }

    socket.send(JSON.stringify({ type: "hello", principal }));
    const unsubscribe = app.transitions.subscribe((ev) => {
      if (socket.readyState !== socket.OPEN) return;
      const current = app.access.resolvePrincipal(claims);
      if (!current) { unsubscribe(); socket.close(4401, "unauthorized"); return; }
      if (app.access.auditVisibleTo(current, ev)) socket.send(JSON.stringify(ev));
    });
    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
  });
}
```

- [ ] **Step 6: A forged token for a non-existent device is now 401** — `apps/api/test/video.test.ts:95,99`:

```ts
  test("missing visits return 404 and unknown devices are rejected without issuing tokens", async () => {
```

```ts
    expect((await token(otherDevice)).statusCode).toBe(401);
```

(The "device of another resident → 403" case stays covered by `visit-actions.test.ts:92`.)

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run --project node && npx tsc -b`
Expected: `revalidation.test.ts` PASS. `events-ws.test.ts` "staff receives all visit transitions" now FAILS, because staff see only the assigned resident's events through `auditVisibleTo`. That is the intended behaviour; Step 8 updates the test.

- [ ] **Step 8: Update the events test to the new scope** — `apps/api/test/events-ws.test.ts:24,45`:

```ts
  test("staff receives assigned residents' visit transitions; family only its own; device only its resident's", async () => {
```

```ts
    expect(states(staff.messages)).toEqual(["awaiting_policy_or_staff", "accepted"]);
```

Re-run: `npx vitest run --project node` → PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api
git commit -m "feat(api): re-validate principals on every request and on every pushed event"
```

---

### Task 5: Retrofit routes and services onto `access`

**Files:**
- Modify: `apps/api/src/routes/staff.ts`, `apps/api/src/routes/me.ts`, `apps/api/src/routes/robots.ts`, `apps/api/src/routes/locations.ts`, `apps/api/src/routes/video.ts:15`, `apps/api/src/routes/visits.ts`, `apps/api/src/routes/tasks.ts`, `apps/api/src/routes/benchmark.ts:17`, `apps/api/src/routes/device.ts:81`, `apps/api/src/services/visits.ts:71-96`, `apps/api/src/services/tasks.ts:87-93,139-160`
- Test: `apps/api/test/scope.test.ts` (create), `apps/api/test/staff.test.ts:89`

**Interfaces:**
- Consumes: `app.access` (Tasks 3–4).
- Produces: `createVisitService` / `createTaskService` build their own `createAccess(db)`; no file outside `services/access.ts` queries `familyRelationship` or `staffAssignment` for authorization.

- [ ] **Step 1: Write the failing scope test** — create `apps/api/test/scope.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";
import { hashSecret } from "../src/auth/password";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function withSecondResidentAndNurse() {
  const ctx = await makeTestApp();
  const { app, db } = ctx;
  db.insert(t.resident).values({ id: "r2", facilityId: SEED_IDS.facility, displayName: "Two", roomLocationId: SEED_IDS.roomLocation }).run();
  db.insert(t.user).values({ id: "fam2", role: "family", username: "family2", displayName: "Son", passwordHash: await hashSecret("pw"), pinHash: null, facilityId: null }).run();
  db.insert(t.familyRelationship).values({ id: "rel2", userId: "fam2", residentId: "r2", label: "son", consentVideo: true, consentRobotVisit: true, consentItemDelivery: true }).run();
  db.insert(t.user).values({ id: "nurse2", role: "staff", username: "nurse2", displayName: "Nurse Two", passwordHash: await hashSecret("pw"), pinHash: await hashSecret("1357"), facilityId: SEED_IDS.facility }).run();
  const login = async (username: string) => (await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: "pw" } })).json().token as string;
  return { ...ctx, family2: await login("family2"), nurse2: await login("nurse2") };
}

describe("staff scope", () => {
  test("audit shows only assigned residents' visits; every facility nurse still sees the robot", async () => {
    const { app, tokens, family2, nurse2 } = await withSecondResidentAndNurse();
    // Each visit writes two visit transitions (awaiting_policy_or_staff, accepted).
    await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } });
    await app.inject({ method: "POST", url: "/visits", headers: auth(family2), payload: { residentId: "r2" } });
    const visitEvents = async (token: string) => (await app.inject({ method: "GET", url: "/audit", headers: auth(token) })).json().events.filter((e: { entityType: string }) => e.entityType === "visit").length;
    expect(await visitEvents(tokens.staff)).toBe(2);
    expect(await visitEvents(nurse2)).toBe(0);
    expect(await visitEvents(tokens.admin)).toBe(4);
    expect((await app.inject({ method: "GET", url: "/audit?residentId=r2", headers: auth(tokens.staff) })).statusCode).toBe(403);
    for (const token of [tokens.staff, nurse2, tokens.admin]) {
      expect((await app.inject({ method: "GET", url: "/queue", headers: auth(token) })).json().robot).toMatchObject({ robotId: SEED_IDS.robot });
    }
  });

  test("pending approvals are filtered by assignment", async () => {
    const { app, db, tokens, family2, nurse2 } = await withSecondResidentAndNurse();
    db.update(t.resident).set({ availability: "in_activity" }).run();
    await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } });
    await app.inject({ method: "POST", url: "/visits", headers: auth(family2), payload: { residentId: "r2" } });
    const pending = async (token: string) => (await app.inject({ method: "GET", url: "/queue", headers: auth(token) })).json().visitsAwaitingApproval.map((v: { residentId: string }) => v.residentId).sort();
    expect(await pending(tokens.staff)).toEqual([SEED_IDS.resident]);
    expect(await pending(nurse2)).toEqual([]);
    expect(await pending(tokens.admin)).toEqual([SEED_IDS.resident, "r2"]);
  });

  test("staff cannot act on or read visits of unassigned residents", async () => {
    const { app, db, family2, nurse2 } = await withSecondResidentAndNurse();
    db.update(t.resident).set({ availability: "in_activity" }).run();
    const visit = (await app.inject({ method: "POST", url: "/visits", headers: auth(family2), payload: { residentId: "r2" } })).json().visit;
    expect((await app.inject({ method: "GET", url: `/visits/${visit.id}`, headers: auth(nurse2) })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/visits/${visit.id}/approve`, headers: auth(nurse2) })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: "/residents/r2/availability", headers: auth(nurse2), payload: { availability: "resting" } })).statusCode).toBe(403);
  });

  test("an unassigned nurse and an admin can still STOP the facility robot", async () => {
    const { app, tokens, nurse2 } = await withSecondResidentAndNurse();
    for (const token of [nurse2, tokens.admin]) {
      const res = await app.inject({ method: "POST", url: `/robots/${SEED_IDS.robot}/stop`, headers: auth(token) });
      expect(res.statusCode).toBe(200);
    }
  });

  test("robot and locations of another facility are invisible", async () => {
    const { app, db, tokens } = await makeTestApp();
    db.insert(t.facility).values({ id: "fb", name: "B", timezone: "Asia/Taipei" }).run();
    db.insert(t.robot).values({ id: "robot_b", facilityId: "fb", name: "B", tokenHash: "x" }).run();
    db.insert(t.location).values({ id: "loc_b", facilityId: "fb", name: "B room", kind: "resident_room", x: 0, y: 0, yaw: 0, approved: true }).run();
    expect((await app.inject({ method: "POST", url: "/robots/robot_b/stop", headers: auth(tokens.staff) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/robots/robot_b/status", headers: auth(tokens.staff) })).statusCode).toBe(404);
    const locations = (await app.inject({ method: "GET", url: "/locations", headers: auth(tokens.staff) })).json().locations.map((l: { id: string }) => l.id);
    expect(locations).not.toContain("loc_b");
    expect((await app.inject({ method: "PATCH", url: "/locations/loc_b", headers: auth(tokens.staff), payload: { approved: false } })).statusCode).toBe(404);
  });

  test("family no longer sees a resident whose link or record is gone", async () => {
    const { app, db, tokens } = await makeTestApp();
    db.update(t.resident).set({ active: false }).where(eq(t.resident.id, SEED_IDS.resident)).run();
    expect((await app.inject({ method: "GET", url: "/me/residents", headers: auth(tokens.family) })).json().residents).toEqual([]);
    expect((await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } })).statusCode).not.toBe(201);
  });

  test("a device unlock PIN must belong to active staff or admin of the device's facility", async () => {
    const { app, db, tokens } = await makeTestApp();
    const unlock = (pin: string) => app.inject({ method: "POST", url: "/device/unlock", headers: auth(tokens.device), payload: { pin } });
    expect((await unlock("2468")).statusCode).toBe(200);
    db.update(t.user).set({ active: false }).run();
    expect((await unlock("2468")).statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/api/test/scope.test.ts`
Expected: FAIL — nurse2 sees everything; admin gets 403 on `/queue`.

- [ ] **Step 3: Staff routes** — `apps/api/src/routes/staff.ts`:

```ts
  const staffOnly = { preHandler: requireRole("staff", "admin") };
```

In `GET /queue` replace the first three lines and the returned `caregiverCalls` / `robot` / list filters:

```ts
  app.get("/queue", staffOnly, async (req) => {
    const p = req.principal;
    const visible = new Set(app.access.residentIdsVisibleTo(p));
    const robot = p.facilityId ? db.select().from(t.robot).where(eq(t.robot.facilityId, p.facilityId)).get() : undefined;
    const visits = db.select().from(t.visitSession).all().filter(v => visible.has(v.residentId));
    const tasks = db.select().from(t.taskRequest).all().filter(k => visible.has(k.residentId));
```

and for `caregiverCalls`, after the existing `.map(...)`, append:

```ts
      })).filter(call => call.residentId === null || visible.has(call.residentId)),
```

(A caregiver call whose device no longer exists carries no resident data, so it stays visible to facility staff — the existing "historical audit IDs" test relies on this.)

Replace `GET /audit`'s filtering:

```ts
  app.get("/audit", staffOnly, async (req, reply) => {
    const parsed = z.object({ residentId: z.string().min(1).optional(), since: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    const q = parsed.data;
    const p = req.principal;
    const visible = new Set(app.access.residentIdsVisibleTo(p));
    if (q.residentId && !visible.has(q.residentId)) return reply.code(403).send({ error: "forbidden" });
    let rows = db.select().from(t.auditEvent).orderBy(desc(t.auditEvent.at), desc(t.auditEvent.id)).all()
      .filter(e => app.access.auditVisibleTo(p, e as AuditEvent, visible));
    if (q.since) rows = rows.filter(e => Date.parse(e.at) >= Date.parse(q.since!));
    if (q.residentId) {
      const visits = new Set(db.select().from(t.visitSession).where(eq(t.visitSession.residentId, q.residentId)).all().map(v => v.id));
      const tasks = new Set(db.select().from(t.taskRequest).where(eq(t.taskRequest.residentId, q.residentId)).all().map(k => k.id));
      rows = rows.filter(e => (e.entityType === "resident" && e.entityId === q.residentId) || (e.entityType === "visit" && visits.has(e.entityId)) || (e.entityType === "task" && tasks.has(e.entityId)));
    }
    return { events: rows.slice(0, q.limit) };
  });
```

Add `import type { AuditEvent } from "@oncare/core";`. In `PATCH /residents/:id/availability`, replace the 404 lookup with a scope check first:

```ts
    const p = req.principal;
    if (!app.access.canAccessResident(p, id)) return reply.code(403).send({ error: "forbidden" });
    const resident = db.select().from(t.resident).where(eq(t.resident.id, id)).get()!;
    if (p.kind !== "user") return reply.code(403).send({ error: "forbidden" });
    const event = makeTransitionEvent({ actorType: p.role === "admin" ? "admin" : "staff", actorId: p.id, entityType: "resident", entityId: id, fromState: resident.availability, toState: parsed.data.availability, reason: "availability_changed", correlationId: id, now });
```

(delete the old `const resident = ...; if (!resident) return 404` and the duplicate `const p` lines).

`apps/api/test/staff.test.ts:89` — resident-scoped routes never reveal existence:

```ts
    expect((await patch("missing", "available")).statusCode).toBe(403);
```

- [ ] **Step 4: `me.ts`** — filter by visible residents:

```ts
  app.get("/me/residents", { preHandler: requireRole("family") }, async (req) => {
    const p = req.principal;
    if (p.kind !== "user") return { residents: [] };
    const visible = new Set(app.access.residentIdsVisibleTo(p));
    const rows = db
      .select({ /* unchanged column list */ })
      .from(t.familyRelationship)
      .innerJoin(t.resident, eq(t.resident.id, t.familyRelationship.residentId))
      .where(eq(t.familyRelationship.userId, p.id))
      .all()
      .filter((r) => visible.has(r.id));
```

Keep the existing column list and the `return` mapping unchanged.

- [ ] **Step 5: Visit and task services**

`apps/api/src/services/visits.ts` — add `import { actionRole, createAccess } from "./access";` (merge with the Task 3 import) and, at the top of `createVisitService`, `const access = createAccess(db);`. Replace `create`'s first lines and `canView`:

```ts
  function create(input: { requesterId: string; residentId: string }) {
    const rel = access.familyLink(input.requesterId, input.residentId);
    if (!rel) return { ok: false as const, error: "no_relationship" as const };
    if (!(rel.consentVideo && rel.consentRobotVisit)) return { ok: false as const, error: "consent_missing" as const };
    const resident = db.select().from(t.resident).where(eq(t.resident.id, input.residentId)).get();
    if (!resident || !resident.active || resident.availability === "not_available") return { ok: false as const, error: "resident_unavailable" as const };
```

```ts
  function canView(principal: Principal, visit: VisitRow): boolean {
    if (principal.kind === "device") return principal.residentId === visit.residentId;
    if (principal.role === "family") return principal.id === visit.requesterId && access.canAccessResident(principal, visit.residentId);
    return access.canAccessResident(principal, visit.residentId);
  }
```

Remove the now-unused `and` import if `tsc` flags it.

`apps/api/src/services/tasks.ts` — same `const access = createAccess(db);`, then:

```ts
    const relationship = access.familyLink(input.requesterId, input.residentId);
    if (!relationship) return { ok: false as const, error: "no_relationship" as const };
    if (!relationship.consentItemDelivery) return { ok: false as const, error: "consent_missing" as const };
```

```ts
    const authorizedRecipients = access.familyLinks(input.requesterId)
      .filter((row) => row.consentItemDelivery).map((row) => row.residentId);
```

```ts
  function canView(principal: Principal, task: TaskRow): boolean {
    if (principal.kind === "device") return principal.residentId === task.residentId;
    if (principal.role === "family") return principal.id === task.requesterId && access.canAccessResident(principal, task.residentId);
    return access.canAccessResident(principal, task.residentId);
  }
```

- [ ] **Step 6: Admin passes staff route guards** — change these `requireRole` calls to include `"admin"` wherever `"staff"` appears:
  - `apps/api/src/routes/visits.ts` (`GET /visits/:id`, `POST /visits/:id/:action`)
  - `apps/api/src/routes/tasks.ts` (`GET /tasks/:id`, `POST /tasks/:id/:action`)
  - `apps/api/src/routes/video.ts` (`POST /visits/:id/camera`, `POST /visits/:id/token`)
  - `apps/api/src/routes/benchmark.ts:17`
  - `apps/api/src/routes/robots.ts`, `apps/api/src/routes/locations.ts` (below)

In `video.ts` `POST /visits/:id/camera`, after the 404 check add:

```ts
    if (!app.visits.canView(req.principal, visit)) return reply.code(403).send({ error: "forbidden" });
```

- [ ] **Step 7: Robots and locations are facility-level** — `apps/api/src/routes/robots.ts`:

```ts
  const staffLike = { preHandler: requireRole("staff", "admin") };
  const robotInFacility = (id: string, p: Principal) => {
    const robot = db.select().from(t.robot).where(eq(t.robot.id, id)).get();
    return robot !== undefined && app.access.sameFacility(p, robot.facilityId);
  };
```

In each of the four handlers replace `requireRole("staff")` with `staffLike` and `if (!robotExists(id))` with `if (!robotInFacility(id, req.principal))` (still 404 — a robot of another facility does not exist for the caller). Delete `robotExists`. Add `import type { Principal } from "../auth/plugin";`.

`apps/api/src/routes/locations.ts`:

```ts
  app.get("/locations", { preHandler: requireRole("staff", "admin") }, async (req) => ({
    locations: db.select().from(t.location).all().filter(l => app.access.sameFacility(req.principal, l.facilityId)),
  }));
  app.patch("/locations/:id", { preHandler: requireRole("staff", "admin") }, async (req, reply) => {
```

and inside the transaction change `if (!existing) return null;` to:

```ts
      if (!existing || !app.access.sameFacility(principal, existing.facilityId)) return null;
```

and `actorType: "staff"` to `actorType: principal.role === "admin" ? "admin" : "staff"`.

- [ ] **Step 8: Device unlock PIN is facility-scoped** — `apps/api/src/routes/device.ts:81`:

```ts
    const staff = db.select().from(t.user).where(and(
      eq(t.user.facilityId, principal.facilityId), eq(t.user.active, true), inArray(t.user.role, ["staff", "admin"]),
    )).all();
```

Add `inArray` to the drizzle import.

- [ ] **Step 9: Run tests and typecheck**

Run: `npx vitest run --project node && npx tsc -b`
Expected: PASS. Then confirm no stray authorization queries:
Run: `git grep -n "familyRelationship\|staffAssignment" apps/api/src -- ':!apps/api/src/services/access.ts' ':!apps/api/src/db'`
Expected: only `routes/me.ts` (data join for consent flags, filtered by `access`).

- [ ] **Step 10: Commit**

```bash
git add apps/api
git commit -m "feat(api): scope queue, audit, visits, tasks, robots and locations through access"
```

---

### Task 6: Care-house admin API

**Files:**
- Create: `apps/api/src/routes/admin.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/admin.test.ts` (create)

**Interfaces:**
- Consumes: `requireRole("admin")`, `app.access`, `app.transitions.emit`, `hashSecret`.
- Produces (HTTP, all admin-only, facility-scoped):
  - `GET /admin/residents` → `{ residents: Resident[] }`; `POST /admin/residents` `{ displayName, roomLocationId }` → 201 `{ resident }`; `PATCH /admin/residents/:id` `{ displayName?, roomLocationId? }`; `POST /admin/residents/:id/deactivate`
  - `GET /admin/users` → `{ users: Array<{ id, role, username, displayName, facilityId, active }> }`; `POST /admin/users` `{ role: "staff" | "family", username, displayName, password, pin? }` → 201 `{ user }`; `POST /admin/users/:id/deactivate`; `POST /admin/users/:id/reset-password` `{ password }`; `POST /admin/users/:id/reset-pin` `{ pin }`
  - `GET /admin/family-links`; `POST /admin/family-links` `{ userId, residentId, label, consentVideo?, consentRobotVisit?, consentItemDelivery? }` → 201; `PATCH /admin/family-links/:id`; `DELETE /admin/family-links/:id`
  - `GET /admin/staff-assignments`; `POST /admin/staff-assignments` `{ userId, residentId }` → 201; `DELETE /admin/staff-assignments/:id` (sets `active = false`)
  - `GET /admin/devices` → `{ devices: Array<device without deviceTokenHash> }`; `POST /admin/devices` `{ residentId, robotId? }` → 201 `{ device, deviceToken }`; `POST /admin/devices/:id/assign` `{ residentId }`; `POST /admin/devices/:id/deactivate`
  - Errors: 400 `bad_request` / `bad_location` / `bad_role`; 403 `forbidden` (outside facility, including unknown ids); 409 `username_taken` / `duplicate` / `cannot_deactivate_self`.

- [ ] **Step 1: Write the failing test** — create `apps/api/test/admin.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function adminApp() {
  const ctx = await makeTestApp();
  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, token = ctx.tokens.admin) =>
    ctx.app.inject({ method, url, headers: auth(token), ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { ...ctx, call };
}

describe("admin API", () => {
  test("only admins may call it", async () => {
    const { call, tokens } = await adminApp();
    for (const token of [tokens.staff, tokens.family, tokens.device]) expect((await call("GET", "/admin/residents", undefined, token)).statusCode).toBe(403);
  });

  test("residents: create, edit, deactivate, audited with the facility as correlation id", async () => {
    const { call, db } = await adminApp();
    const created = await call("POST", "/admin/residents", { displayName: "New", roomLocationId: SEED_IDS.roomLocation });
    expect(created.statusCode).toBe(201);
    const id = created.json().resident.id as string;
    expect((await call("POST", "/admin/residents", { displayName: "X", roomLocationId: SEED_IDS.pickupLocation })).json()).toEqual({ error: "bad_location" });
    expect((await call("PATCH", `/admin/residents/${id}`, { displayName: "Renamed" })).json().resident.displayName).toBe("Renamed");
    expect((await call("POST", `/admin/residents/${id}/deactivate`)).json().resident.active).toBe(false);
    const audit = db.select().from(t.auditEvent).all().filter((e) => e.actorType === "admin");
    expect(audit.map((e) => e.reason)).toEqual(["resident_created", "resident_updated", "resident_deactivated"]);
    expect(audit.every((e) => e.correlationId === SEED_IDS.facility && e.entityType === "resident")).toBe(true);
  });

  test("users: create staff and family, reject duplicates, never return hashes, cannot deactivate self", async () => {
    const { call } = await adminApp();
    const staff = await call("POST", "/admin/users", { role: "staff", username: "nurse9", displayName: "Nurse", password: "pw-long", pin: "1111" });
    expect(staff.statusCode).toBe(201);
    expect(staff.json().user).toEqual({ id: expect.any(String), role: "staff", username: "nurse9", displayName: "Nurse", facilityId: SEED_IDS.facility, active: true });
    expect((await call("POST", "/admin/users", { role: "family", username: "nurse9", displayName: "Dup", password: "pw-long" })).json()).toEqual({ error: "username_taken" });
    expect((await call("POST", "/admin/users", { role: "admin", username: "boss", displayName: "Boss", password: "pw-long" })).statusCode).toBe(400);
    const fam = (await call("POST", "/admin/users", { role: "family", username: "son9", displayName: "Son", password: "pw-long" })).json().user;
    expect(fam.facilityId).toBeNull();
    const listed = (await call("GET", "/admin/users")).json().users as Array<Record<string, unknown>>;
    expect(listed.some((u) => "passwordHash" in u || "pinHash" in u)).toBe(false);
    // A family member with no link to this facility is not listed.
    expect(listed.map((u) => u.username)).not.toContain("son9");
    expect((await call("POST", `/admin/users/${SEED_IDS.adminUser}/deactivate`)).json()).toEqual({ error: "cannot_deactivate_self" });
  });

  test("family links and staff assignments grant and revoke access", async () => {
    const { app, call, db } = await adminApp();
    const fam = (await call("POST", "/admin/users", { role: "family", username: "son9", displayName: "Son", password: "pw-long" })).json().user;
    const link = await call("POST", "/admin/family-links", { userId: fam.id, residentId: SEED_IDS.resident, label: "son", consentVideo: true });
    expect(link.statusCode).toBe(201);
    expect((await call("POST", "/admin/family-links", { userId: fam.id, residentId: SEED_IDS.resident, label: "son" })).json()).toEqual({ error: "duplicate" });
    const famToken = (await app.inject({ method: "POST", url: "/auth/login", payload: { username: "son9", password: "pw-long" } })).json().token;
    const mine = async () => (await app.inject({ method: "GET", url: "/me/residents", headers: auth(famToken) })).json().residents.length;
    expect(await mine()).toBe(1);
    expect((await call("DELETE", `/admin/family-links/${link.json().link.id}`)).statusCode).toBe(200);
    expect(await mine()).toBe(0);

    const nurse = (await call("POST", "/admin/users", { role: "staff", username: "nurse9", displayName: "N", password: "pw-long" })).json().user;
    const sa = await call("POST", "/admin/staff-assignments", { userId: nurse.id, residentId: SEED_IDS.resident });
    expect(sa.statusCode).toBe(201);
    expect((await call("POST", "/admin/staff-assignments", { userId: fam.id, residentId: SEED_IDS.resident })).json()).toEqual({ error: "bad_role" });
    await call("DELETE", `/admin/staff-assignments/${sa.json().assignment.id}`);
    expect(db.select().from(t.staffAssignment).all().find((a) => a.userId === nurse.id)?.active).toBe(false);
    // Re-assigning reactivates the same row instead of failing on the unique index.
    expect((await call("POST", "/admin/staff-assignments", { userId: nurse.id, residentId: SEED_IDS.resident })).statusCode).toBe(201);
  });

  test("devices: token shown once, reassignment revokes the old session, deactivation blocks login", async () => {
    const { app, call, db } = await adminApp();
    const r2 = (await call("POST", "/admin/residents", { displayName: "Two", roomLocationId: SEED_IDS.roomLocation })).json().resident;
    const created = await call("POST", "/admin/devices", { residentId: SEED_IDS.resident });
    expect(created.statusCode).toBe(201);
    const { device, deviceToken } = created.json();
    expect(device).toMatchObject({ residentId: SEED_IDS.resident, robotId: null, active: true, assignmentVersion: 1 });
    expect(device).not.toHaveProperty("deviceTokenHash");
    expect((await call("GET", "/admin/devices")).json().devices.some((d: Record<string, unknown>) => "deviceToken" in d || "deviceTokenHash" in d)).toBe(false);
    expect(db.select().from(t.device).all().some((d) => d.deviceTokenHash.includes(deviceToken))).toBe(false);

    const login = await app.inject({ method: "POST", url: "/auth/device", payload: { deviceToken } });
    expect(login.json().principal).toMatchObject({ residentId: SEED_IDS.resident, robotId: null });
    const session = login.json().token as string;
    const state = () => app.inject({ method: "GET", url: "/device/state", headers: auth(session) });
    expect((await state()).statusCode).toBe(200);

    expect((await call("POST", `/admin/devices/${device.id}/assign`, { residentId: r2.id })).json().device.assignmentVersion).toBe(2);
    expect((await state()).statusCode).toBe(401);
    const relogin = await app.inject({ method: "POST", url: "/auth/device", payload: { deviceToken } });
    expect(relogin.json().principal.residentId).toBe(r2.id);

    await call("POST", `/admin/devices/${device.id}/deactivate`);
    expect((await app.inject({ method: "POST", url: "/auth/device", payload: { deviceToken } })).statusCode).toBe(401);
  });

  test("an admin cannot touch another facility", async () => {
    const { call, db } = await adminApp();
    db.insert(t.facility).values({ id: "fb", name: "B", timezone: "Asia/Taipei" }).run();
    db.insert(t.location).values({ id: "loc_b", facilityId: "fb", name: "B room", kind: "resident_room", x: 0, y: 0, yaw: 0, approved: true }).run();
    db.insert(t.resident).values({ id: "rb", facilityId: "fb", displayName: "B1", roomLocationId: "loc_b" }).run();
    expect((await call("PATCH", "/admin/residents/rb", { displayName: "Hacked" })).statusCode).toBe(403);
    expect((await call("POST", "/admin/devices", { residentId: "rb" })).statusCode).toBe(403);
    expect((await call("POST", "/admin/staff-assignments", { userId: SEED_IDS.staffUser, residentId: "rb" })).statusCode).toBe(403);
    expect((await call("POST", "/admin/residents", { displayName: "X", roomLocationId: "loc_b" })).json()).toEqual({ error: "bad_location" });
    expect((await call("GET", "/admin/residents")).json().residents.map((r: { id: string }) => r.id)).not.toContain("rb");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/api/test/admin.test.ts`
Expected: FAIL — 404 on `/admin/residents`.

- [ ] **Step 3: Create `apps/api/src/routes/admin.ts`**

```ts
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { makeTransitionEvent, type EntityType } from "@oncare/core";
import { requireRole } from "../auth/plugin";
import { hashSecret } from "../auth/password";
import type { Db } from "../db/client";
import * as t from "../db/schema";

type Admin = { id: string; facilityId: string };
type UserRow = typeof t.user.$inferSelect;
type DeviceRow = typeof t.device.$inferSelect;

const publicUser = ({ id, role, username, displayName, facilityId, active }: UserRow) => ({ id, role, username, displayName, facilityId: facilityId ?? null, active });
const publicDevice = ({ deviceTokenHash: _hash, ...rest }: DeviceRow) => rest;

const residentCreate = z.object({ displayName: z.string().trim().min(1).max(80), roomLocationId: z.string().min(1) }).strict();
const residentPatch = residentCreate.partial().strict().refine((v) => Object.keys(v).length > 0);
const userCreate = z.object({
  role: z.enum(["staff", "family"]), username: z.string().trim().min(1).max(64), displayName: z.string().trim().min(1).max(80),
  password: z.string().min(6), pin: z.string().regex(/^\d{4,8}$/).optional(),
}).strict();
const linkCreate = z.object({
  userId: z.string().min(1), residentId: z.string().min(1), label: z.string().trim().min(1).max(40),
  consentVideo: z.boolean().optional(), consentRobotVisit: z.boolean().optional(), consentItemDelivery: z.boolean().optional(),
}).strict();
const linkPatch = linkCreate.omit({ userId: true, residentId: true }).partial().strict().refine((v) => Object.keys(v).length > 0);
const assignmentCreate = z.object({ userId: z.string().min(1), residentId: z.string().min(1) }).strict();
const deviceCreate = z.object({ residentId: z.string().min(1), robotId: z.string().min(1).optional() }).strict();

export async function adminRoutes(app: FastifyInstance, opts: { db: Db; now?: () => Date }) {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());
  const adminOnly = { preHandler: requireRole("admin") };

  /** The calling admin. An admin without a facility manages nothing. */
  function adminOf(req: FastifyRequest): Admin | null {
    const p = req.principal;
    return p.kind === "user" && p.role === "admin" && p.facilityId ? { id: p.id, facilityId: p.facilityId } : null;
  }
  function audit(admin: Admin, entityType: EntityType, entityId: string, reason: string) {
    const ev = makeTransitionEvent({ actorType: "admin", actorId: admin.id, entityType, entityId, fromState: null, toState: null, reason, correlationId: admin.facilityId, now });
    db.insert(t.auditEvent).values(ev).run();
    app.transitions.emit(ev);
  }
  const forbidden = (reply: FastifyReply) => reply.code(403).send({ error: "forbidden" });
  const bad = (reply: FastifyReply, error = "bad_request") => reply.code(400).send({ error });

  const residentIn = (id: string, f: string) => db.select().from(t.resident).where(and(eq(t.resident.id, id), eq(t.resident.facilityId, f))).get();
  const roomIn = (id: string, f: string) => db.select().from(t.location).where(and(eq(t.location.id, id), eq(t.location.facilityId, f), eq(t.location.kind, "resident_room"))).get();
  const facilityResidentIds = (f: string) => db.select({ id: t.resident.id }).from(t.resident).where(eq(t.resident.facilityId, f)).all().map((r) => r.id);
  /** Staff and admins of the facility, and family members linked to one of its residents. */
  function userIn(id: string, f: string): UserRow | undefined {
    const u = db.select().from(t.user).where(eq(t.user.id, id)).get();
    if (!u) return undefined;
    if (u.facilityId === f) return u;
    if (u.role !== "family") return undefined;
    const ids = facilityResidentIds(f);
    const linked = ids.length > 0 && db.select().from(t.familyRelationship).where(and(eq(t.familyRelationship.userId, id), inArray(t.familyRelationship.residentId, ids))).get();
    return linked ? u : undefined;
  }
  const linkIn = (id: string, f: string) => {
    const link = db.select().from(t.familyRelationship).where(eq(t.familyRelationship.id, id)).get();
    return link && residentIn(link.residentId, f) ? link : undefined;
  };
  const deviceIn = (id: string, f: string) => db.select().from(t.device).where(and(eq(t.device.id, id), eq(t.device.facilityId, f))).get();

  // ---- residents
  app.get("/admin/residents", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    return { residents: db.select().from(t.resident).where(eq(t.resident.facilityId, admin.facilityId)).all() };
  });
  app.post("/admin/residents", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const body = residentCreate.safeParse(req.body); if (!body.success) return bad(reply);
    if (!roomIn(body.data.roomLocationId, admin.facilityId)) return bad(reply, "bad_location");
    const id = `resident_${randomUUID()}`;
    db.insert(t.resident).values({ id, facilityId: admin.facilityId, ...body.data }).run();
    audit(admin, "resident", id, "resident_created");
    return reply.code(201).send({ resident: residentIn(id, admin.facilityId) });
  });
  app.patch("/admin/residents/:id", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const { id } = req.params as { id: string };
    if (!residentIn(id, admin.facilityId)) return forbidden(reply);
    const body = residentPatch.safeParse(req.body); if (!body.success) return bad(reply);
    if (body.data.roomLocationId && !roomIn(body.data.roomLocationId, admin.facilityId)) return bad(reply, "bad_location");
    db.update(t.resident).set(body.data).where(eq(t.resident.id, id)).run();
    audit(admin, "resident", id, "resident_updated");
    return { resident: residentIn(id, admin.facilityId) };
  });
  app.post("/admin/residents/:id/deactivate", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const { id } = req.params as { id: string };
    if (!residentIn(id, admin.facilityId)) return forbidden(reply);
    db.update(t.resident).set({ active: false }).where(eq(t.resident.id, id)).run();
    audit(admin, "resident", id, "resident_deactivated");
    return { resident: residentIn(id, admin.facilityId) };
  });

  // ---- users
  app.get("/admin/users", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const users = db.select().from(t.user).all().filter((u) => userIn(u.id, admin.facilityId));
    return { users: users.map(publicUser) };
  });
  app.post("/admin/users", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const body = userCreate.safeParse(req.body); if (!body.success) return bad(reply);
    if (db.select().from(t.user).where(eq(t.user.username, body.data.username)).get()) return reply.code(409).send({ error: "username_taken" });
    const id = `user_${randomUUID()}`;
    db.insert(t.user).values({
      id, role: body.data.role, username: body.data.username, displayName: body.data.displayName,
      passwordHash: await hashSecret(body.data.password),
      pinHash: body.data.role === "staff" && body.data.pin ? await hashSecret(body.data.pin) : null,
      facilityId: body.data.role === "staff" ? admin.facilityId : null,
    }).run();
    audit(admin, "user", id, "user_created");
    return reply.code(201).send({ user: publicUser(db.select().from(t.user).where(eq(t.user.id, id)).get()!) });
  });
  app.post("/admin/users/:id/deactivate", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const { id } = req.params as { id: string };
    if (id === admin.id) return reply.code(409).send({ error: "cannot_deactivate_self" });
    if (!userIn(id, admin.facilityId)) return forbidden(reply);
    db.update(t.user).set({ active: false }).where(eq(t.user.id, id)).run();
    audit(admin, "user", id, "user_deactivated");
    return { user: publicUser(db.select().from(t.user).where(eq(t.user.id, id)).get()!) };
  });
  app.post("/admin/users/:id/reset-password", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const { id } = req.params as { id: string };
    if (!userIn(id, admin.facilityId)) return forbidden(reply);
    const body = z.object({ password: z.string().min(6) }).strict().safeParse(req.body); if (!body.success) return bad(reply);
    db.update(t.user).set({ passwordHash: await hashSecret(body.data.password) }).where(eq(t.user.id, id)).run();
    audit(admin, "user", id, "password_reset");
    return { ok: true };
  });
  app.post("/admin/users/:id/reset-pin", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const { id } = req.params as { id: string };
    const u = userIn(id, admin.facilityId); if (!u) return forbidden(reply);
    if (u.role === "family") return bad(reply, "bad_role");
    const body = z.object({ pin: z.string().regex(/^\d{4,8}$/) }).strict().safeParse(req.body); if (!body.success) return bad(reply);
    db.update(t.user).set({ pinHash: await hashSecret(body.data.pin) }).where(eq(t.user.id, id)).run();
    audit(admin, "user", id, "pin_reset");
    return { ok: true };
  });

  // ---- family links
  app.get("/admin/family-links", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const ids = facilityResidentIds(admin.facilityId);
    return { links: ids.length ? db.select().from(t.familyRelationship).where(inArray(t.familyRelationship.residentId, ids)).all() : [] };
  });
  app.post("/admin/family-links", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const body = linkCreate.safeParse(req.body); if (!body.success) return bad(reply);
    if (!residentIn(body.data.residentId, admin.facilityId)) return forbidden(reply);
    const u = db.select().from(t.user).where(eq(t.user.id, body.data.userId)).get();
    if (!u) return forbidden(reply);
    if (u.role !== "family") return bad(reply, "bad_role");
    if (db.select().from(t.familyRelationship).where(and(eq(t.familyRelationship.userId, u.id), eq(t.familyRelationship.residentId, body.data.residentId))).get()) {
      return reply.code(409).send({ error: "duplicate" });
    }
    const id = `rel_${randomUUID()}`;
    db.insert(t.familyRelationship).values({ id, ...body.data }).run();
    audit(admin, "family_link", id, "family_link_created");
    return reply.code(201).send({ link: db.select().from(t.familyRelationship).where(eq(t.familyRelationship.id, id)).get() });
  });
  app.patch("/admin/family-links/:id", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const { id } = req.params as { id: string };
    if (!linkIn(id, admin.facilityId)) return forbidden(reply);
    const body = linkPatch.safeParse(req.body); if (!body.success) return bad(reply);
    db.update(t.familyRelationship).set(body.data).where(eq(t.familyRelationship.id, id)).run();
    audit(admin, "family_link", id, "family_link_updated");
    return { link: db.select().from(t.familyRelationship).where(eq(t.familyRelationship.id, id)).get() };
  });
  app.delete("/admin/family-links/:id", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const { id } = req.params as { id: string };
    if (!linkIn(id, admin.facilityId)) return forbidden(reply);
    db.delete(t.familyRelationship).where(eq(t.familyRelationship.id, id)).run();
    audit(admin, "family_link", id, "family_link_removed");
    return { ok: true };
  });

  // ---- staff assignments
  app.get("/admin/staff-assignments", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const ids = facilityResidentIds(admin.facilityId);
    return { assignments: ids.length ? db.select().from(t.staffAssignment).where(inArray(t.staffAssignment.residentId, ids)).all() : [] };
  });
  app.post("/admin/staff-assignments", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const body = assignmentCreate.safeParse(req.body); if (!body.success) return bad(reply);
    if (!residentIn(body.data.residentId, admin.facilityId)) return forbidden(reply);
    const u = userIn(body.data.userId, admin.facilityId); if (!u) return forbidden(reply);
    if (u.role !== "staff") return bad(reply, "bad_role");
    const existing = db.select().from(t.staffAssignment).where(and(eq(t.staffAssignment.userId, u.id), eq(t.staffAssignment.residentId, body.data.residentId))).get();
    if (existing?.active) return reply.code(409).send({ error: "duplicate" });
    const id = existing?.id ?? `sa_${randomUUID()}`;
    if (existing) db.update(t.staffAssignment).set({ active: true }).where(eq(t.staffAssignment.id, id)).run();
    else db.insert(t.staffAssignment).values({ id, ...body.data, createdAt: now().toISOString() }).run();
    audit(admin, "staff_assignment", id, "staff_assigned");
    return reply.code(201).send({ assignment: db.select().from(t.staffAssignment).where(eq(t.staffAssignment.id, id)).get() });
  });
  app.delete("/admin/staff-assignments/:id", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const { id } = req.params as { id: string };
    const a = db.select().from(t.staffAssignment).where(eq(t.staffAssignment.id, id)).get();
    if (!a || !residentIn(a.residentId, admin.facilityId)) return forbidden(reply);
    db.update(t.staffAssignment).set({ active: false }).where(eq(t.staffAssignment.id, id)).run();
    audit(admin, "staff_assignment", id, "staff_unassigned");
    return { ok: true };
  });

  // ---- devices
  app.get("/admin/devices", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    return { devices: db.select().from(t.device).where(eq(t.device.facilityId, admin.facilityId)).all().map(publicDevice) };
  });
  app.post("/admin/devices", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const body = deviceCreate.safeParse(req.body); if (!body.success) return bad(reply);
    if (!residentIn(body.data.residentId, admin.facilityId)) return forbidden(reply);
    if (body.data.robotId && !db.select().from(t.robot).where(and(eq(t.robot.id, body.data.robotId), eq(t.robot.facilityId, admin.facilityId))).get()) return forbidden(reply);
    const id = `device_${randomUUID()}`;
    const deviceToken = randomBytes(24).toString("base64url");
    db.insert(t.device).values({
      id, facilityId: admin.facilityId, robotId: body.data.robotId ?? null, kind: "ipad",
      residentId: body.data.residentId, deviceTokenHash: await hashSecret(deviceToken),
    }).run();
    audit(admin, "device", id, "device_registered");
    // The only time the token leaves the server. It is not stored in clear anywhere.
    return reply.code(201).send({ device: publicDevice(deviceIn(id, admin.facilityId)!), deviceToken });
  });
  app.post("/admin/devices/:id/assign", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const { id } = req.params as { id: string };
    const d = deviceIn(id, admin.facilityId); if (!d) return forbidden(reply);
    const body = z.object({ residentId: z.string().min(1) }).strict().safeParse(req.body); if (!body.success) return bad(reply);
    if (!residentIn(body.data.residentId, admin.facilityId)) return forbidden(reply);
    db.update(t.device).set({ residentId: body.data.residentId, assignmentVersion: d.assignmentVersion + 1 }).where(eq(t.device.id, id)).run();
    audit(admin, "device", id, "device_reassigned");
    return { device: publicDevice(deviceIn(id, admin.facilityId)!) };
  });
  app.post("/admin/devices/:id/deactivate", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const { id } = req.params as { id: string };
    if (!deviceIn(id, admin.facilityId)) return forbidden(reply);
    db.update(t.device).set({ active: false }).where(eq(t.device.id, id)).run();
    audit(admin, "device", id, "device_deactivated");
    return { device: publicDevice(deviceIn(id, admin.facilityId)!) };
  });
}
```

- [ ] **Step 4: Register it** — `apps/api/src/app.ts`: `import { adminRoutes } from "./routes/admin";` and, next to the other registrations:

```ts
  app.register(adminRoutes, { db: opts.db, ...(opts.now ? { now: opts.now } : {}) });
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run --project node && npx tsc -b`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(api): care-house admin API for residents, users, links, assignments and iPads"
```

---

### Task 7: AI tool registry skeleton

**Files:**
- Modify: `apps/api/package.json` (add `"zod-to-json-schema": "^3.23.0"` to `dependencies`)
- Create: `apps/api/src/services/directory.ts`, `apps/api/src/tools/registry.ts`, `apps/api/src/tools/builtin.ts`, `apps/api/src/routes/tools.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/test/helpers.ts`
- Test: `apps/api/test/tools.test.ts` (create)

**Interfaces:**
- Consumes: `Access` (Task 3), `pending_action` table (Task 2), `Principal`, `UserRole`.
- Produces (`apps/api/src/tools/registry.ts`):

```ts
export interface ToolContext { principal: Principal; access: Access; directory: Directory; now: () => Date }
export interface ToolDef<I extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string; description: string; roles: Array<UserRole | "device">;
  effect: "read" | "write"; confirm?: boolean;
  input: I;
  summarize?: (ctx: ToolContext, input: z.infer<I>) => string;
  run: (ctx: ToolContext, input: z.infer<I>) => unknown | Promise<unknown>;
}
export function defineTool<I extends z.ZodTypeAny>(def: ToolDef<I>): ToolDef<I>;
export class ToolForbidden extends Error {}
export class ToolInputError extends Error {}
export type ToolResult =
  | { ok: true; result: unknown }
  | { ok: true; needsConfirmation: true; actionId: string; summary: string; expiresAt: string }
  | { ok: false; status: 400 | 403 | 404 | 409 | 410; error: string; detail?: string };
export function createToolRegistry(opts: { db: Db; access: Access; transitions: TransitionService; tools: ToolDef[]; now?: () => Date; id?: () => string }): {
  list(p: Principal): Array<{ name: string; description: string; effect: "read" | "write"; confirm: boolean; inputSchema: object }>;
  invoke(p: Principal, name: string, input: unknown): Promise<ToolResult>;
  confirm(p: Principal, actionId: string): Promise<ToolResult>;
  cancel(p: Principal, actionId: string): ToolResult;
};
export type ToolRegistry = ReturnType<typeof createToolRegistry>;
export const PENDING_ACTION_TTL_MS = 120_000;
```

- Produces (`apps/api/src/services/directory.ts`): `createDirectory(db): Directory` with `residentSummaries(ids: string[]): Array<{ id: string; displayName: string; availability: string; room: string | null }>` and `familyContacts(residentId: string): Array<{ userId: string; displayName: string; label: string; canVideoCall: boolean }>`.
- Produces (`apps/api/src/tools/builtin.ts`): `BUILTIN_TOOLS: ToolDef[]`.
- Produces: `AppOptions.tools?: ToolDef[]` (defaults to `BUILTIN_TOOLS`), `app.tools: ToolRegistry`, `makeTestApp({ tools })`.

- [ ] **Step 1: Install the dependency**

Add `"zod-to-json-schema": "^3.23.0"` to `apps/api/package.json` `dependencies`, then run: `npm install`
Expected: lockfile updated, no new top-level version (already present for `@oncare/contracts`).

- [ ] **Step 2: Let the test helper pass extra tools** — `apps/api/test/helpers.ts`:

```ts
import type { ToolDef } from "../src/tools/registry";

export async function makeTestApp(opts: { now?: () => Date; tools?: ToolDef[] } = {}) {
  const db = openDb(":memory:");
  await seed(db);
  const video = new FakeVideoProvider();
  const app = buildApp({ db, jwtSecret: "test-secret", video, ...(opts.now ? { now: opts.now } : {}), ...(opts.tools ? { tools: opts.tools } : {}) });
```

(rest unchanged).

- [ ] **Step 3: Write the failing test** — create `apps/api/test/tools.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";
import { BUILTIN_TOOLS } from "../src/tools/builtin";
import { defineTool, ToolForbidden } from "../src/tools/registry";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function writeTools(calls: string[]) {
  return [
    ...BUILTIN_TOOLS,
    defineTool({
      name: "test_write", description: "Records a note for a resident.", roles: ["family"], effect: "write",
      input: z.object({ residentId: z.string(), note: z.string() }).strict(),
      summarize: (ctx, input) => {
        if (!ctx.access.canAccessResident(ctx.principal, input.residentId)) throw new ToolForbidden();
        return `Send "${input.note}"?`;
      },
      run: (ctx, input) => {
        if (!ctx.access.canAccessResident(ctx.principal, input.residentId)) throw new ToolForbidden();
        calls.push(input.note);
        return { sent: true };
      },
    }),
    defineTool({
      name: "test_urgent", description: "Runs without confirmation.", roles: ["device"], effect: "write", confirm: false,
      input: z.object({}).strict(),
      run: () => { calls.push("urgent"); return { sent: true }; },
    }),
  ];
}

async function setup(now?: () => Date) {
  const calls: string[] = [];
  const ctx = await makeTestApp({ tools: writeTools(calls), ...(now ? { now } : {}) });
  const invoke = (token: string, name: string, payload: unknown = {}) =>
    ctx.app.inject({ method: "POST", url: `/tools/${name}/invoke`, headers: auth(token), payload: payload as object });
  const post = (token: string, url: string) => ctx.app.inject({ method: "POST", url, headers: auth(token) });
  return { ...ctx, calls, invoke, post };
}

describe("tool registry", () => {
  test("listing is filtered by role and carries JSON Schemas", async () => {
    const { app, tokens } = await setup();
    const names = async (token: string) => (await app.inject({ method: "GET", url: "/tools", headers: auth(token) })).json().tools.map((x: { name: string }) => x.name).sort();
    expect(await names(tokens.family)).toEqual(["get_resident_status", "list_my_residents_or_contacts", "test_write"]);
    expect(await names(tokens.device)).toEqual(["get_resident_status", "list_my_residents_or_contacts", "test_urgent"]);
    const tool = (await app.inject({ method: "GET", url: "/tools", headers: auth(tokens.family) })).json().tools.find((x: { name: string }) => x.name === "test_write");
    expect(tool).toMatchObject({ effect: "write", confirm: true, inputSchema: { type: "object", properties: { residentId: { type: "string" }, note: { type: "string" } } } });
  });

  test("read tools run directly and respect resident scope", async () => {
    const { tokens, invoke } = await setup();
    expect((await invoke(tokens.device, "list_my_residents_or_contacts")).json().result).toEqual({
      contacts: [{ userId: SEED_IDS.familyUser, displayName: "Demo Daughter", label: "daughter", canVideoCall: true }],
    });
    expect((await invoke(tokens.staff, "list_my_residents_or_contacts")).json().result.residents).toEqual([
      { id: SEED_IDS.resident, displayName: "Demo Resident", availability: "available", room: "Demo room" },
    ]);
    expect((await invoke(tokens.device, "get_resident_status")).json().result.resident.id).toBe(SEED_IDS.resident);
    expect((await invoke(tokens.family, "get_resident_status", { residentId: "someone_else" })).statusCode).toBe(403);
    expect((await invoke(tokens.family, "get_resident_status")).json()).toMatchObject({ error: "bad_input" });
  });

  test("unknown tools, tools of another role and bad input are rejected", async () => {
    const { tokens, invoke } = await setup();
    expect((await invoke(tokens.family, "nope")).statusCode).toBe(404);
    expect((await invoke(tokens.staff, "test_write", { residentId: SEED_IDS.resident, note: "x" })).statusCode).toBe(404);
    const bad = await invoke(tokens.family, "test_write", { residentId: 5 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "bad_input", detail: expect.stringContaining("residentId") });
  });

  test("a write needs confirmation by the same principal, once", async () => {
    const { tokens, invoke, post, calls } = await setup();
    const proposed = await invoke(tokens.family, "test_write", { residentId: SEED_IDS.resident, note: "hello" });
    expect(proposed.json()).toMatchObject({ needsConfirmation: true, summary: 'Send "hello"?', actionId: expect.any(String) });
    expect(calls).toEqual([]);
    const id = proposed.json().actionId as string;
    expect((await post(tokens.staff, `/tools/actions/${id}/confirm`)).statusCode).toBe(403);
    const confirmed = await post(tokens.family, `/tools/actions/${id}/confirm`);
    expect(confirmed.json()).toMatchObject({ result: { sent: true } });
    expect(calls).toEqual(["hello"]);
    expect((await post(tokens.family, `/tools/actions/${id}/confirm`)).statusCode).toBe(409);
    expect((await post(tokens.family, "/tools/actions/missing/confirm")).statusCode).toBe(404);
  });

  test("an expired proposal cannot be confirmed", async () => {
    let clock = new Date("2030-01-01T00:00:00Z");
    const { tokens, invoke, post, calls } = await setup(() => clock);
    const id = (await invoke(tokens.family, "test_write", { residentId: SEED_IDS.resident, note: "late" })).json().actionId;
    clock = new Date("2030-01-01T00:02:00.001Z");
    expect((await post(tokens.family, `/tools/actions/${id}/confirm`)).statusCode).toBe(410);
    expect(calls).toEqual([]);
  });

  test("access revoked between proposal and confirmation blocks the write", async () => {
    const { db, tokens, invoke, post, calls } = await setup();
    const id = (await invoke(tokens.family, "test_write", { residentId: SEED_IDS.resident, note: "x" })).json().actionId;
    db.delete(t.familyRelationship).run();
    expect((await post(tokens.family, `/tools/actions/${id}/confirm`)).statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  test("cancel, confirm:false writes, and the audit trail", async () => {
    const { db, tokens, invoke, post, calls } = await setup();
    const id = (await invoke(tokens.family, "test_write", { residentId: SEED_IDS.resident, note: "never" })).json().actionId;
    expect((await post(tokens.family, `/tools/actions/${id}/cancel`)).statusCode).toBe(200);
    expect((await post(tokens.family, `/tools/actions/${id}/confirm`)).statusCode).toBe(409);
    expect((await invoke(tokens.device, "test_urgent")).json()).toMatchObject({ result: { sent: true } });
    expect(calls).toEqual(["urgent"]);
    const rows = db.select().from(t.auditEvent).where(eq(t.auditEvent.actorType, "ai")).all();
    expect(rows.map((r) => r.reason)).toEqual(["tool_proposed", "tool_cancelled", "tool_invoked"]);
    expect(rows.every((r) => r.entityType === "tool")).toBe(true);
    expect(rows[2]).toMatchObject({ actorId: SEED_IDS.device, entityId: "test_urgent", correlationId: SEED_IDS.facility });
  });

  test("a confirm-by-default write without a summarize function is a programming error", () => {
    expect(() => defineTool({ name: "x", description: "x", roles: ["family"], effect: "write", input: z.object({}), run: () => null })).toThrow();
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run apps/api/test/tools.test.ts`
Expected: FAIL — cannot resolve `../src/tools/builtin`.

- [ ] **Step 5: Create `apps/api/src/services/directory.ts`**

```ts
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import * as t from "../db/schema";

/** Read models the AI tools may show. Callers are responsible for scope (see services/access.ts). */
export function createDirectory(db: Db) {
  function residentSummaries(ids: string[]) {
    if (ids.length === 0) return [];
    return db.select({ id: t.resident.id, displayName: t.resident.displayName, availability: t.resident.availability, room: t.location.name })
      .from(t.resident).leftJoin(t.location, eq(t.location.id, t.resident.roomLocationId))
      .where(inArray(t.resident.id, ids)).all()
      .map((r) => ({ id: r.id, displayName: r.displayName, availability: r.availability, room: r.room ?? null }));
  }
  function familyContacts(residentId: string) {
    return db.select({ userId: t.user.id, displayName: t.user.displayName, label: t.familyRelationship.label, canVideoCall: t.familyRelationship.consentVideo })
      .from(t.familyRelationship).innerJoin(t.user, eq(t.user.id, t.familyRelationship.userId))
      .where(and(eq(t.familyRelationship.residentId, residentId), eq(t.user.active, true))).all();
  }
  return { residentSummaries, familyContacts };
}

export type Directory = ReturnType<typeof createDirectory>;
```

- [ ] **Step 6: Create `apps/api/src/tools/registry.ts`**

```ts
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { makeTransitionEvent } from "@oncare/core";
import type { Principal, UserRole } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import type { Access } from "../services/access";
import { createDirectory, type Directory } from "../services/directory";
import type { TransitionService } from "../services/visits";

export const PENDING_ACTION_TTL_MS = 120_000;

export interface ToolContext { principal: Principal; access: Access; directory: Directory; now: () => Date }

export interface ToolDef<I extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  /** Shown to the LLM. */
  description: string;
  roles: Array<UserRole | "device">;
  effect: "read" | "write";
  /** Writes only. Default true; false only for the resident's help request. */
  confirm?: boolean;
  input: I;
  /** Human sentence shown before a confirmed write runs. Required when a write needs confirmation. */
  summarize?: (ctx: ToolContext, input: z.infer<I>) => string;
  run: (ctx: ToolContext, input: z.infer<I>) => unknown | Promise<unknown>;
}

/** Thrown by a tool when the principal may not touch what it asked for. */
export class ToolForbidden extends Error {}
/** Thrown by a tool when valid-shaped input is still unusable (e.g. a required-for-this-role field is missing). */
export class ToolInputError extends Error {}

export function defineTool<I extends z.ZodTypeAny>(def: ToolDef<I>): ToolDef<I> {
  if (def.effect === "write" && def.confirm !== false && !def.summarize) {
    throw new Error(`tool ${def.name}: a write that needs confirmation must define summarize()`);
  }
  return def;
}

export type ToolResult =
  | { ok: true; result: unknown }
  | { ok: true; needsConfirmation: true; actionId: string; summary: string; expiresAt: string }
  | { ok: false; status: 400 | 403 | 404 | 409 | 410; error: string; detail?: string };

const roleKey = (p: Principal) => (p.kind === "device" ? "device" : p.role);
const needsConfirmation = (def: ToolDef) => def.effect === "write" && def.confirm !== false;

export function createToolRegistry(opts: {
  db: Db; access: Access; transitions: TransitionService; tools: ToolDef[]; now?: () => Date; id?: () => string;
}) {
  const { db, access, transitions } = opts;
  const now = opts.now ?? (() => new Date());
  const id = opts.id ?? (() => `act_${randomUUID()}`);
  const directory = createDirectory(db);
  const byName = new Map(opts.tools.map((def) => [def.name, def]));
  const ctx = (principal: Principal): ToolContext => ({ principal, access, directory, now });
  const allowed = (p: Principal, def: ToolDef | undefined): def is ToolDef => def !== undefined && def.roles.includes(roleKey(p));

  function audit(p: Principal, entityId: string, reason: string) {
    const ev = makeTransitionEvent({
      actorType: "ai", actorId: p.id, entityType: "tool", entityId, fromState: null, toState: null, reason,
      correlationId: p.facilityId ?? p.id, now,
    });
    db.insert(t.auditEvent).values(ev).run();
    transitions.emit(ev);
  }

  function failure(e: unknown, p: Principal, entityId: string): ToolResult {
    if (e instanceof ToolForbidden) { audit(p, entityId, "tool_denied"); return { ok: false, status: 403, error: "forbidden" }; }
    if (e instanceof ToolInputError) return { ok: false, status: 400, error: "bad_input", detail: e.message };
    throw e;
  }

  function parse(def: ToolDef, input: unknown): { ok: true; data: unknown } | { ok: false; result: ToolResult } {
    const parsed = def.input.safeParse(input ?? {});
    if (parsed.success) return { ok: true, data: parsed.data };
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return { ok: false, result: { ok: false, status: 400, error: "bad_input", detail } };
  }

  async function run(def: ToolDef, p: Principal, input: unknown, entityId: string): Promise<ToolResult> {
    try {
      const result = await def.run(ctx(p), input);
      audit(p, entityId, "tool_invoked");
      return { ok: true, result };
    } catch (e) {
      return failure(e, p, entityId);
    }
  }

  function list(p: Principal) {
    return opts.tools.filter((def) => allowed(p, def)).map((def) => ({
      name: def.name, description: def.description, effect: def.effect, confirm: needsConfirmation(def),
      inputSchema: zodToJsonSchema(def.input, { $refStrategy: "none" }) as object,
    }));
  }

  async function invoke(p: Principal, name: string, rawInput: unknown): Promise<ToolResult> {
    const def = byName.get(name);
    if (!allowed(p, def)) return { ok: false, status: 404, error: "unknown_tool" };
    const parsed = parse(def, rawInput);
    if (!parsed.ok) return parsed.result;
    if (!needsConfirmation(def)) return run(def, p, parsed.data, def.name);

    let summary: string;
    try { summary = def.summarize!(ctx(p), parsed.data); } catch (e) { return failure(e, p, def.name); }
    const actionId = id();
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + PENDING_ACTION_TTL_MS).toISOString();
    db.insert(t.pendingAction).values({
      id: actionId, principalKind: p.kind, principalId: p.id, tool: def.name, input: parsed.data, summary,
      createdAt: createdAt.toISOString(), expiresAt, status: "pending",
    }).run();
    audit(p, actionId, "tool_proposed");
    return { ok: true, needsConfirmation: true, actionId, summary, expiresAt };
  }

  function owned(p: Principal, actionId: string): { ok: true; row: typeof t.pendingAction.$inferSelect } | { ok: false; result: ToolResult } {
    const row = db.select().from(t.pendingAction).where(eq(t.pendingAction.id, actionId)).get();
    if (!row) return { ok: false, result: { ok: false, status: 404, error: "not_found" } };
    if (row.principalKind !== p.kind || row.principalId !== p.id) return { ok: false, result: { ok: false, status: 403, error: "forbidden" } };
    if (row.status !== "pending") return { ok: false, result: { ok: false, status: 409, error: row.status } };
    return { ok: true, row };
  }

  /** Move a pending row to `to` only if it is still pending, so a double confirm can never run twice. */
  function claim(actionId: string, to: "confirmed" | "cancelled" | "expired"): boolean {
    return db.update(t.pendingAction).set({ status: to })
      .where(and(eq(t.pendingAction.id, actionId), eq(t.pendingAction.status, "pending"))).run().changes === 1;
  }

  async function confirm(p: Principal, actionId: string): Promise<ToolResult> {
    const found = owned(p, actionId);
    if (!found.ok) return found.result;
    const { row } = found;
    if (now().getTime() > Date.parse(row.expiresAt)) {
      if (claim(actionId, "expired")) audit(p, actionId, "tool_expired");
      return { ok: false, status: 410, error: "expired" };
    }
    // Authority is re-checked against current data: roles, and the tool's own access checks inside run().
    const def = byName.get(row.tool);
    if (!allowed(p, def)) { claim(actionId, "cancelled"); return { ok: false, status: 403, error: "forbidden" }; }
    const parsed = parse(def, row.input);
    if (!parsed.ok) { claim(actionId, "cancelled"); return parsed.result; }
    if (!claim(actionId, "confirmed")) return { ok: false, status: 409, error: "not_pending" };
    return run(def, p, parsed.data, actionId);
  }

  function cancel(p: Principal, actionId: string): ToolResult {
    const found = owned(p, actionId);
    if (!found.ok) return found.result;
    if (!claim(actionId, "cancelled")) return { ok: false, status: 409, error: "not_pending" };
    audit(p, actionId, "tool_cancelled");
    return { ok: true, result: { cancelled: true } };
  }

  return { list, invoke, confirm, cancel };
}

export type ToolRegistry = ReturnType<typeof createToolRegistry>;
```

Note the audit order the test expects for a confirmed write: `tool_proposed` at invoke, then `tool_invoked` (entity = action id) when it runs. The test's last case checks `tool_proposed`, `tool_cancelled`, `tool_invoked` across a cancelled proposal and one `confirm: false` call.

- [ ] **Step 7: Create `apps/api/src/tools/builtin.ts`**

```ts
import { z } from "zod";
import { defineTool, ToolForbidden, ToolInputError, type ToolDef } from "./registry";

export const listMyResidentsOrContacts = defineTool({
  name: "list_my_residents_or_contacts",
  description: "On a resident's iPad: the family members this resident can contact. For family, staff and managers: the residents this user may see, with availability and room.",
  roles: ["device", "family", "staff", "admin"],
  effect: "read",
  input: z.object({}).strict(),
  run: (ctx) => ctx.principal.kind === "device"
    ? { contacts: ctx.directory.familyContacts(ctx.principal.residentId) }
    : { residents: ctx.directory.residentSummaries(ctx.access.residentIdsVisibleTo(ctx.principal)) },
});

export const getResidentStatus = defineTool({
  name: "get_resident_status",
  description: "Current availability and room of one resident. On a resident's iPad the resident is implied; everyone else must pass residentId.",
  roles: ["device", "family", "staff", "admin"],
  effect: "read",
  input: z.object({ residentId: z.string().min(1).optional() }).strict(),
  run: (ctx, input) => {
    const residentId = input.residentId ?? (ctx.principal.kind === "device" ? ctx.principal.residentId : undefined);
    if (!residentId) throw new ToolInputError("residentId: Required");
    if (!ctx.access.canAccessResident(ctx.principal, residentId)) throw new ToolForbidden();
    return { resident: ctx.directory.residentSummaries([residentId])[0] ?? null };
  },
});

export const BUILTIN_TOOLS: ToolDef[] = [listMyResidentsOrContacts, getResidentStatus];
```

- [ ] **Step 8: Create `apps/api/src/routes/tools.ts`**

```ts
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireRole } from "../auth/plugin";
import type { ToolResult } from "../tools/registry";

function send(reply: FastifyReply, r: ToolResult) {
  if (!r.ok) return reply.code(r.status).send({ error: r.error, ...(r.detail !== undefined ? { detail: r.detail } : {}) });
  const { ok: _ok, ...body } = r;
  return body;
}

export async function toolRoutes(app: FastifyInstance) {
  const anyone = { preHandler: requireRole("family", "staff", "admin", "device") };
  app.get("/tools", anyone, async (req) => ({ tools: app.tools.list(req.principal) }));
  app.post("/tools/:name/invoke", anyone, async (req, reply) => {
    const { name } = req.params as { name: string };
    return send(reply, await app.tools.invoke(req.principal, name, req.body));
  });
  app.post("/tools/actions/:id/confirm", anyone, async (req, reply) => {
    const { id } = req.params as { id: string };
    return send(reply, await app.tools.confirm(req.principal, id));
  });
  app.post("/tools/actions/:id/cancel", anyone, async (req, reply) => {
    const { id } = req.params as { id: string };
    return send(reply, app.tools.cancel(req.principal, id));
  });
}
```

- [ ] **Step 9: Wire it into `apps/api/src/app.ts`**

```ts
import { toolRoutes } from "./routes/tools";
import { BUILTIN_TOOLS } from "./tools/builtin";
import { createToolRegistry, type ToolDef, type ToolRegistry } from "./tools/registry";

export interface AppOptions { db: Db; jwtSecret: string; now?: () => Date; video?: VideoProvider; tools?: ToolDef[] }
```

Add `tools: ToolRegistry;` to the `FastifyInstance` augmentation. After `app.decorate("transitions", transitions);`:

```ts
  app.decorate("tools", createToolRegistry({
    db: opts.db, access: app.access, transitions, tools: opts.tools ?? BUILTIN_TOOLS, ...(opts.now ? { now: opts.now } : {}),
  }));
```

(`app.access` must already be decorated above this line — it is the first decoration since Task 3.) Register the routes: `app.register(toolRoutes);`.

- [ ] **Step 10: Run tests and typecheck**

Run: `npx vitest run --project node && npx tsc -b`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/api package-lock.json
git commit -m "feat(api): AI tool registry with role-scoped tools and confirm-before-write"
```

---

### Task 8: Facility admin tab in the staff console

**Files:**
- Modify: `packages/web-common/src/api.ts`, `packages/web-common/src/i18n/en.json`
- Modify: `apps/staff/src/App.tsx`, `apps/staff/src/pages/Login.tsx`
- Create: `apps/staff/src/admin/AdminPanel.tsx`, `apps/staff/src/admin/Residents.tsx`, `apps/staff/src/admin/People.tsx`, `apps/staff/src/admin/Links.tsx`, `apps/staff/src/admin/Devices.tsx`, `apps/staff/src/admin/types.ts`
- Test: `packages/web-common/test/api.test.ts` (extend), `apps/staff/test/Admin.test.tsx` (create)

**Interfaces:**
- Consumes: the admin API from Task 6; `GET /locations` (staff/admin).
- Produces: `Api.del<T>(path: string): Promise<T>`; `Session` gains `role: "staff" | "admin"` (sessions stored before this change read back as `"staff"`).

- [ ] **Step 1: Failing test for `del`** — append to `packages/web-common/test/api.test.ts` (it already imports `createApi`, `vi`, `test`, `expect`):

```ts
test("del sends DELETE with the bearer token and no body", async () => {
  const fetchImpl = vi.fn(async () => new Response('{"ok":true}'));
  const api = createApi("http://api", () => "jwt", fetchImpl as unknown as typeof fetch);
  expect(await api.del("/admin/family-links/l1")).toEqual({ ok: true });
  expect(fetchImpl).toHaveBeenCalledWith("http://api/admin/family-links/l1", { method: "DELETE", headers: { accept: "application/json", authorization: "Bearer jwt" } });
});
```

- [ ] **Step 2: Failing admin UI test** — create `apps/staff/test/Admin.test.tsx`:

```tsx
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "../src/App";

class Socket { onmessage?: (event: { data: string }) => void; close() {} }
const data = {
  "/admin/residents": { residents: [{ id: "r1", displayName: "Grandma Lin", roomLocationId: "room1", availability: "available", active: true, facilityId: "f" }] },
  "/admin/users": { users: [{ id: "s1", role: "staff", username: "nurse", displayName: "Nurse Chen", facilityId: "f", active: true }, { id: "fam1", role: "family", username: "daughter", displayName: "Amy", facilityId: null, active: true }] },
  "/admin/family-links": { links: [{ id: "l1", userId: "fam1", residentId: "r1", label: "daughter", consentVideo: true, consentRobotVisit: false, consentItemDelivery: false }] },
  "/admin/staff-assignments": { assignments: [{ id: "a1", userId: "s1", residentId: "r1", active: true, createdAt: "2026-09-19T00:00:00Z" }] },
  "/admin/devices": { devices: [{ id: "d1", residentId: "r1", robotId: null, active: true, assignmentVersion: 1, kind: "ipad", facilityId: "f" }] },
  "/locations": { locations: [{ id: "room1", name: "Room 101", kind: "resident_room" }, { id: "pick", name: "Station", kind: "pickup_station" }] },
  "/queue": { visitsAwaitingApproval: [], tasksAwaitingApproval: [], tasksAwaitingLoad: [], tasksAwaitingHandoff: [], caregiverCalls: [], activeVisits: [], robot: null },
  "/audit": { events: [] },
} as Record<string, unknown>;
let requests: Array<{ method: string; path: string; body: unknown }>;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => {
  sessionStorage.clear();
  requests = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace("http://api", "").split("?")[0]!;
    const method = init?.method ?? "GET";
    requests.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "POST" && path === "/admin/devices") return new Response(JSON.stringify({ device: { id: "d2" }, deviceToken: "tok-once-123" }), { status: 201 });
    if (method !== "GET") return new Response('{"ok":true}');
    return new Response(JSON.stringify(data[path] ?? {}));
  }));
});

const asAdmin = () => sessionStorage.setItem("oncare.staff", JSON.stringify({ token: "jwt", displayName: "Manager", role: "admin" }));

test("the facility admin tab is shown to admins only", async () => {
  sessionStorage.setItem("oncare.staff", JSON.stringify({ token: "jwt", displayName: "Nurse" }));
  render(<App apiBase="http://api" />);
  await screen.findByText("Staff console");
  expect(screen.queryByRole("tab", { name: "Facility admin" })).toBeNull();
});

test("an admin sees residents, people, links and iPads", async () => {
  asAdmin();
  render(<App apiBase="http://api" />);
  await userEvent.click(await screen.findByRole("tab", { name: "Facility admin" }));
  const residents = await screen.findByRole("region", { name: "Residents" });
  expect(within(residents).getByText("Grandma Lin")).toBeInTheDocument();
  expect(within(residents).getByRole("cell", { name: "Room 101" })).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Staff and family" })).getByText("Nurse Chen")).toBeInTheDocument();
  const links = screen.getByRole("region", { name: "Family links and nurse assignments" });
  expect(within(links).getByText(/Amy.*daughter.*Grandma Lin/)).toBeInTheDocument();
  expect(within(links).getByText(/Nurse Chen.*Grandma Lin/)).toBeInTheDocument();
});

test("registering an iPad reveals its token once and removing a link calls DELETE", async () => {
  asAdmin();
  render(<App apiBase="http://api" />);
  await userEvent.click(await screen.findByRole("tab", { name: "Facility admin" }));
  const devices = await screen.findByRole("region", { name: "Resident iPads" });
  await userEvent.selectOptions(within(devices).getByLabelText("Resident"), "r1");
  await userEvent.click(within(devices).getByRole("button", { name: "Register iPad" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("tok-once-123")).toBeInTheDocument();
  expect(requests).toContainEqual({ method: "POST", path: "/admin/devices", body: { residentId: "r1" } });
  await userEvent.click(within(dialog).getByRole("button", { name: "I have saved it" }));
  expect(screen.queryByText("tok-once-123")).toBeNull();

  const links = screen.getByRole("region", { name: "Family links and nurse assignments" });
  await userEvent.click(within(links).getAllByRole("button", { name: "Remove" })[0]!);
  expect(requests).toContainEqual({ method: "DELETE", path: "/admin/family-links/l1", body: undefined });
});

test("deactivating a person and an iPad posts to the exact routes", async () => {
  asAdmin();
  render(<App apiBase="http://api" />);
  await userEvent.click(await screen.findByRole("tab", { name: "Facility admin" }));
  const people = await screen.findByRole("region", { name: "Staff and family" });
  await userEvent.click(within(people).getAllByRole("button", { name: "Deactivate" })[0]!);
  const devices = screen.getByRole("region", { name: "Resident iPads" });
  await userEvent.click(within(devices).getByRole("button", { name: "Deactivate" }));
  expect(requests.filter((r) => r.method === "POST").map((r) => r.path)).toEqual(["/admin/users/s1/deactivate", "/admin/devices/d1/deactivate"]);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run --project web packages/web-common/test/api.test.ts apps/staff/test/Admin.test.tsx`
Expected: FAIL — `api.del is not a function`; no "Facility admin" tab.

- [ ] **Step 4: Add `del`** — `packages/web-common/src/api.ts`:

```ts
export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
}
```

Change `call`'s method type to `"GET" | "POST" | "PATCH" | "DELETE"` and the return line to:

```ts
  return { get: (path) => call("GET", path), post: (path, body) => call("POST", path, body), patch: (path, body) => call("PATCH", path, body), del: (path) => call("DELETE", path) };
```

Any test doubles implementing `Api` by hand now need a `del` member; run `npx tsc -b` and add `del: vi.fn()` where it reports one.

- [ ] **Step 5: Add strings** — append these keys inside `packages/web-common/src/i18n/en.json` (before the closing `}`; keep the file's existing key order otherwise):

```json
  "staff.login.not_staff_or_admin": "This account is not a staff or manager account",
  "staff.tab.console": "Console",
  "staff.tab.admin": "Facility admin",
  "admin.loading": "Loading facility records…",
  "admin.error": "The change was not saved. Check the connection and try again.",
  "admin.residents.title": "Residents",
  "admin.residents.name": "Name",
  "admin.residents.room": "Room",
  "admin.residents.add": "Add resident",
  "admin.people.title": "Staff and family",
  "admin.people.role": "Role",
  "admin.people.role.staff": "Nurse",
  "admin.people.role.family": "Family",
  "admin.people.role.admin": "Manager",
  "admin.people.username": "Username",
  "admin.people.display_name": "Display name",
  "admin.people.password": "Temporary password",
  "admin.people.pin": "PIN (nurses only)",
  "admin.people.add": "Add person",
  "admin.links.title": "Family links and nurse assignments",
  "admin.links.family": "Family member",
  "admin.links.resident": "Resident",
  "admin.links.label": "Relationship",
  "admin.links.video": "May video call",
  "admin.links.add_family": "Link family",
  "admin.links.nurse": "Nurse",
  "admin.links.add_nurse": "Assign nurse",
  "admin.links.remove": "Remove",
  "admin.devices.title": "Resident iPads",
  "admin.devices.resident": "Resident",
  "admin.devices.register": "Register iPad",
  "admin.devices.move": "Move to",
  "admin.devices.token_title": "iPad sign-in code",
  "admin.devices.token_help": "Enter this code on the iPad now. It will not be shown again.",
  "admin.devices.token_done": "I have saved it",
  "admin.deactivate": "Deactivate",
  "admin.inactive": "inactive"
```

- [ ] **Step 6: Session role and admin login** — `apps/staff/src/App.tsx`:

```tsx
import { useMemo, useState } from "react";
import { createApi, t } from "@oncare/web-common";
import { Login } from "./pages/Login";
import { Console } from "./pages/Console";
import { AdminPanel } from "./admin/AdminPanel";
export interface Session {
    token: string;
    displayName: string;
    role: "staff" | "admin";
}
function readSession(): Session | null {
    try {
        const value: unknown = JSON.parse(sessionStorage.getItem("oncare.staff") ?? "null");
        if (value && typeof value === "object" && "token" in value && typeof value.token === "string" && value.token && "displayName" in value && typeof value.displayName === "string")
            // Sessions saved before the admin role existed have no role: they were staff sessions.
            return { token: value.token, displayName: value.displayName, role: "role" in value && value.role === "admin" ? "admin" : "staff" };
    }
    catch { /* A blocked storage or invalid session falls back to login. */ }
    return null;
}
export function App({ apiBase }: {
    apiBase: string;
}) {
    const [session, setSession] = useState(readSession);
    const [tab, setTab] = useState<"console" | "admin">("console");
    const api = useMemo(() => createApi(apiBase, () => session?.token ?? null), [apiBase, session]);
    function save(next: Session | null) {
        try {
            if (next)
                sessionStorage.setItem("oncare.staff", JSON.stringify(next));
            else
                sessionStorage.removeItem("oncare.staff");
        }
        catch { /* In-memory session remains usable. */ }
        setTab("console");
        setSession(next);
    }
    if (!session)
        return <Login api={api} onLoggedIn={save}/>;
    return <>
      <header className="masthead"><h1>{t("staff.title")}</h1>
        {session.role === "admin" && <nav role="tablist">
          <button role="tab" aria-selected={tab === "console"} onClick={() => setTab("console")}>{t("staff.tab.console")}</button>
          <button role="tab" aria-selected={tab === "admin"} onClick={() => setTab("admin")}>{t("staff.tab.admin")}</button>
        </nav>}
        <span>{session.displayName}</span><button onClick={() => save(null)}>{t("staff.logout")}</button></header>
      {tab === "admin" && session.role === "admin" ? <AdminPanel api={api}/> : <Console api={api} apiBase={apiBase} token={session.token}/>}
    </>;
}
```

`apps/staff/src/pages/Login.tsx:28-32`:

```tsx
            const role = result.principal.role;
            if (role !== "staff" && role !== "admin") {
                setError(t("staff.login.not_staff_or_admin"));
                return;
            }
            onLoggedIn({ token: result.token, displayName: result.principal.displayName ?? username, role });
```

If an existing `apps/staff/test/App.test.tsx` assertion matches the old "not a staff account" text, update it to "This account is not a staff or manager account".

- [ ] **Step 7: Admin types** — create `apps/staff/src/admin/types.ts`:

```ts
import type { Api } from "@oncare/web-common";

export interface Resident { id: string; displayName: string; roomLocationId: string; availability: string; active: boolean }
export interface Person { id: string; role: "staff" | "family" | "admin"; username: string; displayName: string; facilityId: string | null; active: boolean }
export interface FamilyLink { id: string; userId: string; residentId: string; label: string; consentVideo: boolean }
export interface Assignment { id: string; userId: string; residentId: string; active: boolean }
export interface Device { id: string; residentId: string; robotId: string | null; active: boolean; assignmentVersion: number }
export interface Room { id: string; name: string; kind: string }

export interface AdminData { residents: Resident[]; people: Person[]; links: FamilyLink[]; assignments: Assignment[]; devices: Device[]; rooms: Room[] }

/** Every section gets the same two things: the data and a way to run one change and reload. */
export interface SectionProps { data: AdminData; run: (change: (api: Api) => Promise<unknown>) => Promise<unknown> }
```

- [ ] **Step 8: Panel** — create `apps/staff/src/admin/AdminPanel.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import { t, type Api } from "@oncare/web-common";
import type { AdminData, Assignment, Device, FamilyLink, Person, Resident, Room } from "./types";
import { Residents } from "./Residents";
import { People } from "./People";
import { Links } from "./Links";
import { Devices } from "./Devices";

async function load(api: Api): Promise<AdminData> {
  const [residents, people, links, assignments, devices, rooms] = await Promise.all([
    api.get<{ residents: Resident[] }>("/admin/residents"),
    api.get<{ users: Person[] }>("/admin/users"),
    api.get<{ links: FamilyLink[] }>("/admin/family-links"),
    api.get<{ assignments: Assignment[] }>("/admin/staff-assignments"),
    api.get<{ devices: Device[] }>("/admin/devices"),
    api.get<{ locations: Room[] }>("/locations"),
  ]);
  return {
    residents: residents.residents, people: people.users, links: links.links,
    assignments: assignments.assignments.filter((a) => a.active), devices: devices.devices,
    rooms: rooms.locations.filter((l) => l.kind === "resident_room"),
  };
}

export function AdminPanel({ api }: { api: Api }) {
  const [data, setData] = useState<AdminData | null>(null);
  const [error, setError] = useState(false);
  const reload = useCallback(async () => {
    try { setData(await load(api)); setError(false); } catch { setError(true); }
  }, [api]);
  useEffect(() => { void reload(); }, [reload]);

  const run = useCallback(async (change: (api: Api) => Promise<unknown>) => {
    try { const result = await change(api); setError(false); return result; }
    catch { setError(true); return null; }
    finally { await reload(); }
  }, [api, reload]);

  if (!data) return <main className="admin">{error ? <p role="alert">{t("admin.error")}</p> : <p role="status">{t("admin.loading")}</p>}</main>;
  return <main className="admin">
    {error && <p role="alert">{t("admin.error")}</p>}
    <Residents data={data} run={run}/>
    <People data={data} run={run}/>
    <Links data={data} run={run}/>
    <Devices data={data} run={run}/>
  </main>;
}
```

- [ ] **Step 9: Residents section** — create `apps/staff/src/admin/Residents.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { t } from "@oncare/web-common";
import type { SectionProps } from "./types";

export function Residents({ data, run }: SectionProps) {
  const [name, setName] = useState("");
  const [room, setRoom] = useState("");
  const roomName = (id: string) => data.rooms.find((r) => r.id === id)?.name ?? id;
  async function add(event: FormEvent) {
    event.preventDefault();
    await run((api) => api.post("/admin/residents", { displayName: name, roomLocationId: room }));
    setName("");
  }
  return <section aria-labelledby="admin-residents"><h2 id="admin-residents">{t("admin.residents.title")}</h2>
    <table><tbody>{data.residents.map((r) => <tr key={r.id}>
      <td>{r.displayName}{!r.active && ` (${t("admin.inactive")})`}</td><td>{roomName(r.roomLocationId)}</td>
      <td>{r.active && <button onClick={() => run((api) => api.post(`/admin/residents/${r.id}/deactivate`))}>{t("admin.deactivate")}</button>}</td>
    </tr>)}</tbody></table>
    <form onSubmit={add}>
      <label htmlFor="resident-name">{t("admin.residents.name")}</label><input id="resident-name" required value={name} onChange={(e) => setName(e.target.value)}/>
      <label htmlFor="resident-room">{t("admin.residents.room")}</label>
      <select id="resident-room" required value={room} onChange={(e) => setRoom(e.target.value)}>
        <option value=""/>{data.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      <button>{t("admin.residents.add")}</button>
    </form>
  </section>;
}
```

The test finds sections by `role="region"` with an accessible name: a `<section>` with `aria-labelledby` pointing at its heading gets exactly that.

- [ ] **Step 10: People section** — create `apps/staff/src/admin/People.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { t } from "@oncare/web-common";
import type { SectionProps } from "./types";

export function People({ data, run }: SectionProps) {
  const [form, setForm] = useState({ role: "staff" as "staff" | "family", username: "", displayName: "", password: "", pin: "" });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  async function add(event: FormEvent) {
    event.preventDefault();
    const { pin, ...rest } = form;
    await run((api) => api.post("/admin/users", form.role === "staff" && pin ? { ...rest, pin } : rest));
    setForm({ ...form, username: "", displayName: "", password: "", pin: "" });
  }
  return <section aria-labelledby="admin-people"><h2 id="admin-people">{t("admin.people.title")}</h2>
    <table><tbody>{data.people.map((p) => <tr key={p.id}>
      <td>{p.displayName}{!p.active && ` (${t("admin.inactive")})`}</td><td>{p.username}</td><td>{t(`admin.people.role.${p.role}`)}</td>
      <td>{p.active && p.role !== "admin" && <button onClick={() => run((api) => api.post(`/admin/users/${p.id}/deactivate`))}>{t("admin.deactivate")}</button>}</td>
    </tr>)}</tbody></table>
    <form onSubmit={add}>
      <label htmlFor="person-role">{t("admin.people.role")}</label>
      <select id="person-role" value={form.role} onChange={set("role")}>
        <option value="staff">{t("admin.people.role.staff")}</option><option value="family">{t("admin.people.role.family")}</option>
      </select>
      <label htmlFor="person-username">{t("admin.people.username")}</label><input id="person-username" required value={form.username} onChange={set("username")}/>
      <label htmlFor="person-name">{t("admin.people.display_name")}</label><input id="person-name" required value={form.displayName} onChange={set("displayName")}/>
      <label htmlFor="person-password">{t("admin.people.password")}</label><input id="person-password" type="password" required minLength={6} value={form.password} onChange={set("password")}/>
      {form.role === "staff" && <><label htmlFor="person-pin">{t("admin.people.pin")}</label><input id="person-pin" inputMode="numeric" pattern="\d{4,8}" value={form.pin} onChange={set("pin")}/></>}
      <button>{t("admin.people.add")}</button>
    </form>
  </section>;
}
```

- [ ] **Step 11: Links section** — create `apps/staff/src/admin/Links.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { t } from "@oncare/web-common";
import type { SectionProps } from "./types";

export function Links({ data, run }: SectionProps) {
  const [family, setFamily] = useState({ userId: "", residentId: "", label: "", consentVideo: true });
  const [nurse, setNurse] = useState({ userId: "", residentId: "" });
  const person = (id: string) => data.people.find((p) => p.id === id)?.displayName ?? id;
  const resident = (id: string) => data.residents.find((r) => r.id === id)?.displayName ?? id;
  const activeResidents = data.residents.filter((r) => r.active);
  const residentOptions = <><option value=""/>{activeResidents.map((r) => <option key={r.id} value={r.id}>{r.displayName}</option>)}</>;
  async function linkFamily(event: FormEvent) {
    event.preventDefault();
    await run((api) => api.post("/admin/family-links", family));
    setFamily({ ...family, label: "" });
  }
  async function assignNurse(event: FormEvent) {
    event.preventDefault();
    await run((api) => api.post("/admin/staff-assignments", nurse));
  }
  return <section aria-labelledby="admin-links"><h2 id="admin-links">{t("admin.links.title")}</h2>
    <ul>{data.links.map((l) => <li key={l.id}>{`${person(l.userId)} · ${l.label} · ${resident(l.residentId)}`}
      <button onClick={() => run((api) => api.del(`/admin/family-links/${l.id}`))}>{t("admin.links.remove")}</button></li>)}</ul>
    <form onSubmit={linkFamily}>
      <label htmlFor="link-family">{t("admin.links.family")}</label>
      <select id="link-family" required value={family.userId} onChange={(e) => setFamily({ ...family, userId: e.target.value })}>
        <option value=""/>{data.people.filter((p) => p.role === "family" && p.active).map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
      </select>
      <label htmlFor="link-resident">{t("admin.links.resident")}</label>
      <select id="link-resident" required value={family.residentId} onChange={(e) => setFamily({ ...family, residentId: e.target.value })}>{residentOptions}</select>
      <label htmlFor="link-label">{t("admin.links.label")}</label><input id="link-label" required value={family.label} onChange={(e) => setFamily({ ...family, label: e.target.value })}/>
      <label><input type="checkbox" checked={family.consentVideo} onChange={(e) => setFamily({ ...family, consentVideo: e.target.checked })}/>{t("admin.links.video")}</label>
      <button>{t("admin.links.add_family")}</button>
    </form>
    <ul>{data.assignments.map((a) => <li key={a.id}>{`${person(a.userId)} → ${resident(a.residentId)}`}
      <button onClick={() => run((api) => api.del(`/admin/staff-assignments/${a.id}`))}>{t("admin.links.remove")}</button></li>)}</ul>
    <form onSubmit={assignNurse}>
      <label htmlFor="assign-nurse">{t("admin.links.nurse")}</label>
      <select id="assign-nurse" required value={nurse.userId} onChange={(e) => setNurse({ ...nurse, userId: e.target.value })}>
        <option value=""/>{data.people.filter((p) => p.role === "staff" && p.active).map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
      </select>
      <label htmlFor="assign-resident">{t("admin.links.resident")}</label>
      <select id="assign-resident" required value={nurse.residentId} onChange={(e) => setNurse({ ...nurse, residentId: e.target.value })}>{residentOptions}</select>
      <button>{t("admin.links.add_nurse")}</button>
    </form>
  </section>;
}
```

- [ ] **Step 12: Devices section** — create `apps/staff/src/admin/Devices.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { t } from "@oncare/web-common";
import type { SectionProps } from "./types";

export function Devices({ data, run }: SectionProps) {
  const [residentId, setResidentId] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const activeResidents = data.residents.filter((r) => r.active);
  const resident = (id: string) => data.residents.find((r) => r.id === id)?.displayName ?? id;
  async function register(event: FormEvent) {
    event.preventDefault();
    const result = await run((api) => api.post<{ deviceToken: string }>("/admin/devices", { residentId })) as { deviceToken?: string } | null;
    if (result?.deviceToken) setToken(result.deviceToken);
  }
  return <section aria-labelledby="admin-devices"><h2 id="admin-devices">{t("admin.devices.title")}</h2>
    <table><tbody>{data.devices.map((d) => <tr key={d.id}>
      <td>{d.id}{!d.active && ` (${t("admin.inactive")})`}</td><td>{resident(d.residentId)}</td>
      <td>{d.active && <>
        <label htmlFor={`move-${d.id}`}>{t("admin.devices.move")}</label>
        <select id={`move-${d.id}`} value="" onChange={(e) => e.target.value && run((api) => api.post(`/admin/devices/${d.id}/assign`, { residentId: e.target.value }))}>
          <option value=""/>{activeResidents.filter((r) => r.id !== d.residentId).map((r) => <option key={r.id} value={r.id}>{r.displayName}</option>)}
        </select>
        <button onClick={() => run((api) => api.post(`/admin/devices/${d.id}/deactivate`))}>{t("admin.deactivate")}</button>
      </>}</td>
    </tr>)}</tbody></table>
    <form onSubmit={register}>
      <label htmlFor="device-resident">{t("admin.devices.resident")}</label>
      <select id="device-resident" required value={residentId} onChange={(e) => setResidentId(e.target.value)}>
        <option value=""/>{activeResidents.map((r) => <option key={r.id} value={r.id}>{r.displayName}</option>)}
      </select>
      <button>{t("admin.devices.register")}</button>
    </form>
    {token && <div role="dialog" aria-labelledby="device-token-title">
      <h3 id="device-token-title">{t("admin.devices.token_title")}</h3>
      <p>{t("admin.devices.token_help")}</p>
      <code>{token}</code>
      <button onClick={() => setToken(null)}>{t("admin.devices.token_done")}</button>
    </div>}
  </section>;
}
```

The token lives only in this component's state; it is never written to storage and disappears when the dialog closes.

- [ ] **Step 13: Run the web suite and typecheck**

Run: `npx vitest run --project web && npx tsc -b`
Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add packages/web-common apps/staff
git commit -m "feat(staff): facility admin tab for residents, people, links and iPads"
```

---

### Task 9: Full verification and docs

**Files:**
- Modify: `README.md:22`
- Modify: `docs/takeover-report-2026-09-16.md` (append a "Foundation (2026-09-19)" status line)

- [ ] **Step 1: Run every check**

Run each and record the result:

```bash
npx vitest run
npx tsc -b
pytest -q robot_gateway
npm run demo:check
```

Expected: all green. If any fails, fix the cause in the task it belongs to (with its own commit) before continuing.

- [ ] **Step 2: Run the browser story**

Run: `npm run e2e`
Expected: PASS. If Playwright/Chromium is not installed on this machine, record "e2e not run: <exact error>" in the report instead of claiming it passed.

- [ ] **Step 3: Update the README credentials line** — `README.md:22`:

```md
`family` / `family-demo-pass`; `staff` / `staff-demo-pass`; `admin` / `admin-demo-pass` (facility manager: opens the **Facility admin** tab in the staff console); staff and admin PIN `2468`; device token `device-demo-token`; robot token `robot-demo-token`. All are seeded fixtures, not production credentials.
```

- [ ] **Step 4: Record status** — append to `docs/takeover-report-2026-09-16.md`:

```md
## Foundation (2026-09-19)

Sub-project 1 of the oncare_communicate integration (spec `docs/superpowers/specs/2026-09-19-foundation-design.md`, plan `docs/superpowers/plans/2026-09-19-foundation.md`): admin role, facility and assignment scope through `services/access.ts` with per-request revalidation, robot-optional `device`, admin API and staff-console tab, AI tool registry (`/tools`) with two read tools. Checks run on <date>: vitest <result>, tsc <result>, pytest <result>, demo:check <result>, e2e <result or "not run: reason">.
```

Fill the placeholders with the actual results from Steps 1–2.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/takeover-report-2026-09-16.md
git commit -m "docs: admin credentials and foundation status"
```
