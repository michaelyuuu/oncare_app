import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { listen, makeTestApp } from "./helpers";
import { SEED_IDS } from "../src/db/seed";
import * as t from "../src/db/schema";
import { hashSecret } from "../src/auth/password";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

function connect(url: string, token: string): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url.replace("http", "ws")}/events?token=${token}`);
    const messages: any[] = [];
    ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
    ws.once("open", () => resolve({ ws, messages }));
    ws.once("error", reject);
  });
}
const settle = () => new Promise((r) => setTimeout(r, 80));

describe("WS /events", () => {
  test("staff receives assigned residents' visit transitions; family only its own; device only its resident's", async () => {
    const { app, db, tokens } = await makeTestApp();
    const srv = await listen(app); closers.push(srv.close);
    // second family user related to a second resident
    db.insert(t.resident).values({ id: "resident_demo_02", facilityId: SEED_IDS.facility, displayName: "Other", roomLocationId: SEED_IDS.roomLocation }).run();
    db.insert(t.user).values({ id: "family_demo_02", role: "family", username: "family2", displayName: "Other", passwordHash: await hashSecret("pw"), pinHash: null }).run();
    db.insert(t.familyRelationship).values({ id: "rel_2", userId: "family_demo_02", residentId: "resident_demo_02", label: "son", consentVideo: true, consentRobotVisit: true, consentItemDelivery: true }).run();
    const family2 = (await app.inject({ method: "POST", url: "/auth/login", payload: { username: "family2", password: "pw" } })).json().token;

    const staff = await connect(srv.url, tokens.staff);
    const fam1 = await connect(srv.url, tokens.family);
    const fam2 = await connect(srv.url, family2);
    const dev = await connect(srv.url, tokens.device);
    await settle();
    expect(staff.messages[0]).toMatchObject({ type: "hello" });

    await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } });
    await app.inject({ method: "POST", url: "/visits", headers: auth(family2), payload: { residentId: "resident_demo_02" } });
    await settle();

    const states = (m: any[]) => m.filter((x) => x.type !== "hello").map((x) => x.toState);
    expect(states(staff.messages)).toEqual(["awaiting_policy_or_staff", "accepted"]);
    expect(states(fam1.messages)).toEqual(["awaiting_policy_or_staff", "accepted"]);
    expect(states(fam2.messages)).toEqual(["awaiting_policy_or_staff", "accepted"]);
    expect(fam1.messages.filter((x) => x.type !== "hello").every((x) => x.correlationId === fam1.messages[1].correlationId)).toBe(true);
    expect(states(dev.messages)).toEqual(["awaiting_policy_or_staff", "accepted"]);
    for (const c of [staff, fam1, fam2, dev]) c.ws.close();
  });

  test("reservation events reach only authenticated principals in the resident and family scope", async () => {
    const { app, db, tokens } = await makeTestApp({ now: () => new Date("2026-09-21T00:00:00.000Z") });
    db.insert(t.resident).values({
      id: "resident_reservation_other",
      facilityId: SEED_IDS.facility,
      displayName: "Other Reservation Resident",
      roomLocationId: SEED_IDS.roomLocation,
    }).run();
    db.insert(t.user).values({
      id: "family_reservation_other",
      role: "family",
      username: "family-reservation-other",
      displayName: "Other Reservation Family",
      passwordHash: await hashSecret("pw"),
      pinHash: null,
    }).run();
    db.insert(t.familyRelationship).values({
      id: "rel_reservation_other",
      userId: "family_reservation_other",
      residentId: "resident_reservation_other",
      label: "son",
      consentVideo: true,
      consentRobotVisit: true,
      consentItemDelivery: true,
    }).run();
    const unrelatedFamily = (await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "family-reservation-other", password: "pw" },
    })).json().token;
    const srv = await listen(app); closers.push(srv.close);
    const staff = await connect(srv.url, tokens.staff);
    const family = await connect(srv.url, tokens.family);
    const unrelated = await connect(srv.url, unrelatedFamily);
    const device = await connect(srv.url, tokens.device);
    await settle();

    const response = await app.inject({
      method: "POST",
      url: "/visit-reservations",
      headers: auth(tokens.family),
      payload: { residentId: SEED_IDS.resident, localDate: "2026-09-22", startMinute: 540 },
    });
    expect(response.statusCode).toBe(201);
    await settle();

    const reservationEvents = (messages: any[]) => messages.filter((message) => message.entityType === "visit_reservation");
    for (const scoped of [staff, family, device]) {
      expect(reservationEvents(scoped.messages)).toEqual([
        expect.objectContaining({
          entityId: response.json().reservation.id,
          toState: "pending",
          reason: "reservation_proposed",
        }),
      ]);
    }
    expect(reservationEvents(unrelated.messages)).toEqual([]);
    for (const connection of [staff, family, unrelated, device]) connection.ws.close();
  });

  test("a robot-entity audit event reaches staff only", async () => {
    const { app, tokens } = await makeTestApp();
    const srv = await listen(app); closers.push(srv.close);
    const staff = await connect(srv.url, tokens.staff);
    const fam = await connect(srv.url, tokens.family);
    const dev = await connect(srv.url, tokens.device);
    await settle();
    // an ack for a correlation id this API has no command row for
    app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: "visit_gone", result: "accepted" });
    await settle();
    const robotEvents = (m: any[]) => m.filter((x) => x.entityType === "robot");
    expect(robotEvents(staff.messages)).toHaveLength(1);
    expect(robotEvents(staff.messages)[0]).toMatchObject({ reason: "unknown_correlation", correlationId: "visit_gone", entityId: SEED_IDS.robot });
    expect(robotEvents(fam.messages)).toHaveLength(0);
    expect(robotEvents(dev.messages)).toHaveLength(0);
    for (const c of [staff, fam, dev]) c.ws.close();
  });

  test("bad token is closed with 4401", async () => {
    const { app } = await makeTestApp();
    const srv = await listen(app); closers.push(srv.close);
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${srv.url.replace("http", "ws")}/events?token=bad`);
      ws.once("close", (c) => resolve(c));
      ws.once("error", () => {});
    });
    expect(code).toBe(4401);
  });

  test("closing the socket unsubscribes (no send on a closed socket throws)", async () => {
    const { app, tokens } = await makeTestApp();
    const srv = await listen(app); closers.push(srv.close);
    const c = await connect(srv.url, tokens.staff);
    c.ws.close();
    await settle();
    await expect(app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } })).resolves.toMatchObject({ statusCode: 201 });
  });
});
