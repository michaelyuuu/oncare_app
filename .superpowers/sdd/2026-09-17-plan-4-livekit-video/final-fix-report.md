# Plan 4 final fix wave

Base: `f69fa478e257608af4176347dd9765fa9932c45b`. One combined fix wave on the authorized shared master checkout. All three Important and six minor final findings addressed. No other plan, workspace, branch, or external-system changes.

## Changes and covering regressions

1. Room shutdown now subscribes to the existing successful transition stream in `createVisitService`, so staff stop, gateway terminals, and visit actions receive the same cleanup. Eligibility uses the prior state (`awaiting_resident_consent`, `connecting`, `active`, `ending`) or a recorded connection. Accepted pre-call cancellation remains room-free. Rooms closed at `ending` are remembered only until the terminal event, preventing a second close during `end` without retaining every completed visit forever. The app's close hook disposes this subscription and its bookkeeping. Fake-provider tests exercise three staff-stop starting states, gateway safety-stop/cancel from both connecting and active, repeated terminal events, immediate ending cleanup, a different visit transitioning after app close, normal once-only end, prejoin decline, pre-call cancellation, and caught close failures.
2. Family startup discards and leaves a result after either cancellation or an earlier terminal loss. It never stores the late handle or attaches its preview. Lost generations ignore subsequent media/presence/state callbacks and release the control handle. Component coverage defers startup until after loss; the Visit integration also rejects the loss-report API call, keeps the panel mounted, then resolves startup and verifies the handle is left without attaching preview.
3. Shared `createCall` reports camera-on immediately after camera publication succeeds, before awaiting microphone publication. It disconnects on terminal loss even while startup is pending, guards every startup await and post-await control notification, and cannot attach a preview after termination. FakeRoom regressions cover deferred microphone startup, loss during either camera or microphone startup, immediate disconnect while still pending, no continued microphone start after camera-stage loss, and pending mic/camera controls completing after leave.
4. `connection_lost` regression is parameterized over both connecting and active.
5. Direct token endpoint tests cover missing-visit 404 and unrelated-device 403, including no tokens issued.
6. Fixed cleanup sleeps were removed. FakeVideoProvider records closure synchronously at invocation; tests assert after the completed action/transition. The rejected-close test waits for the actual error-log assertion.
7. Blank/whitespace resident names use localized `your family member` in the waiting text. The fallback lives at the CallPanel display boundary, covering the Visit lookup window and direct callers.
8. Control rejection feedback requires the same current handle, so a replaced call cannot add an error to its successor.
9. Failed lifecycle-report copy now reads `The call status could not be updated. Please reload the page.` Both acknowledgement and terminal-loss expectations were updated; no automatic retry is claimed.

The frontend-design skill informed the copy choices: neutral, user-facing fallback and accurate recovery guidance. Existing layout, styling, typography, controls, and visual hierarchy are preserved. TDD was used for the behavior changes. Only FakeVideoProvider/FakeRoom and existing frontend call-boundary fakes were used; no LiveKit/network/hardware rehearsal was performed.

## RED evidence

Command from repository root, before production edits:

```text
npx vitest run apps/api/test/video.test.ts packages/web-common/test/call.test.ts apps/family/test/CallPanel.test.tsx apps/family/test/App.test.tsx
```

Runner output (all failing cases and assertion messages; repetitive DOM/assertion stack dumps omitted):

```text
RUN v3.2.7 D:/ontaru/AGI carehouse/oncare_app
packages/web-common/test/call.test.ts (17 tests | 5 failed)
  reports camera publishing before microphone startup completes
    expected last spy call with { camera: true, mic: false }; received undefined
  loss during pending camera startup stops continuation and late notifications
    promise resolved a CallHandle instead of rejecting
  loss during pending microphone startup stops continuation and late notifications
    promise resolved a CallHandle instead of rejecting
  pending mic control does not notify after leave
    expected spy to be called 1 times, but got 2 times
  pending camera control does not notify after leave
    expected spy to be called 1 times, but got 2 times
apps/family/test/CallPanel.test.tsx (10 tests | 3 failed)
  early startup loss leaves the late handle while the panel stays mounted
    expected leave spy to be called 1 times, but got 0 times
  a replaced call's pending control rejection cannot show feedback on the new call
    expected <p class="error" role="alert"> to be null
  an unavailable resident name uses neutral localized waiting text
    unable to find Waiting for your family member to join…
    rendered Waiting for  to join…
apps/family/test/App.test.tsx (8 tests | 2 failed)
  shows connection feedback when the real-presence acknowledgement fails without retrying
    expected The call status could not be updated. Please reload the page.
    received The call could not connect. Trying again.
  posts terminal connection loss and keeps failure feedback when reporting it fails
    expected The call status could not be updated. Please reload the page.
    received The call could not connect. Trying again.
apps/api/test/video.test.ts (21 tests | 8 failed)
  staff stop closes a awaiting_resident_consent room once
  staff stop closes a connecting room once
  staff stop closes a active room once
  gateway connecting -> safety_stopped closes the room once
  gateway active -> safety_stopped closes the room once
  gateway connecting -> cancelled closes the room once
  gateway active -> cancelled closes the room once
  API close disposes the room transition subscription
    each: expected [] to deeply equal [visit id]
Test Files 4 failed (4)
Tests 18 failed | 38 passed (56)
Start at 18:43:39
Duration 10.81s
Exit code 1
```

