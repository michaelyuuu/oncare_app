import { describe, expect, test } from "vitest";
import { makeTestApp } from "./helpers";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("communication capabilities", () => {
  test("device receives customer capability states without physical robot actions", async () => {
    const { app, tokens } = await makeTestApp();
    const response = await app.inject({ method: "GET", url: "/capabilities", headers: auth(tokens.device) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      environment: "customer_v0_1",
      voice_conversation: { state: "available" },
      family_call: { state: expect.any(String) },
      staff_assistance: { state: "available" },
      robot: { state: "not_supported" },
    });
    expect(response.json()).not.toHaveProperty("tools.navigate");
    expect(response.json()).not.toHaveProperty("tools.manipulate");
  });

  test("capabilities require an authenticated supported principal", async () => {
    const { app, tokens } = await makeTestApp();
    expect((await app.inject({ method: "GET", url: "/capabilities" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/capabilities", headers: auth(tokens.family) })).statusCode).toBe(200);
  });
});
