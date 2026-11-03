/**
 * QUINN'S WORK: one "draft quotation" task, from pasted text to a complete quotation.
 *
 *   queued ──► running ──► succeeded (a complete draft quotation exists; the editor opens it)
 *                    └──► failed    (plain-English reason; nothing half-created)
 *
 * Steps: read the price list and default settings → ask OpenAI for the structured content →
 * apply approved prices from the price list (never from the AI) → save with the default payment
 * terms, tax, validity and T&C. Each step is written to agent_events (the progress page shows them).
 * The quotation is saved in ONE transaction: either the whole draft appears, or nothing does.
 */
import { z } from "zod";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import { agentTasks, agentEvents, users, type AgentTask, type AgentEvent, type DraftTaskInput, type QuinnNotes } from "@/db/schema";
import { assertCan, can, type Actor } from "@/auth/permissions";
import { toActor } from "@/auth/service";
import { writeAudit } from "@/audit/log";
import { activePriceList } from "@/catalogue/service";
import { QuoteError, newQuoteDefaults, saveDraft, type QuotePayloadInput } from "@/quotations/service";
import { CalcError, PLACEHOLDER_CLIENT, PLACEHOLDER_TITLE, linesFromPriceList, todayKL } from "@/quotations/calc";
import { buildQuinnInput } from "./prompt";
import { QuinnError, explainAiError, type Drafter } from "./ai";
import type { AiDraft } from "./draft-schema";

export const MAX_ACTIVE_TASKS = 2;
export const MAX_TASKS_PER_HOUR = 20;
/** Long WhatsApp exports are fine; this is roughly 15,000 words. */
export const MAX_DESCRIPTION = 60_000;

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const DraftRequest = z.object({
  description: z.string().trim()
    .min(20, "Paste or describe what the client needs (at least a sentence or two).")
    .max(MAX_DESCRIPTION, `That's too long (max ${MAX_DESCRIPTION.toLocaleString()} characters). Remove old or unrelated messages and try again.`),
  clientCompany: z.string().trim().max(200).default("").transform((s) => (s.length >= 2 ? s : null)),
});

async function logEvent(db: Pick<DB, "insert">, taskId: string, step: string, message: string) {
  await db.insert(agentEvents).values({ taskId, step, message });
}

/** Staff ask Quinn for a quotation. Returns the task; the background worker does the work. */
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
    if (recent >= MAX_TASKS_PER_HOUR) throw new QuinnError("LIMIT", `You've asked Quinn for ${MAX_TASKS_PER_HOUR} quotations in the last hour. Please wait a little before trying again.`);
    const [task] = await tx.insert(agentTasks).values({ kind: "draft_quotation", requestedBy: actor.id, input }).returning();
    await logEvent(tx, task.id, "queued", "Waiting for Quinn");
    // The pasted text itself isn't copied into the audit log (it may contain client details).
    await writeAudit(tx, actor, { action: "quinn.draft_requested", entityType: "agent_task", entityId: task.id, after: { chars: input.description.length } });
    return task;
  });
}

export async function loadTaskForViewer(db: DB, actor: Actor, taskId: string): Promise<{ task: AgentTask; events: AgentEvent[] } | null> {
  if (!uuidRe.test(taskId)) return null;
  const [task] = await db.select().from(agentTasks).where(eq(agentTasks.id, taskId));
  if (!task || (task.requestedBy !== actor.id && !can(actor, "quotes.viewAll"))) return null;
  const events = await db.select().from(agentEvents).where(eq(agentEvents.taskId, taskId)).orderBy(asc(agentEvents.id));
  return { task, events };
}

/**
 * Apply approved prices. A line gets a price ONLY from the price list, via the item Quinn named;
 * everything else is left unpriced ("Price review required") with a note saying why.
 */
