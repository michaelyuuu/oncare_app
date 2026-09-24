import { describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { hashSecret } from "../src/auth/password";
import type { Db } from "../src/db/client";
import { SEED_IDS } from "../src/db/seed";
import * as t from "../src/db/schema";
import { makeTestApp } from "./helpers";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const firstDate = "2026-09-22";

function clock() {
  let instant = new Date("2026-09-21T00:00:00.000Z");
  return {
    now: () => instant,
    set(value: string) { instant = new Date(value); },
  };
}

async function login(app: FastifyInstance, username: string, password: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password } });
  expect(response.statusCode).toBe(200);
  return response.json().token as string;
}

async function addFamily(
  app: FastifyInstance,
  db: Db,
  input: {
    id: string;
    username: string;
    residentId: string;
    consentVideo?: boolean;
    consentRobotVisit?: boolean;
    active?: boolean;
  },
): Promise<string> {
  const password = `${input.username}-password`;
  db.insert(t.user).values({
    id: input.id,
    role: "family",
    username: input.username,
    displayName: input.username,
    passwordHash: await hashSecret(password),
    pinHash: null,
    facilityId: null,
    active: input.active ?? true,
  }).run();
  db.insert(t.familyRelationship).values({
    id: `rel_${input.id}_${input.residentId}`,
    userId: input.id,
    residentId: input.residentId,
    label: "son",
    consentVideo: input.consentVideo ?? true,
    consentRobotVisit: input.consentRobotVisit ?? true,
    consentItemDelivery: true,
  }).run();
  if (input.active === false) return "";
  return login(app, input.username, password);
}

function addResidentUsingRobot(db: Db, input: { id: string; robotId: string; facilityId?: string }) {
  const facilityId = input.facilityId ?? SEED_IDS.facility;
  db.insert(t.resident).values({
    id: input.id,
    facilityId,
    displayName: input.id,
    roomLocationId: SEED_IDS.roomLocation,
  }).run();
  db.insert(t.device).values({
    id: `device_${input.id}`,
    facilityId,
    robotId: input.robotId,
    kind: "ipad",
    residentId: input.id,
    deviceTokenHash: `unused_${input.id}`,
  }).run();
}

async function propose(
  app: FastifyInstance,
  token: string,
  payload: { residentId?: string; contactUserId?: string; localDate: string; startMinute: number },
) {
  return app.inject({ method: "POST", url: "/visit-reservations", headers: auth(token), payload });
}

