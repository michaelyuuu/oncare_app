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
