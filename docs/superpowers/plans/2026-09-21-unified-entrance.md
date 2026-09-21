# Unified Entrance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one role-selecting OnCare front door while keeping authentication and identity authority in the existing backend and role applications.

**Architecture:** A new `@oncare/portal` Vite app presents Resident, Family, Staff, and Manager routes and redirects into the existing role apps. A new authenticated identity-directory endpoint returns only server-authorized resident identities; role selection and browser state never create authority.

**Tech Stack:** React 19, Vite 6, TypeScript, Fastify 5, Drizzle ORM, Vitest, Testing Library

**Spec:** `docs/superpowers/specs/2026-09-21-rfid-oncare-laundry-ai-design.md`

## Global Constraints

- Role selection is navigation only; only a resolved backend principal authorizes data.
- Production never accepts a client-supplied role or synthetic actor header as authentication.
- Resident devices are bound to one resident; family, staff, and manager identity lists are server filtered.
- Demo identity affordances must be visibly labelled `SIMULATED` and disabled unless explicitly configured.
- Preserve the existing resident, family, and staff application boundaries.

---

### Task 1: Authenticated identity directory

**Files:**
- Create: `apps/api/test/identity-options.test.ts`
- Modify: `apps/api/src/routes/me.ts`
- Modify: `packages/web-common/src/index.ts`

**Interfaces:**
- Produces: `GET /me/identities -> { principal: { kind, role }, identities: IdentityOption[] }`
- Produces: `IdentityOption = { residentId: string; displayName: string; relationship: "self" | "family" | "assignment" | "facility" }`
- Consumes: `access.residentIdsVisibleTo(principal)` and current active resident rows.

- [ ] **Step 1: Write failing role-scope tests**

Create tests that authenticate with `tokens.device`, `tokens.family`, `tokens.staff`, and `tokens.admin`, call `/me/identities`, and assert:

```ts
expect(await identities(tokens.device)).toEqual([
  { residentId: SEED_IDS.resident, displayName: "Demo Resident", relationship: "self" },
]);
expect(await identities(tokens.family)).toEqual([
  { residentId: SEED_IDS.resident, displayName: "Demo Resident", relationship: "family" },
]);
expect(await identities(tokens.staff)).toEqual([
  { residentId: SEED_IDS.resident, displayName: "Demo Resident", relationship: "assignment" },
]);
expect(await identities(tokens.admin)).toEqual([
  { residentId: SEED_IDS.resident, displayName: "Demo Resident", relationship: "facility" },
]);
```

Also deactivate the resident or staff assignment after login and assert it disappears without issuing a new token. An unauthenticated call must return `401`.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npx vitest run apps/api/test/identity-options.test.ts`

Expected: FAIL because `/me/identities` is not registered.

- [ ] **Step 3: Implement the endpoint with server-derived scope**

Extend `meRoutes` with one route guarded by all current roles:

```ts
app.get("/me/identities", { preHandler: requireRole("device", "family", "staff", "admin") }, async (req) => {
  const visible = app.access.residentIdsVisibleTo(req.principal);
  const rows = visible.length
    ? db.select({ residentId: t.resident.id, displayName: t.resident.displayName })
        .from(t.resident).where(inArray(t.resident.id, visible)).all()
    : [];
  const relationship = req.principal.kind === "device" ? "self"
    : req.principal.role === "family" ? "family"
    : req.principal.role === "staff" ? "assignment" : "facility";
  return { principal: publicPrincipal(req.principal), identities: rows.map((row) => ({ ...row, relationship })) };
});
```

Return only `kind`, user `role`, and the authorized identity rows. Do not echo facility IDs, JWT claims, relationship IDs, or device secrets.

- [ ] **Step 4: Export the shared response type and run tests**

Add `IdentityOption` and `IdentityOptionsResponse` to `packages/web-common/src/index.ts`.

Run: `npx vitest run apps/api/test/identity-options.test.ts packages/web-common/test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/me.ts apps/api/test/identity-options.test.ts packages/web-common/src/index.ts
git commit -m "feat(auth): add scoped identity directory"
```

### Task 2: Unified portal workspace

**Files:**
- Create: `apps/portal/package.json`
- Create: `apps/portal/tsconfig.json`
- Create: `apps/portal/vite.config.ts`
- Create: `apps/portal/vitest.config.ts`
- Create: `apps/portal/index.html`
- Create: `apps/portal/src/main.tsx`
- Create: `apps/portal/src/App.tsx`
- Create: `apps/portal/src/styles.css`
- Create: `apps/portal/test/App.test.tsx`
- Modify: `package.json`
- Modify: `tsconfig.json`

**Interfaces:**
- Produces: portal at development port `5172`.
- Consumes: `VITE_RESIDENT_URL`, `VITE_FAMILY_URL`, and `VITE_STAFF_URL`, with localhost defaults.
- Manager and Staff both route to the staff app; their backend role after login determines available UI.

- [ ] **Step 1: Write failing portal tests**

Test four accessible links and exact destinations:

```tsx
render(<App urls={{ resident: "http://r", family: "http://f", staff: "http://s" }} />);
expect(screen.getByRole("link", { name: "Resident" })).toHaveAttribute("href", "http://r");
expect(screen.getByRole("link", { name: "Family" })).toHaveAttribute("href", "http://f");
expect(screen.getByRole("link", { name: "Staff" })).toHaveAttribute("href", "http://s");
expect(screen.getByRole("link", { name: "Manager" })).toHaveAttribute("href", "http://s?mode=manager");
```

Assert the page does not render username, password, token, facility, or free-form identity inputs.

- [ ] **Step 2: Run the test and verify failure**

Run: `npx vitest run apps/portal/test/App.test.tsx`

Expected: FAIL because the workspace does not exist.

- [ ] **Step 3: Create the minimal portal**

Implement `App` as a semantic heading plus four links. Use this URL type:

```ts
export interface PortalUrls { resident: string; family: string; staff: string }
```

`main.tsx` supplies:

```ts
const urls = {
  resident: import.meta.env.VITE_RESIDENT_URL ?? "http://localhost:5173/",
  family: import.meta.env.VITE_FAMILY_URL ?? "http://localhost:5174/",
  staff: import.meta.env.VITE_STAFF_URL ?? "http://localhost:5175/",
};
```

Use direct links rather than copying credentials or sessions between origins.

- [ ] **Step 4: Wire workspace scripts**

Add portal to the root `dev` concurrently command and document `http://localhost:5172` in its script. Add `{ "path": "apps/portal" }` to the explicit `references` array in the root `tsconfig.json`.

