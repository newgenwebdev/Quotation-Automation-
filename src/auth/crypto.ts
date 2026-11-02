/**
 * Password hashing and random tokens, using Node's built-in crypto (no extra packages).
 * scrypt is deliberately slow, so a stolen database can't be cracked quickly.
 */
import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";

const KEYLEN = 64;
const COST = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEYLEN, COST, (err, key) => (err ? reject(err) : resolve(key))));
}

/** Returns "scrypt$<salt>$<hash>". */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, keyB64] = stored.split("$");
  if (algo !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = await scryptAsync(password, Buffer.from(saltB64, "base64"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** A random, URL-safe secret (for cookies and setup links). */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** We store only this hash, so a database leak doesn't hand out live sessions or links. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Burn similar time for unknown emails so attackers can't tell which emails exist. */
export async function dummyVerify(): Promise<void> {
  await scryptAsync("dummy-password", Buffer.alloc(16));
}
