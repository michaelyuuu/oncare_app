# OnCare

OnCare is the AGI Carehouse demo platform: a family member requests a resident visit, the resident answers once on a kiosk, and a confirmed item request passes through deterministic parsing, policy checks, staff approval, and a tray-delivery state machine. The platform design is in [the approved spec](docs/superpowers/specs/2026-09-17-oncare-platform-design.md) and the original brief is [the handover](CLAUDE_HANDOVER_AGI_CAREHOUSE_IPAD_APP.md).

## Prerequisites and startup

- Node 24 and npm workspaces
- Python 3.12 for `robot_gateway`
- A LiveKit account is optional; without `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`, calls use the labelled fake provider and do not provide real media

```bash
npm install
python -m venv robot_gateway/.venv
robot_gateway/.venv/Scripts/python -m pip install -r robot_gateway/requirements.txt
npm run dev
```

The three apps are then available at `http://localhost:5174` (family), `http://localhost:5173` (resident kiosk), and `http://localhost:5175` (staff). Start the synthetic gateway separately from `robot_gateway/` with `ONCARE_ROBOT_TOKEN=robot-demo-token` and `ROBOT_ADAPTER=mock`; it must log `SIMULATED ROBOT`. Copy `apps/api/.env.example` to `apps/api/.env` when configuring a real LiveKit provider. Never commit real credentials.

## Synthetic demo credentials

`family` / `family-demo-pass`; `staff` / `staff-demo-pass`; staff PIN `2468`; device token `device-demo-token`; robot token `robot-demo-token`. All are seeded fixtures, not production credentials.

## Checks and benchmarks

```bash
npx vitest run
npx tsc -b
pytest -q robot_gateway
npm run demo:check
npm run bench:visit     # requires a running API and mock gateway; writes real dated evidence only
npm run e2e              # requires optional @playwright/test + Chromium; see e2e/README.md
```

The visit benchmark targets notification median under 3 seconds and at least 95% successful completions. The parser corpus currently measures 20/20 clear phrases and 21/21 ambiguous phrases clarified. No visit baseline CSV or browser report is committed: the local API/gateway load run, Playwright run, LiveKit rehearsal, and physical Jetson rehearsal remain measurements to perform in their intended environments.

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

The code enforces schema validation before task persistence, approved-item and approved-surface policy, explicit family confirmation and staff approval before dispatch, authenticated gateway/device roles, and staff STOP/safety-stopped transitions. The mock adapter simulates travel and labels every UI with `SIMULATED ROBOT`; it does not exercise motors, perception, grasping, tray sensors, or an arm. Browser speech is optional and deterministic keyword parsing remains the offline fallback. Native iPad signing, production auth, real ROS/arm manipulation, and unattended physical execution are out of scope for this demo build. Follow [the Jetson gateway setup](docs/jetson-gateway-setup.md) before any real-robot run.
