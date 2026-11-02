import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "../src/db/client";

async function main() {
  const { db, pool } = createDb();
  await migrate(db, { migrationsFolder: "./drizzle" });
  await pool.end();
  console.log("Migrations applied.");
}
main().catch((e) => { console.error(e); process.exit(1); });
