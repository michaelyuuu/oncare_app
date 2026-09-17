# OnCare Platform Design — Family-to-Robot Care, Two-Week Demo

Date: 2026-09-17
Status: approved section by section by the owner on 2026-09-17; written spec pending owner review.
Inputs: `CLAUDE_HANDOVER_AGI_CAREHOUSE_IPAD_APP.md`, `docs/takeover-report-2026-09-16.md`, read-only survey of `D:/ontaru/AGI carehouse/on_software_all` (robot software).

## 0. Decisions already made by the owner

| Decision | Value |
|---|---|
| Hardware | Full robot including mobile base is assembled. Robot software is the `michaelyuuu/on_software_all` umbrella repo (ROS 2 Jazzy, Nav2, teleop safety chain). |
| Demo mode | **Option A: real navigation, tray delivery, arms untouched.** Autonomous grasping is developed by a separate session in `on_software_all` and plugs in later through the `ManipulationAdapter` contract. |
| Video | LiveKit Cloud behind a `VideoProvider` adapter. |
| Intent parsing | **No AI key.** Deterministic keyword parser only, behind an `IntentParser` adapter so a model provider can be added in one file later. |
| Resident iPad | Kiosk web app in Safari Guided Access. Native SwiftUI deferred (no Mac available). |
| Language | English first; all UI strings behind i18n keys so Chinese and Japanese can follow. |
| Demo audience | Care-facility staff trying the system. Resident usability and the staff console rank above manipulation. |
| Repos | This session writes only `oncare_app`. `on_software_all` is read-only for this session. |

## 1. System boundary and data flow

```
Family web (apps/family) ─────┐
Staff console (apps/staff) ───┼── HTTPS/WSS ──> Cloud API (apps/api) ──WSS (outbound from robot)──> Robot Gateway (robot_gateway/, Jetson)
Resident kiosk (apps/resident)┘                    │                                                │ HTTP 127.0.0.1 only
                                                   │                                                ├─ nav_web :5804   /goal /cancel /resume /state /map.bin /lift
        LiveKit Cloud <── each web client joins a room with a short-lived token                    ├─ health_web :5808 /health.json
                                                   │                                                └─ ManipulationAdapter (tray | mock | future real grasp)
                                              SQLite (Drizzle)
```

Four architectural rules (handover section 5):

