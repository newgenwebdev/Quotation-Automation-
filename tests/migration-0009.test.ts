/**
 * Migration 0009 (redesign) run against data shaped exactly like the old Finance-approval system:
 * every old status, roles, frozen snapshots, unpriced lines. Checks nothing is lost and every
 * change is traceable. Uses its own throw-away database.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const base = new URL(process.env.TEST_DATABASE_URL!);
const dbName = "newgen_office_migtest";
const adminUrl = new URL(base.toString()); adminUrl.pathname = "/postgres";
const testUrl = new URL(base.toString()); testUrl.pathname = `/${dbName}`;
let pool: pg.Pool;
const before = { versions: 0, lines: 0, quotations: 0 };

const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pool.query(text, params)).rows as T[];

/** A copy of ./drizzle containing only migrations 0000–0008 (the system as it was before the redesign). */
function oldMigrationsFolder(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mig-"));
  cpSync("./drizzle", dir, { recursive: true });
  const journalPath = path.join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 8);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

const ids = {
  fin: "00000000-0000-4000-8000-000000000001", sales: "00000000-0000-4000-8000-000000000002",
  tech: "00000000-0000-4000-8000-000000000003", admin: "00000000-0000-4000-8000-000000000004",
};
const qid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const vid = (n: number, v: number) => `20000000-0000-4000-8000-${String(n * 10 + v).padStart(12, "0")}`;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  pool = new pg.Pool({ connectionString: testUrl.toString() });
  await migrate(drizzle(pool), { migrationsFolder: oldMigrationsFolder() });

  // ---------- Data as the old system would have left it ----------
  await q(`INSERT INTO users (id, email, name, role) VALUES
    ($1,'fin@t.local','Fin','finance'), ($2,'sales@t.local','Sally','sales'), ($3,'tech@t.local','Tech','technical'), ($4,'admin@t.local','Admin','admin')`,
  [ids.fin, ids.sales, ids.tech, ids.admin]);
  await q(`INSERT INTO commercial_policies (code, version, currency, payment_milestones, quote_validity_days, tax_enabled, tax_label, tax_rate_bp, valid_from, status, created_by, approved_by, approved_at)
    VALUES ('DEFAULT', 1, 'MYR', '[{"label":"Deposit","percentBp":5000},{"label":"Completion","percentBp":5000}]', 30, true, 'SST', 800, '2026-01-01', 'approved', $1, $2, now())`, [ids.fin, ids.admin]);

  const snapshot = JSON.stringify({ policyId: "x", policyVersion: 1, paymentMilestones: [{ label: "Old deposit", percentBp: 6000 }, { label: "Old balance", percentBp: 4000 }], quoteValidityDays: 30, tax: null, termsText: "Old payment terms wording" });
  const quote = (n: number, status: string, current = 1) =>
    q(`INSERT INTO quotations (id, number, client_company, project_title, owner_id, status, current_version) VALUES ($1, $2, $3, 'Project', $4, $5, $6)`,
      [qid(n), `NGQ-2026-${String(n).padStart(4, "0")}`, `Client ${n}`, ids.sales, status, current]);
  const version = (n: number, v: number, status: string, extra: Record<string, unknown> = {}) => {
    const cols = ["id", "quotation_id", "version", "status", "created_by", ...Object.keys(extra)];
    const vals = [vid(n, v), qid(n), v, status, ids.sales, ...Object.values(extra)];
    return q(`INSERT INTO quotation_versions (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, vals);
  };
  const line = (n: number, v: number, pos: number, unit: number | null, qty = 1) =>
    q(`INSERT INTO quotation_lines (version_id, position, kind, description, quantity, unit_price_sen, line_total_sen) VALUES ($1, $2, 'custom', $3, $4, $5, $6)`,
      [vid(n, v), pos, `Item ${pos}`, qty, unit, unit === null ? null : unit * qty]);

  // Q1 approved by Finance (frozen snapshot, terms only in the snapshot)
  await quote(1, "approved");
  await version(1, 1, "draft");
  await line(1, 1, 1, 100_000); await line(1, 1, 2, 50_000, 2);
  await q(`UPDATE quotation_versions SET status='submitted', submitted_by=$2, submitted_at='2026-10-01T02:00:00Z', subtotal_sen=200000, tax_sen=0, total_sen=200000, policy_snapshot=$3 WHERE id=$1`, [vid(1, 1), ids.sales, snapshot]);
  await q(`UPDATE quotation_versions SET status='approved', decided_by=$2, decided_at='2026-10-02T03:00:00Z', valid_until='2026-11-01' WHERE id=$1`, [vid(1, 1), ids.fin]);
  // Q2 waiting for Finance
  await quote(2, "pending_approval");
  await version(2, 1, "draft"); await line(2, 1, 1, 300_000);
  await q(`UPDATE quotation_versions SET status='submitted', submitted_by=$2, submitted_at=now(), subtotal_sen=300000, tax_sen=0, total_sen=300000, policy_snapshot=$3 WHERE id=$1`, [vid(2, 1), ids.sales, snapshot]);
  // Q3 sent back by Finance (current version rejected)
  await quote(3, "rejected");
  await version(3, 1, "draft"); await line(3, 1, 1, 10_000);
  await q(`UPDATE quotation_versions SET status='submitted', submitted_at=now(), policy_snapshot=$2 WHERE id=$1`, [vid(3, 1), snapshot]);
  await q(`UPDATE quotation_versions SET status='rejected', decided_by=$2, decided_at=now(), decision_note='Too cheap' WHERE id=$1`, [vid(3, 1), ids.fin]);
  // Q4 rejected v1, then revised: v2 is the current draft
  await quote(4, "draft", 2);
  await version(4, 1, "rejected", { decided_by: ids.fin, decided_at: new Date() });
  await version(4, 2, "draft", { confirmed_timeline: "6 weeks" }); await line(4, 2, 1, 20_000);
  // Q5 approved v1, then revised: v2 is the current draft
  await quote(5, "draft", 2);
  await version(5, 1, "approved", { decided_by: ids.fin, decided_at: "2026-09-01T01:00:00Z", valid_until: "2026-10-01", policy_snapshot: snapshot });
  await version(5, 2, "draft");
  // Q6 cancelled while draft; Q7 cancelled after being sent back; Q8 cancelled after approval
  await quote(6, "cancelled"); await version(6, 1, "cancelled");
  await quote(7, "cancelled"); await version(7, 1, "rejected", { decided_by: ids.fin, decided_at: new Date() });
  await quote(8, "cancelled"); await version(8, 1, "approved", { decided_by: ids.fin, decided_at: "2026-08-01T01:00:00Z", valid_until: "2026-08-31" });
  // Q9 plain draft with an unpriced line (Quinn-style), no snapshot
  await quote(9, "draft"); await version(9, 1, "draft");
  await line(9, 1, 1, 100_000); await line(9, 1, 2, 25_000, 2); await line(9, 1, 3, null);

  for (const [k, t] of [["versions", "quotation_versions"], ["lines", "quotation_lines"], ["quotations", "quotations"]] as const) {
    before[k] = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`))[0].n;
  }
  // ---------- Run the redesign migration ----------
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
}, 60_000);

