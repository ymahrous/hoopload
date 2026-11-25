# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, Copilot and others) working in this repository. Humans should read [CONTRIBUTING.md](CONTRIBUTING.md); the design is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Project in one paragraph

Hoopload is a Next.js 15 App Router app (React 19, TypeScript strict), served in production by `server.mjs`. It is a public, account-free service, so every visitor is untrusted; read [SECURITY.md](SECURITY.md) before touching `lib/server/**` or `app/api/**`. You upload a file by shooting it into a basketball hoop: `lib/game/engine.ts` detects a make, and `lib/client/uploadManager.ts` then runs a chunked, resumable, SHA-256-verified, deduplicated upload against route handlers in `app/api/**`. Those handlers delegate to a pure service, `lib/server/uploads.ts`, which uses three ports: the metadata store (Neon Postgres or a JSON file), blob storage (local disk) and the event bus (SSE).

## Commands

```bash
npm install
npm run dev               # http://localhost:3000 (JSON store, no DB needed)
npm run typecheck         # tsc --noEmit (includes tests)
npm test                  # all Vitest projects: unit + integration + component
npm run test:unit         # fast; run after any lib/ change
npm run test:integration  # service + store contract on PGlite + API handlers
npm run test:component    # jsdom + Testing Library
npm run test:coverage     # enforces thresholds (90% lines/functions/statements, 85% branches)
npm run build             # must pass before e2e
npm run test:e2e          # Playwright: e2e, a11y (axe), SEO, perf, desktop + mobile
npm run test:load         # needs a running server: BASE_URL=http://localhost:3000
npm run db:migrate        # applies migrations to DATABASE_URL (Neon)
npm run check:secrets     # secret scan (add -- --bundle after a build to scan client JS)
npm run check:deps        # npm audit (prod) + registry signatures
npm start                 # production: node server.mjs (needs SESSION_SECRET)
npm run check             # everything CI runs, in order
```

With a system Chrome instead of downloaded browsers: `PW_EXECUTABLE_PATH=/usr/bin/google-chrome npm run test:e2e`.

## Where things go

| You are changing… | Edit | And also |
| --- | --- | --- |
| Wire format or limits | `lib/shared/protocol.ts` | Server validation in `lib/server/uploads.ts` and the client in `lib/client/uploadManager.ts`. Public copy updates itself from `lib/site.ts`. |
| Upload rules | `lib/server/uploads.ts` | `tests/integration/upload-service.test.ts` (runs on both stores) |
| SQL or schema | `lib/server/store/postgres.ts`, and a **new** entry in `lib/server/db/migrations.ts` | Mirror the behaviour in `store/json.ts`; extend `store.contract.test.ts` |
| An endpoint | `app/api/**/route.ts` built with **`secureRoute`** (thin), with logic in the service | `tests/integration/api.test.ts`; the enumeration test in `security.test.ts` checks it automatically |
| A rate limit or quota | `lib/server/security/rateLimit.ts` (`POLICIES`, `CONCURRENCY`), `QUOTAS` in `protocol.ts` | A "one test per limit" case in `security.test.ts`, plus the tables in `SECURITY.md` |
| Game feel or physics | `lib/game/engine.ts`; pure math in `lib/game/shot.ts` | `tests/unit/shot.test.ts`, e2e `upload.spec.ts` |
| Public text, FAQ, steps | `lib/site.ts` only | Bump `SITE.updated`. JSON-LD, `llms.txt` and pages follow automatically. |
| Page metadata | Use `pageMetadata()` from `lib/seo/meta.ts` | Never hand-write `openGraph` without `images` |

## Invariants: do not break these

1. **No database query on the chunk PUT hot path.** Sessions come from the LRU. Chunk receipt is the chunk files in storage, never a DB row. The query-budget test in `upload-service.test.ts` fails if you add a round trip anywhere (init 2, chunk 0, complete 2, list ≤ 1).
2. **One round trip per store method.** Put multi-statement work in `db.batch([...])`, which becomes one Neon HTTP request in one transaction.
3. **Never keep the Neon compute awake.**
   - No `LISTEN/NOTIFY` or WebSocket `Pool`.
   - No database polling, no cron, no DB-backed rate limits.
   - No schema queries at startup.
   - `/api/health` must not touch the database unless `?deep=1` is passed.
