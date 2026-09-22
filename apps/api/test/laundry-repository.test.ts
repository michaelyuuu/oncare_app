import { describe, expect, test } from "vitest";
import { openDb } from "../src/db/client";
import * as t from "../src/db/schema";
import { SEED_IDS, seed } from "../src/db/seed";
import {
  createLaundryRepository,
  type StationLedgerSnapshot,
} from "../src/services/laundry-repository";

const STATION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_STATION_ID = "22222222-2222-4222-8222-222222222222";
const SUCCESS_AT = "2026-09-21T12:00:00.000Z";

const snapshot: StationLedgerSnapshot = {
  stationId: STATION_ID,
  facilityId: SEED_IDS.facility,
  sourceVersion: 7,
  sourceUpdatedAt: SUCCESS_AT,
  warnings: [],
  garments: [{
    sourceKey: "E200001",
    residentId: SEED_IDS.resident,
    name: "Blue cardigan",
    category: "cardigan",
    color: "blue",
    status: "active",
    washCount: 4,
    lastSeen: "2026-09-21T11:59:00.000Z",
  }],
};

async function setup(now: () => Date = () => new Date("2026-09-21T12:04:59.999Z")) {
  const db = openDb(":memory:");
  await seed(db);
  return { db, repository: createLaundryRepository(db, { now }) };
}

