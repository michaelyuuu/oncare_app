# Hand-off: resume from Plan 3

Written 2026-09-17 by the session that executed Plans 1–2. Read this, then the memory files and ledgers it points to, before dispatching anything.

## Where things stand

- Branch `plan-1-foundation` (off `master`), single branch for the whole demo build. Not merged; merge decision deferred to the end of Plan 7.
- **Plan 1 complete** (core, contracts, API foundation). **Plan 2 complete** (visit flow, hub + dispatch, `/gateway` and `/events` WebSockets, Python gateway core + runner, e2e) including its final-review fix wave. HEAD is the last commit of that fix wave — see `git log`.
- Test baseline at hand-off: `npx vitest run` and `npx tsc -b` green from the repo root; `cd robot_gateway && .venv/Scripts/python -m pytest -m "not hardware" -q` green. Exact counts are in `git log` commit messages and the ledger.
- Plans 3–7 are written in `docs/superpowers/plans/` and were patched as Plans 1–2 landed (start_goto signature, atomic `patch`, stop/resume routes, stale-flush guard). Read a plan's header and Global Constraints before extracting briefs.
- The owner verified Plan 1 and Plan 2 by hand (login, `/me/residents`, visit creation, mock robot driving a visit to `awaiting_resident_consent`). Their API dev server may still be running on port 3000; do not kill processes you did not start.

## How to resume (subagent-driven development, all the way to Plan 7)

1. Load the `superpowers:subagent-driven-development` skill. Scripts live in its `scripts/` folder: `sdd-workspace PLAN`, `task-brief PLAN N`, `review-package PLAN BASE HEAD`.
2. Workspace for Plan 3 already exists: `.superpowers/sdd/2026-09-17-plan-3-resident-kiosk-and-family-app/` with `task-1..5-brief.md` and `progress.md` (pre-flight scan done, no conflicts). It is git-ignored; if it is missing (different machine), re-run `sdd-workspace` and `task-brief`, and copy the pre-flight table from the "Plan 3 pre-flight" section below.
3. Per task: record BASE (`git rev-parse --short HEAD`); dispatch ONE implementer (fresh subagent, brief path + report path + only the context it needs; never the whole plan); on DONE build `review-package PLAN BASE HEAD` and dispatch a task reviewer; fix loop (rounds 1–3 resume the same implementer, 4–5 a fresh one on a stronger model, scoped re-review each round); ledger every step; never fix code yourself in the controller session.
4. After the last task of a plan: build a code-only whole-branch diff (exclude `package-lock.json` and `docs/`), dispatch the final reviewer on the strongest model with the ledger's parked/deferred list, ONE fix wave, ONE scoped re-review, adjudicate residuals, close the workspace, then start the next plan.
5. Model choice that worked: haiku for transcription tasks whose brief contains the full code; sonnet for multi-file tasks and reviews; opus for final reviews and fix waves.
6. UI tasks (Plan 3 Tasks 3–4, Plan 4 Tasks 3–4, Plan 5 Tasks 5 and 7) must load the `frontend-design` skill before writing JSX/CSS.
7. Commit trailer, verbatim on every commit (subagents sometimes substitute their own model name; accepted, do not rewrite history):
   ```
   Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
   Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC
   ```
   (A new session may use its own session URL.)
8. While subagents run, draft or patch later plans; the owner asked for that explicitly.

## Owner facts and preferences

- Owner writes Chinese (Traditional); answer in Chinese when they do. Runs commands in PowerShell — give `Invoke-RestMethod` forms, not bash `curl`, and remind them to `cd` into the repo first.
- Decisions: full robot exists; robot code is the separate repo `on_software_all` (read-only for us); LiveKit Cloud for video (credentials in `apps/api/.env`, git-ignored); NO AI/LLM key (keyword parser only); resident iPad = kiosk web app; English UI first; demo audience = care-facility staff.
- A separate session owns the grasp pipeline in `on_software_all` (`docs/handover-grasp-pipeline-session.md`); the `ManipulationAdapter` contract there is the seam. Do not touch that repo.

