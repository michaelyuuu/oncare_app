# Plan 7: Benchmark Logging, Parser Corpus, Browser End-to-End, Demo Docs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure what the handover asks to measure (section 11), prove the demo story end to end in real browsers against the mock robot, and leave the repo runnable by someone who was not here.

**Architecture:** Benchmark metrics are derived from audit timestamps plus one new client signal (the iPad acknowledging that it rendered the incoming screen). A CSV export and a load script produce the numbers. A parser corpus test turns "speech parsing accuracy" into a regression test. Playwright drives three browser contexts against the running dev stack.

**Tech Stack:** as before, plus `@playwright/test`.

**Spec:** `docs/superpowers/specs/2026-09-17-oncare-platform-design.md` (section 5)

**Depends on:** Plans 1–5 complete (Plan 6 optional for the browser e2e; required for the real-robot rehearsal numbers).

## Global Constraints

- Benchmark rows contain IDs and timestamps only.
- Targets (handover §11): resident answers with exactly one action; request → iPad incoming under 3 s median; call connect ≥ 95%; recoverable loss handled within 10 s or failed safe; zero physical executions without confirmation; ≥ 90% of the ambiguous corpus triggers clarification.
- Test commands as before; Playwright: `npx playwright test` from the repo root with the dev stack running.
- Commit trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC
  ```

## File structure produced by this plan

```
apps/api/src/services/benchmark.ts        createBenchmarkService(): record visit/task metrics from transitions; toCsv()
apps/api/src/routes/benchmark.ts          GET /benchmark.csv (staff); POST /device/screen-shown (device)
apps/api/test/benchmark.test.ts
apps/resident/src/App.tsx                 posts /device/screen-shown once per (screen, visit id)
scripts/bench-visit.mjs                   N visit requests against the dev API + mock gateway with a fake device; prints median/percentiles; writes docs/benchmarks/visit-<date>.csv
packages/core/test/parser-corpus.test.ts  40-phrase corpus with accuracy thresholds
docs/benchmarks/parser-corpus.md
e2e/playwright.config.ts, e2e/demo-story.spec.ts
README.md, docs/demo-day-checklist.md
```

---

### Task 1: Benchmark service, screen-shown signal, CSV export

**Files:**
- Create: `apps/api/src/services/benchmark.ts`, `apps/api/src/routes/benchmark.ts`, `apps/api/test/benchmark.test.ts`
- Modify: `apps/api/src/app.ts` (wire), `apps/resident/src/App.tsx` (post `screen-shown`), `apps/resident/test/App.test.tsx` (assert the post)

**Interfaces:**
```ts
// benchmark.ts
export interface VisitMetrics { visitId: string; requestedAt: string; incomingShownAt: string | null; answeredAt: string | null; connectedAt: string | null; endedAt: string | null; finalState: string; commandAckMs: number | null; notifyMs: number | null /* incomingShownAt - requestedAt */; residentActions: number /* answer/decline posts by the device */ }
export interface TaskMetrics { taskId: string; createdAt: string; confirmedAt: string | null; approvedAt: string | null; pickupArrivedAt: string | null; loadedAt: string | null; deliveryArrivedAt: string | null; receivedAt: string | null; finalState: string; totalMs: number | null }
export function createBenchmarkService(db: Db, transitions: TransitionService): { visit(visitId: string): VisitMetrics | null; task(taskId: string): TaskMetrics | null; recordScreenShown(deviceId: string, screen: string, entityId: string, at: string): void; toCsv(): string; stop(): void }
// Routes
POST /device/screen-shown (device) body { screen: "incoming"|"delivery_arrived", entityId } -> 200 { ok: true }; idempotent per (deviceId, screen, entityId); stores a benchmark_trial { name: "screen_shown:<screen>", at }
GET  /benchmark.csv (staff) -> text/csv; one row per visit and per task with the fields above
```
- Implementation: on every transition the service upserts a `benchmark_run` row for the entity (`kind` visit/task, `metrics` JSON recomputed from `audit_event` timestamps: `requested`→`requestedAt` (visit row), `connecting`→`answeredAt`, `active`→`connectedAt`, `completed|ending`→`endedAt`; task: `awaiting_policy_or_staff`→`confirmedAt`, `queued`→`approvedAt`, `locating_item`→`pickupArrivedAt`, `navigating_to_delivery`→`loadedAt`, `placing`→`deliveryArrivedAt`, `verifying_delivery`→`receivedAt`), `commandAckMs` from `robot_command.issuedAt/ackedAt`, `residentActions` = count of audit rows with `actorType = "device"` on that visit, `incomingShownAt` from the `benchmark_trial` named `screen_shown:incoming`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/benchmark.test.ts
import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("benchmark", () => {
  test("a visit produces one metrics row with notify latency, one resident action, and ack latency", async () => {
    let clock = Date.parse("2026-09-17T00:00:00.000Z");
    const { app, db, tokens } = await makeTestApp({ now: () => new Date(clock) });
    app.hub.attach(SEED_IDS.robot, { send() {} });
    const v = (await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } })).json().visit.id;
    clock += 400; app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: v, result: "accepted" });
    clock += 1000; app.hub.receive(SEED_IDS.robot, { type: "state_event", correlationId: v, at: new Date(clock).toISOString(), event: "arrived" });
    clock += 800; await app.inject({ method: "POST", url: "/device/screen-shown", headers: auth(tokens.device), payload: { screen: "incoming", entityId: v } });
    await app.inject({ method: "POST", url: "/device/screen-shown", headers: auth(tokens.device), payload: { screen: "incoming", entityId: v } });   // idempotent
    clock += 3000; await app.inject({ method: "POST", url: `/visits/${v}/answer`, headers: auth(tokens.device) });
    clock += 1500; await app.inject({ method: "POST", url: `/visits/${v}/connected`, headers: auth(tokens.family) });
    clock += 60000; await app.inject({ method: "POST", url: `/visits/${v}/end`, headers: auth(tokens.family) });
    const m = app.benchmark.visit(v)!;
    expect(m).toMatchObject({ finalState: "completed", residentActions: 1, commandAckMs: 400, notifyMs: 2200 });
    expect(db.select().from(t.benchmarkRun).where(eq(t.benchmarkRun.entityId, v)).all()).toHaveLength(1);
    expect(db.select().from(t.benchmarkTrial).all().filter((x) => x.name === "screen_shown:incoming")).toHaveLength(1);
  });

  test("task metrics carry per-stage timestamps and total time", async () => {
    let clock = Date.parse("2026-09-17T00:00:00.000Z");
    const { app, tokens } = await makeTestApp({ now: () => new Date(clock) });
    app.hub.attach(SEED_IDS.robot, { send() {} });
    const task = (await app.inject({ method: "POST", url: "/tasks", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident, text: "water" } })).json().task;
    clock += 1000; await app.inject({ method: "POST", url: `/tasks/${task.id}/confirm`, headers: auth(tokens.family) });
    clock += 1000; await app.inject({ method: "POST", url: `/tasks/${task.id}/approve`, headers: auth(tokens.staff) });
    app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: task.correlationId, result: "accepted" });
    clock += 5000; app.hub.receive(SEED_IDS.robot, { type: "state_event", correlationId: task.correlationId, at: new Date(clock).toISOString(), event: "arrived_pickup" });
    clock += 2000; await app.inject({ method: "POST", url: `/tasks/${task.id}/loaded`, headers: auth(tokens.staff) });
    clock += 5000; app.hub.receive(SEED_IDS.robot, { type: "state_event", correlationId: task.correlationId, at: new Date(clock).toISOString(), event: "arrived_delivery" });
    clock += 1000; await app.inject({ method: "POST", url: `/tasks/${task.id}/received`, headers: auth(tokens.device) });
    const m = app.benchmark.task(task.id)!;
    expect(m.finalState).toBe("completed");
    expect(m.totalMs).toBe(15000);
    expect([m.confirmedAt, m.approvedAt, m.pickupArrivedAt, m.loadedAt, m.deliveryArrivedAt, m.receivedAt].every((x) => typeof x === "string")).toBe(true);
  });

  test("CSV export is staff-only and has a header plus one line per run", async () => {
    const { app, tokens } = await makeTestApp();
    await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } });
    expect((await app.inject({ method: "GET", url: "/benchmark.csv", headers: auth(tokens.family) })).statusCode).toBe(403);
    const res = await app.inject({ method: "GET", url: "/benchmark.csv", headers: auth(tokens.staff) });
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.body.trim().split("\n");
    expect(lines[0]).toContain("kind,entityId,finalState");
    expect(lines).toHaveLength(2);
    expect(res.body).not.toContain("Demo Daughter");
  });
});
```
`makeTestApp` must accept `{ now }` and pass it to `buildApp`; update `helpers.ts`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/api/test/benchmark.test.ts`
Expected: FAIL — `app.benchmark` undefined / routes 404.

- [ ] **Step 3: Implement**

`benchmark.ts` computes metrics on demand from `audit_event`, `visit_session`, `task_request`, `robot_command`, `benchmark_trial`; `transitions.subscribe` upserts the `benchmark_run` row (`id = "bench_" + entityId`, `metrics` JSON) after every transition for that entity. `toCsv()` flattens all runs: header `kind,entityId,finalState,requestedAt,incomingShownAt,answeredAt,connectedAt,endedAt,notifyMs,commandAckMs,residentActions,confirmedAt,approvedAt,pickupArrivedAt,loadedAt,deliveryArrivedAt,receivedAt,totalMs` with empty cells where not applicable. `recordScreenShown` inserts a `benchmark_trial` (`runId` = the visit's run id, creating the run if absent; `name = "screen_shown:<screen>"`, `at`) unless one with the same run+name exists.

Routes: `POST /device/screen-shown` (device, zod body), `GET /benchmark.csv` (staff, `reply.type("text/csv").send(app.benchmark.toCsv())`).

Resident `App.tsx`: `useEffect` keyed on `(screen, server?.visit?.id ?? server?.task?.id)`: when `screen === "incoming"` or `"delivery_arrived"`, post `/device/screen-shown { screen, entityId }` once (track in a `useRef<Set<string>>`). Add an assertion to the existing incoming test: `calls.some(c => c.path === "/device/screen-shown")`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc -b` → all green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test apps/resident/src/App.tsx apps/resident/test/App.test.tsx
git commit -m "feat(api): benchmark metrics from audit timestamps, screen-shown signal, CSV export" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 2: Visit latency load script

