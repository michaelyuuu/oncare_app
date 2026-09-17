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
  test("staff receives all visit transitions; family receives only its own; device only its resident's", async () => {
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
    expect(states(staff.messages)).toEqual(["awaiting_policy_or_staff", "accepted", "awaiting_policy_or_staff", "accepted"]);
    expect(states(fam1.messages)).toEqual(["awaiting_policy_or_staff", "accepted"]);
    expect(states(fam2.messages)).toEqual(["awaiting_policy_or_staff", "accepted"]);
    expect(fam1.messages.filter((x) => x.type !== "hello").every((x) => x.correlationId === fam1.messages[1].correlationId)).toBe(true);
    expect(states(dev.messages)).toEqual(["awaiting_policy_or_staff", "accepted"]);
    for (const c of [staff, fam1, fam2, dev]) c.ws.close();
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
