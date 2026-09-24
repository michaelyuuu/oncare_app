import { afterEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { SEED_IDS } from "../src/db/seed";
import * as t from "../src/db/schema";
import { makeTestApp } from "./helpers";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const f = await makeTestApp();
  cleanup.push(() => f.app.close());
  const create = (token = f.tokens.device, payload: object = { contactUserId: SEED_IDS.familyUser }) => f.app.inject({ method: "POST", url: "/visits/now", headers: auth(token), payload });
  const incoming = (token = f.tokens.family) => f.app.inject({ method: "GET", url: "/visits/incoming", headers: auth(token) });
  return { ...f, create, incoming };
}

describe("immediate calls", () => {
  test("resident calls the selected family participant and robot arrival exposes only their incoming call", async () => {
    const f = await fixture();
    f.db.insert(t.user).values({ id: "other_family", role: "family", username: "other", displayName: "Other", passwordHash: "unused" }).run();
    f.db.insert(t.familyRelationship).values({ id: "other_link", userId: "other_family", residentId: SEED_IDS.resident, label: "son", consentVideo: true, consentRobotVisit: true }).run();
    const other = f.app.jwt.sign({ kind: "user", id: "other_family", role: "family", facilityId: null });
    const response = await f.create();
    expect(response.statusCode).toBe(201);
    const visit = response.json().visit;
    expect(visit).toMatchObject({ requesterId: SEED_IDS.familyUser, initiatorKind: "device", initiatorId: SEED_IDS.device, scheduledStartAt: null });
    expect((await f.incoming()).json()).toEqual({ visits: [] });
    f.app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: visit.id, result: "accepted" });
    f.app.hub.receive(SEED_IDS.robot, { type: "state_event", correlationId: visit.id, event: "arrived", at: new Date().toISOString() });
    expect(f.app.visits.get(visit.id)?.state).toBe("awaiting_family_consent");
    expect((await f.incoming()).json().visits).toEqual([expect.objectContaining({ id: visit.id })]);
    expect((await f.incoming(other)).json()).toEqual({ visits: [] });
    expect((await f.incoming(f.tokens.device)).statusCode).toBe(403);
    expect((await f.app.inject({ method: "POST", url: `/visits/${visit.id}/answer_family`, headers: auth(other) })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "GET", url: "/device/state", headers: auth(f.tokens.device) })).json().screen).toBe("in_call");
    expect((await f.app.inject({ method: "POST", url: `/visits/${visit.id}/answer_family`, headers: auth(f.tokens.family) })).statusCode).toBe(200);
    expect((await f.incoming()).json()).toEqual({ visits: [] });
  });

  test("family now and compatibility creation persist the family initiator", async () => {
    const f = await fixture();
    const response = await f.create(f.tokens.family, { residentId: SEED_IDS.resident });
    expect(response.statusCode).toBe(201);
    expect(response.json().visit).toMatchObject({ requesterId: SEED_IDS.familyUser, initiatorKind: "family", initiatorId: SEED_IDS.familyUser });
    const old = await f.app.inject({ method: "POST", url: "/visits", headers: auth(f.tokens.family), payload: { residentId: SEED_IDS.resident } });
    expect(old.statusCode).toBe(201);
    expect(old.json().visit.initiatorKind).toBe("family");
    expect(f.db.select().from(t.visitReservation).all()).toEqual([]);
  });

  test("rejects spoofed participants, unapproved contacts, missing consent and staff creation", async () => {
    const f = await fixture();
    expect((await f.create(f.tokens.device, { contactUserId: SEED_IDS.familyUser, residentId: "other" })).statusCode).toBe(400);
    expect((await f.create(f.tokens.family, { residentId: SEED_IDS.resident, familyUserId: "other" })).statusCode).toBe(400);
    expect((await f.create(f.tokens.device, { contactUserId: SEED_IDS.staffUser })).statusCode).toBe(403);
    expect((await f.create(f.tokens.staff, { residentId: SEED_IDS.resident })).statusCode).toBe(403);
    f.db.update(t.familyRelationship).set({ consentVideo: false }).run();
    expect((await f.create()).statusCode).toBe(409);
    expect(f.db.select().from(t.visitSession).all()).toEqual([]);
  });

  test("revoked consent hides incoming calls and prevents acceptance", async () => {
    const f = await fixture();
    const response = await f.create();
    expect(response.statusCode).toBe(201);
    const id = response.json().visit.id as string;
    f.db.update(t.visitSession).set({ state: "awaiting_family_consent" }).where(eq(t.visitSession.id, id)).run();
    f.db.update(t.familyRelationship).set({ consentRobotVisit: false }).run();
    expect((await f.incoming()).json()).toEqual({ visits: [] });
    expect((await f.app.inject({ method: "POST", url: `/visits/${id}/answer_family`, headers: auth(f.tokens.family) })).statusCode).toBe(403);
  });
});
