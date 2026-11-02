// Plain-JavaScript migration runner used inside the Docker container at startup.
// (scripts/migrate.ts does the same thing for local development.)
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  await migrate(drizzle(pool), { migrationsFolder: process.env.MIGRATIONS_DIR ?? "./drizzle" });
  console.log("Migrations applied.");
} finally {
  await pool.end();
}
