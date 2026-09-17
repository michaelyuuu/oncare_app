# Takeover Report — AGI Carehouse Family-to-Robot App

Date: 2026-09-16
Source of truth: `CLAUDE_HANDOVER_AGI_CAREHOUSE_IPAD_APP.md` (the only file in the repository at takeover).

## 1. Executive summary

The repository contains no code. It holds one file: the handover prompt. There is no git history, no README, no package manifest, no ROS package, no schema, no tests, and no environment example. No related application code exists elsewhere under `D:\ontaru` (the sibling projects are laundry folding, scopec, and skyscope, all unrelated). Every item in the handover's "must be real" list is therefore missing rather than mocked, and nothing can be demonstrated today without new code. The development machine is Windows 11 with Node 24, npm 11, Python 3.12, and git installed; Docker, pnpm, Flutter, and Xcode are absent, which rules out a native SwiftUI resident app and local container-based infrastructure for the two-week window. Hardware status (base, arms, Jetson, D435, D405s) is unknown from the repository and must be confirmed by the owner. The narrowest achievable slice is: family web client requests a visit, resident kiosk web app answers with one tap, a WebRTC call runs through a provider adapter, a spoken or typed request becomes a schema-validated task proposal, the family member confirms, and a clearly labelled mock robot gateway walks the task through the physical-task state machine with audit events. The first milestone should be a pure domain package (state machines, intent schema, policy checks, audit events) with tests, because every client and the gateway depend on that contract and it needs no credentials or hardware.

## 2. Current system map

Nothing exists. The handover's target boundary is adopted unchanged:

```
Family web client ─────┐
Staff console ─────────┼─> API + realtime signaling + task service ─> Secure Robot Gateway ─> ROS 2 (mock first)
Resident iPad kiosk ───┘
```

Proposed concrete stack (subject to owner approval, see section 7):

| Layer | Choice | Reason |
|---|---|---|
| Monorepo | npm workspaces, TypeScript | npm is installed; pnpm is not. One toolchain for three web clients and the API. |
| `packages/core` | Pure TS domain: state machines, zod schemas, policy, audit event types | Testable without I/O; generates JSON Schema for the Python gateway. |
| `apps/api` | Node + Fastify, WebSocket for realtime, SQLite via Drizzle | No Docker, so no local Postgres. Drizzle keeps a Postgres migration path. |
| `apps/resident` | React + Vite kiosk web app, run in Safari Guided Access on the iPad | Handover permits a kiosk web prototype if documented; no Mac available for SwiftUI. |
| `apps/family` | React + Vite responsive web app | Handover prefers responsive web over native. |
| `apps/staff` | React + Vite, minimal | Approvals, active streams, stop task, audit view. |
| `robot_gateway/` | Python 3.12 process, `MockRobotAdapter` now, `Ros2Adapter` stub | The real gateway runs on the Jetson beside ROS 2, so Python from day one. Same task contract for mock and hardware. |
| Video | `VideoProvider` adapter; LiveKit Cloud for the demo | Self-hosting needs Docker. Cloud SFU gives reliable iPad Safari support. |
| Speech | `SpeechProvider` adapter; browser Web Speech API first | Zero credentials for the demo; swappable for Whisper or Deepgram. |
| Intent parsing | `IntentParser` adapter; Claude API behind a strict zod schema, plus a deterministic keyword parser fallback | Handover requires schema validation and deterministic policy after parsing. Fallback keeps the demo working without an API key. |

## 3. Working vs mocked vs missing

| Area | Status |
|---|---|
| Resident iPad client | Missing |
| Family client | Missing |
| Staff console | Missing |
| Operator console | Missing (out of MVP per handover) |
| Backend / database schema | Missing |
| Authentication and family-resident relationships | Missing |
| Video calling | Missing |
| Realtime state updates | Missing |
| Speech-to-text / LLM parsing | Missing |
| Visit and task state machines | Missing |
| Robot gateway | Missing |
| ROS 2 packages, drivers, cameras, MoveIt or policies | Missing; hardware status unknown |
| Simulator | Missing |
| Audit log | Missing |
| Benchmark logging | Missing |
| Tests, CI, deployment | Missing |
| Git repository | Not initialized |

## 4. Risks and blockers (ranked by impact on the two-week demo)

