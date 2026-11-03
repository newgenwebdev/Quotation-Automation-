/**
 * QUINN'S WORK: one "draft quotation" task, from request to finished draft.
 *
 *   queued ──► running ──► succeeded (a draft quotation exists)
 *                    └──► failed    (plain-English reason; nothing half-created)
 *
 * Each step is written to agent_events, which is what the progress page (and later the
 * Virtual Office) shows. The quotation is created in ONE database transaction: either the
 * whole draft appears, or nothing does.
 */
import { z } from "zod";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import {
  agentTasks, agentEvents, catalogueItems, termsTemplates, users, quotationVersions,
  type AgentTask, type AgentEvent, type DraftTaskInput, type QuinnNotes, type Quotation,
} from "@/db/schema";
import { assertCan, can, type Actor } from "@/auth/permissions";
import { toActor } from "@/auth/service";
import { writeAudit } from "@/audit/log";
import { normaliseTerms } from "@/terms/service";
import {
  QuoteError, addCatalogueLine, addCustomLine, createQuotation, loadTerms, updateScope, updateTerms,
} from "@/quotations/service";
import { buildQuinnInput } from "./prompt";
import { QuinnError, explainAiError, type Drafter } from "./ai";

export const MAX_ACTIVE_TASKS = 2;
export const MAX_TASKS_PER_HOUR = 20;

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const DraftRequest = z.object({
  description: z.string().trim()
    .min(20, "Describe what the client needs in a bit more detail (at least a sentence or two).")
    .max(20000, "The description is too long (max 20,000 characters)."),
  clientCompany: z.string().trim().max(200).transform((s) => (s.length >= 2 ? s : null)),
  termsTemplateId: z.string().refine((v) => v === "none" || uuidRe.test(v), "Choose the terms & conditions to use."),
  extraTerms: z.string().max(5000, "Extra terms are too long (max 5,000 characters).").transform((s) => normaliseTerms(s) || null),
});

function today(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
}

async function logEvent(db: Pick<DB, "insert">, taskId: string, step: string, message: string) {
  await db.insert(agentEvents).values({ taskId, step, message });
}

/** Staff ask Quinn for a draft. Returns the task; the background worker does the work. */
export async function createDraftTask(db: DB, actor: Actor, raw: z.input<typeof DraftRequest>): Promise<AgentTask> {
  assertCan(actor, "quotes.create");
  const input: DraftTaskInput = DraftRequest.parse(raw);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"quinn-user:" + actor.id}))`);
    const [{ active }] = await tx.select({ active: sql<number>`count(*)::int` }).from(agentTasks)
      .where(and(eq(agentTasks.requestedBy, actor.id), inArray(agentTasks.status, ["queued", "running"])));
    if (active >= MAX_ACTIVE_TASKS) throw new QuinnError("BUSY", "Quinn is still working on your previous request. Please wait for it to finish.");
    const [{ recent }] = await tx.select({ recent: sql<number>`count(*)::int` }).from(agentTasks)
      .where(and(eq(agentTasks.requestedBy, actor.id), gt(agentTasks.createdAt, new Date(Date.now() - 3600_000))));
    if (recent >= MAX_TASKS_PER_HOUR) throw new QuinnError("LIMIT", `You've asked Quinn for ${MAX_TASKS_PER_HOUR} drafts in the last hour. Please wait a little before trying again.`);
    if (input.termsTemplateId !== "none") {
      const [t] = await tx.select({ id: termsTemplates.id }).from(termsTemplates).where(and(eq(termsTemplates.id, input.termsTemplateId), eq(termsTemplates.active, true)));
      if (!t) throw new QuinnError("TERMS_GONE", "That T&C template isn't available any more. Please choose another.");
    }
    const [task] = await tx.insert(agentTasks).values({ kind: "draft_quotation", requestedBy: actor.id, input }).returning();
    await logEvent(tx, task.id, "queued", "Waiting for Quinn");
    // The description itself isn't copied into the audit log (it may contain client details).
    await writeAudit(tx, actor, { action: "quinn.draft_requested", entityType: "agent_task", entityId: task.id, after: { chars: input.description.length, termsTemplateId: input.termsTemplateId } });
    return task;
  });
}

export async function loadTaskForViewer(db: DB, actor: Actor, taskId: string): Promise<{ task: AgentTask; events: AgentEvent[] } | null> {
  if (!uuidRe.test(taskId)) return null;
  const [task] = await db.select().from(agentTasks).where(eq(agentTasks.id, taskId));
  if (!task || (task.requestedBy !== actor.id && actor.role !== "admin")) return null;
  const events = await db.select().from(agentEvents).where(eq(agentEvents.taskId, taskId)).orderBy(asc(agentEvents.id));
  return { task, events };
}

