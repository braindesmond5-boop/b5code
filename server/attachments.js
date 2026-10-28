// Files added to a message (the + button, paste, drop). Pure, so tested.
//
// Each file is saved under data/uploads first. When the message is sent,
// images Claude can see go in as image blocks; anything else (a PDF, a
// zip, a large image) goes in as its path, which Claude reads with its own
// tools.

import path from "node:path";

export const UPLOAD_MAX = 25 * 1024 * 1024;
// The API takes images up to 5 MB once base64-encoded, about 3.75 MB raw.
export const IMAGE_INLINE_MAX = Math.floor(3.75 * 1024 * 1024);
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** A file name safe to keep on disk: no folders, no odd characters. */
export function safeName(name) {
  const base = path.basename(String(name || "file")).normalize("NFC");
  const clean = base.replace(/[^\w.\- ()]+/g, "_").replace(/^\.+/, "").slice(-120);
  return clean || "file";
}

/** True when an attachment's path is one Desk saved, not any file on disk. */
export function isUpload(p, uploadsDir) {
  const resolved = path.resolve(String(p || ""));
  return resolved.startsWith(path.resolve(uploadsDir) + path.sep);
}

/**
 * The message content for Claude Code's stream-json input.
 * @param {string} text
 * @param {{path: string, name: string, type: string, size: number}[]} attachments
 * @param {(p: string) => Buffer} readFile
 */
export function buildContent(text, attachments = [], readFile) {
  const files = [];
  const images = [];
  for (const a of attachments) {
    if (IMAGE_TYPES.has(a.type) && a.size <= IMAGE_INLINE_MAX) {
      images.push({ type: "image", source: { type: "base64", media_type: a.type, data: readFile(a.path).toString("base64") } });
    } else {
      files.push(`- ${a.name}: ${a.path}`);
    }
  }
  const body = [String(text || "").trim(), files.length ? `Attached files (read them from these paths):\n${files.join("\n")}` : ""]
    .filter(Boolean).join("\n\n") || (images.length ? "See the attached image." : "");
  if (!images.length) return body;
  return [...images, { type: "text", text: body }];
}