**Files:**
- Create: `scripts/bench-visit.mjs`, `docs/benchmarks/README.md`
- Modify: root `package.json` — `"bench:visit": "node scripts/bench-visit.mjs"`

**Behaviour:** against a running dev API (`API=http://127.0.0.1:3000`, default) with the mock gateway connected: logs in as `family` and `device`; opens a device `/events` socket; for `N` (default 20) iterations: `POST /visits`, wait for the device to receive `awaiting_resident_consent` (record `notifyMs` = event receipt − request send), post `/device/screen-shown`, `answer`, `connected`, `end`, wait for `completed` (`connectMs`); then fetches `/benchmark.csv` as staff and writes `docs/benchmarks/visit-<YYYY-MM-DD>.csv`; prints `n, notify median/p95, connect success %, end-to-end median` and PASS/FAIL against the targets (notify median < 3000 ms, connect ≥ 95%). Uses only `fetch` and `ws`.

- [ ] **Step 1: Write the script**

```js
// scripts/bench-visit.mjs
import WebSocket from "ws";
import { mkdirSync, writeFileSync } from "node:fs";
const API = process.env.API ?? "http://127.0.0.1:3000";
const N = Number(process.env.N ?? 20);
const j = async (path, opts = {}, token) => {
  const r = await fetch(`${API}${path}`, { ...opts, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : r.text();
};
const login = async (username, password) => (await j("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) })).token;
const family = await login("family", "family-demo-pass");
const staff = await login("staff", "staff-demo-pass");
const device = (await j("/auth/device", { method: "POST", body: JSON.stringify({ deviceToken: "device-demo-token" }) })).token;
const residents = (await j("/me/residents", {}, family)).residents;
const residentId = residents[0].id;

const waiters = new Map();
const ws = new WebSocket(`${API.replace("http", "ws")}/events?token=${device}`);
ws.on("message", (d) => { const ev = JSON.parse(d.toString()); const key = `${ev.entityId}:${ev.toState}`; waiters.get(key)?.(Date.now()); });
await new Promise((r) => ws.once("open", r));
const waitFor = (id, state, ms = 15000) => new Promise((resolve, reject) => { const key = `${id}:${state}`; const t = setTimeout(() => { waiters.delete(key); reject(new Error(`timeout ${key}`)); }, ms); waiters.set(key, (at) => { clearTimeout(t); waiters.delete(key); resolve(at); }); });

const rows = [];
for (let i = 0; i < N; i++) {
  const t0 = Date.now();
  const { visit } = await j("/visits", { method: "POST", body: JSON.stringify({ residentId }) }, family);
  const ringing = waitFor(visit.id, "awaiting_resident_consent");
  let notifyMs = null, ok = false;
  try {
    const at = await ringing; notifyMs = at - t0;
    await j("/device/screen-shown", { method: "POST", body: JSON.stringify({ screen: "incoming", entityId: visit.id }) }, device);
    await j(`/visits/${visit.id}/answer`, { method: "POST" }, device);
    await j(`/visits/${visit.id}/connected`, { method: "POST" }, family);
    const done = waitFor(visit.id, "completed");
    await j(`/visits/${visit.id}/end`, { method: "POST" }, family);
    await done; ok = true;
  } catch (e) { console.error(`run ${i}: ${e.message}`); }
  rows.push({ i, visitId: visit.id, notifyMs, ok, totalMs: Date.now() - t0 });
  process.stdout.write(`run ${i + 1}/${N} notify=${notifyMs}ms ok=${ok}\n`);
}
ws.close();
const nums = rows.filter((r) => r.notifyMs !== null).map((r) => r.notifyMs).sort((a, b) => a - b);
const q = (p) => nums[Math.min(nums.length - 1, Math.floor(p * nums.length))] ?? null;
const success = rows.filter((r) => r.ok).length / rows.length;
const summary = { n: rows.length, notifyMedianMs: q(0.5), notifyP95Ms: q(0.95), connectSuccess: success, pass: q(0.5) !== null && q(0.5) < 3000 && success >= 0.95 };
console.log(JSON.stringify(summary, null, 2));
const date = new Date().toISOString().slice(0, 10);
mkdirSync("docs/benchmarks", { recursive: true });
writeFileSync(`docs/benchmarks/visit-${date}.csv`, await j("/benchmark.csv", {}, staff));
writeFileSync(`docs/benchmarks/visit-${date}.summary.json`, JSON.stringify({ ...summary, rows }, null, 2));
process.exit(summary.pass ? 0 : 1);
```

