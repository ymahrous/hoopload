"use client";

import { useEffect, useRef, useState } from "react";
import type { FileRecord } from "@/lib/shared/protocol";
import { formatBytes, timeAgo } from "@/lib/shared/format";
import { FileIcon } from "./FileIcon";

interface Props {
  open: boolean;
  onClose(): void;
  files: FileRecord[];
  bytes: number;
  connected: boolean;
  loaded: boolean;
  onDelete(id: string): void;
}

/** Server-side file list. Updates live from the SSE feed, including other tabs' uploads. */
export function Locker({ open, onClose, files, bytes, connected, loaded, onDelete }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const t = setInterval(() => force((n) => n + 1), 20_000); // refresh relative times
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearInterval(t);
    };
  }, [open, onClose]);

  return (
    <>
      <div className="scrim" data-open={open} onClick={onClose} />
      <aside className="locker" data-open={open} inert={!open} aria-label="Uploaded files" ref={panelRef} tabIndex={-1}>
        <header>
          <div>
            <h2>Locker room</h2>
            <p>
              {files.length} file{files.length === 1 ? "" : "s"} · {formatBytes(bytes)}
            </p>
          </div>
          <span className="live" data-on={connected} title={connected ? "Live updates connected" : "Reconnecting…"}>
            <i /> {connected ? "Live" : "Offline"}
          </span>
          <button className="icon-btn" onClick={onClose} aria-label="Close locker">
            ×
          </button>
        </header>
        <ul>
          {loaded && files.length === 0 && <li className="empty">No files yet. Sink one.</li>}
          {files.map((f) => (
            <li key={f.id}>
              <FileIcon name={f.name} mime={f.mime} size={28} />
              <div className="meta">
                <span className="name" title={f.name}>
                  {f.name}
                </span>
                <span className="sub">
                  {formatBytes(f.size)} · {timeAgo(f.createdAt)}
                </span>
              </div>
              <a className="text-btn" href={`/api/files/${f.id}`} download={f.name}>
                Download
              </a>
              <button className="icon-btn" onClick={() => onDelete(f.id)} aria-label={`Delete ${f.name}`}>
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path d="M3 4h10M6.5 4V2.5h3V4M4.5 4l.6 9.5h5.8l.6-9.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </>
  );
}
