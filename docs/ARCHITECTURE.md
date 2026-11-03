# Quinn — Architecture

## The one rule everything is built around

**The AI reads and writes words. Plain code handles money.**

| Job | Who does it | Why |
|---|---|---|
| Read WhatsApp chats, emails and notes; write the client-facing content; pick which price-list item applies and the quantity; flag what's missing | Quinn (OpenAI, `src/quinn/`) | Language work is what AI is good at |
| Decide which prices exist | NewGen staff, in Settings → Price list | Commercial authority |
| Apply prices and calculate every ringgit (lines, discount, tax, total, payment milestones) | `src/quotations/calc.ts` (same code in the browser and on the server) | Must be exact and repeatable |

Quinn's answer format has **no price fields at all**. A line gets a price only from the price list, through the item Quinn named; anything else is saved as **Price review required**, and the quotation can't be finalised until a person enters the price (checked in code and by a database trigger).

## Workflow

```
Generate with Quinn ─┐
                     ├─► the same editor (draft) ──finalise──► finalised ──mark as sent──► sent
Generate manually ───┘          ▲                                  │                         │
                                └──────── Edit (new revision) ◄────┴─────────────────────────┘
Any open quotation ──cancel──► cancelled          Duplicate: a new quotation from any existing one
```

- One role for now (**Admin**): every team member can create, edit, finalise and export. Each quotation records who created it.
- No approval step. Finalising checks: client and title filled in, at least one item, every item priced, payment terms add up to 100%, validity date set. Suspicious values (prices of RM 10 or less, very short T&C, validity under a week, a date in the past) are shown as warnings first.
- A finalised version is frozen by the database. "Edit" starts a new draft revision; the finalised one stays as a record.

## Components

```
 Browser ── Next.js pages + the editor (client component, live totals)
    │
    ▼
 Next.js server ──► services: quotations, price list / payment terms, T&C, company profile, users
    │                    │
    │                    ▼
    │              PostgreSQL ◄── pg-boss job queue (same database)
    ▼                    ▲
 Quinn worker (in the app container) ── OpenAI Responses API (strict JSON schema)
```

## Tables

- `users` — everyone is `admin` (the old role values stay in the type for history).
- `company_profile` — NewGen's details printed on the PDF (one row).
- `catalogue_items` — versioned price list. Saving creates a new version in use immediately; old versions are frozen.
- `commercial_policies` — default payment milestones, validity days and tax (versioned the same way).
- `terms_templates` — standard T&C; the default one is applied to new quotations.
- `quotations` — number, client, creator, status (draft / finalised / sent / cancelled).
- `quotation_versions` — every section of a quotation and its totals; frozen once finalised.
- `quotation_lines` — the pricing table; amount = quantity × unit price (enforced by the database).
- `agent_tasks` / `agent_events` — Quinn's requests and their step-by-step trail.
- `audit_log` — append-only history of every change.

## Key decisions

- **Money in sen (integers)**, percentages in basis points, half-up rounding. Tax is charged on the subtotal after discount. The last payment milestone absorbs rounding so milestones always add up to the total.
- **One editor, one data model, one PDF** for both ways of creating a quotation (`saveDraft()` in `src/quotations/service.ts`).
- **Nothing is made up.** Payment terms, tax and T&C come only from Settings; if Settings is empty those sections start empty. The PDF prints only what's on the quotation.
- **Two people editing**: a save from a page opened before someone else's save is refused (no silent overwrite).
- **Migration 0009** moved the old Finance-approval data to the new statuses without deleting anything, logging every change in the audit log.
