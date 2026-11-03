# NewGen AI Office

Home of **Quinn**, NewGen's AI quotation assistant. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Paste client requirements → Quinn writes and prices the quotation → review and edit → export PDF → send to the client.**
Or: **Generate manually → fill in one structured form → preview → export PDF.**

## What's in it

| Area | What it does |
|---|---|
| Quotations | History with search and status filter (Draft / Finalised / Sent / Cancelled), Generate with Quinn, Generate manually, edit, duplicate, preview, export PDF, mark as sent, cancel |
| Editor | One page, nine sections: quotation info, customer, project, scope, pricing (discount, tax), timeline, payment terms, T&C, final preview. Live totals; Save draft / Preview / Finalise |
| Quinn | Reads WhatsApp chats, emails or notes (up to 60,000 characters), fills every section, applies approved prices from the price list, marks anything else "Price review required", applies the default payment terms, tax, validity and T&C |
| Settings | Company profile, Price list, Payment terms, T&C templates, Users, Activity log |
| PDF | Branded client quotation; drafts watermarked DRAFT; no internal notes |

## Run locally

```bash
cp .env.example .env              # set DATABASE_URL (and OPENAI_API_KEY for Quinn)
npm install
npm run db:migrate
npm run seed:drafts               # optional: indicative prices as drafts ("Not in use yet")
npm run dev
```

## Tests

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/newgen_office_test npm test
```

Uses a real PostgreSQL database. **The test database is wiped on every run**, so never point it at real data.

End-to-end (built app, fresh database, mock OpenAI):

```bash
npx tsx tests/mock-openai.ts 4010 &
DATABASE_URL=… BOOTSTRAP_ADMIN_EMAIL=founder@e2e.local OPENAI_API_KEY=test-key OPENAI_BASE_URL=http://127.0.0.1:4010/v1 npm start -- -p 3200
BASE=http://127.0.0.1:3200 SETUP_URL=<link from server log> npm run test:e2e
```

## Deploy (Dokploy)

Push to `main`; Dokploy builds the `Dockerfile`. The container applies database migrations on start, then starts the app and Quinn's worker. Health check: `GET /api/health`.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection |
| `OPENAI_API_KEY` | for Quinn | OpenAI key (server-side only) |
| `OPENAI_MODEL` | no | Model Quinn uses (default `gpt-6-luna`) |
| `BOOTSTRAP_ADMIN_EMAIL` | first start | Creates the first Admin when there are no users and prints a one-time setup link in the logs |
| `BOOTSTRAP_ADMIN_NAME` | no | Display name for that Admin |
| `APP_URL` | recommended | Public address, used to print a complete setup link |
| `QUINN_WORKER` | no | `off` to run Quinn's worker somewhere else |
