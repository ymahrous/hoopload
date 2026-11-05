import fs from "node:fs/promises";
import path from "node:path";
import type { FileRecord } from "@/lib/shared/protocol";
import { Mutex } from "../core";
import { decodeCursor, encodeCursor, type ClaimResult, type FilePage, type InitLookup, type MetadataStore, type UploadSession } from "./types";

interface OwnedFile extends FileRecord {
  ownerId: string;
}

interface Shape {
  version: 3;
  files: Record<string, OwnedFile>;
  sessions: Record<string, UploadSession>;
}

const pub = ({ ownerId: _o, ...f }: OwnedFile): FileRecord => ({ ...f });
const copySession = (s: UploadSession): UploadSession => ({ ...s, chunkHashes: [...s.chunkHashes] });

/**
 * Zero-config store for local development and tests: an in-memory model,
 * mutations serialised by a mutex, persisted as coalesced atomic snapshots
 * (file mode 0600). Single-process only. Same owner semantics as PostgresStore.
 */
export class JsonStore implements MetadataStore {
  readonly kind = "json" as const;
  private data: Shape = { version: 3, files: {}, sessions: {} };
  private ready: Promise<void>;
  private lock = new Mutex();
  private dirty = false;
  private flushing: Promise<void> | null = null;

  constructor(private file: string | null) {
    this.ready = this.load();
  }

  private async load() {
    if (!this.file) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as { version: number; files?: Record<string, OwnedFile>; sessions?: Record<string, UploadSession> };
      if (parsed.version === 3) this.data = parsed as Shape;
      else if (parsed.version === 2) {
        // Pre-ownership data: unreachable by any real identity (mirrors SQL migration 2).
        for (const f of Object.values(parsed.files ?? {})) this.data.files[f.id] = { ...f, ownerId: "legacy" };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("[json-store] unreadable, starting fresh", err);
    }
  }

  private async tx<T>(fn: (d: Shape) => T): Promise<T> {
    await this.ready;
    return this.lock.run(() => {
      const out = fn(this.data);
      this.dirty = true;
      void this.flush();
      return out;
    });
  }

  private async read<T>(fn: (d: Shape) => T): Promise<T> {
    await this.ready;
    return fn(this.data);
  }

