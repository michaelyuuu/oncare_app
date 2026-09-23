import { expect, test } from "vitest";
import config from "./playwright.config";

test("the owned E2E stack uses an isolated in-memory database", () => {
  const webServers = Array.isArray(config.webServer) ? config.webServer : [config.webServer];
  const apiServer = webServers.find((server) => server && "url" in server && server.url === "http://127.0.0.1:3000/health");
  const databasePath = apiServer && "env" in apiServer ? apiServer.env?.DATABASE_PATH : undefined;

  expect(databasePath).toBe(":memory:");
});
