# Claude Code Handover Prompt — AGI Carehouse Family-to-Robot App

You are taking over the product definition, technical architecture, and prototype implementation for an iPad-centered care-facility robotics application.

Read this document completely before modifying code. First inspect the repository and report what already exists, what is working, what is mocked, and what is missing. Do not assume that a component works merely because a file or UI exists.

## 1. Product vision

Build a **Family-to-Robot Care Platform** for care facilities.

The immediate interface is an iPad mounted on the robot's chest. It allows an older adult to communicate with family members outside the facility. Over time, a family member should be able to:

1. Start or schedule a video visit.
2. Ask the robot to go to the resident or an approved meeting location.
3. Request safe physical assistance through voice, such as bringing water or another approved item.
4. See task status without directly controlling low-level robot motion.

The long-term product is not merely a video-call app or a remote-controlled robot. It is a facility-managed system connecting residents, family members, staff, robot autonomy, teleoperators, and the facility's broader IoT/AI orchestration layer.

Core product statement:

> A family member's care and intent can move from a remote conversation into a safe, authorized action in the physical world.

## 2. Current hardware context

The robot platform is expected to include:

- Two Seeed reBot Arm B601-DM arms with grippers.
- A mobile base, currently designed around mecanum wheels.
- NVIDIA Jetson AGX Orin 32 GB as the robot computer.
- Intel RealSense D435 on the head for wide-scene RGB-D perception and navigation support.
- One Intel RealSense D405 on each wrist for close-range manipulation perception.
- An iPad mounted on the robot's chest.
- ROS/ROS 2 as the expected robot integration layer.
- Physical emergency-stop hardware independent of the application.

Do not assume all hardware is currently assembled, calibrated, or available. Determine actual repository and hardware status before selecting implementation paths.

## 3. Validated market lessons

Relevant products and prototypes include:

- GrandPad and KOMP: senior-friendly communication, trusted contacts, simplified resident interface.
- ElliQ: proactive companion interactions and a separate caregiver app.
- temi: autonomous navigation, video interaction, voice control, SDK integration.
- Double 3: click-to-drive shared autonomy and local obstacle avoidance.
- Ohmni/OhmniCare: family or clinician telepresence without requiring the older adult to operate the device.
- GiraffPlus: integration of telepresence, home/facility sensors, and remote care.
- Labrador Retriever: reliable item delivery through standardized trays and fixed pickup locations rather than arbitrary manipulation.
- Toyota HSR and Hello Robot Stretch: research-grade mobile manipulation and assistive fetching.
- HomeRobot OVMM: open-vocabulary mobile manipulation remains research-grade; reported real-world baselines were far from product-level reliability.

The market has substantially validated:

- Simple senior video calling.
- Approved family-member access.
- Remote telepresence and autonomous navigation to known locations.
- Remote clinical visits.
- Standardized tray or known-location delivery.

The market has **not** validated at product reliability:

- Arbitrary voice-requested object retrieval in unstructured care rooms.
- Family members directly controlling dual arms near residents.
- General-purpose manipulation with no staff or trained-operator fallback.

## 4. Required user surfaces

Treat these as separate products sharing one backend. Do not collapse them into one UI with role-based hidden buttons unless there is a strong implementation reason.

### A. Resident iPad app

Primary users may have low vision, hearing loss, reduced dexterity, or cognitive impairment.

Initial functions:

- Photo-based trusted contacts.
- One-action answer or decline.
- Video and audio calling.
- Large subtitles and volume controls.
- Family photos and voice messages.
- Call-caregiver action.
- Clear camera, microphone, and remote-control state.
- Staff PIN for configuration and exiting kiosk mode.
- Automatic return to the home state after inactivity or recoverable errors.
- Optional voice prompts in English, Chinese, and Japanese; design localization-ready even if only one language is implemented initially.

Do not place base or arm teleoperation controls in the resident UI.

### B. Family web/mobile app

Initial functions:

