# RFID Station, Unified Entrance, and Laundry AI Design

**Date:** 2026-09-21  
**Target repository:** `oncare_app`  
**Status:** Approved design; implementation has not started

## Decision

Integrate the RFID garment station with OnCare through a read-only server-side
projection. The RFID station remains the offline-capable source of truth;
OnCare periodically reads the station ledger, validates station ownership, and
stores a facility-scoped projection for application and assistant queries.

Add one unified OnCare entrance where a person first selects Resident, Family,
Staff, or Manager and then completes that role's authentication. Role or
identity selection is navigation, not authorization. The backend-issued
principal remains the only authority for data access.

Expose Laundry AI only to authenticated facility managers (`admin`). Residents,
family users, and ordinary staff may use the unified entrance and their existing
OnCare capabilities, but they do not receive the laundry tools or Laundry AI UI.

## Goals

- Preserve uninterrupted RFID scanning and local garment records when OnCare,
  the network, or the AI provider is unavailable.
- Give a manager a natural-language overview of facility laundry data and a
  way to find individual garments.
- Reuse OnCare's existing principal resolution, facility scoping, tool
  registry, confirmation conventions, audit events, and provider boundary.
- Make stale, missing, malformed, or unavailable data visible rather than
  presenting it as a successful empty result.
- Provide one clearly labelled entry point for every OnCare role without
  merging the role-specific applications or weakening authentication.

## Non-goals

- AI writes to the RFID registry or garment ledger.
- Real-time alerts, event push, or operational escalation.
- Resident location, toileting, or excretion tracking.
- Model access to garment photos, raw EPC values, or raw scan journals.
- Laundry AI access for residents, family users, or ordinary staff.
- A production impersonation or unrestricted identity-switching feature.
- Replacing the RFID station's local files with an OnCare or cloud database.

## Approaches considered

### Selected: OnCare projection with manager-scoped tools

OnCare pulls the protected station ledger on a schedule and updates local
projection tables. Assistant tools query that projection. This keeps manager
queries fast, centralizes authorization and audit, and does not make station
operation depend on the network.

### Rejected for V1: Query the station for every question

This is smaller initially but makes every answer depend on station and LAN
availability, complicates multi-station routing, and gives the AI path a wider
network boundary.

### Deferred: Expose the station as an MCP server

MCP may be useful if several independent assistants must share RFID tools.
OnCare already has a role-scoped tool registry and server-side relay, so MCP
would add authentication and deployment surface without a V1 benefit.

## System architecture

```text
UHF reader
    |
RFID station
local registry + append-only scan journal
    |
    | GET /api/ledger over a private authenticated connection
    v
OnCare RFID connector
station identity check + normalization + atomic projection refresh
    |
    +--> RFID sync state / garment projection
              |
              +--> Facility admin Laundry AI
                       |
                       +--> manager-scoped OnCare function tools
                                |
                                +--> optional AI provider
```

The station keeps its existing ledger bearer guard. The token is stored only
by the OnCare API and is never returned to a browser or model. Each configured
station has an explicit `station_id -> facility_id` binding. An unknown station,
a station bound to another facility, or a changed station identity fails closed
and does not replace the last known-good projection.

V1 uses polling rather than push. The default target is one successful ledger
read per minute. A projection is stale when no successful refresh has completed
for five minutes. These values are server configuration, not model decisions.

## Unified entrance and identity rules

The unified entrance is a thin front door, not a fourth authorization system.
It presents four choices:

- Resident
- Family
- Staff
- Manager

After selection, the user completes that role's existing authentication and is
routed to the appropriate existing application surface. Manager uses the staff
application with its Facility admin area. The role choice never becomes a role
claim and is never accepted as proof of authority.

After authentication, an identity picker may show only identities returned by
the server for the authenticated principal:

- a resident device is bound to its assigned resident;
- a family user sees only residents connected by active family relationships;
- staff see only residents in active staff assignments;
- a manager sees only active residents in the manager's facility.

Selecting an identity changes the current view context but does not expand the
principal's scope. Every subsequent API and tool call rechecks current server
authority. Revoked assignments or relationships therefore take effect without
trusting stale browser state.

Demo mode may provide a synthetic identity selector behind an explicit
development configuration. It must be visibly labelled `SIMULATED`, use only
seeded identities, and be disabled in production. Production must not accept a
synthetic actor header or a client-supplied role as authentication.

## Projection data model

### RFID station sync state

One row per configured station:

- `stationId`
- `facilityId`
- `sourceVersion`
- `lastAttemptAt`
- `lastSuccessAt`
- `status`: `healthy`, `stale`, `unavailable`, or `invalid`
- bounded normalized `warnings`

### Garment projection

One row per garment returned by a station:

- internal source garment key, retained by the backend only
- `stationId`
- `facilityId`
- `residentId`
- garment name
- category
- color
- status
- wash count
- last seen time
- source update time
- projection sync time

The projection needs the station's EPC-derived key for idempotent replacement,
but API and tool results do not expose raw EPC values. Photos and raw scan
records are neither copied into the projection nor sent to the AI provider.

Each refresh is validated before it becomes visible. A malformed response or
identity mismatch records a failed attempt and preserves the previous
last-known-good rows. A successful refresh replaces that station's projection
atomically so a query cannot observe a half-updated ledger.

