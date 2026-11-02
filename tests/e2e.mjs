/**
 * END-TO-END TEST against a real running server (built app + real PostgreSQL).
 * Acts like real people using browsers: plain HTTP requests with cookies and form posts.
 *
 * Usage: BASE=http://127.0.0.1:3200 SETUP_URL=<first admin link from server log> node tests/e2e.mjs
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
    return { status: res.status, location: res.headers.get("location"), html: await res.text() };
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
  /** Follow a redirect and return the page. */
  async follow(r) { return r.location ? this.get(r.location) : null; }
}

const PW = "Test-password-123";
const text = (html) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

async function setupAndLogin(b, setupUrl, email) {
  const token = new URL(setupUrl).pathname.split("/").pop();
  const s = await b.post("/api/auth/setup", { token, password: PW, confirm: PW });
  const l = await b.post("/api/auth/login", { email, password: PW });
  return { s, l };
}

async function addUser(admin, name, email, role) {
  const r = await admin.post("/api/users", { name, email, role });
  const page = await admin.follow(r);
  const link = page.html.match(/(https?:\/\/[^<"\s]+\/setup\/[A-Za-z0-9_-]+)/)?.[1];
  return { r, link };
}

console.log("\n1. First admin and login");
const admin = new Browser("admin");
{
  const r = await admin.get("/catalogue");
  check("not logged in → sent to /login", r.status === 307 && r.location?.includes("/login"), `${r.status} ${r.location}`);
  const bad = await admin.post("/api/auth/setup", { token: new URL(process.env.SETUP_URL).pathname.split("/").pop(), password: "short", confirm: "short" });
  check("short password refused on setup", bad.error?.includes("at least"), bad.error);
  const { s, l } = await setupAndLogin(admin, process.env.SETUP_URL, "founder@e2e.local");
  check("admin sets password via setup link", s.ok?.includes("Password saved"), s.error);
  check("admin logs in", l.location === "/catalogue" && admin.cookies.has("ngo_session"), JSON.stringify(l));
  const reuse = await admin.post("/api/auth/setup", { token: new URL(process.env.SETUP_URL).pathname.split("/").pop(), password: PW, confirm: PW });
  check("setup link can't be reused", reuse.error?.includes("invalid, already used or expired"), reuse.error);
  const page = await admin.get("/catalogue");
  check("price list loads, empty state shown", page.status === 200 && text(page.html).includes("No prices yet"));
}

console.log("\n2. Adding the team");
const fin1 = new Browser("fin1"), fin2 = new Browser("fin2"), sales = new Browser("sales"), tech = new Browser("tech");
for (const [b, name, email, role] of [
  [fin1, "Finance One", "fin1@e2e.local", "finance"], [fin2, "Finance Two", "fin2@e2e.local", "finance"],
  [sales, "Sales Person", "sales@e2e.local", "sales"], [tech, "Tech Person", "tech@e2e.local", "technical"],
]) {
  const { r, link } = await addUser(admin, name, email, role);
  check(`${name} added and setup link shown once`, r.ok?.includes("added") && !!link, r.error);
  check(`setup link is not in the redirect URL`, !r.location.includes("setup"));
  const { l } = await setupAndLogin(b, link, email);
  check(`${name} can sign in`, l.location === "/catalogue", JSON.stringify(l));
}
{
  const dup = await admin.post("/api/users", { name: "Dup", email: "SALES@e2e.local", role: "sales" });
  check("duplicate email refused", dup.error?.includes("already exists"), dup.error);
}

console.log("\n3. Who can see what");
{
  check("sales can't open Users page", (await sales.get("/users")).location?.includes("access"));
  check("sales can't open Audit page", (await sales.get("/audit")).location?.includes("access"));
  check("sales can't open Add service page", (await sales.get("/catalogue/new")).location?.includes("access"));
  const nav = text((await sales.get("/catalogue")).html);
  check("sales nav hides Users and Audit", !nav.includes("Users") && !nav.includes("Audit log"));
  const r = await sales.post("/api/catalogue", { code: "HACK", name: "Hack", category: "website", kind: "package", pricingModel: "fixed", price: "1", validFrom: "2026-01-01" });
  check("sales can't create a price by posting directly", r.error?.includes("permission"), r.error);
  const r2 = await sales.post("/api/users", { name: "X", email: "x@e2e.local", role: "admin" });
  check("sales can't add users by posting directly", r2.error?.includes("permission"), r2.error);
}

console.log("\n4. Cross-site form attack (CSRF)");
{
  const evil = await fin1.post("/api/catalogue", { code: "EVIL", name: "Evil", category: "website", kind: "package", pricingModel: "fixed", price: "1", validFrom: "2026-01-01" }, { origin: "https://evil.example" });
  check("post from another website is rejected", evil.status === 403, String(evil.status));
  const none = await fin1.post("/api/catalogue", { code: "EVIL", name: "Evil" }, { origin: null });
  check("post with no origin is rejected", none.status === 403, String(none.status));
}

console.log("\n5. Prices: draft → four-eyes approval");
let webId;
{
  const bad = await fin1.post("/api/catalogue", { code: "WEB-TEST", name: "Test Website", category: "website", kind: "package", pricingModel: "base_plus_units", price: "5,000", unitLabel: "page", includedUnits: "", extraUnitPrice: "", validFrom: "2026-01-01" });
  check("incomplete base+units form gives a clear error", bad.error?.includes("included units"), bad.error);
  const badMoney = await fin1.post("/api/catalogue", { code: "WEB-TEST", name: "Test Website", category: "website", kind: "package", pricingModel: "fixed", price: "5k", validFrom: "2026-01-01" });
  check("bad money format rejected", badMoney.error?.includes("amount like"), badMoney.error);

  const r = await fin1.post("/api/catalogue", {
    code: "web-test", name: "Test Website", category: "website", kind: "package", pricingModel: "base_plus_units",
    price: "5,000.00", unitLabel: "page", includedUnits: "5", extraUnitPrice: "500", minQuantity: "1", maxQuantity: "10",
    revisionLimit: "2", inclusions: "Up to 5 pages\nContact form", exclusions: "Copywriting", validFrom: "2026-01-01",
  });
  check("finance creates draft", r.ok?.includes("WEB-TEST v1"), r.error);
  webId = r.location.split("/catalogue/")[1].split("?")[0];
  check("sales can't see the draft", (await sales.get(`/catalogue/${webId}`)).status === 404);
  check("draft not in sales price list", !text((await sales.get("/catalogue")).html).includes("WEB-TEST"));

  const edit = await fin1.post(`/api/catalogue/${webId}/update`, {
    name: "Test Website", category: "website", kind: "package", pricingModel: "base_plus_units",
    price: "5,200", unitLabel: "page", includedUnits: "5", extraUnitPrice: "500", minQuantity: "1", maxQuantity: "10",
    revisionLimit: "2", inclusions: "Up to 5 pages", exclusions: "Copywriting", validFrom: "2026-01-01",
  });
  check("draft can be edited", edit.ok === "Draft updated.", edit.error);

  const page = text((await fin1.get(`/catalogue/${webId}`)).html);
  check("drafter is told someone else must approve", page.includes("someone else in Finance or Admin must approve"));
  const self = await fin1.post(`/api/catalogue/${webId}/approve`, {});
  check("drafter's own approval is refused by the server", self.error?.includes("cannot approve"), self.error);
  const t = await tech.post(`/api/catalogue/${webId}/approve`, {});
  check("technical can't approve", t.error?.includes("permission"), t.error);
  const ok = await fin2.post(`/api/catalogue/${webId}/approve`, { reason: "E2E check" });
  check("second finance person approves", ok.ok?.includes("approved"), ok.error);
  check("sales now sees it", text((await sales.get("/catalogue")).html).includes("WEB-TEST"));
  const again = await fin1.post(`/api/catalogue/${webId}/update`, { name: "X", category: "website", kind: "package", pricingModel: "fixed", price: "1", validFrom: "2026-01-01" });
  check("approved price can't be edited", again.error?.includes("create a new version"), again.error);
}

console.log("\n6. Payment terms");
{
  const bad = await fin1.post("/api/policy", { milestones: "Deposit | 50\nFinal | 40", quoteValidityDays: "30", validFrom: "2026-01-01" });
  check("milestones not adding to 100% are refused", bad.error?.includes("add up to 90%"), bad.error);
  const r = await fin1.post("/api/policy", { milestones: "Deposit | 50\nOn completion | 50", quoteValidityDays: "30", validFrom: "2026-01-01" });
  check("finance drafts payment terms", r.ok?.includes("Draft v1"), r.error);
  const page = text((await fin2.get("/policy")).html);
  const id = (await fin2.get("/policy")).html.match(/\/api\/policy\/([0-9a-f-]{36})\/approve/)?.[1];
  check("draft visible to other finance user", page.includes("Draft v1") && !!id);
  const ok = await fin2.post(`/api/policy/${id}/approve`, {});
  check("second finance person approves terms", ok.ok?.includes("in force"), ok.error);
}

console.log("\n7. Price checker (the pricing engine through the screen)");
{
  const p1 = text((await sales.get("/price-check?go=1&code0=WEB-TEST&qty0=7")).html);
  check("7 pages = RM 5,200 + 2 × RM 500 = RM 6,200", p1.includes("RM 6,200.00") && p1.includes("Priced."), p1.slice(0, 300));
  const p2 = text((await sales.get("/price-check?go=1&code0=WEB-TEST&qty0=25")).html);
  check("25 pages (over limit) → needs estimate, not a price", p2.includes("need a technical estimate") && p2.includes("C · Custom"));
  const p3 = text((await sales.get("/price-check?go=1&code0=WEB-TEST&qty0=5&discount=10&reason=friend+of+boss")).html);
  check("sales discount refused", p3.includes("Only Finance or Admin can apply discounts"));
  const p4 = text((await fin1.get("/price-check?go=1&code0=WEB-TEST&qty0=5&discount=10&reason=Repeat+client")).html);
  check("finance 10% discount applied (RM 5,200 → RM 4,680)", p4.includes("RM 4,680.00"));
  const p5 = text((await sales.get("/price-check?go=1&code0=WEB-TEST&qty0=5&custom=Sync+orders+to+SAP")).html);
  check("custom request → estimate request", p5.includes("No approved price for") && p5.includes("Sync orders to SAP"));
}

console.log("\n8. Account controls");
{
  const usersHtml = (await admin.get("/users")).html;
  const row = usersHtml.split("<tr>").find((r) => r.includes("sales@e2e.local"));
  const sid = row?.match(/\/api\/users\/([0-9a-f-]{36})\//)?.[1];
  const d = await admin.post(`/api/users/${sid}/deactivate`, {});
  check("admin deactivates sales", d.ok?.includes("deactivated"), d.error);
  const after = await sales.get("/catalogue");
  check("deactivated user is signed out immediately", after.location?.includes("/login"), `${after.status} ${after.location}`);
  const relog = await sales.post("/api/auth/login", { email: "sales@e2e.local", password: PW });
  check("deactivated user can't sign in", relog.error === "Wrong email or password.", relog.error);

  const adminRow = usersHtml.split("<tr>").find((r) => r.includes("founder@e2e.local"));
  const aid = adminRow?.match(/\/api\/users\/([0-9a-f-]{36})\//)?.[1];
  const demote = await admin.post(`/api/users/${aid}/role`, { role: "sales" });
  check("only admin can't demote themselves", demote.error?.includes("only active Admin"), demote.error);

  for (let i = 0; i < 5; i++) await tech.post("/api/auth/login", { email: "tech@e2e.local", password: "wrong-password-x" });
  const locked = await tech.post("/api/auth/login", { email: "tech@e2e.local", password: PW });
  check("5 wrong passwords lock the account", locked.error?.includes("Too many wrong attempts"), locked.error);

  const out = await fin1.post("/api/auth/logout", {});
  check("sign out works", out.location?.startsWith("/login") && (await fin1.get("/catalogue")).location?.includes("/login"));
}

console.log("\n9. Audit log");
{
  const page = text((await fin2.get("/audit")).html);
  for (const a of ["catalogue.draft_created", "catalogue.draft_updated", "catalogue.approved", "policy.approved", "user.created", "user.deactivated", "user.locked"]) {
    check(`audit records ${a}`, page.includes(a));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
