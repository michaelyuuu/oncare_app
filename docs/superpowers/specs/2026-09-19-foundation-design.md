# OnCare Integration — Sub-project 1: Foundation

Date: 2026-09-19
Status: approved section by section by the owner on 2026-09-19; written spec pending owner review.
Inputs: this repo at `fc1e72c`; read-only survey of `D:/ontaru/AGI carehouse/oncare_communicate` (branch `chest-screen-ui`, HEAD `5a1cb76`).

## 0. Context and decisions already made by the owner

`oncare_app` and `oncare_communicate` are being merged into **one product with one backend**. This spec covers only the first of five sub-projects.

| Decision | Value |
|---|---|
| Base | **`oncare_app`** (TypeScript, Fastify, React, Drizzle/SQLite, LiveKit). `oncare_communicate` is read-only reference; its logic is ported into TypeScript, never imported. |
| End goal | AI assist on top, a complete and maintainable calling system underneath, scheduled calls with a calendar. Easy for residents, easy to manage for the care house. |
| Layering | AI is the **top, thinnest layer**. All business logic lives in the Fastify service layer. UI and AI are both callers of that layer and go through the same authorization. An AI can never do what its principal could not do in the UI. |
| AI clients | Resident iPad voice assistant, staff/care-house assistant, family assistant. **No external MCP access** for now. |
| AI action policy | Reads run directly. Writes return a proposal and run only after the user confirms. Exception: the resident's help request sends immediately. |
| LLM provider | **OpenAI for all three assistants** (resident voice via OpenAI Realtime). This supersedes the earlier "no AI key" decision in `docs/handoff-plan-3-onward.md`. The key never reaches a browser. |
| Robot | Robot visit and tray delivery stay as they are. |

### Sub-project order

1. **Foundation** (this spec) — roles, facility scope, device decoupled from robot, one authorization module, admin management, AI tool registry skeleton.
2. **Assistance requests** — replace the `call_caregiver` audit-row stub with communicate's full model (outbox, events, withdrawal, escalation).
3. **Calling** — an independent `call` entity (revision-based concurrency, one open call per resident, persisted consent evidence) on LiveKit; `visit_session` references a call instead of owning media.
4. **Scheduling / calendar** — per-resident callable windows; family bookings inside a window auto-confirm, outside need staff approval; reminder, ring, one-tap or spoken answer, unanswered → notify staff.
5. **AI assistants** — three role-scoped assistants over the tools registered by 2–4.

## 1. Problems in the current code this sub-project fixes

| Problem | Where |
|---|---|
| `user` has no facility and only `family \| staff` roles. | `apps/api/src/db/schema.ts:13` |
| Staff see everything: `/queue` and `/audit` are unfiltered; the events WebSocket returns `true` for any staff principal. | `apps/api/src/routes/staff.ts:68,102`, `apps/api/src/routes/events-ws.ts:12` |
| An iPad cannot exist without a robot: `robot_device.robot_id` is NOT NULL and the device principal carries `robotId`. | `schema.ts:29`, `apps/api/src/auth/plugin.ts:7` |
| Authorization is scattered: `family_relationship` is queried separately in several services. There is no single entry point for an AI tool layer to reuse. | `services/visits.ts:72`, `services/tasks.ts:88,139` |
| Authority comes only from JWT claims for up to 12 h; disabling a user or moving an iPad has no effect until expiry. | `auth/plugin.ts:17` |

## 2. Data model (migration `0002`)

Generated with `npm run db:generate -w @oncare/api`, with existing rows carried over.

