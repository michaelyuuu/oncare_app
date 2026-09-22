import { expect, test } from "vitest";
import config from "./playwright.config";

test("the owned E2E stack uses an isolated in-memory database", () => {
  const webServers = Array.isArray(config.webServer) ? config.webServer : [config.webServer];
  const apiServer = webServers[0];
  const databasePath = apiServer && "env" in apiServer ? apiServer.env?.DATABASE_PATH : undefined;

  expect(databasePath).toBe(":memory:");
});
