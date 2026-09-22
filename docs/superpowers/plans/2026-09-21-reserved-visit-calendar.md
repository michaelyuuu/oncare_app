# Reserved Robot Visit Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one-time, two-sided scheduling for one-hour ON 0 robot visits with video calls, including a landscape resident calendar, five-minute proposal holds, confirmation, reminders, and resident-initiated calls.

**Architecture:** Keep scheduling in a new reservation service and leave `visitSession` responsible for the active robot/video state machine. Put deterministic slot and timezone rules in `packages/core`, expose authorized reservation routes from the API, and reuse the existing transition/WebSocket and LiveKit paths for activation and calls.

**Tech Stack:** TypeScript, npm workspaces, Fastify, SQLite/Drizzle, Zod, Vitest, React, Vite, Playwright, LiveKit/fake video provider.

**Spec:** `docs/superpowers/specs/2026-09-21-reserved-visit-calendar-design.md`

## Global Constraints

- Reservations are one-time only and exactly one hour.
- Bookable slot starts are 09:00, 10:00, 11:00, 13:00, 14:00, and 15:00 in the facility timezone.
- The calendar covers the next 14 days; lunch, staff handoff, and dinner/quiet periods remain visible but disabled.
- Pending proposals hold a slot for five minutes; suggesting another time releases the original hold immediately.
- Confirmed calls show a 10-minute reminder and dispatch ON 0 five minutes before the reserved time.
- Only active, consented resident/family relationships may schedule or call.
- The resident communication home and separate **I need help** action remain intact.
- Store timestamps as ISO instants and display them in the facility timezone.
- No external calendar provider, recurring visits, arbitrary contacts, or voice-only confirmation.
- Never commit `.env` files, API keys, databases, or generated reports.

---

### Task 1: Add the deterministic slot and timezone policy

**Files:**
- Create: `packages/core/src/scheduling.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/scheduling.test.ts`

**Interfaces:**
- Produces `DEMO_VISIT_POLICY`, `VisitSlotDefinition`, `VisitSlotState`, `VisitBlockReason`, `buildVisitSlotDefinitions(localDate)`, `isVisitDateInWindow(localDate, todayLocalDate)`, and `localSlotToIso(localDate, startMinute, timeZone)` for the API and UI layers.
- `VisitSlotDefinition` has `{ localDate: string; startMinute: number; endMinute: number; state: "available" | "blocked"; reason?: "lunch" | "staff_handoff" | "dinner_quiet" }`.

- [ ] **Step 1: Write the failing policy tests.**

  Add tests for the six bookable starts, the three blocked periods, the 14-day inclusive window, dates outside the window, and Asia/Taipei conversion of `2026-09-22 09:00` to `2026-09-22T01:00:00.000Z`.

  ```ts
  test("builds the fixed demo day with blocked periods", () => {
    expect(buildVisitSlotDefinitions("2026-09-22")).toEqual([
      expect.objectContaining({ startMinute: 540, endMinute: 600, state: "available" }),
      expect.objectContaining({ startMinute: 600, endMinute: 660, state: "available" }),
      expect.objectContaining({ startMinute: 660, endMinute: 720, state: "available" }),
      expect.objectContaining({ startMinute: 720, endMinute: 780, state: "blocked", reason: "lunch" }),
      expect.objectContaining({ startMinute: 780, endMinute: 840, state: "available" }),
      expect.objectContaining({ startMinute: 840, endMinute: 900, state: "available" }),
      expect.objectContaining({ startMinute: 900, endMinute: 960, state: "available" }),
      expect.objectContaining({ startMinute: 960, endMinute: 1020, state: "blocked", reason: "staff_handoff" }),
      expect.objectContaining({ startMinute: 1020, endMinute: 1080, state: "blocked", reason: "dinner_quiet" }),
    ]);
  });
  ```

- [ ] **Step 2: Run the focused test to verify it fails for the missing policy module.**

  Run: `npx vitest run packages/core/test/scheduling.test.ts`

  Expected: FAIL because `../src/scheduling` and its exported policy functions do not exist.

