import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const API_BASE = "http://127.0.0.1:3000";
const FIXTURE_BASE = "http://127.0.0.1:3101";
const LAUNDRY_TOOLS = ["find_garments", "get_laundry_overview"];

type ToolEnvelope = {
  result?: {
    availability?: string;
    total?: number;
    syncedAt?: string | null;
    warnings?: Array<{ kind?: string }>;
  };
};

async function resetFixture(request: APIRequestContext) {
  const response = await request.post(`${FIXTURE_BASE}/__control/reset`);
  expect(response.ok()).toBeTruthy();
}

async function setFixtureUnavailable(request: APIRequestContext) {
  const response = await request.post(`${FIXTURE_BASE}/__control`, {
    data: { mode: "unavailable" },
  });
  expect(response.ok()).toBeTruthy();
}

async function adminToken(request: APIRequestContext): Promise<string> {
  const response = await request.post(`${API_BASE}/auth/login`, {
    data: { username: "admin", password: "admin-demo-pass" },
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json() as { token: string };
  return body.token;
}

async function invoke(
  request: APIRequestContext,
  token: string,
  tool: (typeof LAUNDRY_TOOLS)[number],
  data: Record<string, string> = {},
): Promise<ToolEnvelope> {
  const response = await request.post(`${API_BASE}/tools/${tool}/invoke`, {
    headers: { authorization: `Bearer ${token}` },
    data,
  });
  expect(response.ok()).toBeTruthy();
  return await response.json() as ToolEnvelope;
}

async function waitForHealthyLedger(request: APIRequestContext, token: string) {
  await expect.poll(async () => {
    const body = await invoke(request, token, "get_laundry_overview");
    return {
      availability: body.result?.availability,
      total: body.result?.total,
      warnings: body.result?.warnings?.map((warning) => warning.kind),
    };
  }, { timeout: 15_000 }).toEqual({ availability: "available", total: 1, warnings: [] });
}

async function loginAsAdmin(page: Page) {
  await page.goto("http://127.0.0.1:5175/?mode=manager");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("admin-demo-pass");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("tab", { name: "Facility admin" })).toBeVisible();
}

function formatSyncTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

async function openFacilityAdmin(page: Page): Promise<ToolEnvelope> {
  const overview = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/tools/get_laundry_overview/invoke")
      && response.request().method() === "POST", { timeout: 15_000 });
  await page.getByRole("tab", { name: "Facility admin" }).click();
  await expect(page.getByRole("heading", { name: "Laundry AI" })).toBeVisible();
  return await (await overview).json() as ToolEnvelope;
}

async function searchBlueCardigan(page: Page): Promise<ToolEnvelope> {
  await page.getByLabel("Garment name").fill("blue cardigan");
  const search = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/tools/find_garments/invoke")
      && response.request().method() === "POST", { timeout: 15_000 });
  await page.getByRole("button", { name: "Find garments" }).click();
  return await (await search).json() as ToolEnvelope;
}

test.beforeEach(async ({ request }) => {
  await resetFixture(request);
  const token = await adminToken(request);
  await waitForHealthyLedger(request, token);
});

test.afterEach(async ({ request }) => {
  await resetFixture(request);
});

test("manager sees the fixture summary, blue cardigan, and exact visible sync time", async ({ page }) => {
  await loginAsAdmin(page);
  const overview = await openFacilityAdmin(page);
  const overviewSyncedAt = overview.result?.syncedAt;
  expect(typeof overviewSyncedAt).toBe("string");

  const totals = page.getByLabel("Laundry totals");
  await expect(totals.locator("div").filter({ hasText: "Total" }).locator("dd")).toHaveText("1");
  await expect(totals.locator("div").filter({ hasText: "Active" }).locator("dd")).toHaveText("1");
  await expect(page.getByLabel("Overview data freshness").locator("span"))
    .toHaveText(formatSyncTime(overviewSyncedAt as string));

  const search = await searchBlueCardigan(page);
  const searchSyncedAt = search.result?.syncedAt;
  expect(typeof searchSyncedAt).toBe("string");
  await expect(page.getByLabel("Search result freshness").locator("span"))
    .toHaveText(formatSyncTime(searchSyncedAt as string));
  const row = page.getByRole("row").filter({ hasText: "Blue cardigan" });
  await expect(row).toContainText("Demo Resident");
  await expect(row).toContainText("blue, cardigan");
  await expect(row).toContainText("Active");
  await expect(row).toContainText("4");
  await expect(page.getByText("E200001")).toHaveCount(0);
});

test("an unavailable poll preserves the last-known-good cardigan with a safe warning", async ({ page, request }) => {
  const token = await adminToken(request);
  await loginAsAdmin(page);
  await openFacilityAdmin(page);
  await searchBlueCardigan(page);

  await setFixtureUnavailable(request);
  await expect.poll(async () => {
    const body = await invoke(request, token, "find_garments", { name: "blue cardigan" });
    return body.result?.warnings?.map((warning) => warning.kind) ?? [];
  }, { timeout: 15_000 }).toContain("station_unavailable");

  const degraded = await searchBlueCardigan(page);
  expect(degraded.result?.warnings?.map((warning) => warning.kind)).toContain("station_unavailable");
  await expect(page.getByText("Station data is temporarily unavailable.")).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "Blue cardigan" });
  await expect(row).toContainText("Demo Resident");
  await expect(row).toContainText("blue, cardigan");
  await expect(page.getByText("E200001")).toHaveCount(0);
});
