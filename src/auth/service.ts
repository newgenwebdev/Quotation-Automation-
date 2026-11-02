/**
 * LOGIN AND USER MANAGEMENT
 *
 * How someone gets access:
 *   1. An Admin adds them (name, email, role). The system creates a one-time setup link.
 *   2. The Admin sends that link privately (WhatsApp, email). It works once and expires in 72 hours.
 *   3. The person opens it and chooses their own password. Nobody else ever knows it.
 * No emails are sent by the system yet, so no email service is needed.
 *
 * Protections: passwords hashed with scrypt; sessions and links stored only as hashes;
 * 5 wrong passwords lock the account for 15 minutes; deactivated users are logged out at once;
 * the last active Admin can't be removed or demoted.
 */
import { z } from "zod";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import { users, sessions, setupTokens, auditLog, type User, type Role } from "@/db/schema";
import { assertCan, type Actor } from "./permissions";
import { writeAudit } from "@/audit/log";
import { hashPassword, verifyPassword, newToken, hashToken, dummyVerify } from "./crypto";

export const SESSION_DAYS = 7;
export const SETUP_LINK_HOURS = 72;
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;
export const MIN_PASSWORD_LENGTH = 10;

export class AuthError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export function toActor(u: Pick<User, "id" | "role" | "email">): Actor {
  return { id: u.id, role: u.role, email: u.email };
}

const NewUserInput = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  name: z.string().trim().min(2, "Enter a name"),
  role: z.enum(["sales", "technical", "finance", "admin"]),
});

async function issueSetupToken(tx: Pick<DB, "insert">, userId: string): Promise<string> {
  const token = newToken();
  await tx.insert(setupTokens).values({
    tokenHash: hashToken(token), userId,
    expiresAt: new Date(Date.now() + SETUP_LINK_HOURS * 3600_000),
  });
  return token;
}

/** Admin adds a person. Returns the one-time setup token to put in their link. */
export async function createUser(db: DB, actor: Actor, raw: z.input<typeof NewUserInput>): Promise<{ user: User; setupToken: string }> {
  assertCan(actor, "users.manage");
  const input = NewUserInput.parse(raw);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, input.email));
    if (existing) throw new AuthError("EMAIL_TAKEN", "A user with that email already exists.");
    const [user] = await tx.insert(users).values(input).returning();
    const setupToken = await issueSetupToken(tx, user.id);
    await writeAudit(tx, actor, { action: "user.created", entityType: "user", entityId: user.id, after: { email: user.email, name: user.name, role: user.role } });
    return { user, setupToken };
  });
}

/** First start only: if there are no users yet, create the founding Admin. */
export async function bootstrapAdmin(db: DB, email: string, name = "Administrator"): Promise<string | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('bootstrap-admin'))`);
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(users);
    if (n > 0) return null;
    const [user] = await tx.insert(users).values({ email: email.trim().toLowerCase(), name, role: "admin" }).returning();
    const token = await issueSetupToken(tx, user.id);
    await tx.insert(auditLog).values({
      actorLabel: "system:bootstrap", action: "user.created", entityType: "user", entityId: user.id,
      after: { email: user.email, role: "admin" }, reason: "First administrator created on initial start-up",
    });
    return token;
  });
}

/** Admin creates a fresh setup link (forgotten password, or the first link expired). */
export async function issueResetLink(db: DB, actor: Actor, userId: string): Promise<string> {
  assertCan(actor, "users.manage");
  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId));
    if (!user) throw new AuthError("NOT_FOUND", "User not found.");
    if (!user.active) throw new AuthError("INACTIVE", "Reactivate this user before issuing a link.");
    // Old unused links stop working.
    await tx.update(setupTokens).set({ usedAt: new Date() }).where(and(eq(setupTokens.userId, userId), isNull(setupTokens.usedAt)));
    const token = await issueSetupToken(tx, userId);
    await writeAudit(tx, actor, { action: "user.setup_link_issued", entityType: "user", entityId: userId });
    return token;
  });
}

/** The person opens their link and chooses a password. The link then stops working. */
export async function completeSetup(db: DB, token: string, password: string): Promise<User> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError("WEAK_PASSWORD", `Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const passwordHash = await hashPassword(password);
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(setupTokens).where(eq(setupTokens.tokenHash, hashToken(token))).for("update");
    if (!row || row.usedAt || row.expiresAt < new Date()) {
      throw new AuthError("INVALID_LINK", "This link is invalid, already used or expired. Ask an Admin for a new one.");
    }
    const [user] = await tx.select().from(users).where(eq(users.id, row.userId));
    if (!user.active) throw new AuthError("INACTIVE", "This account is deactivated.");
    await tx.update(setupTokens).set({ usedAt: new Date() }).where(eq(setupTokens.tokenHash, row.tokenHash));
    const [updated] = await tx.update(users).set({ passwordHash, failedLogins: 0, lockedUntil: null }).where(eq(users.id, user.id)).returning();
    // A password change logs out every existing session.
    await tx.delete(sessions).where(eq(sessions.userId, user.id));
    await writeAudit(tx, toActor(user), { action: "user.password_set", entityType: "user", entityId: user.id });
    return updated;
  });
}