1. **Two separately authorized paths.** Video goes through LiveKit with per-identity tokens. Robot commands go API → Gateway over one authenticated WebSocket. Neither path can reach the other.
2. **Cloud sends only high-level intents**: `request_visit`, `go_to_location`, `deliver_item`, `cancel`, `stop`. The Gateway validates, expires, and translates them into `nav_web` HTTP calls. Family clients never see ROS topics, ports, motors, or joints.
3. **The Gateway dials out.** It holds a per-robot token and opens the WebSocket to the API. The Jetson exposes no inbound port to the internet. The robot's ten unauthenticated LAN HTTP servers stay LAN-only; the Gateway is the only trust boundary.
4. **Defined safe state on network loss.** The Gateway polls `nav_web /state` and `health.json` every second and reports a heartbeat. The API distinguishes `cloud_online` from `robot_ready`. If the WebSocket is down for more than 10 seconds, the Gateway calls `POST /cancel` (which latches the robot's soft e-stop) and marks any active task `safety_stopped`.

### Repository layout

```
oncare_app/
  packages/core/        DONE: visit + task state machines, TaskProposal schema, policy. TODO: audit event model, keyword parser
  packages/contracts/   Gateway <-> API message schemas (zod); emits JSON Schema for the Python side
  apps/api/             Fastify, REST + two WebSockets (/events, /gateway), SQLite via Drizzle, LiveKit token issuing
  apps/resident/        React + Vite kiosk for iPad Safari Guided Access
  apps/family/          React + Vite responsive web app
  apps/staff/           React + Vite, single page
  robot_gateway/        Python 3.12, pytest; MockRobotAdapter / NavWebAdapter; ManipulationAdapter interface
  docs/                 specs, contracts, kiosk setup, benchmark results
```

### Tray delivery mapped onto the task state machine

The handover's physical-task states are kept unchanged. In tray mode the manipulation states are driven by staff actions instead of arm motion, and every event carries `mode: "tray"`.

| State(s) | Driven by | Physical reality |
|---|---|---|
| `queued` → `navigating_to_pickup` | Gateway → `nav_web POST /goal` | Robot drives to the pickup station (nurse station) |
| `locating_item` → `grasping` → `verifying_grasp` | **Staff presses "Loaded on tray"** in the staff console | Arms stay in rest pose. No arm command is ever issued |
| `navigating_to_delivery` | Gateway → `POST /goal` | Robot drives to the resident's room |
| `placing` → `verifying_delivery` | Resident taps "I have it" on the iPad, or staff presses "Received" | Item taken off the tray |
| `completed` | Gateway reports arrival at standby | Audit written; robot returns to standby |

When the grasp pipeline matures, the three middle states switch from staff buttons to `ManipulationAdapter` events. Neither the API nor the web clients change.

## 2. Data model, API, realtime

### Data model (SQLite via Drizzle; synthetic demo data only)

| Table | Key fields | Notes |
|---|---|---|
| `facility` | id, name, timezone | one for the demo |
| `resident` | id, facility_id, display_name, room_location_id, availability (`available` / `in_activity` / `resting` / `not_available`) | no medical data |
| `user` | id, role (`family` / `staff`), display_name, password_hash, pin_hash (staff only) | dev-grade auth |
| `family_relationship` | user_id, resident_id, label, consent_video, consent_robot_visit, consent_item_delivery | three consent switches |
| `robot` | id, facility_id, name, token_hash | one robot |
| `robot_device` | robot_id, kind (`ipad`), device_token_hash | the iPad authenticates as a device, not a person |
| `location` | id, facility_id, name, kind (`resident_room` / `pickup_station` / `standby`), x, y, yaw, approved | the named-location table the robot stack lacks |
| `item` | id, label, approved, prohibited | mirrors `DEMO_CATALOGUE` in core |
| `visit_session` | id, resident_id, requester_id, robot_id, state, livekit_room, requested_at, connected_at, ended_at | state ∈ `VisitState` |
| `task_request` | id, visit_id?, requester_id, resident_id, proposal (JSON), state, mode (`tray` / `manipulation` / `mock`), correlation_id | state ∈ `TaskState` |
| `task_approval` | task_id, actor_id, decision, reason, at | one row for family confirmation, one for staff approval |
| `robot_command` | id, robot_id, task_id?, visit_id?, intent (JSON), issued_at, expires_at, acked_at, result | one row per intent; `id` is the idempotency key |
| `audit_event` | id, at, actor_type, actor_id, entity_type, entity_id, from_state, to_state, reason, correlation_id | written on every transition, approval, denial, stop |
| `benchmark_run`, `benchmark_trial` | latency and outcome measurements | handover section 11 |

Not stored: video, audio, transcripts. Deferred (YAGNI for the demo): `media_asset`, `notification`, photos, voice messages.

### API (Fastify)

Authentication: three identities, three token types.
- Family and staff: username + password → JWT (dev grade; documented as not production auth).
- Resident iPad: device token → JWT with `role=device`.
- Gateway: robot token, presented on the `/gateway` WebSocket handshake.
Every route checks role and relationship: a family user can only read or act on residents they have a `family_relationship` with.

| Audience | Routes |
|---|---|
| Family | `GET /me/residents`, `POST /visits`, `GET /visits/:id`, `POST /tasks` (text in; returns a proposal or a clarification), `POST /tasks/:id/confirm`, `POST /tasks/:id/cancel` |
| Resident device | `GET /device/state` (which screen to show), `POST /visits/:id/answer`, `POST /visits/:id/decline`, `POST /tasks/:id/received`, `POST /device/call-caregiver`, `POST /device/unlock` (staff PIN) |
| Staff | `GET /queue`, `POST /visits/:id/approve|deny`, `POST /tasks/:id/approve|deny|loaded|stop`, `POST /robots/:id/stop`, `POST /robots/:id/resume` (PIN), `POST /robots/:id/standby`, `GET /audit`, `PATCH /residents/:id/availability`, `GET /benchmark.csv` |
| Video | `POST /visits/:id/token` issues a LiveKit token for the caller's identity: family publish+subscribe, device publish+subscribe, staff subscribe only |
| Gateway | WebSocket `/gateway` only. Down: `intent` (with `expires_at`, `correlation_id`), `cancel`, `stop`, `locations` (approved location table). Up: `heartbeat` (1 Hz), `ack`, `state_event`. Message shapes live in `packages/contracts`. |

### Realtime to web clients

One WebSocket `/events`, JWT-authenticated, server-side filtered: family users receive events for their own visits and tasks; the device receives events for its resident; staff receive everything. The payload is the `audit_event` row. Clients switch screens on `to_state`; there is no second event vocabulary.

### Single writer for state

`visit_session.state` and `task_request.state` are written only by the API through one function, `applyTransition()`, which calls `transitionVisit` / `transitionTask` from `packages/core`, writes the `audit_event` in the same transaction, and broadcasts it. An illegal transition writes an audit row with reason `rejected_transition` and returns HTTP 409. The Gateway reports events; it never declares a state. "Zero physical executions without explicit confirmation" is therefore enforced and tested in one place: no `intent` of type `deliver_item` is issued unless `task_request.state` is `queued`, which is reachable only through `awaiting_user_confirmation` and `awaiting_policy_or_staff`.

## 3. Robot Gateway

### Role
The only internet-facing component on the robot. Receives intents, validates, translates, executes, reports, and brings the robot to a safe state on any anomaly.

### Structure

```
robot_gateway/
  gateway/
    main.py            load config, connect WebSocket, run heartbeat + intent loops
    contracts.py       validate every message against the JSON Schema emitted by packages/contracts
    intents.py         handlers: request_visit, go_to_location, deliver_item, cancel, stop
    robot/
      base.py          RobotAdapter protocol: goto(location_id), cancel(), resume(), state(), health(), lift_rest()
      navweb.py        real robot: nav_web :5804 and health_web :5808 over HTTP on 127.0.0.1
      mock.py          simulated robot: configurable travel time, injectable navigation_failed / stuck / estop
    manipulation/
      base.py          ManipulationAdapter protocol (identical to docs/handover-grasp-pipeline-session.md section 3)
      tray.py          tray mode: waits for staff_loaded / received events, never commands an arm
      mock.py          simulated grasp with fixed delays and injectable failures
    safety.py          expiry, heartbeat timeout, disconnect → safe stop
    heartbeat.py       also emits to the robot's own health page via robot/mobile/common/heartbeat.py Emitter
  tests/               pytest; `-m 'not hardware'` runs without a robot
  config.example.toml  API URL, robot token placeholder, location cache path; no real data
```

### Intent translation

| Intent | Gateway behaviour |
|---|---|
| `request_visit {resident_location}` | `POST /goal` to the resident's room → report `robot_en_route` → on Nav2 success report `arrived` (API maps it to `awaiting_resident_consent`) |
| `go_to_location {location}` | as above; used for "return to standby" |
| `deliver_item {pickup, destination, mode: tray}` | `/goal` pickup station → report `arrived_pickup` → wait for API `staff_loaded` → `/goal` resident room → report `arrived_delivery` → wait for `received` → `/goal` standby → report `completed_leg` |
| `cancel {correlation_id}` | `POST /cancel` (latches soft e-stop) → `POST /resume` → report `cancelled` |
| `stop` | `POST /cancel`, **no** resume, report `safety_stopped`; only a staff `resume` with PIN releases it |

Locations arrive from the API (`location` table). The Gateway accepts only IDs with `approved = true` and never raw coordinates. Before `POST /goal` it fetches `/map.bin` and checks the target cell is inside the map and not occupied. `nav_web` performs the same check (`check_goal_cell`); the Gateway check is a deliberate second layer.

Evidence for the integration points (from the read-only survey of `on_software_all`):
- `POST :5804/goal {x,y,yaw,via?}` → `robot/mobile/web/nav_web.py:1624` → `send_goal_route` (`:1144`) → Nav2 `NavigateToPose` in the `map` frame. Refused while soft-e-stopped (`:1166`).
- `POST :5804/cancel` → `stop_all` (`nav_web.py:1307`) latches `/soft_estop` before cancelling the goal. `POST /resume` → `resume` (`:1322`).
- `GET :5804/state` → `state_json` (`nav_web.py:1492`): pose, nav state, goal, e-stop, lift, base_server status.
- `GET :5804/map.bin` → `map_blob` (`nav_web.py:1526`): gzip occupancy grid with a 7-float header.
- `POST :5804/lift {cmd:"preset", slot:"rest"}` → `LiftControl.request` (`nav_web.py:263`).
- `GET :5808/health.json` → `health_web.py:2437`, served by systemd from boot.
- Heartbeat bus: `robot/mobile/common/heartbeat.py` `Emitter(name).emit(**fields)`, UDP to 127.0.0.1:5808.
- No named locations exist anywhere in the robot stack; the Gateway owns that table.
- `nav_web` speed ceilings (`MAX_LIN_VEL = 0.5` m/s, `constants.py:147`) and the `cmd_vel_bridge` deadman remain in force under the Gateway; it adds no new control path.

### Safety rules (each has a test)

1. Every intent carries `expires_at`; an expired intent is rejected and reported as `expired`.
2. A re-sent `correlation_id` is acked but not re-executed (idempotent).
3. One intent executes at a time; a new intent while busy is answered `busy`.
4. WebSocket down for more than 10 s, or three consecutive heartbeats without an ack: call `/cancel`, set local state `safety_stopped`, and on reconnect report before accepting anything new.
5. If `health.json` or `/state` shows Nav2 not running, `base_server` down, or e-stop latched, the heartbeat reports `robot_ready = false` and the API issues no intents.
6. The Gateway never calls `/joy` (manual velocity), never calls `console_web` (:5810), never touches any arm port. Those code paths do not exist in the Gateway.
7. The lift is only ever commanded to `preset rest`, and only while stationary at standby.

### Heartbeat (1 Hz)
`robot_ready`, `pose`, `nav_state`, `estop`, `lift`, `battery` (reported as `unknown` when `health.json` has no value; never guessed), `active_correlation_id`, `gateway_version`.

### MockRobotAdapter
Selected with `ROBOT_ADAPTER=mock`. Used for all development on the Windows machine and in CI. Simulates travel time and supports failure injection. Every web client shows a prominent "SIMULATED ROBOT" badge whenever the heartbeat reports `adapter = mock`.

## 4. Web clients, video, intent parsing

### Resident iPad kiosk (`apps/resident`)

Five screens, one primary action each:

| Screen | Content | Primary action |
|---|---|---|
| `home` | large time, greeting, family photo wall | none (idle) |
| `incoming` | caller's large photo and name | green "Answer"; small grey "Not now" |
| `in_call` | remote video full screen, subtitle band, volume +/−, camera/mic status | "End" |
| `delivery_arrived` | "Your water bottle is here" | "I have it" |
| `caregiver_called` | "A caregiver has been notified" | auto-return to `home` |

Rules:
- Screen is chosen by the API (`/device/state` plus `/events`); the client never infers state. Any error, or 90 s of inactivity, returns to `home`.
- Incoming call is spoken with the browser's `SpeechSynthesis` ("Your daughter Amy is calling"); replaceable by recorded audio later.
- Camera and microphone state are always shown as icon plus text ("Camera on"). While a family member is connected the screen shows "Amy is on the call".
- Staff PIN entry: press and hold the bottom-left logo for 3 s to reveal a numeric keypad. No other gesture, long-press, or multi-touch anywhere.
- Typography: minimum 32 px, primary buttons at least 120 px tall, WCAG AA contrast, no pure-black backgrounds.
- Kiosk lock via iOS Guided Access; setup steps in `docs/ipad-kiosk-setup.md`.

### Family web app (`apps/family`)

Login → resident card (photo, availability, last call) → "Start a video visit" / "Send the robot to visit" → in-call screen with "Ask the robot for help" → type or hold-to-talk → structured confirmation card ("Send the robot with the **water bottle** to **Mom's bedside table**?" with Confirm / Cancel) → task progress bar (one segment per state; failures in red with the reason and "Staff have been notified").

- Speech uses the browser Web Speech API. No audio is sent to our servers.
- No robot control UI of any kind.

### Staff console (`apps/staff`)

Single page, three columns plus a footer:
- **Pending**: visit approvals, task approvals, and staff actions ("Load item on tray").
- **Robot**: location, battery, `robot_ready`, current task, large red **STOP** (issues `stop`; never auto-resumes), "Return to standby", "Release stop" (requires PIN re-entry).
- **Streaming now**: every robot currently sending audio/video and to whom, each with "End call" and "Pause camera".
- **Audit log** footer table, filterable by resident and time, with "Export CSV".

### Video

LiveKit Cloud. Room name = visit id. Each identity fetches its own short-lived token from the API. The `VideoProvider` interface has `createRoom`, `issueToken`, `closeRoom`; tests use an in-memory fake. Reconnection is handled by the LiveKit SDK; if a participant is gone for more than 10 s the API moves the visit to `connection_failed` and the iPad returns to `home`. When a visit enters `ending`, the API closes the room through the LiveKit server API.

### Intent parsing

`packages/core/src/parser/keyword.ts` implements `IntentParser`: `parse(text, ctx) → { kind: "proposal", proposal } | { kind: "clarification", question, options }`.
- Item synonym table (e.g. "water", "water bottle", "水瓶" → `water_bottle`).
- Destination defaults to the approved surface in the target resident's room.
- No item, or more than one candidate item, returns a clarification with suggested options.
- No network calls. The interface leaves room for a model-backed parser, but none is planned now.

## 5. Audit, benchmark, testing, schedule

### Audit
All transitions go through `applyTransition()`, which writes the `audit_event` in the same transaction. Logs contain IDs only: no names, room numbers, or utterance text.

### Benchmark logging
The API records a `benchmark_run` per visit and per task: request-to-iPad-incoming latency, number of resident actions to answer, call connect success/failure, per-state timestamps for tasks, Gateway ack latency. Staff console exports CSV. Targets are the handover's section 11 values: one resident action, notification under 3 s, call connect at least 95%, recoverable loss handled within 10 s, zero physical executions without confirmation.

### Test layers

| Layer | Tool | Covers |
|---|---|---|
| core | vitest | state machines, schema, policy, parser (40 tests exist) |
| contracts | vitest + Python `jsonschema` | the same schema validates on both sides |
| api | vitest with in-memory SQLite | permissions (cross-resident 403), illegal transitions 409, no intent without confirmation, disconnect → safe state |
| gateway | pytest | expiry, idempotency, busy, heartbeat timeout, full mock run |
| end-to-end | Playwright against the mock robot | the handover section 8 demo story |

### Schedule (14 days, one critical path)

| Days | Milestone |
|---|---|
| 1–2 | core: audit model + keyword parser; `packages/contracts`; API skeleton, SQLite, seed data, auth |
| 3–4 | visit flow API + `/events`; Gateway mock + heartbeat + `request_visit` |
| 5–6 | resident kiosk five screens; family login → request visit → iPad incoming → answer |
| 7–8 | LiveKit wired, real call, disconnect handling |
| 9–10 | task flow: parse → confirm → staff approve → tray mode → progress → complete; staff console |
| 11–12 | Gateway `NavWebAdapter` on the Jetson against real `nav_web`; location table; stop/resume |
| 13–14 | three full rehearsals on the real robot, benchmark export, iPad setup doc, fixes |

Owner inputs needed: LiveKit Cloud API key and secret by day 7; SSH access to the Jetson and the map coordinates of three locations (resident room, pickup station, standby) by day 11.

## 6. Out of scope for this spec
Autonomous grasping (separate session, `docs/handover-grasp-pipeline-session.md`), photos and voice messages, notifications, operator console, EHR, multi-robot, multi-facility, production authentication, HIPAA claims, App Store release.
