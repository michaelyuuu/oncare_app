# Task 4 implementation report

## Status

DONE

## Implemented

- `GET /device/state` now returns the resident's newest non-terminal task with its catalogue item id and label.
- Screen precedence is `in_call` / `incoming` before `delivery_arrived`, with `placing` selecting the delivery notice only when no call screen is active.
- Non-placing work remains available in device state while the kiosk stays home; a placing task remains available during a call and appears after that call completes.
- Resident device state now has a concrete task type.
- The delivery screen renders the catalogue label and posts the encoded task receipt route before refreshing.
- Receipt failures use the established kiosk error fallback instead of being swallowed.
- Per the controller ruling, receipt advances `placing` to `verifying_delivery`; the task remains non-terminal until the gateway's standby `completed_leg` completes it.

## TDD evidence

### RED

Command:

`npx vitest run apps/api/test/device.test.ts apps/resident/test/App.test.tsx`

Result: expected failure, 6 failed and 19 passed. API failures showed `screen: "home", task: null` instead of task-bearing delivery state. Resident failures showed the generic `Your delivery is here` label and no `Please try again` fallback after a failed receipt. These failures directly demonstrated the missing API and resident wiring.

### GREEN

Command:

`npx vitest run apps/api/test/device.test.ts apps/resident/test/App.test.tsx`

Result: 2 files passed, 25 tests passed, 0 failed.

## Verification

Command:

`npx vitest run apps/api/test/device.test.ts apps/api/test/task-dispatch.test.ts apps/resident; npx tsc -b; npm run build -w @oncare/resident; git diff --check`

Result:

- 7 test files passed, 53 tests passed, 0 failed.
- TypeScript project build exited successfully with no diagnostics.
- Resident Vite production build completed successfully (50 modules transformed).
- `git diff --check` completed cleanly.
- Vite emitted its existing non-blocking warning that the resident bundle exceeds 500 kB after minification.

## Files changed

- `apps/api/src/routes/device.ts`
- `apps/api/test/device.test.ts`
- `apps/resident/src/screen.ts`
- `apps/resident/src/App.tsx`
- `apps/resident/test/App.test.tsx`
- `.superpowers/sdd/2026-09-17-plan-5-task-flow-tray-mode-staff-console/task-4-report.md`

## Self-review

- Re-read the brief, global constraints, and controller rulings against the diff.
- Confirmed call precedence, post-call delivery notice, non-terminal task retention, item label shape, receipt transition timing, URL encoding, and safe error behavior are covered by behavior tests.
- Confirmed no Plan 4 call lifecycle or kiosk fallback contracts were changed.
- Confirmed no raw resident-facing strings were introduced; the existing `DeliveryArrived` component continues to source title and action text through `t()`.
- Confirmed changes are limited to Task 4 and its report.

## Concerns

No implementation concerns. The resident production bundle continues to produce the existing large-chunk advisory warning.
