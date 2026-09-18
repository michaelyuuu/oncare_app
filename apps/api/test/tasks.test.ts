import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";
import { createTaskService } from "../src/services/tasks";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const post = (app: any, token: string, body: unknown) => app.inject({ method: "POST", url: "/tasks", headers: auth(token), payload: body });

describe("POST /tasks", () => {
  test("the handover sentence becomes a proposal awaiting confirmation, with an audit trail and no utterance stored", async () => {
    const { app, db, tokens } = await makeTestApp();
    const res = await post(app, tokens.family, { residentId: SEED_IDS.resident, text: "Could you bring Mom the water bottle?" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe("proposal");
    expect(body.task).toMatchObject({ state: "awaiting_user_confirmation", mode: "tray", residentId: SEED_IDS.resident, requesterId: SEED_IDS.familyUser,
      proposal: { task_type: "deliver_item", item: "water_bottle", recipient: SEED_IDS.resident, destination: "bedside_table_demo", requires_confirmation: true } });
    const trail = db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, body.task.id)).all();
    expect(trail.map((e) => e.toState)).toEqual(["parsed", "awaiting_user_confirmation"]);
    expect(JSON.stringify(db.select().from(t.taskRequest).all())).not.toContain("Could you");
  });

  test("an ambiguous request returns a clarification and creates no row", async () => {
    const { app, db, tokens } = await makeTestApp();
    const res = await post(app, tokens.family, { residentId: SEED_IDS.resident, text: "can you help her?" });
    expect(res.json()).toMatchObject({ kind: "clarification", options: ["water_bottle", "tissue_box", "tv_remote"] });
    expect(db.select().from(t.taskRequest).all()).toHaveLength(0);
  });

  test("invalid structured parser output is clarified and never persisted", async () => {
    const { app, db } = await makeTestApp();
    const parser = {
      parse: () => ({
        kind: "proposal" as const,
        proposal: { task_type: "deliver_item", item: "Water Bottle", recipient: SEED_IDS.resident,
          destination: "bedside_table_demo", requires_confirmation: true },
      }),
    } as Parameters<typeof createTaskService>[2] extends { parser?: infer P } ? P : never;
    const service = createTaskService(db, app.transitions, { parser });
    const result = service.create({ requesterId: SEED_IDS.familyUser, residentId: SEED_IDS.resident, text: "water" });
    expect(result).toMatchObject({ ok: true, outcome: { kind: "clarification" } });
    expect(db.select().from(t.taskRequest).all()).toHaveLength(0);
  });

  test("a prohibited item is rejected by policy with the prohibited_item code and a rejected task row", async () => {
    const { app, db, tokens } = await makeTestApp();
    const res = await post(app, tokens.family, { residentId: SEED_IDS.resident, text: "bring her medication" });
    expect(res.json()).toMatchObject({ kind: "rejected", code: "prohibited_item", task: { state: "rejected" } });
    const last = db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, res.json().task.id)).all().at(-1);
    expect(last).toMatchObject({ toState: "rejected", reason: "prohibited_item" });
  });

  test("consentItemDelivery false is 409 consent_missing; unrelated resident is 403", async () => {
    const { app, db, tokens } = await makeTestApp();
    db.update(t.familyRelationship).set({ consentItemDelivery: false }).where(eq(t.familyRelationship.userId, SEED_IDS.familyUser)).run();
    expect((await post(app, tokens.family, { residentId: SEED_IDS.resident, text: "water" })).statusCode).toBe(409);
    db.insert(t.resident).values({ id: "resident_demo_02", facilityId: SEED_IDS.facility, displayName: "Other", roomLocationId: SEED_IDS.roomLocation }).run();
    expect((await post(app, tokens.family, { residentId: "resident_demo_02", text: "water" })).statusCode).toBe(403);
  });

  test("a visitId that belongs to someone else is 409 visit_mismatch", async () => {
    const { app, db, tokens } = await makeTestApp();
    db.insert(t.resident).values({ id: "resident_demo_02", facilityId: SEED_IDS.facility, displayName: "Other", roomLocationId: SEED_IDS.roomLocation }).run();
    db.insert(t.visitSession).values({ id: "visit_other", residentId: "resident_demo_02", requesterId: SEED_IDS.staffUser, robotId: null, state: "active", livekitRoom: null, requestedAt: new Date().toISOString(), connectedAt: null, endedAt: null }).run();
    expect((await post(app, tokens.family, { residentId: SEED_IDS.resident, text: "water", visitId: "visit_other" })).json()).toEqual({ error: "visit_mismatch" });
  });

  test("staff and device cannot create tasks; empty text is 400", async () => {
    const { app, tokens } = await makeTestApp();
    expect((await post(app, tokens.staff, { residentId: SEED_IDS.resident, text: "water" })).statusCode).toBe(403);
    expect((await post(app, tokens.device, { residentId: SEED_IDS.resident, text: "water" })).statusCode).toBe(403);
    expect((await post(app, tokens.family, { residentId: SEED_IDS.resident, text: "" })).statusCode).toBe(400);
  });
});

describe("GET /tasks/:id", () => {
  test("owner, staff and the resident's device can read; another family user cannot", async () => {
    const { app, db, tokens } = await makeTestApp();
    const id = (await post(app, tokens.family, { residentId: SEED_IDS.resident, text: "water bottle" })).json().task.id;
    for (const tok of [tokens.family, tokens.staff, tokens.device]) expect((await app.inject({ method: "GET", url: `/tasks/${id}`, headers: auth(tok) })).statusCode).toBe(200);
    const { hashSecret } = await import("../src/auth/password");
    db.insert(t.user).values({ id: "family_demo_02", role: "family", username: "family2", displayName: "Other", passwordHash: await hashSecret("pw"), pinHash: null }).run();
    const other = (await app.inject({ method: "POST", url: "/auth/login", payload: { username: "family2", password: "pw" } })).json().token;
    expect((await app.inject({ method: "GET", url: `/tasks/${id}`, headers: auth(other) })).statusCode).toBe(403);
  });
});
