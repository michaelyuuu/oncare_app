# OnaCare Communication Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Port the tested communication prototype into `oncare_app` so the resident kiosk, staff console, authenticated API, assistant tools, and optional live voice share one TypeScript/Drizzle runtime.

**Architecture:** Add a durable staff-assistance service and scoped assistant routes to the existing Fastify API. Reuse the existing device/user principals, access service, audit/transition event stream, LiveKit visit flow, and tool registry. Keep voice behind a fake adapter plus an optional server-side OpenAI Realtime/WebRTC adapter; the resident UI remains touch-capable when voice is unavailable.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM, SQLite, Zod, React, Vitest, Vite, WebRTC, optional OpenAI Realtime.

**Spec:** `docs/superpowers/specs/2026-09-19-oncare-communication-integration-design.md`

## Global Constraints

- The customer runtime must not expose or execute robot movement, navigation, arms, grippers, fetching, delivery, ROS, shell commands, or actuator credentials.
- Resolve facility, resident, device, user, and role from the authenticated server-side principal; do not trust client or model identity claims.
- Keep raw assistant audio and full conversation transcripts out of persistence by default.
- Treat provider-unavailable voice as a capability state; keep touch Help and family calling usable.
- Use only allowlisted, Zod-validated assistant tools; reject unknown fields and tool names.
- A committed staff-help request is not the same as staff delivery, acknowledgment, or resolution.
- Use synthetic fixtures and fake providers in tests; never call a real provider or hardware adapter from the test suite.
- Preserve the separate `oncare_communicate` checkout and all existing uncommitted user changes.

---

### Task 1: Add durable assistance requests and scoped staff transitions

**Files:**
- Create: `apps/api/src/services/assistance.ts`
- Create: `apps/api/src/routes/assistance.ts`
- Create: `apps/api/test/assistance.test.ts`
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0003_communication.sql` and its generated Drizzle metadata
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/test/migration.test.ts`
- Modify: `apps/api/test/helpers.ts` only if the typed test fixture needs the new service

**Interfaces:**
- `AssistanceCategory` is the union `general_assistance | communication_support | other`.
- `AssistanceService.create(principal, input, idempotencyKey)` accepts only a device principal, resolves its resident and facility, stores an optional note of at most 500 characters, and returns `{ kind: "created" | "duplicate"; request: AssistanceRow }`.
- `AssistanceService.get(principal, requestId)` returns the row only when the principal is the owning device or an assigned staff/admin principal.
- `AssistanceService.listForStaff(principal)` returns only requests for `access.residentIdsVisibleTo(principal)`.
- `AssistanceService.act(principal, requestId, action)` accepts `acknowledge`, `in_progress`, `resolve`, `reject`, `fail_delivery`, `request_withdrawal`, and `confirm_withdrawal`, and returns either the updated row or a typed `not_found | forbidden | invalid_transition | conflict` result.

- [ ] **Step 1: Write the failing database and service tests.**

Add tests that create an assistance request from the seeded device and assert the stable ID, category, optional note, `recorded` persistence, `pending` delivery, `open` handling, `none` withdrawal, and `none` escalation states. Add a second create with the same `Idempotency-Key` and assert one row and a duplicate response. Add tests for malformed category/note, another resident's device, another facility's staff, unassigned staff, and a forged request body resident ID.

Add transition tests for:

```ts
acknowledge: pending/open -> delivered/acknowledged
in_progress: delivered/acknowledged -> delivered/in_progress
resolve: delivered/in_progress -> delivered/resolved
request_withdrawal: any non-terminal request -> withdrawal=requested
confirm_withdrawal: requested -> confirmed and handling=cancelled
```

Assert that `resolve` does not work for an unassigned staff member, duplicate acknowledgment is a conflict, and a delivered request is not erased by a withdrawal request.

Run:

```powershell
npm test -- apps/api/test/assistance.test.ts
```

Expected result: the new tests fail because the table, service, and routes do not exist.

- [ ] **Step 2: Add the schema and migration.**

Add `assistanceRequest` with these columns: `id`, `residentId`, `deviceId`, `facilityId`, `category`, `note`, `idempotencyKey`, `persistenceState`, `deliveryState`, `handlingState`, `withdrawalState`, `escalationState`, `version`, `createdAt`, `updatedAt`, `deliveryAt`, `acknowledgedAt`, `resolvedAt`, and `withdrawalAt`. Add foreign keys to facility, resident, and device plus a unique index on `(device_id, idempotency_key)`. Keep all state columns as explicit text enums in the Drizzle schema.

Create migration `0003_communication.sql` with the table, indexes, and no seed changes that would affect existing demo rows. Update the migration journal and snapshot using the repository's existing Drizzle format. Extend the migration test with a legacy database assertion that the new table is created and existing rows remain intact.

