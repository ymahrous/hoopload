"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { useFilesFeed, useUploads } from "@/lib/client/hooks";
import { getUploadManager } from "@/lib/client/uploadManager";
import { HoopEngine, type AttachIntent } from "@/lib/game/engine";
import { FileIcon } from "./FileIcon";
import { Locker } from "./Locker";
import { UploadTray } from "./UploadTray";

interface BallView {
  id: string;
  name: string;
  mime: string;
}

type DragState = "none" | "court" | "hoop";

const uid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}${Math.random()}`);

export function Court() {
  const stageRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLCanvasElement>(null);
  const frontRef = useRef<HTMLCanvasElement>(null);
  const rimRef = useRef<HTMLDivElement>(null);
  const floorRef = useRef<HTMLDivElement>(null);
  const dropzoneRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const engineRef = useRef<HoopEngine | null>(null);
  const filesRef = useRef(new Map<string, File>());
  const intentsRef = useRef(new Map<string, AttachIntent>());
  const elsRef = useRef(new Map<string, HTMLElement>());
  const refCbs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const dragDepth = useRef(0);

  const [balls, setBalls] = useState<BallView[]>([]);
  const [hot, setHot] = useState(false);
  const [drag, setDrag] = useState<DragState>("none");
  const [stats, setStats] = useState({ shots: 0, makes: 0, streak: 0, best: 0 });
  const [lockerOpen, setLockerOpen] = useState(false);

  const uploads = useUploads();
  const feed = useFilesFeed();
  const uploadedCount = uploads.filter((u) => u.status === "done").length;

  // --- engine lifecycle -----------------------------------------------------
  useEffect(() => {
    const engine = new HoopEngine(stageRef.current!, backRef.current!, frontRef.current!, rimRef.current!, floorRef.current!, {
      onShot: () => setStats((s) => ({ ...s, shots: s.shots + 1 })),
      onScore: (id, dunk) => {
        const file = filesRef.current.get(id);
        if (file) getUploadManager().add(file);
        if (!dunk)
          setStats((s) => {
            const streak = s.streak + 1;
            return { ...s, makes: s.makes + 1, streak, best: Math.max(s.best, streak) };
          });
      },
      onMiss: () => setStats((s) => ({ ...s, streak: 0 })),
      onGone: (id) => {
        filesRef.current.delete(id);
        intentsRef.current.delete(id);
        refCbs.current.delete(id);
        setBalls((prev) => prev.filter((b) => b.id !== id));
      },
      onHot: setHot,
    });
    engineRef.current = engine;
    // Re-attach anything already mounted (StrictMode remounts effects in dev).
    for (const [id, el] of elsRef.current) engine.attach(id, el, { mode: "rest", x: undefined });
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  /** Stable per-ball ref callbacks, so re-renders never detach a ball mid-flight. */
  const ballRef = useCallback((id: string) => {
    let cb = refCbs.current.get(id);
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        if (el) {
          elsRef.current.set(id, el);
          engineRef.current?.attach(id, el, intentsRef.current.get(id) ?? { mode: "rest" });
        } else {
          elsRef.current.delete(id);
          engineRef.current?.detach(id);
        }
      };
      refCbs.current.set(id, cb);
    }
    return cb;
  }, []);

  const addFiles = useCallback((files: File[], intent: (i: number) => AttachIntent) => {
    if (!files.length) return;
    const views = files.map((file, i) => {
      const id = uid();
      filesRef.current.set(id, file);
      intentsRef.current.set(id, intent(i));
      return { id, name: file.name || "untitled", mime: file.type };
    });
    setBalls((prev) => [...prev, ...views]);
  }, []);

  // --- paste + stray drops --------------------------------------------------
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length) addFiles(files, () => ({ mode: "rest" }));
    };
    const block = (e: globalThis.DragEvent) => e.preventDefault();
    window.addEventListener("paste", onPaste);
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, [addFiles]);

  // --- native drag & drop ---------------------------------------------------
  const overHoop = (e: DragEvent) => {
    const r = dropzoneRef.current?.getBoundingClientRect();
    if (!r) return false;
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom + 60;
  };
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  const onDragEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current++;
  };
  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const next: DragState = overHoop(e) ? "hoop" : "court";
    if (next !== drag) setDrag(next);
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDrag("none");
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDrag("none");
    const files = Array.from(e.dataTransfer.files);
    const p = engineRef.current?.stagePoint(e.clientX, e.clientY);
    if (overHoop(e)) addFiles(files, (i) => ({ mode: "dunk", x: p?.x, stack: i }));
    else addFiles(files, () => ({ mode: "rest", x: p?.x }));
  };

  const restingCount = balls.length;
  const fg = stats.shots ? Math.round((stats.makes / stats.shots) * 100) : null;

  return (
    <div className="app">
      <div className="stage" ref={stageRef} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} data-drag={drag}>
        <header className="top">
          <div>
            <h1>Upload files</h1>
            <p>Drag and drop, or take the shot.</p>
          </div>
          <div className="top-right">
            {stats.shots > 0 && (
              <span className="pill stat" title={`Best streak ${stats.best}`}>
                FG {stats.makes}/{stats.shots}
                {fg !== null && ` · ${fg}%`}
                {stats.streak > 1 && <b> · {stats.streak} in a row</b>}
              </span>
            )}
            <span className="pill">
              Uploaded <b>{uploadedCount}</b>
            </span>
            <button className="pill button" onClick={() => setLockerOpen(true)} aria-haspopup="dialog">
              Locker <b>{feed.files.length}</b>
            </button>
          </div>
        </header>

        <div className="hoop-area">
          <button
            ref={dropzoneRef}
            className="dropzone"
            data-hot={hot || drag === "hoop"}
            onClick={() => inputRef.current?.click()}
            aria-describedby="dropzone-help"
          >
            <svg className="dz-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M12 15V4m0 0l-4 4m4-4l4 4M5 14v4a2 2 0 002 2h10a2 2 0 002-2v-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <strong>Drop files here</strong>
            <small>or take the shot</small>
            <span id="dropzone-help" className="sr-only">
              Opens a file picker. Chosen files land on the court, ready to shoot.
            </span>
            <span className="backboard" aria-hidden="true">
              <span className="target" />
              <span className="rim-anchor" ref={rimRef} />
            </span>
          </button>
        </div>

        <canvas className="layer" ref={backRef} aria-hidden="true" />
        <div className="balls">
          {balls.map((b) => (
            <div key={b.id} ref={ballRef(b.id)} className="ball" role="button" tabIndex={0} aria-label={`${b.name}. Press Enter to shoot it into the hoop.`}>
              <FileIcon name={b.name} mime={b.mime} />
              <span className="label">{b.name}</span>
            </div>
          ))}
        </div>
        <canvas className="layer" ref={frontRef} aria-hidden="true" />

        <div className="floor" ref={floorRef} aria-hidden="true" />

        <div className="court-hint">
          {restingCount === 0 ? (
            <button className="ghost" onClick={() => inputRef.current?.click()}>
              + Put files on the court
            </button>
          ) : (
            <>
              <span>{stats.shots === 0 ? "Pull back and release to shoot · tap for an assisted shot" : "Pull back, aim, release"}</span>
              {restingCount > 1 && (
                <button className="ghost" onClick={() => engineRef.current?.shootAll()}>
                  Shoot all
                </button>
              )}
            </>
          )}
        </div>

        {drag === "court" && <div className="drop-hint">Drop on the court to shoot · drop on the hoop to dunk</div>}

        <UploadTray items={uploads} />
      </div>

      <Locker open={lockerOpen} onClose={() => setLockerOpen(false)} files={feed.files} bytes={feed.bytes} connected={feed.connected} loaded={feed.loaded} onDelete={feed.remove} />

      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles(Array.from(e.target.files ?? []), () => ({ mode: "rest" }));
          e.target.value = "";
        }}
      />
    </div>
  );
}
