import { openDb } from "./db/client";
import { seed } from "./db/seed";
const db = openDb(process.env.DATABASE_PATH ?? "./oncare.db");
await seed(db);
console.log("seeded");
