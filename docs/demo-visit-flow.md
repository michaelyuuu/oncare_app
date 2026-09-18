# Demo visit flow

This is the Plan 3 visit slice. It demonstrates the mock robot, the resident consent flow, and the call-state placeholder; actual video/media arrives in Plan 4. Task help and item delivery are Plan 5 work and are not part of this rehearsal.

## Start the demo

Run these four PowerShell terminals from the repository root (the mock command changes into `robot_gateway`):

1. API:
   ```powershell
   npm run dev -w @oncare/api
   ```
2. Resident kiosk:
   ```powershell
   npm run dev -w @oncare/resident
   ```
3. Family app:
   ```powershell
   npm run dev -w @oncare/family
   ```
4. Mock gateway:
   ```powershell
   Set-Location robot_gateway
   $env:ONCARE_ROBOT_TOKEN = 'robot-demo-token'
   $env:ROBOT_ADAPTER = 'mock'
   .\.venv\Scripts\python.exe -m gateway
   ```

For the three web processes, the simpler consolidated alternative is `npm run dev` in one terminal; still run the mock gateway in a second terminal. Before each rehearsal, run `npm run demo:check`. It starts nothing and probes the default API, resident, and family URLs.

## Click-through: handover section 8, steps 1-5

1. **Family phone — request a visit.** Sign in and select the resident card, then request the visit. The family phone shows visit progress; the resident iPad remains at Home, and the mock gateway receives the request after policy approval. The audit begins with `awaiting_policy_or_staff`, then `accepted`.
2. **Mock gateway — travel to the room.** The mock logs accepted travel and the family phone shows the robot travelling. The resident iPad remains at Home. The audit adds `robot_en_route`.
3. **Resident iPad — incoming visit.** When the mock arrival is reported, the iPad announces the incoming call and shows its one primary answer action; the family phone reports that the resident is being asked. The audit adds `awaiting_resident_consent`.
4. **Resident iPad — answer.** Tap the answer action. The iPad enters the connecting screen and the family phone shows connecting progress. The audit adds `connecting`.
5. **Family phone — connected then end.** The current Plan 3 screen is a call placeholder: the family client reports connected automatically, while media is deferred to Plan 4. End the visit from the family flow. The iPad shows the call/ending state then returns to Home; the family phone reports the completed visit. The API records `active`, then records both `ending` and `completed` for the end action.

The expected visit transition audit `toState` values, in order, are:

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

`requested` is the initial database state, not a transition audit row. During the rehearsal, both web clients should display the prominent **SIMULATED ROBOT** badge once the mock gateway heartbeat is visible.
