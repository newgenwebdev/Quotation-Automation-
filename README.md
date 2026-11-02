# NewGen AI Office

Home of **Quinn**, NewGen's AI Quotation Specialist. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Pricing catalogue, commercial policy, pricing engine, roles, audit log | ✅ Built and tested |
| 2 | AI requirements extraction (worker + pg-boss) | Not started |
| 3 | Classification and clarification questions | Not started |
| 4 | Rule-based quotation drafts | Not started |
| 5 | Branded PDF | Not started |
| 6 | Technical and finance approvals, revisions | Not started |
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

Use the `Dockerfile` (or `docker-compose.yml`). Set `DATABASE_URL`. The container applies migrations on start. Health check: `GET /api/health`.