- Secure authentication.
- Relationship to an authorized resident.
- Start or schedule a video visit.
- Send photos and voice messages.
- See a privacy-preserving availability state such as `available`, `in_activity`, `resting`, or `not_available`.
- Request a robot visit.
- Submit an item request by voice or text.
- Confirm the structured interpretation before physical execution.
- See task progress and failure status.

Later functions:

- Click-to-go movement in approved areas.
- Request camera orientation changes.
- Receive approved summaries and notifications.

Never expose raw motor, ROS topic, or arm-joint controls to family users.

### C. Staff console

Required eventual functions:

- Incoming visit and task approvals.
- Resident consent settings.
- Family permissions.
- Robot location, battery, call, and task states.
- Restricted locations and time windows.
- End call, pause camera, stop task, or take control.
- Audit log and incident review.
- Task queue and priorities.
- Clear indication of every robot currently streaming audio/video.

### D. Trained operator console

This is separate from the family app and may be out of the first MVP.

Future functions:

- Head D435 view and depth data.
- Both D405 wrist views.
- Base and arm teleoperation.
- Collision, force/torque, and joint-state display.
- Recovery after autonomous failure.
- Emergency stop request, while recognizing that software stop is not a substitute for the physical safety circuit.
- Episode recording and task annotation for learning.

## 5. Safety and product rules

These are architectural constraints, not optional UI enhancements.

1. The iPad is an HMI, not the robot's safety controller.
2. The family client must never connect directly to ROS 2, motor controllers, or arm drivers.
3. Cloud commands must be high-level intents such as `request_visit`, `go_to_approved_location`, or `deliver_approved_item`.
4. A local Robot Gateway must authenticate, validate, expire, and translate intents into robot tasks.
5. Local obstacle avoidance, speed limits, collision checking, geofencing, and emergency-stop logic always override remote commands.
6. Network loss must lead to a defined safe state.
7. No physical action may execute from uncertain speech recognition without confirmation.
8. Prohibited initial items include medication, hot liquid, sharp objects, fragile objects, unidentified items, and anything requiring contact with a resident's body.
9. Initial delivery should place an item on an approved bedside surface or tray, not directly into a resident's hand.
10. Every remote visit, camera session, movement request, approval, denial, and physical task needs an auditable event record.
11. Do not claim HIPAA compliance. Architect for privacy and security, identify what would be required for compliance, and keep protected data out of logs and development fixtures.

## 6. Recommended system boundary

Use an architecture equivalent to:

```text
Family Web/Mobile Client ----\
                              -> Cloud/API + Realtime Signaling + Task Service
Staff Console ---------------/                  |
                                                 |
Resident iPad App -------------------------------|
                                                 |
                                      Secure Robot Gateway
                                                 |
                            ROS 2 navigation / perception / manipulation
```

Separate at least these concepts:

- Identity and authorization.
- Facility, resident, family relationship, robot, and device records.
- Calls and realtime signaling.
- Robot presence/heartbeat.
- High-level task requests.
- Approval policy.
- Robot task execution state.
- Audit events.
- Media/attachments.
- Notifications.

Video traffic and robot command traffic must use separately authorized paths even if the prototype uses the same backend provider.

## 7. Suggested state machines

Implement explicit states rather than scattered booleans.

### Visit state

```text
requested
-> awaiting_policy_or_staff
-> accepted
-> robot_en_route
-> awaiting_resident_consent
-> connecting
-> active
-> ending
-> completed

Failure exits:
denied | resident_unavailable | robot_unavailable | navigation_failed |
connection_failed | cancelled | safety_stopped
```

### Physical task state

```text
draft
-> parsed
-> awaiting_user_confirmation
-> awaiting_policy_or_staff
-> queued
-> navigating_to_pickup
-> locating_item
-> grasping
-> verifying_grasp
-> navigating_to_delivery
-> placing
-> verifying_delivery
-> completed

Failure exits:
rejected | clarification_required | item_not_found | grasp_failed |
navigation_failed | operator_required | cancelled | safety_stopped
```

Store transition time, actor, reason, and correlation/task ID.

## 8. Near-term POC goal

The desired demonstration story is:

