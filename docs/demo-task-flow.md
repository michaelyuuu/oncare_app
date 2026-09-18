# Tray-mode task-flow demo

This demo uses the mock gateway only. It sends real authenticated API requests and WebSocket messages, but it does not command an arm or any physical hardware. Tray loading and receipt are explicit human actions.

## Prerequisites and four screens

Use Node 24 and Python 3.12. Install the repository dependencies, copy `apps/api/.env.example` to `apps/api/.env`, and use only development credentials. A real video call additionally requires working LiveKit values in that file; without them, demonstrate the task only after reaching a visit state that exposes **Ask the robot** through the supported demo/test setup. The task panel is intentionally scoped to a visit in `connecting`, `active`, or `completed` state.

Start the API and three web apps from the repository root:

```powershell
npm run dev
```

Start the mock gateway in another terminal. This is simulation only:

```powershell
cd robot_gateway
$env:ONCARE_API_URL = "ws://127.0.0.1:3000"
$env:ONCARE_ROBOT_TOKEN = "robot-demo-token"
$env:ROBOT_ADAPTER = "mock"
.venv/Scripts/python -m gateway
```

Arrange four visible screens:

1. Family phone: `http://localhost:5174`, sign in as `family` / `family-demo-pass`.
2. Resident iPad: `http://localhost:5173`. On first launch, hold the bottom-right corner to open settings, enter device token `device-demo-token`, and save it.
3. Staff console: `http://localhost:5175`, sign in as `staff` / `staff-demo-pass`.
4. Mock gateway log: keep the Python terminal visible. Confirm it says `SIMULATED ROBOT: adapter=mock` and connects to the API.

The seeded staff release PIN is `2468`. The credentials and PIN are synthetic fixtures, not production secrets.

## Click-through: approved water delivery

1. On the family phone, select **Send the robot to visit** for Demo Resident. On the staff console, approve the pending visit. Watch the mock gateway log receive the visit intent and report arrival. On the resident iPad, tap **Answer**. Complete the call connection flow if LiveKit is configured.
2. While the call is connecting or active, the family phone can open **Ask the robot**. For the clearest handover sequence, end the real call first and then open **Ask the robot** on the completed visit. The delivery notice has lower display precedence than an incoming or active call: if a delivery arrives while the call is still shown, the resident iPad continues to show the call; the delivery notice appears after the call ends.
3. Type `Could you bring Mom the water bottle?` and click **Send**. Alternatively, hold **Hold to speak**, say the same sentence, and release. The family phone shows a confirmation card naming the water bottle and Demo Resident's bedside table. The mock gateway log must not show a `deliver_item` intent yet.
4. Click **Yes, send the robot**. The family phone advances to **Waiting for staff approval**. The staff console gains a pending task with **Approve** and **Deny**. The gateway log still must not show a `deliver_item` intent.
5. On the staff console, click **Approve**. Only now should the mock gateway log show one `deliver_item` intent in tray mode, acknowledge it, and navigate to the pickup station. The family progress moves through approval and pickup.
6. When the staff console offers **Loaded**, narrate that staff would load the tray, but perform no physical action; click **Loaded** to advance the software-only demo. The gateway log reports the delivery leg and arrival. The family phone advances toward delivery.
7. After any call screen has ended, the resident iPad shows **Your water bottle is here** and one large **I have it** button. Tap it. The API records `verifying_delivery`, and the mock gateway starts its simulated return to standby.
8. Keep all screens open until the gateway reports the standby `completed_leg`. The family phone then shows the task as done, the resident iPad returns home, and the staff queue clears the task. Receipt alone does not complete the task; arrival at standby does.

## Expected 12-entry audit

In the staff console audit footer, filter to the resident if desired. The task must show these states in order:

| # | State | Actor |
|---:|---|---|
| 1 | `parsed` | `system` |
| 2 | `awaiting_user_confirmation` | `system` |
| 3 | `awaiting_policy_or_staff` | `family` |
| 4 | `queued` | `staff` |
| 5 | `navigating_to_pickup` | `robot` |
| 6 | `locating_item` | `robot` |
| 7 | `grasping` | `staff` |
| 8 | `verifying_grasp` | `staff` |
| 9 | `navigating_to_delivery` | `staff` |
| 10 | `placing` | `robot` |
| 11 | `verifying_delivery` | `device` |
| 12 | `completed` | `robot` |

The audit contains fixed IDs, states, actor types, and reason codes only. The sentence spoken or typed by the family member must not appear in the audit, task row, approval row, or robot command.

## Failure demo: STOP and PIN release

1. Begin another approved water-bottle delivery and wait until it is navigating to pickup or delivery.
2. On the staff console, click the large red **STOP** button. The family phone shows **The robot was stopped for safety** and the task audit ends in `safety_stopped` with reason `staff_stop`. STOP does not auto-resume.
3. Click **Release stop**, enter PIN `2468`, and submit. This releases the robot safety latch only; it does not resume or recreate the stopped task. Start a new request if the delivery still needs to happen. Do not test this flow against physical hardware.

## Failure demo: prohibited item

1. On the family phone, open **Ask the robot**, type `bring her medication`, and click **Send**.
2. The family phone immediately shows **That item can't be delivered by the robot**. No confirmation card appears, no staff approval is offered, and the mock gateway receives no delivery intent.
3. In the staff audit footer, verify the task has `parsed` followed by `rejected`; the rejected row has reason `prohibited_item`. The original sentence is not stored.

## Demo limitations

- The mock adapter simulates navigation timing and standby return; it does not exercise motors, perception, grasping, tray sensors, or an arm.
- Real LiveKit camera/audio behavior needs valid deployment credentials. Staff remote camera resume also requires LiveKit remote-unmute to be enabled; see [staff-camera-control.md](staff-camera-control.md).
- Browser speech input depends on Web Speech support and microphone permission. Typed input exercises the same deterministic parser and policy path.
- Use a fresh seeded demo database when an exact audit sequence matters, or filter the audit by resident and time so prior demo runs are not confused with the current task.