- [ ] **Step 2: Run it** with `npm run dev -w @oncare/api` and the mock gateway (`mock_travel_ms = 500` in its config for the bench) running: `npm run bench:visit`. Expected: 20 runs, `pass: true`, files written. Commit the CSV and summary as the first baseline.

- [ ] **Step 3: Commit**

```bash
git add scripts/bench-visit.mjs package.json docs/benchmarks
git commit -m "bench: visit notification/connection benchmark script and first mock baseline" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 3: Parser corpus test

**Files:**
- Create: `packages/core/test/parser-corpus.test.ts`, `docs/benchmarks/parser-corpus.md`

- [ ] **Step 1: Write the test (it is the deliverable)**

```ts
// packages/core/test/parser-corpus.test.ts
import { describe, expect, test } from "vitest";
import { KeywordParser } from "../src/parser/keyword";
import { DEMO_CATALOGUE } from "../src/policy";
const ctx = { recipientId: "resident_demo_01", defaultDestinationId: "bedside_table_demo", catalogue: DEMO_CATALOGUE };
const parser = new KeywordParser();

/** Clear requests: exactly one approved item, must parse to it. */
const CLEAR: Array<[string, string]> = [
  ["Could you bring Mom the water bottle?", "water_bottle"], ["water please", "water_bottle"], ["she needs some water", "water_bottle"], ["bring the bottle of water", "water_bottle"],
  ["can you get the tissue box", "tissue_box"], ["tissues please", "tissue_box"], ["mom needs a tissue", "tissue_box"], ["bring her the tissue box from the table", "tissue_box"],
  ["bring the tv remote", "tv_remote"], ["she lost the remote", "tv_remote"], ["can you bring the remote control", "tv_remote"], ["the TV remote please", "tv_remote"],
  ["幫媽媽拿水瓶", "water_bottle"], ["拿面紙給她", "tissue_box"], ["遙控器", "tv_remote"], ["請拿水", "water_bottle"],
  ["WATER BOTTLE", "water_bottle"], ["tissue-box", "tissue_box"], ["remote!", "tv_remote"], ["bring   water   now", "water_bottle"],
];
/** Ambiguous or empty requests: must NOT produce a proposal. */
const AMBIGUOUS: string[] = [
  "can you help her?", "bring her something to drink", "she needs her things", "get the stuff on the table", "please come", "bring it", "the thing", "help",
  "water and tissues", "tissue box or remote", "bring the water bottle and the tv remote", "water, tissues, remote",
  "", "   ", "???", "hello", "how is she today", "is the robot free", "can she call me back", "thanks",
];

