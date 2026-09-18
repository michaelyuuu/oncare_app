import { afterEach, expect, test } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { GatewayDown } from "@oncare/contracts";
import { makeTestApp } from "./helpers";
import { SEED_IDS } from "../src/db/seed";
import * as t from "../src/db/schema";

const closing: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closing.splice(0)) await close(); });
async function setup() {
  const value = await makeTestApp();
  closing.push(() => value.app.close());
  return value;
}
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

test("staff edits atomically audited locations and every healthy link gets the full approved table", async () => {
  const { app, db, tokens } = await setup();
  const sent: GatewayDown[][] = [[], []];
  app.hub.attach("broken", { send: () => { throw new Error("lost link"); } });
  sent.forEach((messages, index) => app.hub.attach(`robot${index}`, { send: m => { messages.push(m); } }));
  expect((await app.inject({ url: "/locations", headers: auth(tokens.staff) })).json().locations).toHaveLength(3);
  const res = await app.inject({ method: "PATCH", url: `/locations/${SEED_IDS.roomLocation}`, headers: auth(tokens.staff), payload: { x: 3.25, y: -1.5, yaw: 1.57 } });
  expect(res.statusCode).toBe(200);
  expect(res.json().location).toMatchObject({ id: SEED_IDS.roomLocation, x: 3.25, y: -1.5, yaw: 1.57 });
  expect(db.select().from(t.auditEvent).all()).toEqual([expect.objectContaining({ actorType: "staff", actorId: SEED_IDS.staffUser, entityType: "robot", entityId: SEED_IDS.robot, reason: "location_updated", correlationId: SEED_IDS.roomLocation })]);
  for (const messages of sent) expect(messages).toEqual([{ type: "locations", locations: expect.arrayContaining([expect.objectContaining({ id: SEED_IDS.roomLocation, x: 3.25 })]) }]);
  await app.inject({ method: "PATCH", url: `/locations/${SEED_IDS.roomLocation}`, headers: auth(tokens.staff), payload: { approved: false } });
  for (const messages of sent) {
    const latest = messages.at(-1);
    expect(latest?.type).toBe("locations");
    if (latest?.type === "locations") expect(latest.locations.map(l => l.id)).toEqual([SEED_IDS.pickupLocation, SEED_IDS.standbyLocation]);
  }
});

test("location access and finite nonempty strict patches reject without audit or broadcast", async () => {
  const { app, db, tokens } = await setup();
  const sent: GatewayDown[] = [];
  app.hub.attach(SEED_IDS.robot, { send: m => { sent.push(m); } });
  for (const token of [tokens.family, tokens.device]) {
    expect((await app.inject({ url: "/locations", headers: auth(token) })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: `/locations/${SEED_IDS.roomLocation}`, headers: auth(token), payload: { x: 1 } })).statusCode).toBe(403);
  }
  expect((await app.inject({ url: "/locations" })).statusCode).toBe(401);
  expect((await app.inject({ method: "PATCH", url: "/locations/missing", headers: auth(tokens.staff), payload: { x: 1 } })).statusCode).toBe(404);
  for (const payload of ['{}', '{"x":"far"}', '{"x":1e999}', '{"x":null}', '{"approved":1}', '{"name":"changed"}']) {
    expect((await app.inject({ method: "PATCH", url: `/locations/${SEED_IDS.roomLocation}`, headers: { ...auth(tokens.staff), "content-type": "application/json" }, payload })).statusCode).toBe(400);
  }
  expect(db.select().from(t.auditEvent).all()).toHaveLength(0);
  expect(sent).toHaveLength(0);
});

test("audit failure rolls back location update and suppresses broadcast", async () => {
  const { app, db, tokens } = await setup();
  db.run(sql`CREATE TRIGGER reject_location_audit BEFORE INSERT ON audit_event BEGIN SELECT RAISE(ABORT, 'test audit failure'); END`);
  const before = db.select().from(t.location).where(eq(t.location.id, SEED_IDS.roomLocation)).get();
  const sent: GatewayDown[] = [];
  app.hub.attach(SEED_IDS.robot, { send: m => { sent.push(m); } });
  const res = await app.inject({ method: "PATCH", url: `/locations/${SEED_IDS.roomLocation}`, headers: auth(tokens.staff), payload: { x: 99 } });
  expect(res.statusCode).toBe(500);
  expect(db.select().from(t.location).where(eq(t.location.id, SEED_IDS.roomLocation)).get()).toEqual(before);
  expect(sent).toHaveLength(0);
});
