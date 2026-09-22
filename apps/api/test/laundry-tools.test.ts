import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";
import type { StationLedgerSnapshot } from "../src/services/laundry-repository";
import { makeTestApp } from "./helpers";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const STATION_ID = "33333333-3333-4333-8333-333333333333";
const SYNCED_AT = "2026-09-21T12:00:00.000Z";
const GENERIC_PUBLIC_WARNING = {
  kind: "laundry_data_warning",
  message: "Some laundry data may be incomplete.",
};

const snapshot: StationLedgerSnapshot = {
  stationId: STATION_ID,
  facilityId: SEED_IDS.facility,
  sourceVersion: 1,
  sourceUpdatedAt: SYNCED_AT,
  warnings: [{ kind: "station_notice", message: "Using verified projection data" }],
  garments: [{
    sourceKey: "EPC-SECRET-001",
    residentId: SEED_IDS.resident,
    name: "Blue cardigan",
    category: "cardigan",
    color: "blue",
    status: "active",
    washCount: 4,
    lastSeen: "2026-09-21T11:59:00.000Z",
  }],
};

async function setup() {
  const ctx = await makeTestApp({ now: () => new Date(SYNCED_AT) });
  const invoke = (token: string, name: string, payload: unknown = {}) =>
    ctx.app.inject({ method: "POST", url: `/tools/${name}/invoke`, headers: auth(token), payload: payload as object });
  const list = async (token: string) =>
    (await ctx.app.inject({ method: "GET", url: "/tools", headers: auth(token) })).json().tools as Array<{
      name: string;
      effect: string;
      confirm: boolean;
      inputSchema: Record<string, unknown>;
    }>;
  return { ...ctx, invoke, list };
}

function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...allKeys(nested)]);
}

