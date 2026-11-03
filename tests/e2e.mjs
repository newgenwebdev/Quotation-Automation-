/**
 * END-TO-END TEST against a real running server (built app + real PostgreSQL + mock OpenAI).
 * Acts like people using browsers: HTTP requests with cookies, form posts and the editor's JSON save.
 *
 * Usage: BASE=http://127.0.0.1:3200 SETUP_URL=<first admin link from server log> node tests/e2e.mjs
 * For Quinn, run the server with OPENAI_API_KEY=test-key OPENAI_BASE_URL=http://127.0.0.1:4010/v1
 * and start the mock first: npx tsx tests/mock-openai.ts 4010
 * Uses fictional people and TEST prices only.
 */
const BASE = process.env.BASE;
const ORIGIN = new URL(BASE).origin;
let passed = 0, failed = 0;

function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
}

class Browser {
  constructor(name) { this.name = name; this.cookies = new Map(); }
  cookieHeader() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "); }
  store(res) {
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";"); const i = kv.indexOf("=");
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (/Max-Age=0/.test(c) || v === "") this.cookies.delete(k); else this.cookies.set(k, v);
    }
  }
  async get(path) {
    const res = await fetch(BASE + path, { headers: { cookie: this.cookieHeader() }, redirect: "manual" });
    this.store(res);
    const type = res.headers.get("content-type") ?? "";
    const isPdf = type.includes("pdf");
    return { status: res.status, location: res.headers.get("location"), type, disposition: res.headers.get("content-disposition"), html: isPdf ? "" : await res.text(), bytes: isPdf ? await res.arrayBuffer() : null };
  }
  async post(path, fields, { origin = ORIGIN } = {}) {
    const headers = { cookie: this.cookieHeader(), "content-type": "application/x-www-form-urlencoded" };
    if (origin) headers.origin = origin;
    const res = await fetch(BASE + path, { method: "POST", headers, body: new URLSearchParams(fields), redirect: "manual" });
    this.store(res);
    const location = res.headers.get("location");
    const msg = location ? new URL(location, BASE).searchParams : new URLSearchParams();
    return { status: res.status, location, ok: msg.get("ok"), error: msg.get("error") };
  }
  async json(path, body, { origin = ORIGIN } = {}) {
    const headers = { cookie: this.cookieHeader(), "content-type": "application/json" };
    if (origin) headers.origin = origin;
    const res = await fetch(BASE + path, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual" });
    return { status: res.status, data: await res.json().catch(() => null) };
  }
  async follow(r) { return r.location ? this.get(r.location) : null; }
}

const PW = "Test-password-123";
const text = (html) => html.replace(/<!-- -->/g, "").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const pdfText = async (bytes, mode = "-layout") => {
  const { execFileSync } = await import("node:child_process");
  return execFileSync("pdftotext", [mode, "-", "-"], { input: Buffer.from(bytes) }).toString();
};
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function setupAndLogin(b, setupUrl, email) {
  const token = new URL(setupUrl).pathname.split("/").pop();
  const s = await b.post("/api/auth/setup", { token, password: PW, confirm: PW });
  const l = await b.post("/api/auth/login", { email, password: PW });
  return { s, l };
}

// ---------------------------------------------------------------------------
console.log("\n1. Sign-in");
const admin = new Browser("admin");
{
  const r = await admin.get("/quotations");
  check("not signed in → sent to /login", r.status === 307 && r.location?.includes("/login"), `${r.status} ${r.location}`);
  const { l } = await setupAndLogin(admin, process.env.SETUP_URL, "founder@e2e.local");
  check("first admin sets a password and signs in", l.location === "/quotations", JSON.stringify(l));
}

