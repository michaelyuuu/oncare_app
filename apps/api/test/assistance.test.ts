import { describe, expect, test } from "vitest";
import { makeTestApp } from "./helpers";
import { SEED_IDS } from "../src/db/seed";

const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });

describe("staff assistance requests", () => {
  test("device creation is idempotent and assigned staff can acknowledge, progress, and resolve", async () => {
    const { app, tokens } = await makeTestApp();
    const headers = auth(tokens.device, { "Idempotency-Key": "help-demo-01" });
    const first = await app.inject({
      method: "POST", url: "/assistance-requests", headers,
      payload: { category: "general_assistance", note: "Please help me reach the phone." },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      duplicate: false,
      request: {
        id: expect.stringMatching(/^help_[a-f0-9]{32}$/),
        residentId: SEED_IDS.resident,
        category: "general_assistance",
        persistenceState: "recorded",
        deliveryState: "pending",
        handlingState: "open",
        withdrawalState: "none",
        escalationState: "none",
        version: 1,
      },
    });
    const request = first.json().request as { id: string; version: number };

    const duplicate = await app.inject({
      method: "POST", url: "/assistance-requests", headers,
      payload: { category: "general_assistance", note: "Please help me reach the phone." },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ duplicate: true, request: { id: request.id, version: 1 } });

    const queue = await app.inject({ method: "GET", url: "/staff/assistance-requests", headers: auth(tokens.staff) });
    expect(queue.statusCode).toBe(200);
    expect(queue.json().requests).toEqual([expect.objectContaining({ id: request.id, residentId: SEED_IDS.resident, deliveryState: "pending" })]);

    const acknowledge = await app.inject({
      method: "POST", url: `/staff/assistance-requests/${request.id}/acknowledge`,
      headers: auth(tokens.staff), payload: { version: 1 },
    });
    expect(acknowledge.statusCode).toBe(200);
    expect(acknowledge.json().request).toMatchObject({ deliveryState: "delivered", handlingState: "acknowledged", version: 2 });

    const progress = await app.inject({
      method: "POST", url: `/staff/assistance-requests/${request.id}/in_progress`,
      headers: auth(tokens.staff), payload: { version: 2 },
    });
    expect(progress.statusCode).toBe(200);
    expect(progress.json().request).toMatchObject({ handlingState: "in_progress", version: 3 });

    const resolved = await app.inject({
      method: "POST", url: `/staff/assistance-requests/${request.id}/resolve`,
      headers: auth(tokens.staff), payload: { version: 3 },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().request).toMatchObject({ handlingState: "resolved", version: 4 });
  });

  test("the request is bound to the authenticated device and rejects forged identity fields", async () => {
    const { app, tokens } = await makeTestApp();
    const forged = await app.inject({
      method: "POST", url: "/assistance-requests", headers: auth(tokens.device, { "Idempotency-Key": "help-forged" }),
      payload: { residentId: "resident_other", facilityId: "facility_other", category: "other", unexpected: "nope" },
    });
    expect(forged.statusCode).toBe(400);
  });

  test("family cannot create or staff-read resident assistance", async () => {
    const { app, tokens } = await makeTestApp();
    expect((await app.inject({ method: "POST", url: "/assistance-requests", headers: auth(tokens.family), payload: { category: "other" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/staff/assistance-requests", headers: auth(tokens.family) })).statusCode).toBe(403);
  });
});
