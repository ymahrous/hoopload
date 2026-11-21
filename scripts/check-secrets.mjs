#!/usr/bin/env node
/**
 * Secret scanner (no dependencies). CI additionally runs gitleaks over the full
 * git history; this script is the fast local/pre-commit gate.
 *
 *   node scripts/check-secrets.mjs            # working tree
 *   node scripts/check-secrets.mjs --bundle   # also the built client bundle (.next/static)
 *
 * The bundle scan also fails if the VALUE of any server-only env var
 * (SESSION_SECRET, DATABASE_URL, HEALTH_TOKEN, …) appears in client code, and
 * if any server-only env var NAME is referenced from the client.
 * Findings are printed redacted. Exit code 1 on any finding.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const bundle = process.argv.includes("--bundle");

const PATTERNS = [
  ["AWS access key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ["Stripe live key", /\b(sk|rk)_live_[0-9a-zA-Z]{16,}\b/],
  ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  ["Slack token", /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["OpenAI/Anthropic key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  // Connection strings WITH a real-looking password (placeholders like "password"/"user" are allowed).
  ["Postgres URL with password", /postgres(?:ql)?:\/\/[^:\s/@'"`]+:(?!password@|pass@|\*+@|<)[^@\s'"`]{8,}@[^\s'"`]+/],
  ["Upstash/Redis token", /\bredis(?:s)?:\/\/[^:\s]*:[^@\s]{16,}@/],
  // Any NAME ending in SECRET/TOKEN/PASSWORD/API_KEY (e.g. SESSION_SECRET=…). Note: `\bSECRET` would
  // miss SESSION_SECRET, because "_" is a word character.
  ["generic assignment", /\b[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)\s*[=:]\s*["']?(?![<$'"]|process\.env|change-me|your-)[A-Za-z0-9+/_=-]{24,}/],
];

const SKIP_DIRS = new Set(["node_modules", ".git", ".data", ".data-e2e", ".data-load", "coverage", "test-results", "playwright-report", ".next"]);
const SKIP_FILES = new Set(["package-lock.json", "check-secrets.mjs"]);
const TEXT = /\.(m?[jt]sx?|json|md|ya?ml|env.*|sql|css|html|txt|toml|sh|example)$|^\.env|^Dockerfile|^\.gitignore$/;
const SERVER_ENV = ["SESSION_SECRET", "SESSION_SECRET_PREVIOUS", "DATABASE_URL", "HEALTH_TOKEN"];

function* walk(dir, include) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) || include?.(p)) yield* walk(p, include);
    } else if (!SKIP_FILES.has(e.name)) yield p;
  }
}

const redact = (s) => (s.length <= 8 ? "****" : `${s.slice(0, 4)}…${"*".repeat(6)}`);
const findings = [];

function scanText(file, text) {
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (line.includes("check-secrets: allow")) return;
    for (const [label, re] of PATTERNS) {
      const m = re.exec(line);
      if (m) findings.push(`${path.relative(root, file)}:${i + 1}  ${label}  ${redact(m[0])}`);
    }
  });
}

// 1. Working tree.
for (const f of walk(root)) {
  if (!TEXT.test(path.basename(f))) continue;
  const stat = fs.statSync(f);
  if (stat.size > 2_000_000) continue;
  scanText(f, fs.readFileSync(f, "utf8"));
}

// 2. .gitignore must keep env files and data out of git.
const gi = fs.existsSync(path.join(root, ".gitignore")) ? fs.readFileSync(path.join(root, ".gitignore"), "utf8") : "";
for (const must of [".env", ".data"]) {
  if (!gi.split("\n").some((l) => l.trim() === must || l.trim() === `${must}*` || l.trim() === `${must}/`)) findings.push(`.gitignore  missing "${must}*"`);
}
if (!/^!\.env\.example$/m.test(gi)) findings.push('.gitignore  should re-include "!.env.example"');

// 3. Client bundle.
if (bundle) {
  const dir = path.join(root, ".next", "static");
  if (!fs.existsSync(dir)) {
    console.error("No .next/static — run `npm run build` first.");
    process.exit(2);
  }
  const values = SERVER_ENV.map((k) => [k, process.env[k]]).filter(([, v]) => v && v.length >= 8);
  let files = 0;
  for (const f of walk(dir)) {
    if (!/\.(js|css|json|map)$/.test(f)) continue;
    files++;
    const text = fs.readFileSync(f, "utf8");
    scanText(f, text);
    for (const [k, v] of values) if (text.includes(v)) findings.push(`${path.relative(root, f)}  VALUE of ${k} is in the client bundle`);
    for (const k of SERVER_ENV) if (text.includes(`process.env.${k}`) || text.includes(`"${k}"`)) findings.push(`${path.relative(root, f)}  server-only env name ${k} referenced from client code`);
  }
  if (files === 0) findings.push(".next/static  no client files found to scan");
  else console.log(`scanned ${files} client bundle files`);
}

if (findings.length) {
  console.error(`✗ ${findings.length} potential secret(s):\n  ${findings.join("\n  ")}`);
  console.error("If a real secret leaked: ROTATE it first, then remove it (and purge git history).");
  process.exit(1);
}
console.log("✓ no secrets found");