## Laundry tools

Add two read-only tools to the existing OnCare tool registry. Both tools have
the sole allowed role `admin` and derive `facilityId` from the authenticated
principal.

### `get_laundry_overview`

Inputs:

- optional `residentId`

Behavior:

- without `residentId`, summarize the manager's facility;
- with `residentId`, require that the resident is active and belongs to the
  manager's facility;
- return garment totals, recently washed count, lost/discarded count, attention
  items, station status, `syncedAt`, and `stale`;
- never accept `facilityId` from the model.

### `find_garments`

Inputs:

- optional `residentId`
- optional bounded garment-name text
- optional category
- optional color
- optional status

Behavior:

- apply the manager's facility scope before all filters;
- return at most 20 deterministic results;
- return garment name, resident display identity, category, color, status,
  wash count, last seen time, `syncedAt`, and `stale`;
- omit raw EPC, photos, raw scanner readings, and unrelated resident data.

The model never receives database credentials, SQL capability, a station token,
or the complete ledger. Tool inputs are schema validated. Tool execution passes
through the current OnCare audit path with the manager as the accountable
principal and `actorType: "ai"` for the invocation event.

## Manager experience

The staff application's Facility admin area gains a Laundry AI section. It is
not rendered for ordinary staff and its API remains protected even if a user
manually constructs the route.

The section contains:

- station health and last successful sync time;
- a text question field with concise example questions;
- summary cards for overview responses;
- a bounded table for individual garment results;
- persistent freshness and warning labels attached to every result.

Example supported questions include:

- "How many active garments are registered in this facility?"
- "Which garments have not been seen recently?"
- "Show blue cardigans belonging to Resident A."
- "How many washes are recorded for this garment?"

The deterministic tool result remains available to the UI even if the AI
provider is unavailable. The UI may present structured results directly and
state that conversational summarization is unavailable.

## Failure semantics

- **Never synchronized:** report that laundry data is unavailable; do not show
  zero garments.
- **Stale projection:** answer from the last-known-good data and state the exact
  data time.
- **Station unavailable:** preserve existing projection, record the failed
  attempt, and leave RFID scanning unaffected.
- **Malformed station data:** reject the refresh, surface a bounded warning, and
  keep the last-known-good projection.
- **Station identity mismatch:** fail closed, record an administrative error,
  and do not merge data.
- **No matching garment:** report "no matching record" distinctly from service
  unavailability.
- **Unauthorized role or facility:** return a non-disclosing authorization
  error and do not expose whether the resident or garment exists.
- **AI provider failure:** keep structured manager search available and do not
  claim that an AI-generated answer was produced.

## Security and privacy

- The browser and model never receive station or provider credentials.
- Facility scope comes from the resolved server principal, not request input.
- All identity choices are server-filtered and reauthorized on use.
- Only the minimum fields needed for an answer are sent to the model.
- Tool calls and denied attempts follow existing OnCare audit conventions.
- Logs redact bearer credentials and avoid raw EPC or full ledger payloads.
- V1 is read-only; there is no confirmation flow because no laundry tool may
  mutate station or OnCare garment state.

## Testing strategy

### RFID connector and projection

- valid refresh creates an atomic facility-scoped projection;
- repeated source versions are idempotent;
- unavailable, malformed, and identity-mismatched stations preserve the last
  known-good projection;
- stale state begins after five minutes without a successful refresh;
- RFID station tests prove local scanning does not depend on connector access.

### Authorization and tools

- only `admin` can list or invoke the two laundry tools;
- resident, family, staff, inactive admin, and cross-facility calls are denied;
- a client-supplied `facilityId` cannot broaden a query;
- resident filtering is checked against the manager's current facility;
- `find_garments` is deterministic and capped at 20 rows;
- every successful invocation produces the expected audit event;
- raw EPC, station credentials, photos, and scan records never appear in tool
  schemas or results.

### Unified entrance

- selecting a role does not authenticate or create a role claim;
- each role reaches only its existing authentication flow;
- identity lists contain only currently authorized identities;
- relationship or assignment revocation invalidates a previously selected
  identity;
- synthetic identity selection is visibly labelled and unavailable under
  production configuration.

### UI and degraded behavior

- only managers see Laundry AI in Facility admin;
- freshness and station warnings remain visible with all results;
- no-match, stale, never-synced, malformed-data, and provider-unavailable states
  render distinct messages;
- structured summary and search remain usable when the AI provider is down.

## Acceptance criteria

1. The RFID station continues operating with OnCare and all network services
   stopped.
2. OnCare refreshes a valid station ledger into an atomic facility projection
   and never replaces it with invalid data.
3. A manager can ask for a facility or resident laundry overview and search
   individual garments from Facility admin.
4. Residents, family users, and ordinary staff cannot discover or invoke the
   laundry tools.
5. Cross-facility access is denied even when a valid resident or garment ID is
   supplied.
6. Every result includes its freshness state, and missing data is never
   represented as a successful zero result.
7. Unified entrance role and identity selection cannot grant authority beyond
   the resolved backend principal.
8. Focused tests, the full OnCare test suite, typecheck, and the relevant
   browser flow pass before implementation is considered complete.

