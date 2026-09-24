# RFID Laundry AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synchronize RFID garment ledger data into a facility-scoped OnCare projection and let managers query summaries and individual garments through structured tools and a bounded AI assistant.

**Architecture:** A server-only connector polls configured RFID stations and atomically replaces last-known-good projection rows after validation. Two read-only admin tools query the projection; Facility admin offers structured search at all times and optional OpenAI Responses summarization through a laundry-only tool loop.

**Tech Stack:** TypeScript, Fastify 5, SQLite, Drizzle ORM, Zod, React 19, OpenAI Responses API, Vitest, Testing Library

**Spec:** `docs/superpowers/specs/2026-09-21-rfid-oncare-laundry-ai-design.md`

## Global Constraints

- RFID local files remain the source of truth and station scanning must work without OnCare.
- V1 is read-only; no tool or route may write RFID garment state.
- Only authenticated `admin` principals can discover or invoke laundry tools.
- Facility scope always comes from the resolved server principal.
- Raw EPC, garment photos, raw scan journals, station tokens, and provider keys never reach the browser or model.
- Poll every 60 seconds by default and mark data stale after five minutes without success.
- Invalid refreshes preserve the last-known-good projection.

---

### Task 1: Projection schema, migration, and repository

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: generated `apps/api/drizzle/0004_rfid_laundry_projection.sql`
- Modify: generated `apps/api/drizzle/meta/_journal.json`
- Create: generated `apps/api/drizzle/meta/0004_snapshot.json`
- Create: `apps/api/src/services/laundry-repository.ts`
- Create: `apps/api/test/laundry-repository.test.ts`
- Modify: `apps/api/test/migration.test.ts`

**Interfaces:**
- Produces: `LaundryRepository.replaceStation(input: StationLedgerSnapshot): void`
- Produces: `LaundryRepository.overview(facilityId: string, residentId?: string): LaundryOverview`
- Produces: `LaundryRepository.find(facilityId: string, filters: GarmentFilters): GarmentResult[]`
- Produces: `LaundryRepository.recordFailure(stationId, status, warning): void`

- [ ] **Step 1: Write failing repository tests**

Cover atomic replacement, facility filtering, deterministic 20-row cap, preservation after failure, and the distinction between never-synced and no-match. Use fixed time and this minimal input shape:

```ts
const snapshot: StationLedgerSnapshot = {
  stationId: "11111111-1111-4111-8111-111111111111",
  facilityId: SEED_IDS.facility,
  sourceVersion: 7,
  sourceUpdatedAt: "2026-09-21T12:00:00.000Z",
  warnings: [],
  garments: [{
    sourceKey: "E200001", residentId: SEED_IDS.resident, name: "Blue cardigan",
    category: "cardigan", color: "blue", status: "active", washCount: 4,
    lastSeen: "2026-09-21T11:59:00.000Z",
  }],
};
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npx vitest run apps/api/test/laundry-repository.test.ts`

Expected: FAIL because tables and repository do not exist.

- [ ] **Step 3: Add tables and generate migration**

Add `rfidStationSync` and `garmentProjection`. Use an internal ID formed by `stationId + ":" + sourceKey`; keep `sourceKey` backend-only. Store warnings as JSON and all timestamps as ISO text. Generate rather than hand-edit snapshots:

Run: `npm run db:generate -w @oncare/api -- --name rfid_laundry_projection`

Expected: `0004_rfid_laundry_projection.sql`, updated journal, and `meta/0004_snapshot.json`.

- [ ] **Step 4: Implement repository transaction semantics**

Use `db.transaction` to upsert sync state, delete only the target station's old rows, and insert the complete validated replacement. `recordFailure` updates attempt/status/warnings but never deletes garments or changes `lastSuccessAt`.

`find` must order by `residentId`, normalized name, then internal ID and apply `.limit(20)`. `overview` returns:

