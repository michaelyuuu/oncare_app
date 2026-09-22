import { expect, test } from "@playwright/test";

test("manager navigation does not grant facility administration", async ({ page }) => {
  await page.goto("http://localhost:5172/");
  await expect(page.getByText("SIMULATED", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Resident" })).toBeVisible();

  await page.getByRole("link", { name: "Manager" }).click();
  await expect(page).toHaveURL(/localhost:5175.*mode=manager/);
  await expect(page.getByRole("heading", { name: /manager/i })).toBeVisible();

  await page.getByLabel("Username").fill("staff");
  await page.getByLabel("Password").fill("staff-demo-pass");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Facility admin" })).toHaveCount(0);

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("admin-demo-pass");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("tab", { name: "Facility admin" })).toBeVisible();
});
