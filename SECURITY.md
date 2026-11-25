# Security

This file covers how Hoopload is defended, the limits it enforces, what an operator must do before going live, and how to re-run every check.

## Reporting a vulnerability

Please don't open a public issue. Contact the maintainers privately with steps to reproduce and the impact. We aim to acknowledge reports within 3 working days.

## Threat model

Hoopload is a public, account-free upload service, so **every visitor is untrusted**. The assets are each visitor's uploaded files, the server's disk, and the Neon free-tier compute budget (100 CU-hours a month). The attackers we design against:

| Attacker | Goal | Main defences |
| --- | --- | --- |
| Other visitors | Read, list, delete or detect someone else's files | Signed per-browser identity; every query is owner-scoped; another owner's resources return 404; dedupe only within an owner |
| Malicious websites | Act through a visitor's browser (CSRF) | `SameSite=Lax` cookie; `Sec-Fetch-Site` / `Origin` check on every mutation; JSON endpoints require `application/json` |
| Script injection (XSS) | Run code in the app's origin | Nonce CSP with `'strict-dynamic'` (no inline handlers or `eval`); React escaping; uploads only ever served as sandboxed attachments |
| Floods and scrapers | Exhaust CPU, disk, bandwidth or Neon compute | Layered rate limits, byte quotas, per-owner storage quotas, a disk-space reserve, concurrency caps, socket timeouts, a health check that never touches the DB |
| Header spoofers | Evade limits with a fake `X-Forwarded-For` | `server.mjs` derives the client address from the socket (or N trusted proxies) and overwrites the only header the limiter reads |
| Malware uploaders | Host executables | Magic-byte detection blocks PE, ELF and Mach-O even when renamed; downloads are `attachment` with `nosniff` and a sandbox CSP |
| Database credential leak | Read data through another role | Default-deny row-level security on every table; `PUBLIC` has no privileges |

## Controls

### Identity and authorization
- **Identity cookie.** On first API use, `/api/session` issues a random 128-bit owner id in an HMAC-SHA256-signed cookie.
  - The cookie is `HttpOnly` and `SameSite=Lax`, and over HTTPS it uses the `__Host-` prefix with `Secure`.
  - Verification is timing-safe.
  - `SESSION_SECRET_PREVIOUS` allows the secret to be rotated without logging everyone out.
- **Every file, upload session and live event belongs to one owner**, and the database queries filter by owner, so there is no "get by id" method that ignores ownership.
  - Another owner's resource is indistinguishable from a missing one (`404`).
  - Malformed ids are rejected before any lookup.
- **Deduplication can't be used to probe for files.** It skips the upload only for *your own* identical files. Anyone else must upload every byte, which the server verifies per chunk, before the storage is shared. File assembly always writes the full file, so response timing doesn't reveal whether the bytes already existed.
- **Every API handler is built with `secureRoute`**, which runs, in order:
  1. Resolve the trusted client address.
  2. Apply the global rate limit.
  3. Check CSRF.
  4. Check identity.
  5. Apply the per-route limits.
  6. Run the handler.
  7. Map errors to a uniform response.

  An enumeration test fails if any route skips it, if a mutating verb lacks CSRF, or if a non-public route doesn't require identity.

### Input handling
- Init bodies have an exact shape. Unknown fields (mass assignment) are rejected, and types and bounds are checked.
- The fingerprint is recomputed on the server from the chunk hashes, and each chunk's SHA-256 is verified while it streams to disk.
- File names are NFC-normalised, with control and bidi characters stripped, path separators replaced, and a 200-code-point cap. `Content-Disposition` is always ASCII-safe, with an RFC 5987 UTF-8 name.
- Size caps:
  - JSON bodies: 32 KB.
  - Each chunk: capped at its declared `Content-Length` (which is required), and must finish streaming within 60 s.
  - Requests: 120 s overall, and headers must arrive within 15 s.
  - Headers: 16 KB maximum.
- MIME claims that would be active content (html, js, xml, svg) are discarded, and the content type comes from magic bytes.

### Response hardening
- **Pages:** a per-request nonce CSP (`script-src 'self' 'nonce-…' 'strict-dynamic'`, plus `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'self'` and `upgrade-insecure-requests`).
- **Everywhere:**
  - `X-Content-Type-Options: nosniff`.
  - `X-Frame-Options: DENY`.
  - `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy` set to `same-origin`.
  - `Origin-Agent-Cluster`.
  - `Referrer-Policy: strict-origin-when-cross-origin`.
  - A restrictive `Permissions-Policy`.
  - HSTS (2 years, preload) in production.
  - No `x-powered-by` header.
- **API:** `Cache-Control: no-store`, and no CORS headers, so cross-origin reads are blocked by the browser.
- **Downloads:** `attachment`, `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private`, `Vary: Cookie` and `X-Robots-Tag: noindex`.

### Database (Neon)
- Only the server talks to Postgres, over the HTTP driver. All values are bound parameters.
- **Row-level security** is enabled on every table, with a single policy for the `hoopload_app` role. Any other role sees **0 rows**, which `tests/integration/rls.test.ts` proves with a role that holds a direct `SELECT` grant. `PUBLIC` has no table privileges, and new tables are swept automatically after every migration.
- Recommended least-privilege setup: create a login in the app role and use it for `DATABASE_URL`, keeping the owner role for migrations only.
  ```sql
  CREATE ROLE hoopload_web LOGIN PASSWORD '<generated>' IN ROLE hoopload_app;
  ```

## Rate limits and quotas

Every limited request is charged against **both** the client address and, when known, the owner identity. It is refused when **either** bucket is empty, and a refusal consumes nothing.

