import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";

const STAFF_BASE = process.env.ONCARE_STAFF_E2E_BASE ?? "http://127.0.0.1:5175";
const MANAGER_DESTINATIONS = ["Laundry", "Residents", "Family links", "People", "Devices"] as const;
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 900 },
  { width: 768, height: 900 },
  { width: 390, height: 844 },
] as const;

async function login(page: Page, role: "staff" | "admin") {
  await page.goto(`${STAFF_BASE}/${role === "admin" ? "?mode=manager" : ""}`);
  await page.getByLabel("Username").fill(role);
  await page.getByLabel("Password").fill(role === "admin" ? "admin-demo-pass" : "staff-demo-pass");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Signed in" })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    offenders: [...document.querySelectorAll<HTMLElement>("body *")].flatMap((element) => {
      const box = element.getBoundingClientRect();
      if (box.right <= document.documentElement.clientWidth + 0.5 && element.scrollWidth <= element.clientWidth + 0.5)
        return [];
      return [{
        element: element.tagName.toLowerCase(),
        className: element.className,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        right: Math.round(box.right),
      }];
    }).slice(0, 12),
  }));
  expect(dimensions.scrollWidth, JSON.stringify(dimensions.offenders)).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function expectNavigationTouchTargets(page: Page) {
  const navButtons = page.getByRole("navigation", { name: "Workspace" }).getByRole("button");
  for (let index = 0; index < await navButtons.count(); index += 1) {
    const box = await navButtons.nth(index).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
}

async function captureRole(
  browser: Browser,
  role: "staff" | "admin",
  viewport: (typeof VIEWPORTS)[number],
  testInfo: TestInfo,
) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  const page = await context.newPage();
  await login(page, role);
  if (role === "admin") {
    await page.getByRole("button", { name: "Laundry", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Laundry records" })).toBeVisible();
  } else {
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  }
  if (process.env.ONCARE_CAPTURE_SCREENSHOTS === "1")
    await page.screenshot({ path: testInfo.outputPath(`${role}-${viewport.width}.png`), fullPage: true });
  await expectNoHorizontalOverflow(page);
  if (role === "admin" && viewport.width === 768) {
    const heading = await page.locator(".laundry-heading > div").first().boundingBox();
    const freshness = await page.getByLabel("Overview data freshness").boundingBox();
    expect(freshness?.y ?? 0).toBeGreaterThanOrEqual((heading?.y ?? 0) + (heading?.height ?? 0));
    const structuredSearchPrecedesAssistant = await page.evaluate(() => {
      const search = document.querySelector(".laundry-filters button");
      const assistant = document.querySelector("#laundry-question");
      return Boolean(search && assistant && (search.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    expect(structuredSearchPrecedesAssistant).toBe(true);
  }
  if (viewport.width === 390) {
    const topbarRows = await page.evaluate(() => {
      const identity = document.querySelector<HTMLElement>(".workspace-identity")?.getBoundingClientRect();
      const account = document.querySelector<HTMLElement>(".workspace-account")?.getBoundingClientRect();
      const role = document.querySelector<HTMLElement>(".workspace-role");
      const session = document.querySelector<HTMLElement>(".workspace-session");
      return {
        identityBottom: identity?.bottom ?? 0,
        accountTop: account?.top ?? 0,
        roleLines: role ? Math.round(role.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(role).lineHeight)) : 0,
        sessionLines: session ? Math.round(session.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(session).lineHeight)) : 0,
      };
    });
    expect(topbarRows.accountTop).toBeGreaterThanOrEqual(topbarRows.identityBottom);
    expect(topbarRows.roleLines).toBe(1);
    expect(topbarRows.sessionLines).toBe(1);
  }
  await expectNavigationTouchTargets(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => {
    const focused = document.activeElement as HTMLElement;
    const style = getComputedStyle(focused);
    return { inNavigation: Boolean(focused.closest(".workspace-navigation")), style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
  expect(outline.inNavigation).toBe(true);
  expect(outline.style).not.toBe("none");
  expect(outline.width).toBeGreaterThanOrEqual(2);
  await expect.poll(() => page.evaluate(() => document.getAnimations()
    .filter((animation) => animation.playState === "running").length)).toBe(0);
  await context.close();
}

test("staff navigation remains role-limited with one global STOP control", async ({ page }) => {
  await login(page, "staff");
  for (const destination of MANAGER_DESTINATIONS)
    await expect(page.getByRole("button", { name: destination, exact: true })).toHaveCount(0);

  for (const destination of ["Calls", "Robot", "Activity", "Today"] as const) {
    await page.getByRole("button", { name: destination, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: destination, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "STOP ROBOT", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "STOP ROBOT", exact: true })).toBeVisible();
  }
});

test("manager subsections retain form state and expose Laundry only after admin login", async ({ page }) => {
  await login(page, "admin");
  for (const destination of MANAGER_DESTINATIONS)
    await expect(page.getByRole("button", { name: destination, exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Laundry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Laundry records" })).toBeVisible();
  await page.getByLabel("Color").fill("violet");

  await page.getByRole("button", { name: "Residents", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Residents", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("New resident");

  await page.getByRole("button", { name: "Laundry", exact: true }).click();
  await expect(page.getByLabel("Color")).toHaveValue("violet");
  await page.getByRole("button", { name: "Residents", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("New resident");

  await page.getByRole("button", { name: "Devices", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Resident iPads" })).toBeVisible();
  await expect(page.getByRole("button", { name: "STOP ROBOT", exact: true })).toHaveCount(1);
});

test("staff and manager layouts remain usable at the supported widths", async ({ browser }, testInfo) => {
  for (const viewport of VIEWPORTS) {
    await captureRole(browser, "staff", viewport, testInfo);
    await captureRole(browser, "admin", viewport, testInfo);
  }
});
