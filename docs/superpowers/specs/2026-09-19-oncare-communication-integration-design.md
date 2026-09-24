# OnaCare Communication Integration Design

**Date:** 2026-09-19  
**Target repository:** `oncare_app`  
**Integration branch:** `integration/communication`

## Decision

Make `oncare_app` the single source of truth for the customer communication runtime. Port the tested communication behavior from the separate `oncare_communicate` prototype into the existing TypeScript monorepo instead of embedding the Python/SQLite service as a second application.

The main repository already owns authenticated facility, resident, family, staff, device, visit, robot, task, audit, and realtime concepts. The communication prototype has the missing resident assistant behavior: durable staff-help requests, evidence-based status wording, approved-contact lookup, withdrawal, a fake voice adapter, and an optional OpenAI Realtime/WebRTC adapter. Those behaviors will use the main repository's principal, Drizzle database, transition/audit service, websocket events, LiveKit video provider, and role-scoped tool registry.

## Scope

### Included

- Resident kiosk entry point labelled **Talk to Ontaru**.
- Touch-first staff-help request flow that remains usable without voice.
- Durable assistance request records with separate persistence, delivery, handling, withdrawal, and escalation evidence.
- Staff queue actions for acknowledge, resolve, reject, and explicit delivery failure/escalation states.
- Assistant tools limited to approved family-contact lookup, staff-help request creation, current request status, withdrawal request, and service/capability status.
- A deterministic fake assistant adapter for offline tests and demos.
- An optional server-side OpenAI Realtime/WebRTC adapter. The API key remains server-only and the browser receives only a short-lived session response.
- Reuse of the existing visit/LiveKit flow for family calls. Family-call audio is not automatically sent to the assistant.
- Assistant profile configuration with bounded text/list fields and fixed safety instructions appended after facility-provided text.
- Synthetic demo documentation and environment examples with empty credential values.

### Excluded

- Robot movement, navigation, arms, grippers, fetching, delivery, ROS, shell commands, or actuator credentials in the customer assistant.
- Copying the Python/SQLite database, synthetic-header authentication, or a second resident/family/staff identity system into the main repository.
- Persisting raw assistant audio or full conversation transcripts by default.
- Always-on wake-word detection.
- Clinical diagnosis, triage, urgency scoring, assisted consent, or emergency nurse-call claims.
- Changes to the separate laboratory robotics repository.

## Runtime architecture

```text
Resident kiosk / family app / staff console
                  |
        authenticated Fastify API
                  |
  access + policy + Drizzle persistence + audit/events
          |                         |
    assistant tools             LiveKit visits
          |
  fake adapter or OpenAI Realtime/WebRTC adapter
```

The resident device authenticates with the existing device token flow. Every assistant request resolves the resident, facility, device assignment, and actor from the server-side principal. The model may propose only a registered tool with a strict schema; it cannot supply an arbitrary resident ID, facility ID, URL, shell command, ROS command, or completion claim.

The browser's Realtime data channel is an untrusted transport. Function-call arguments are sent to a server-side assistant endpoint, parsed again, and executed through the same scoped tool registry used by the rest of the application. Provider failure changes voice availability only; it does not remove touch controls or alter already committed assistance state.

## Assistance contract

An assistance request has one stable ID and independently tracked dimensions:

- persistence: `recorded` or `failed`;
- delivery: `pending`, `delivered`, `failed`, or `unknown`;
- handling: `open`, `acknowledged`, `in_progress`, `resolved`, or `cancelled`;
- withdrawal: `none`, `requested`, `confirmed`, or `rejected`;
- escalation: `none`, `due`, `attempting`, `delivered`, or `failed`.

The resident-facing response is derived only from those persisted states. Creating a database row does not claim staff receipt. A staff action or verified receiver event is required for acknowledgment and resolution. Creation is idempotent by client key; duplicate retries return the existing request. A request that is already delivered cannot be silently erased by a resident withdrawal tap.

Initial categories are `general_assistance`, `communication_support`, and `other`. Notes are optional and bounded. They are not interpreted as medical data or priority instructions.

## Conversation and safety policy

The assistant conversation follows:

```text
idle -> listening -> processing -> responding -> listening
                    \-> clarification_required
active -> closed | unavailable
```

Two unsuccessful clarifications produce recognizable choices or a staff-help path. Explicit requests for a person bypass diagnostic questioning. Stopping speech stops playback only; it does not withdraw an accepted request.

The fixed assistant instructions require concise replies, no medical advice, no unsupported capability claims, and immediate staff-help routing when a resident reports a fall, injury, or feeling unwell. Facility profile text cannot override those rules.

The capability registry reports assistant, family-call, staff-assistance, and robot capability states separately. Robot physical capabilities are absent from the customer tool registry rather than hidden by UI state.

## Files and boundaries

The implementation plan will extend existing boundaries instead of replacing them:

- `apps/api/src/db/schema.ts` and a new Drizzle migration own durable assistance/profile/session data.
- `apps/api/src/services/access.ts`, a focused assistance service, and the existing transition/audit/event services own authorization and state.
- `apps/api/src/routes/device.ts`, a focused assistance/assistant route module, and `apps/api/src/routes/tools.ts` expose authenticated APIs.
- `apps/api/src/tools/builtin.ts` and the existing tool registry expose only the allowlisted assistant operations.
- `apps/api/src/services/voice.ts` owns the provider interface, fake adapter, Realtime SDP exchange, live-session binding, and tool relay.
- `apps/resident/src` adds the assistant panel and keeps Help, family-call, and privacy controls visible.
- `apps/staff/src` adds the assistance queue using the existing staff authorization and audit presentation.
- `packages/web-common` adds typed API helpers and shared assistant copy only where existing shared patterns require it.
- Tests cover unauthorized scope, idempotency, invalid transitions, provider failure, assignment changes, no-transcript behavior, and customer-boundary rejection of physical tools.

The separate `oncare_communicate` checkout remains unchanged and is treated as the behavioral reference during porting. Its uncommitted visual edits are not copied blindly; the resident UI is adapted to the main app's existing React kiosk surface.

## Acceptance gates

The integration is ready to push only when:

1. The existing `oncare_app` test suite and typecheck pass.
2. New API tests prove cross-facility and cross-resident denial, idempotent creation, duplicate dispatch safety, withdrawal races, invalid staff transitions, assignment revocation, and provider-unavailable fallback.
3. Resident tests prove Help and family calling remain touch-usable and voice is not required.
4. Staff tests prove only assigned staff can acknowledge or resolve requests.
5. The customer-boundary test proves no assistant route can invoke a physical robot operation.
6. The OpenAI path is labelled deployment-gated unless a real provider run is explicitly configured and tested.
7. Git status and diff are reviewed, then the branch is pushed to `origin/integration/communication`.

## Known non-goals after this integration

This change will not claim HIPAA compliance, production staffing readiness, real resident-media approval, or autonomous caregiving. Live-provider credentials, facility routing, operational escalation, accessibility trials, and physical installation remain owner-controlled deployment gates.
