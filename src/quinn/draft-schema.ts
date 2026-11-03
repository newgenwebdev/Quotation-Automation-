/**
 * THE SHAPE OF QUINN'S ANSWER
 *
 * OpenAI is forced ("strict" mode) to answer in exactly this JSON shape. It covers every section
 * of the quotation EXCEPT money: there are no price, amount or discount fields. Quinn picks which
 * price-list item applies (catalogueCode) and the quantity; NewGen's own code then applies the
 * approved price. Anything without a matching price-list item becomes "Price review required".
 * So Quinn can complete the quotation, but structurally cannot invent a price.
 *
 * The answer is still treated as untrusted: it's cleaned and bounded below before use.
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
  required: [
    "client", "projectTitle", "projectOverview", "objectives", "services", "features", "technicalRequirements",
    "deliverables", "exclusions", "timeline", "lineItems", "projectAssumptions", "missingInformation",
    "clarificationQuestions", "draftNotes",
  ],
  properties: {
    client: {
      type: "object",
      additionalProperties: false,
      required: ["company", "contactName", "contactPhone", "contactEmail", "address"],
      properties: {
        company: nullableString("Client company name, only if stated"),
        contactName: nullableString("Contact person, only if stated"),
        contactPhone: nullableString("Contact phone, only if stated"),
        contactEmail: nullableString("Contact email, only if stated"),
        address: nullableString("Client company address, only if stated"),
      },
    },
    projectTitle: { type: "string", description: "Short client-facing project title (max 80 characters)" },
    projectOverview: { type: "string", description: "2-5 sentence client-facing overview: the client's situation, what will be built and why" },
    objectives: stringList("The client's business goals for this project (outcomes, not features)"),
    services: stringList("Services NewGen will provide, e.g. UI/UX design, web development, CMS setup, deployment"),
    features: stringList("Features and functionalities of the solution"),
    technicalRequirements: stringList("Technical requirements or constraints: platforms, integrations, hosting, languages, devices"),
    deliverables: stringList("Concrete things the client will receive"),
    exclusions: stringList("Relevant things NOT included that the client might assume are"),
    timeline: {
      type: "object",
      additionalProperties: false,
      required: ["estimatedDuration", "milestones"],
      properties: {
        estimatedDuration: nullableString("Estimated total duration such as \"6-8 weeks\", or null if the scope is too unclear. Never a calendar date."),
        milestones: {
          type: "array",
          description: "Delivery phases in order with relative timing (\"Week 1-2\"). Empty if no estimate.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "timing"],
            properties: {
              label: { type: "string", description: "Phase, e.g. Discovery & UI/UX design" },
              timing: { type: "string", description: "Relative timing, e.g. Week 1-2" },
            },
          },
        },
      },
    },
    lineItems: {
      type: "array",
      description: "The pricing table: separately priceable pieces of work, without prices",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "details", "quantity", "unitLabel", "catalogueCode", "category"],
        properties: {
          description: { type: "string", description: "Client-facing item name" },
          details: nullableString("Optional client-facing detail, e.g. which pages or features"),
          quantity: { type: "integer", description: "Number of units; 1 for a one-off item" },
          unitLabel: nullableString("Unit for the quantity (page, screen, month, user...); null for a one-off item"),
          catalogueCode: nullableString("Code of the approved price-list item that applies, or null if none clearly applies"),
          category: { type: "string", enum: [...SERVICE_CATEGORIES] },
        },
      },
    },
    projectAssumptions: stringList("Client-facing assumptions this quotation relies on, e.g. client supplies all text and images"),
    missingInformation: stringList("Facts NewGen still needs to confirm scope or price"),
    clarificationQuestions: stringList("Specific, polite questions to ask the client"),
    draftNotes: stringList("Internal notes for NewGen staff: anything you guessed, estimated or were unsure about"),
  },
} as const;

// ---------- Cleaning and checking the answer ----------

const LIMITS = { title: 120, overview: 4000, item: 200, details: 500, listItem: 400, list: 25, lines: 40, maxQty: 10000 };

const cut = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s === "" ? null : s.slice(0, max);
};
const cutBlock = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s === "" ? null : s.slice(0, max);
};
const list = (v: unknown, maxItems = LIMITS.list): string[] =>
  [...new Set((Array.isArray(v) ? v : []).map((x) => cut(x, LIMITS.listItem)).filter((x): x is string => !!x))].slice(0, maxItems);

const Category = z.enum(SERVICE_CATEGORIES);

export const AiDraft = z.object({
  client: z.object({
    company: z.string().nullable(), contactName: z.string().nullable(), contactPhone: z.string().nullable(),
    contactEmail: z.string().nullable(), address: z.string().nullable(),
  }),
  projectTitle: z.string().nullable(),
  projectOverview: z.string().nullable(),
  objectives: z.array(z.string()),
  services: z.array(z.string()),
  features: z.array(z.string()),
  technicalRequirements: z.array(z.string()),
  deliverables: z.array(z.string()),
  exclusions: z.array(z.string()),
  timeline: z.object({
    estimatedDuration: z.string().nullable(),
    milestones: z.array(z.object({ label: z.string(), timing: z.string() })),
  }),
  lineItems: z.array(z.object({
    description: z.string().min(3),
    details: z.string().nullable(),
    quantity: z.number().int().min(1).max(LIMITS.maxQty),
    unitLabel: z.string().nullable(),
    catalogueCode: z.string().nullable(),
    category: Category,
  })).min(1, "Quinn couldn't find anything to quote in the description. Add what the client needs and try again."),
  projectAssumptions: z.array(z.string()),
  missingInformation: z.array(z.string()),
  clarificationQuestions: z.array(z.string()),
  draftNotes: z.array(z.string()),
});
export type AiDraft = z.infer<typeof AiDraft>;

/**
 * Turn whatever came back into a safe, bounded draft. Unknown fields (e.g. a sneaked-in "price")
 * are dropped, text is trimmed to sensible lengths, odd quantities fall back to 1, units that
 * aren't words are dropped, and an email that doesn't look like an email is discarded.
 */
