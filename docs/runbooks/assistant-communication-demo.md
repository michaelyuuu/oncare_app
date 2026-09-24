# Assistant communication demo

This runbook covers the synthetic communication path in `oncare_app`. It uses the
existing seeded device, resident, and staff principals. It does not contact a
real voice provider, store raw audio or transcripts, or issue robot commands.

## Start the demo

From `oncare_app`:

```powershell
Copy-Item apps/api/.env.example apps/api/.env
npm install
npm run dev -w @oncare/api
```

Start the resident and staff web apps using the repository's normal Vite
commands. Use the seeded device token for the resident kiosk and the seeded
staff account for the staff console. The exact demo credentials are listed in
the root README and are development-only fixtures.

## Resident path

1. Open the resident kiosk and select **Talk to Ontaru**.
2. The default session is the deterministic fake assistant. Use the text
   fallback to request staff help, ask for approved contacts, check request
   status, or ask about service availability.
3. A staff-help request is persisted with `recorded` persistence and `pending`
   delivery. The kiosk says **Request recorded**; it never claims that a nurse
   has arrived.
4. The **Help staff** touch action remains available independently of the
   assistant panel. It uses an idempotency key and re-reads the authoritative
   request row before showing the recorded state.
5. Family calling and existing resident settings remain available when the
   assistant is unavailable.

## Staff path

1. Open the staff console and wait for the queue to refresh.
2. The assistance row is scoped to staff assignments and shows the resident,
   optional note, timestamp, delivery state, handling state, and request ID.
3. Use **Acknowledge request**, **Start work**, and **Mark resolved** in order.
   Each action sends the row's current version; a stale view receives a
   conflict and refreshes instead of applying a duplicate transition.
4. Use **Mark delivery failed** only when the delivery state is still pending
   or unknown. The UI reports **Delivery status unknown** rather than making an
   arrival promise.

## Optional live voice

Leave `OPENAI_API_KEY` empty for the fake session. To enable the optional
server-side OpenAI Realtime/WebRTC adapter, set the API key in the ignored
`apps/api/.env` file and optionally set:

```text
ONCARE_REALTIME_MODEL=gpt-realtime
ONCARE_REALTIME_ENDPOINT=https://api.openai.com/v1/realtime/calls
ONCARE_ASSISTANT_PROFILE=
```

The API key is read only by the server. The browser receives only an SDP answer
and capability/session state. A configured assistant profile is bounded and
fails closed if invalid. The assistant routes expose only the communication
tools listed by the capability endpoint.

## Safe verification

Run the repository checks from `oncare_app`:

```powershell
npm run typecheck
npm test
git diff --check
```

The reference checkout can be checked separately without copying code into the
main repository:

```powershell
python -m pytest -q ..\oncare_communicate
npm --prefix ..\oncare_communicate\apps\web test
python ..\oncare_communicate\scripts\verify_customer_boundary.py
```

OpenAI microphone/provider execution, staffing coverage, media approval,
production authentication, and physical robot installation remain deployment
gates. Robot movement, navigation, manipulation, shell, ROS, and actuator
operations are not assistant capabilities in this release.
