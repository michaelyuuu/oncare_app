import { z } from "zod";
import type { LaundryRepository, LaundryWarning, StationLedgerSnapshot } from "./laundry-repository";
import type { RfidStationConfig } from "./rfid-config";

const warningSchema = z.object({
  kind: z.string().min(1).max(100),
  message: z.string().max(500).optional(),
  count: z.number().int().nonnegative().optional(),
}).strict();

const isoDateTimeSchema = z.string().datetime({ offset: true });
const photoUrlSchema = z.union([
  z.string().url(),
  z.string().regex(/^\/(?!\/)[^\s]*$/),
]);

const residentSchema = z.object({
  resident_id: z.string(),
  name: z.string(),
  room: z.string(),
  floor: z.string(),
  photo: z.string(),
  kana: z.string(),
  admitted_on: z.string(),
  active: z.boolean(),
}).strict();

const garmentSchema = z.object({
  epc: z.string().min(1),
  name: z.string().min(1),
  color: z.string().min(1),
  category: z.string().min(1),
  owner: z.string(),
  added_at: isoDateTimeSchema,
  resident_id: z.string().min(1),
  size: z.string(),
  brand: z.string(),
  care_label: z.string(),
  tag_type: z.string(),
  status: z.enum(["active", "lost", "discarded"]),
  notes: z.string(),
  resident: residentSchema.nullable(),
  wash_count: z.number().int().nonnegative().nullable(),
  last_seen: isoDateTimeSchema.nullable(),
  photo_url: photoUrlSchema.nullable(),
}).strict();

const ledgerSchema = z.object({
  station_id: z.string().uuid(),
  registry: z.object({
    version: z.number().int().nonnegative(),
    written_at: isoDateTimeSchema,
    etag: z.string(),
  }).strict(),
  baseline: z.record(z.number().int().nonnegative()),
  baseline_etag: z.string().nullable(),
  garments: z.array(garmentSchema),
  residents: z.array(residentSchema),
  categories: z.array(z.string()),
  statuses: z.array(z.string()),
  warnings: z.array(warningSchema).max(100),
}).strict().superRefine((ledger, ctx) => {
  const washFactsUnavailable = ledger.warnings.some((warning) => warning.kind === "missing_scan_log");
  ledger.garments.forEach((garment, index) => {
    if (garment.wash_count === null && !washFactsUnavailable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["garments", index, "wash_count"],
        message: "null wash count requires a missing scan warning",
      });
    }
  });
});

export interface RfidConnectorOptions {
  repository: LaundryRepository;
  stations: RfidStationConfig[];
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  intervalMs?: number;
  requestTimeoutMs?: number;
}

