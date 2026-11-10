"use client";

/**
 * Ensures this browser holds its signed identity cookie before any other API
 * call. One request per page load; concurrent callers share it, so two
 * first-time requests can never mint two identities.
 */
let pending: Promise<void> | null = null;

export function ensureSession(force = false): Promise<void> {
  if (!pending || force) {
    pending = fetch("/api/session", { credentials: "same-origin", cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(res.status === 429 ? "Too many new sessions from your network. Try again later." : `Session error ${res.status}`);
      })
      .catch((err) => {
        pending = null;
        throw err;
      });
  }
  return pending;
}
