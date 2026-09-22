import { z } from "zod";

const stationSchema = z.object({
  stationId: z.string().uuid(),
  facilityId: z.string().trim().min(1),
  baseUrl: z.string().url().superRefine((value, ctx) => {
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "station URL must use HTTPS unless it is loopback" });
    }
  }),
  token: z.string().trim().min(1),
}).strict();

const stationsSchema = z.array(stationSchema).superRefine((stations, ctx) => {
  const seen = new Set<string>();
  stations.forEach((station, index) => {
    if (seen.has(station.stationId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "stationId"],
        message: "duplicate station ID",
      });
    }
    seen.add(station.stationId);
  });
});

export type RfidStationConfig = z.infer<typeof stationSchema>;

export function parseRfidStations(env: Record<string, string | undefined>): RfidStationConfig[] {
  const configured = env.ONCARE_RFID_STATIONS;
  if (configured === undefined || configured.trim() === "") return [];

  let value: unknown;
  try {
    value = JSON.parse(configured);
  } catch {
    throw new Error("ONCARE_RFID_STATIONS must be valid JSON");
  }
  const parsed = stationsSchema.safeParse(value);
  if (!parsed.success) throw new Error("ONCARE_RFID_STATIONS is invalid");
  return parsed.data;
}

const DEFAULT_RFID_POLL_INTERVAL_MS = 60_000;
const MIN_RFID_POLL_INTERVAL_MS = 250;

export function parseRfidIntervalMs(env: Record<string, string | undefined>): number {
  const configured = env.ONCARE_RFID_POLL_INTERVAL_MS;
  if (configured === undefined || configured.trim() === "") return DEFAULT_RFID_POLL_INTERVAL_MS;
  const trimmed = configured.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) throw new Error("ONCARE_RFID_POLL_INTERVAL_MS is invalid");
  const intervalMs = Number(trimmed);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_RFID_POLL_INTERVAL_MS || intervalMs > DEFAULT_RFID_POLL_INTERVAL_MS) {
    throw new Error("ONCARE_RFID_POLL_INTERVAL_MS is invalid");
  }
  return intervalMs;
}
