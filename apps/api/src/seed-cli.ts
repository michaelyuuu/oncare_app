import { openDb } from "./db/client";
import { seedDemo } from "./db/seed";
const db = openDb(process.env.DATABASE_PATH ?? "./oncare.db");
if (await seedDemo(db, process.env)) {
  console.log("seeded");
} else {
  console.error("demo seed is disabled for this environment");
  process.exitCode = 1;
}