console.log("\n2. Navigation (scenario 17)");
{
  const q = await admin.get("/quotations");
  const t = text(q.html);
  check("Quotations page loads with both main buttons", q.status === 200 && t.includes("Generate with Quinn") && t.includes("Generate manually"));
  check("sidebar has only Quotations and Settings (no Approvals / Price list / Audit log items)", /aria-label="Main"/.test(q.html) && !/href="\/approvals"/.test(q.html) && !/href="\/catalogue"/.test(q.html) && !/href="\/audit"/.test(q.html) && /href="\/settings"/.test(q.html));
  for (const p of ["/quotations/generate", "/quotations/new", "/settings/company", "/settings/price-list", "/settings/price-list/new", "/settings/payment-terms", "/settings/terms", "/settings/users", "/settings/activity"]) {
    const r = await admin.get(p);
    check(`${p} loads`, r.status === 200, String(r.status));
  }
  const s = await admin.get("/settings");
  check("/settings opens Company profile", s.status === 307 && s.location === "/settings/company", `${s.status} ${s.location}`);
  for (const [from, to] of [["/approvals", "/quotations"], ["/catalogue", "/settings/price-list"], ["/policy", "/settings/payment-terms"], ["/terms", "/settings/terms"], ["/users", "/settings/users"], ["/audit", "/settings/activity"]]) {
    const r = await admin.get(from);
    check(`old address ${from} → ${to}`, [307, 308].includes(r.status) && r.location === to, `${r.status} ${r.location}`);
  }
  const nf = await admin.get("/quotations/00000000-0000-4000-8000-000000000000");
  check("unknown quotation → 404", nf.status === 404, String(nf.status));
}

