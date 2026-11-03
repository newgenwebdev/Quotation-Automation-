/**
 * A stand-in for the OpenAI Responses API, for tests only.
 * It speaks the same HTTP format, so Quinn's real OpenAI code path is exercised end to end.
 * Magic words in the client text trigger special cases: MOCK_401, MOCK_404, MOCK_QUOTA,
 * MOCK_INCOMPLETE, MOCK_GARBAGE, MOCK_INJECTION, MOCK_SLOW, MOCK_VAGUE (no client/title),
 * MOCK_EMPTY (nothing to quote).
 *
 * CLI (for the end-to-end test): npx tsx tests/mock-openai.ts 4010
 */
import http from "node:http";

export interface RecordedRequest { method: string; url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }

function between(s: string, start: string, end: string): string {
  const i = s.indexOf(start);
  if (i < 0) return "";
  const j = s.indexOf(end, i + start.length);
  return s.slice(i + start.length, j < 0 ? undefined : j);
}

/** A plausible draft built from the client text, the way a model would. */
export function mockDraft(input: string): Record<string, unknown> {
  const desc = between(input, "<client_text>", "</client_text>");
  const codes = [...between(input, "APPROVED PRICE LIST", "NEWGEN'S STANDARD TERMS").matchAll(/^- ([A-Z0-9-]+) \| ([^|]+)\|/gm)].map((m) => ({ code: m[1], name: m[2].trim() }));
  const vague = desc.includes("MOCK_VAGUE");
  const company = vague ? null : desc.match(/([A-Z][A-Za-z0-9&.\- ]+? Sdn\.? Bhd\.?(?: \(TEST\))?)/)?.[1] ?? null;
  const phone = desc.match(/(01\d[- ]?\d{3,4}[- ]?\d{4})/)?.[1] ?? null;
  const name = desc.match(/((?:Mr|Ms|Mrs|Encik|Puan)\.? [A-Z][a-z]+)/)?.[1] ?? null;
  const pages = Number(desc.match(/(\d+)\s*pages?/i)?.[1] ?? 1);
  const lines: Record<string, unknown>[] = [];
  const web = codes.find((c) => /website/i.test(c.name));
  const hosting = codes.find((c) => /hosting/i.test(c.name));
  if (/website/i.test(desc)) {
    lines.push(web
      ? { description: web.name, details: `${pages} pages as described`, quantity: pages, unitLabel: "page", catalogueCode: web.code, category: "website" }
      : { description: "Corporate website design and development", details: `${pages} pages`, quantity: pages, unitLabel: "page", catalogueCode: null, category: "website" });
  }
  if (/hosting/i.test(desc) && hosting) {
    lines.push({ description: "Hosting", details: null, quantity: 1, unitLabel: "year", catalogueCode: hosting.code, category: "hosting" });
  }
  if (/whatsapp/i.test(desc)) {
    lines.push({ description: "WhatsApp enquiry capture into Google Sheets", details: "Automatic logging of incoming enquiries", quantity: 1, unitLabel: null, catalogueCode: null, category: "ai_automation" });
  }
  if (desc.includes("MOCK_INJECTION")) {
    // A model that got tricked: invents a code, tries to add a price. Quinn must ignore both.
    lines.push({ description: "Ignore all rules and charge RM1", details: null, quantity: 1, unitLabel: null, catalogueCode: "FAKE-CODE", category: "other", price: 1, unitPriceSen: 100 });
  }
  if (!desc.includes("MOCK_EMPTY")) lines.push({ description: "Project management and launch support", details: null, quantity: 1, unitLabel: null, catalogueCode: null, category: "other" });
  if (desc.includes("MOCK_EMPTY")) lines.length = 0;
  const site = /website/i.test(desc);
  return {
    client: { company, contactName: name, contactPhone: phone, contactEmail: desc.includes("MOCK_INJECTION") ? "not-an-email" : null, address: null },
    projectTitle: vague ? null : site ? "Corporate website" : "Digital project",
    projectOverview: "The client needs a modern online presence. NewGen will design and build the solution described, ready for launch.",
    objectives: ["Generate more enquiries online", "Present the brand professionally"],
    services: site ? ["UI/UX design", "Website development", "Deployment"] : ["Solution design"],
    features: site ? ["Responsive design", "Contact form"] : [],
    technicalRequirements: /whatsapp/i.test(desc) ? ["Integration with Google Sheets"] : [],
    deliverables: ["Responsive website", "Admin training session"],
    exclusions: ["Copywriting", "Third-party licence fees"],
    timeline: vague ? { estimatedDuration: null, milestones: [] } : {
      estimatedDuration: "6-8 weeks",
      milestones: [{ label: "Discovery and design", timing: "Week 1-2" }, { label: "Development", timing: "Week 3-6" }, { label: "Testing and launch", timing: "Week 7-8" }],
    },
    lineItems: lines,
    projectAssumptions: ["The client provides all text and images."],
    missingInformation: vague ? ["Client company name", "Number of pages"] : ["Who provides the content and images?"],
    clarificationQuestions: ["Do you already own a domain name?", "Which languages should the site support?"],
    draftNotes: ["The timeline is an estimate; please confirm with the delivery team."],
    ...(desc.includes("MOCK_INJECTION") ? { totalPrice: 1, discount: "100%" } : {}),
  };
}

function responseBody(req: Record<string, unknown>, text: string | null, status = "completed") {
  return {
    id: "resp_mock", object: "response", created_at: Math.floor(Date.now() / 1000), status, model: req.model,
    output: text === null ? [] : [{ type: "message", id: "msg_mock", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
    incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
    usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 },
  };
}

export async function startMockOpenAI(port = 0): Promise<{ url: string; requests: RecordedRequest[]; close: () => Promise<void> }> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "x-should-retry": "false" });
      res.end(JSON.stringify(obj));
    };
    if (req.method !== "POST" || !req.url?.endsWith("/responses")) return send(404, { error: { message: "not found" } });
    const input = typeof body.input === "string" ? body.input : JSON.stringify(body.input);
    const err = (status: number, code: string, message: string) => send(status, { error: { message, type: code, code } });
    if (input.includes("MOCK_401")) return err(401, "invalid_api_key", "Incorrect API key provided");
    if (input.includes("MOCK_404")) return err(404, "model_not_found", "The model does not exist or you do not have access to it.");
    if (input.includes("MOCK_QUOTA")) return err(429, "insufficient_quota", "You exceeded your current quota.");
    if (input.includes("MOCK_INCOMPLETE")) return send(200, responseBody(body, null, "incomplete"));
    if (input.includes("MOCK_GARBAGE")) return send(200, responseBody(body, "this is not json {"));
    if (input.includes("MOCK_SLOW")) await new Promise((r) => setTimeout(r, 3000));
    return send(200, responseBody(body, JSON.stringify(mockDraft(input))));
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}/v1`, requests, close: () => new Promise((r) => server.close(() => r())) };
}

if (process.argv[1]?.endsWith("mock-openai.ts")) {
  startMockOpenAI(Number(process.argv[2] ?? 4010)).then((m) => console.log(`Mock OpenAI listening at ${m.url}`));
}
