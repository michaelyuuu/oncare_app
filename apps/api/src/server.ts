import { buildApp } from "./app";
import { openDb } from "./db/client";
import { seed } from "./db/seed";
import { FakeVideoProvider } from "./services/video";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // A local env file is optional; buildApp selects the fake provider when LiveKit is unconfigured.
}

const DEV_JWT_SECRET = "dev-only-secret-change-me";
const configuredSecret = process.env.JWT_SECRET;

if (process.env.NODE_ENV === "production" && !configuredSecret) {
  console.error("JWT_SECRET is required in production");
  process.exit(1);
}
if (!configuredSecret) {
  // Never print the secret itself, in any environment.
  console.warn("using the dev-only JWT secret (set JWT_SECRET)");
}

const db = openDb(process.env.DATABASE_PATH ?? "./oncare.db");
await seed(db);
const app = buildApp({ db, jwtSecret: configuredSecret ?? DEV_JWT_SECRET });
console.log(`video provider: ${app.video instanceof FakeVideoProvider ? "fake" : "livekit"}`);
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
// Reconcile intents the robot never acked. Deliberately started here and not
// in buildApp: tests drive sweepExpired directly with an injected clock, and a
// background timer inside the app object would leak into every one of them.
setInterval(() => app.dispatch.sweepExpired(), 5000).unref();
console.log(`api listening on :${port}`);
