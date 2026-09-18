# Task 4 report — family live call panel

## Outcome

Implemented the family LiveKit call panel and connected visit state to actual remote-participant presence. The panel owns scoped media, local device controls, exactly-once lifecycle reporting, and cleanup. The former automatic connected effect and retry trigger are removed.

## TDD evidence

### RED — panel contract

Command:

```text
npx vitest run apps/family/test/CallPanel.test.tsx
```

Observed: exit 1; `Failed to resolve import "../src/components/CallPanel"`; 1 failed suite. This was the intended missing-feature failure before production implementation.

### GREEN — panel contract

Same command after minimal implementation: exit 0; 1 file passed, 5 tests passed. Coverage includes initial-state preview attachment after handle resolution, scoped remote audio/video, controls, exactly-once callbacks, stale callbacks, latest closures, late-handle cleanup, token 409 waiting, and non-409 startup loss.

### RED — Visit integration

Command:

```text
npx vitest run apps/family/test/App.test.tsx
```

Observed: exit 1; 3 of 8 tests failed. The failures showed that the panel was not rendered, presence could not drive `/connected`, and loss could not drive `/connection_lost`. The existing automatic acknowledgement was still visible in the rendered feedback.

### GREEN — Visit integration

Same command after integration: exit 0; 1 file passed, 8 tests passed. The end-to-end family test now proves no connected POST occurs before remote presence and that presence advances the visit to active. Failure tests prove connected/lost report errors stay visible without the old blanket retry loop.

## Final verification

```text
npx vitest run apps/family packages/web-common
```

Exit 0: 7 files passed, 40 tests passed.

```text
npx tsc -b
```

Exit 0, no diagnostics.

```text
npm run build -w @oncare/family
```

Exit 0; 42 modules transformed and production assets emitted. Vite retained its non-failing warning that the 804.92 kB JavaScript chunk exceeds 500 kB.

## Design pass and critique

Preserved the established family paper `#f8f8f2`, ink `#20342f`, pine `#25604b`, sage `#dce8df`, Georgia title, and Arial control language. The remote person is the sole dominant element in a stable responsive 4:3 frame; the mirrored muted self-preview is a small upper-right inset; status and two controls sit below the face without overlap. Focus styling remains inherited and visible.

The initial idea risked becoming a generic rounded video card. The revision avoids a new card system or decorative gradient and uses the existing restrained border/radius/shadow vocabulary. Visual emphasis is spent only on the live frame; the preview disappears until media exists, and the control copy is direct device-state language.

## Files

- `apps/family/src/components/CallPanel.tsx` — call ownership, media hosts, controls, lifecycle and cleanup.
- `apps/family/src/pages/Visit.tsx` — presence/loss API integration; removed automatic connected effect/retry trigger.
- `apps/family/src/styles.css` — responsive remote frame, inset preview, status and controls.
- `apps/family/test/CallPanel.test.tsx` — focused call panel contract.
- `apps/family/test/App.test.tsx` — fake `createCall` integration and report-failure coverage.
- `packages/web-common/src/i18n/en.json` — family call labels/status.
- `docs/demo-visit-flow.md` — real flow/setup and honest pending rehearsal bounds.

## Self-review

- Remote video and audio are hosted inside the component, not appended globally.
- The initial `onLocalState`/late handle race is handled by attaching preview again after `createCall` resolves.
- Connected and lost callbacks are guarded exactly once, ignore stale callbacks, and use the latest prop closures without rejoining.
- Loss calls local leave before the Visit callback posts to the API; an API failure therefore cannot leave local media running.
- Handles that resolve after unmount are immediately left; normal unmount leaves once.
- Token 409 remains in the waiting state for the next server refresh. Other token/create failures report loss and Visit surfaces report failure.
- No automatic connection acknowledgement or timer retry remains.
- Mutation check: removing publish mode, preview reattachment, media scoping, callback guards, cleanup, 409 distinction, presence gate, or either report path breaks a focused test.

## Concerns and deferred physical evidence

- The real LiveKit/network/camera/microphone rehearsal is explicitly prohibited for this task and remains pending. No timing was invented. The demo guide records the expected 5-second two-way-media and 10-second remote-absence bounds.
- Production build passes with the existing Vite large-chunk advisory; code splitting is outside this task's scope.
