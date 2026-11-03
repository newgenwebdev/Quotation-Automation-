/**
 * QUINN'S CONNECTION TO OPENAI
 *
 * Uses the OpenAI Responses API with a strict JSON schema, so the answer always has the
 * expected shape. The API key comes from the server environment (OPENAI_API_KEY) and never
 * reaches the browser. `store: false` asks OpenAI not to keep the response.
 *
 * Failures are turned into plain-English messages for staff, with technical detail kept for Admins.
 */
import OpenAI from "openai";
import { DRAFT_JSON_SCHEMA, sanitizeDraft, type AiDraft } from "./draft-schema";
import { QUINN_INSTRUCTIONS } from "./prompt";

export const DEFAULT_MODEL = "gpt-6-luna";

export class QuinnError extends Error {
  constructor(public code: string, message: string, public detail?: string) { super(message); }
}

export interface Drafter {
  readonly model: string;
  draft(input: string): Promise<AiDraft>;
}

export function quinnConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY?.trim();
}

export function quinnModel(): string {
  return process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
}

/** Map OpenAI/network failures to messages a non-technical person can act on. */
export function explainAiError(e: unknown, model: string): QuinnError {
  if (e instanceof QuinnError) return e;
  const err = e as { status?: number; code?: string; message?: string; name?: string };
  const detail = `${err.name ?? "Error"}${err.status ? ` ${err.status}` : ""}${err.code ? ` (${err.code})` : ""}: ${err.message ?? String(e)}`.slice(0, 1000);
  if (err.status === 401) return new QuinnError("AI_AUTH", "OpenAI rejected the API key. An Admin needs to check OPENAI_API_KEY in Dokploy.", detail);
  if (err.status === 403) return new QuinnError("AI_FORBIDDEN", "This OpenAI account isn't allowed to use that model or feature. An Admin needs to check the OpenAI account.", detail);
  if (err.status === 404) return new QuinnError("AI_MODEL", `The AI model "${model}" isn't available on this OpenAI account. An Admin can set OPENAI_MODEL in Dokploy.`, detail);
  if (err.status === 429) {
    return err.code === "insufficient_quota"
      ? new QuinnError("AI_QUOTA", "The OpenAI account has run out of credit. An Admin needs to top it up.", detail)
      : new QuinnError("AI_BUSY", "OpenAI is busy right now. Please try again in a minute.", detail);
  }
  if (err.status === 400) return new QuinnError("AI_REJECTED", "OpenAI couldn't process this request. Try shortening the description; if it keeps happening, tell an Admin.", detail);
  if (err.name === "APIConnectionTimeoutError") return new QuinnError("AI_TIMEOUT", "OpenAI took too long to answer. Please try again.", detail);
  if (err.name === "APIConnectionError") return new QuinnError("AI_NETWORK", "Couldn't reach OpenAI from the server. Please try again shortly.", detail);
  if (typeof err.status === "number" && err.status >= 500) return new QuinnError("AI_DOWN", "OpenAI is having problems right now. Please try again shortly.", detail);
  return new QuinnError("AI_UNKNOWN", "Quinn hit an unexpected problem. Please try again; if it keeps happening, tell an Admin.", detail);
}

export function createOpenAIDrafter(opts: { apiKey: string; model?: string; baseURL?: string }): Drafter {
  const model = opts.model ?? quinnModel();
  // The SDK retries brief network/rate-limit/server errors itself (twice, with back-off).
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL ?? process.env.OPENAI_BASE_URL ?? undefined, timeout: 120_000, maxRetries: 2 });
  return {
    model,
    async draft(input: string): Promise<AiDraft> {
      let response;
      try {
        response = await client.responses.create({
          model,
          instructions: QUINN_INSTRUCTIONS,
          input,
          text: { format: { type: "json_schema", name: "quotation_draft", schema: DRAFT_JSON_SCHEMA as unknown as Record<string, unknown>, strict: true } },
          max_output_tokens: 16000,
          store: false,
        });
      } catch (e) {
        throw explainAiError(e, model);
      }
      if (response.status === "incomplete") {
        throw new QuinnError("AI_INCOMPLETE", "Quinn's answer was cut off. Try a shorter description or split it into smaller quotations.", JSON.stringify(response.incomplete_details ?? {}));
      }
      const refusal = response.output?.flatMap((o) => (o.type === "message" ? o.content : [])).find((c) => c.type === "refusal");
      if (refusal) throw new QuinnError("AI_REFUSED", "Quinn declined to draft this request. Please rephrase the description.", "refusal" in refusal ? String(refusal.refusal) : undefined);
      const text = response.output_text;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new QuinnError("AI_BAD_OUTPUT", "Quinn's answer couldn't be read. Please try again.", text?.slice(0, 1000));
      }
      try {
        return sanitizeDraft(parsed);
      } catch (e) {
        const msg = (e as { issues?: { message: string }[] }).issues?.[0]?.message;
        throw new QuinnError("AI_EMPTY", msg ?? "Quinn's draft was incomplete. Add more detail to the description and try again.", String(e).slice(0, 1000));
      }
    },
  };
}

/** The drafter used by the worker: real OpenAI when configured, otherwise a clear "not set up" error. */
export function defaultDrafter(): Drafter {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    return {
      model: quinnModel(),
      async draft() {
        throw new QuinnError("NOT_CONFIGURED", "Quinn isn't connected to OpenAI yet. An Admin needs to add OPENAI_API_KEY in Dokploy.");
      },
    };
  }
  return createOpenAIDrafter({ apiKey: key });
}
