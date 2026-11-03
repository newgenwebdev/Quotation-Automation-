/**
 * THE SHAPE OF QUINN'S ANSWER
 *
 * OpenAI is forced ("strict" mode) to answer in exactly this JSON shape.
 * Notice what is NOT here: no prices, amounts, discounts, payment terms, dates or T&C.
 * Quinn structurally cannot produce them; pricing stays with the price list, people and Finance.
 *
 * Even so, the answer is treated as untrusted: it's cleaned and checked below before use.
 */
import { z } from "zod";

export const SERVICE_CATEGORIES = [
  "website", "landing_page", "ecommerce", "mobile_app", "custom_software",
  "ai_automation", "seo", "hosting", "maintenance", "other",
] as const;

const nullableString = (description: string) => ({ type: ["string", "null"], description });
const stringList = (description: string) => ({ type: "array", description, items: { type: "string" } });

/** JSON Schema sent to OpenAI (strict mode: every field required, no extra fields). */
export const DRAFT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["client", "projectTitle", "serviceCategory", "scopeSummary", "deliverables", "exclusions", "lineItems", "missingInformation", "clarificationQuestions", "assumptions"],
  properties: {
    client: {
      type: "object",
      additionalProperties: false,
      required: ["company", "contactName", "contactPhone", "contactEmail"],
      properties: {
        company: nullableString("Client company name, only if stated in the description"),
        contactName: nullableString("Contact person, only if stated"),
        contactPhone: nullableString("Contact phone, only if stated"),
        contactEmail: nullableString("Contact email, only if stated"),
      },
    },
    projectTitle: { type: "string", description: "Short client-facing project title (max 80 characters)" },
    serviceCategory: { type: "string", enum: [...SERVICE_CATEGORIES] },
    scopeSummary: { type: "string", description: "2-4 sentence client-facing summary of the work" },
    deliverables: stringList("Concrete things the client will receive"),
    exclusions: stringList("Relevant things NOT included that the client might assume are"),
    lineItems: {
      type: "array",
      description: "Separately priceable pieces of work. No prices.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "details", "quantity", "unitLabel", "catalogueCode"],
        properties: {
          description: { type: "string", description: "Client-facing item name" },
          details: nullableString("Optional client-facing detail, e.g. which pages or features"),
          quantity: { type: "integer", description: "Number of units; 1 if not countable" },
          unitLabel: nullableString("Unit for the quantity, e.g. page, screen, feature, month; null if quantity is 1 of a whole item"),
          catalogueCode: nullableString("Exact code from the approved price list if this is exactly that service, else null"),
        },
      },
    },
    missingInformation: stringList("Facts NewGen still needs before this can be priced or delivered"),
    clarificationQuestions: stringList("Specific questions to ask the client"),
    assumptions: stringList("Assumptions made to prepare this draft"),
  },
} as const;

// ---------- Cleaning and checking the answer ----------

const LIMITS = { title: 120, summary: 3000, item: 200, details: 500, listItem: 300, list: 20, lines: 30, maxQty: 10000 };

const cut = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s === "" ? null : s.slice(0, max);
};
const cutBlock = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\r\n?/g, "\n").trim();
  return s === "" ? null : s.slice(0, max);
};
const list = (v: unknown, maxItems = LIMITS.list): string[] =>
  (Array.isArray(v) ? v : []).map((x) => cut(x, LIMITS.listItem)).filter((x): x is string => !!x).slice(0, maxItems);

export const AiDraft = z.object({
  client: z.object({
    company: z.string().nullable(),
    contactName: z.string().nullable(),
    contactPhone: z.string().nullable(),
    contactEmail: z.string().nullable(),
  }),
  projectTitle: z.string().min(3),
  serviceCategory: z.enum(SERVICE_CATEGORIES),
  scopeSummary: z.string().min(10),
  deliverables: z.array(z.string()),
  exclusions: z.array(z.string()),
  lineItems: z.array(z.object({
    description: z.string().min(3),
    details: z.string().nullable(),
    quantity: z.number().int().min(1).max(LIMITS.maxQty),
    unitLabel: z.string().nullable(),
    catalogueCode: z.string().nullable(),
  })).min(1, "Quinn couldn't find anything to quote in the description."),
  missingInformation: z.array(z.string()),
  clarificationQuestions: z.array(z.string()),
  assumptions: z.array(z.string()),
});
export type AiDraft = z.infer<typeof AiDraft>;

/**
 * Turn whatever came back into a safe, bounded draft. Unknown fields (e.g. a sneaked-in "price")
 * are dropped, text is trimmed to sensible lengths, odd quantities fall back to 1, and an
 * email that doesn't look like an email is discarded rather than guessed at.
 */
export function sanitizeDraft(raw: unknown): AiDraft {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const c = (r.client && typeof r.client === "object" ? r.client : {}) as Record<string, unknown>;
  const email = cut(c.contactEmail, 200);
  const cat = typeof r.serviceCategory === "string" && (SERVICE_CATEGORIES as readonly string[]).includes(r.serviceCategory) ? r.serviceCategory : "other";
  const lines = (Array.isArray(r.lineItems) ? r.lineItems : []).slice(0, LIMITS.lines).map((li) => {
    const l = (li && typeof li === "object" ? li : {}) as Record<string, unknown>;
    const q = typeof l.quantity === "number" && Number.isInteger(l.quantity) && l.quantity >= 1 && l.quantity <= LIMITS.maxQty ? l.quantity : 1;
    return {
      description: cut(l.description, LIMITS.item) ?? "",
      details: cut(l.details, LIMITS.details),
      quantity: q,
      unitLabel: q === 1 && !cut(l.unitLabel, 30) ? null : cut(l.unitLabel, 30),
      catalogueCode: cut(l.catalogueCode, 60)?.toUpperCase() ?? null,
    };
  }).filter((l) => l.description.length >= 3);

  return AiDraft.parse({
    client: {
      company: cut(c.company, 200),
      contactName: cut(c.contactName, 120),
      contactPhone: cut(c.contactPhone, 40),
      contactEmail: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    },
    projectTitle: cut(r.projectTitle, LIMITS.title) ?? "Project (title to confirm)",
    serviceCategory: cat,
    scopeSummary: cutBlock(r.scopeSummary, LIMITS.summary) ?? "",
    deliverables: list(r.deliverables, 25),
    exclusions: list(r.exclusions, 25),
    lineItems: lines,
    missingInformation: list(r.missingInformation),
    clarificationQuestions: list(r.clarificationQuestions),
    assumptions: list(r.assumptions),
  });
}