afterAll(async () => { await pool?.end(); });

const statusOf = async (n: number) => (await q<{ status: string }>(`SELECT status FROM quotations WHERE id=$1`, [qid(n)]))[0].status;
const vStatus = async (n: number, v: number) => (await q<{ status: string }>(`SELECT status FROM quotation_versions WHERE id=$1`, [vid(n, v)]))[0].status;

describe("Migration 0009: statuses", () => {
  it("maps every old quotation status to Draft / Finalised / Sent / Cancelled", async () => {
    expect(await statusOf(1)).toBe("finalised");
    expect(await statusOf(2)).toBe("draft");
    expect(await statusOf(3)).toBe("draft");
    expect(await statusOf(4)).toBe("draft");
    expect(await statusOf(5)).toBe("draft");
    for (const n of [6, 7, 8]) expect(await statusOf(n)).toBe("cancelled");
    expect(await statusOf(9)).toBe("draft");
  });

  it("maps version statuses and keeps every version (nothing deleted)", async () => {
    expect(await vStatus(1, 1)).toBe("finalised");
    expect(await vStatus(2, 1)).toBe("draft"); // waiting for Finance → editable again
    expect(await vStatus(3, 1)).toBe("draft"); // sent back → editable again
    expect(await vStatus(4, 1)).toBe("superseded");
    expect(await vStatus(4, 2)).toBe("draft");
    expect(await vStatus(5, 1)).toBe("finalised");
    expect(await vStatus(6, 1)).toBe("cancelled");
    expect(await vStatus(7, 1)).toBe("cancelled");
    expect(await vStatus(8, 1)).toBe("finalised");
    const count = async (t: string) => (await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`))[0].n;
    expect(before).toEqual({ versions: 11, lines: 8, quotations: 9 });
    expect(await count("quotation_versions")).toBe(before.versions);
    expect(await count("quotation_lines")).toBe(before.lines);
    expect(await count("quotations")).toBe(before.quotations);
  });

  it("keeps the Finance decision as history and fills finalised-by", async () => {
    const [v] = await q<Record<string, unknown>>(`SELECT * FROM quotation_versions WHERE id=$1`, [vid(1, 1)]);
    expect(v.finalised_by).toBe(ids.fin);
    expect(v.decided_by).toBe(ids.fin);
    expect(v.quote_date).toBeTruthy();
    expect(v.total_sen).toBe("200000"); // frozen total untouched
    expect(v.terms_text).toBe("Old payment terms wording"); // the PDF keeps printing what was approved
    expect(v.payment_milestones).toEqual([{ label: "Old deposit", percentBp: 6000 }, { label: "Old balance", percentBp: 4000 }]);
    expect(v.tax_rate_bp).toBeNull();
  });

  it("gives drafts the payment terms in force and a running total", async () => {
    const [v] = await q<Record<string, unknown>>(`SELECT * FROM quotation_versions WHERE id=$1`, [vid(9, 1)]);
    expect(v.payment_milestones).toEqual([{ label: "Deposit", percentBp: 5000 }, { label: "Completion", percentBp: 5000 }]);
    expect(v.tax_label).toBe("SST");
    expect(v.subtotal_sen).toBe("150000"); // 1,000 + 2 × 250 (the unpriced line counts as 0)
    expect(v.tax_sen).toBe("12000");
    expect(v.total_sen).toBe("162000");
    const [v4] = await q<Record<string, unknown>>(`SELECT timeline_duration FROM quotation_versions WHERE id=$1`, [vid(4, 2)]);
    expect(v4.timeline_duration).toBe("6 weeks");
  });

  it("writes the old and new status of each changed quotation to the audit log", async () => {
    const rows = await q<{ entity_id: string; before: { status: string }; after: { status: string } }>(
      `SELECT entity_id, before, after FROM audit_log WHERE action='quote.status_migrated' ORDER BY entity_id`);
    const byId = Object.fromEntries(rows.map((r) => [r.entity_id, r]));
    expect(byId[qid(1)].before.status).toBe("approved");
    expect(byId[qid(1)].after.status).toBe("finalised");
    expect(byId[qid(2)].before.status).toBe("pending_approval");
    expect(byId[qid(3)].before.status).toBe("rejected");
    expect(byId[qid(9)]).toBeUndefined(); // unchanged ones aren't logged
  });

  it("also logs every version's old status (older revisions too), so it can be reversed from the log", async () => {
    const rows = await q<{ entity_id: string; before: { status: string; version: number }; after: { status: string } }>(
      `SELECT entity_id, before, after FROM audit_log WHERE action='quote.version_status_migrated'`);
    const byId = Object.fromEntries(rows.map((r) => [r.entity_id, r]));
    expect(byId[vid(4, 1)]).toMatchObject({ before: { status: "rejected", version: 1 }, after: { status: "superseded" } });
    expect(byId[vid(5, 1)]).toMatchObject({ before: { status: "approved" }, after: { status: "finalised" } });
    expect(byId[vid(7, 1)]).toMatchObject({ before: { status: "rejected" }, after: { status: "cancelled" } });
    expect(rows).toHaveLength(7); // Q1, Q2, Q3, Q4v1, Q5v1, Q7, Q8
    for (const r of rows) expect(await vStatus(Number(r.entity_id.slice(-2, -1)), Number(r.entity_id.slice(-1)))).toBe(r.after.status);
  });
});

describe("Migration 0009: roles", () => {
  it("makes every user an Admin and logs each old role", async () => {
    const roles = await q<{ role: string }>(`SELECT role FROM users`);
    expect(roles.every((r) => r.role === "admin")).toBe(true);
    const logged = await q<{ before: { role: string } }>(`SELECT before FROM audit_log WHERE action='user.role_changed' AND actor_label='system:migration'`);
    expect(logged.map((r) => r.before.role).sort()).toEqual(["finance", "sales", "technical"]);
  });
});

describe("Migration 0009: database rules afterwards", () => {
  it("still refuses to change a finalised version", async () => {
    await expect(q(`UPDATE quotation_versions SET scope_summary='changed' WHERE id=$1`, [vid(1, 1)])).rejects.toThrow(/FROZEN_QUOTATION/);
    await expect(q(`UPDATE quotation_lines SET description='x' WHERE version_id=$1`, [vid(1, 1)])).rejects.toThrow(/FROZEN_QUOTATION/);
  });

  it("refuses to finalise with an unpriced line or with no lines", async () => {
    await expect(q(`UPDATE quotation_versions SET status='finalised', finalised_at=now() WHERE id=$1`, [vid(9, 1)])).rejects.toThrow(/UNPRICED_LINES/);
    await expect(q(`UPDATE quotation_versions SET status='finalised', finalised_at=now() WHERE id=$1`, [vid(5, 2)])).rejects.toThrow(/NO_LINES/);
  });

  it("rejects old status values and typed totals that don't match quantity × price", async () => {
    await expect(q(`UPDATE quotations SET status='approved' WHERE id=$1`, [qid(9)])).rejects.toThrow(/quotations_status_check/);
    await expect(q(`UPDATE quotation_lines SET line_total_sen = 1 WHERE version_id=$1 AND unit_price_sen IS NOT NULL`, [vid(9, 1)])).rejects.toThrow(/quotation_line_total_matches/);
  });

  it("removed the old status types and seeded the company profile", async () => {
    const types = await q(`SELECT typname FROM pg_type WHERE typname IN ('quotation_status','quotation_version_status')`);
    expect(types).toHaveLength(0);
    const [c] = await q<{ name: string; registration_no: string }>(`SELECT name, registration_no FROM company_profile`);
    expect(c.name).toBe("NewGen Innovation Sdn. Bhd.");
    expect(c.registration_no).toBe("202201030615 (1476312T)");
  });
});
