import { HttpError } from "./core";

/** Normalises a user-supplied file name so it is safe to display and to put in headers. */
export function sanitizeName(raw: unknown): string {
  if (typeof raw !== "string") throw new HttpError(400, "bad_name", "File name is required.");
  const cleaned = raw
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\\/]/g, "_")
    .trim();
  const clipped = Array.from(cleaned).slice(0, 200).join("");
  if (!clipped || /^\.+$/.test(clipped)) throw new HttpError(400, "bad_name", "Invalid file name.");
  return clipped;
}

/** Value for Content-Disposition that works in every browser (RFC 6266 + RFC 5987). */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