- [ ] **Step 3: Implement the service and routes.**

Implement the service with a single transaction for request creation, row initialization, and an audit event whose entity is `assistance_request`. Use `randomUUID()` IDs prefixed with `help_`, increment `version` on each valid action, and emit the transition event after the transaction. Use the existing access service for all staff visibility checks.

Expose these authenticated routes:

```text
POST /assistance-requests                         device create
GET  /assistance-requests/:id                     device or assigned staff read
POST /assistance-requests/:id/withdrawal          owning device withdrawal
GET  /staff/assistance-requests                   assigned staff queue
POST /staff/assistance-requests/:id/:action       assigned staff transition
```

Validate request bodies with Zod. The staff action route must reject unknown actions, stale `version` values, duplicate terminal transitions, and principals outside the resident assignment. Never return the private note to an unrelated principal.

- [ ] **Step 4: Run the focused API and migration tests.**

```powershell
npm test -- apps/api/test/assistance.test.ts apps/api/test/migration.test.ts
```

Expected result: all assistance and migration tests pass with zero failures.

- [ ] **Step 5: Commit the task.**

```powershell
git add apps/api/src/db/schema.ts apps/api/src/services/assistance.ts apps/api/src/routes/assistance.ts apps/api/drizzle apps/api/test/assistance.test.ts apps/api/test/migration.test.ts apps/api/src/app.ts
git commit -m "feat(api): add scoped staff assistance requests"
```

### Task 2: Expose communication tools and capability state

**Files:**
- Modify: `apps/api/src/tools/registry.ts`
- Modify: `apps/api/src/tools/builtin.ts`
- Create: `apps/api/src/routes/capabilities.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/test/tools.test.ts`
- Create: `apps/api/test/capabilities.test.ts`
- Modify: `packages/web-common/src/api.ts` only if a typed helper is needed by the resident UI

**Interfaces:**
- `request_staff_help` accepts `{ category, note? }`, is device-only, is schema-validated, and runs without an additional confirmation because the resident's explicit Help action is the confirmation.
- `get_my_request_status` accepts `{ requestId }` and returns only the owning resident's request with evidence-based status fields.
- `request_withdrawal` accepts `{ requestId }`, is device-only, and creates the withdrawal state without claiming cancellation until the receiving workflow confirms it.
- `get_service_status` is a read-only device tool returning separate `staff_assistance`, `family_call`, `voice_conversation`, and `robot` capability objects.
- `GET /capabilities` returns the same capability object filtered for the authenticated principal.

- [ ] **Step 1: Write failing tool and capability tests.**

Add tests asserting that a device sees exactly the five communication tools plus existing resident-safe reads, while family and staff do not see resident-only write tools. Invoke `request_staff_help` and assert the same assistance row is created as the touch route. Invoke the status and withdrawal tools with a foreign request ID and assert a scoped denial. Assert `GET /capabilities` reports `staff_assistance.state = "available"` only for the synthetic queue and reports robot actions as `not_supported`.

Run:

```powershell
npm test -- apps/api/test/tools.test.ts apps/api/test/capabilities.test.ts
```

Expected result: the new assertions fail because the communication tools and capability route are absent.

- [ ] **Step 2: Implement the tools and capability route.**

Inject the assistance service into the Fastify app and extend `BUILTIN_TOOLS` with the five schemas. Use strict Zod objects with `additionalProperties` rejected. Use `confirm: false` only for explicit resident service writes. Route status text through deterministic server fields; never accept a model-provided completion or acknowledgment field.

Register `GET /capabilities` behind `requireRole("family", "staff", "admin", "device")`. The customer capability object must include `environment: "customer_v0_1"`, `voice_conversation`, `family_call`, `staff_assistance`, and `robot`, with no physical-action tool names.

- [ ] **Step 3: Run focused tests and commit.**

```powershell
npm test -- apps/api/test/tools.test.ts apps/api/test/capabilities.test.ts
git add apps/api/src/tools apps/api/src/routes/capabilities.ts apps/api/src/app.ts apps/api/test/tools.test.ts apps/api/test/capabilities.test.ts packages/web-common/src/api.ts
git commit -m "feat(api): expose communication capabilities and tools"
```

### Task 3: Add fake and optional OpenAI Realtime assistant adapters

**Files:**
- Create: `apps/api/src/services/assistant-profile.ts`
- Create: `apps/api/src/services/voice.ts`
- Create: `apps/api/src/routes/assistant.ts`
- Create: `apps/api/test/assistant-profile.test.ts`
- Create: `apps/api/test/voice.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/.env.example`
- Modify: `README.md`

