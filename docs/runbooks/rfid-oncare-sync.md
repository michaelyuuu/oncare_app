# RFID station to OnCare synchronization

This runbook configures the read-only RFID projection used by the manager-only Laundry AI screen. The RFID station remains the source of truth and continues scanning and storing its local ledger when OnCare, the network, or the optional AI provider is unavailable. OnCare only performs authenticated `GET /api/ledger` requests; it does not write station data.

## Server configuration

Set `ONCARE_RFID_STATIONS` on the OnCare API process to a JSON array. Each object must have exactly these four properties:

```dotenv
ONCARE_RFID_STATIONS=[{"stationId":"11111111-1111-4111-8111-111111111111","facilityId":"facility_demo","baseUrl":"https://rfid.internal.example","token":"replace-with-station-ledger-token"}]
```

- `stationId` is the station UUID and must exactly match `station_id` returned by that station's ledger.
- `facilityId` is the OnCare facility that owns the projection. Authority comes from this server-side binding and the authenticated admin principal, never from a browser or model request.
- `baseUrl` is the private station origin, without `/api/ledger`. Use private-network HTTPS with a certificate trusted by the OnCare host. Plain HTTP is accepted only for `localhost`, `127.0.0.1`, or `[::1]` development fixtures.
- `token` is the station's read-only ledger bearer token. Store it only in the API environment or secret manager; never put it in Vite/browser configuration, prompts, logs, screenshots, or checked-in files.

Malformed JSON, unknown properties, duplicate station IDs, invalid UUIDs, blank tokens, and non-HTTPS remote URLs stop API startup. An unset or blank `ONCARE_RFID_STATIONS` configures no stations and makes no RFID network calls.

The production poll interval defaults to exactly 60 seconds. `ONCARE_RFID_POLL_INTERVAL_MS` is a strict server-only test override bounded to 250–60,000 ms; the browser and model cannot set it. Omit it in production so the 60-second default remains in force. The Playwright fixture uses `250` only to make polling deterministic.

Restart the OnCare API after any station configuration or token change. Confirm the manager's Facility admin page shows a successful sync before ending maintenance.

## Token rotation

Rotate a station token without exposing either credential:

1. Create a new read-only ledger token on the RFID station while the current token remains valid.
2. Replace only that station object's `token` value in the OnCare server secret/configuration.
3. Restart the OnCare API so it captures the new immutable station binding.
4. Sign in as an admin, open **Facility admin**, and verify a current sync and expected garment count.
5. Revoke the old token at the station.

If the station cannot overlap tokens, expect a temporary unavailable warning between revocation and restart. OnCare keeps the last-known-good projection. Never paste a token into chat, the manager assistant, browser developer tools, or incident notes.

## Freshness and failure behavior

OnCare records receipt time for each successful poll. Data becomes stale after five minutes without a successful refresh. The UI always shows the last successful sync time and labels stale data; a never-synced station is distinct from a valid empty ledger.

A failed connection or non-2xx response produces a sanitized station-unavailable warning. Invalid JSON or schema produces a sanitized invalid-data warning. If the ledger's `station_id` differs from configured `stationId`, OnCare rejects the response and shows a station-identity warning. In all three cases, OnCare preserves the last-known-good garments instead of replacing them with an empty or unverified result. Investigate station health, certificate trust, token validity, and configured identity; do not clear the projection to hide a warning.

The optional manager provider is independent of structured RFID access. With no `OPENAI_API_KEY`, overview and garment search continue to work and the conversational laundry endpoint returns a safe unavailable response. Provider failure never changes station records or structured tool availability.

## Disable a station

To stop OnCare polling a station, remove its object from `ONCARE_RFID_STATIONS` and restart the OnCare API. To disable all station polling, set the variable to an empty JSON array (`[]`) or leave it unset, then restart. The restart is required; the running connector holds an immutable copy of configuration. Existing last-known-good projection data may remain visible and age into the stale state, but OnCare makes no further requests to the removed station.

## Privacy and authorization boundaries

Only authenticated `admin` users with a server-resolved facility can discover or invoke `get_laundry_overview` and `find_garments`, and only admins can see Facility admin/Laundry AI. Family and staff catalogs must not contain either tool. Tool output excludes raw EPC/source keys, garment photos, raw scan journals, station UUIDs, bearer tokens, and provider keys. Station warning text is mapped to bounded, sanitized UI copy; upstream exception and payload details are not rendered. The manager assistant can call only the two read-only laundry tools and never receives station or provider credentials.

For a local proof with no real station or provider, run the focused Playwright scenario documented in `e2e/laundry-ai.spec.ts`. Its loopback fixture resets before and after every case and uses an in-memory OnCare database.
