import { expect, test } from "@playwright/test";

test("handover section 8: visit, call, item request, tray delivery", async ({ browser }) => {
  test.setTimeout(180_000);
  const family = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const resident = await (await browser.newContext({ viewport: { width: 1024, height: 768 }, permissions: ["camera", "microphone"] })).newPage();
  const staff = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  try {
    await resident.goto("http://localhost:5173/");
    await resident.getByLabel("Device token").fill("device-demo-token");
    await resident.getByRole("button", { name: "Save" }).click();
    await expect(resident.getByText("Hello, Demo Resident")).toBeVisible();
    await expect(resident.getByText("SIMULATED ROBOT")).toBeVisible();

    await staff.goto("http://localhost:5175/");
    await staff.getByLabel("Username").fill("staff");
    await staff.getByLabel("Password").fill("staff-demo-pass");
    await staff.getByRole("button", { name: "Sign in" }).click();
    await expect(staff.getByText("Connected")).toBeVisible();

    await family.goto("http://localhost:5174/");
    await family.getByLabel("Username").fill("family");
    await family.getByLabel("Password").fill("family-demo-pass");
    await family.getByRole("button", { name: "Sign in" }).click();
    await family.getByRole("button", { name: "Send the robot to visit" }).click();
    await expect(family.getByText("Robot is on its way")).toHaveAttribute("aria-current", "step");

    const answer = resident.getByRole("button", { name: "Answer" });
    await expect(answer).toBeVisible({ timeout: 20_000 });
    await expect(resident.getByText("Demo Daughter is calling")).toBeVisible();
    await answer.click();
    await expect(resident.getByTestId("video-stage")).toBeVisible();

    const hasVideo = await resident.getByTestId("video-stage").locator("video").count().then((count) => count > 0).catch(() => false);
    test.info().annotations.push({ type: "media", description: hasVideo ? "real LiveKit media" : "call screens without media (no LiveKit env)" });
    await expect(family.getByText("On the call")).toHaveAttribute("aria-current", "step", { timeout: 30_000 });

    await family.getByRole("button", { name: "Ask the robot for help" }).click();
    await family.getByPlaceholder(/Type what you need/).fill("Could you bring Mom the water bottle?");
    await family.getByRole("button", { name: "Send" }).click();
    await expect(family.getByText("Send the robot with the water bottle to Mom's bedside table?")).toBeVisible();
    await family.getByRole("button", { name: "Yes, send the robot" }).click();
    await expect(family.getByText("Care home approval")).toHaveAttribute("aria-current", "step");

    await staff.getByRole("button", { name: "Approve" }).first().click();
    await expect(staff.getByRole("button", { name: "Loaded on tray" })).toBeVisible({ timeout: 20_000 });
    await staff.getByRole("button", { name: "Loaded on tray" }).click();
    await expect(resident.getByText("Your water bottle is here")).toBeVisible({ timeout: 20_000 });
    await resident.getByRole("button", { name: "I have it" }).click();
    await expect(family.getByText("Done")).toHaveAttribute("aria-current", "step", { timeout: 20_000 });

    await staff.getByLabel("Resident id").fill("resident_demo_01");
    await expect(staff.locator("table tbody tr").filter({ hasText: "completed" }).first()).toBeVisible();
    await family.getByRole("button", { name: "End call" }).click();
  } finally {
    await family.context().close();
    await resident.context().close();
    await staff.context().close();
  }
});
