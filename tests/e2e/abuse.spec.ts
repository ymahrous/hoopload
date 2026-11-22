import { expect, test } from "@playwright/test";

/**
 * Runs LAST (its own Playwright project, after desktop + mobile): it drains the
 * strictest budget for 127.0.0.1, which every other e2e test shares.
 *
 * Proves server.mjs ignores client-supplied forwarding headers: rotating
 * X-Forwarded-For / X-Real-IP / even our own x-hoop-client-ip on every request
 * does not create new rate-limit buckets.
 */
test("spoofed forwarding headers do not reset the identity-mint limit", async ({ playwright, baseURL }) => {
  const budget = 5 * 20; // mint: 5/hour × e2e multiplier
  let firstLimitedAt = 0;
  for (let i = 1; i <= budget + 20 && !firstLimitedAt; i++) {
    // Fresh cookie jar each time: the attacker discards their identity and asks for a new one.
    const api = await playwright.request.newContext({ baseURL });
    const r = await api.get("/api/session", {
      headers: { "x-forwarded-for": `9.${i}.9.9`, "x-real-ip": `7.7.7.${i}`, "x-hoop-client-ip": `8.${i}.8.8` },
    });
    if (r.status() === 429) {
      firstLimitedAt = i;
      expect(Number(r.headers()["retry-after"])).toBeGreaterThan(0);
    }
    await api.dispose();
  }
  // Earlier tests already minted some identities from 127.0.0.1, so the limit hits at or before budget + 1.
  expect(firstLimitedAt).toBeGreaterThan(0);
  expect(firstLimitedAt).toBeLessThanOrEqual(budget + 1);
});
