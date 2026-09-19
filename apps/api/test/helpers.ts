import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { openDb } from "../src/db/client";
import { SEED_SECRETS, seed } from "../src/db/seed";
import { FakeVideoProvider } from "../src/services/video";

export async function makeTestApp(opts: { now?: () => Date } = {}) {
  const db = openDb(":memory:");
  await seed(db);
  const video = new FakeVideoProvider();
  const app = buildApp({ db, jwtSecret: "test-secret", video, ...(opts.now ? { now: opts.now } : {}) });
  await app.ready();
  const login = async (username: string, password: string) =>
    (await app.inject({ method: "POST", url: "/auth/login", payload: { username, password } })).json().token as string;
  const device = (await app.inject({ method: "POST", url: "/auth/device", payload: { deviceToken: SEED_SECRETS.deviceToken } })).json().token as string;
  return { app, db, video, tokens: {
    family: await login("family", SEED_SECRETS.familyPassword), staff: await login("staff", SEED_SECRETS.staffPassword),
    admin: await login("admin", SEED_SECRETS.adminPassword), device,
  } };
}

export async function listen(app: FastifyInstance): Promise<{ url: string; close: () => Promise<void> }> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => app.close() };
}
