# Plan 3 final-review fix wave

Date: 2026-09-17

## Scope and changed files

- `apps/family/src/pages/Visit.tsx` — replaces the one-shot connected acknowledgement guard with an explicit retry attempt state. A failed acknowledgement schedules a two-second retry; cleanup cancels the retry and ignores stale completion when the component unmounts or the visit leaves `connecting`. Connection feedback is independent of polling feedback and remains until the acknowledgement succeeds or the visit recovers out of `connecting`.
- `apps/family/src/pages/Residents.tsx` — supplies the selected resident's display name to the localized visit error helper.
- `apps/resident/src/App.tsx` — disables the in-call End control unless the server visit state is `active` (as well as while another action is pending).
- `apps/family/test/App.test.tsx` — adds JSDOM regressions for connection-acknowledgement retry/error retention/timer cleanup and named `resident_unavailable` feedback.
- `apps/resident/test/App.test.tsx` — adds a connecting-state interaction regression proving End is disabled and does not POST `/end`.
- `docs/ipad-kiosk-setup.md` — corrects the `VITE_API_BASE` statement while retaining the same-origin proxy/CORS deployment guidance.

No server behavior or Plan 4–7 files changed.

## RED

Command:

```powershell
npx vitest run apps/family/test/App.test.tsx apps/resident/test/App.test.tsx
```

Output before production changes: exit 1, 3 failures / 14 passes.

- `connecting calls disable End and never send the illegal end action`: the End button was not disabled.
- `a resident-unavailable visit error includes the resident's name`: expected `Mom is not available right now`; received `{name} is not available right now`.
- `retries a failed connection acknowledgement and keeps feedback until it recovers`: expected the connection POST spy to be called twice after two seconds; received one call.

## GREEN and final verification

Focused JSDOM regression command:

```powershell
npx vitest run apps/family/test/App.test.tsx apps/resident/test/App.test.tsx
```

Output: exit 0; 2 test files passed, 17 tests passed (family 7, resident 10).

Whole suite:

```powershell
npx vitest run
```

Output: exit 0; 31 test files passed, 222 tests passed.

Strict typecheck:

```powershell
npx tsc -b
```

Output: exit 0; no diagnostics.

Production builds:

```powershell
npm run build -w @oncare/family
npm run build -w @oncare/resident
```

Output: both exit 0. Family built 39 modules; resident built 48 modules.

`git diff --check` also exited 0.