## Machine notes

- Windows 11, Git Bash for the Bash tool. Quote paths (the folder has a space). Bash heredocs with `<<'EOF'` sometimes fail on this machine for larger bodies; use the Write tool for files.
- Node 24 / npm 11; `better-sqlite3@12` installs with a prebuilt binary. `npm install` may `ECONNRESET` once; re-run.
- Python 3.12.7 venv at `robot_gateway/.venv` (websockets 17, jsonschema 4.26, pytest, pytest-asyncio, hatchling); the package is installed editable.
- `ws` drops `message`/`close` events emitted before a listener is attached: the `/gateway` route pauses the socket during scrypt verification and the tests use a FIFO `nextMessage` helper. Reuse both patterns for any new WebSocket code.
- Subagents occasionally die on API rate limits (HTTP 429) mid-task; check `git status` for uncommitted work and resume the same agent from the working tree.

## Rulings made so far (all reversible; each ledger line has the cost-if-wrong)

Plan 1: single branch, no worktree; accepted "Claude Haiku 4.5" co-author trailers; `resume` message added in Plan 1 not Plan 2; zod `invalid_union` verbosity parked; snake_case `REASON_CODE` enforced in core; atomic `patch` option on transitions; weak rollback test parked then strengthened in Plan 2 Task 1; merge deferred to the end.
Plan 2: `create()` not wrapped in one transaction (parked); multi-step `end` as two transactions (parked; `end` from `ending` now resumable); ack row update outside the transition transaction (parked); unknown-correlation robot messages — first ruled silent, then the final fix wave writes an audit row; robot token in the WS query string (brief-mandated, parked); `RobotAdapter.start_goto(location, now_ms)` signature; `wall_ms` injectable clock separate from the monotonic tick clock; heartbeat-ack contract (spec rule "three heartbeats without ack") deferred as a design note for Plan 5.

Parked hardening items for the final pass (see the two ledgers): non-atomic create; scrypt per robot row per connection; token in query string; `asyncio` deprecations; permanently bad `api_url` retries forever.

## Plan 3 pre-flight (copy if the workspace is gone)

| Pair / task | Finding |
|---|---|
| Plan 1 F4 → T1 | reasons `call_caregiver` / `device_unlock` / `device_unlock_failed` are snake_case — consistent |
| Plan 1 audit → T1 | T1 widens `TransitionEventInput.fromState/toState` to `string \| null` (core AuditEvent already nullable) |
| T1 → T3 | `DeviceState` shape consistent with `apps/resident/src/screen.ts` |
| Plan 2 hub → T1 | robot block from `app.hub.status(robotId).lastHeartbeat.adapter` |
| T2 root vitest | switch to `projects` (node vs jsdom); keep api/core/contracts in node; run the full suite to prove it |
| T2 → T3/T4 | `createApi`/`connectEvents`/`t` signatures; all i18n keys listed in T2 |
| T4 → API | `visit.simulated` computed in `GET /visits/:id`; T4 adds it + a test |
| T5 | docs + `demo-check` script only |

Note for Plan 3 Task 1: `GET /robots/:id/status` now lives in `apps/api/src/routes/robots.ts` (moved in Plan 2's fix wave), together with `POST /robots/:id/stop` and `/resume`.

## What the owner can verify today (already confirmed working)

API on :3000, mock gateway (`ONCARE_ROBOT_TOKEN=robot-demo-token`, `.venv\Scripts\python -m gateway` from `robot_gateway/`), then: family login → `POST /visits` → `accepted` → within ~2 s `awaiting_resident_consent` → device `answer` → `connecting` → family `connected` → `active` → `end` → `completed`; staff `GET /robots/robot_demo_01/status` shows the mock heartbeat; the audit trail for the visit lists the eight states with the two robot steps attributed to `robot:robot_demo_01`.