  flush(): Promise<void> {
    if (!this.file) return Promise.resolve();
    if (this.flushing) return this.flushing;
    const file = this.file;
    this.flushing = (async () => {
      while (this.dirty) {
        this.dirty = false;
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(this.data), { mode: 0o600 });
        await fs.rename(tmp, file);
      }
    })()
      .catch((err) => console.error("[json-store] flush failed", err))
      .finally(() => {
        this.flushing = null;
      });
    return this.flushing;
  }

  private owned(d: Shape, owner: string) {
    return Object.values(d.files).filter((f) => f.ownerId === owner);
  }

  lookupForInit(owner: string, fingerprint: string, name: string, now: number): Promise<InitLookup> {
    return this.read((d) => {
      const mine = this.owned(d, owner);
      const same = mine.filter((f) => f.fingerprint === fingerprint).sort((a, b) => a.createdAt - b.createdAt);
      const exact = same.find((f) => f.name === name);
      const sessions = Object.values(d.sessions).filter((s) => s.ownerId === owner && s.expiresAt > now);
      const open = sessions.filter((s) => s.fingerprint === fingerprint && s.status === "open").sort((a, b) => b.createdAt - a.createdAt)[0];
      const hit = exact ?? same[0];
      return {
        file: hit ? pub(hit) : null,
        exact: Boolean(exact),
        openSessionId: open?.id ?? null,
        usage: { files: mine.length, bytes: mine.reduce((n, f) => n + f.size, 0), openSessions: sessions.filter((s) => s.status !== "complete").length },
      };
    });
  }

  upsertFile(owner: string, file: FileRecord): Promise<FileRecord> {
    return this.tx((d) => {
      const existing = this.owned(d, owner).find((f) => f.fingerprint === file.fingerprint && f.name === file.name);
      if (existing) return pub(existing);
      d.files[file.id] = { ...file, ownerId: owner };
      return { ...file };
    });
  }

  createSession(s: UploadSession): Promise<void> {
    return this.tx((d) => void (d.sessions[s.id] = copySession(s)));
  }

  touchSession(id: string, owner: string, name: string, expiresAt: number): Promise<void> {
    return this.tx((d) => {
      const s = d.sessions[id];
      if (s && s.ownerId === owner) Object.assign(s, { name, expiresAt });
    });
  }

  getSession(id: string, now: number): Promise<UploadSession | null> {
    return this.read((d) => {
      const s = d.sessions[id];
      return s && s.expiresAt > now ? copySession(s) : null;
    });
  }

  claimSession(id: string, owner: string, now: number): Promise<ClaimResult> {
    return this.tx((d): ClaimResult => {
      const s = d.sessions[id];
      if (!s || s.ownerId !== owner || s.expiresAt <= now) return { outcome: "missing" };
      if (s.status === "open") {
        s.status = "assembling";
        return { outcome: "claimed", session: copySession(s) };
      }
      const f = s.fileId ? d.files[s.fileId] : undefined;
      if (s.status === "complete" && f && f.ownerId === owner) return { outcome: "complete", file: pub(f) };
      if (s.status === "assembling") return { outcome: "assembling" };
      return { outcome: "missing" };
    });
  }

  finalizeSession(id: string, owner: string, file: FileRecord, keepUntil: number): Promise<FileRecord> {
    return this.tx((d) => {
      const existing = this.owned(d, owner).find((f) => f.fingerprint === file.fingerprint && f.name === file.name);
      const saved = existing ?? (d.files[file.id] = { ...file, ownerId: owner });
      const s = d.sessions[id];
      if (s && s.ownerId === owner) Object.assign(s, { status: "complete", fileId: saved.id, expiresAt: keepUntil });
      return pub(saved);
    });
  }

  reopenSession(id: string): Promise<void> {
    return this.tx((d) => {
      const s = d.sessions[id];
      if (s?.status === "assembling") s.status = "open";
    });
  }

  deleteSession(id: string, owner: string): Promise<boolean> {
    return this.tx((d) => {
      const s = d.sessions[id];
      if (!s || s.ownerId !== owner || s.status === "complete") return false;
      delete d.sessions[id];
      return true;
    });
  }

  deleteExpiredSessions(now: number): Promise<string[]> {
    return this.tx((d) => {
      const ids = Object.values(d.sessions)
        .filter((s) => s.expiresAt <= now)
        .map((s) => s.id);
      for (const id of ids) delete d.sessions[id];
      return ids;
    });
  }

  getFile(owner: string, id: string): Promise<FileRecord | null> {
    return this.read((d) => {
      const f = d.files[id];
      return f && f.ownerId === owner ? pub(f) : null;
    });
  }

  listFiles(owner: string, { limit, cursor }: { limit: number; cursor?: string | null }): Promise<FilePage> {
    return this.read((d) => {
      const all = this.owned(d, owner).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
      const c = decodeCursor(cursor);
      const after = c ? all.filter((f) => f.createdAt < c.createdAt || (f.createdAt === c.createdAt && f.id < c.id)) : all;
      const files = after.slice(0, limit).map(pub);
      return {
        files,
        totals: { count: all.length, bytes: all.reduce((n, f) => n + f.size, 0) },
        nextCursor: after.length > limit ? encodeCursor(files[files.length - 1]) : null,
      };
    });
  }

  deleteFile(owner: string, id: string): Promise<{ fingerprint: string; orphaned: boolean } | null> {
    return this.tx((d) => {
      const f = d.files[id];
      if (!f || f.ownerId !== owner) return null;
      delete d.files[id];
      for (const s of Object.values(d.sessions)) if (s.fileId === id) s.fileId = null;
      return { fingerprint: f.fingerprint, orphaned: !Object.values(d.files).some((o) => o.fingerprint === f.fingerprint) };
    });
  }

  isReferenced(fingerprint: string): Promise<boolean> {
    return this.read((d) => Object.values(d.files).some((f) => f.fingerprint === fingerprint));
  }
}