**Interfaces:**
- `AssistantProfile` contains bounded `identity`, `robot`, `canDo`, `cannotDo`, `facilityKnowledge`, `replyLanguage`, and `replyStyle` fields.
- `buildAssistantInstructions(profile)` always appends fixed safety rules after facility text.
- `VoiceProvider.createCall(sdp, config)` returns an SDP answer or a classified provider error; the provider never receives a client-supplied API key.
- `VoiceSession` stores `sessionId`, device principal ID, resident ID, assignment version, mode, provider, state, clarification count, and last request ID.
- `FakeVoiceAdapter.interpret(text, lastRequestId)` returns only an allowlisted tool proposal or a clarification result.

- [ ] **Step 1: Write failing profile, fake-session, and live-provider contract tests.**

Test that an absent profile uses the default identity, unknown profile fields and oversized text are rejected, fixed safety rules remain last, and language tags are validated. Test fake text input for staff help, status, contacts, request status, withdrawal, two clarifications followed by choices, interruption, close, and assignment revocation.

Test the live provider with an injected HTTP function that captures the request without network access. Assert the server sends the SDP and session configuration as multipart data, never exposes the API key in the response, and includes only the five communication tool definitions. Test provider unavailable, timeout, quota, and malformed SDP responses.

Run:

```powershell
npm test -- apps/api/test/assistant-profile.test.ts apps/api/test/voice.test.ts
```

Expected result: the tests fail because the TypeScript adapters do not exist.

- [ ] **Step 2: Implement the bounded profile and provider adapters.**

Port the behavior of `oncare_communicate/apps/api/ontaru_api/assistant_profile.py` and `voice.py` into small TypeScript modules. Keep the default adapter fake and select the live adapter only when `OPENAI_API_KEY` is configured. Use `ONCARE_REALTIME_MODEL`, `ONCARE_REALTIME_ENDPOINT`, and `ONCARE_ASSISTANT_PROFILE` as optional configuration names. Read profile JSON at server startup and fail closed on a configured invalid file.

- [ ] **Step 3: Add authenticated assistant routes and session binding.**

Expose:

```text
POST /assistant/sessions
POST /assistant/sessions/:id/input
POST /assistant/sessions/:id/interrupt
POST /assistant/sessions/:id/close
POST /assistant/realtime/calls
GET  /assistant/realtime/sessions/:id
POST /assistant/realtime/sessions/:id/tool
```

Bind every session to the device ID and assignment version. Refuse a session after device reassignment, when a family visit is active, or when the principal is not the owning device. The tool relay must invoke the same `app.tools` registry and must return the authoritative API result, not model-generated success text.

- [ ] **Step 4: Run focused tests, typecheck, and commit.**

```powershell
npm test -- apps/api/test/assistant-profile.test.ts apps/api/test/voice.test.ts
npm run typecheck
git add apps/api/src/services/assistant-profile.ts apps/api/src/services/voice.ts apps/api/src/routes/assistant.ts apps/api/test/assistant-profile.test.ts apps/api/test/voice.test.ts apps/api/src/app.ts apps/api/.env.example README.md
git commit -m "feat(api): add scoped resident assistant voice adapters"
```

### Task 4: Add the resident assistant surface

**Files:**
- Create: `apps/resident/src/components/AssistantPanel.tsx`
- Create: `apps/resident/src/assistant.ts`
- Create: `apps/resident/test/AssistantPanel.test.tsx`
- Modify: `apps/resident/src/screens/Home.tsx`
- Modify: `apps/resident/src/App.tsx`
- Modify: `apps/resident/src/styles.css`
- Modify: `apps/resident/src/speech.ts`
- Modify: `packages/web-common/src/i18n/en.json`

**Interfaces:**
- `AssistantPanel` receives `api`, `onClose`, `disabled`, and the current resident display name.
- `createAssistantClient(api)` exposes `startFakeSession`, `sendText`, `interrupt`, `close`, and an optional `startRealtime` method.
- Touch Help continues to call `POST /assistance-requests` directly and displays request evidence from `GET /assistance-requests/:id`.

- [ ] **Step 1: Write failing resident tests.**

Add tests asserting Home has a large `Talk to Ontaru` action, the assistant panel exposes a text fallback and Stop control, provider failure leaves Help and family-call actions enabled, a successful help request says it is recorded rather than acknowledged, and an assignment/auth failure resets the panel without retaining the previous request ID.

Run:

```powershell
npm test -- apps/resident/test/AssistantPanel.test.tsx apps/resident/test/App.test.tsx
```

Expected result: the new test fails because the assistant action and panel do not exist.

- [ ] **Step 2: Implement the touch-first panel and assistant client.**

