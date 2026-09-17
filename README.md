# OnCare

OnCare is the prototype platform behind the AGI Carehouse demo: a family member opens a video
visit with a resident and, through a deterministic parse → policy → confirmation chain, can
ask a robot to fetch an approved item and place it on an approved surface. The robot never
receives free text or raw coordinates, only validated intents, and every state change is
written with its audit row in the same transaction. The design lives in
[docs/superpowers/specs/2026-09-17-oncare-platform-design.md](docs/superpowers/specs/2026-09-17-oncare-platform-design.md);
the original brief is [CLAUDE_HANDOVER_AGI_CAREHOUSE_IPAD_APP.md](CLAUDE_HANDOVER_AGI_CAREHOUSE_IPAD_APP.md).

## Prerequisites

- Node 24 (npm workspaces, ESM)
- Python 3.12 (robot gateway, later plans)

## Getting started

```bash
npm install
npm run dev -w @oncare/api      # http://localhost:3000, seeds ./oncare.db on boot
```

Copy `apps/api/.env.example` to `apps/api/.env` before running anything beyond the demo.

## Demo credentials (synthetic, seeded on first boot)

| Principal   | Credential                       |
| ----------- | -------------------------------- |
| family user | `family` / `family-demo-pass`    |
| staff user  | `staff` / `staff-demo-pass`      |
| staff PIN   | `2468`                           |
| iPad device | device token `device-demo-token` |
| robot       | robot token `robot-demo-token`   |

**Auth is dev-grade, not production auth.** The passwords above are fixtures, and the API
falls back to a dev-only JWT secret when `JWT_SECRET` is unset (in production it refuses to
start). See `apps/api/.env.example`; never commit a real `.env`.

## Checks

```bash
npx vitest run     # full test suite
npx tsc -b         # project-wide typecheck
```

Regenerate the gateway JSON Schema after any change to `packages/contracts/src/gateway.ts`
(a test fails if the emitted files drift):

```bash
npx tsx packages/contracts/scripts/emit-json-schema.ts
```

## Repo map

- `packages/core` — state machines, intent + policy validation, deterministic parser, audit events
- `packages/contracts` — zod schemas for the robot gateway protocol and their JSON Schema emitter
- `apps/api` — Fastify 5 API, drizzle + better-sqlite3 storage, auth, transition service
- `robot_gateway/schema` — generated JSON Schema consumed by the Python gateway
- `docs/superpowers/specs` — the platform design spec
- `docs/superpowers/plans` — plan 1…7, what is built and what comes next