describe("parser corpus (handover section 11: speech parsing accuracy)", () => {
  test("every clear request parses to the right item", () => {
    const failures = CLEAR.filter(([text, item]) => { const o = parser.parse(text, ctx); return !(o.kind === "proposal" && o.proposal.item === item); });
    expect(failures, JSON.stringify(failures)).toEqual([]);
  });
  test("at least 90% of ambiguous requests trigger clarification instead of a proposal", () => {
    const clarified = AMBIGUOUS.filter((text) => parser.parse(text, ctx).kind === "clarification");
    const rate = clarified.length / AMBIGUOUS.length;
    expect(rate, `clarified ${clarified.length}/${AMBIGUOUS.length}`).toBeGreaterThanOrEqual(0.9);
  });
  test("no ambiguous request ever produces an executable proposal for a multi-item sentence", () => {
    for (const text of ["water and tissues", "tissue box or remote", "bring the water bottle and the tv remote", "water, tissues, remote"]) {
      expect(parser.parse(text, ctx).kind, text).toBe("clarification");
    }
  });
});
```

- [ ] **Step 2: Run** `npx vitest run packages/core/test/parser-corpus.test.ts`. Expected: PASS. If a CLEAR case fails, extend `DEFAULT_SYNONYMS` (never weaken the assertion) and note it in the doc.

- [ ] **Step 3: Write `docs/benchmarks/parser-corpus.md`**: the two lists, the measured rates from the run, and how to add phrases.

- [ ] **Step 4: Commit**

```bash
git add packages/core/test/parser-corpus.test.ts packages/core/src/parser/keyword.ts docs/benchmarks/parser-corpus.md
git commit -m "test(core): parser accuracy corpus with clarification-rate threshold" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 4: Browser end-to-end of the demo story (Playwright, mock robot)