describe("visit reservation contacts and slots", () => {
  test("device contacts include only active relationships with both video and robot consent", async () => {
    const timer = clock();
    const { app, db, tokens } = await makeTestApp({ now: timer.now });
    await addFamily(app, db, {
      id: "family_video_only",
      username: "video-only",
      residentId: SEED_IDS.resident,
      consentRobotVisit: false,
    });
    await addFamily(app, db, {
      id: "family_robot_only",
      username: "robot-only",
      residentId: SEED_IDS.resident,
      consentVideo: false,
    });
    await addFamily(app, db, {
      id: "family_inactive",
      username: "inactive-contact",
      residentId: SEED_IDS.resident,
      active: false,
    });

    const response = await app.inject({
      method: "GET",
      url: "/visit-reservations/contacts",
      headers: auth(tokens.device),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      contacts: [{ userId: SEED_IDS.familyUser, displayName: "Demo Daughter", label: "daughter" }],
    });
    expect((await app.inject({
      method: "GET",
      url: "/visit-reservations/contacts",
      headers: auth(tokens.family),
    })).statusCode).toBe(403);
  });

  test("returns the facility timezone and fourteen policy days with blocked and held slots", async () => {
    const timer = clock();
    const { app, tokens } = await makeTestApp({ now: timer.now });
    const created = await propose(app, tokens.family, {
      residentId: SEED_IDS.resident,
      localDate: firstDate,
      startMinute: 540,
    });
    expect(created.statusCode).toBe(201);

    const response = await app.inject({
      method: "GET",
      url: `/visit-reservations/slots?residentId=${SEED_IDS.resident}&from=2026-09-21`,
      headers: auth(tokens.family),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.timeZone).toBe("Asia/Taipei");
    expect(body.slots).toHaveLength(14 * 9);
    expect(body.slots).toContainEqual(expect.objectContaining({
      localDate: "2026-09-21",
      startMinute: 720,
      endMinute: 780,
      state: "blocked",
      reason: "lunch",
    }));
    expect(body.slots).toContainEqual(expect.objectContaining({
      localDate: firstDate,
      startMinute: 540,
      startAt: "2026-09-22T01:00:00.000Z",
      endAt: "2026-09-22T02:00:00.000Z",
      state: "pending",
      reservationId: created.json().reservation.id,
    }));
  });

  test("caps a shifted slot query at the facility-local fourteen-day horizon", async () => {
    const timer = clock();
    const { app, tokens } = await makeTestApp({ now: timer.now });

    const response = await app.inject({
      method: "GET",
      url: `/visit-reservations/slots?residentId=${SEED_IDS.resident}&from=2026-10-03`,
      headers: auth(tokens.family),
    });

    expect(response.statusCode).toBe(200);
    const slots = response.json().slots as Array<{ localDate: string }>;
    expect(slots).toHaveLength(2 * 9);
    expect([...new Set(slots.map((slot) => slot.localDate))]).toEqual(["2026-10-03", "2026-10-04"]);
  });

  test("rejects blocked starts and dates outside the facility-local fourteen-day window", async () => {
    const timer = clock();
    const { app, db, tokens } = await makeTestApp({ now: timer.now });

    const blocked = await propose(app, tokens.family, {
      residentId: SEED_IDS.resident,
      localDate: firstDate,
      startMinute: 720,
    });
    const outside = await propose(app, tokens.family, {
      residentId: SEED_IDS.resident,
      localDate: "2026-10-05",
      startMinute: 540,
    });

    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ error: "invalid_slot" });
    expect(outside.statusCode).toBe(409);
    expect(outside.json()).toEqual({ error: "invalid_slot" });
    expect(db.select().from(t.visitReservation).all()).toHaveLength(0);
  });
});

