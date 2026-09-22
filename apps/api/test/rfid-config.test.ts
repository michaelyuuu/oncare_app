import { describe, expect, test } from "vitest";
import { parseRfidIntervalMs, parseRfidStations } from "../src/services/rfid-config";

const STATION_ID = "11111111-1111-4111-8111-111111111111";

function encoded(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([{
    stationId: STATION_ID,
    facilityId: "facility_demo",
    baseUrl: "https://rfid.local",
    token: "secret",
    ...overrides,
  }]);
}

describe("RFID station configuration", () => {
  test.each([undefined, "", "   "])("treats an unset or blank value as no stations", (value) => {
    expect(parseRfidStations({ ONCARE_RFID_STATIONS: value })).toEqual([]);
  });

  test("accepts the exact server-side station binding", () => {
    expect(parseRfidStations({ ONCARE_RFID_STATIONS: encoded() })).toEqual([{
      stationId: STATION_ID,
      facilityId: "facility_demo",
      baseUrl: "https://rfid.local",
      token: "secret",
    }]);
  });

  test.each([
    ["unknown keys", encoded({ unexpected: true })],
    ["invalid UUIDs", encoded({ stationId: "station-one" })],
    ["blank tokens", encoded({ token: "   " })],
    ["non-HTTPS remote URLs", encoded({ baseUrl: "http://rfid.local" })],
  ])("rejects %s during startup", (_name, value) => {
    expect(() => parseRfidStations({ ONCARE_RFID_STATIONS: value })).toThrow();
  });

  test.each([
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://[::1]:8080",
  ])("allows a loopback HTTP station at %s", (baseUrl) => {
    expect(parseRfidStations({ ONCARE_RFID_STATIONS: encoded({ baseUrl }) })[0]?.baseUrl)
      .toBe(baseUrl);
  });

  test("rejects duplicate station identities", () => {
    const station = JSON.parse(encoded())[0];
    expect(() => parseRfidStations({
      ONCARE_RFID_STATIONS: JSON.stringify([station, { ...station, facilityId: "facility_other" }]),
    })).toThrow();
  });

  test("never includes a configured token in validation errors", () => {
    const token = "credential-that-must-stay-secret";
    expect(() => parseRfidStations({
      ONCARE_RFID_STATIONS: encoded({ token, unexpected: true }),
    })).toThrowError(expect.not.stringContaining(token));
  });

  test.each([undefined, "", "   "])("defaults the server poll interval to exactly one minute", (value) => {
    expect(parseRfidIntervalMs({ ONCARE_RFID_POLL_INTERVAL_MS: value })).toBe(60_000);
  });

  test("accepts a bounded server-only test poll interval", () => {
    expect(parseRfidIntervalMs({ ONCARE_RFID_POLL_INTERVAL_MS: "250" })).toBe(250);
  });

  test.each(["0", "249", "1.5", "60001", "fast", "250ms"])(
    "rejects unsafe RFID poll interval %s",
    (value) => {
      expect(() => parseRfidIntervalMs({ ONCARE_RFID_POLL_INTERVAL_MS: value })).toThrow(
        "ONCARE_RFID_POLL_INTERVAL_MS is invalid",
      );
    },
  );
});
