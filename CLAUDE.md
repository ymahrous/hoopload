# CLAUDE.md

@AGENTS.md

The import above is the shared rulebook for every agent. Read it first; this file only adds what is specific to Claude Code.

## Working style for this repo

- **Plan before multi-file changes.** Anything touching the protocol, the store or the engine affects client, server and tests together; sketch the change set first.
- **Verify, don't assume.** After editing, run the narrowest suite that proves the change (`npm run test:unit -- <file>` or `npx vitest run <path>`), then widen it. Report what you ran and the results.
- **Use the query budget as a guardrail.** If a change to `lib/server/**` makes `upload-service.test.ts › Neon free-tier query budget` fail, the change is wrong for the free tier. Redesign it rather than editing the expected numbers.
- **Treat failing tests as signals.** Two real bugs in this codebase were found by tests: integrator drift in the assisted shot (property test) and rim clipping on phones (mobile end-to-end). Investigate before changing an assertion.
- **Keep copy in `lib/site.ts`.** When asked to change wording, FAQ entries or limits text, edit only there. Pages, JSON-LD and `llms.txt` follow.

## Handy one-liners

```bash
npx vitest run tests/integration/store.contract.test.ts       # both stores, real Postgres (PGlite)
npx vitest run -t "query budget"                              # Neon round-trip budget only
PW_EXECUTABLE_PATH=/usr/bin/google-chrome npx playwright test tests/e2e/a11y.spec.ts
npx playwright test --project=mobile                          # phone viewport subset
```

## Don't

- Don't run `npm run db:migrate` against a database the user hasn't named.
- Don't add dependencies for things the platform already does (`fetch`, Web Crypto, `ReadableStream`, `node:stream`).
- Don't commit, push or open PRs unless asked.