1. **Hardware availability unknown.** If no arm, camera, or base is assembled and calibrated, "one real manipulation path" is impossible and the demo must use a labelled mock. This is the single biggest scope decision.
2. **Video provider credentials.** A WebRTC call on iPad Safari is the demo's spine. Without a provider account the call step cannot be real.
3. **No Mac.** A native SwiftUI resident app cannot be built or signed here. The kiosk web app is the only path in two weeks.
4. **LLM and STT credentials.** Without an Anthropic API key the parser falls back to keyword matching, which is acceptable for the demo but must be labelled.
5. **Jetson and ROS 2 access.** Even with hardware, the gateway needs network access to the Jetson and a ROS 2 distribution decision.
6. **Two weeks and four surfaces.** Scope creep into staff or operator features will starve the vertical slice.

## 5. Two-week plan (single critical path)

| Days | Milestone | Exit criterion |
|---|---|---|
| 1-2 | Git init, monorepo scaffold, `packages/core`: visit and task state machines, `TaskProposal` schema, policy checks, audit event model, tests | `npm test` passes, including invalid transitions and prohibited items |
| 3-4 | `apps/api`: SQLite schema, synthetic seed data, dev auth, visit/task endpoints, WebSocket realtime, gateway heartbeat, audit persistence | Visit request moves through states via API and is observable over WebSocket |
| 5-6 | `apps/resident` kiosk: home, incoming call, one-tap answer/decline, in-call, staff PIN, idle return; `apps/family`: login, resident card, availability, request visit, status | Resident answers a request in one action on iPad Safari |
| 7-8 | Video via `VideoProvider` adapter (LiveKit); connect and reconnect handling | Two-way call between family browser and iPad |
| 9-10 | Speech to `IntentParser` to schema validation to policy to confirmation to task; `robot_gateway` mock executes with failure injection; task progress UI | Confirmed water-bottle request runs to `completed` or a labelled failure state with audit trail |
| 11-12 | `apps/staff` minimal: approvals, streaming indicator, stop task; benchmark logging; latency measurements | Staff can stop a task; benchmark CSV written per run |
| 13-14 | Hardware adapter if hardware confirmed, otherwise mock hardening; demo rehearsal; docs | End-to-end demo script runs three times in a row |

## 6. Proposed benchmark

Manipulation (only if hardware is confirmed): the handover's 3 objects x 5 poses x 3 lighting conditions = 45 trials, one primary arm, other arm in safe pose, per-trial CSV with detection, first-attempt grasp, retry success, time, drops, contacts, intervention, failure category. Pass: detection at least 95%, first grasp at least 70%, success within one retry at least 85%, zero dangerous collisions, every unrecoverable failure ends in `operator_required` or `safety_stopped`.

App/realtime: 20 repeated visit requests on the test network. Pass: request-to-resident-notification under 3 s median, call connection at least 95%, resident answers with exactly one action, simulated network loss recovers within 10 s or fails to a safe state, zero physical executions without explicit confirmation, at least 90% of a 20-phrase ambiguous set triggers clarification rather than execution.

## 7. Questions requiring owner input

1. Is any robot hardware (base, arms, D435, D405s, Jetson) assembled, calibrated, and reachable on the network now? If not, the demo uses a labelled mock gateway.
2. May the demo use LiveKit Cloud (or Daily) for video, and is there an account? Otherwise the call is stubbed.
3. Is an Anthropic API key available for intent parsing, and is the browser Web Speech API acceptable for demo speech input?
4. Is a kiosk web app in Safari Guided Access acceptable for the resident iPad, given no Mac is available for SwiftUI?
5. Is English-only acceptable for the first pass, with localization keys in place for Chinese and Japanese?

## 8. Recommended first code change

Initialize git and create the npm workspace with `packages/core` only:

- `packages/core/src/visit-state.ts` — visit state machine with explicit transition table.
- `packages/core/src/task-state.ts` — physical task state machine with failure exits.
- `packages/core/src/intent.ts` — `TaskProposal` zod schema matching the handover JSON, `requires_confirmation` always true.
- `packages/core/src/policy.ts` — deterministic checks: prohibited item list, approved destinations, approved item catalogue.
- `packages/core/src/audit.ts` — audit event type with time, actor, reason, correlation ID.
- Tests for every invalid transition, every prohibited item, and confirmation enforcement.

No UI, no network, no credentials. Reversible, and every later milestone builds on it.