Add the assistant entry to the resident Home screen without removing existing Call family, Help staff, settings, or privacy controls. Use the fake session endpoint for offline demos and display the server's capability state. Use the existing browser speech helper only for short controlled status prompts; do not store transcripts. Add the optional Realtime/WebRTC path behind the returned `voice_conversation` capability and route function calls through `/assistant/realtime/sessions/:id/tool`.

Keep reduced-motion and large-target styles consistent with the current resident kiosk. On close, interrupt provider playback, close the session, clear local request context, and return to Home. Do not withdraw a committed assistance request merely because the assistant panel closes.

- [ ] **Step 3: Run resident tests and commit.**

```powershell
npm test -- apps/resident/test/AssistantPanel.test.tsx apps/resident/test/App.test.tsx
git add apps/resident/src apps/resident/test/AssistantPanel.test.tsx packages/web-common/src/i18n/en.json
git commit -m "feat(resident): add touch-first Ontaru assistant"
```

### Task 5: Add the staff assistance queue

**Files:**
- Modify: `apps/api/src/routes/staff.ts`
- Modify: `apps/staff/src/types.ts`
- Modify: `apps/staff/src/components/Queue.tsx`
- Modify: `apps/staff/src/pages/Console.tsx` if queue props need extension
- Modify: `apps/staff/src/styles.css`
- Modify: `apps/staff/test/App.test.tsx`
- Modify: `packages/web-common/src/i18n/en.json`

**Interfaces:**
- `QueueData.assistanceRequests` contains rows returned by `/queue` or `/staff/assistance-requests` with stable ID, resident ID, category, note, delivery state, handling state, withdrawal state, version, and timestamps.
- `Action` sends the route plus the current version so stale staff views receive a conflict and refresh rather than applying a duplicate side effect.

- [ ] **Step 1: Write failing staff tests.**

Add a seeded assistance request to the staff queue fixture. Assert the row displays resident, category, evidence-based status, and note only for assigned staff. Assert Acknowledge, In progress, Resolve, and delivery-failure actions call exact routes and refresh the queue. Assert an unassigned staff API request returns 403 and a stale version returns 409.

Run:

```powershell
npm test -- apps/staff/test/App.test.tsx apps/api/test/assistance.test.ts
```

Expected result: the staff UI test fails because queue data has no assistance rows.

- [ ] **Step 2: Implement queue API and UI.**

Extend `/queue` with `assistanceRequests: app.assistance.listForStaff(req.principal)`. Render an assistance row separately from robot visits and delivery tasks. Use controlled copy: `Request recorded`, `Reached staff queue`, `Staff acknowledged`, `Work in progress`, `Marked resolved`, or `Delivery status unknown`. Never display `nurse is coming` or an arrival promise.

- [ ] **Step 3: Run staff/API tests and commit.**

```powershell
npm test -- apps/staff/test/App.test.tsx apps/api/test/assistance.test.ts
git add apps/api/src/routes/staff.ts apps/staff/src apps/staff/test/App.test.tsx packages/web-common/src/i18n/en.json
git commit -m "feat(staff): add assistance request queue"
```

### Task 6: Documentation, full verification, and push

**Files:**
- Modify: `README.md`
- Modify: `apps/api/.env.example`
- Modify: `docs/takeover-report-2026-09-16.md` or add `docs/runbooks/assistant-communication-demo.md`
- Create: `scripts/demo-assistant-check.mjs` if a deterministic repository-level smoke check is needed
- Modify: `package.json` only if the smoke check needs a named script

- [ ] **Step 1: Document the integrated runtime.**

Document the resident device login, fake assistant demo, staff acknowledgment path, optional live-provider configuration, capability states, the absence of robot tools, and the exact commands for synthetic checks. State that OpenAI microphone/provider execution, staffing coverage, media approval, and physical installation remain deployment gates.

- [ ] **Step 2: Run the complete safe verification matrix.**

```powershell
npm run typecheck
npm test
python -m pytest -q ..\oncare_communicate
npm --prefix ..\oncare_communicate\apps\web test
python ..\oncare_communicate\scripts\verify_customer_boundary.py
git diff --check
git status --short --branch
```

The TypeScript suite must report zero failures. Python and communication-web results are behavioral reference checks; no Python files are copied into `oncare_app` and no real provider or robot is contacted.

- [ ] **Step 3: Review the final diff.**

Confirm that only the design, implementation, tests, migrations, docs, and configuration named in this plan changed. Confirm no secrets, resident media, Python database files, actuator references, or unrelated changes are staged.

- [ ] **Step 4: Commit release documentation and push.**

```powershell
git add README.md apps/api/.env.example docs scripts package.json
git commit -m "docs: record integrated communication demo"
git push -u origin integration/communication
```

Expected result: the remote branch `origin/integration/communication` points to the verified integration branch and the working tree is clean.
