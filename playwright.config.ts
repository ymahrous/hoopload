import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3200);
const visual = process.env.VISUAL === "1";

/**
 * Runs against a production build (`npm run build` first). Each run starts on
 * an empty data dir. Set PW_EXECUTABLE_PATH to use a system Chrome.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  grep: visual ? /@visual/ : undefined,
  grepInvert: visual ? undefined : /@visual/,
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: "disabled" } },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.PW_EXECUTABLE_PATH ? { executablePath: process.env.PW_EXECUTABLE_PATH } : {},
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } }, testIgnore: /abuse\.spec\.ts/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /(a11y|seo|smoke|security)\.spec\.ts/ },
    // Drains shared rate-limit budgets, so it must run after everything else.
    { name: "abuse", use: { ...devices["Desktop Chrome"] }, testMatch: /abuse\.spec\.ts/, dependencies: ["desktop", "mobile"] },
  ],
  webServer: {
    // The real production entry point (trusted client IP, socket timeouts).
    command: `node -e "require('fs').rmSync('.data-e2e',{recursive:true,force:true})" && node server.mjs`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      UPLOAD_DIR: ".data-e2e",
      NEXT_TELEMETRY_DISABLED: "1",
      SESSION_SECRET: process.env.SESSION_SECRET ?? "e2e-only-session-secret-0123456789abcdef", // check-secrets: allow (test dummy)
      // Every e2e browser context comes from 127.0.0.1, so limits are scaled for the suite.
      // Strict per-limit behaviour is covered in tests/integration/security.test.ts.
      RATE_LIMIT_MULTIPLIER: "20",
      ALLOW_RATE_LIMIT_MULTIPLIER: "1",
    },
  },
});