/** Run one task. Never throws: every outcome is recorded on the task. */
export async function runDraftTask(db: DB, taskId: string, drafter: Drafter): Promise<void> {
  // Claim it (a task only ever runs once).
  const [task] = await db.update(agentTasks).set({ status: "running", startedAt: new Date(), model: drafter.model })
    .where(and(eq(agentTasks.id, taskId), eq(agentTasks.status, "queued"))).returning();
  if (!task) return;

  try {
    const [u] = await db.select().from(users).where(eq(users.id, task.requestedBy));
    if (!u || !u.active || !can(u, "quotes.create")) throw new QuinnError("NO_ACCESS", "Your account can no longer create quotations.");
    const actor = toActor(u);
    const input = task.input;

    await logEvent(db, taskId, "reading", "Reading the description and the approved price list");
    const day = today();
    const catalogue = (await db.select().from(catalogueItems).where(eq(catalogueItems.status, "approved")))
      .filter((c) => c.validFrom <= day && (c.validTo === null || c.validTo >= day));
    let template: { id: string; body: string; name: string } | null = null;
    if (input.termsTemplateId !== "none") {
      [template] = await db.select({ id: termsTemplates.id, body: termsTemplates.body, name: termsTemplates.name }).from(termsTemplates)
        .where(and(eq(termsTemplates.id, input.termsTemplateId), eq(termsTemplates.active, true)));
      if (!template) throw new QuinnError("TERMS_GONE", "The chosen T&C template is no longer available. Pick another and try again.");
    }
    const finalTerms = [template?.body, input.extraTerms].filter(Boolean).join("\n\n") || null;

    await logEvent(db, taskId, "drafting", "Drafting the scope and line items");
    const draft = await drafter.draft(buildQuinnInput({ description: input.description, clientCompany: input.clientCompany, catalogue, termsText: finalTerms }));

    await logEvent(db, taskId, "saving", `Saving ${draft.lineItems.length} line item${draft.lineItems.length === 1 ? "" : "s"} as a draft quotation`);
    const approved = new Set(catalogue.map((c) => c.code));
    const assumptions = [...draft.assumptions];

    const quotation: Quotation = await db.transaction(async (tx) => {
      const tdb = tx as unknown as DB; // services open nested transactions (savepoints) on this one
      const company = input.clientCompany ?? (draft.client.company && draft.client.company.length >= 2 ? draft.client.company : null) ?? "Client to be confirmed";
      const q = await createQuotation(tdb, actor, {
        clientCompany: company, projectTitle: draft.projectTitle,
        clientContactName: draft.client.contactName, clientContactPhone: draft.client.contactPhone, clientContactEmail: draft.client.contactEmail,
      });
      await updateScope(tdb, actor, q.id, {
        scopeSummary: draft.scopeSummary, deliverables: draft.deliverables, exclusions: draft.exclusions,
        confirmedTimeline: null, internalNotes: null,
      });
      for (const li of draft.lineItems) {
        const code = li.catalogueCode && approved.has(li.catalogueCode) ? li.catalogueCode : null;
        if (code) {
          try {
            await addCatalogueLine(tdb, actor, q.id, { catalogueCode: code, quantity: li.quantity, details: li.details });
            continue;
          } catch (e) {
            if (!(e instanceof QuoteError) || !["CANT_PRICE", "DUPLICATE"].includes(e.code)) throw e;
            assumptions.push(`"${li.description}" couldn't use price-list item ${code} (${e.message}) so it was added as a custom item.`);
          }
        }
        await addCustomLine(tdb, actor, q.id, { description: li.description, details: li.details, quantity: li.quantity, unitLabel: li.unitLabel, unitPriceSen: null });
      }

      // Terms & conditions exactly as the staff member chose them; Quinn never writes T&C.
      const [v1] = await tx.select().from(quotationVersions).where(and(eq(quotationVersions.quotationId, q.id), eq(quotationVersions.version, 1)));
      if (template && v1.termsTemplateId !== template.id) await loadTerms(tdb, actor, q.id, { kind: "template", templateId: template.id });
      if (!template && v1.termsText) await updateTerms(tdb, actor, q.id, "");
      if (input.extraTerms) await updateTerms(tdb, actor, q.id, finalTerms ?? "");

      const notes: QuinnNotes = {
        taskId, model: drafter.model, generatedAt: new Date().toISOString(),
        clarificationQuestions: draft.clarificationQuestions, missingInformation: draft.missingInformation, assumptions,
      };
      await tx.update(quotationVersions).set({ aiNotes: notes }).where(eq(quotationVersions.id, v1.id));
      await writeAudit(tx, "agent:quinn", { action: "quote.drafted_by_quinn", entityType: "quotation", entityId: q.id, reason: `Drafted for ${actor.email} (task ${taskId}, ${drafter.model})` });
      return q;
    });

    await db.update(agentTasks).set({ status: "succeeded", quotationId: quotation.id, finishedAt: new Date() }).where(eq(agentTasks.id, taskId));
    await logEvent(db, taskId, "done", `Draft ${quotation.number} is ready for review`);
  } catch (e) {
    const qe = e instanceof QuinnError ? e
      : e instanceof QuoteError ? new QuinnError(e.code, e.message)
      : explainAiError(e, drafter.model);
    if (!(e instanceof QuinnError)) console.error("[quinn] task failed", taskId, e);
    await db.update(agentTasks).set({ status: "failed", error: qe.message, errorDetail: qe.detail ?? null, finishedAt: new Date() }).where(eq(agentTasks.id, taskId));
    await logEvent(db, taskId, "failed", qe.message);
  }
}
