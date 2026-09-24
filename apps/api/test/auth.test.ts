import { describe, expect, test } from "vitest";
import { makeTestApp } from "./helpers";
import { SEED_SECRETS } from "../src/db/seed";

describe("authentication", () => {
  test("demo quick-login uses 1234 for family, staff, and resident", async () => {
    const { app } = await makeTestApp();
    const family = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "family", password: "1234" } });
    const staff = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "staff", password: "1234" } });
    const resident = await app.inject({ method: "POST", url: "/auth/device", payload: { deviceToken: "1234" } });
    expect(family.statusCode).toBe(200);
    expect(staff.statusCode).toBe(200);
    expect(resident.statusCode).toBe(200);
  });

  test("family login returns a token and principal", async () => {
    const { app } = await makeTestApp();
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "family", password: SEED_SECRETS.familyPassword } });
    expect(res.statusCode).toBe(200);
    expect(res.json().principal).toMatchObject({ kind: "user", role: "family" });
    expect(typeof res.json().token).toBe("string");
  });

  test("wrong password is 401 and does not reveal which field failed", async () => {
    const { app } = await makeTestApp();
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "family", password: "nope" } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_credentials" });
  });

  test("device token login returns a device principal bound to its resident", async () => {
    const { app } = await makeTestApp();
    const res = await app.inject({ method: "POST", url: "/auth/device", payload: { deviceToken: SEED_SECRETS.deviceToken } });
    expect(res.statusCode).toBe(200);
    expect(res.json().principal).toMatchObject({ kind: "device", residentId: "resident_demo_01" });
  });

  test("protected route without a token is 401", async () => {
    const { app } = await makeTestApp();
    const res = await app.inject({ method: "GET", url: "/me/residents" });
    expect(res.statusCode).toBe(401);
  });

  test("protected route with the wrong role is 403", async () => {
    const { app, tokens } = await makeTestApp();
    const res = await app.inject({ method: "GET", url: "/me/residents", headers: { authorization: `Bearer ${tokens.device}` } });
    expect(res.statusCode).toBe(403);
  });
});