describe("visit reservation proposal authorization and conflicts", () => {
  test("derives the missing participant for family and device proposals and lists only visible rows", async () => {
    const timer = clock();
    const { app, tokens } = await makeTestApp({ now: timer.now });
    const events: Array<{ entityId: string; fromState: string | null; toState: string | null; reason: string | null }> = [];
    app.transitions.subscribe((event) => events.push(event));

    const familyProposal = await propose(app, tokens.family, {
      residentId: SEED_IDS.resident,
      localDate: firstDate,
      startMinute: 540,
    });
    const deviceProposal = await propose(app, tokens.device, {
      contactUserId: SEED_IDS.familyUser,
      localDate: firstDate,
      startMinute: 600,
    });

    expect(familyProposal.statusCode).toBe(201);
    expect(familyProposal.json().reservation).toMatchObject({
      residentId: SEED_IDS.resident,
      familyUserId: SEED_IDS.familyUser,
      proposerKind: "family",
      proposerId: SEED_IDS.familyUser,
      status: "pending",
      startAt: "2026-09-22T01:00:00.000Z",
      expiresAt: "2026-09-21T00:05:00.000Z",
    });
    expect(deviceProposal.statusCode).toBe(201);
    expect(deviceProposal.json().reservation).toMatchObject({
      residentId: SEED_IDS.resident,
      familyUserId: SEED_IDS.familyUser,
      proposerKind: "device",
      proposerId: SEED_IDS.device,
      startAt: "2026-09-22T02:00:00.000Z",
    });

    const familyList = await app.inject({ method: "GET", url: "/visit-reservations", headers: auth(tokens.family) });
    const deviceList = await app.inject({ method: "GET", url: "/visit-reservations", headers: auth(tokens.device) });
    expect(familyList.json().reservations.map((row: { id: string }) => row.id)).toEqual([
      familyProposal.json().reservation.id,
      deviceProposal.json().reservation.id,
    ]);
    expect(deviceList.json().reservations).toHaveLength(2);
    expect(events.map(({ fromState, toState, reason }) => ({ fromState, toState, reason }))).toEqual([
      { fromState: null, toState: "pending", reason: "reservation_proposed" },
      { fromState: null, toState: "pending", reason: "reservation_proposed" },
    ]);
  });

  test("a device can propose to exactly one approved contact and rejected contacts stay hidden", async () => {
    const timer = clock();
    const { app, db, tokens } = await makeTestApp({ now: timer.now });
    const deniedToken = await addFamily(app, db, {
      id: "family_denied",
      username: "family-denied",
      residentId: SEED_IDS.resident,
      consentRobotVisit: false,
    });

    const approved = await propose(app, tokens.device, {
      contactUserId: SEED_IDS.familyUser,
      localDate: firstDate,
      startMinute: 540,
    });
    const denied = await propose(app, tokens.device, {
      contactUserId: "family_denied",
      localDate: firstDate,
      startMinute: 600,
    });
    const unrelated = await propose(app, tokens.device, {
      contactUserId: "missing_contact",
      localDate: firstDate,
      startMinute: 660,
    });

    expect(approved.statusCode).toBe(201);
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toEqual({ error: "consent_missing" });
    expect(unrelated.statusCode).toBe(403);
    expect(unrelated.json()).toEqual({ error: "forbidden" });
    expect((await propose(app, deniedToken, {
      residentId: SEED_IDS.resident,
      localDate: firstDate,
      startMinute: 600,
    })).json()).toEqual({ error: "consent_missing" });
  });

  test("pending and confirmed rows conflict independently by resident, family user, and robot", async () => {
    const timer = clock();
    const { app, db, tokens } = await makeTestApp({ now: timer.now });
    const family2 = await addFamily(app, db, {
      id: "family_conflict_2",
      username: "family-conflict-2",
      residentId: SEED_IDS.resident,
    });

    addResidentUsingRobot(db, { id: "resident_same_robot", robotId: SEED_IDS.robot });
    db.insert(t.familyRelationship).values({
      id: "rel_family_conflict_2_same_robot",
      userId: "family_conflict_2",
      residentId: "resident_same_robot",
      label: "son",
      consentVideo: true,
      consentRobotVisit: true,
      consentItemDelivery: true,
    }).run();

    db.insert(t.facility).values({ id: "facility_other", name: "Other", timezone: "Asia/Taipei" }).run();
    db.insert(t.robot).values({ id: "robot_other", facilityId: "facility_other", name: "Other Robot", tokenHash: "unused" }).run();
    addResidentUsingRobot(db, { id: "resident_other", robotId: "robot_other", facilityId: "facility_other" });
    db.insert(t.familyRelationship).values({
      id: "rel_seed_family_other",
      userId: SEED_IDS.familyUser,
      residentId: "resident_other",
      label: "daughter",
      consentVideo: true,
      consentRobotVisit: true,
      consentItemDelivery: true,
    }).run();

    const original = await propose(app, tokens.family, {
      residentId: SEED_IDS.resident,
      localDate: firstDate,
      startMinute: 540,
    });
    expect(original.statusCode).toBe(201);
    const confirmed = await app.inject({
      method: "POST",
      url: `/visit-reservations/${original.json().reservation.id}/confirm`,
      headers: auth(tokens.device),
    });
    expect(confirmed.statusCode).toBe(200);

    const residentConflict = await propose(app, family2, {
      residentId: SEED_IDS.resident,
      localDate: firstDate,
      startMinute: 540,
    });
    const familyConflict = await propose(app, tokens.family, {
      residentId: "resident_other",
      localDate: firstDate,
      startMinute: 1020,
    });
    const robotConflict = await propose(app, family2, {
      residentId: "resident_same_robot",
      localDate: firstDate,
      startMinute: 540,
    });

    expect(residentConflict.json()).toEqual({ error: "conflict" });
    expect(familyConflict.json()).toEqual({ error: "invalid_slot" });
    const familyConflictBookable = await propose(app, tokens.family, {
      residentId: "resident_other",
      localDate: firstDate,
      startMinute: 540,
    });
    expect(familyConflictBookable.json()).toEqual({ error: "conflict" });
    expect(robotConflict.json()).toEqual({ error: "conflict" });
    expect(db.select().from(t.visitReservation).all()).toHaveLength(1);
  });
});