/** Check email + password. Returns a session token for the cookie. */
export async function login(db: DB, emailRaw: string, password: string): Promise<{ sessionToken: string; user: User }> {
  const email = emailRaw.trim().toLowerCase();
  const generic = new AuthError("BAD_LOGIN", "Wrong email or password.");
  const [user] = await db.select().from(users).where(eq(users.email, email));

  if (!user || !user.passwordHash || !user.active) {
    await dummyVerify();
    throw generic;
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AuthError("LOCKED", `Too many wrong attempts. Try again after ${LOCK_MINUTES} minutes.`);
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    const failed = user.failedLogins + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    await db.update(users).set({
      failedLogins: lock ? 0 : failed,
      lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
    }).where(eq(users.id, user.id));
    if (lock) {
      await writeAudit(db, toActor(user), { action: "user.locked", entityType: "user", entityId: user.id, reason: `${MAX_FAILED_LOGINS} failed logins` });
    }
    throw generic;
  }

  const sessionToken = newToken();
  await db.transaction(async (tx) => {
    await tx.insert(sessions).values({
      tokenHash: hashToken(sessionToken), userId: user.id,
      expiresAt: new Date(Date.now() + SESSION_DAYS * 86400_000),
    });
    await tx.update(users).set({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(users.id, user.id));
  });
  return { sessionToken, user };
}

/** Who owns this session cookie? Null if missing, expired, or the user was deactivated. */
export async function getSessionUser(db: DB, sessionToken: string | undefined): Promise<User | null> {
  if (!sessionToken) return null;
  const [row] = await db.select({ user: users }).from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(sessionToken)), gt(sessions.expiresAt, new Date()), eq(users.active, true)));
  return row?.user ?? null;
}

export async function logout(db: DB, sessionToken: string | undefined): Promise<void> {
  if (sessionToken) await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(sessionToken)));
}

async function countActiveAdmins(tx: Pick<DB, "select">): Promise<number> {
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(users).where(and(eq(users.role, "admin"), eq(users.active, true)));
  return n;
}

export async function changeRole(db: DB, actor: Actor, userId: string, role: Role, reason?: string): Promise<User> {
  assertCan(actor, "users.manage");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('admin-count'))`);
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (!user) throw new AuthError("NOT_FOUND", "User not found.");
    if (user.role === role) return user;
    if (user.role === "admin" && user.active && (await countActiveAdmins(tx)) <= 1) {
      throw new AuthError("LAST_ADMIN", "This is the only active Admin. Make someone else Admin first.");
    }
    const [updated] = await tx.update(users).set({ role }).where(eq(users.id, userId)).returning();
    // Role changes take effect immediately: existing sessions are ended.
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await writeAudit(tx, actor, { action: "user.role_changed", entityType: "user", entityId: userId, before: { role: user.role }, after: { role }, reason });
    return updated;
  });
}

export async function setActive(db: DB, actor: Actor, userId: string, active: boolean): Promise<User> {
  assertCan(actor, "users.manage");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('admin-count'))`);
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (!user) throw new AuthError("NOT_FOUND", "User not found.");
    if (user.active === active) return user;
    if (!active && user.role === "admin" && (await countActiveAdmins(tx)) <= 1) {
      throw new AuthError("LAST_ADMIN", "You can't deactivate the only active Admin.");
    }
    const [updated] = await tx.update(users).set({ active }).where(eq(users.id, userId)).returning();
    if (!active) {
      await tx.delete(sessions).where(eq(sessions.userId, userId));
      await tx.update(setupTokens).set({ usedAt: new Date() }).where(and(eq(setupTokens.userId, userId), isNull(setupTokens.usedAt)));
    }
    await writeAudit(tx, actor, { action: active ? "user.reactivated" : "user.deactivated", entityType: "user", entityId: userId });
    return updated;
  });
}
