import { describe, expect, test } from "vitest";
import { GatewayHub, type RobotLink } from "../src/services/gateway-hub";

function makeLink(): RobotLink {
  return { send: () => {} };
}

describe("GatewayHub.detach", () => {
  test("detach(id, otherLink) is a no-op when a different link is stored", () => {
    const hub = new GatewayHub();
    const link1 = makeLink();
    const link2 = makeLink();
    hub.attach("robot_1", link1);
    hub.detach("robot_1", link2);
    expect(hub.status("robot_1").connected).toBe(true);
  });

  test("detach(id, link) removes when the stored link matches", () => {
    const hub = new GatewayHub();
    const link1 = makeLink();
    hub.attach("robot_1", link1);
    hub.detach("robot_1", link1);
    expect(hub.status("robot_1").connected).toBe(false);
  });

  test("detach(id) with no link still removes", () => {
    const hub = new GatewayHub();
    const link1 = makeLink();
    hub.attach("robot_1", link1);
    hub.detach("robot_1");
    expect(hub.status("robot_1").connected).toBe(false);
  });
});