**Files:**
- Create: `e2e/playwright.config.ts`, `e2e/demo-story.spec.ts`, `e2e/README.md`
- Modify: root `package.json` — devDependency `"@playwright/test": "^1.48.0"`, scripts `"e2e": "playwright test -c e2e/playwright.config.ts"`; root `.gitignore` — `e2e/test-results/`, `e2e/playwright-report/`

**Behaviour:** `webServer` in the config starts `npm run dev` (api + three apps) and the mock gateway (`.venv/Scripts/python -m gateway` with env `ONCARE_ROBOT_TOKEN=robot-demo-token ROBOT_ADAPTER=mock`) and waits for `/health`. One spec with three `browser.newContext()`s: family (`localhost:5174`), resident (`localhost:5173`, viewport 1024×768, permissions `["camera","microphone"]` with fake media via `--use-fake-device-for-media-stream`), staff (`localhost:5175`). Steps mirror handover §8 with LiveKit either real (if `apps/api/.env` exists) or the call screens asserted without media (the spec detects `visit.simulated` and whether the `video-stage` got a `<video>` within 10 s; both paths pass, the report says which ran).

- [ ] **Step 1: Write the spec**

```ts
// e2e/demo-story.spec.ts
import { expect, test } from "@playwright/test";

test("handover section 8: visit, call, item request, tray delivery", async ({ browser }) => {
  test.setTimeout(180_000);
  const family = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const resident = await (await browser.newContext({ viewport: { width: 1024, height: 768 }, permissions: ["camera", "microphone"] })).newPage();
  const staff = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

  // resident kiosk: first-run settings -> device token
  await resident.goto("http://localhost:5173/");
  await resident.getByLabel("Device token").fill("device-demo-token");
  await resident.getByRole("button", { name: "Save" }).click();
  await expect(resident.getByText("Hello, Demo Resident")).toBeVisible();
  await expect(resident.getByText("SIMULATED ROBOT")).toBeVisible();

  // staff console
  await staff.goto("http://localhost:5175/");
  await staff.getByLabel("Username").fill("staff"); await staff.getByLabel("Password").fill("staff-demo-pass");
  await staff.getByRole("button", { name: "Sign in" }).click();
  await expect(staff.getByText("Connected")).toBeVisible();

  // 1-2. daughter requests a visit; robot goes
  await family.goto("http://localhost:5174/");
  await family.getByLabel("Username").fill("family"); await family.getByLabel("Password").fill("family-demo-pass");
  await family.getByRole("button", { name: "Sign in" }).click();
  await family.getByRole("button", { name: "Send the robot to visit" }).click();
  await expect(family.getByText("Robot is on its way")).toHaveAttribute("aria-current", "step");

  // 3-4. iPad rings; one tap answers
  const answer = resident.getByRole("button", { name: "Answer" });
  await expect(answer).toBeVisible({ timeout: 20_000 });
  await expect(resident.getByText("Demo Daughter is calling")).toBeVisible();
  await answer.click();

  // 5. call screen on both sides (media only if LiveKit is configured)
  await expect(resident.getByTestId("video-stage")).toBeVisible();
  await expect(family.getByText("On the call")).toHaveAttribute("aria-current", "step", { timeout: 30_000 });
  const hasVideo = await resident.getByTestId("video-stage").locator("video").count().then((n) => n > 0).catch(() => false);
  test.info().annotations.push({ type: "media", description: hasVideo ? "real LiveKit media" : "call screens without media (no LiveKit env)" });

  // 6-8. ask for the water bottle, confirm
  await family.getByRole("button", { name: "Ask the robot for help" }).click();
  await family.getByPlaceholder(/Type what you need/).fill("Could you bring Mom the water bottle?");
  await family.getByRole("button", { name: "Send" }).click();
  await expect(family.getByText("Send the robot with the water bottle to Mom's bedside table?")).toBeVisible();
  await family.getByRole("button", { name: "Yes, send the robot" }).click();
  await expect(family.getByText("Care home approval")).toHaveAttribute("aria-current", "step");

  // staff approves, robot drives, staff loads the tray
  await staff.getByRole("button", { name: "Approve" }).first().click();
  await expect(staff.getByRole("button", { name: "Loaded on tray" })).toBeVisible({ timeout: 20_000 });
  await staff.getByRole("button", { name: "Loaded on tray" }).click();

  // 9-10. delivery on the iPad; resident takes it
  await expect(resident.getByText("Your water bottle is here")).toBeVisible({ timeout: 20_000 });
  await resident.getByRole("button", { name: "I have it" }).click();
  await expect(family.getByText("Done")).toHaveAttribute("aria-current", "step", { timeout: 20_000 });

  // 11. audit shows it
  await staff.getByLabel("Resident id").fill("resident_demo_01");
  await expect(staff.locator("table tbody tr").filter({ hasText: "completed" }).first()).toBeVisible();
  await family.getByRole("button", { name: "End call" }).click();
});
```

