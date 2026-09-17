import { buildApp } from "./app";
import { openDb } from "./db/client";
import { seed } from "./db/seed";

const db = openDb(process.env.DATABASE_PATH ?? "./oncare.db");
await seed(db);
const app = buildApp({ db, jwtSecret: process.env.JWT_SECRET ?? "dev-only-secret-change-me" });
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
console.log(`api listening on :${port}`);