1. A daughter opens the family client and requests a visit with her mother.
2. The system creates a visit request and reports that the robot is going to the resident.
3. The resident iPad shows a large incoming-call screen and speaks a prompt.
4. The resident answers with one tap.
5. A two-way video call starts.
6. During the call, the family member says: `Could you bring Mom the water bottle?`
7. Speech is converted into a structured proposal:

```json
{
  "task_type": "deliver_item",
  "item": "water_bottle",
  "recipient": "resident_demo_01",
  "destination": "bedside_table_demo",
  "requires_confirmation": true
}
```

8. The family member confirms it.
9. The UI shows progress through perception, pickup, transport, and placement.
10. The robot performs one real, constrained pickup and placement, or the robot adapter uses an explicitly labelled simulator/mock when hardware is unavailable.
11. The result and any failure are recorded.

## 9. Two-week scope control

Prioritize one reliable end-to-end vertical slice over many disconnected features.

### Must be real

- Resident interface.
- Family interface.
- Bidirectional call or a well-isolated video-call integration.
- Visit/task creation and realtime state updates.
- Voice or text input converted into a structured task.
- Explicit confirmation.
- Robot adapter interface.
- One real manipulation path if working hardware is available.
- Safe failure handling.
- Benchmark logging.

### May be mocked, but must be visibly labelled

- Full facility map.
- Multiple robots.
- EHR integration.
- Production HIPAA infrastructure.
- Elevator integration.
- Multi-resident scheduling.
- Autonomous navigation if the mobile base is unavailable.
- Grasp execution if the arms/cameras are unavailable.

### Explicitly out of scope for the first two weeks

- Arbitrary household-object retrieval.
- Direct family control of the arms.
- Medication delivery.
- Physical contact care.
- Full App Store release.
- Claims of autonomous general-purpose caregiving.

## 10. Manipulation benchmark

For an initial controlled benchmark, use:

- One table or pickup station.
- Three approved objects, preferably rigid and easy to grasp.
- Five object poses per object.
- Three lighting conditions.
- One arm as the primary manipulation arm; keep the other in a known safe pose.
- Head D435 for workspace/target discovery where useful.
- Wrist D405 for close-range pose refinement and grasp verification.

This gives 45 trials:

```text
3 objects x 5 poses x 3 lighting conditions = 45 trials
```

Record:

- Detection success.
- 3D localization error if ground truth or a reasonable reference is available.
- First-attempt grasp success.
- Success after one retry.
- Completion time.
- Drops.
- Table/environment contacts.
- Operator intervention.
- Failure category.

Reasonable prototype targets:

- Known-object detection: at least 95%.
- First-attempt grasp: at least 70%.
- Success after at most one retry: at least 85%.
- Zero dangerous collisions.
- Every unrecoverable failure enters a safe stopped/operator-required state.

Do not tune only for a single recorded demo. Preserve per-trial results.

## 11. App/realtime benchmark

Measure at least:

- Call request to resident notification latency.
- Call connection success rate.
- Reconnection behavior.
- Task update latency.
- Number of resident actions required to answer.
- Staff intervention time.
- Speech parsing accuracy under quiet and robot-noise conditions.
- Percentage of ambiguous requests that trigger clarification rather than execution.

Initial targets:

- Resident answers with one action.
- Notification latency below 3 seconds on the test network.
- Call connection success at least 95% in repeated controlled trials.
- Recoverable connection loss handled within 10 seconds or clearly failed safe.
- Zero physical executions without explicit confirmation.

## 12. UX direction

The robot should feel friendly, calm, and medical-grade rather than industrial or aggressively futuristic.

Resident UI rules:

- One primary action per screen.
- Large type and large touch targets.
- High contrast without harsh black-face styling.
- Prefer photos and plain language over icons alone.
- Avoid gestures that require precision, long press, or multi-touch.
- Provide immediate audio and visual feedback.
- Clearly show when a family member is connected or controlling an allowed robot behavior.
- Make error recovery obvious and nontechnical.

Do not make the iPad look like a generic admin dashboard mounted on a robot.

