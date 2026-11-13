import path from "node:path";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      "@": root,
      // `server-only` throws outside React Server Components; tests import server modules directly.
      "server-only": path.join(root, "tests/helpers/empty.ts"),
    },
  },
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    projects: [
      { extends: true, test: { name: "unit", environment: "node", include: ["tests/unit/**/*.test.ts"] } },
      {
        extends: true,
        test: { name: "integration", environment: "node", include: ["tests/integration/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 30_000 },
      },
      {
        extends: true,
        test: { name: "component", environment: "jsdom", include: ["tests/component/**/*.test.tsx"], setupFiles: ["tests/helpers/setup-dom.ts"] },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["lib/**/*.ts", "app/api/**/*.ts", "components/**/*.tsx", "app/**/*.ts"],
      exclude: [
        // Covered by Playwright (needs a real browser: canvas, Worker, XHR upload progress).
        "lib/game/engine.ts",
        "lib/client/**",
        "components/Court.tsx",
        "app/**/opengraph-image.tsx",
        "app/**/apple-icon.tsx",
        "lib/server/db/executor.ts",
        "lib/server/store/index.ts",
      ],
      reporter: ["text-summary", "html", "lcov"],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 85 },
    },
  },
});
