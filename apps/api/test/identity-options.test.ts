import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";
import { makeTestApp } from "./helpers";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("GET /me/identities", () => {
  test("returns only the server-authorized identity and public principal for each role", async () => {
    const { app, tokens } = await makeTestApp();
    const response = async (token: string) => {
      const res = await app.inject({ method: "GET", url: "/me/identities", headers: auth(token) });
      expect(res.statusCode).toBe(200);
      return res.json();
    };

    await expect(response(tokens.device)).resolves.toEqual({
      principal: { kind: "device" },
      identities: [
        { residentId: SEED_IDS.resident, displayName: "Demo Resident", relationship: "self" },
      ],
    });
    await expect(response(tokens.family)).resolves.toEqual({
      principal: { kind: "user", role: "family" },
      identities: [
        { residentId: SEED_IDS.resident, displayName: "Demo Resident", relationship: "family" },
      ],
    });
    await expect(response(tokens.staff)).resolves.toEqual({
      principal: { kind: "user", role: "staff" },
      identities: [
        { residentId: SEED_IDS.resident, displayName: "Demo Resident", relationship: "assignment" },
      ],
    });
    await expect(response(tokens.admin)).resolves.toEqual({
      principal: { kind: "user", role: "admin" },
      identities: [
        { residentId: SEED_IDS.resident, displayName: "Demo Resident", relationship: "facility" },
      ],
    });
  });

  test("re-reads active resident scope after login", async () => {
    const { app, db, tokens } = await makeTestApp();
    db.update(t.resident).set({ active: false }).where(eq(t.resident.id, SEED_IDS.resident)).run();

    const res = await app.inject({ method: "GET", url: "/me/identities", headers: auth(tokens.device) });

    expect(res.statusCode).toBe(200);
    expect(res.json().identities).toEqual([]);
  });

  test("re-reads active staff assignments after login", async () => {
    const { app, db, tokens } = await makeTestApp();
    db.update(t.staffAssignment).set({ active: false }).where(eq(t.staffAssignment.userId, SEED_IDS.staffUser)).run();

    const res = await app.inject({ method: "GET", url: "/me/identities", headers: auth(tokens.staff) });

    expect(res.statusCode).toBe(200);
    expect(res.json().identities).toEqual([]);
  });

  test("rejects unauthenticated requests", async () => {
    const { app } = await makeTestApp();

    const res = await app.inject({ method: "GET", url: "/me/identities" });

    expect(res.statusCode).toBe(401);
  });
});
