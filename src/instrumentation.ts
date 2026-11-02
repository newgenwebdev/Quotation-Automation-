/**
 * Runs once when the server starts.
 * On the very first start (no users in the database), it creates the founding Admin
 * from BOOTSTRAP_ADMIN_EMAIL and prints a one-time setup link to the server logs.
 * After that it does nothing, even if the variable is left in place.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  if (!email || !process.env.DATABASE_URL) return;

  const { createDb } = await import("./db/client");
  const { bootstrapAdmin } = await import("./auth/service");
  const { db, pool } = createDb();
  try {
    const token = await bootstrapAdmin(db, email, process.env.BOOTSTRAP_ADMIN_NAME ?? "Administrator");
    if (token) {
      const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
      console.log("=".repeat(70));
      console.log(`First Admin created for ${email}.`);
      console.log(`Open this link once to set the password (expires in 72 hours):`);
      console.log(`${base || "<your app address>"}/setup/${token}`);
      console.log("=".repeat(70));
    }
  } catch (e) {
    console.error("Admin bootstrap failed:", e);
  } finally {
    await pool.end();
  }
}
