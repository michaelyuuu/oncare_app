# Reserved Robot Visit Calendar

## Status

Approved design for `feature/resident-call-scheduling`. This document defines the demo scope for one-time, scheduled ON 0 robot visits with video calls.

## Product outcome

Residents and approved family contacts can propose a one-hour robot-plus-video visit from either side. The receiving participant confirms or suggests another time. The resident iPad keeps the communication surface as its home screen, while the calendar uses a landscape, calendar-first layout.

## User experience

### Resident

- Home remains the communication UI.
- The resident selects one approved family contact, then chooses **Schedule a visit** or **Call now**.
- The calendar is a landscape two-pane view: month/date rail on the left and large touch-friendly time slots on the right.
- The next 14 days are visible. Slots use facility-local time and show available, meal/quiet, staff-unavailable, pending, and confirmed states.
- **I need help** remains a separate staff-assistance action.
- A pending proposal shows a five-minute countdown. A confirmed proposal shows the contact, time, ON 0 robot visit, video call, and a 10-minute reminder.

### Family

- The resident card exposes **Schedule a visit** as the primary action and **Call now** as the secondary action.
- Family uses the same slot rules and sees the same proposal states.
- The receiver can confirm or suggest another time. Suggesting another time releases the original hold immediately and starts a new five-minute hold for the replacement slot.
- Either participant can cancel before the call starts. Staff/admin can always cancel.

### Assistant

Ontaru may read upcoming reservations, explain available slots, and propose a slot after the user asks. The final proposal or confirmation always requires an on-screen action; voice-only booking is out of scope.

## Scheduling policy

- Reservations are one-time only.
- Each reservation is exactly one hour.
- Bookable slot starts are 09:00, 10:00, 11:00, 13:00, 14:00, and 15:00 local facility time.
- 12:00–13:00 is lunch; 16:00–17:00 is staff handoff; 17:00–18:00 is dinner/quiet time. These periods are visible but disabled.
- A pending proposal holds its slot for five minutes, then expires and releases it.
- Confirmed reservations show a 10-minute reminder.
- ON 0 dispatch begins five minutes before the call. The existing incoming/LiveKit flow starts at the reserved time.
- Conflicts are rejected for the resident, selected family contact, or assigned robot.
- `Call now` bypasses reservations and uses an immediate robot/video visit flow after contact selection.
- If cancellation happens after dispatch, the system safely stops the visit and notifies staff.

## Architecture

Use a new reservation service rather than overloading `visitSession`. The reservation represents the proposal and scheduling lifecycle; `visitSession` remains the state machine for the active robot/video visit.

### Reservation data

Add a Drizzle migration and `visitReservation` table with fields for:

- resident, selected family contact, facility, and assigned robot
- proposer kind/id (resident device or family user)
- status: `pending`, `confirmed`, `expired`, or `cancelled`
- start/end timestamps, facility timezone, and five-minute `expiresAt`
- reminder and dispatch timestamps
- confirmation/cancellation metadata
- replacement/superseded reservation link
- linked `visitSession` id once activated

Store timestamps as ISO instants and generate/display slots in the facility timezone. Enforce overlap checks transactionally for resident, family contact, and robot. Pending reservations count as conflicts until they expire or are replaced.

### Services and routes

Add a pure slot-policy module in `packages/core` for date-window, working-hour, blocked-period, timezone, and slot generation rules. Add an API reservation service and routes for:

- available slots and upcoming reservations
- creating a proposal
- confirming a proposal
- suggesting a replacement slot
- cancelling a reservation
- creating an immediate `Call now` visit for either authorized participant

Family access is restricted to an active relationship with video and robot-visit consent. Resident access is restricted to the resident device and one selected approved family relationship. Staff/admin can view and cancel within their existing resident scope.

### Scheduler and events

Add a small API scheduler that expires pending holds and activates confirmed reservations. At T-5 it creates/starts the existing visit flow and dispatches ON 0. Reuse the existing transitions event stream and `/events` WebSocket for proposal, confirmation, expiry, cancellation, reminder, and activation updates. Clients retain polling/reload fallback.

## UI boundaries

- Resident: add a contact picker, calendar screen, reservation status card, and immediate-call entry point without replacing the communication home.
- Family: add scheduling from the residents page and reservation status/response screens while preserving the current immediate visit flow.
- Staff: expose upcoming reservations and cancellation support in the existing console.
- Shared web/API types and i18n strings should live in existing shared packages where appropriate; resident and family layouts may remain separate.

## Failure handling

- Expired holds return the slot to Available and explain that the proposal timed out.
- A conflict returns a clear retry state and refreshes availability.
- A revoked relationship or consent change prevents new proposals and hides the contact.
- Robot dispatch failure prevents the call from starting, emits a staff-visible event, and offers both participants a rebook path.
- Offline clients refresh reservation state before confirming or cancelling, so stale actions cannot overwrite a newer state.

## Verification

Test the core slot rules, timezone boundaries, blocked periods, 14-day window, overlap protection, consent/access, five-minute expiry, alternative proposals, cancellation, reminder/dispatch timing, immediate calls, assistant confirmation gates, resident/family UI states, and a Playwright scheduled-call path using the fake video provider. Finish with `npm test`, `npm run typecheck`, and the relevant E2E/demo checks.

## Out of scope

External calendar synchronization, recurring visits, arbitrary contacts, voice-only confirmation, multi-hour calls, and facility-specific schedule administration beyond the fixed demo policy.
