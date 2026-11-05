import "server-only";
import path from "node:path";
import { UPLOAD_DIR, singleton } from "../core";
import { neonExecutor } from "../db/executor";
import { JsonStore } from "./json";
import { PostgresStore } from "./postgres";
import type { MetadataStore } from "./types";

/**
 * DATABASE_URL set   -> Postgres (Neon) over HTTP.
 * DATABASE_URL unset -> JSON file in UPLOAD_DIR (zero-config local dev).
 */
export function getStore(): MetadataStore {
  return singleton("store", () => {
    const url = process.env.DATABASE_URL;
    if (url) return new PostgresStore(neonExecutor(url));
    return new JsonStore(path.join(UPLOAD_DIR, "db.json"));
  });
}

export type { MetadataStore } from "./types";