describe("laundry projection repository", () => {
  test("replaces one station atomically and never exposes its source key", async () => {
    const { db, repository } = await setup();
    repository.replaceStation(snapshot);

    expect(repository.find(SEED_IDS.facility, {})).toEqual([{
      residentId: SEED_IDS.resident,
      residentName: "Demo Resident",
      name: "Blue cardigan",
      category: "cardigan",
      color: "blue",
      status: "active",
      washCount: 4,
      lastSeen: "2026-09-21T11:59:00.000Z",
      syncedAt: "2026-09-21T12:04:59.999Z",
      stale: false,
    }]);
    expect(Object.keys(repository.find(SEED_IDS.facility, {})[0]!)).not.toContain("sourceKey");

    repository.replaceStation({
      ...snapshot,
      sourceVersion: 8,
      garments: [{ ...snapshot.garments[0]!, sourceKey: "E200002", name: "Red jumper", color: "red" }],
    });
    expect(repository.find(SEED_IDS.facility, {}).map((row) => row.name)).toEqual(["Red jumper"]);

    expect(() => repository.replaceStation({
      ...snapshot,
      sourceVersion: 9,
      garments: [
        { ...snapshot.garments[0]!, sourceKey: "DUPLICATE", name: "First" },
        { ...snapshot.garments[0]!, sourceKey: "DUPLICATE", name: "Second" },
      ],
    })).toThrow();
    expect(repository.find(SEED_IDS.facility, {}).map((row) => row.name)).toEqual(["Red jumper"]);
    expect(db.select().from(t.rfidStationSync).get()).toEqual(expect.objectContaining({
      sourceVersion: 8,
      lastSuccessAt: "2026-09-21T12:04:59.999Z",
    }));
  });

  test("applies facility scope before every overview and garment filter", async () => {
    const { db, repository } = await setup();
    db.insert(t.facility).values({ id: "facility_other", name: "Other", timezone: "UTC" }).run();
    db.insert(t.location).values({
      id: "location_other",
      facilityId: "facility_other",
      name: "Other room",
      kind: "resident_room",
      x: 0,
      y: 0,
      yaw: 0,
      approved: true,
    }).run();
    db.insert(t.resident).values({
      id: "resident_other",
      facilityId: "facility_other",
      displayName: "Other Resident",
      roomLocationId: "location_other",
    }).run();
    repository.replaceStation(snapshot);
    repository.replaceStation({
      ...snapshot,
      stationId: OTHER_STATION_ID,
      facilityId: "facility_other",
      garments: [{ ...snapshot.garments[0]!, sourceKey: "OTHER", residentId: "resident_other", name: "Other coat" }],
    });

    expect(repository.overview(SEED_IDS.facility)).toEqual(expect.objectContaining({ total: 1 }));
    expect(repository.overview("facility_other")).toEqual(expect.objectContaining({ total: 1 }));
    expect(repository.find(SEED_IDS.facility, {}).map((row) => row.name)).toEqual(["Blue cardigan"]);
    expect(repository.find(SEED_IDS.facility, { residentId: "resident_other" })).toEqual([]);
    expect(repository.find(SEED_IDS.facility, { name: "Other" })).toEqual([]);
  });

  test("replacing one station preserves another station's projection", async () => {
    const { repository } = await setup();
    repository.replaceStation(snapshot);
    repository.replaceStation({
      ...snapshot,
      stationId: OTHER_STATION_ID,
      garments: [{ ...snapshot.garments[0]!, sourceKey: "OTHER", name: "Green coat" }],
    });

    repository.replaceStation({
      ...snapshot,
      sourceVersion: 8,
      garments: [{ ...snapshot.garments[0]!, sourceKey: "REPLACEMENT", name: "Red jumper" }],
    });

    expect(repository.find(SEED_IDS.facility, {}).map((row) => row.name)).toEqual(["Green coat", "Red jumper"]);
  });

  test("orders by resident, normalized name, then internal id and caps results at 20", async () => {
    const { repository } = await setup();
    repository.replaceStation({
      ...snapshot,
      garments: [
        { ...snapshot.garments[0]!, sourceKey: "A003", name: "alpha", washCount: 3 },
        { ...snapshot.garments[0]!, sourceKey: "A001", name: "Alpha", washCount: 1 },
        { ...snapshot.garments[0]!, sourceKey: "A002", name: "ALPHA", washCount: 2 },
        ...Array.from({ length: 22 }, (_, index) => ({
          ...snapshot.garments[0]!,
          sourceKey: `I${String(index + 1).padStart(2, "0")}`,
          name: `Item ${String(index + 1).padStart(2, "0")}`,
          washCount: index + 101,
        })),
      ],
    });

    const results = repository.find(SEED_IDS.facility, {});
    expect(results).toHaveLength(20);
    expect(results.map((row) => row.washCount)).toEqual([
      1, 2, 3,
      101, 102, 103, 104, 105, 106, 107, 108, 109,
      110, 111, 112, 113, 114, 115, 116, 117,
    ]);
  });

  test("records a failed attempt without changing last-known-good rows or success time", async () => {
    let current = new Date("2026-09-21T12:04:59.999Z");
    const { db, repository } = await setup(() => current);
    repository.replaceStation(snapshot);
    current = new Date("2026-09-21T12:06:00.000Z");

    repository.recordFailure(STATION_ID, "unavailable", {
      kind: "station_unavailable",
      message: "Station did not respond",
    });

    expect(repository.find(SEED_IDS.facility, {}).map((row) => row.name)).toEqual(["Blue cardigan"]);
    expect(repository.overview(SEED_IDS.facility)).toEqual({
      availability: "available",
      total: 1,
      active: 1,
      lostOrDiscarded: 0,
      recentlyWashed: 1,
      syncedAt: "2026-09-21T12:04:59.999Z",
      stale: false,
      warnings: [{ kind: "station_unavailable", message: "Station did not respond" }],
    });
    expect(db.select().from(t.rfidStationSync).get()).toEqual(expect.objectContaining({
      status: "unavailable",
      lastAttemptAt: "2026-09-21T12:06:00.000Z",
      lastSuccessAt: "2026-09-21T12:04:59.999Z",
    }));
  });

  test("distinguishes never-synced data from a valid no-match and turns stale at five minutes", async () => {
    let current = new Date("2026-09-21T12:04:59.999Z");
    const { repository } = await setup(() => current);
    expect(repository.overview(SEED_IDS.facility)).toEqual({
      availability: "never_synced",
      total: 0,
      active: 0,
      lostOrDiscarded: 0,
      recentlyWashed: 0,
      syncedAt: null,
      stale: false,
      warnings: [],
    });

    repository.replaceStation(snapshot);
    expect(repository.overview(SEED_IDS.facility, "resident_without_garments")).toEqual(expect.objectContaining({
      availability: "available",
      total: 0,
      syncedAt: "2026-09-21T12:04:59.999Z",
      stale: false,
    }));
    current = new Date("2026-09-21T12:09:59.998Z");
    expect(repository.overview(SEED_IDS.facility).stale).toBe(false);
    current = new Date("2026-09-21T12:09:59.999Z");
    expect(repository.overview(SEED_IDS.facility).stale).toBe(true);
    expect(repository.find(SEED_IDS.facility, {})[0]?.stale).toBe(true);
  });

  test("counts last-seen times from exactly 24 hours ago through now as recently washed", async () => {
    const current = new Date("2026-09-21T12:00:00.000Z");
    const { repository } = await setup(() => current);
    repository.replaceStation({
      ...snapshot,
      garments: [
        { ...snapshot.garments[0]!, sourceKey: "AT_START", lastSeen: "2026-09-20T12:00:00.000Z" },
        { ...snapshot.garments[0]!, sourceKey: "BEFORE_START", lastSeen: "2026-09-20T11:59:59.999Z" },
        { ...snapshot.garments[0]!, sourceKey: "AT_NOW", lastSeen: "2026-09-21T12:00:00.000Z" },
        { ...snapshot.garments[0]!, sourceKey: "AFTER_NOW", lastSeen: "2026-09-21T12:00:00.001Z" },
        { ...snapshot.garments[0]!, sourceKey: "NEVER", lastSeen: null },
      ],
    });

    expect(repository.overview(SEED_IDS.facility).recentlyWashed).toBe(2);
  });
});