export function sanitizeDraft(raw: unknown): AiDraft {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const c = (r.client && typeof r.client === "object" ? r.client : {}) as Record<string, unknown>;
  const t = (r.timeline && typeof r.timeline === "object" ? r.timeline : {}) as Record<string, unknown>;
  const email = cut(c.contactEmail, 200);
  const lines = (Array.isArray(r.lineItems) ? r.lineItems : []).slice(0, LIMITS.lines).map((li) => {
    const l = (li && typeof li === "object" ? li : {}) as Record<string, unknown>;
    const q = typeof l.quantity === "number" && Number.isInteger(l.quantity) && l.quantity >= 1 && l.quantity <= LIMITS.maxQty ? l.quantity : 1;
    const unit = cut(l.unitLabel, 20);
    const category = Category.safeParse(l.category);
    return {
      description: cut(l.description, LIMITS.item) ?? "",
      details: cut(l.details, LIMITS.details),
      quantity: q,
      unitLabel: unit && /[a-z]/i.test(unit) && !(q === 1 && /^(item|unit|lot|package|project|job)s?$/i.test(unit)) ? unit : null,
      catalogueCode: cut(l.catalogueCode, 60)?.toUpperCase() ?? null,
      category: category.success ? category.data : "other" as const,
    };
  }).filter((l) => l.description.length >= 3);
  const milestones = (Array.isArray(t.milestones) ? t.milestones : []).slice(0, 15).map((m) => {
    const x = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
    return { label: cut(x.label, 200) ?? "", timing: cut(x.timing, 100) ?? "" };
  }).filter((m) => m.label);

  return AiDraft.parse({
    client: {
      company: cut(c.company, 200),
      contactName: cut(c.contactName, 120),
      contactPhone: cut(c.contactPhone, 40),
      contactEmail: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
      address: cutBlock(c.address, 500),
    },
    projectTitle: cut(r.projectTitle, LIMITS.title),
    projectOverview: cutBlock(r.projectOverview, LIMITS.overview),
    objectives: list(r.objectives),
    services: list(r.services),
    features: list(r.features, 40),
    technicalRequirements: list(r.technicalRequirements),
    deliverables: list(r.deliverables),
    exclusions: list(r.exclusions),
    timeline: { estimatedDuration: cut(t.estimatedDuration, 100), milestones },
    lineItems: lines,
    projectAssumptions: list(r.projectAssumptions),
    missingInformation: list(r.missingInformation),
    clarificationQuestions: list(r.clarificationQuestions),
    draftNotes: list(r.draftNotes),
  });
}