## 13. Data model starting point

Use names appropriate for the existing stack, but preserve the concepts:

```text
Facility
Resident
User
FamilyRelationship
StaffAssignment
Robot
RobotDevice
PermissionGrant
ConsentPolicy
RestrictedZone
VisitSession
CallSession
TaskRequest
TaskApproval
RobotExecution
AuditEvent
MediaAsset
Notification
BenchmarkRun
BenchmarkTrial
```

Do not store raw video by default. If recording is introduced for development or robot learning, it requires a clearly separate consent, retention, and access path.

## 14. Repository takeover instructions

Start with read-only inspection.

1. List the repository structure.
2. Read `README`, `CLAUDE.md`, package manifests, environment examples, Docker files, ROS packages, schemas, and test configuration.
3. Inspect git status and recent commit history without changing or discarding existing work.
4. Identify current frontend(s), backend, realtime/video provider, database, robot interface, ROS version, simulator, and deployment method.
5. Search for existing resident, family, call, task, robot, WebRTC, ROS, and authentication code.
6. Run only safe existing checks/tests after determining the documented commands.
7. Do not overwrite user changes, secrets, hardware configuration, calibration files, recorded datasets, or model weights.

Then provide a takeover report with:

- Current architecture.
- What runs now.
- What is incomplete or mocked.
- Technical debt or contradictions.
- Safety/privacy gaps.
- Reusable components.
- Missing dependencies and credentials.
- Proposed two-week critical path.
- Exact first implementation milestone.

Do not begin a broad rewrite until the report is complete. If the current architecture can support the vertical slice, extend it rather than replacing it.

## 15. Implementation principles

- Prefer a responsive family web app for the first prototype instead of developing separate iOS and Android apps.
- For the resident iPad, preserve the option for a native SwiftUI app, but a kiosk-capable web prototype is acceptable for the two-week demonstration if clearly documented.
- Use adapters/interfaces around video, speech, LLM parsing, and robot execution so providers can be replaced.
- Use deterministic policy checks after language-model parsing.
- Validate LLM output against a strict schema.
- Never allow the LLM to output executable ROS or shell commands.
- Keep robot commands idempotent where possible.
- Add command expiry, cancellation, and correlation IDs.
- Implement heartbeats and distinguish cloud-online from robot-ready.
- Build simulation and hardware adapters behind the same task contract.
- Avoid hardcoding secrets, resident information, room numbers, or family identities.
- Use synthetic demo data only.
- Add tests for permissions and invalid state transitions, not only happy-path UI tests.

## 16. Questions to answer after repository inspection

Answer these with evidence from the repository. Mark unknowns explicitly.

1. Is there already an iPad, web, or mobile client?
2. Is video calling implemented? Which provider or protocol is used?
3. Is authentication implemented, and does it support resident-family relationships?
4. Is there an existing backend and database schema?
5. Is ROS 1 or ROS 2 used? Which distribution?
6. Are the base, arms, D435, and both D405 cameras represented in the current software?
7. Is manipulation performed by scripted trajectories, MoveIt, imitation learning, or another policy?
8. Is speech-to-text or an LLM already connected?
9. What can be demonstrated today without new code?
10. What is the narrowest end-to-end slice achievable within two weeks?
11. Which parts require real hardware access?
12. Which blockers require a user decision rather than an engineering assumption?

## 17. Required first response

After inspecting the repository, respond in this order:

1. **Executive summary** — five to ten sentences.
2. **Current system map** — clients, services, robot stack, data flow.
3. **Working vs mocked vs missing** — a clear table.
4. **Risks and blockers** — ranked by impact on the two-week demo.
5. **Two-week plan** — daily or milestone-based, with a single critical path.
6. **Proposed benchmark** — exact trial setup and pass/fail criteria.
7. **Questions requiring owner input** — only decisions that materially change implementation.
8. **Recommended first code change** — exact files/components, but wait for approval if it would cause a broad or irreversible change.

Do not respond with a generic robotics architecture. Ground every conclusion in either repository evidence or an explicit statement from this handover.

