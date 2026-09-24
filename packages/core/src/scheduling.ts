export type VisitSlotState = "available" | "blocked";

export type VisitBlockReason = "lunch" | "staff_handoff" | "dinner_quiet";

export interface VisitSlotDefinition {
  localDate: string;
  startMinute: number;
  endMinute: number;
  state: VisitSlotState;
  reason?: VisitBlockReason;
}

export const DEMO_VISIT_POLICY = {
  timeZone: "Asia/Taipei",
  windowDays: 14,
  slotDurationMinutes: 60,
  dayStartMinute: 9 * 60,
  dayEndMinute: 18 * 60,
  bookableStartMinutes: [9 * 60, 10 * 60, 11 * 60, 13 * 60, 14 * 60, 15 * 60],
  blockedPeriods: [
    { startMinute: 12 * 60, endMinute: 13 * 60, reason: "lunch" },
    { startMinute: 16 * 60, endMinute: 17 * 60, reason: "staff_handoff" },
    { startMinute: 17 * 60, endMinute: 18 * 60, reason: "dinner_quiet" },
  ],
} as const;

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MINUTES_PER_DAY = 24 * 60;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

interface ParsedLocalDate {
  year: number;
  month: number;
  day: number;
  utcMillis: number;
}

function parseLocalDate(localDate: string): ParsedLocalDate | undefined {
  const match = LOCAL_DATE_PATTERN.exec(localDate);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }

  return { year, month, day, utcMillis: date.getTime() };
}

function requireLocalDate(localDate: string): ParsedLocalDate {
  const parsed = parseLocalDate(localDate);
  if (!parsed) throw new RangeError(`Invalid local date: ${localDate}`);
  return parsed;
}

export function buildVisitSlotDefinitions(localDate: string): VisitSlotDefinition[] {
  requireLocalDate(localDate);

  const definitions: VisitSlotDefinition[] = [];
  for (
    let startMinute = DEMO_VISIT_POLICY.dayStartMinute;
    startMinute < DEMO_VISIT_POLICY.dayEndMinute;
    startMinute += DEMO_VISIT_POLICY.slotDurationMinutes
  ) {
    const endMinute = startMinute + DEMO_VISIT_POLICY.slotDurationMinutes;
    const blockedPeriod = DEMO_VISIT_POLICY.blockedPeriods.find(
      (period) => period.startMinute === startMinute && period.endMinute === endMinute,
    );

    if (blockedPeriod) {
      definitions.push({
        localDate,
        startMinute,
        endMinute,
        state: "blocked",
        reason: blockedPeriod.reason,
      });
    } else {
      definitions.push({ localDate, startMinute, endMinute, state: "available" });
    }
  }
  return definitions;
}

export function isVisitDateInWindow(localDate: string, todayLocalDate: string): boolean {
  const candidate = parseLocalDate(localDate);
  const today = parseLocalDate(todayLocalDate);
  if (!candidate || !today) return false;

  const dayOffset = (candidate.utcMillis - today.utcMillis) / MILLISECONDS_PER_DAY;
  return dayOffset >= 0 && dayOffset < DEMO_VISIT_POLICY.windowDays;
}

function createLocalWallClockMillis(date: ParsedLocalDate, startMinute: number): number {
  if (!Number.isInteger(startMinute) || startMinute < 0 || startMinute >= MINUTES_PER_DAY) {
    throw new RangeError(`Invalid slot start minute: ${startMinute}`);
  }

  const wallClock = new Date(0);
  wallClock.setUTCFullYear(date.year, date.month - 1, date.day);
  wallClock.setUTCHours(Math.floor(startMinute / 60), startMinute % 60, 0, 0);
  return wallClock.getTime();
}

function zonedDateAsUtcMillis(formatter: Intl.DateTimeFormat, instantMillis: number): number {
  const parts = formatter.formatToParts(new Date(instantMillis));
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }

  return Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
}

export function localSlotToIso(localDate: string, startMinute: number, timeZone: string): string {
  const parsedDate = requireLocalDate(localDate);
  const wallClockMillis = createLocalWallClockMillis(parsedDate, startMinute);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  let instantMillis = wallClockMillis;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const offsetMillis = zonedDateAsUtcMillis(formatter, instantMillis) - instantMillis;
    const nextInstantMillis = wallClockMillis - offsetMillis;
    if (nextInstantMillis === instantMillis) return new Date(instantMillis).toISOString();
    instantMillis = nextInstantMillis;
  }

  return new Date(instantMillis).toISOString();
}
