# Demo visit flow

This flow includes the Plan 4 LiveKit video call after the mock-robot handoff. Task help and item delivery are Plan 5 work and are not part of this rehearsal. OnCare does not record or store call audio or video.

## Start the demo

Run these four PowerShell terminals from the repository root (the mock command changes into `robot_gateway`):

1. API: `npm run dev -w @oncare/api`
2. Resident kiosk: `npm run dev -w @oncare/resident`
3. Family app: `npm run dev -w @oncare/family`
4. Mock gateway:

   ```powershell
   Set-Location robot_gateway
   $env:ONCARE_ROBOT_TOKEN = 'robot-demo-token'
   $env:ROBOT_ADAPTER = 'mock'
   .\.venv\Scripts\python.exe -m gateway
   ```

For the three web processes, the consolidated alternative is `npm run dev`; still run the mock gateway separately. Before each rehearsal, run `npm run demo:check`. It starts nothing and probes the default API, resident, and family URLs.

Populate the LiveKit server URL, API key, and API secret in `apps/api/.env`; they must point to the same project and remain only in that API environment file. The family browser and resident device must grant camera and microphone permission. Use HTTPS (or localhost during same-machine development) so browsers permit media capture.

## Click-through: handover section 8, steps 1-5

1. **Family phone — request a visit.** Sign in, select the resident card, and request the visit. The resident iPad remains at Home while the mock gateway receives the request after policy approval. The audit begins with `awaiting_policy_or_staff`, then `accepted`.
2. **Mock gateway — travel to the room.** The mock logs accepted travel and the family phone shows the robot travelling. The audit adds `robot_en_route`.
3. **Resident iPad — incoming visit.** After mock arrival, the iPad announces the incoming call and shows its answer action. The audit adds `awaiting_resident_consent`.
4. **Resident iPad — answer.** Tap Answer. The iPad and family phone enter connecting. The audit adds `connecting`.
5. **Family phone — connected then end.** The family page requests its scoped token and shows a waiting call panel. The visit becomes active only after real remote-participant presence. Confirm the resident video fills the main frame, the muted family preview appears, two-way audio works, Mute/Unmute and Camera off/on follow local state, the family stepper shows **On the call**, and the resident identifies the caller. End the visit. The iPad returns Home and the family page reports completion. The API records `active`, `ending`, then `completed`.

The expected transition audit `toState` values are:

```text
awaiting_policy_or_staff
accepted
robot_en_route
awaiting_resident_consent
connecting
active
ending
completed
```

`requested` is the initial database state, not a transition row. Both clients should display **SIMULATED ROBOT** once the mock gateway heartbeat is visible.

## Pending physical-device rehearsal

The real-token, real-network, camera/microphone rehearsal has not been run in this development environment. It remains pending on a family Chrome session and a resident Safari/iPad session (or a second isolated browser profile) with the mock gateway running. Automated tests do not prove browser permission, hardware, or LiveKit-project interoperability.

Measure the interval from resident Answer to two-way media; the acceptance bound is **within 5 seconds**. Then remove the resident device's network for at least the shared call layer's **10-second remote-absence bound** and confirm the API transitions to `connection_failed`, family shows **The call could not connect**, and the resident returns Home after server refresh. Record measured results here only after the rehearsal is actually performed.
