# NewGen AI Office

Home of **Quinn**, NewGen's AI Quotation Specialist. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Pricing catalogue, commercial policy, pricing engine, roles, audit log | ✅ Built and tested |
| 1b | Login, users, price-list / payment-terms / audit screens | ✅ Built and tested |
| 1c | Quotations workspace: Sales builds quotes (price-list + custom lines), Finance approves every quote, branded PDF, revisions | ✅ Built and tested |
| 1d | Per-client terms & conditions: Finance T&C templates, tailored per quotation, reused from the client's earlier approved quotes, frozen on submit, printed on PDF | ✅ Built and tested |
| 2 | AI requirements extraction (worker + pg-boss) | Not started |
| 3 | Classification and clarification questions | Not started |
| 4 | Quinn fills a draft quotation from discovery notes | Not started |
| 5 | ~~Branded PDF~~ | Done in 1c |
| 6 | Technical review step (finance approvals done in 1c) | Not started |
| 7 | Virtual Office integration | Not started |

## Run locally

```bash
cp .env.example .env              # set DATABASE_URL
npm install
npm run db:migrate
npm run seed:drafts               # loads indicative prices as DRAFTS (unusable until approved)
npm run dev
```

## Tests

```bash
TEST_DATABASE_URL=postgres://postgres@localhost:5432/newgen_office_test npm test
```

Uses a real PostgreSQL database. **The test database is wiped on every run**, so never point it at real data.

## Deploy (Dokploy)

Use the `Dockerfile` (or `docker-compose.yml`). The container applies migrations on start. Health check: `GET /api/health`.

Environment variables:

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection |
| `BOOTSTRAP_ADMIN_EMAIL` | first start | Creates the first Admin when there are no users and prints a one-time setup link in the logs |
| `BOOTSTRAP_ADMIN_NAME` | no | Display name for that Admin |
| `APP_URL` | recommended | Public address, used to print a complete setup link |
| `ALLOW_SELF_APPROVAL` | no | `true` lets the drafter of a price approve it (default `false`) |

## End-to-end test

Start a built server against an empty database with `BOOTSTRAP_ADMIN_EMAIL=founder@e2e.local`, then:

```bash
BASE=http://127.0.0.1:3200 SETUP_URL=<link from server log> npm run test:e2e
```
