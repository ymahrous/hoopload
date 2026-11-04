export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export type FileKind = "pdf" | "image" | "video" | "audio" | "archive" | "doc" | "sheet" | "code" | "other";

export function fileKind(name: string, mime = ""): FileKind {
  const ext = extOf(name);
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "avif"].includes(ext)) return "image";
  if (mime.startsWith("video/") || ["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "video";
  if (mime.startsWith("audio/") || ["mp3", "wav", "flac", "m4a", "ogg"].includes(ext)) return "audio";
  if (["zip", "rar", "7z", "tar", "gz", "tgz"].includes(ext)) return "archive";
  if (["xls", "xlsx", "csv", "numbers", "tsv"].includes(ext)) return "sheet";
  if (["doc", "docx", "txt", "md", "rtf", "pages", "odt"].includes(ext)) return "doc";
  if (["js", "ts", "tsx", "jsx", "py", "go", "rs", "json", "html", "css", "java", "c", "cpp", "rb", "sh"].includes(ext)) return "code";
  return "other";
}

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function badgeLabel(name: string, mime = ""): string {
  const ext = extOf(name);
  if (ext && ext.length <= 4) return ext.toUpperCase();
  const kind = fileKind(name, mime);
  return kind === "other" ? "FILE" : kind.slice(0, 3).toUpperCase();
}