- [ ] **Step 2: Config**

```ts
// e2e/playwright.config.ts
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".", timeout: 120_000, retries: 0, reporter: [["list"], ["html", { open: "never" }]],
  use: { launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } },
  webServer: [
    { command: "npm run dev", url: "http://127.0.0.1:3000/health", reuseExistingServer: true, timeout: 120_000, cwd: ".." },
    { command: "cd ../robot_gateway && ONCARE_ROBOT_TOKEN=robot-demo-token ROBOT_ADAPTER=mock .venv/Scripts/python -m gateway", url: "http://127.0.0.1:3000/health", reuseExistingServer: true, cwd: "." },
  ],
});
```
On Windows the second command runs under `cmd`; if `cd ... &&` fails, replace it with `node e2e/start-gateway.mjs` that spawns the venv python with the env set.

- [ ] **Step 3: Run** `npx playwright install chromium` once, then `npm run e2e`. Expected: 1 passed, annotation says which media path ran. Fix defects in the owning app if the story breaks; note them in the report.

- [ ] **Step 4: Commit**

```bash
git add e2e package.json package-lock.json .gitignore
git commit -m "test(e2e): browser end-to-end of the demo story across family, resident and staff apps" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 5: README, demo-day checklist, takeover report status

**Files:**
- Create: `README.md`, `docs/demo-day-checklist.md`
- Modify: `docs/takeover-report-2026-09-16.md` — append a "Status as of <date>" section

- [ ] **Step 1: README** — what this is (one paragraph, links the spec and handover), prerequisites (Node 24, Python 3.12, LiveKit account optional), `npm install`, `robot_gateway` venv, `npm run dev`, the three URLs and seed credentials (`family`/`family-demo-pass`, `staff`/`staff-demo-pass`, staff PIN `2468`, device token `device-demo-token`, robot token `robot-demo-token`; all synthetic), how to run tests (`npx vitest run`, `pytest`, `npm run e2e`), how to run the mock gateway vs. the Jetson (`docs/jetson-gateway-setup.md`), repo map (one line per package/app), safety rules that the code enforces (five bullets), what is mocked and labelled, what is out of scope.
- [ ] **Step 2: Checklist** — the morning-of list: `npm run demo:check`, `ontaru doctor` on the Jetson, robot at standby with lift at rest, iPad in Guided Access with Auto-Lock off, LiveKit env present, three logins tested, `npm run bench:visit` passes, the three failure drills rehearsed, who stands by the robot, how to STOP (staff console, nav_web page, power).
- [ ] **Step 3: Takeover report status** — table of the eight sections from the original report with what now exists, and the measured numbers from `docs/benchmarks/` and the rehearsal doc.
- [ ] **Step 4: Commit and tag**

```bash
git add README.md docs
git commit -m "docs: README, demo-day checklist, takeover status update" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
git tag -a v0.1.0-demo -m "Two-week demo build"
```

---

## Plan self-review

**Spec coverage (Plan 7):** §5 benchmark logging (Task 1), targets measured (Task 2), speech accuracy as a regression corpus (Task 3), Playwright e2e against the mock (Task 4), docs (Task 5). The manipulation benchmark (handover §10) is owned by the grasp-pipeline session and is out of scope here by the owner's decision.

**Placeholder scan:** none.

**Type consistency:** `VisitMetrics`/`TaskMetrics` fields ↔ CSV header (Task 1) ↔ bench script consumption (Task 2 only reads the CSV as text); `screen-shown` route ↔ resident App post; Playwright selectors ↔ i18n strings from Plans 3–5.
