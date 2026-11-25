# Contributing to Hoopload

Thanks for helping. This guide covers setup, workflow and what a good pull request looks like. For the design, read [ARCHITECTURE.md](ARCHITECTURE.md). For the rules that keep the free-tier database cheap and the app accessible, see the invariants in [AGENTS.md](AGENTS.md); they apply to humans too.

## Setup

```bash
git clone <your fork>
cd hoopload
npm install
cp .env.example .env.local   # optional; defaults work without a database
npm run dev
```

To run the production build locally: `npm run build && SESSION_SECRET="$(openssl rand -base64 48)" npm start`.

You need Node 20.9 or later. No database is needed for development: without `DATABASE_URL`, metadata goes to `.data/db.json`.

### Using Neon (optional)

1. Create a free project at [neon.com](https://neon.com) and copy its connection string.
2. Put it in `.env.local` as `DATABASE_URL=postgresql://…?sslmode=require`.
3. Run `npm run db:migrate`.
4. Run `npm run dev`. `GET /api/health?deep=1` should report `"store":"postgres"` and `"db":{"ok":true}`.

For work that touches the schema, use a Neon **branch** so you never migrate the main database by accident.

### Playwright browsers

Run `npx playwright install chromium` once. Alternatively, set `PW_EXECUTABLE_PATH` to a local Chrome.

## Workflow

1. Branch from `main`: `feat/…`, `fix/…`, `docs/…`, `test/…`, `perf/…`.
2. Make the change with its tests (see below).
3. Run `npm run check`, which runs exactly what CI runs.
4. Open a PR using the checklist below.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org): `feat(upload): resume across tabs`, `fix(engine): rim clipping on narrow screens`, `perf(store): batch finalize into one round trip`. Keep the subject at 72 characters or fewer, in the imperative.

## Tests

| Change | Minimum test |
| --- | --- |
| Pure function (parser, formatter, math) | Unit test, plus a `fast-check` property if it takes arbitrary input |
| Upload rule or service behaviour | `tests/integration/upload-service.test.ts` (runs on both stores) |
| SQL or schema | `tests/integration/store.contract.test.ts` and `migrations.test.ts` |
| Endpoint, status code or header | `tests/integration/api.test.ts` |
| Component | `tests/component/*.test.tsx` (query by role and label, not by class) |
| User-visible flow | `tests/e2e/*.spec.ts` |
| Styling or layout | `npm run test:e2e`, and include before/after screenshots in the PR |

Coverage thresholds are enforced (90% lines, functions and statements; 85% branches). Browser-only modules (engine, upload manager, worker) are excluded from coverage and covered by Playwright instead.

### Database changes

- Add a **new** migration to `lib/server/db/migrations.ts` with the next `id`. Never edit a shipped one.
- One SQL statement per array entry. Use `IF NOT EXISTS` where possible.
- Keep each store method to one round trip, using `db.batch([...])` for multiple statements. The query-budget test will tell you if you regress.
- Mirror the behaviour in `JsonStore`.

### Copy, SEO and AEO

- Public text lives in `lib/site.ts`. Change it there and bump `SITE.updated`.
- FAQ answers lead with the answer and stay at 60 words or fewer (a test enforces this).
- New pages use `pageMetadata()`, add their JSON-LD through `<JsonLd>`, and are added to `app/sitemap.ts` and `NAV`.

### Accessibility

axe runs on every page at desktop and mobile sizes and must report zero WCAG 2.2 AA violations.
- Use `--orange-ink` for orange text and buttons.
- Give every control a visible label that matches its accessible name.
- Make sure everything is reachable by keyboard.

## Pull request checklist

- [ ] `npm run check` passes locally
- [ ] Tests added or updated at the right layer
- [ ] No new database round trips on hot paths (the query-budget test passes unchanged)
- [ ] Migrations are additive and mirrored in `JsonStore`
- [ ] Public copy changed only in `lib/site.ts`
- [ ] New or changed endpoints use `secureRoute`; user data is owner-scoped (cross-owner tests pass)
- [ ] New expensive operations have a rate limit or quota, with a test, and appear in `SECURITY.md`
- [ ] `npm run check:secrets` passes; no server-only values behind `NEXT_PUBLIC_`
- [ ] Docs updated if an invariant, command or architectural choice changed
- [ ] Screenshots or recordings for UI changes

## Reporting bugs and security issues

Open an issue with steps to reproduce, the expected and actual behaviour, and your browser and OS. **Do not** file security problems publicly; follow [SECURITY.md](SECURITY.md#reporting-a-vulnerability).

## Code of conduct

Be kind, assume good intent, and review the code, not the person.
