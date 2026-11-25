# Hoopload 🏀

**Upload files by shooting hoops.** Pull a file back like a slingshot, follow the dotted arc, and sink it. The make starts a real upload: chunked, resumable, SHA-256-verified and deduplicated. It is built on Next.js as a full-stack framework, with Neon Postgres tuned for the free tier.

```bash
npm install
npm run dev    # http://localhost:3000 — no database required

# production
npm run build
SESSION_SECRET="$(openssl rand -base64 48)" npm start   # node server.mjs
```

## How to play

| Action | Result |
| --- | --- |
| Click the hoop card, paste (⌘/Ctrl+V), or drop files on the court | Files land on the floor |
| Press, pull back, release | Slingshot shot with a live trajectory preview |
| Tap a file, or focus it and press Enter | Assisted shot that always goes in |
| Drop files directly on the hoop | Dunk, which uploads immediately |
| **Shoot all** | Fires every waiting file |
| **Locker** | Server file list, live across tabs; download or delete |

## Highlights

- **Upload pipeline**
  - 4 MiB chunks hashed in a Web Worker, with up to 2 files × 3 chunks in parallel.
  - Exponential backoff with jitter on failures.
  - Resume within 24 hours.
  - Content-addressed deduplication with reference-counted deletes.
  - Magic-byte type detection that blocks executables.
- **Neon free tier, used efficiently**
  - HTTP driver with no held connections, so the compute scales to zero.
  - **0 database queries per chunk**, 4 per new upload.
  - Batched transactions and `bytea` hashes; no file bytes in Postgres.
  - Live updates without `LISTEN/NOTIFY`, and lazy GC with no cron.
  - Details: [ARCHITECTURE.md › Database](ARCHITECTURE.md#database-neon-free-tier).
- **SEO, AEO and GEO**
  - Metadata API, sitemap, robots (with AI crawlers explicitly allowed), web manifest and a generated Open Graph image.
  - JSON-LD for `WebApplication`, `HowTo`, `FAQPage` (with `speakable`), `TechArticle` and `BreadcrumbList`.
  - Answer-first FAQ, plus `llms.txt` and `llms-full.txt`.
- **Security**
  - Files are private to the browser that uploaded them, via a signed HttpOnly identity cookie. Every query is owner-scoped, and other people's files return 404.
  - CSRF checks, a nonce-based CSP, HSTS and sandboxed downloads.
  - Strict layered rate limits (per address and per identity), byte quotas, storage quotas and concurrency caps.
  - A spoof-proof client address (`server.mjs`) and socket timeouts.
  - Default-deny row-level security on every table.
  - Secret scanning (including the client bundle), `npm audit`, and gitleaks in CI. See [SECURITY.md](SECURITY.md).
- **Tested at every layer**
  - Unit, property-based, store contract (real Postgres via PGlite), integration, API contract and component tests.
  - End-to-end, axe accessibility (WCAG 2.2 AA), SEO, Core Web Vitals, visual regression and load tests with SLO gates.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SESSION_SECRET` | *(required in production)* | Signs the identity cookie (at least 32 random characters) |
| `TRUST_PROXY_HOPS` / `CLIENT_IP_HEADER` | `0` / *(unset)* | How the real client address is found behind proxies (see SECURITY.md) |
| `HEALTH_TOKEN` | *(unset)* | Bearer token for detailed or deep health checks |
| `DATABASE_URL` | *(unset)* | Neon connection string. When unset, a local JSON store is used. |
| `UPLOAD_DIR` | `./.data` | Blob storage root and JSON store location |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` | Canonical origin for SEO (read at build time) |

Using Neon: set `DATABASE_URL`, run `npm run db:migrate`, then start the app. See [CONTRIBUTING.md](CONTRIBUTING.md#using-neon-optional).

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` / `build` | Next.js |
| `npm start` | Production server (`node server.mjs`) |
| `npm run check:secrets` / `check:deps` | Secret scan / dependency audit |
| `npm run typecheck` | TypeScript, including tests |
| `npm test` | Unit, integration and component tests (Vitest) |
| `npm run test:coverage` | The same, with enforced coverage thresholds |
| `npm run test:e2e` | Playwright end-to-end, accessibility, SEO and performance on desktop and mobile (run `build` first) |
| `npm run test:visual` | Screenshot regression |
| `npm run test:load` | Load test with SLO gates (`BASE_URL=…`) |
| `npm run db:migrate` | Apply migrations to `DATABASE_URL` |
| `npm run check` | Everything CI runs |

## API

| Method and path | Purpose |
| --- | --- |
| `POST /api/uploads` | Start, resume or dedupe an upload |
| `PUT /api/uploads/:id/chunks/:index` | Send one chunk (raw bytes, idempotent) |
| `POST /api/uploads/:id/complete` | Assemble and publish (idempotent) |
| `GET` / `DELETE /api/uploads/:id` | Session status / abort |
| `GET /api/files?limit&cursor` | Your files, newest first, keyset-paginated |
| `GET` / `DELETE /api/files/:id` | Download (Range, ETag) / delete |
| `GET /api/events` | Server-Sent Events: `file.created`, `file.deleted` |
| `GET /api/session` | Issues the anonymous identity cookie (rate-limited) |
| `GET /api/health[?deep=1]` | Public `{ok:true}`; details and a database ping need `HEALTH_TOKEN` |

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): system design, protocol, database budget, SEO, security, testing and scaling
- [CONTRIBUTING.md](CONTRIBUTING.md): setup, workflow, tests, PR checklist
- [SECURITY.md](SECURITY.md): threat model, controls, rate limits, go-live checklist, audit log
- [AGENTS.md](AGENTS.md): rules and commands for AI coding agents ([CLAUDE.md](CLAUDE.md) imports it)
