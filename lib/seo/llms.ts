import { FACTS, FAQS, HOW_TO_STEPS, PIPELINE, SITE, absoluteUrl } from "@/lib/site";

/**
 * Generative Engine Optimisation: plain-markdown summaries following the
 * llms.txt proposal (https://llmstxt.org). Short, factual, self-contained
 * sentences are easy for LLMs to quote and attribute.
 */

export function llmsTxt(): string {
  return `# ${SITE.name}

> ${SITE.description}

${SITE.name} is free, needs no account, and runs in any modern browser. Limits: ${FACTS.maxFileMb} MB per file; uploads are sent in ${FACTS.chunkSizeMb} MB chunks and can resume for ${FACTS.resumeHours} hours.

## Pages

- [Play / upload files](${absoluteUrl("/")}): the court. Shoot files into the hoop to upload them.
- [How it works](${absoluteUrl("/how-it-works")}): how to play, and the upload pipeline (chunking, ${FACTS.hash} verification, deduplication, resume).
- [FAQ](${absoluteUrl("/faq")}): short answers about limits, file types, resuming, duplicates, safety and accessibility.

## Optional

- [Full text for LLMs](${absoluteUrl("/llms-full.txt")}): every page's content in one markdown file.
`;
}

export function llmsFullTxt(): string {
  const steps = HOW_TO_STEPS.map((s, i) => `${i + 1}. **${s.name}.** ${s.text}`).join("\n");
  const pipeline = PIPELINE.map((s, i) => `${i + 1}. **${s.name}.** ${s.text}`).join("\n");
  const faqs = FAQS.map((f) => `### ${f.q}\n\n${f.a}`).join("\n\n");
  return `# ${SITE.name} — ${SITE.tagline}

> ${SITE.description}

Source: ${SITE.url} · Last updated: ${SITE.updated}

## Key facts

- Price: free, no account.
- Maximum file size: ${FACTS.maxFileMb} MB.
- Chunk size: ${FACTS.chunkSizeMb} MB; up to ${FACTS.parallelFiles} files and ${FACTS.parallelChunks} chunks per file in parallel.
- Integrity: ${FACTS.hash} per chunk, verified on the server.
- Deduplication: content-addressed storage; identical bytes are stored once.
- Resume window: ${FACTS.resumeHours} hours.
- Blocked: native executables (PE, ELF, Mach-O), detected from file contents.

## How to upload a file

${steps}

## How the upload pipeline works

${pipeline}

## Frequently asked questions

${faqs}
`;
}