- **Changing the cookie doesn't help:** the address bucket still applies, and minting new identities is itself the strictest limit.
- **Changing the address doesn't help:** the owner bucket still applies.
- **IPv6 is grouped by /64.**
- **Every 429 carries `Retry-After`**, and successful responses carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`.

| Limit | Burst | Sustained | Applies to |
| --- | --- | --- | --- |
| `global` | 300 | 10/s | Every API request, per address (checked first, before parsing) |
| `mint` | 5 | 5/hour | New anonymous identities, per address |
| `init` | 20 | 1 every 2 s | Upload starts |
| `chunk` | 120 | 8/s (~32 MB/s) | Chunk PUTs |
| `uploadBytes` | 2 GiB | 2 GiB/day | Uploaded bytes (charged from `Content-Length` before streaming) |
| `complete` | 20 | 1 every 2 s | Upload completions |
| `read` | 60 | 3/s | File list and upload status |
| `download` | 30 | 1/s | Downloads |
| `mutate` | 10 | 1 every 5 s | Deletes and aborts |
| `events` | 5 | 1 every 10 s | Live-update connection attempts |

| Cap | Value |
| --- | --- |
| Live-update connections | 4 per identity, 50 per address (NAT-friendly), 500 in total; each recycled after 30 min |
| Simultaneous chunk writes | 6 per identity |
| Storage per identity | 2 GiB, 500 files, 10 unfinished uploads |
| Disk reserve | Uploads are refused (507) when free space would drop below `MIN_FREE_BYTES` (default 1 GiB) |
| Sockets | `headersTimeout` 15 s, `requestTimeout` 120 s, keep-alive 5 s, `maxConnections` 2000, 16 KB headers |

**Limiter storage.** Blob storage is a local disk, so Hoopload runs as one long-lived Node process (`server.mjs`), and an in-process limiter is authoritative for that. If storage moves to S3 and the app scales out, implement `LimitStore` on Redis. `limit()` and its callers stay the same.

**Shared addresses.** Offices and carrier-grade NAT can put many people behind one IP. The per-address limits are sized for that, but a very large NAT could still hit `global` or `mint`. Raise only those limits if real users report 429s.

## Before going live (operator checklist)

- [ ] **`SESSION_SECRET`** is set to at least 32 random characters (`openssl rand -base64 48`). The server refuses to start without it in production.
- [ ] **Start with `npm start`** (`node server.mjs`), not `next start`. Otherwise the client address can't be trusted, and all clients fail closed into one shared rate-limit bucket.
- [ ] **Behind a reverse proxy or CDN?** Set `TRUST_PROXY_HOPS` to exactly the number of proxies that *append* to `X-Forwarded-For`. On a platform with its own trusted header, set `CLIENT_IP_HEADER` instead (for example `cf-connecting-ip`).
- [ ] **Serve over HTTPS only** (HSTS is sent in production).
- [ ] **`HEALTH_TOKEN`** (at least 16 characters) if a monitor needs health details. The public health response is `{ ok: true }` and never touches the database.
- [ ] **Neon:** run `npm run db:migrate` (enables RLS), and use a least-privilege login (see above).
- [ ] **CI secrets:** `SESSION_SECRET` (used for the bundle scan) and `DATABASE_URL` if migrations run in CI.
- [ ] **`npm audit signatures`** passes. It couldn't run in the authoring environment because the registry keys endpoint was unreachable; CI runs it.
- [ ] **Git history:** the gitleaks CI job scans every commit. Make sure it is green on the first push.

## Re-running the checks

```bash
npm run check:secrets                    # working tree + .gitignore
npm run build && SESSION_SECRET=… npm run check:secrets -- --bundle   # client bundle
npm run check:deps                       # npm audit (prod) + registry signatures
npx vitest run tests/integration/rls.test.ts tests/integration/security.test.ts tests/unit/security.test.ts
npx playwright test tests/e2e/security.spec.ts                         # CSP, headers, cookie, isolation
npx playwright test --project=abuse                                    # spoofed-header rate-limit test
TRUST_PROXY_HOPS=1 SESSION_SECRET=… node server.mjs & BASE_URL=http://localhost:3000 EXPECT_LIMITED=1 VUS=1 FILES=30 SIZE_MB=1 npm run test:load
```

CI runs all of these on every push: a `security` job (gitleaks over full history, the secret scan, `npm audit`, signatures), plus the bundle scan and every test suite. Dependabot opens weekly update PRs, grouping minor and patch versions and opening majors individually.

## Audit log (2026-11-25)

A probe of the pre-hardening build confirmed seven vulnerabilities, all fixed and re-tested:

| # | Finding | Before | After |
| --- | --- | --- | --- |
| 1 | Anyone could list and download every file | listed and downloaded (200) | empty list; 404 (401 without identity) |
| 2 | Dedupe revealed whether *anyone* held a given file | `complete` | `open` (must upload all bytes) |
| 3 | CSRF: a malicious site could delete files | 204 | 403 |
| 4 | IDOR: anyone could delete any file | 204 | 404; the owner's file is intact |
| 5 | Rate limits bypassed with a rotating `X-Forwarded-For` | 0 of 200 limited | 140 of 200 limited (all beyond the burst) |
| 6 | Anyone could wake Neon via `/api/health?deep=1` | full details, DB queried | `{ ok: true }`, DB untouched |
| 7 | No CSP or HSTS on pages | none | nonce CSP + HSTS |

Also fixed: two high-severity advisories in production dependencies (`sharp`, and `postcss` via an override, keeping Next 15), and a blind spot in the secret scanner (`\bSECRET` didn't match `SESSION_SECRET`).

Deferred (major versions; review in their own PRs): Next 16, TypeScript 7, `@types/node` 26 (stays on the Node 22 major).
