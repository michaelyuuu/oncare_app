import { describe, expect, test } from "vitest";
import { GatewayHub, type RobotLink } from "../src/services/gateway-hub";

function makeLink(): RobotLink {
  return { send: () => {} };
}

describe("GatewayHub.attach", () => {
  test("attaching a second link closes the superseded one with 4409", () => {
    const hub = new GatewayHub();
    const closes: Array<[number, string]> = [];
    const link1: RobotLink = { send: () => {}, close: (code, reason) => { closes.push([code, reason]); } };
    const link2 = makeLink();
    hub.attach("robot_1", link1);
    hub.attach("robot_1", link2);
    expect(closes).toEqual([[4409, "superseded"]]);
    expect(hub.status("robot_1").connected).toBe(true);
  });

  test("a superseded link without close() is simply replaced", () => {
    const hub = new GatewayHub();
    hub.attach("robot_1", makeLink());
    expect(() => hub.attach("robot_1", makeLink())).not.toThrow();
    expect(hub.status("robot_1").connected).toBe(true);
  });

  test("re-attaching the very same link does not close it", () => {
    const hub = new GatewayHub();
    let closed = 0;
    const link: RobotLink = { send: () => {}, close: () => { closed++; } };
    hub.attach("robot_1", link);
    hub.attach("robot_1", link);
    expect(closed).toBe(0);
    expect(hub.status("robot_1").connected).toBe(true);
  });
});

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
