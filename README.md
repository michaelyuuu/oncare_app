# OnCare

OnCare is the AGI Carehouse demo platform: a family member requests a resident visit, the resident answers once on a kiosk, and a confirmed item request passes through deterministic parsing, policy checks, staff approval, and a tray-delivery state machine. The platform design is in [the approved spec](docs/superpowers/specs/2026-09-17-oncare-platform-design.md) and the original brief is [the handover](CLAUDE_HANDOVER_AGI_CAREHOUSE_IPAD_APP.md).

## Prerequisites and startup

- Node 24 and npm workspaces
- Python 3.12 for `robot_gateway`
- A LiveKit account is optional; without `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`, calls use the labelled fake provider and do not provide real media

```bash
npm install
python -m venv robot_gateway/.venv
robot_gateway/.venv/Scripts/python -m pip install -e "robot_gateway[dev]"
npm run dev
```

The three apps are then available at `http://localhost:5174` (family), `http://localhost:5173` (resident kiosk), and `http://localhost:5175` (staff). Start the synthetic gateway separately from `robot_gateway/` with `ONCARE_ROBOT_TOKEN=robot-demo-token` and `ROBOT_ADAPTER=mock`; it must log `SIMULATED ROBOT`. Copy `apps/api/.env.example` to `apps/api/.env` when configuring a real LiveKit provider. Never commit real credentials.

The resident kiosk includes a touch-first **Talk to Ontaru** assistant. With no `OPENAI_API_KEY`, its text fallback is deterministic and uses only the server's allowlisted communication tools: approved contacts, staff assistance, request status, withdrawal, and service status. `OPENAI_API_KEY` enables the optional server-side OpenAI Realtime/WebRTC adapter; the key is read only by the API and is never accepted from or returned to the browser. `ONCARE_REALTIME_MODEL` and `ONCARE_REALTIME_ENDPOINT` select the provider configuration. Set `ONCARE_ASSISTANT_PROFILE` to a bounded JSON profile when facility-specific wording is required; an invalid configured profile stops startup rather than weakening the fixed safety rules. The capability endpoint reports fake/live voice, family-call, staff-assistance, and robot states separately. Robot movement, navigation, manipulation, shell, ROS, and actuator operations are not assistant capabilities.

## Synthetic demo credentials

`family` / `family-demo-pass`; `staff` / `staff-demo-pass`; `admin` / `admin-demo-pass` (facility manager: opens the **Facility admin** tab in the staff console); staff and admin PIN `2468`; device token `device-demo-token`; robot token `robot-demo-token`. All are seeded fixtures, not production credentials.

## Checks and benchmarks

```bash
npx vitest run
npx tsc -b
robot_gateway/.venv/Scripts/python -m pytest -q robot_gateway
npm run demo:check
npm run bench:visit     # requires a running API and mock gateway; writes real dated evidence only
npm run e2e              # requires optional @playwright/test + Chromium; see e2e/README.md
```

The visit benchmark targets notification median under 3 seconds and at least 95% successful completions. The parser corpus currently measures 20/20 clear phrases and 21/21 ambiguous phrases clarified. On 2026-09-18 the Jetson with the mock gateway measured a 2207 ms notification median over 20/20 completed visits ([summary](docs/benchmarks/visit-2026-09-18.summary.json); roughly 2000 ms of that is the simulated travel time), and the Playwright demo story passed with the fake video provider. The LiveKit rehearsal and physical Jetson rehearsal remain measurements to perform in their intended environments.

## Repository map

- `packages/core` — state machines, validated task intent, deterministic parser, policy, and audit events
- `packages/contracts` — gateway protocol schemas and generated JSON Schema
- `packages/web-common` — API, realtime, i18n, and LiveKit client wrappers shared by the apps
- `apps/api` — Fastify API, SQLite/Drizzle persistence, authentication, transitions, gateway hub, tasks, visits, and benchmark CSV
- `apps/resident` — resident iPad kiosk with one-tap visit actions, call screen, PIN settings, and delivery receipt
- `apps/family` — responsive family login, visit progress, call panel, and item request confirmation
- `apps/staff` — approvals, tray loading, stop controls, camera controls, robot health, locations, streaming, and audit
- `robot_gateway` — Python mock gateway and opt-in Jetson `nav_web` adapter
- `docs` — setup, demo flow, benchmark corpus, Jetson runbook, plans, and status

## Safety and scope

The code enforces schema validation before task persistence, approved-item and approved-surface policy, explicit family confirmation and staff approval before dispatch, authenticated gateway/device roles, and staff STOP/safety-stopped transitions. Demo credentials are seeded only outside `NODE_ENV=production`; set `ONCARE_SEED_DEMO=0` to disable them in another environment. The mock adapter simulates travel and labels every UI with `SIMULATED ROBOT`; it does not exercise motors, perception, grasping, tray sensors, or an arm. Browser speech is optional and deterministic keyword parsing remains the offline fallback. Native iPad signing, production auth, real ROS/arm manipulation, and unattended physical execution are out of scope for this demo build. Follow [the Jetson gateway setup](docs/jetson-gateway-setup.md) before any real-robot run.