All failures were expected behavior/copy assertions, not test-load errors. Existing token policy, both connection-loss states, and sleep-free cleanup assertions already passed. Before GREEN the gateway test fixtures were completed with the contract's required `at` timestamps, and the app-close test gained an independent still-active visit to ensure it detects a missing unsubscribe even when once-only bookkeeping is present.

## GREEN evidence

Same focused command:

```text
npx vitest run apps/api/test/video.test.ts packages/web-common/test/call.test.ts apps/family/test/CallPanel.test.tsx apps/family/test/App.test.tsx

RUN v3.2.7 D:/ontaru/AGI carehouse/oncare_app
✓ packages/web-common/test/call.test.ts (17 tests) 48ms
✓ apps/family/test/CallPanel.test.tsx (10 tests) 772ms
✓ apps/family/test/App.test.tsx (8 tests) 4132ms
✓ apps/api/test/video.test.ts (21 tests) 7399ms
Test Files 4 passed (4)
Tests 56 passed (56)
Start at 18:45:29
Duration 10.61s
Exit code 0
```

Covering checks:

```text
npx vitest run apps/api/test/transitions.test.ts apps/api/test/visit-actions.test.ts apps/api/test/dispatch.test.ts apps/api/test/robots.test.ts apps/resident/test/InCall.test.tsx apps/resident/test/App.test.tsx packages/web-common/test/i18n.test.ts

RUN v3.2.7 D:/ontaru/AGI carehouse/oncare_app
✓ packages/web-common/test/i18n.test.ts (3 tests) 10ms
✓ apps/resident/test/InCall.test.tsx (5 tests) 972ms
✓ apps/resident/test/App.test.tsx (11 tests) 1248ms
✓ apps/api/test/transitions.test.ts (14 tests) 4175ms
✓ apps/api/test/robots.test.ts (8 tests) 3875ms
✓ apps/api/test/visit-actions.test.ts (12 tests) 5746ms
✓ apps/api/test/dispatch.test.ts (21 tests) 8604ms
Test Files 7 passed (7)
Tests 74 passed (74)
Start at 18:46:16
Duration 12.75s
Exit code 0

npx tsc -b
[no output]
Exit code 0
```

Self-review strengthened the existing family integration regression to combine early startup loss with failed API reporting and a mounted panel, and asserted disconnect before resolving pending startup. No further production edit was needed. Final rerun of those two changed test files and TypeScript:

```text
npx vitest run apps/family/test/App.test.tsx packages/web-common/test/call.test.ts

RUN v3.2.7 D:/ontaru/AGI carehouse/oncare_app
✓ packages/web-common/test/call.test.ts (17 tests) 47ms
✓ apps/family/test/App.test.tsx (8 tests) 4129ms
Test Files 2 passed (2)
Tests 25 passed (25)
Start at 18:47:19
Duration 7.33s
Exit code 0

npx tsc -b
[no output]
Exit code 0

git diff --check
[no output]
Exit code 0
```

Final total: 130 distinct impacted tests passing across 11 files; the final 25-test run is a rerun, not additional coverage. Controller owns the complete checkout suite and both frontend builds.

## Self-review and concerns

- Reviewed the full production diff against all nine findings and the task brief interfaces/rulings. Tokens, authorization paths, TTL/grants, API state ownership, and no-recording constraints are unchanged.
- Once-only room deletion covers successful end transitions while invalid/repeated transitions cannot trigger the subscriber. The ending bookkeeping is removed on terminal completion and cleared at app close.
- The shutdown hook owns the new subscription's lifetime; a distinct visit transitioning after close proves it is detached.
- Deferred camera/microphone operations cannot announce fresh state or start the next startup operation after terminal cleanup. Loss disconnects before notifying consumers, and later leave/catch paths reuse the disconnect promise.
- The fallback is localized at rendering, and lifecycle failure copy no longer promises a nonexistent retry. Frontend tests check user-visible outcomes.
- No outstanding scoped findings. Remaining limitation: actual LiveKit interoperability, Safari permissions/audio, hardware media behavior, and two-device/network rehearsals remain unverified by explicit constraint. No observations from such tests are claimed.