export function createRfidConnector({
  repository,
  stations,
  fetch: fetchImpl = globalThis.fetch,
  intervalMs = 60_000,
  requestTimeoutMs = 10_000,
}: RfidConnectorOptions) {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60_000) {
    throw new Error("rfid_request_timeout_invalid");
  }
  let timer: ReturnType<typeof setInterval> | null = null;
  const activeRequests = new Set<() => void>();
  let pendingRefresh: Promise<void> | null = null;
  const configuredStations = stations.map((station) => Object.freeze({ ...station }));
  const stationById = new Map(configuredStations.map((station) => [station.stationId, station]));

  for (const station of configuredStations) {
    repository.registerStation({ stationId: station.stationId, facilityId: station.facilityId });
  }

  function recordUnavailable(stationId: string): void {
    repository.recordFailure(stationId, "unavailable", {
      kind: "station_unavailable",
      message: "RFID station is unavailable",
    });
  }

  function recordInvalid(stationId: string, warning: LaundryWarning = {
    kind: "invalid_payload",
    message: "RFID station returned invalid ledger data",
  }): void {
    repository.recordFailure(stationId, "invalid", warning);
  }

  function normalize(station: RfidStationConfig, input: unknown): StationLedgerSnapshot | null {
    const parsed = ledgerSchema.safeParse(input);
    if (!parsed.success) return null;
    if (parsed.data.station_id !== station.stationId) return null;
    return {
      stationId: station.stationId,
      facilityId: station.facilityId,
      sourceVersion: parsed.data.registry.version,
      sourceUpdatedAt: parsed.data.registry.written_at,
      warnings: parsed.data.warnings.map((warning) => ({
        kind: warning.kind,
        ...(warning.message !== undefined ? { message: warning.message } : {}),
        ...(warning.count !== undefined ? { count: warning.count } : {}),
      })),
      garments: parsed.data.garments.map((garment) => ({
        sourceKey: garment.epc,
        residentId: garment.resident_id,
        name: garment.name,
        category: garment.category,
        color: garment.color,
        status: garment.status,
        washCount: garment.wash_count ?? 0,
        lastSeen: garment.last_seen,
      })),
    };
  }

  async function refreshStation(stationId: string): Promise<void> {
    const station = stationById.get(stationId);
    if (!station) throw new Error("rfid_station_not_configured");
    const controller = new AbortController();
    const startedAt = Date.now();
    type Outcome = { snapshot: StationLedgerSnapshot } | "unavailable" | "invalid" | "identity_mismatch" | "timeout" | "stopped";
    let cancel!: () => void;
    let stopped = false;
    let timeout!: ReturnType<typeof setTimeout>;
    const interrupted = new Promise<Outcome>((resolve) => {
      cancel = () => {
        stopped = true;
        clearTimeout(timeout);
        resolve("stopped");
        controller.abort();
      };
      timeout = setTimeout(() => {
        resolve("timeout");
        controller.abort();
      }, requestTimeoutMs);
    });
    activeRequests.add(cancel);
    // Only this race's winner may mutate the projection. A late fetch/body result
    // is still observed by Promise.race, but cannot overwrite or warn after stop.
    const load = async (): Promise<Outcome> => {
      let response: Response;
      try {
        response = await fetchImpl(`${station.baseUrl.replace(/\/+$/, "")}/api/ledger`, {
          method: "GET",
          headers: { Authorization: `Bearer ${station.token}` },
          signal: controller.signal,
        });
      } catch {
        return "unavailable";
      }
      if (!response.ok) return "unavailable";
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return "invalid";
      }
      const snapshot = normalize(station, body);
      // Synchronous schema work can delay a timer callback; still reject an
      // over-deadline result instead of installing it as a successful refresh.
      if (Date.now() - startedAt >= requestTimeoutMs) return "timeout";
      if (snapshot !== null) return { snapshot };
      const returnedId = typeof body === "object" && body !== null && "station_id" in body
        ? (body as { station_id?: unknown }).station_id : undefined;
      return returnedId !== undefined && returnedId !== station.stationId ? "identity_mismatch" : "invalid";
    };
    try {
      const outcome = await Promise.race([load(), interrupted]);
      if (stopped || outcome === "stopped") return;
      if (outcome === "timeout") {
        controller.abort();
        repository.recordFailure(stationId, "unavailable", {
          kind: "station_unavailable", message: "RFID station request timed out",
        });
      } else if (outcome === "unavailable") {
        recordUnavailable(stationId);
      } else if (outcome === "invalid" || outcome === "identity_mismatch") {
        recordInvalid(stationId, outcome === "identity_mismatch" ? {
          kind: "station_identity_mismatch", message: "RFID station identity did not match configuration",
        } : undefined);
      } else {
        try { repository.replaceStation(outcome.snapshot); } catch { recordInvalid(stationId); }
      }
    } finally {
      clearTimeout(timeout);
      activeRequests.delete(cancel);
    }
  }

  function refreshAll(): Promise<void> {
    if (pendingRefresh) return pendingRefresh;
    const cycle = Promise.all(configuredStations.map((station) => refreshStation(station.stationId)))
      .then(() => undefined)
      .finally(() => { if (pendingRefresh === cycle) pendingRefresh = null; });
    pendingRefresh = cycle;
    return pendingRefresh;
  }

  function start() {
    if (configuredStations.length === 0 || timer) return;
    void refreshAll().catch(() => undefined);
    timer = setInterval(() => void refreshAll().catch(() => undefined), intervalMs);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    for (const cancel of activeRequests) cancel();
    activeRequests.clear();
    pendingRefresh = null;
  }

  return { refreshStation, refreshAll, start, stop };
}

export type RfidConnector = ReturnType<typeof createRfidConnector>;
