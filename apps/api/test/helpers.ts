import { buildApp } from "../src/app";
import { openDb } from "../src/db/client";
import { SEED_SECRETS, seed } from "../src/db/seed";

export async function makeTestApp() {
  const db = openDb(":memory:");
  await seed(db);
  const app = buildApp({ db, jwtSecret: "test-secret" });
  await app.ready();
  const login = async (username: string, password: string) =>
    (await app.inject({ method: "POST", url: "/auth/login", payload: { username, password } })).json().token as string;
  const device = (await app.inject({ method: "POST", url: "/auth/device", payload: { deviceToken: SEED_SECRETS.deviceToken } })).json().token as string;
  return { app, db, tokens: { family: await login("family", SEED_SECRETS.familyPassword), staff: await login("staff", SEED_SECRETS.staffPassword), device } };
}
