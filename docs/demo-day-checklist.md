# Demo-day checklist

This is a morning-of checklist, not permission to bypass the safety gates. Keep the mock path selected unless the owner has explicitly approved an attended Jetson rehearsal.

## Before opening the demo

- [ ] `npm run demo:check` passes for the API and three web URLs.
- [ ] On the Jetson, an attendant runs `./ontaru doctor` and records the result in the dated rehearsal note; do not run this from Windows.
- [ ] If hardware is used, the robot is at standby, the lift is at rest, the map and approved locations are current, and a person is beside the robot.
- [ ] The resident iPad is in Guided Access with Auto-Lock off for the session; camera/microphone permissions and the device token are tested.
- [ ] LiveKit environment variables are present if real media is required; otherwise tell observers that the call is screen-only/fake-provider.
- [ ] Family, resident, and staff logins are tested with the synthetic credentials in the README.
- [ ] Run `npm run bench:visit` only with the API and mock gateway already running; record its real dated output, or mark it not run.

## Failure drills

- [ ] Simulate a lost call and confirm the resident returns Home / the family sees a connection failure within the documented bounded timeout.
- [ ] Use staff STOP during a physical task and confirm `safety_stopped`; do not resume without the staff PIN and a safety check.
- [ ] Submit an ambiguous or prohibited item request and confirm clarification/rejection with no robot delivery intent.

## Roles and STOP

- [ ] Name one person beside the robot and one person operating the staff console.
- [ ] STOP order: press the staff console STOP, use the authorized `nav_web` STOP page if the Jetson adapter is active, then remove robot power only under the facility's emergency procedure. Never send raw coordinates or use `/joy`/arm ports.
- [ ] If any state, map, health, or safety observation is unexpected: stop, leave the run marked failed/not-run, and preserve evidence.

## After the demo

- [ ] Export the staff audit/benchmark CSV only from genuine runs, redact identifiers as required, and record the run date and software/map versions.
- [ ] End Guided Access and restore the facility's Auto-Lock policy.