- [ ] **Step 5: Run portal tests and typecheck**

Run: `npx vitest run apps/portal/test/App.test.tsx`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/portal package.json tsconfig.json
git commit -m "feat(portal): add unified role entrance"
```

### Task 3: Manager routing hint and production-safe demo labeling

**Files:**
- Modify: `apps/staff/src/App.tsx`
- Modify: `apps/staff/src/pages/Login.tsx`
- Modify: `apps/staff/test/App.test.tsx`
- Modify: `apps/portal/src/App.tsx`
- Modify: `apps/portal/test/App.test.tsx`
- Modify: `packages/web-common/src/i18n/en.json`

**Interfaces:**
- Consumes: optional `mode=manager` URL hint.
- Produces: manager-oriented login copy only; it does not change submitted credentials or accepted roles.
- Produces: optional `demo` prop on portal; demo UI is labelled `SIMULATED` and contains no production token.

- [ ] **Step 1: Add failing tests for the non-authoritative hint**

Render the staff app with a manager-mode hint, complete a login whose response principal is `staff`, and assert the session remains `role: "staff"` and Facility admin is absent. Complete an admin login and assert Facility admin appears.

For the portal, assert a demo badge appears only when `demo={true}` and the standard role links are unchanged.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npx vitest run apps/staff/test/App.test.tsx apps/portal/test/App.test.tsx`

Expected: FAIL on the new copy/demo assertions.

- [ ] **Step 3: Implement label-only behavior**

Parse `mode=manager` only to choose login heading text. Preserve this authority rule:

```ts
const role = result.principal.role;
if (role !== "staff" && role !== "admin") throw new Error("not_staff_or_admin");
onLoggedIn({ token: result.token, displayName: result.principal.displayName, role });
```

Do not derive `role` from the URL. Add the `SIMULATED` badge to the portal only when `VITE_ONCARE_DEMO === "1"` is converted to `demo={true}` by `main.tsx`.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run apps/staff/test/App.test.tsx apps/portal/test/App.test.tsx`

Run: `npm run typecheck`

Expected: PASS.

```bash
git add apps/staff/src/App.tsx apps/staff/src/pages/Login.tsx apps/staff/test/App.test.tsx apps/portal/src/App.tsx apps/portal/src/main.tsx apps/portal/test/App.test.tsx packages/web-common/src/i18n/en.json
git commit -m "test(auth): keep portal role hints non-authoritative"
```

### Task 4: Unified entrance browser acceptance and documentation

**Files:**
- Create: `e2e/unified-entrance.spec.ts`
- Modify: `e2e/playwright.config.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: portal on port `5172` and existing role apps.
- Produces: browser proof that role selection routes correctly and Manager still requires admin credentials.

- [ ] **Step 1: Add the browser scenario**

The scenario must:

```ts
await page.goto("http://localhost:5172/");
await expect(page.getByRole("link", { name: "Resident" })).toBeVisible();
await page.getByRole("link", { name: "Manager" }).click();
await expect(page).toHaveURL(/localhost:5175.*mode=manager/);
await expect(page.getByRole("heading", { name: /manager/i })).toBeVisible();
```

Then log in once with staff credentials and prove Facility admin is absent; log out, use admin credentials, and prove Facility admin is present.

- [ ] **Step 2: Run focused and full verification**

Run: `npx playwright test -c e2e/playwright.config.ts e2e/unified-entrance.spec.ts`

Run: `npm test`

Run: `npm run typecheck`

Expected: all commands PASS.

- [ ] **Step 3: Document and commit**

Update README startup URLs and explain that role selection does not authenticate. Document demo labeling and the production prohibition on synthetic identity selection.

```bash
git add e2e/unified-entrance.spec.ts e2e/playwright.config.ts README.md
git commit -m "tdocs(portal): verify unified entrance"
```

