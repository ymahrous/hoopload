"use client";

import { memo } from "react";
import { getUploadManager, type UploadItem } from "@/lib/client/uploadManager";
import { formatBytes } from "@/lib/shared/format";
import { FileIcon } from "./FileIcon";

const STATUS_TEXT: Record<UploadItem["status"], string> = {
  queued: "Queued",
  hashing: "Fingerprinting…",
  uploading: "Uploading…",
  finalizing: "Finalizing…",
  done: "Uploaded",
  error: "Failed",
  canceled: "Canceled",
};

export function UploadTray({ items }: { items: UploadItem[] }) {
  if (!items.length) return null;
  const finished = items.filter((i) => i.status === "done" || i.status === "canceled").length;
  return (
    <section className="tray" aria-label="Uploads" aria-live="polite">
      {finished > 1 && (
        <button className="tray-clear" onClick={() => getUploadManager().clearFinished()}>
          Clear {finished}
        </button>
      )}
      <ul>
        {items.map((it) => (
          <UploadRow key={it.id} item={it} />
        ))}
      </ul>
    </section>
  );
}

const UploadRow = memo(function UploadRow({ item }: { item: UploadItem }) {
  const m = getUploadManager();
  const pct = Math.round(item.progress * 100);
  const active = item.status === "uploading" || item.status === "hashing" || item.status === "finalizing" || item.status === "queued";
  let detail = STATUS_TEXT[item.status];
  if (item.status === "uploading") detail = `${pct}%${item.bytesPerSec > 0 ? ` · ${formatBytes(item.bytesPerSec)}/s` : ""}${item.resumed ? " · resumed" : ""}`;
  if (item.status === "hashing") detail = `Fingerprinting ${pct}%`;
  if (item.status === "done" && item.deduped) detail = "Uploaded · already stored";
  if (item.status === "error") detail = item.error ?? "Failed";

  return (
    <li className="upload-row" data-status={item.status}>
      <div className="upload-icon">
        <FileIcon name={item.name} mime={item.mime} size={26} />
      </div>
      <div className="upload-meta">
        <div className="upload-name" title={item.name}>
          {item.name}
        </div>
        <div className="upload-size">{formatBytes(item.size)}</div>
      </div>
      <div className="upload-progress">
        <div className="upload-status">{detail}</div>
        <div
          className="bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={item.status === "done" ? 100 : pct}
          aria-label={`${item.name} upload progress`}
        >
          <span style={{ transform: `scaleX(${item.status === "done" ? 1 : item.status === "uploading" || item.status === "finalizing" ? item.progress : item.status === "hashing" ? item.progress * 0.08 : 0})` }} />
        </div>
      </div>
      <div className="upload-action">
        {item.status === "done" && (
          <span className="check" aria-label="Uploaded">
            <svg viewBox="0 0 20 20" width="20" height="20">
              <circle cx="10" cy="10" r="10" fill="#16a34a" />
              <path d="M6 10.5l2.6 2.6L14.2 7.5" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        )}
        {active && (
          <button className="icon-btn" onClick={() => m.cancel(item.id)} aria-label={`Cancel ${item.name}`}>
            ×
          </button>
        )}
        {(item.status === "error" || item.status === "canceled") && (
          <>
            <button className="text-btn" onClick={() => m.retry(item.id)}>
              Retry
            </button>
            <button className="icon-btn" onClick={() => m.dismiss(item.id)} aria-label={`Dismiss ${item.name}`}>
              ×
            </button>
          </>
        )}
      </div>
    </li>
  );
});