- [ ] **Step 3: Implement the minimal policy and timezone conversion.**

  Define the constants from the spec, generate one-hour definitions from 09:00 through 18:00, mark 12:00–13:00, 16:00–17:00, and 17:00–18:00 with their reasons, reject dates outside the next 14 local dates, and convert local slot boundaries to ISO instants using `Intl.DateTimeFormat` timezone offsets without adding a date library.

- [ ] **Step 4: Export the module and run the focused tests.**

  Run: `npx vitest run packages/core/test/scheduling.test.ts`

  Expected: PASS with all policy and timezone assertions green.

- [ ] **Step 5: Commit the independent domain change.**

  ```bash
  git add packages/core/src/scheduling.ts packages/core/src/index.ts packages/core/test/scheduling.test.ts
  git commit -m "tfeat(core): add scheduled visit slot policy"
  ```

### Task 2: Add reservation persistence and shared response types

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0004_reserved_visit_calendar.sql` and the generated `apps/api/drizzle/meta/0004_snapshot.json`
- Modify: `packages/web-common/src/index.ts`
- Create: `packages/web-common/src/scheduling.ts`
- Modify: `apps/api/test/migration.test.ts`
- Create: `packages/web-common/test/scheduling.test.ts`

**Interfaces:**
- `visitReservation` stores `facilityId`, `residentId`, `familyUserId`, `robotId`, `proposerKind`, `proposerId`, `status`, `startAt`, `endAt`, `timeZone`, `expiresAt`, `reminderAt`, `dispatchAt`, confirmation/cancellation fields, `supersedesId`, `visitId`, `createdAt`, and `updatedAt`.
- `visitSession` gains nullable `scheduledStartAt`, `initiatorKind`, and `initiatorId` so an activated reservation and resident-initiated immediate call retain their timing and origin.
- Shared types include `ReservationStatus`, `VisitContact`, `VisitSlot`, and `VisitReservationView` so both apps render the same server contract.

- [ ] **Step 1: Add migration assertions before changing the schema.**

  Extend `apps/api/test/migration.test.ts` to open an in-memory database and assert that `visit_reservation` exists with `status`, `start_at`, `end_at`, `expires_at`, `visit_id`, and that `visit_session` exposes `scheduled_start_at`, `initiator_kind`, and `initiator_id`.

- [ ] **Step 2: Run the migration test and verify the expected schema failure.**

  Run: `npx vitest run apps/api/test/migration.test.ts`

  Expected: FAIL because the new table and columns are absent.

- [ ] **Step 3: Implement the Drizzle schema and generate the 0004 migration.**

  Add the table and nullable visit columns, then run `npm run db:generate -w @oncare/api`. Review the generated SQL and snapshot, preserving the existing foreign-key and index style. Add indexes that support pending/conflict queries by resident, family user, robot, start time, and status.

- [ ] **Step 4: Add shared scheduling response types and exports.**

  Define the exact serialized fields used by the API, export them from `packages/web-common/src/index.ts`, and add a runtime test that confirms reservation statuses and slot state values are represented without duplicate string literals in the apps.

- [ ] **Step 5: Run migration, shared-package, and type checks.**

  Run: `npx vitest run apps/api/test/migration.test.ts packages/web-common/test/scheduling.test.ts`

  Expected: PASS.

- [ ] **Step 6: Commit persistence and shared contracts.**

  ```bash
  git add apps/api/src/db/schema.ts apps/api/drizzle packages/web-common/src/scheduling.ts packages/web-common/src/index.ts packages/web-common/test/scheduling.test.ts apps/api/test/migration.test.ts
  git commit -m "tfeat(calendar): add reservation persistence"
  ```

### Task 3: Implement contacts, slot availability, and reservation actions

**Files:**
- Create: `apps/api/src/services/reservations.ts`
- Create: `apps/api/src/routes/reservations.ts`
- Modify: `apps/api/src/services/directory.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/test/reservations.test.ts`

**Interfaces:**
- `createReservationService(db, access, transitions, opts)` returns `contacts`, `slots`, `list`, `createProposal`, `confirm`, `suggest`, `cancel`, and `expirePending`.
- `POST /visit-reservations` accepts a family body `{ residentId, localDate, startMinute }` or a device body `{ contactUserId, localDate, startMinute }`; the server derives the missing participant from the authenticated principal.
- `GET /visit-reservations/contacts` returns `{ contacts: VisitContact[] }` for a resident device.
- `GET /visit-reservations/slots?residentId=<id>&from=<YYYY-MM-DD>` returns `{ timeZone, slots }` for the next 14 days.
- `GET /visit-reservations` returns reservations visible to the current resident device or family user.
- `POST /visit-reservations/:id/confirm`, `/suggest` with `{ localDate, startMinute }`, and `/cancel` return `{ reservation }`.
- Service errors are `not_found`, `forbidden`, `consent_missing`, `invalid_slot`, `conflict`, `expired`, and `invalid_action`.

- [ ] **Step 1: Write API tests for authorization and proposal lifecycle.**

  Cover: family proposal with consent, resident proposal to exactly one approved contact, hidden/unapproved contacts, blocked-slot rejection, dates beyond 14 days, resident/family/robot overlap conflicts, five-minute expiry, receiver-only confirmation, replacement proposal releasing the old hold, either-participant cancellation, and live transition events.

- [ ] **Step 2: Run the reservation tests to verify they fail before the service exists.**

  Run: `npx vitest run apps/api/test/reservations.test.ts`

  Expected: FAIL because the reservation routes/service are not registered.

- [ ] **Step 3: Implement the service with transactional conflict checks.**

  Resolve the facility timezone and robot from the resident, use `packages/core` to validate local slots, lazily expire old pending rows before every availability/conflict query, and insert proposals in a SQLite transaction. Require both `consentVideo` and `consentRobotVisit`. Treat pending and confirmed rows as conflicts for the resident, selected family user, and robot.

- [ ] **Step 4: Implement routes and register them in `apps/api/src/app.ts`.**

  Use Zod unions for the family/device create bodies, `requireRole("family", "device")` for participant routes, and `requireRole("family", "staff", "admin", "device")` for reads/cancellation where appropriate. Map forbidden, missing, expired, and conflict service errors to the existing 403/404/409 response style.

- [ ] **Step 5: Run focused API tests and typecheck.**

  Run: `npx vitest run apps/api/test/reservations.test.ts && npm run typecheck`

  Expected: PASS with no TypeScript errors.

- [ ] **Step 6: Commit the reservation API.**

  ```bash
  git add apps/api/src/services/reservations.ts apps/api/src/routes/reservations.ts apps/api/src/services/directory.ts apps/api/src/app.ts apps/api/test/reservations.test.ts
  git commit -m "tfeat(api): add two-sided visit reservations"
  ```

### Task 4: Integrate scheduled activation and resident-initiated immediate calls

**Files:**
- Modify: `packages/core/src/visit-state.ts`
- Modify: `packages/core/test/visit-state.test.ts`
- Modify: `apps/api/src/services/visits.ts`
- Modify: `apps/api/src/services/dispatch.ts`
- Create: `apps/api/src/services/reservation-scheduler.ts`
- Modify: `apps/api/src/routes/visits.ts`
- Modify: `apps/api/src/routes/device.ts`
- Modify: `apps/api/src/routes/video.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/test/reservation-scheduler.test.ts`
- Modify: `apps/api/test/visit-actions.test.ts` and `apps/api/test/video.test.ts`

**Interfaces:**
- Add `awaiting_family_consent` to the visit state machine for a resident-initiated call; it transitions to `connecting`, `cancelled`, or `safety_stopped`.
- `createVisitService` preserves the existing family `create` method and adds `createNow({ residentId, familyUserId, initiator })` plus `createScheduled({ residentId, familyUserId, scheduledStartAt, reservationId })`.
- `createReservationScheduler({ db, reservations, visits, transitions, dispatch, now, intervalMs })` returns `tick(at)`, `start()`, and `stop()`.
- `POST /visits/now` creates an immediate visit for a family or device participant after the reservation service validates the selected contact.
- `screenForVisitState(state, scheduledStartAt, now, initiatorKind)` hides a pre-start scheduled ring, shows the resident’s outgoing wait for `awaiting_family_consent`, and preserves the existing incoming/in-call mapping.

- [ ] **Step 1: Add failing state and scheduler tests.**

  Test that resident-initiated robot arrival enters `awaiting_family_consent`, family `answer` is authorized only for that state, a confirmed reservation is activated exactly five minutes before start, pending holds expire, the device stays on home before `scheduledStartAt`, and a resident immediate call can issue a device video token while waiting for family acceptance.

- [ ] **Step 2: Run the focused tests and observe the missing-state failures.**

  Run: `npx vitest run packages/core/test/visit-state.test.ts apps/api/test/reservation-scheduler.test.ts apps/api/test/video.test.ts`

  Expected: FAIL because the new state, scheduler, scheduled fields, and device/family call path do not exist.

- [ ] **Step 3: Add the state-machine and visit-service changes.**

  Let dispatch choose `awaiting_family_consent` when `initiatorKind === "device"`; preserve `awaiting_resident_consent` for family-originated visits. Store the selected family user as the visit participant for access checks and the initiator fields for correct origin/audit behavior. Keep `answer` device-only for `awaiting_resident_consent`, add a separate `answer_family` action restricted to family for `awaiting_family_consent`, and do not let a family user answer a normal resident incoming call.

- [ ] **Step 4: Add the scheduler and app lifecycle hooks.**

  On each tick, expire pending proposals, emit one reminder event when `reminderAt` is reached, activate confirmed rows whose dispatch time has arrived, create exactly one scheduled visit, and link its id back to the reservation. Start the scheduler when the API is ready and stop it in the Fastify close hook. Use an atomic status/visit-id claim so repeated ticks cannot dispatch twice.

- [ ] **Step 5: Update device state and video-token access.**

  Keep the visit row available to internal scheduling but suppress `incoming` until the reserved start. Allow the device to join `awaiting_family_consent` for its outgoing call; allow the family participant to join after answering. Preserve the existing token denial for unrelated users and terminal visits.

- [ ] **Step 6: Add the immediate-call route and family inbound query.**

  Implement `POST /visits/now` using the same relationship/consent checks as reservations. Add `GET /visits/incoming` for a family user, scoped to their selected relationship, so the family app can answer a resident-initiated call. Keep the existing family `POST /visits` compatibility path and map it to the immediate service.

- [ ] **Step 7: Add a safe deterministic clock hook for E2E only.**

  In `apps/api/src/server.ts`, when `NODE_ENV !== "production"` and `ONCARE_TEST_CLOCK_FILE` is set, pass a `now` function to `buildApp` that reads the ISO instant from that file on each call; otherwise use the system clock. Add the file path to the Playwright web-server environment only, and never expose a runtime clock-changing endpoint.

- [ ] **Step 8: Run focused integration tests and commit.**

  Run: `npx vitest run packages/core/test/visit-state.test.ts apps/api/test/reservation-scheduler.test.ts apps/api/test/visit-actions.test.ts apps/api/test/video.test.ts`

  Expected: PASS.

  ```bash
  git add packages/core/src/visit-state.ts packages/core/test/visit-state.test.ts apps/api/src/services/visits.ts apps/api/src/services/dispatch.ts apps/api/src/services/reservation-scheduler.ts apps/api/src/routes/visits.ts apps/api/src/routes/device.ts apps/api/src/routes/video.ts apps/api/src/app.ts apps/api/test/reservation-scheduler.test.ts apps/api/test/visit-actions.test.ts apps/api/test/video.test.ts
  git commit -m "tfeat(api): activate scheduled and resident calls"
  ```

### Task 5: Add assistant scheduling proposals with on-screen confirmation

**Files:**
- Modify: `apps/api/src/tools/registry.ts`
- Modify: `apps/api/src/tools/builtin.ts`
- Modify: `apps/api/src/services/voice.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/test/tools.test.ts`
- Modify: `apps/api/test/voice.test.ts`
- Modify: `apps/resident/src/realtime.ts`
- Modify: `apps/resident/src/components/AssistantPanel.tsx`
- Create: `apps/resident/src/components/AssistantActionConfirmation.tsx`
- Modify: `apps/resident/test/AssistantPanel.test.tsx`

**Interfaces:**
- Add read tools `get_visit_schedule` and `get_visit_slots` for the device.
- Add confirmed write tool `propose_visit_time` with `{ contactUserId, localDate, startMinute }`; its `summarize` text names the contact, local time, and one-hour ON 0 visit, and its `run` creates a pending reservation only after `/tools/actions/:id/confirm`.
- Add the same function schemas with `type: "function"` to `REALTIME_TOOL_DEFINITIONS`.
- `AssistantActionConfirmation` accepts `{ actionId, summary, expiresAt, onConfirm, onCancel }` and renders a large touch confirmation inside the communication surface.

- [ ] **Step 1: Write failing tool and assistant UI tests.**

  Assert that the scheduling write returns `needsConfirmation` without inserting a reservation, confirmation inserts one pending reservation, cancellation leaves no reservation, realtime tool schemas expose the new functions, and the resident panel renders **Confirm**/**Cancel** when a tool result contains an action id.

- [ ] **Step 2: Run focused tests and verify missing-tool/UI failures.**

  Run: `npx vitest run apps/api/test/tools.test.ts apps/api/test/voice.test.ts apps/resident/test/AssistantPanel.test.tsx`

  Expected: FAIL because the scheduling tools and confirmation component are absent.

- [ ] **Step 3: Add reservation access to `ToolContext` and implement the tools.**

  Pass the reservation service through `createToolRegistry`, enforce device-only access, return evidence-based schedule data, and use the existing pending-action transaction for the final screen confirmation.

- [ ] **Step 4: Add fake and realtime tool definitions.**

  Teach `FakeVoiceAdapter` to recognize scheduling requests only when the resident supplies a contact/time choice; otherwise return one clarification question. Update the OpenAI schemas and keep the identity/safety instructions explicit that Ontaru cannot move ON 0 or access its camera.

- [ ] **Step 5: Render confirmation actions in the assistant panel.**

  Parse `needsConfirmation`, display the summary and expiry, call `/tools/actions/:id/confirm` or `/cancel`, and announce the result without opening a second microphone session. Cover both simulated text results and realtime tool-result callbacks.

- [ ] **Step 6: Run tests and commit the assistant integration.**

  Run: `npx vitest run apps/api/test/tools.test.ts apps/api/test/voice.test.ts apps/resident/test/AssistantPanel.test.tsx && npm run typecheck`

  ```bash
  git add apps/api/src/tools/registry.ts apps/api/src/tools/builtin.ts apps/api/src/services/voice.ts apps/api/src/app.ts apps/api/test/tools.test.ts apps/api/test/voice.test.ts apps/resident/src/realtime.ts apps/resident/src/components/AssistantPanel.tsx apps/resident/src/components/AssistantActionConfirmation.tsx apps/resident/test/AssistantPanel.test.tsx
  git commit -m "tfeat(assistant): propose scheduled visits safely"
  ```

### Task 6: Build the resident landscape calendar and actions

**Files:**
- Create: `apps/resident/src/screens/VisitCalendar.tsx`
- Create: `apps/resident/src/components/VisitReservationCard.tsx`
- Create: `apps/resident/src/components/VisitContactPicker.tsx`
- Modify: `apps/resident/src/screens/Home.tsx`
- Modify: `apps/resident/src/App.tsx`
- Modify: `apps/resident/src/styles.css`
- Modify: `apps/resident/src/screen.ts`
- Modify: `apps/resident/test/CommunicationHome.test.tsx`
- Create: `apps/resident/test/VisitCalendar.test.tsx`
- Modify: `apps/resident/test/App.test.tsx`
- Modify: `packages/web-common/src/i18n/en.json`

**Interfaces:**
- `VisitCalendar` receives `api`, `residentId`, `timeZone`, `contacts`, `reservations`, `onClose`, and `onChanged`.
- `VisitContactPicker` exposes exactly one selected approved contact and does not render unapproved relationships.
- `VisitReservationCard` renders pending countdown, confirm/suggest actions, confirmed reminder, cancellation, and expired/conflict/error states.

- [ ] **Step 1: Write failing resident tests.**

  Cover Home rendering **Schedule a visit**, **Call now**, and **I need help**; contact selection before either call action; landscape two-pane date/slot rendering; disabled blocked slots; five-minute pending countdown; confirm/suggest/cancel requests; and no duplicate action while a request is pending.

- [ ] **Step 2: Run the resident tests and verify the new UI is absent.**

  Run: `npx vitest run apps/resident/test/CommunicationHome.test.tsx apps/resident/test/VisitCalendar.test.tsx apps/resident/test/App.test.tsx`

  Expected: FAIL on the missing actions, screen, and calendar component.

- [ ] **Step 3: Add the resident calendar and contact picker.**

  Add an explicit landscape layout with a month/date rail, large slot buttons, visible meal/handoff/quiet reasons, selected-time summary, and local-time label. Keep the communication orb as the home visual and leave the bottom **I need help** behavior unchanged.

- [ ] **Step 4: Wire resident reservation and immediate-call actions.**

  Load `/visit-reservations/contacts`, `/slots`, and `/visit-reservations`; post proposal/confirm/suggest/cancel actions; post `/visits/now` for **Call now**; subscribe to `/events` and refresh on resident-scoped reservation/visit events.

- [ ] **Step 5: Add localization, accessibility, and responsive styling.**

  Add resident scheduling strings to `packages/web-common/src/i18n/en.json`, use button labels and live status regions for countdown/error updates, keep touch targets at least 48px, and preserve the kiosk fallback when the API is offline.

- [ ] **Step 6: Run focused resident tests and commit.**

  Run: `npx vitest run apps/resident/test/CommunicationHome.test.tsx apps/resident/test/VisitCalendar.test.tsx apps/resident/test/App.test.tsx && npm run typecheck`

  ```bash
  git add apps/resident/src packages/web-common/src/i18n/en.json apps/resident/test
  git commit -m "tfeat(resident): add landscape visit calendar"
  ```

### Task 7: Build the family schedule, response, and incoming-call UI

**Files:**
- Create: `apps/family/src/pages/ScheduleVisit.tsx`
- Create: `apps/family/src/pages/IncomingVisit.tsx`
- Create: `apps/family/src/components/VisitReservationCard.tsx`
- Modify: `apps/family/src/App.tsx`
- Modify: `apps/family/src/pages/Residents.tsx`
- Modify: `apps/family/src/pages/Visit.tsx`
- Modify: `apps/family/src/styles.css`
- Modify: `apps/family/test/App.test.tsx`
- Create: `apps/family/test/ScheduleVisit.test.tsx`
- Modify: `packages/web-common/src/i18n/en.json`

**Interfaces:**
- `ScheduleVisit` receives `residentId`, `residentName`, `api`, and callbacks for back, reservation creation, and immediate visit creation.
- `IncomingVisit` receives a family-visible visit id and offers **Answer**/**Decline**, then routes to the existing `Visit` call screen.

- [ ] **Step 1: Write failing family tests.**

  Assert that each resident card exposes **Schedule a visit** and **Call now**, the family landscape calendar shows the same six bookable starts and disabled blocks, the family can confirm or suggest another time, cancellation works, and a resident-initiated incoming visit appears and answers.

- [ ] **Step 2: Run focused family tests and verify missing route/UI failures.**

  Run: `npx vitest run apps/family/test/App.test.tsx apps/family/test/ScheduleVisit.test.tsx`

  Expected: FAIL because the schedule route, reservation actions, and incoming-call query are absent.

- [ ] **Step 3: Implement the family calendar and reservation response flow.**

  Reuse the shared response types and API paths, show the facility timezone, keep **Schedule a visit** primary, preserve the existing immediate family visit path for **Call now**, and display Confirm/Suggest another/Cancel states with server errors mapped to existing localization conventions.

- [ ] **Step 4: Implement family incoming-call polling and live updates.**

  Poll `GET /visits/incoming` while logged in, listen to the existing WebSocket for visible visit transitions, avoid duplicate prompts by visit id, and route an answered visit to `Visit.tsx` so LiveKit remains centralized in `CallPanel`.

- [ ] **Step 5: Add family localization and run tests.**

  Run: `npx vitest run apps/family/test/App.test.tsx apps/family/test/ScheduleVisit.test.tsx apps/family/test/CallPanel.test.tsx && npm run typecheck`

- [ ] **Step 6: Commit the family UI.**

  ```bash
  git add apps/family/src apps/family/test packages/web-common/src/i18n/en.json
  git commit -m "tfeat(family): add visit scheduling and responses"
  ```

### Task 8: Add staff visibility, end-to-end coverage, and final verification

**Files:**
- Modify: `apps/api/src/routes/staff.ts`
- Modify: `apps/staff/src/types.ts`
- Modify: `apps/staff/src/pages/Console.tsx`
- Modify: `apps/staff/src/components/Queue.tsx`
- Modify: `apps/staff/test/App.test.tsx`
- Modify: `e2e/` scheduled-visit scenario and fixtures
- Modify: `README.md` with demo scheduling instructions

**Interfaces:**
- Staff queue receives upcoming reservations and explicit robot dispatch failures in the existing facility/resident scope.
- The Playwright story covers family proposal, resident confirmation, five-minute-before dispatch with fake time, incoming resident call, and successful fake-video completion.

- [ ] **Step 1: Write failing staff and E2E assertions.**

  Add a staff test for upcoming reservation visibility/cancellation and an E2E scenario that uses seeded Demo Care House, selects a fixed slot, confirms it from the other app, writes the slot start instant to the test clock file, and answers the call with the fake video provider.

- [ ] **Step 2: Run the focused tests to verify the missing queue and flow.**

  Run: `npx vitest run apps/staff/test/App.test.tsx && npm run e2e -- --grep "scheduled visit"`

  Expected: FAIL until the staff payload and E2E selectors exist.

- [ ] **Step 3: Add staff reservation data and actions.**

  Extend the staff queue payload with upcoming reservations and dispatch failures, add a scoped cancel action, and render the same clear status labels without adding robot control capabilities to the resident UI.

- [ ] **Step 4: Finish the deterministic Playwright scenario and documentation.**

  Force `ONCARE_VIDEO_PROVIDER=fake`, set `ONCARE_TEST_CLOCK_FILE` to a temporary file created by the Playwright fixture, use stable `data-testid` selectors for calendar/slot/proposal actions, write the reserved slot start to the test clock file to trigger the scheduler, document the 14-day demo policy and seeded account flow in `README.md`, and include the local/Tailscale URLs only as runtime instructions rather than committed secrets.

- [ ] **Step 5: Run the complete verification suite.**

  Run: `npm test`, `npm run typecheck`, `npm run e2e`, `npm run demo:check`, and `git diff --check`.

  Expected: all Vitest tests, type checks, scheduled-call E2E, and deterministic demo checks pass.

- [ ] **Step 6: Commit the staff, E2E, and documentation changes.**

  ```bash
  git add apps/api/src/routes/staff.ts apps/staff/src apps/staff/test e2e README.md
  git commit -m "tfeat(calendar): verify scheduled visit demo"
  ```

## Execution order

Execute Tasks 1–4 sequentially because the API and scheduler depend on the domain policy and reservation schema. Tasks 5–7 can then proceed in sequence with their focused test gates; Task 8 is the final integration gate. Preserve and do not stage unrelated existing communication, assistant-profile, `AGENTS.md`, or `config/assistant.json` changes unless a task explicitly modifies them.