| Change | Detail |
|---|---|
| `user.role` | `family \| staff \| admin` |
| `user.facility_id` | New, nullable FK → `facility`. Required (enforced in service code) for `staff` and `admin`. `family` may be null: a family member can have relatives in more than one facility. Existing staff rows get the seed facility. |
| `user.active` | New boolean, default `true`. |
| `staff_assignment` (new) | `id, user_id → user, resident_id → resident, active, created_at`. Unique on `(user_id, resident_id)`. Ported from communicate's `staff_assignments`. |
| `robot_device` → **`device`** | Renamed. `robot_id` becomes nullable. New columns: `facility_id` (NOT NULL, backfilled from the robot's facility), `active` (default `true`), `assignment_version` (integer, default `1`). `resident_id` stays NOT NULL; an unassigned iPad is represented by `active = false`. |
| `resident.active` | New boolean, default `true`. |
| `pending_action` (new) | See §5. |

`family_relationship` is unchanged. Its three consent booleans remain until sub-project 3 introduces call consent evidence.

All code references to `robotDevice` / `robot_device` (auth route, staff queue, video route, benchmark service, seed, tests) are renamed.

## 3. Unified authorization: `apps/api/src/services/access.ts`

Every "may this principal touch this resident?" decision goes through this module. Routes, the events WebSocket, and the tool registry all call it; no other file queries `family_relationship` or `staff_assignment` for authorization.

### 3.1 Principal

```ts
type Principal =
  | { kind: "user"; id: string; role: "family" | "staff" | "admin"; facilityId: string | null }
  | { kind: "device"; id: string; residentId: string; facilityId: string; robotId: string | null; assignmentVersion: number };
```

### 3.2 Rules

| Principal | Residents it may access |
|---|---|
| admin | All active residents in its facility. |
| staff | Active residents in its facility that have an active `staff_assignment` for it. |
| family | Residents linked by `family_relationship`. |
| device | Only the resident it is currently assigned to. |

API surface:

- `resolvePrincipal(claims): Principal | null` — re-reads the user or device row. Returns `null` if the row is missing, `active = false`, or (device) `assignment_version` or `resident_id` differs from the claims.
- `canAccessResident(p, residentId): boolean`
- `residentIdsVisibleTo(p): string[]`
- `sameFacility(p, facilityId): boolean` — for facility-level resources (robot, locations).

### 3.3 Revalidation on every request

`requireRole` calls `resolvePrincipal` after `jwtVerify`. A `null` result returns **401**. Disabling a user, disabling a device, or reassigning an iPad takes effect on the next request, not at token expiry. The events WebSocket resolves once on connect and re-resolves on every outgoing event; a failed resolve closes the socket with `4401`.

### 3.4 Retrofitting existing routes

| Route | New behaviour |
|---|---|
| `GET /queue` | Only visits, tasks and caregiver calls for `residentIdsVisibleTo(p)`. |
| `GET /audit` | Only events whose entity resolves to a visible resident; `?residentId=` outside scope → 403. |
| `PATCH /residents/:id/availability` | `canAccessResident` or 403. |
| visits / tasks / video token routes | Existing relationship checks replaced by `access`. |
| events WS | `visibleTo` delegates to `access`; staff no longer see everything. |
| `GET /me/residents` | Uses `residentIdsVisibleTo`. |
| Robot controls `stop / standby / resume / status`, `GET/PATCH /locations` | **Facility level**: any active staff or admin with `sameFacility`. STOP is a safety control and must not be blocked by assignment scope. |

The seed assigns the demo staff user to the demo resident, so the documented demo flow and e2e story are unchanged.

## 4. Care-house administration

### 4.1 API

All routes `requireRole("admin")`, all scoped to the admin's facility, every mutation writes an `audit_event` with `actor_type = "admin"`.

| Resource | Operations |
|---|---|
| Residents | `GET /admin/residents`, `POST`, `PATCH /:id` (display name, room), `POST /:id/deactivate` |
| Users | `GET /admin/users`, `POST` (staff or family), `POST /:id/deactivate`, `POST /:id/reset-password`, `POST /:id/reset-pin` |
| Family links | `POST /admin/family-links`, `PATCH /:id` (label, consent flags), `DELETE /:id` |
| Staff assignments | `POST /admin/staff-assignments`, `DELETE /:id` |
| Devices | `POST /admin/devices` (requires `residentId`; returns the device token **once**; only its hash is stored), `POST /:id/assign` (sets `resident_id`, increments `assignment_version`), `POST /:id/deactivate` |

A family user created by an admin gets `facility_id = null`; the link to the resident is what grants access.

### 4.2 UI

A **「機構管理」 (Facility admin)** tab inside the existing `apps/staff`, rendered only when the logged-in principal has `role = "admin"`. Plain tables and forms: residents, users, family links, staff assignments, devices. The device-token reveal is a one-time dialog. Strings go through the existing i18n keys. Later sub-projects add callable windows and the calendar under this tab.

## 5. AI tool registry skeleton: `apps/api/src/tools/`

### 5.1 Definition

```ts
defineTool({
  name: "list_my_contacts",
  description: "…",               // shown to the LLM
  roles: ["device", "family"],    // principals allowed to see and call it
  effect: "read",                 // "read" | "write"
  confirm: true,                  // writes only; false only for the resident help request
  input: z.object({ /* … */ }),   // exported to JSON Schema with zod-to-json-schema
  run: (ctx, input) => { /* … */ } // ctx.principal is resolved; may call only services + access
});
```

Tools live in one registry. A tool may not import the DB client directly: it goes through services, so it cannot bypass `access`.

### 5.2 Execution: `invokeTool(principal, name, input)`

1. **Role filter.** A principal whose role is not in `roles` gets 404 `unknown_tool` (the tool is also absent from its listing).
2. **Validation.** zod failure → 400 with a short machine-and-LLM-readable message.
3. **Read** → run and return `{ result }`.
4. **Write with `confirm: true`** → do not run. Insert a `pending_action` and return `{ needsConfirmation: true, actionId, summary }`, where `summary` is a human sentence rendered by the tool (for example 「要打給 王小美（女兒）嗎？」).
5. **Write with `confirm: false`** → run immediately.
6. **Audit.** Every invocation, confirmation, cancellation and expiry writes an `audit_event` with `actor_type = "ai"`, `actor_id = <principal id>`, `entity_type = "tool"`, `entity_id = <tool name or action id>`.

`pending_action`: `id, principal_kind, principal_id, tool, input (JSON), summary, created_at, expires_at (created + 2 min), status ∈ pending | confirmed | cancelled | expired`.

`confirmAction(principal, actionId)`:
- different principal → 403; unknown id → 404; past `expires_at` → 410 (and status `expired`); status not `pending` → 409.
- **re-runs the role filter and the tool's own `access` checks against current data**, then runs the tool and sets status `confirmed`.

### 5.3 HTTP

| Route | Purpose |
|---|---|
| `GET /tools` | Tools visible to the caller, with JSON Schemas. |
| `POST /tools/:name/invoke` | Body = tool input. |
| `POST /tools/actions/:id/confirm` | Confirm a pending action. |
| `POST /tools/actions/:id/cancel` | Cancel a pending action. |

These exist now because the resident's OpenAI Realtime session runs in the browser and relays tool calls to the backend (communicate's pattern); the staff and family assistants in sub-project 5 will call `invokeTool` in process.

