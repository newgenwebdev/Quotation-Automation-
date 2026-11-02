# Quinn — Architecture

## The one rule everything is built around

**The AI reads and writes words. Plain code handles money and permissions.**

| Job | Who does it | Why |
|---|---|---|
| Read messy discovery notes, extract requirements, suggest questions, suggest matching catalogue codes, write scope text | Quinn (AI) | Language work is what AI is good at |
| Decide which prices exist and their terms | Finance (humans) | Commercial authority |
| Calculate every ringgit on a quote | Pricing engine (`src/pricing/engine.ts`) | Must be exact, repeatable and auditable |
| Decide who may approve, discount or release | Permission rules + workflow (code) | Can't be talked out of it by a cleverly written client note |

If Quinn suggests a catalogue code that doesn't exist, isn't approved or is expired, the pricing engine simply refuses it.

## Components

```
 Browser (Next.js pages, 3D office)
        │
        ▼
 Next.js server ──► Services (catalogue, pricing, quotations, approvals)
        │                     │
        │                     ▼
        │              PostgreSQL ◄── pg-boss job queue (lives in the same DB)
        │                     ▲
        ▼                     │
 Worker process ── runs Quinn's jobs: AI extraction, drafting, PDF ──► AI API (Anthropic/OpenAI)
```

- **One database** holds data, the audit log *and* the job queue (pg-boss). Less to run and back up.
- **The worker** runs separately so slow AI calls never freeze the website.
- **Quinn's on-screen state** (Idle, Analysing, Drafting, Waiting, Completed, Failed) is read from real job records, never from timers.

## Phase 1 tables (built)

- `users`: role is one of sales / technical / finance / admin.
- `catalogue_items`: versioned price list. Draft → approved → retired. Approved rows are frozen by a DB trigger.
- `commercial_policies`: payment milestones (must total 100%), quote validity days, optional tax.
- `audit_log`: append-only. The DB rejects updates and deletes.

## Planned tables (later phases)

| Table | Purpose | Phase |
|---|---|---|
| `quotations` | One per client opportunity: number, client, status, project class (A/B/C), owner | 2 |
| `quotation_versions` | Snapshot per revision: extracted requirements, pricing result, policy version, PDF location | 2–5 |
| `quotation_lines` | Priced lines, recording the exact catalogue version used | 4 |
| `clarification_questions` | Questions Quinn raised, answers received | 3 |
| `estimate_requests` | Custom work sent to Technical; Finance turns the estimate into an approved one-off price | 6 |
| `approvals` | Technical and Finance decisions with reason, actor and time | 6 |
| `agent_tasks` / `agent_events` | What Quinn is doing right now, and what happened (drives the 3D office) | 2, 7 |
| `notifications` | "Action needed" messages to internal users | 6 |

## Quotation workflow (Phase 6, enforced in code)

```
new_request → scope_analysis → [clarification] → [technical_review] → draft_preparation
           → finance_approval → approved → delivered
Any active state → cancelled.   finance_approval → rejected → (revise) → draft_preparation.
approved/delivered → revision (new version) → scope_analysis.
```

Each transition lists which roles may trigger it. Finance approval cannot be skipped, and only an approved version can produce an external PDF.

## Key decisions

- **Money in sen (integers).** RM 5,899.00 is stored as `589900`. This avoids decimal rounding bugs.
- **Structured pricing formulas, not free text.** Three models (fixed, per unit, base + extra units) cover current services. Free-text formulas would be a security risk.
- **Four-eyes approval.** The drafter can't approve their own price. It can be relaxed with `ALLOW_SELF_APPROVAL=true` if one person runs finance.
- **One approved version per service.** Approving v2 retires v1 immediately. Scheduled future prices aren't supported yet.
- **"From" prices are not prices.** "Mobile app from RM55,000" is treated as custom (Class C) work needing an estimate.
