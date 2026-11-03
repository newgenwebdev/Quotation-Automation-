/**
 * T&C TEMPLATES (Settings) — standard terms & conditions wording.
 *
 * The default template is applied to every new quotation automatically; the salesperson can
 * pick another template (or the terms used for this client before) and adjust the wording.
 * Editing a template never changes quotations already created, because each quotation keeps
 * its own copy of the text.
 */
import { z } from "zod";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import { termsTemplates, type TermsTemplate } from "@/db/schema";
import { assertCan, type Actor } from "@/auth/permissions";
import { writeAudit } from "@/audit/log";

export const MAX_TERMS_LENGTH = 20000;

export class TermsError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/** Same wording? Ignores Windows line endings, trailing spaces and blank edges. */
export function normaliseTerms(s: string | null | undefined): string {
  return (s ?? "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd()).join("\n").trim();
}

const TemplateInput = z.object({
  name: z.string().trim().min(2, "Give the template a name").max(100, "Name is too long"),
  body: z.string().min(10, "Write the terms (at least a sentence)").max(MAX_TERMS_LENGTH, `Terms are too long (max ${MAX_TERMS_LENGTH.toLocaleString()} characters)`),
  isDefault: z.boolean().default(false),
  active: z.boolean().default(true),
});
export type TemplateInput = z.input<typeof TemplateInput>;

async function assertNameFree(tx: Pick<DB, "select">, name: string, exceptId?: string) {
  const [clash] = await tx.select({ id: termsTemplates.id }).from(termsTemplates)
    .where(and(sql`lower(${termsTemplates.name}) = lower(${name})`, exceptId ? ne(termsTemplates.id, exceptId) : undefined));
  if (clash) throw new TermsError("NAME_TAKEN", `A template called "${name}" already exists.`);
}

export async function listTemplates(db: DB, opts: { activeOnly?: boolean } = {}): Promise<TermsTemplate[]> {
  return db.select().from(termsTemplates)
    .where(opts.activeOnly ? eq(termsTemplates.active, true) : undefined)
    .orderBy(sql`${termsTemplates.isDefault} DESC`, asc(termsTemplates.name));
}

export async function createTemplate(db: DB, actor: Actor, raw: TemplateInput): Promise<TermsTemplate> {
  assertCan(actor, "terms.manage");
  const input = TemplateInput.parse({ ...raw, body: normaliseTerms(raw.body) });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('terms-templates'))`);
    await assertNameFree(tx, input.name);
    const isDefault = input.isDefault && input.active;
    if (isDefault) await tx.update(termsTemplates).set({ isDefault: false }).where(eq(termsTemplates.isDefault, true));
    const [row] = await tx.insert(termsTemplates).values({ ...input, isDefault, createdBy: actor.id }).returning();
    await writeAudit(tx, actor, { action: "terms.template_created", entityType: "terms_template", entityId: row.id, after: { name: row.name, isDefault: row.isDefault } });
    return row;
  });
}

export async function updateTemplate(db: DB, actor: Actor, id: string, raw: TemplateInput, reason?: string): Promise<TermsTemplate> {
  assertCan(actor, "terms.manage");
  const input = TemplateInput.parse({ ...raw, body: normaliseTerms(raw.body) });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('terms-templates'))`);
    const [existing] = await tx.select().from(termsTemplates).where(eq(termsTemplates.id, id)).for("update");
    if (!existing) throw new TermsError("NOT_FOUND", "Template not found.");
    await assertNameFree(tx, input.name, id);
    const isDefault = input.isDefault && input.active; // an inactive template can't be the default
    if (isDefault && !existing.isDefault) {
      await tx.update(termsTemplates).set({ isDefault: false }).where(eq(termsTemplates.isDefault, true));
    }
    const [row] = await tx.update(termsTemplates)
      .set({ ...input, isDefault, updatedBy: actor.id, updatedAt: new Date() })
      .where(eq(termsTemplates.id, id)).returning();
    await writeAudit(tx, actor, {
      action: "terms.template_updated", entityType: "terms_template", entityId: id,
      before: { name: existing.name, body: existing.body, isDefault: existing.isDefault, active: existing.active },
      after: { name: row.name, body: row.body, isDefault: row.isDefault, active: row.active },
      reason,
    });
    return row;
  });
}
