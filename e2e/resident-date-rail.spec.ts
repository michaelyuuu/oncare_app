import { expect, test } from "@playwright/test";

test("resident visit dates scroll vertically on a landscape display", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.goto("http://localhost:5173/");
  await page.getByLabel("Device token").fill("1234");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Schedule a visit" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("radio", { name: /Demo Daughter/ }).check();
  await page.getByRole("button", { name: "Schedule a visit" }).click();

  const dateRail = page.getByRole("navigation", { name: "Visit dates" });
  await expect(dateRail).toBeVisible();
  await expect.poll(() => dateRail.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
  await dateRail.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => dateRail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});
