import { expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";

const CLOCK_FILE = process.env.ONCARE_TEST_CLOCK_FILE;
const INITIAL_CLOCK = new Date().toISOString();
const FACILITY_TIME_ZONE = "Asia/Taipei";
const SLOT_START = 540;

function localDateAt(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: FACILITY_TIME_ZONE, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const fields = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return fields.year + "-" + fields.month + "-" + fields.day;
}

function addDays(localDate: string, amount: number): string {
  const value = new Date(localDate + "T00:00:00.000Z");
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function localSlotIso(localDate: string, startMinute: number): string {
  const hour = Math.floor(startMinute / 60).toString().padStart(2, "0");
  const minute = (startMinute % 60).toString().padStart(2, "0");
  return new Date(localDate + "T" + hour + ":" + minute + ":00+08:00").toISOString();
}

const LOCAL_DATE = addDays(localDateAt(new Date(INITIAL_CLOCK)), 1);
const DISPATCH_AT = localSlotIso(LOCAL_DATE, SLOT_START - 5);
const VISIT_START = localSlotIso(LOCAL_DATE, SLOT_START);

function setClock(value: string): void {
  if (!CLOCK_FILE) throw new Error("Playwright clock file was not configured");
  writeFileSync(CLOCK_FILE, value);
}

async function familyVisit(page: Page, visitId: string): Promise<{ visit?: { state: string } }> {
  return page.evaluate(async (id) => {
    const session = sessionStorage.getItem("oncare.family");
    if (!session) throw new Error("Family session is not available");
    const token = (JSON.parse(session) as { token: string }).token;
    const response = await fetch("/api/visits/" + encodeURIComponent(id), { headers: { authorization: "Bearer " + token } });
    if (!response.ok) throw new Error("Visit request failed: " + response.status);
    return response.json();
  }, visitId);
}

async function staffQueue(page: Page): Promise<{
  reservations?: Array<{ id: string; visitId: string | null; status: string }>;
}> {
  return page.evaluate(async () => {
    const session = sessionStorage.getItem("oncare.staff");
    if (!session) throw new Error("Staff session is not available");
    const token = (JSON.parse(session) as { token: string }).token;
    const response = await fetch("/api/queue", { headers: { authorization: "Bearer " + token } });
    if (!response.ok) throw new Error("Queue request failed: " + response.status);
    return response.json();
  });
}

test("scheduled visit: family proposal, resident confirmation, dispatch, incoming call, fake video completion", async ({ browser }) => {
  test.setTimeout(180_000);
  setClock(INITIAL_CLOCK);

  const familyContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const residentContext = await browser.newContext({ viewport: { width: 1180, height: 820 }, permissions: ["camera", "microphone"] });
  const staffContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const family = await familyContext.newPage();
  const resident = await residentContext.newPage();
  const staff = await staffContext.newPage();
  let scheduledVisitId: string | null = null;
  await family.clock.install({ time: INITIAL_CLOCK });
  await resident.clock.install({ time: INITIAL_CLOCK });
  await staff.clock.install({ time: INITIAL_CLOCK });

  try {
    await resident.goto("http://localhost:5173/");
    await resident.getByLabel("Device token").fill("1234");
    await resident.getByRole("button", { name: "Save" }).click();
    await expect(resident.getByRole("button", { name: "Schedule a visit" })).toBeVisible({ timeout: 30_000 });
    await resident.getByRole("radio", { name: /Demo Daughter/ }).check();
    await resident.getByRole("button", { name: "Schedule a visit" }).click();
    await expect(resident.getByTestId("resident-visit-calendar")).toBeVisible();

    await staff.goto("http://localhost:5175/");
    await staff.getByLabel("Username").fill("staff");
    await staff.getByLabel("Password").fill("1234");
    await staff.getByRole("button", { name: "Sign in" }).click();
    await expect(staff.getByRole("heading", { name: "Today" })).toBeVisible({ timeout: 30_000 });
    await expect(staff.getByText("Connected")).toBeVisible({ timeout: 30_000 });

    await family.goto("http://localhost:5174/");
    await family.getByLabel("Username").fill("family");
    await family.getByLabel("Password").fill("1234");
    await family.getByRole("button", { name: "Sign in" }).click();
    await family.getByRole("button", { name: "Schedule a visit" }).click();
    await expect(family.getByTestId("family-schedule")).toBeVisible();
    await family.getByTestId("family-date-" + LOCAL_DATE).click();
    await family.getByTestId("family-slot-" + LOCAL_DATE + "-" + SLOT_START).click();
    await family.getByTestId("family-request-visit").click();
    await expect(family.getByText("Visit request sent. Waiting for confirmation.")).toBeVisible();
    const familyReservation = family.locator("[data-testid^=\"family-reservation-card-\"]");
    await expect(familyReservation).toBeVisible();
    const reservationTestId = await familyReservation.getAttribute("data-testid");
    const reservationId = reservationTestId?.replace("family-reservation-card-", "");
    expect(reservationId).toBeTruthy();
    await expect(staff.getByText("Upcoming visit")).toBeVisible({ timeout: 20_000 });

    // Reloading the kiosk exercises the persisted proposal rather than relying only on the event stream.
    await resident.reload();
    await expect(resident.getByRole("button", { name: "Schedule a visit" })).toBeVisible({ timeout: 30_000 });
    await resident.getByRole("radio", { name: /Demo Daughter/ }).check();
    await resident.getByRole("button", { name: "Schedule a visit" }).click();
    await resident.getByTestId("resident-date-" + LOCAL_DATE).click();
    await expect(resident.getByText("Waiting for confirmation")).toBeVisible({ timeout: 20_000 });
    await resident.getByRole("button", { name: "Confirm time" }).click();
    await expect(resident.getByText("Visit confirmed")).toBeVisible();

    setClock(DISPATCH_AT);
    await family.clock.setFixedTime(DISPATCH_AT);
    await resident.clock.setFixedTime(DISPATCH_AT);
    await staff.clock.setFixedTime(DISPATCH_AT);
    await expect.poll(async () => {
      const queue = await staffQueue(staff);
      return queue.reservations?.find((item) => item.id === reservationId)?.visitId ?? null;
    }, { timeout: 30_000, intervals: [500, 1000, 2000] }).toBeTruthy();
    scheduledVisitId = (await staffQueue(staff)).reservations?.find((item) => item.id === reservationId)?.visitId ?? null;
    expect(scheduledVisitId).toBeTruthy();
    await expect.poll(async () => (await familyVisit(family, scheduledVisitId!)).visit?.state ?? "missing", { timeout: 30_000, intervals: [500, 1000, 2000] }).toBe("awaiting_resident_consent");
    await expect(family.getByRole("button", { name: "Open visit" })).toBeVisible({ timeout: 20_000 });
    await family.getByRole("button", { name: "Open visit" }).click();
    await expect(family.getByRole("heading", { name: /Visit with Demo Resident/ })).toBeVisible({ timeout: 20_000 });

    setClock(VISIT_START);
    await family.clock.setFixedTime(VISIT_START);
    await resident.clock.setFixedTime(VISIT_START);
    await staff.clock.setFixedTime(VISIT_START);
    await expect(resident.getByRole("button", { name: "Answer" })).toBeVisible({ timeout: 30_000 });
    await expect(resident.getByText("Demo Daughter is calling")).toBeVisible();
    await resident.getByRole("button", { name: "Answer" }).click();
    await expect(resident.getByTestId("video-stage")).toBeVisible();
    await expect(family.getByRole("region", { name: "Video call" })).toBeVisible({ timeout: 30_000 });
    await expect(family.getByText("Connected")).toBeVisible({ timeout: 30_000 });

    await family.getByRole("button", { name: "End call" }).click();
    await expect(family.getByText("Finished")).toHaveAttribute("aria-current", "step", { timeout: 30_000 });
  } finally {
    await familyContext.close();
    await residentContext.close();
    await staffContext.close();
  }
});