```ts
interface LaundryOverview {
  availability: "available" | "never_synced";
  total: number;
  active: number;
  lostOrDiscarded: number;
  recentlyWashed: number;
  syncedAt: string | null;
  stale: boolean;
  warnings: Array<{ kind: string; message?: string; count?: number }>;
}
```

Compute `stale` against the repository's injected `now()` and `300_000` ms.

- [ ] **Step 5: Extend migration coverage and run tests**

Assert upgraded databases have both new tables and zero rows. Run:

`npx vitest run apps/api/test/laundry-repository.test.ts apps/api/test/migration.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle apps/api/src/services/laundry-repository.ts apps/api/test/laundry-repository.test.ts apps/api/test/migration.test.ts
git commit -m "feat(laundry): add RFID projection repository"
```

### Task 2: Station configuration and polling connector

**Files:**
- Create: `apps/api/src/services/rfid-config.ts`
- Create: `apps/api/src/services/rfid-connector.ts`
- Create: `apps/api/test/rfid-config.test.ts`
- Create: `apps/api/test/rfid-connector.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/.env.example`

**Interfaces:**
- Produces: `parseRfidStations(env): RfidStationConfig[]`
- Produces: `createRfidConnector({ repository, stations, fetch, now, intervalMs }): { refreshStation; refreshAll; start; stop }`
- Consumes: station `GET /api/ledger` response and `Authorization: Bearer <token>`.

- [ ] **Step 1: Write failing strict-config tests**

Use `ONCARE_RFID_STATIONS` as a JSON array with exact fields:

```json
[{"stationId":"11111111-1111-4111-8111-111111111111","facilityId":"facility_demo","baseUrl":"https://rfid.local","token":"secret"}]
```

Assert blank/unset means no stations; unknown keys, duplicate station IDs, non-HTTPS non-loopback URLs, blank tokens, and invalid UUIDs throw during startup.

- [ ] **Step 2: Write failing connector tests**

Assert the connector sends the bearer header, rejects a returned `station_id` mismatch, validates every garment before replacement, preserves projection on HTTP/JSON/schema errors, redacts tokens from thrown/loggable errors, and makes overlapping `refreshAll` calls coalesce.

- [ ] **Step 3: Run tests and verify failure**

Run: `npx vitest run apps/api/test/rfid-config.test.ts apps/api/test/rfid-connector.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Implement strict parsing and snapshot normalization**

Use Zod `.strict()` schemas. Normalize the station response into `StationLedgerSnapshot`; treat missing scan warnings as data warnings, not an empty success. Reject unknown garment status and negative/non-integer wash counts.

The connector lifecycle must be:

```ts
function start() {
  if (stations.length === 0 || timer) return;
  void refreshAll();
  timer = setInterval(() => void refreshAll(), intervalMs);
}
function stop() { if (timer) clearInterval(timer); timer = null; }
```

Register `stop()` in an `onClose` hook. Tests and callers may inject `fetch`; production uses global fetch.

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run apps/api/test/rfid-config.test.ts apps/api/test/rfid-connector.test.ts`

Run: `npm run typecheck`

Expected: PASS.

```bash
git add apps/api/src/services/rfid-config.ts apps/api/src/services/rfid-connector.ts apps/api/test/rfid-config.test.ts apps/api/test/rfid-connector.test.ts apps/api/src/app.ts apps/api/src/server.ts apps/api/.env.example
git commit -m "feat(laundry): synchronize RFID station ledger"
```

### Task 3: Manager-only laundry tools

**Files:**
- Modify: `apps/api/src/tools/registry.ts`
- Modify: `apps/api/src/tools/builtin.ts`
- Create: `apps/api/test/laundry-tools.test.ts`

**Interfaces:**
- Adds `laundry: LaundryRepository` to `ToolContext`.
- Produces tools `get_laundry_overview` and `find_garments`, both `roles: ["admin"]`, `effect: "read"`.

- [ ] **Step 1: Write failing role and data-minimization tests**

