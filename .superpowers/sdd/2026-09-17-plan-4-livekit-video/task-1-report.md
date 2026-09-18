# Task 1 report: API video adapter and token lifecycle

## Result

Implemented the `VideoProvider` boundary with LiveKit and deterministic fake implementations, per-identity visit token issuance, and visit-driven room cleanup. The API defaults to the fake provider unless all three LiveKit environment values are present.

## Changes

- Added `VideoGrant`, `VideoProvider`, role grant mapping, `LiveKitProvider`, `FakeVideoProvider`, and environment provider selection.
- Added `POST /visits/:id/token` with owner/device/staff authorization, role- and state-specific callability, 600-second grants, principal identity, and display-name-only token metadata.
- Added `connection_lost` for family/device from `connecting` or `active` to `connection_failed`.
- Added fire-and-forget room cleanup after successful transitions to ending/terminal states only when the pre-transition visit was token-eligible or already connected.
- Covered prejoin device-token cleanup on resident decline, while preserving no-room behavior for cancellation from `accepted`.
- Prevented duplicate cleanup on rejected/repeated terminal actions by requiring a successful state change.
- Logged background close failures with only the visit ID and a fixed message.
- Wired provider injection through `buildApp`, registered the video route, loaded optional `apps/api/.env`, and logged only the provider kind.
- Added `livekit-server-sdk` and lockfile entries.
- Updated `makeTestApp` to inject and return a `FakeVideoProvider`.

## TDD evidence

### RED

Command:

```text
npx vitest run apps/api/test/video.test.ts
```

Observed expected failure:

```text
FAIL apps/api/test/video.test.ts
Error: Cannot find module '../src/services/video'
Test Files 1 failed (1)
```

This established that the new test suite could not pass before the provider implementation existed.

### GREEN

Focused command:

```text
npx vitest run apps/api/test/video.test.ts
```

Output summary:

```text
Test Files 1 passed (1)
Tests 11 passed (11)
```

Full API command:

```text
npx vitest run apps/api
```

Output summary:

```text
Test Files 15 passed (15)
Tests 117 passed (117)
```

TypeScript command:

```text
npx tsc -b
```

Output: no diagnostics; exit code 0.

## Files

- `apps/api/src/services/video.ts` (new)
- `apps/api/src/routes/video.ts` (new)
- `apps/api/src/services/visits.ts`
- `apps/api/src/app.ts`
- `apps/api/src/server.ts`
- `apps/api/package.json`
- `package-lock.json`
- `apps/api/test/helpers.ts`
- `apps/api/test/video.test.ts` (new)

## Self-review

- Token grants are isolated from robot command authorization and contain only the specified grant fields plus identity/display name.
- Device prejoin access is limited to `awaiting_resident_consent`; family/staff remain blocked until `connecting`.
- Staff tokens cannot publish.
- Missing visits return 404, unrelated principals return 403, and non-callable states return `{ error: "not_callable" }` with 409.
- LiveKit room deletion converts websocket URLs to HTTP(S), is idempotent for not-found responses, and rethrows other failures.
- Room cleanup uses the old row for eligibility and the changed new row for terminal detection, which covers decline/cancel/connection loss/end without duplicate close calls on rejected actions.
- No secrets are logged or read during testing, and tests use only the fake provider.
- `git diff --check` is run before commit.

## Concerns and limitations

- The real-token smoke test was intentionally omitted because the task ruling prohibits real LiveKit/network tests. LiveKit credentials, generated JWT payloads against a real service, and live room deletion remain unverified in this environment.
- `livekit-server-sdk` resolved to 2.19.0 under the requested compatible range `^2.7.0`; its declared Node engine is `>=19`.
