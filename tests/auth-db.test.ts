import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type DB } from "@/db/client";
import { users, setupTokens, auditLog } from "@/db/schema";
import { PermissionError } from "@/auth/permissions";
import {
  bootstrapAdmin, createUser, completeSetup, login, getSessionUser, logout,
  changeRole, setActive, issueResetLink, toActor, MAX_FAILED_LOGINS,
} from "@/auth/service";

const url = process.env.TEST_DATABASE_URL!;
let db: DB; let pool: import("pg").Pool;
const PW = "correct horse battery";

beforeAll(async () => { ({ db, pool } = createDb(url)); await migrate(db, { migrationsFolder: "./drizzle" }); });
afterAll(async () => { await pool.end(); });
beforeEach(async () => { await db.execute(sql`TRUNCATE audit_log, catalogue_items, commercial_policies, users RESTART IDENTITY CASCADE`); });

async function adminActor() {
  const token = await bootstrapAdmin(db, "Founder@Test.local", "Founder");
  const admin = await completeSetup(db, token!, PW);
  return toActor(admin);
}

describe("First start-up", () => {
  it("creates exactly one founding admin, only when the database has no users", async () => {
    const t1 = await bootstrapAdmin(db, "a@test.local");
    expect(t1).toBeTruthy();
    expect(await bootstrapAdmin(db, "b@test.local")).toBeNull();
    const all = await db.select().from(users);
    expect(all).toHaveLength(1);
    expect(all[0].role).toBe("admin");
    expect(all[0].passwordHash).toBeNull(); // no password until they open the link
  });
});

describe("Setup links", () => {
  it("work once, then stop working", async () => {
    const admin = await adminActor();
    const { setupToken } = await createUser(db, admin, { email: "sean@test.local", name: "Sean", role: "finance" });
    await completeSetup(db, setupToken, PW);
    await expect(completeSetup(db, setupToken, PW)).rejects.toMatchObject({ code: "INVALID_LINK" });
  });

  it("expire", async () => {
    const admin = await adminActor();
    const { user, setupToken } = await createUser(db, admin, { email: "x@test.local", name: "Xavier", role: "sales" });
    await db.update(setupTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(setupTokens.userId, user.id));
    await expect(completeSetup(db, setupToken, PW)).rejects.toMatchObject({ code: "INVALID_LINK" });
  });

  it("reject short passwords", async () => {
    const admin = await adminActor();
    const { setupToken } = await createUser(db, admin, { email: "y@test.local", name: "Yolanda", role: "sales" });
    await expect(completeSetup(db, setupToken, "short")).rejects.toMatchObject({ code: "WEAK_PASSWORD" });
  });

  it("a new reset link cancels the older one", async () => {
    const admin = await adminActor();
    const { user, setupToken: first } = await createUser(db, admin, { email: "z@test.local", name: "Zara", role: "sales" });
    const second = await issueResetLink(db, admin, user.id);
    await expect(completeSetup(db, first, PW)).rejects.toMatchObject({ code: "INVALID_LINK" });
    await completeSetup(db, second, PW);
  });

  it("only stores hashes, never the token itself", async () => {
    const admin = await adminActor();
    const { setupToken } = await createUser(db, admin, { email: "h@test.local", name: "Hana", role: "sales" });
    const rows = await db.select().from(setupTokens);
    expect(rows.some((r) => r.tokenHash === setupToken)).toBe(false);
  });
});

describe("Login", () => {
  it("works with the right password, case-insensitive email", async () => {
    await adminActor();
    const { sessionToken } = await login(db, "FOUNDER@test.local", PW);
    expect((await getSessionUser(db, sessionToken))?.email).toBe("founder@test.local");
  });

  it("gives the same message for unknown email and wrong password", async () => {
    await adminActor();
    const a = await login(db, "nobody@test.local", PW).catch((e) => e.message);
    const b = await login(db, "founder@test.local", "wrong password!!").catch((e) => e.message);
    expect(a).toBe(b);
  });

  it(`locks the account after ${MAX_FAILED_LOGINS} wrong passwords`, async () => {
    await adminActor();
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) await login(db, "founder@test.local", "nope nope nope").catch(() => {});
    await expect(login(db, "founder@test.local", PW)).rejects.toMatchObject({ code: "LOCKED" });
    const actions = (await db.select().from(auditLog)).map((r) => r.action);
    expect(actions).toContain("user.locked");
  });

  it("logout ends the session", async () => {
    await adminActor();
    const { sessionToken } = await login(db, "founder@test.local", PW);
    await logout(db, sessionToken);
    expect(await getSessionUser(db, sessionToken)).toBeNull();
  });
});

describe("User management", () => {
  it("only Admins can add users", async () => {
    const admin = await adminActor();
    const { user } = await createUser(db, admin, { email: "f@test.local", name: "Fin", role: "finance" });
    await expect(createUser(db, toActor(user), { email: "g@test.local", name: "Gee", role: "admin" })).rejects.toBeInstanceOf(PermissionError);
  });

  it("deactivating someone logs them out immediately", async () => {
    const admin = await adminActor();
    const { user, setupToken } = await createUser(db, admin, { email: "s@test.local", name: "Sales", role: "sales" });
    await completeSetup(db, setupToken, PW);
    const { sessionToken } = await login(db, "s@test.local", PW);
    await setActive(db, admin, user.id, false);
    expect(await getSessionUser(db, sessionToken)).toBeNull();
    await expect(login(db, "s@test.local", PW)).rejects.toMatchObject({ code: "BAD_LOGIN" });
  });

  it("a role change ends existing sessions so new permissions apply at once", async () => {
    const admin = await adminActor();
    const { user, setupToken } = await createUser(db, admin, { email: "r@test.local", name: "Rita", role: "finance" });
    await completeSetup(db, setupToken, PW);
    const { sessionToken } = await login(db, "r@test.local", PW);
    await changeRole(db, admin, user.id, "sales", "Moved to sales team");
    expect(await getSessionUser(db, sessionToken)).toBeNull();
  });

  it("the last active Admin can't be demoted or deactivated", async () => {
    const admin = await adminActor();
    await expect(changeRole(db, admin, admin.id, "sales")).rejects.toMatchObject({ code: "LAST_ADMIN" });
    await expect(setActive(db, admin, admin.id, false)).rejects.toMatchObject({ code: "LAST_ADMIN" });
  });

  it("duplicate emails are refused", async () => {
    const admin = await adminActor();
    await createUser(db, admin, { email: "d@test.local", name: "Dan", role: "sales" });
    await expect(createUser(db, admin, { email: "D@test.local", name: "Dan 2", role: "sales" })).rejects.toMatchObject({ code: "EMAIL_TAKEN" });
  });
});
