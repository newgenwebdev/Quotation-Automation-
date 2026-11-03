/**
 * COMPANY PROFILE (Settings → Company profile): NewGen's details printed on every quotation.
 * One row. If it's missing (e.g. a brand-new database before migrations), the confirmed
 * details from src/config/company.ts are used.
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { DB } from "@/db/client";
import { companyProfile, type CompanyProfile } from "@/db/schema";
import { assertCan, type Actor } from "@/auth/permissions";
import { writeAudit } from "@/audit/log";
import { COMPANY } from "@/config/company";

const opt = (max: number) => z.string().trim().max(max).transform((s) => (s === "" ? null : s)).nullable().default(null);

export const CompanyInput = z.object({
  name: z.string().trim().min(2, "Enter the company name").max(200),
  registrationNo: opt(100),
  address: opt(500),
  phone: opt(50),
  email: z.string().trim().max(200).transform((s) => (s === "" ? null : s)).nullable().default(null)
    .refine((v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Enter a valid email or leave it blank"),
  website: opt(200),
  bankName: opt(100),
  bankAccountName: opt(200),
  bankAccountNo: z.string().trim().max(40).transform((s) => (s === "" ? null : s)).nullable().default(null)
    .refine((v) => v === null || /^[0-9][0-9 -]{4,38}$/.test(v), "Account number: digits, spaces and dashes only"),
});
export type CompanyInput = z.input<typeof CompanyInput>;

export function fallbackCompany(): CompanyProfile {
  return {
    id: 1, name: COMPANY.name, registrationNo: COMPANY.registration, address: COMPANY.addressLines.join("\n"),
    phone: null, email: null, website: null, bankName: null, bankAccountName: null, bankAccountNo: null,
    updatedBy: null, updatedAt: new Date(0),
  };
}

export async function loadCompany(db: Pick<DB, "select">): Promise<CompanyProfile> {
  const [row] = await db.select().from(companyProfile).where(eq(companyProfile.id, 1));
  return row ?? fallbackCompany();
}

export async function saveCompany(db: DB, actor: Actor, raw: CompanyInput): Promise<CompanyProfile> {
  assertCan(actor, "company.manage");
  const input = CompanyInput.parse(raw);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(companyProfile).where(eq(companyProfile.id, 1)).for("update");
    const [row] = await tx.insert(companyProfile).values({ id: 1, ...input, updatedBy: actor.id, updatedAt: new Date() })
      .onConflictDoUpdate({ target: companyProfile.id, set: { ...input, updatedBy: actor.id, updatedAt: new Date() } })
      .returning();
    await writeAudit(tx, actor, { action: "company.updated", entityType: "company_profile", entityId: "1", before: before ?? null, after: row });
    return row;
  });
}