### 5.4 Tools registered in this sub-project

Read-only, to prove the pipeline end to end:

| Tool | Roles | Returns |
|---|---|---|
| `list_my_residents_or_contacts` | device, family, staff, admin | device: approved family contacts (name, relationship label). family/staff/admin: visible residents. |
| `get_resident_status` | device, family, staff, admin | availability and room for a resident the caller can access; device may only ask about its own resident. |

Write tools (help request, call, booking) are registered by sub-projects 2–4.

## 6. Error handling

| Situation | Response |
|---|---|
| Invalid token; user or device disabled; device reassigned | 401 |
| Resident or resource outside the caller's scope | 403 — never 404 for resident-scoped resources, so existence is not leaked |
| Tool not available to caller | 404 `unknown_tool` |
| Pending action expired | 410 |
| Pending action already resolved | 409 |
| Bad input | 400 |

## 7. Testing

Vitest with in-memory SQLite, following the existing `apps/api` test layout.

- **Access matrix** — table-driven: {admin, staff, family, device} × {linked/assigned, unlinked, other facility, deactivated principal, deactivated resident} → allow / deny, for `canAccessResident` and `residentIdsVisibleTo`.
- **Revalidation** — a valid JWT stops working after user deactivation, device deactivation, and device reassignment.
- **Migration** — apply `0000`–`0001`, seed, apply `0002`; every former `robot_device` row exists in `device` with `facility_id` backfilled and `assignment_version = 1`.
- **Scope retrofit** — staff see only assigned residents in `/queue`, `/audit`, and the events WS; an unassigned staff member can still STOP the robot.
- **Admin API** — facility isolation (admin of facility A cannot touch facility B), device token returned once, reassignment increments version, every mutation audited.
- **Tool registry** — role filtering in listing and invoke; zod errors; read path; confirm path (success, expired, other principal, double confirm, access revoked between invoke and confirm); `confirm: false` path; audit rows.
- **Regression** — the existing API, web and gateway suites plus `npm run e2e` stay green; `npx tsc -b` passes.

## 8. Out of scope

Assistance requests, calls, scheduling, any LLM integration, porting any `oncare_communicate` UI, multi-facility family UX, SSO / facility IdP, Postgres.