console.log("\n3. Settings");
let webId, hostId, samLink;
{
  const c = await admin.post("/api/company", { name: "NewGen Innovation Sdn. Bhd.", registrationNo: "202201030615 (1476312T)", address: "Seksyen C No. 188, Jalan S2 C9,\nGreen Technology Park Seremban 2,\n70300 Seremban, Negeri Sembilan", phone: "06-000 0000", email: "hello@newgen.test", website: "newgen.test", bankName: "TEST Bank", bankAccountName: "NewGen Innovation Sdn. Bhd.", bankAccountNo: "1234-5678-90" });
  check("company profile saved", !!c.ok, c.error ?? "");
  const bad = await admin.post("/api/company", { name: "X" });
  check("company profile validation (name too short)", !!bad.error, bad.error ?? "");

  const p1 = await admin.post("/api/policy", { milestones: "Deposit | 50\nDevelopment | 40", quoteValidityDays: "30" });
  check("payment terms that don't add up to 100% are refused", p1.error?.includes("100%"), p1.error ?? "");
  const p2 = await admin.post("/api/policy", { milestones: "Deposit | 50\nDevelopment | 40\nLaunch | 10", quoteValidityDays: "30", taxEnabled: "on", taxLabel: "SST", taxRate: "8" });
  check("payment terms saved in one step (no approval)", p2.ok?.includes("saved"), JSON.stringify(p2));

  const t = await admin.post("/api/terms", { name: "Standard (TEST)", body: "1. TEST: a deposit is payable before work starts.\n2. TEST: two revision rounds are included.\n3. TEST: this quotation excludes third-party fees.", isDefault: "on" });
  check("default T&C template saved", !!t.ok, t.error ?? "");

  const w = await admin.post("/api/catalogue", { code: "WEB-TEST", name: "Corporate Website (TEST)", category: "website", pricingModel: "base_plus_units", price: "5000", unitLabel: "page", includedUnits: "5", extraUnitPrice: "500", minQuantity: "1", maxQuantity: "10", validFrom: "2026-01-01" });
  check("price-list service saved and in use immediately", w.ok?.includes("used for new quotations"), JSON.stringify(w));
  webId = w.location?.match(/price-list\/([0-9a-f-]{36})/)?.[1];
  const h = await admin.post("/api/catalogue", { code: "HOST-TEST", name: "Hosting (TEST)", category: "hosting", pricingModel: "per_unit", price: "1500", unitLabel: "year", minQuantity: "1", validFrom: "2026-01-01" });
  hostId = h.location?.match(/price-list\/([0-9a-f-]{36})/)?.[1];
  check("second service saved", !!hostId, JSON.stringify(h));
  const bad2 = await admin.post("/api/catalogue", { code: "BAD-UNIT", name: "Bad unit", category: "other", pricingModel: "per_unit", price: "10", unitLabel: "20", minQuantity: "1", validFrom: "2026-01-01" });
  check("a numeric unit (the '1 20' bug) is refused", bad2.error?.includes("must be a word"), bad2.error ?? "");
  const change = await admin.post("/api/catalogue", { code: "HOST-TEST", name: "Hosting (TEST)", category: "hosting", pricingModel: "per_unit", price: "1800", unitLabel: "year", minQuantity: "1", validFrom: "2026-01-01" });
  check("changing a price creates version 2", change.ok?.includes("version 2"), JSON.stringify(change));

  const u = await admin.post("/api/users", { name: "Sam Sales", email: "sam@e2e.local" });
  const page = await admin.follow(u);
  samLink = page.html.match(/(https?:\/\/[^<"\s]+\/setup\/[A-Za-z0-9_-]+)/)?.[1];
  check("person added (as Admin) with a one-time setup link", !!u.ok && !!samLink, JSON.stringify(u));
  check("users page has no role picker", !/name="role"/.test(page.html));
}

console.log("\n4. Generate manually: save, reopen, calculations, finalise (scenarios 7–11, 13–15)");
const sam = new Browser("sam");
await setupAndLogin(sam, samLink, "sam@e2e.local");
let qid, qnum;
{
  const n = await sam.get("/quotations/new");
  const t = text(n.html);
  const order = ["Quotation information", "Customer information", "Project information", "Scope of work", "Pricing breakdown", "Project timeline", "Payment terms", "Terms and conditions", "Final preview"];
  check("manual editor shows all 9 sections, top to bottom", order.every((s, i) => t.indexOf(s) >= 0 && (i === 0 || t.indexOf(order[i - 1]) < t.indexOf(s))));
  check("defaults from Settings are pre-filled (payment terms, T&C)", n.html.includes("Development") && n.html.includes("TEST: a deposit is payable"));

  const payload = {
    quoteDate: today, validUntil: addDays(today, 30),
    client: { company: "Kedai Contoh Sdn Bhd (TEST)", contactName: "Puan Aminah", email: "aminah@contoh.test", phone: "012-111 2222", address: "No. 1, Jalan Ujian, Seremban" },
    projectTitle: "Online ordering website", overview: "A website where customers order and pay online.",
    objectives: ["Take orders online"], services: ["UI/UX design", "Development"], features: ["Online payment", "Order notifications"],
    technicalRequirements: [], deliverables: ["Website", "Training"], exclusions: ["Photography"], assumptions: ["Client provides menu photos"],
    lines: [
      { catalogueItemId: webId, description: "Corporate Website (TEST)", details: "Includes up to 5 pages", quantity: 1, unitLabel: null, unitPriceSen: 500_000 },
      { description: "Payment gateway integration", quantity: 1, unitPriceSen: null },
    ],
    discount: { type: "amount", value: 20_000, label: "Opening promotion" }, tax: { label: "SST", rateBp: 800 },
    timeline: { duration: "6 weeks", milestones: [{ label: "Design", timing: "Week 1-2" }] },
    payment: { milestones: [{ label: "Deposit", percentBp: 5000 }, { label: "Development", percentBp: 4000 }, { label: "Launch", percentBp: 1000 }], notes: null },
    terms: { templateId: null, sourceVersionId: null, text: "1. TEST clause for this client, long enough to be real terms.", projectTerms: null },
    internalNotes: "E2E-INTERNAL-NOTE",
  };
  const noOrigin = await sam.json("/api/quotations/save", { payload }, { origin: null });
  check("save without our Origin header is refused (CSRF)", noOrigin.status === 403, String(noOrigin.status));
  const anon = await new Browser("anon").json("/api/quotations/save", { payload });
  check("save while signed out is refused", anon.status === 401, String(anon.status));
  const invalid = await sam.json("/api/quotations/save", { payload: { ...payload, client: { company: "" }, lines: [{ description: "x", quantity: 0, unitPriceSen: 1 }] } });
  check("validation errors come back as a readable list (scenario 20)", invalid.status === 422 && invalid.data.issues.some((m) => m.includes("company name")) && invalid.data.issues.some((m) => m.includes("at least 1")), JSON.stringify(invalid.data));

  const s1 = await sam.json("/api/quotations/save", { payload });
  check("unfinished draft saved (one item still needs a price)", s1.status === 200 && s1.data.ok && /^NGQ-\d{4}-\d{4}$/.test(s1.data.number), JSON.stringify(s1.data));
  qid = s1.data.id; qnum = s1.data.number;
  const reopen = await sam.get(`/quotations/${qid}`);
  check("reopening shows the saved content in the editor (scenario 11)", reopen.html.includes("Kedai Contoh Sdn Bhd (TEST)") && reopen.html.includes("Payment gateway integration") && reopen.html.includes("Opening promotion") && reopen.html.includes("E2E-INTERNAL-NOTE"));
  check("the item without a price is flagged 'Price review required'", text(reopen.html).includes("Price review required"));

  const f1 = await sam.json("/api/quotations/save", { id: qid, payload: { ...payload, baseUpdatedAt: s1.data.updatedAt }, finalise: true });
  check("finalising is blocked while an item needs a price (but the draft is saved)", f1.data?.ok && !f1.data.finalised && f1.data.errors.some((e) => e.startsWith("Price review required")), JSON.stringify(f1.data));

  payload.lines[1].unitPriceSen = 250_000;
  const stale = await sam.json("/api/quotations/save", { id: qid, payload: { ...payload, baseUpdatedAt: s1.data.updatedAt } });
  check("saving from an out-of-date page is refused instead of overwriting", stale.status === 409 && stale.data.code === "STALE", JSON.stringify(stale.data));
  const f2 = await sam.json("/api/quotations/save", { id: qid, payload: { ...payload, baseUpdatedAt: f1.data.updatedAt }, finalise: true });
  check("finalised once every item has a price — no Finance approval", f2.data?.finalised === true, JSON.stringify(f2.data));

  const view = await sam.get(`/quotations/${qid}`);
  const vt = text(view.html);
  // 5,000 + 2,500 = 7,500 − 200 = 7,300 + SST 8% 584 = 7,884
  check("finalised view shows status and the server-calculated totals (scenario 9)", vt.includes("Finalised") && vt.includes("RM 7,500.00") && vt.includes("RM 584.00") && vt.includes("RM 7,884.00"), vt.slice(0, 300));
  check("payment milestones reconcile with the total (scenario 10)", vt.includes("RM 3,942.00") && vt.includes("RM 3,153.60") && vt.includes("RM 788.40"));
  check("finalised quotation offers Download PDF, Mark as sent, Edit, Duplicate", ["Download PDF", "Mark as sent", "Edit", "Duplicate"].every((s) => vt.includes(s)));

  const pdf = await sam.get(`/quotations/${qid}/pdf`);
  check("PDF downloads as an attachment named with the number and client (scenario 14)", pdf.type.includes("pdf") && pdf.disposition?.startsWith("attachment") && pdf.disposition.includes(qnum) && pdf.disposition.includes("Kedai-Contoh"), pdf.disposition ?? "");
  const pt = await pdfText(pdf.bytes);
  const raw = await pdfText(pdf.bytes, "-raw");
  check("PDF has company, client, sections, totals, payment and bank details (scenario 15)", ["NewGen Innovation Sdn. Bhd.", "hello@newgen.test", qnum, "Kedai Contoh Sdn Bhd (TEST)", "Scope of Work", "Pricing", "RM 7,884.00", "Opening promotion", "Payment Terms", "TEST Bank", "1234-5678-90", "Terms & Conditions", "Acceptance"].every((s) => pt.includes(s)), pt.slice(0, 400));
  check("PDF has no internal notes, AI wording or watermark", !raw.includes("E2E-INTERNAL-NOTE") && !raw.includes("Quinn") && !raw.includes("DRAFT") && !raw.includes("Price review"));
  const inline = await sam.get(`/quotations/${qid}/pdf?inline=1`);
  check("Preview opens the PDF in the browser", inline.disposition?.startsWith("inline"), inline.disposition ?? "");

  const sent = await sam.post(`/api/quotations/${qid}/mark-sent`, {});
  check("marked as sent", sent.ok === "Marked as sent.", JSON.stringify(sent));
  const rev = await sam.post(`/api/quotations/${qid}/revise`, {});
  const revPage = await sam.follow(rev);
  check("Edit on a sent quotation starts revision 2 as a draft in the editor", rev.ok?.includes("Revision 2") && text(revPage.html).includes("Revision 2") && revPage.html.includes("Final preview"), JSON.stringify(rev));
  const v1 = await sam.get(`/quotations/${qid}?v=1`);
  check("revision 1 is kept read-only as a record", text(v1.html).includes("older revision") && !v1.html.includes("Final preview"));
}

console.log("\n5. Duplicate, cancel, list and search (scenarios 12, 16)");
let newNum;
{
  const d = await admin.post(`/api/quotations/${qid}/duplicate`, {});
  const copyId = d.location?.match(/quotations\/([0-9a-f-]{36})/)?.[1];
  const copy = await admin.follow(d);
  newNum = d.ok?.match(/NGQ-\d{4}-\d{4}/)?.[0];
  check("duplicate opens a new draft with a new number, created by the duplicator", !!copyId && copyId !== qid && !!newNum && newNum !== qnum && text(copy.html).includes("Created by Founder"), JSON.stringify(d));
  const cancel = await admin.post(`/api/quotations/${copyId}/cancel`, { reason: "E2E test" });
  check("cancelled", cancel.ok === "Quotation cancelled.", JSON.stringify(cancel));
  const cpdf = await admin.get(`/quotations/${copyId}/pdf`);
  check("a cancelled quotation's PDF is marked CANCELLED", (await pdfText(cpdf.bytes, "-raw")).includes("CANCELLED") && cpdf.disposition.includes("CANCELLED"));

  const list = text((await admin.get("/quotations")).html);
  check("list shows number, client, project, creator, total, status, last updated", [qnum, newNum, "Kedai Contoh Sdn Bhd (TEST)", "Online ordering website", "Sam Sales", "Founder", "Draft", "Cancelled", "Just now"].every((s) => list.includes(s)), list.slice(0, 500));
  check("no old statuses anywhere", !/Waiting for Finance|Approved|Sent back/.test(list));
  const search = text((await admin.get(`/quotations?q=${encodeURIComponent(qnum)}`)).html);
  check("search by quotation number", search.includes(qnum) && !search.includes(newNum));
  const filt = text((await admin.get("/quotations?status=cancelled")).html);
  check("filter by status", filt.includes(newNum) && !filt.includes(qnum));
  const none = text((await admin.get("/quotations?q=zzzz-no-match")).html);
  check("empty search shows a helpful message", none.includes("No quotations match"));
}

console.log("\n6. Generate with Quinn (scenarios 1, 4, 5, 6)");
{
  const g = await sam.get("/quotations/generate");
  check("Quinn page asks only for the requirements and an optional client company", /name="description"/.test(g.html) && /name="clientCompany"/.test(g.html) && !/name="termsTemplateId"/.test(g.html) && !/name="unitPrice"/.test(g.html));
  const short = await sam.post("/api/quinn/draft", { description: "hi", clientCompany: "" });
  check("too-short text is refused with a clear message", short.error?.includes("at least a sentence"), short.error ?? "");
  const r = await sam.post("/api/quinn/draft", { description: "Hi NewGen, we are Demo Trading Sdn Bhd (TEST). We need a company website with 7 pages and hosting. Also WhatsApp enquiries into Google Sheets. Contact Mr Tan 012-345 6789.", clientCompany: "" });
  check("request accepted → progress page", r.location?.startsWith("/quinn/tasks/"), JSON.stringify(r));
  let page = await sam.get(r.location);
  for (let i = 0; i < 40 && page.status === 200; i++) { await new Promise((res) => setTimeout(res, 500)); page = await sam.get(r.location); }
  check("when Quinn finishes, it goes straight to the quotation editor", page.status === 307 && /^\/quotations\/[0-9a-f-]{36}\?ok=/.test(page.location ?? ""), `${page.status} ${page.location}`);
  const ed = await sam.follow(page);
  const et = text(ed.html);
  check("editor opens with Quinn's content in the real fields", et.includes("Demo Trading Sdn Bhd (TEST)") && ed.html.includes("Corporate website") && ed.html.includes("Responsive design") && ed.html.includes("6-8 weeks"));
  check("approved prices applied from the price list (package + extra pages, hosting at the NEW price)", ed.html.includes("5000.00") && ed.html.includes("500.00") && ed.html.includes("1800.00"));
  check("unknown item flagged, not invented", et.includes("Price review required") && et.includes("WhatsApp enquiry capture"));
  check("Quinn's notes shown (internal) with questions for the client", et.includes("Quinn's notes") && et.includes("Do you already own a domain name?"));
  check("defaults applied automatically: payment terms, SST and the default T&C", ed.html.includes("Development") && ed.html.includes("SST") && ed.html.includes("TEST: a deposit is payable"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
