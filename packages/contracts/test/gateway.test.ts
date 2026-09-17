import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { zodToJsonSchema } from "zod-to-json-schema";
import { GatewayDownSchema, GatewayUpSchema } from "../src/gateway";

describe("gateway contracts", () => {
  test("accepts a deliver_item intent in tray mode", () => {
    const msg = {
      type: "intent", intent: "deliver_item", correlationId: "corr_1",
      expiresAt: "2026-09-17T00:05:00.000Z",
      payload: { itemId: "water_bottle", pickupLocationId: "pickup_station_demo", destinationLocationId: "room_demo_01", standbyLocationId: "standby_demo", mode: "tray" },
    };
    expect(GatewayDownSchema.safeParse(msg).success).toBe(true);
  });

  test("rejects an intent carrying raw coordinates", () => {
    const msg = {
      type: "intent", intent: "go_to_location", correlationId: "c", expiresAt: "2026-09-17T00:05:00.000Z",
      payload: { x: 1.0, y: 2.0, yaw: 0 },
    };
    expect(GatewayDownSchema.safeParse(msg).success).toBe(false);
  });

  test("rejects an unknown message type", () => {
    expect(GatewayDownSchema.safeParse({ type: "joy", vx: 1 }).success).toBe(false);
  });

  test("accepts a heartbeat with unknown battery", () => {
    const hb = {
      type: "heartbeat", at: "2026-09-17T00:00:00.000Z", robotReady: false, adapter: "mock",
      pose: null, navState: "idle", estop: false, lift: "unknown", battery: "unknown",
      activeCorrelationId: null, gatewayVersion: "0.0.1",
    };
    expect(GatewayUpSchema.safeParse(hb).success).toBe(true);
  });

  test("rejects a state_event with an unknown event name", () => {
    const ev = { type: "state_event", correlationId: "c", at: "2026-09-17T00:00:00.000Z", event: "completed" };
    expect(GatewayUpSchema.safeParse(ev).success).toBe(false);
  });

  test("accepts a resume message", () => {
    expect(GatewayDownSchema.safeParse({ type: "resume" }).success).toBe(true);
  });

  test("the emitted JSON Schema files still match the zod schemas", () => {
    const read = (f: string) => JSON.parse(readFileSync(f, "utf8"));
    expect(read("robot_gateway/schema/gateway-down.json"))
      .toEqual(zodToJsonSchema(GatewayDownSchema, "GatewayDown"));
    expect(read("robot_gateway/schema/gateway-up.json"))
      .toEqual(zodToJsonSchema(GatewayUpSchema, "GatewayUp"));
  });
});
