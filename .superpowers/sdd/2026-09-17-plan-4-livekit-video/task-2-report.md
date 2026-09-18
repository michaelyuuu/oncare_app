# Task 2 report — shared `createCall` wrapper

## TDD evidence

### RED

Command:

```text
npx vitest run packages/web-common/test/call.test.ts
```

Output (exit 1):

```text
RUN  v3.2.7 D:/ontaru/AGI carehouse/oncare_app

FAIL  |web| packages/web-common/test/call.test.ts [ packages/web-common/test/call.test.ts ]
Error: Failed to resolve import "../src/call" from "packages/web-common/test/call.test.ts". Does the file exist?

Test Files  1 failed (1)
Tests  no tests
Duration  1.98s
```

The failure was the expected missing production module, before `src/call.ts` existed.

### GREEN — focused wrapper suite

Command:

```text
npx vitest run packages/web-common/test/call.test.ts
```

Output (exit 0):

```text
RUN  v3.2.7 D:/ontaru/AGI carehouse/oncare_app
✓ |web| packages/web-common/test/call.test.ts (11 tests) 23ms

Test Files  1 passed (1)
Tests  11 passed (11)
Duration  1.71s
```

### Required final verification

Command:

```text
npx vitest run packages/web-common
```

Output (exit 0):

```text
RUN  v3.2.7 D:/ontaru/AGI carehouse/oncare_app
✓ |web| packages/web-common/test/events.test.ts (5 tests) 15ms
✓ |web| packages/web-common/test/i18n.test.ts (3 tests) 5ms
✓ |web| packages/web-common/test/api.test.ts (4 tests) 17ms
✓ |web| packages/web-common/test/call.test.ts (11 tests) 28ms

Test Files  4 passed (4)
Tests  23 passed (23)
Duration  2.10s
```

Command:

```text
npx tsc -b
```

Output (exit 0): no diagnostics.

Command:

```text
git diff --check
```

Output (exit 0): no whitespace errors.

## Changes

- Added `packages/web-common/src/call.ts` with the specified public interfaces and `createCall`.
- Added `livekit-client` with the required `^2.5.0` range and updated the lockfile (currently resolves to 2.22.3).
- Exported the wrapper from `packages/web-common/src/index.ts`.
- Added a fake-Room-only test suite; it performs no network or real LiveKit operations.
- Publishing calls enable local media and report local state. Subscribe-only calls never enable camera or microphone, including through later setters.
- Initial remote presence is reported after successful startup. Once a remote participant has existed, absence for 10 seconds reports loss once; return, leave, disconnect, and successful reconnection cancel the deadline as applicable.
- `Reconnecting` starts the deadline after prior presence even when LiveKit retains stale participant-map entries. Reconnect messages are generic and contain neither URL nor token.
- Only the first remote camera is attached. Remote audio tracks are tracked individually, receive clamped volume updates while subscribed, and emit `null` only after the last attached audio track leaves.
- Leave and startup-failure cleanup remove attached media and disconnect idempotently. Intentional leave, startup failure, terminal loss, duplicate disconnects, and later stale events cannot produce duplicate or stale callbacks.

## Files

- `packages/web-common/src/call.ts`
- `packages/web-common/src/index.ts`
- `packages/web-common/package.json`
- `package-lock.json`
- `packages/web-common/test/call.test.ts`
- `.superpowers/sdd/2026-09-17-plan-4-livekit-video/task-2-report.md`

## Self-review and concerns

- Reviewed the task brief and binding constraints/rulings line by line against the implementation and tests.
- Checked realistic mutations: removing the publish guard, changing the 10-second bound, failing to cancel timers, accepting duplicate loss callbacks, attaching a second camera, retaining unsubscribed audio, omitting cleanup, or logging connection inputs would each fail a focused assertion.
- The wrapper deliberately leaves reconnection mechanics to the LiveKit SDK; its timer only reports the binding loss condition.
- Per the ruling, real-token, real-network, and two-device/browser media rehearsals were not run. Browser autoplay/device-permission behavior remains pending integration rehearsal.
- Tests use structural fakes for LiveKit because the task explicitly prohibits network/real LiveKit tests; TypeScript compilation verifies the production code against the installed real SDK types.

## Fix round 1 — terminal timeout media cleanup

Reviewer finding: a reconnect/absence timeout called `onLost` and disabled later event handlers without first detaching retained remote media. LiveKit may retain participant and track entries while reconnecting, so relying on a later unsubscribe, disconnect, or caller `leave()` could leave video/audio elements alive.

### RED

Command:

```text
npx vitest run packages/web-common/test/call.test.ts
```

Output (exit 1):

```text
❯ |web| packages/web-common/test/call.test.ts (12 tests | 1 failed) 27ms
× createCall > reconnect timeout removes attached media and reports terminal callbacks once
  → expected "spy" to be called 1 times, but got 0 times

AssertionError: expected "spy" to be called 1 times, but got 0 times
❯ packages/web-common/test/call.test.ts:232:26
    expect(video.detach).toHaveBeenCalledTimes(1);

Test Files  1 failed (1)
Tests  1 failed | 11 passed (12)
Duration  2.64s
```

### GREEN

The terminal `reportLost` path now calls the existing media cleanup before callbacks are deactivated. The disconnected path delegates to that same terminal path, preventing duplicate cleanup/null notifications.

Command:

```text
npx vitest run packages/web-common/test/call.test.ts
```

Output (exit 0):

```text
✓ |web| packages/web-common/test/call.test.ts (12 tests) 22ms

Test Files  1 passed (1)
Tests  12 passed (12)
Duration  1.81s
```

Command:

```text
npx tsc -b
```

Output (exit 0): no diagnostics.

Regression coverage attaches one video and one audio track, advances the reconnect timeout deterministically, then emits stale disconnect/unsubscribe events. It verifies one detach/remove per element, one terminal `null` per media callback, and one `onLost` call.