4. **No file bytes in Postgres.** Metadata only. Store hashes as `bytea`.
5. **Both stores stay behaviourally identical.** A store change is not done until `store.contract.test.ts` passes for both.
6. **Migrations are append-only.** Never edit a shipped migration; add a new `id`. One SQL statement per array entry.
7. **The service stays framework-free.** `lib/server/uploads.ts` must not import from `next/*`. Inject time (`now`) instead of calling `Date.now()` inside store methods.
8. **Downloads stay inert.** Keep `attachment`, `nosniff`, the sandbox CSP and `noindex` on `/api/files/:id`.
9. **Public facts derive from code.** Don't hard-code "4 MB" or "512 MB" in copy; use `FACTS` from `lib/site.ts`.
10. **JSON-LD must match the visible page.** No ratings, reviews or claims the page does not show.
11. **Accessibility is a test gate.** axe must report zero WCAG 2.2 AA violations. Use `--orange-ink` (not `--orange`) for text and buttons. Closed panels use `inert`, not `aria-hidden` over focusable children.
12. **Every API handler uses `secureRoute`.** Mutating verbs set `mutating: true` (CSRF). Only `session`, `files.list` and `health` may use `identity: "optional"`. The enumeration test enforces all three.
13. **Owner scoping is mandatory.** Every store method that touches user data takes `owner` and filters by it in the query. Another owner's resource must look like a missing one (`404`, never `403`). Never dedupe across owners, because that leaks existence.
14. **Never trust client-supplied forwarding headers.** Rate limits key ONLY on `clientIp()`, which reads the header `server.mjs` overwrites from the socket. Don't read `x-forwarded-for` or `x-real-ip` anywhere else. Production starts with `node server.mjs`.
15. **Limits charge address AND owner.** Add new expensive operations to `POLICIES`, using `cost` for byte-based budgets. Long-lived resources (streams, writes) need an `acquire()` concurrency cap.
16. **No secrets in code or the client bundle.** Server-only env vars never get a `NEXT_PUBLIC_` prefix. `check:secrets -- --bundle` must pass. Dummy values in tests or CI carry a `check-secrets: allow` comment.
17. **CSP stays nonce-based.** Don't add `'unsafe-inline'` or `'unsafe-eval'` to `script-src`, and no inline event handlers. Inline JSON-LD (`type="application/ld+json"`) is fine.


## Gotchas already solved (don't reintroduce them)

- **`openGraph` is replaced, not merged**, by child pages. Use `pageMetadata()`, which always sets `images`.
- **`route()` has two overloads.** Handlers without params take `(req)`; those with params take `(req, { params })`. Next's generated route types reject an optional context argument.
- **`server-only`** is aliased to an empty module in `vitest.config.mts`, so tests can import server code.
- **The solver compensates semi-implicit Euler** (`vy - g·dt/2`). If you change the engine's integrator or `STEP`, update `solveShot` and keep the property test at under 2 px.
- **Rim collisions apply only while the ball falls** (`vy > 0`). Otherwise shots from under the hoop fail on narrow phones.
- **`.ball` ref callbacks are memoised per id** in `Court.tsx`. An inline ref would detach balls mid-flight on every render.
- **Neon returns `bigint` as a string.** The store selects `::float8` and maps with `Number()`.
- **Interpolating `U+2028` into a regex literal** breaks the TypeScript parser. Build such patterns with `String.fromCharCode`.
- **Next.js keeps a client's own `X-Forwarded-For`** (`??=`), so it cannot be trusted inside routes. That is why `server.mjs` exists.
- **`\bSECRET` doesn't match `SESSION_SECRET`** (`_` is a word character). The scanner matches `[A-Za-z0-9_]*SECRET`, and a regression test guards it.
- **Under `'strict-dynamic'`, scripts created by trusted code are allowed by design.** XSS tests must inject *markup* (inline handlers), not `createElement("script")`.
- **E2E browsers all come from 127.0.0.1**, so limits are scaled by `RATE_LIMIT_MULTIPLIER` (honoured in production only with `ALLOW_RATE_LIMIT_MULTIPLIER=1`). Tests that drain budgets go in the `abuse` project, which runs last. Strict per-limit assertions live in `security.test.ts`.
- **`networkidle` never settles** on the home page (SSE stays open). Use `load` plus a short wait.

## Testing expectations

- Every behaviour change ships with a test at the lowest layer that can prove it: unit, then integration, then end-to-end.
- Server bugs get a regression test in `upload-service.test.ts`, which runs on both stores automatically.
- Prefer a property-based test (`fast-check`) for parsers, sanitisers and math.
- After UI changes, run `npm run test:e2e`.
- Don't weaken a failing assertion to make it pass. Find out whether the test or the code is wrong, and say which in your summary.

## Definition of done

`npm run check` passes. Docs are updated when you changed an invariant, a command or the architecture: `ARCHITECTURE.md` for design, this file for agent rules.

## Environment

- Node 20.9 or later.
- `SESSION_SECRET` (required in production, at least 32 characters), and optionally `SESSION_SECRET_PREVIOUS`.
- `TRUST_PROXY_HOPS` / `CLIENT_IP_HEADER`: how to find the real client address. See `SECURITY.md`.
- `HEALTH_TOKEN`, `MIN_FREE_BYTES`: optional hardening knobs.
- `DATABASE_URL` (optional): Neon. When unset, the app uses `.data/db.json`.
- `UPLOAD_DIR`: blob storage root.
- `NEXT_PUBLIC_SITE_URL`: canonical origin, read at build time.
- Don't commit `.env*.local`, `.data*` or test artefacts.
