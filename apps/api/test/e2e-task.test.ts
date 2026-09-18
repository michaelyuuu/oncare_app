import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { eq } from "drizzle-orm";
import { listen, makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS, SEED_SECRETS } from "../src/db/seed";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function waitFor<T>(condition: () => T | false | null | undefined, description: string, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function closeSocket(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once("close", () => resolve());
    ws.close();
  });
}

/** Scripted tray gateway: navigation is instant, while handoffs require authenticated staff/device actions. */
async function trayGateway(url: string, token: string, messages: any[] = []): Promise<WebSocket> {
  const ws = new WebSocket(`${url.replace("http", "ws")}/gateway?token=${token}`);
  const send = (message: unknown) => ws.send(JSON.stringify(message));
  const now = () => new Date().toISOString();
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    messages.push(message);
    if (message.type === "intent" && message.intent === "deliver_item") {
      send({ type: "ack", correlationId: message.correlationId, result: "accepted" });
      send({ type: "state_event", correlationId: message.correlationId, at: now(), event: "arrived_pickup", detail: { leg: "pickup", mode: "tray" } });
    }
    if (message.type === "staff_event" && message.event === "staff_loaded") {
      send({ type: "state_event", correlationId: message.correlationId, at: now(), event: "arrived_delivery", detail: { leg: "delivery", mode: "tray" } });
    }
    if (message.type === "staff_event" && message.event === "received") {
      send({ type: "state_event", correlationId: message.correlationId, at: now(), event: "completed_leg", detail: { leg: "standby", mode: "tray" } });
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  closers.push(() => closeSocket(ws));
  return ws;
}

describe("end-to-end item delivery (handover section 8, steps 6-11, tray mode)", () => {
  test("confirmation gates, staff handoff, resident receipt, and standby produce the 12-state audit", async () => {
    const { app, db, tokens } = await makeTestApp();
    const server = await listen(app);
    closers.push(server.close);
    const gatewayMessages: any[] = [];
    await trayGateway(server.url, SEED_SECRETS.robotToken, gatewayMessages);

    const utterance = "Could you bring Mom the water bottle?";
    const created = await app.inject({
      method: "POST", url: "/tasks", headers: auth(tokens.family),
      payload: { residentId: SEED_IDS.resident, text: utterance },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().kind).toBe("proposal");
    const id = created.json().task.id as string;
    const state = () => db.select().from(t.taskRequest).where(eq(t.taskRequest.id, id)).get()!.state;
    expect(gatewayMessages.filter((message) => message.type === "intent")).toEqual([]);

    expect((await app.inject({ method: "POST", url: `/tasks/${id}/confirm`, headers: auth(tokens.family) })).json().task.state)
      .toBe("awaiting_policy_or_staff");
    expect(gatewayMessages.filter((message) => message.type === "intent")).toEqual([]);

    expect((await app.inject({ method: "POST", url: `/tasks/${id}/approve`, headers: auth(tokens.staff) })).json().task.state)
      .toBe("queued");
    await waitFor(() => state() === "locating_item", "the robot to arrive at pickup");
    expect(gatewayMessages.filter((message) => message.type === "intent")).toHaveLength(1);

    expect((await app.inject({ method: "POST", url: `/tasks/${id}/loaded`, headers: auth(tokens.staff) })).json().task.state)
      .toBe("navigating_to_delivery");
    await waitFor(() => state() === "placing", "the robot to arrive for delivery");

    const deviceState = await app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.device) });
    expect(deviceState.statusCode).toBe(200);
    expect(deviceState.json()).toMatchObject({
      screen: "delivery_arrived",
      task: { id, state: "placing", item: { id: "water_bottle", label: "water bottle" } },
    });

    expect((await app.inject({ method: "POST", url: `/tasks/${id}/received`, headers: auth(tokens.device) })).json().task.state)
      .toBe("verifying_delivery");
    await waitFor(() => state() === "completed", "the robot to reach standby");
    expect((await app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.device) })).json())
      .toMatchObject({ screen: "home", task: null });

    const trail = db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, id)).all();
    expect(trail.map((event) => event.toState)).toEqual([
      "parsed", "awaiting_user_confirmation", "awaiting_policy_or_staff", "queued",
      "navigating_to_pickup", "locating_item", "grasping", "verifying_grasp",
      "navigating_to_delivery", "placing", "verifying_delivery", "completed",
    ]);
    expect(trail.map((event) => event.actorType)).toEqual([
      "system", "system", "family", "staff", "robot", "robot",
      "staff", "staff", "staff", "robot", "device", "robot",
    ]);
    expect(JSON.stringify({
      tasks: db.select().from(t.taskRequest).all(),
      approvals: db.select().from(t.taskApproval).all(),
      commands: db.select().from(t.robotCommand).all(),
      audit: db.select().from(t.auditEvent).all(),
    })).not.toContain(utterance);
  });

  test("staff cannot approve or dispatch an unconfirmed request", async () => {
    const { app, db, tokens } = await makeTestApp();
    const server = await listen(app);
    closers.push(server.close);
    const gatewayMessages: any[] = [];
    await trayGateway(server.url, SEED_SECRETS.robotToken, gatewayMessages);

    const id = (await app.inject({
      method: "POST", url: "/tasks", headers: auth(tokens.family),
      payload: { residentId: SEED_IDS.resident, text: "tissue box" },
    })).json().task.id as string;

    expect((await app.inject({ method: "POST", url: `/tasks/${id}/approve`, headers: auth(tokens.staff) })).statusCode).toBe(409);
    expect(gatewayMessages.filter((message) => message.type === "intent")).toEqual([]);
    expect(db.select().from(t.robotCommand).where(eq(t.robotCommand.taskId, id)).all()).toEqual([]);
  });
});