describe("manager laundry tools", () => {
  test("only admins discover the read-only laundry tools and other roles receive unknown_tool", async () => {
    const { app, tokens, list, invoke } = await setup();
    const toolNames = ["get_laundry_overview", "find_garments"];

    for (const token of [tokens.device, tokens.family, tokens.staff]) {
      expect((await list(token)).map((tool) => tool.name)).not.toEqual(expect.arrayContaining(toolNames));
      for (const name of toolNames) {
        const response = await invoke(token, name);
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: "unknown_tool" });
      }
    }

    const adminTools = (await list(tokens.admin)).filter((tool) => toolNames.includes(tool.name));
    expect(adminTools.map((tool) => tool.name).sort()).toEqual([...toolNames].sort());
    expect(adminTools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "get_laundry_overview", effect: "read", confirm: false }),
      expect.objectContaining({ name: "find_garments", effect: "read", confirm: false }),
    ]));
    for (const tool of adminTools) {
      expect(allKeys(tool.inputSchema).filter((key) => /epc|sourceKey|token|photo|scan|stationId/i.test(key))).toEqual([]);
    }
    await app.close();
  });

  test("uses strict, bounded input schemas and never accepts facility scope", async () => {
    const { app, tokens, invoke } = await setup();

    for (const [name, payload] of [
      ["get_laundry_overview", { residentId: "" }],
      ["get_laundry_overview", { facilityId: "facility_other" }],
      ["find_garments", { name: "x".repeat(101) }],
      ["find_garments", { category: "x".repeat(51) }],
      ["find_garments", { color: "x".repeat(51) }],
      ["find_garments", { status: "washing" }],
      ["find_garments", { facilityId: "facility_other" }],
    ] as const) {
      const response = await invoke(tokens.admin, name, payload);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "bad_input" });
    }
    await app.close();
  });

  test("checks resident access before repository reads and does not disclose cross-facility data", async () => {
    const { app, db, tokens, invoke } = await setup();
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
    const overview = vi.spyOn(app.laundry, "overview");
    const find = vi.spyOn(app.laundry, "find");

    expect(await app.tools.invoke({
      kind: "user",
      id: "admin_without_facility",
      role: "admin",
      facilityId: null,
    }, "get_laundry_overview", {})).toMatchObject({ ok: false, status: 403, error: "forbidden" });

    const overviewResponse = await invoke(tokens.admin, "get_laundry_overview", { residentId: "resident_other" });
    const findResponse = await invoke(tokens.admin, "find_garments", { residentId: "resident_other" });

    expect(overviewResponse.statusCode).toBe(403);
    expect(overviewResponse.json()).toEqual({ error: "forbidden" });
    expect(findResponse.statusCode).toBe(403);
    expect(findResponse.json()).toEqual({ error: "forbidden" });
    expect(overview).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
    await app.close();
  });

  test("returns freshness envelopes without RFID secrets and audits successful calls", async () => {
    const { app, db, tokens, invoke } = await setup();
    app.laundry.replaceStation(snapshot);

    const overview = await invoke(tokens.admin, "get_laundry_overview", { residentId: SEED_IDS.resident });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().result).toEqual({
      availability: "available",
      total: 1,
      active: 1,
      lostOrDiscarded: 0,
      recentlyWashed: 1,
      syncedAt: SYNCED_AT,
      stale: false,
      warnings: [GENERIC_PUBLIC_WARNING],
    });

    const found = await invoke(tokens.admin, "find_garments", {
      residentId: SEED_IDS.resident,
      name: " cardigan ",
      category: " cardigan ",
      color: " blue ",
      status: "active",
    });
    expect(found.statusCode).toBe(200);
    expect(found.json().result).toEqual({
      availability: "available",
      syncedAt: SYNCED_AT,
      stale: false,
      warnings: [GENERIC_PUBLIC_WARNING],
      garments: [{
        residentId: SEED_IDS.resident,
        residentName: "Demo Resident",
        name: "Blue cardigan",
        category: "cardigan",
        color: "blue",
        status: "active",
        washCount: 4,
        lastSeen: "2026-09-21T11:59:00.000Z",
        syncedAt: SYNCED_AT,
        stale: false,
      }],
    });

    for (const result of [overview.json().result, found.json().result]) {
      expect(allKeys(result).filter((key) => /epc|sourceKey|token|photo|scan|stationId/i.test(key))).toEqual([]);
    }
    const audit = db.select().from(t.auditEvent).where(eq(t.auditEvent.actorType, "ai")).all();
    expect(audit).toEqual([
      expect.objectContaining({
        actorId: SEED_IDS.adminUser,
        entityType: "tool",
        entityId: "get_laundry_overview",
        reason: "tool_invoked",
        correlationId: SEED_IDS.facility,
      }),
      expect.objectContaining({
        actorId: SEED_IDS.adminUser,
        entityType: "tool",
        entityId: "find_garments",
        reason: "tool_invoked",
        correlationId: SEED_IDS.facility,
      }),
    ]);
    await app.close();
  });

  test("sanitizes warning kinds, messages, and counts at the tool boundary", async () => {
    const { app, tokens, invoke } = await setup();
    const secrets = [
      "E200-RAW-EPC-SECRET",
      "station-token-secret-123",
      "sk-provider-key-secret-456",
      "https://rfid.internal/photos/private-garment.jpg",
      "scan-journal-fragment-resident-42",
    ];
    app.laundry.replaceStation({
      ...snapshot,
      warnings: [
        { kind: "missing_scan_log", message: `source leaked ${secrets[0]}`, count: 3 },
        { kind: "station_unavailable", message: `source leaked ${secrets[1]}` },
        { kind: "invalid_payload", message: `source leaked ${secrets[2]}` },
        { kind: "station_identity_mismatch", message: `source leaked ${secrets[3]}` },
        ...secrets.map((secret, index) => ({
          kind: `legacy:${secret}`,
          message: `legacy warning ${secret}`,
          count: [7, 1_000_000, -1, 1.5, Number.NaN][index]!,
        })),
      ],
    });

    const overview = await invoke(tokens.admin, "get_laundry_overview");
    const found = await invoke(tokens.admin, "find_garments");
    expect(overview.statusCode).toBe(200);
    expect(found.statusCode).toBe(200);
    const expectedWarnings = [
      { kind: "wash_history_unavailable", message: "Laundry wash history is temporarily unavailable.", count: 3 },
      { kind: "station_unavailable", message: "Laundry station data is temporarily unavailable." },
      { kind: "invalid_data", message: "Laundry station data could not be verified." },
      { kind: "station_identity_mismatch", message: "Laundry station identity could not be verified." },
      { ...GENERIC_PUBLIC_WARNING, count: 7 },
      { ...GENERIC_PUBLIC_WARNING, count: 10_000 },
      GENERIC_PUBLIC_WARNING,
      GENERIC_PUBLIC_WARNING,
      GENERIC_PUBLIC_WARNING,
    ];
    expect(overview.json().result.warnings).toEqual(expectedWarnings);
    expect(found.json().result.warnings).toEqual(expectedWarnings);

    const serializedResults = JSON.stringify([overview.json().result, found.json().result]);
    for (const secret of secrets) expect(serializedResults).not.toContain(secret);
    for (const result of [overview.json().result, found.json().result]) {
      expect(allKeys(result).filter((key) => /epc|sourceKey|token|photo|scan|stationId/i.test(key))).toEqual([]);
    }
    await app.close();
  });
});
