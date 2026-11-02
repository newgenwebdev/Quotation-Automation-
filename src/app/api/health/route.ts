import { Pool } from "pg";

export const dynamic = "force-dynamic";

/** Health check for Dokploy: confirms the app is up and can reach PostgreSQL. */
export async function GET() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    await pool.query("select 1");
    return Response.json({ ok: true, db: "up" });
  } catch {
    return Response.json({ ok: false, db: "down" }, { status: 503 });
  } finally {
    await pool.end();
  }
}
