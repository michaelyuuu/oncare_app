import { describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as t from "../src/db/schema";
import { openDb } from "../src/db/client";
import { SEED_IDS, seed } from "../src/db/seed";
import { createLaundryRepository, type LaundryRepository } from "../src/services/laundry-repository";
import { createRfidConnector } from "../src/services/rfid-connector";
import type { RfidStationConfig } from "../src/services/rfid-config";

const STATION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_STATION_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "credential-that-must-stay-secret";
const SOURCE_TIME = "2026-09-21T11:59:00.000Z";

const station: RfidStationConfig = {
  stationId: STATION_ID,
  facilityId: SEED_IDS.facility,
  baseUrl: "https://rfid.local",
  token: TOKEN,
};

const resident = {
  resident_id: SEED_IDS.resident,
  name: "Demo Resident",
  room: "101",
  floor: "1",
  photo: "",
  kana: "",
  admitted_on: "2026-01-01",
  active: true,
};

function ledger(overrides: Record<string, unknown> = {}) {
  return {
    station_id: STATION_ID,
    registry: { version: 7, written_at: SOURCE_TIME, etag: "ledger-etag" },
    baseline: {},
    baseline_etag: null,
    garments: [{
      epc: "E200001",
      name: "Blue cardigan",
      color: "blue",
      category: "cardigan",
      owner: "Demo Resident",
      added_at: "2026-01-01T00:00:00+00:00",
      resident_id: SEED_IDS.resident,
      size: "M",
      brand: "",
      care_label: "",
      tag_type: "uhf",
      status: "active",
      notes: "",
      resident,
      wash_count: 4,
      last_seen: SOURCE_TIME,
      photo_url: null,
    }],
    residents: [resident],
    categories: ["cardigan"],
    statuses: ["active", "discarded", "lost"],
    warnings: [],
    ...overrides,
  };
}

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

async function setup(fetchImpl: typeof fetch, repositoryOverride?: LaundryRepository) {
  const db = openDb(":memory:");
  await seed(db);
  const repository = repositoryOverride ?? createLaundryRepository(db, {
    now: () => new Date("2026-09-21T12:00:00.000Z"),
  });
  const connector = createRfidConnector({
    repository,
    stations: [station],
    fetch: fetchImpl,
    now: () => new Date("2026-09-21T12:00:00.000Z"),
  });
  return { connector, repository };
}

describe("RFID polling connector", () => {
  test("stop prevents writes even when response completion is already queued", async () => {
    const db = openDb(":memory:");
    await seed(db);
    const repository = createLaundryRepository(db);
    for (let checkpoint = 0; checkpoint < 10; checkpoint += 1) {
      db.delete(t.garmentProjection).run();
      db.delete(t.rfidStationSync).run();
      const connector = createRfidConnector({
        repository, stations: [station],
        fetch: (async () => ({ ok: true, json: async () => ledger() }) as Response) as typeof fetch,
      });
      const cycle = connector.refreshAll();
      for (let step = 0; step < checkpoint; step += 1) await Promise.resolve();
      const beforeStop = repository.overview(SEED_IDS.facility);
      connector.stop();
      await cycle;
      expect(repository.overview(SEED_IDS.facility), "stop checkpoint " + checkpoint).toEqual(beforeStop);
    }
  });

  test.each(["headers", "body"])("bounds stalled %s and permits healthy stations in subsequent cycles", async (phase) => {
    const db = openDb(":memory:");
    await seed(db);
    const repository = createLaundryRepository(db, { now: () => new Date(SOURCE_TIME) });
    let stall = false;
    let healthyCount = 0;
    let stalledSignal: AbortSignal | null = null;
    let rejectLate!: (reason: Error) => void;
    const stalled = new Promise<never>((_resolve, reject) => { rejectLate = reject; });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("healthy.local")) {
        healthyCount += 1;
        return response(ledger({ station_id: OTHER_STATION_ID, garments: [
          { ...ledger().garments[0], name: "Healthy garment", wash_count: healthyCount },
        ] }));
      }
      if (stall) {
        stalledSignal = init?.signal ?? null;
        return phase === "headers" ? stalled : { ok: true, json: () => stalled } as unknown as Response;
      }
      return response(ledger());
    }) as typeof fetch;
    const connector = createRfidConnector({
      repository, stations: [station, { ...station, stationId: OTHER_STATION_ID, baseUrl: "https://healthy.local" }],
      fetch: fetchImpl, requestTimeoutMs: 50,
    });
    await connector.refreshAll();
    vi.useFakeTimers();
    try {
      stall = true;
      let settled = false;
      const cycle = connector.refreshAll().then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(50);
      expect(settled).toBe(true);
      await cycle;
      expect((stalledSignal as AbortSignal | null)?.aborted).toBe(true);
      expect(repository.find(SEED_IDS.facility, {}).map((row) => row.name)).toEqual(["Blue cardigan", "Healthy garment"]);
      expect(db.select().from(t.rfidStationSync).where(eq(t.rfidStationSync.stationId, STATION_ID)).get()).toMatchObject({
        status: "unavailable", lastSuccessAt: SOURCE_TIME,
        warnings: [{ kind: "station_unavailable", message: "RFID station request timed out" }],
      });
      stall = false;
      await connector.refreshAll();
      expect(repository.find(SEED_IDS.facility, {}).find((row) => row.name === "Healthy garment")?.washCount).toBe(3);
      expect(repository.overview(SEED_IDS.facility).warnings).toEqual([]);
      rejectLate(new Error("late secret provider detail"));
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      connector.stop();
      vi.useRealTimers();
    }
  });

  test("stop aborts pending work without late writes and start can immediately resume", async () => {
    const db = openDb(":memory:");
    await seed(db);
    const repository = createLaundryRepository(db);
    let release!: (value: Response) => void;
    let signal: AbortSignal | null = null;
    let requests = 0;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const connector = createRfidConnector({
      repository, stations: [station], requestTimeoutMs: 50,
      fetch: (async (_input, init) => {
        requests += 1;
        signal = init?.signal ?? null;
        return requests === 1 ? pending : response(ledger());
      }) as typeof fetch,
    });
    vi.useFakeTimers();
    try {
      connector.start();
      connector.start();
      expect(requests).toBe(1);
      let settled = false;
      const first = connector.refreshAll().then(() => { settled = true; });
      connector.stop();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      await first;
      expect((signal as AbortSignal | null)?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(repository.overview(SEED_IDS.facility)).toMatchObject({ availability: "never_synced", warnings: [] });
      connector.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(repository.find(SEED_IDS.facility, {}).map((row) => row.name)).toEqual(["Blue cardigan"]);
      release(response(ledger({ garments: [{ ...ledger().garments[0], name: "Late overwrite" }] })));
      await vi.advanceTimersByTimeAsync(0);
      expect(repository.find(SEED_IDS.facility, {}).map((row) => row.name)).toEqual(["Blue cardigan"]);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(requests).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(requests).toBe(3);
    } finally {
      connector.stop();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });

  test.each(["cross-facility", "inactive", "unknown", "null", "empty"])("rejects an entire %s resident snapshot with a safe warning and retained good data", async (kind) => {
    const db = openDb(":memory:");
    await seed(db);
    db.insert(t.facility).values({ id: "facility_other", name: "Other", timezone: "UTC" }).run();
    db.insert(t.resident).values({
      id: "private_resident", facilityId: kind === "cross-facility" ? "facility_other" : SEED_IDS.facility,
      displayName: "Private person", roomLocationId: "other_room", active: kind !== "inactive",
    }).run();
    const repository = createLaundryRepository(db, { now: () => new Date(SOURCE_TIME) });
    const residentId = kind === "unknown" ? "unknown_resident" : kind === "null" ? null : kind === "empty" ? "" : "private_resident";
    const bodies = [ledger(), ledger({ garments: [
      { ...ledger().garments[0], name: "Changed valid garment" },
      { ...ledger().garments[0], epc: "BAD", name: "Private garment", resident_id: residentId },
    ] })];
    const connector = createRfidConnector({ repository, stations: [station], fetch: (async () => response(bodies.shift())) as typeof fetch });
    await connector.refreshAll();
    await connector.refreshAll();
    expect(repository.find(SEED_IDS.facility, {}).map((row) => row.name)).toEqual(["Blue cardigan"]);
    expect(repository.overview(SEED_IDS.facility)).toMatchObject({
      syncedAt: SOURCE_TIME, total: 1,
      warnings: [{ kind: "invalid_payload", message: "RFID station returned invalid ledger data" }],
    });
    const sync = db.select().from(t.rfidStationSync).where(eq(t.rfidStationSync.stationId, STATION_ID)).get()!;
    expect(sync.status).toBe("invalid");
    expect(JSON.stringify(sync.warnings)).not.toMatch(/private_resident|Private person|unknown_resident/);
  });

  test("registers configured ownership before a first refresh can fail", async () => {
    const db = openDb(":memory:");
    await seed(db);
    const real = createLaundryRepository(db);
    const calls: string[] = [];
    const repository = {
      ...real,
      registerStation(input: { stationId: string; facilityId: string }) {
        calls.push(`register:${input.stationId}:${input.facilityId}`);
        real.registerStation(input);
      },
      recordFailure(stationId: string, status: "stale" | "unavailable" | "invalid", warning: { kind: string; message?: string; count?: number }) {
        calls.push(`failure:${stationId}:${status}:${warning.kind}`);
        real.recordFailure(stationId, status, warning);
      },
    } satisfies LaundryRepository;
    const { connector } = await setup(vi.fn(async () => { throw new Error("offline"); }), repository);

    await connector.refreshAll();

    expect(calls).toEqual([
      `register:${STATION_ID}:${SEED_IDS.facility}`,
      `failure:${STATION_ID}:unavailable:station_unavailable`,
    ]);
    expect(real.overview(SEED_IDS.facility).warnings).toEqual([{
      kind: "station_unavailable",
      message: "RFID station is unavailable",
    }]);
  });

  test("sends only a read-only ledger GET with the bearer credential", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ input: String(input), ...(init ? { init } : {}) });
      return response(ledger());
    }) as unknown as typeof fetch;
    const { connector, repository } = await setup(fetchImpl);

    await connector.refreshStation(STATION_ID);

    expect(requests).toEqual([{
      input: "https://rfid.local/api/ledger",
      init: { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` }, signal: expect.any(AbortSignal) },
    }]);
    expect(repository.find(SEED_IDS.facility, {})).toEqual([expect.objectContaining({
      residentId: SEED_IDS.resident,
      name: "Blue cardigan",
      status: "active",
      washCount: 4,
    })]);
  });

  test("rejects station config objects and unknown IDs without fetching or mutating the repository", async () => {
    const fetchImpl = vi.fn(async () => response(ledger())) as unknown as typeof fetch;
    const { connector, repository } = await setup(fetchImpl);

    await expect((connector.refreshStation as (stationId: unknown) => Promise<void>)({
      ...station,
      facilityId: "facility_other",
    })).rejects.toThrow("rfid_station_not_configured");
    await expect(connector.refreshStation(OTHER_STATION_ID)).rejects.toThrow("rfid_station_not_configured");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(repository.overview(SEED_IDS.facility)).toEqual(expect.objectContaining({
      availability: "never_synced",
      warnings: [],
    }));
  });

  test("captures immutable station authority when the connector is created", async () => {
    const configured = { ...station };
    const requests: Array<{ input: string; authorization: string | null }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        input: String(input),
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      return response(ledger());
    }) as unknown as typeof fetch;
    const db = openDb(":memory:");
    await seed(db);
    const repository = createLaundryRepository(db);
    const connector = createRfidConnector({ repository, stations: [configured], fetch: fetchImpl });
    configured.facilityId = "facility_other";
    configured.baseUrl = "https://attacker.invalid";
    configured.token = "changed-token";

    await connector.refreshStation(STATION_ID);

    expect(requests).toEqual([{
      input: "https://rfid.local/api/ledger",
      authorization: `Bearer ${TOKEN}`,
    }]);
    expect(repository.find(SEED_IDS.facility, {}).map((row) => row.name)).toEqual(["Blue cardigan"]);
    expect(repository.overview("facility_other").availability).toBe("never_synced");
  });

  test("rejects a returned station identity mismatch and preserves last-known-good rows", async () => {
    const bodies = [ledger(), ledger({ station_id: OTHER_STATION_ID })];
    const fetchImpl = vi.fn(async () => response(bodies.shift())) as unknown as typeof fetch;
    const { connector, repository } = await setup(fetchImpl);
    await connector.refreshAll();

    await connector.refreshAll();

    expect(repository.find(SEED_IDS.facility, {}).map((row) => row.name)).toEqual(["Blue cardigan"]);
    expect(repository.overview(SEED_IDS.facility).warnings).toEqual([{
      kind: "station_identity_mismatch",
      message: "RFID station identity did not match configuration",
    }]);
  });

  test.each([
    ["unknown garment status", { status: "donated" }],
    ["negative wash count", { wash_count: -1 }],
    ["fractional wash count", { wash_count: 1.5 }],
  ])("validates every garment before replacing on %s", async (_name, invalidField) => {
    const valid = ledger();
    const invalid = ledger({
      garments: [valid.garments[0], { ...valid.garments[0], epc: "E200002", name: "Bad row", ...invalidField }],
    });
    const bodies = [valid, invalid];
    const fetchImpl = vi.fn(async () => response(bodies.shift())) as unknown as typeof fetch;
    const { connector, repository } = await setup(fetchImpl);
    await connector.refreshAll();

    await connector.refreshAll();

    expect(repository.find(SEED_IDS.facility, {}).map((row) => row.name)).toEqual(["Blue cardigan"]);
    expect(repository.overview(SEED_IDS.facility).warnings).toEqual([{
      kind: "invalid_payload",
      message: "RFID station returned invalid ledger data",
    }]);
  });

  test.each([
    ["empty registry timestamp", () => ledger({
      registry: { version: 8, written_at: "", etag: "next-etag" },
      garments: [{ ...ledger().garments[0], name: "Bad timestamp" }],
    })],
    ["invalid registry timestamp", () => ledger({
      registry: { version: 8, written_at: "yesterday", etag: "next-etag" },
      garments: [{ ...ledger().garments[0], name: "Bad timestamp" }],
    })],
    ["invalid last_seen", () => ledger({
      garments: [{ ...ledger().garments[0], name: "Bad timestamp", last_seen: "recently" }],
    })],
    ["invalid added_at", () => ledger({
      garments: [{ ...ledger().garments[0], name: "Bad timestamp", added_at: "today" }],
    })],
    ["invalid photo_url", () => ledger({
      garments: [{ ...ledger().garments[0], name: "Bad URL", photo_url: "not a URL" }],
    })],
  ])("rejects %s and preserves the last-known-good projection", async (_name, invalidLedger) => {
    const bodies = [ledger(), invalidLedger()];
    const fetchImpl = vi.fn(async () => response(bodies.shift())) as unknown as typeof fetch;
    const { connector, repository } = await setup(fetchImpl);
    await connector.refreshAll();

    await connector.refreshAll();

    expect(repository.find(SEED_IDS.facility, {}).map((row) => row.name)).toEqual(["Blue cardigan"]);
    expect(repository.overview(SEED_IDS.facility).warnings).toEqual([{
      kind: "invalid_payload",
      message: "RFID station returned invalid ledger data",
    }]);
  });

  test.each([
    "/photos/E200001.jpg",
    "https://rfid.local/photos/E200001.jpg",
  ])("accepts a valid station photo URL without copying it to the projection: %s", async (photoUrl) => {
    const body = ledger({ garments: [{ ...ledger().garments[0], photo_url: photoUrl }] });
    const { connector, repository } = await setup(vi.fn(async () => response(body)) as unknown as typeof fetch);

    await connector.refreshAll();

    expect(repository.find(SEED_IDS.facility, {})[0]).toEqual(expect.objectContaining({ name: "Blue cardigan" }));
    expect(JSON.stringify(repository.find(SEED_IDS.facility, {}))).not.toContain(photoUrl);
  });

  test.each([
    ["HTTP", async () => new Response("no", { status: 503 })],
    ["JSON", async () => new Response("not-json", { status: 200 })],
    ["schema", async () => response({ ...ledger(), unexpected: true })],
  ])("records %s failures without replacing the last-known-good projection", async (_name, failureFetch) => {
    let failing = false;
    const fetchImpl = vi.fn(async () => failing ? failureFetch() : response(ledger())) as unknown as typeof fetch;
    const { connector, repository } = await setup(fetchImpl);
    await connector.refreshAll();
    failing = true;

    await connector.refreshAll();

    expect(repository.find(SEED_IDS.facility, {}).map((row) => row.name)).toEqual(["Blue cardigan"]);
    expect(repository.overview(SEED_IDS.facility).warnings).toHaveLength(1);
  });

  test("keeps station scan warnings on an otherwise valid snapshot", async () => {
    const body = ledger({
      warnings: [{ kind: "missing_scan_log", message: "scan journal is unavailable; wash facts are not known" }],
      garments: [{ ...ledger().garments[0], wash_count: null, last_seen: null }],
    });
    const { connector, repository } = await setup(vi.fn(async () => response(body)) as unknown as typeof fetch);

    await connector.refreshAll();

    expect(repository.overview(SEED_IDS.facility).warnings).toEqual(body.warnings);
    expect(repository.find(SEED_IDS.facility, {})[0]).toEqual(expect.objectContaining({ washCount: 0, lastSeen: null }));
  });

  test("redacts credentials from recorded and thrown failure details", async () => {
    const { connector, repository } = await setup(vi.fn(async () => {
      throw new Error(`request failed with Authorization: Bearer ${TOKEN}`);
    }) as unknown as typeof fetch);

    let thrown: unknown;
    try {
      await connector.refreshAll();
    } catch (error) {
      thrown = error;
    }
    const observable = JSON.stringify({ thrown, overview: repository.overview(SEED_IDS.facility) });
    expect(observable).not.toContain(TOKEN);
    expect(observable).not.toContain("Bearer");
  });

  test("coalesces overlapping refreshAll calls into one station request", async () => {
    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn(async () => pending) as unknown as typeof fetch;
    const { connector } = await setup(fetchImpl);

    const first = connector.refreshAll();
    const second = connector.refreshAll();

    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release(response(ledger()));
    await first;
  });
});
