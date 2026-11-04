import { CHUNK_SIZE, MAX_FILE_SIZE, QUOTAS, SESSION_TTL_MS } from "@/lib/shared/protocol";

/**
 * Single source of truth for public-facing copy.
 * Rendered pages, JSON-LD and /llms.txt all read from here, so search engines,
 * answer engines and LLM crawlers always see the same facts.
 */

const MB = 1024 * 1024;

export const SITE = {
  name: "Hoopload",
  tagline: "Upload files by shooting hoops",
  url: (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  description:
    "Hoopload is a free browser file uploader that turns uploading into a basketball game: drag a file back, release, and sink it in the hoop to upload it. Uploads are chunked, resumable, verified with SHA-256 and deduplicated.",
  shortDescription: "A file uploader you play like basketball. Chunked, resumable and deduplicated.",
  keywords: [
    "file upload",
    "upload files online",
    "drag and drop upload",
    "resumable upload",
    "chunked file upload",
    "gamified file upload",
    "basketball file upload",
    "Next.js file upload",
    "SHA-256 deduplication",
  ],
  locale: "en_US",
  themeColor: "#e8622c",
  /** Bump when public copy or pages change; used for lastModified / dateModified. */
  updated: "2026-11-25",
} as const;

export const FACTS = {
  chunkSizeMb: CHUNK_SIZE / MB,
  maxFileMb: MAX_FILE_SIZE / MB,
  resumeHours: SESSION_TTL_MS / (60 * 60 * 1000),
  hash: "SHA-256",
  parallelFiles: 2,
  parallelChunks: 3,
  quotaGb: QUOTAS.storageBytes / 1024 ** 3,
  quotaFiles: QUOTAS.files,
};

export interface Faq {
  id: string;
  q: string;
  /** Answer-first: the first sentence fully answers the question (AEO). */
  a: string;
}

export const FAQS: Faq[] = [
  {
    id: "what-is-hoopload",
    q: "What is Hoopload?",
    a: `Hoopload is a web file uploader where you upload a file by shooting it into a basketball hoop. Under the game is a real upload pipeline: files are split into ${FACTS.chunkSizeMb} MB chunks, verified with ${FACTS.hash}, deduplicated and resumable.`,
  },
  {
    id: "how-to-upload",
    q: "How do I upload a file by shooting a hoop?",
    a: "Press on a file, pull it back like a slingshot, and release toward the hoop; a make starts the upload. You can also tap a file for an assisted shot, or drop files straight onto the hoop to dunk them.",
  },
  {
    id: "max-size",
    q: "What is the maximum file size?",
    a: `The maximum file size is ${FACTS.maxFileMb} MB per file, with up to ${FACTS.quotaGb} GB and ${FACTS.quotaFiles} files per browser. Empty files are rejected before any data is sent.`,
  },
  {
    id: "miss",
    q: "What happens if I miss the shot?",
    a: "Nothing is uploaded when you miss. The file rolls back to its spot on the court so you can shoot again or tap it for an assisted shot.",
  },
  {
    id: "resume",
    q: "Can an interrupted upload resume?",
    a: `Yes. If an upload is interrupted, re-adding the same file within ${FACTS.resumeHours} hours resumes it, and only the missing chunks are sent.`,
  },
  {
    id: "duplicates",
    q: "Does uploading the same file twice use extra space?",
    a: `No. Files are content-addressed by a ${FACTS.hash} fingerprint, so identical bytes are stored once. Re-uploading a file you already uploaded completes instantly without sending its data.`,
  },
  {
    id: "integrity",
    q: "How is file integrity checked?",
    a: `Every chunk is hashed with ${FACTS.hash} in the browser and hashed again on the server; a chunk that does not match is rejected and re-sent automatically.`,
  },
  {
    id: "file-types",
    q: "Which file types are allowed?",
    a: "Documents, images, audio, video, archives and code are all accepted. Native executables (Windows .exe, Linux ELF and macOS Mach-O binaries) are blocked, even when renamed, because the server checks the file's real contents rather than its extension.",
  },
  {
    id: "privacy",
    q: "Who can see my uploaded files?",
    a: "Only the browser that uploaded them. Each browser gets a private, signed identity cookie, and every file, download and live update is scoped to it; other visitors cannot list, download or delete your files, or even learn that they exist.",
  },
  {
    id: "keyboard",
    q: "Can I use Hoopload without a mouse?",
    a: "Yes. Each file on the court is a focusable button: press Tab to reach it and Enter or Space to take an assisted shot. Upload progress is announced to screen readers.",
  },
  {
    id: "safe-downloads",
    q: "Are downloaded files safe to open from the site?",
    a: "Downloads are always served as attachments with a sandboxing Content-Security-Policy and nosniff, so an uploaded file can never run inside the Hoopload page itself.",
  },
];

export interface Step {
  name: string;
  text: string;
}

export const HOW_TO_STEPS: Step[] = [
  { name: "Put files on the court", text: "Click the hoop card, paste with Ctrl/Cmd+V, or drag files onto the page. Each file appears on the floor." },
  { name: "Aim", text: "Press on a file and pull it back. A dotted line previews the arc." },
  { name: "Shoot", text: "Release to shoot. Tap instead of dragging for an assisted shot that always goes in." },
  { name: "Score to upload", text: "When the file drops through the hoop the upload starts, and a progress card fills until it shows a green check." },
  { name: "Find it in the Locker", text: "Open the Locker to download or delete your files. It is private to your browser and updates live across your tabs." },
];

export const PIPELINE: Step[] = [
  { name: "Fingerprint", text: `A Web Worker splits the file into ${FACTS.chunkSizeMb} MB chunks and hashes each with ${FACTS.hash}, off the main thread.` },
  { name: "Start or skip", text: "The server checks the fingerprint against your own files: a file you already uploaded completes instantly, a matching unfinished upload resumes, otherwise a new session opens." },
  { name: "Send chunks", text: `Up to ${FACTS.parallelFiles} files and ${FACTS.parallelChunks} chunks per file upload in parallel, with exponential backoff and jitter on failure.` },
  { name: "Verify", text: "Each chunk is streamed to storage while it is hashed; any mismatch is rejected with HTTP 422 and re-sent." },
  { name: "Assemble", text: "Chunks are joined into one content-addressed object, its real type is detected from its magic bytes, and every open tab is notified over Server-Sent Events." },
];

export const NAV = [
  { href: "/", label: "Play" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/faq", label: "FAQ" },
];

export const absoluteUrl = (path = "/") => `${SITE.url}${path === "/" ? "" : path}` || SITE.url;
