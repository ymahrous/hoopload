import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/** Runs the real scanner against a throwaway project tree. */
const SCRIPT = path.join(process.cwd(), "scripts/check-secrets.mjs");
let dir = "";

function project(files: Record<string, string>) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-"));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.copyFileSync(SCRIPT, path.join(dir, "scripts/check-secrets.mjs"));
  const all = { ".gitignore": ".env\n.env*\n!.env.example\n.data*\n", ...files };
  for (const [name, body] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  const r = spawnSync(process.execPath, [path.join(dir, "scripts/check-secrets.mjs")], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("check-secrets", () => {
  it("passes a clean tree with placeholders", () => {
    const r = project({ ".env.example": "DATABASE_URL=postgresql://user:password@host/db\nSESSION_SECRET=change-me\n", "app.ts": "const x = process.env.SESSION_SECRET;" });
    expect(r.code).toBe(0);
  });

  it.each([
    ["AWS key", "const k = 'AKIA" + "ABCDEFGHIJKLMNOP';"],
    ["Postgres URL", "postgresql://neondb_owner:npg_" + "Zx9Qw3Lk8Rt2@ep-x.neon.tech/db"],
    ["private key", "-----BEGIN " + "PRIVATE KEY-----"],
    ["*_SECRET assignment (regression: \\bSECRET missed SESSION_SECRET)", "SESSION_SECRET=" + "Q2x8Rk3mP9vL1wZ7tY4uN6bH0cJ5dF8a"],
    ["*_TOKEN assignment", "const API_TOKEN = '" + "Zx9Qw3Lk8Rt2Mn7Bv4Cx1Pl6Ok5Ij0Uh'"],
  ])("flags %s, redacted", (_n, line) => {
    const r = project({ "src/leak.ts": line });
    expect(r.code).toBe(1);
    expect(r.out).toContain("src/leak.ts:1");
    expect(r.out).not.toContain(line.slice(12, 30)); // value is never printed
  });

  it("requires .gitignore to exclude env files", () => {
    dir = "";
    const r = project({ ".gitignore": "node_modules\n" });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/missing "\.env\*"/);
  });
});
