import { expect, test } from "@playwright/test";

const PORTAL_BASE = process.env.ONCARE_PORTAL_E2E_BASE ?? "http://localhost:5172";

test("manager navigation does not grant facility administration", async ({ page }) => {
  await page.goto(`${PORTAL_BASE}/`);
  await expect(page.getByText("SIMULATED", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Resident" })).toBeVisible();

  await page.getByRole("link", { name: "Manager" }).click();
  await expect(page).toHaveURL(/localhost:5175.*mode=manager/);
  await expect(page.getByRole("heading", { name: /manager/i })).toBeVisible();

  await page.getByLabel("Username").fill("staff");
  await page.getByLabel("Password").fill("staff-demo-pass");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  for (const destination of ["Laundry", "Residents", "Family links", "People", "Devices"])
    await expect(page.getByRole("button", { name: destination, exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("admin-demo-pass");
  await page.getByRole("button", { name: "Sign in" }).click();
  for (const destination of ["Laundry", "Residents", "Family links", "People", "Devices"])
    await expect(page.getByRole("button", { name: destination, exact: true })).toBeVisible();
});
