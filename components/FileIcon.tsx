import { badgeLabel, fileKind, type FileKind } from "@/lib/shared/format";

const COLORS: Record<FileKind, string> = {
  pdf: "#e5383b",
  image: "#16a34a",
  video: "#7c3aed",
  audio: "#db2777",
  archive: "#d97706",
  doc: "#2563eb",
  sheet: "#059669",
  code: "#0f172a",
  other: "#64748b",
};

export function FileIcon({ name, mime = "", size = 56 }: { name: string; mime?: string; size?: number }) {
  const kind = fileKind(name, mime);
  const label = badgeLabel(name, mime);
  const h = size * (68 / 56);
  return (
    <svg width={size} height={h} viewBox="0 0 56 68" aria-hidden="true" className="file-icon">
      <defs>
        <linearGradient id="paper" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#f3f4f6" />
        </linearGradient>
      </defs>
      <path d="M6 2h30l16 16v44a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4z" fill="url(#paper)" stroke="#d6d9df" strokeWidth="1.5" />
      <path d="M36 2v12a4 4 0 0 0 4 4h12" fill="#eceef2" stroke="#d6d9df" strokeWidth="1.5" />
      <rect x="10" y="26" width="24" height="3" rx="1.5" fill="#e5e7eb" />
      <rect x="10" y="33" width="30" height="3" rx="1.5" fill="#e5e7eb" />
      <rect x="6" y="44" width={Math.max(26, label.length * 7.5 + 10)} height="14" rx="3" fill={COLORS[kind]} />
      <text x="11" y="54.5" fill="#fff" fontSize="9" fontWeight="700" fontFamily="ui-sans-serif, system-ui, sans-serif" letterSpacing="0.4">
        {label}
      </text>
    </svg>
  );
}