export function priceDraftLines(draft: AiDraft, catalogue: Awaited<ReturnType<typeof activePriceList>>) {
  const byCode = new Map(catalogue.map((c) => [c.code, c]));
  const used = new Set<string>();
  const lines: NonNullable<QuotePayloadInput["lines"]> = [];
  const notes: string[] = [];
  for (const li of draft.lineItems) {
    const item = li.catalogueCode ? byCode.get(li.catalogueCode) : undefined;
    if (item && !used.has(item.code)) {
      const priced = linesFromPriceList(item, li.quantity, li.details);
      if ("lines" in priced) {
        used.add(item.code);
        lines.push(...priced.lines.map((p) => ({ ...p, category: p.category })));
        notes.push(`“${li.description}” priced from the price list (${item.code}).`);
        continue;
      }
      notes.push(`Price review required: “${li.description}”. ${priced.problem}`);
    } else if (li.catalogueCode && !item) {
      notes.push(`Price review required: “${li.description}” (Quinn suggested ${li.catalogueCode}, which isn't on the current price list).`);
    } else if (item) {
      notes.push(`Price review required: “${li.description}” (${item.code} is already used on another line).`);
    } else {
      notes.push(`Price review required: “${li.description}” has no matching price-list item.`);
    }
    lines.push({
      catalogueItemId: null, category: li.category, description: li.description, details: li.details,
      quantity: li.quantity, unitLabel: li.unitLabel, unitPriceSen: null,
    });
  }
  return { lines, notes };
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

    await logEvent(db, taskId, "reading", "Reading the requirements, the price list and your default settings");
    const catalogue = await activePriceList(db, todayKL());
    const defaults = await newQuoteDefaults(db);

    await logEvent(db, taskId, "drafting", "Writing the quotation: client, scope, deliverables, timeline and pricing items");
    const draft = await drafter.draft(buildQuinnInput({ description: input.description, clientCompany: input.clientCompany, catalogue, termsText: defaults.terms.text }));

    const { lines, notes: pricingNotes } = priceDraftLines(draft, catalogue);
    const review = lines.filter((l) => l.unitPriceSen === null).length;
    await logEvent(db, taskId, "pricing", `Applied approved prices to ${lines.length - review} of ${lines.length} item${lines.length === 1 ? "" : "s"}${review ? `; ${review} need${review === 1 ? "s" : ""} a price review` : ""}`);

    const company = input.clientCompany ?? (draft.client.company && draft.client.company.length >= 2 ? draft.client.company : null);
    const title = draft.projectTitle && draft.projectTitle.length >= 3 ? draft.projectTitle : null;
    const missing = [...draft.missingInformation];
    if (!company) missing.unshift("The client's company name.");
    if (!title) missing.unshift("A project title.");
    const notes: QuinnNotes = {
      taskId, model: drafter.model, generatedAt: new Date().toISOString(),
      clarificationQuestions: draft.clarificationQuestions, missingInformation: missing, assumptions: draft.draftNotes, pricingNotes,
    };
    const payload: QuotePayloadInput = {
      quoteDate: defaults.quoteDate, validUntil: defaults.validUntil,
      client: {
        company: company ?? PLACEHOLDER_CLIENT, contactName: draft.client.contactName, email: draft.client.contactEmail,
        phone: draft.client.contactPhone, address: draft.client.address,
      },
      projectTitle: title ?? PLACEHOLDER_TITLE,
      overview: draft.projectOverview, objectives: draft.objectives,
      services: draft.services, features: draft.features, technicalRequirements: draft.technicalRequirements,
      deliverables: draft.deliverables, exclusions: draft.exclusions, assumptions: draft.projectAssumptions,
      lines, discount: null, tax: defaults.tax,
      timeline: { duration: draft.timeline.estimatedDuration, milestones: draft.timeline.milestones },
      payment: { milestones: defaults.paymentMilestones, notes: null },
      terms: { templateId: defaults.terms.templateId, sourceVersionId: null, text: defaults.terms.text, projectTerms: null },
      internalNotes: null,
    };

    await logEvent(db, taskId, "saving", "Saving the draft quotation");
    const quotation = await db.transaction(async (tx) => {
      const { quotation: q } = await saveDraft(tx as unknown as DB, actor, payload, { aiNotes: notes, auditReason: `Drafted by Quinn (task ${taskId})` });
      await writeAudit(tx, "agent:quinn", { action: "quote.drafted_by_quinn", entityType: "quotation", entityId: q.id, reason: `Drafted for ${actor.email} (task ${taskId}, ${drafter.model})` });
      return q;
    });

    await db.update(agentTasks).set({ status: "succeeded", quotationId: quotation.id, finishedAt: new Date() }).where(eq(agentTasks.id, taskId));
    await logEvent(db, taskId, "done", `Quotation ${quotation.number} is ready to review`);
  } catch (e) {
    const issues = (e as { issues?: { message: string }[] }).issues;
    const qe = e instanceof QuinnError ? e
      : e instanceof QuoteError || e instanceof CalcError ? new QuinnError(e.code, e.message)
      : Array.isArray(issues) ? new QuinnError("AI_BAD_OUTPUT", "Quinn's draft didn't pass the quotation checks. Please try again.", issues.map((i) => i.message).join("; ").slice(0, 1000))
      : explainAiError(e, drafter.model);
    if (!(e instanceof QuinnError)) console.error("[quinn] task failed", taskId, e);
    await db.update(agentTasks).set({ status: "failed", error: qe.message, errorDetail: qe.detail ?? null, finishedAt: new Date() }).where(eq(agentTasks.id, taskId));
    await logEvent(db, taskId, "failed", qe.message);
  }
}