Assert only the admin tool listing contains both names. Device, family, and staff invocation must return `404 unknown_tool`. Cross-facility `residentId` must return `403`. Successful results must not contain keys matching `/epc|sourceKey|token|photo|scan/i`.

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run apps/api/test/laundry-tools.test.ts`

Expected: FAIL because the tools do not exist.

- [ ] **Step 3: Implement strict tool definitions**

Use these schemas:

```ts
const overviewInput = z.object({ residentId: z.string().min(1).optional() }).strict();
const findInput = z.object({
  residentId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(100).optional(),
  category: z.string().trim().min(1).max(50).optional(),
  color: z.string().trim().min(1).max(50).optional(),
  status: z.enum(["active", "lost", "discarded"]).optional(),
}).strict();
```

Require a user admin with non-null facility. When `residentId` is supplied, call `ctx.access.canAccessResident` before the repository. Return `availability`, `syncedAt`, `stale`, and warnings with every result envelope.

- [ ] **Step 4: Verify audit and run tests**

Assert successful calls create `actorType: "ai"`, `entityType: "tool"`, `reason: "tool_invoked"`, and facility correlation. Run:

`npx vitest run apps/api/test/laundry-tools.test.ts apps/api/test/tools.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/tools/registry.ts apps/api/src/tools/builtin.ts apps/api/test/laundry-tools.test.ts
git commit -m "feat(assistant): add manager laundry tools"
```

### Task 4: Bounded manager assistant tool loop

**Files:**
- Modify: `apps/api/package.json`
- Modify: `package-lock.json`
- Create: `apps/api/src/services/laundry-assistant.ts`
- Create: `apps/api/src/routes/laundry-assistant.ts`
- Create: `apps/api/test/laundry-assistant.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/.env.example`

**Interfaces:**
- Produces: `POST /admin/laundry/ask` body `{ question: string }`.
- Produces: `{ answer: string; toolResults: LaundryToolResult[] }` or `503 { error: "assistant_unavailable" }`.
- Consumes only `get_laundry_overview` and `find_garments` through `ToolRegistry.invoke`.

- [ ] **Step 1: Configure the API key using the required OpenAI API-key workflow**

Keep `OPENAI_API_KEY` server-side. Add `ONCARE_MANAGER_MODEL` with the explicit default `gpt-5.4`. Never accept a key or model name from the browser.

- [ ] **Step 2: Write failing provider-loop tests with a fake client**

Test: missing key returns `assistant_unavailable`; non-admin is `403`; question length is 1..500; a fake model tool call invokes only an allowed laundry tool; an attempted `request_staff_help` or unknown tool fails closed; at most four provider turns execute; final answer includes structured tool results.

- [ ] **Step 3: Run tests and verify failure**

Run: `npx vitest run apps/api/test/laundry-assistant.test.ts`

Expected: FAIL because the service and route do not exist.

- [ ] **Step 4: Implement the Responses function-tool loop**

Install the official `openai` package in `@oncare/api`. Define an injectable narrow client interface rather than constructing the SDK in tests. The service starts with only these tool definitions:

```ts
const ALLOWED = new Set(["get_laundry_overview", "find_garments"]);
```

For every function call, reject names outside `ALLOWED`, parse arguments as JSON, invoke the existing registry with the resolved admin principal, and submit a `function_call_output` tied to the provider `call_id`. Stop after a normal text answer or four total provider responses. Do not expose model chain-of-thought or raw provider payloads.

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run apps/api/test/laundry-assistant.test.ts apps/api/test/laundry-tools.test.ts`

Run: `npm run typecheck`

Expected: PASS.

```bash
git add apps/api/package.json package-lock.json apps/api/src/services/laundry-assistant.ts apps/api/src/routes/laundry-assistant.ts apps/api/test/laundry-assistant.test.ts apps/api/src/app.ts apps/api/.env.example
git commit -m "feat(assistant): add bounded manager laundry chat"
```

### Task 5: Facility admin Laundry AI UI

