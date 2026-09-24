import { afterEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import WebSocket from "ws";
import { listen, makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS, SEED_SECRETS } from "../src/db/seed";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

describe("per-request revalidation", () => {
  test("deactivating a user revokes its live token and blocks login", async () => {
    const { app, db, tokens } = await makeTestApp();
    expect((await app.inject({ method: "GET", url: "/queue", headers: auth(tokens.staff) })).statusCode).toBe(200);
    db.update(t.user).set({ active: false }).where(eq(t.user.id, SEED_IDS.staffUser)).run();
    expect((await app.inject({ method: "GET", url: "/queue", headers: auth(tokens.staff) })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { username: "staff", password: SEED_SECRETS.staffPassword } })).statusCode).toBe(401);
  });

  test("reassigning or deactivating an iPad revokes its live token", async () => {
    const { app, db, tokens } = await makeTestApp();
    const state = () => app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.device) });
    expect((await state()).statusCode).toBe(200);
    db.update(t.device).set({ assignmentVersion: 2 }).run();
    expect((await state()).statusCode).toBe(401);
    db.update(t.device).set({ assignmentVersion: 1, active: false }).run();
    expect((await state()).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/device", payload: { deviceToken: SEED_SECRETS.deviceToken } })).statusCode).toBe(401);
  });

  test("a role change takes effect without a new token", async () => {
    const { app, db, tokens } = await makeTestApp();
    db.update(t.user).set({ role: "family", facilityId: null }).where(eq(t.user.id, SEED_IDS.staffUser)).run();
    expect((await app.inject({ method: "GET", url: "/queue", headers: auth(tokens.staff) })).statusCode).toBe(403);
  });

  test("the events socket closes with 4401 once its principal is deactivated", async () => {
    const { app, db, tokens } = await makeTestApp();
    const srv = await listen(app); closers.push(srv.close);
    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/events?token=${tokens.staff}`);
    await new Promise((resolve) => ws.once("open", resolve));
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    db.update(t.user).set({ active: false }).where(eq(t.user.id, SEED_IDS.staffUser)).run();
    await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } });
    expect(await closed).toBe(4401);
  });
});