describe("visit reservation lifecycle", () => {
  test("pending proposals expire after five minutes and can no longer be confirmed", async () => {
    const timer = clock();
    const { app, db, tokens } = await makeTestApp({ now: timer.now });
    const events: Array<{ toState: string | null; reason: string | null }> = [];
    app.transitions.subscribe((event) => events.push(event));
    const created = await propose(app, tokens.family, {
      residentId: SEED_IDS.resident,
      localDate: firstDate,
      startMinute: 540,
    });
    timer.set("2026-09-21T00:05:00.000Z");

    const response = await app.inject({
      method: "POST",
      url: `/visit-reservations/${created.json().reservation.id}/confirm`,
      headers: auth(tokens.device),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "expired" });
    expect(db.select().from(t.visitReservation).where(eq(t.visitReservation.id, created.json().reservation.id)).get()?.status).toBe("expired");
    expect(events.at(-1)).toMatchObject({ toState: "expired", reason: "reservation_expired" });
  });

  test("only the receiving participant can confirm a pending proposal", async () => {
    const timer = clock();
    const { app, tokens } = await makeTestApp({ now: timer.now });
    const familyProposal = await propose(app, tokens.family, {
      residentId: SEED_IDS.resident,
      localDate: firstDate,
      startMinute: 540,
    });

    const proposerAttempt = await app.inject({
      method: "POST",
      url: `/visit-reservations/${familyProposal.json().reservation.id}/confirm`,
      headers: auth(tokens.family),
    });
    const receiverAttempt = await app.inject({
      method: "POST",
      url: `/visit-reservations/${familyProposal.json().reservation.id}/confirm`,
      headers: auth(tokens.device),
    });

    expect(proposerAttempt.statusCode).toBe(403);
    expect(proposerAttempt.json()).toEqual({ error: "forbidden" });
    expect(receiverAttempt.statusCode).toBe(200);
    expect(receiverAttempt.json().reservation).toMatchObject({
      status: "confirmed",
      confirmedByKind: "device",
      confirmedById: SEED_IDS.device,
      confirmedAt: "2026-09-21T00:00:00.000Z",
    });

    const deviceProposal = await propose(app, tokens.device, {
      contactUserId: SEED_IDS.familyUser,
      localDate: firstDate,
      startMinute: 600,
    });
    expect((await app.inject({
      method: "POST",
      url: `/visit-reservations/${deviceProposal.json().reservation.id}/confirm`,
      headers: auth(tokens.device),
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "POST",
      url: `/visit-reservations/${deviceProposal.json().reservation.id}/confirm`,
      headers: auth(tokens.family),
    })).statusCode).toBe(200);
  });

  test("a receiver suggestion atomically releases the old hold and creates a five-minute replacement", async () => {
    const timer = clock();
    const { app, db, tokens } = await makeTestApp({ now: timer.now });
    const family2 = await addFamily(app, db, {
      id: "family_replacement_2",
      username: "family-replacement-2",
      residentId: SEED_IDS.resident,
    });
    const original = await propose(app, tokens.family, {
      residentId: SEED_IDS.resident,
      localDate: firstDate,
      startMinute: 540,
    });
    timer.set("2026-09-21T00:01:00.000Z");

    const suggested = await app.inject({
      method: "POST",
      url: `/visit-reservations/${original.json().reservation.id}/suggest`,
      headers: auth(tokens.device),
      payload: { localDate: firstDate, startMinute: 600 },
    });

    expect(suggested.statusCode).toBe(200);
    expect(suggested.json().reservation).toMatchObject({
      proposerKind: "device",
      proposerId: SEED_IDS.device,
      status: "pending",
      startAt: "2026-09-22T02:00:00.000Z",
      expiresAt: "2026-09-21T00:06:00.000Z",
      supersedesId: original.json().reservation.id,
    });
    expect(db.select().from(t.visitReservation).where(eq(t.visitReservation.id, original.json().reservation.id)).get()).toMatchObject({
      status: "cancelled",
      cancellationReason: "superseded",
    });

    const oldSlotReused = await propose(app, family2, {
      residentId: SEED_IDS.resident,
      localDate: firstDate,
      startMinute: 540,
    });
    expect(oldSlotReused.statusCode).toBe(201);
  });

  test("a replacement checks conflicts against the resident's reassigned robot", async () => {
    const timer = clock();
    const { app, db, tokens } = await makeTestApp({ now: timer.now });
    db.insert(t.robot).values({
      id: "robot_reassigned",
      facilityId: SEED_IDS.facility,
      name: "Reassigned Robot",
      tokenHash: "unused",
    }).run();
    addResidentUsingRobot(db, { id: "resident_reassigned_robot", robotId: "robot_reassigned" });
    const competingFamily = await addFamily(app, db, {
      id: "family_reassigned_robot",
      username: "family-reassigned-robot",
      residentId: "resident_reassigned_robot",
    });
    const original = await propose(app, tokens.device, {
      contactUserId: SEED_IDS.familyUser,
      localDate: firstDate,
      startMinute: 540,
    });
    const competing = await propose(app, competingFamily, {
      residentId: "resident_reassigned_robot",
      localDate: firstDate,
      startMinute: 600,
    });
    expect(original.statusCode).toBe(201);
    expect(competing.statusCode).toBe(201);

    db.update(t.device).set({ robotId: "robot_reassigned", assignmentVersion: 2 })
      .where(eq(t.device.id, SEED_IDS.device)).run();
    const suggested = await app.inject({
      method: "POST",
      url: `/visit-reservations/${original.json().reservation.id}/suggest`,
      headers: auth(tokens.family),
      payload: { localDate: firstDate, startMinute: 600 },
    });

    expect(suggested.statusCode).toBe(409);
    expect(suggested.json()).toEqual({ error: "conflict" });
    expect(db.select().from(t.visitReservation).where(eq(t.visitReservation.id, original.json().reservation.id)).get()?.status).toBe("pending");
    expect(db.select().from(t.visitReservation).all()).toHaveLength(2);
  });

  test("either participant and scoped staff can cancel while nonparticipants cannot", async () => {
    const timer = clock();
    const { app, db, tokens } = await makeTestApp({ now: timer.now });
    const unrelated = await addFamily(app, db, {
      id: "family_unrelated",
      username: "family-unrelated",
      residentId: SEED_IDS.resident,
    });
    db.delete(t.familyRelationship).where(and(
      eq(t.familyRelationship.userId, "family_unrelated"),
      eq(t.familyRelationship.residentId, SEED_IDS.resident),
    )).run();

    const byFamily = await propose(app, tokens.family, {
      residentId: SEED_IDS.resident,
      localDate: firstDate,
      startMinute: 540,
    });
    const denied = await app.inject({
      method: "POST",
      url: `/visit-reservations/${byFamily.json().reservation.id}/cancel`,
      headers: auth(unrelated),
    });
    const deviceCancelled = await app.inject({
      method: "POST",
      url: `/visit-reservations/${byFamily.json().reservation.id}/cancel`,
      headers: auth(tokens.device),
    });

    const byDevice = await propose(app, tokens.device, {
      contactUserId: SEED_IDS.familyUser,
      localDate: firstDate,
      startMinute: 600,
    });
    const familyCancelled = await app.inject({
      method: "POST",
      url: `/visit-reservations/${byDevice.json().reservation.id}/cancel`,
      headers: auth(tokens.family),
    });

    const forStaff = await propose(app, tokens.family, {
      residentId: SEED_IDS.resident,
      localDate: firstDate,
      startMinute: 660,
    });
    const staffCancelled = await app.inject({
      method: "POST",
      url: `/visit-reservations/${forStaff.json().reservation.id}/cancel`,
      headers: auth(tokens.staff),
    });

    expect(denied.statusCode).toBe(403);
    expect(deviceCancelled.json().reservation).toMatchObject({ status: "cancelled", cancelledByKind: "device" });
    expect(familyCancelled.json().reservation).toMatchObject({ status: "cancelled", cancelledByKind: "family" });
    expect(staffCancelled.json().reservation).toMatchObject({ status: "cancelled", cancelledByKind: "staff" });
  });

  test("the existing immediate family visit endpoint remains compatible", async () => {
    const timer = clock();
    const { app, tokens } = await makeTestApp({ now: timer.now });

    const response = await app.inject({
      method: "POST",
      url: "/visits",
      headers: auth(tokens.family),
      payload: { residentId: SEED_IDS.resident },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().visit).toMatchObject({
      residentId: SEED_IDS.resident,
      requesterId: SEED_IDS.familyUser,
      state: "accepted",
    });
  });
});