**Files:**
- Create: `apps/staff/src/admin/LaundryAI.tsx`
- Create: `apps/staff/test/LaundryAI.test.tsx`
- Modify: `apps/staff/src/admin/AdminPanel.tsx`
- Modify: `apps/staff/src/admin/types.ts`
- Modify: `packages/web-common/src/i18n/en.json`
- Modify: `apps/staff/src/styles.css`

**Interfaces:**
- Consumes: `GET /tools`, `POST /tools/get_laundry_overview/invoke`, `POST /tools/find_garments/invoke`, and `POST /admin/laundry/ask`.
- Produces: manager-only station freshness, structured overview/search, and optional conversational answer.

- [ ] **Step 1: Write failing component tests**

Cover: initial overview load; freshness timestamp; stale warning; never-synced message distinct from zero; filter submission; deterministic result table; maximum result behavior supplied by API; AI provider `503` leaves structured search usable; failed requests preserve entered filters.

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run apps/staff/test/LaundryAI.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the focused component**

Keep structured and conversational states separate:

```ts
type LoadState<T> =
  | { kind: "idle" | "loading" }
  | { kind: "ready"; value: T }
  | { kind: "error"; message: string };
```

Always render `syncedAt` and `stale` beside data, not only in chat prose. Render no-match, never-synced, stale, malformed warning, and assistant-unavailable as distinct visible messages. Do not render raw source keys.

- [ ] **Step 4: Mount only in Facility admin and run tests**

Add `<LaundryAI api={api} />` inside `AdminPanel`. `App.tsx` already mounts `AdminPanel` only for `session.role === "admin"`; add a regression test proving staff sessions never fetch laundry routes.

Run: `npx vitest run apps/staff/test/LaundryAI.test.tsx apps/staff/test/App.test.tsx`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/staff/src/admin/LaundryAI.tsx apps/staff/test/LaundryAI.test.tsx apps/staff/src/admin/AdminPanel.tsx apps/staff/src/admin/types.ts apps/staff/src/styles.css packages/web-common/src/i18n/en.json apps/staff/test/App.test.tsx
git commit -m "feat(staff): add manager Laundry AI"
```

### Task 6: End-to-end degraded-state proof and operations documentation

**Files:**
- Create: `e2e/laundry-ai.spec.ts`
- Create: `docs/runbooks/rfid-oncare-sync.md`
- Modify: `README.md`
- Modify: `scripts/demo-check.mjs`

**Interfaces:**
- Consumes: seeded admin and a fake RFID ledger server/fixture.
- Produces: repeatable proof of successful, stale, unavailable, and unauthorized behavior.

- [ ] **Step 1: Add a fake ledger fixture and browser scenario**

Use a local test server that returns one valid station UUID and garment. The scenario logs in as admin, opens Facility admin, verifies a summary, searches `blue cardigan`, and checks the visible sync time. A second test stops or changes the fixture response and proves the last-known-good result remains with an unavailable/stale warning.

- [ ] **Step 2: Extend demo check for authorization**

The demo script must call `/tools` as family, staff, and admin and assert the two laundry tools appear only for admin. It must not require a real RFID station or OpenAI key.

- [ ] **Step 3: Write the runbook**

Document `ONCARE_RFID_STATIONS`, token rotation, private HTTPS expectations, one-minute polling, five-minute stale threshold, station identity mismatch, last-known-good behavior, provider-optional behavior, and how to disable a station by removing it from configuration and restarting OnCare.

- [ ] **Step 4: Run complete verification**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run demo:check`

Run: `npx playwright test -c e2e/playwright.config.ts e2e/laundry-ai.spec.ts`

Run from the RFID integration worktree with its writable pytest temp: `python -m pytest tests -q --basetemp .tmp_pytest`

Expected: all commands PASS; station tests do not require OnCare or network access.

- [ ] **Step 5: Commit**

```bash
git add e2e/laundry-ai.spec.ts docs/runbooks/rfid-oncare-sync.md README.md scripts/demo-check.mjs
git commit -m "tdocs(laundry): verify RFID manager workflow"
```

