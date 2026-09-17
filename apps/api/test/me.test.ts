import { describe, expect, test } from "vitest";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";
import { hashSecret } from "../src/auth/password";

describe("GET /me/residents", () => {
  test("returns only residents the family user is related to", async () => {
    const { app, db, tokens } = await makeTestApp();
    // A second resident with no relationship to the demo family user.
    db.insert(t.resident).values({ id: "resident_demo_02", facilityId: SEED_IDS.facility, displayName: "Other Resident", roomLocationId: SEED_IDS.roomLocation }).run();
    const res = await app.inject({ method: "GET", url: "/me/residents", headers: { authorization: `Bearer ${tokens.family}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().residents).toEqual([
      { id: SEED_IDS.resident, displayName: "Demo Resident", availability: "available",
        relationship: { label: "daughter", consentVideo: true, consentRobotVisit: true, consentItemDelivery: true } },
    ]);
  });

  test("a family user with no relationships gets an empty list, not an error", async () => {
    const { app, db } = await makeTestApp();
    db.insert(t.user).values({ id: "family_demo_02", role: "family", username: "family2", displayName: "Unrelated", passwordHash: await hashSecret("pw"), pinHash: null }).run();
    const token = (await app.inject({ method: "POST", url: "/auth/login", payload: { username: "family2", password: "pw" } })).json().token;
    const res = await app.inject({ method: "GET", url: "/me/residents", headers: { authorization: `Bearer ${token}` } });
    expect(res.json()).toEqual({ residents: [] });
  });

  test("staff token is 403 on a family route", async () => {
    const { app, tokens } = await makeTestApp();
    const res = await app.inject({ method: "GET", url: "/me/residents", headers: { authorization: `Bearer ${tokens.staff}` } });
    expect(res.statusCode).toBe(403);
  });
});
