/**
 * Runs once when the server starts.
 *  1. First start only: creates the founding Admin from BOOTSTRAP_ADMIN_EMAIL and prints a
 *     one-time setup link in the logs (does nothing once any user exists).
 *  2. Starts Quinn's background worker (set QUINN_WORKER=off to run it elsewhere).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.DATABASE_URL) return;
  await bootstrapFirstAdmin();
  if (process.env.QUINN_WORKER !== "off") {
    try {
      const { createDb } = await import("./db/client");
      const { startQuinnWorker } = await import("./quinn/queue");
      const { quinnConfigured, quinnModel } = await import("./quinn/ai");
      await startQuinnWorker(createDb().db);
      console.log(`Quinn worker started (${quinnConfigured() ? `OpenAI model ${quinnModel()}` : "OpenAI key not set yet"}).`);
    } catch (e) {
      console.error("Quinn worker failed to start:", e);
    }
  }
}

async function bootstrapFirstAdmin() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  if (!email) return;
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
