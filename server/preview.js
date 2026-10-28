// Which files the Preview pane may show, and as what type. Pure, so the
// home-folder fence is tested without a server.

import path from "node:path";
import { IS_WIN, within } from "./platform.js";

export const PREVIEW_TYPES = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".csv": "text/plain; charset=utf-8",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
};

/**
 * The file a preview URL names, or null if it is outside your home folder. On a Mac the URL is the
 * path without its first "/"; on Windows it starts with the drive (C:/Users/…, either slash).
 */
export function previewPath(rest, home, win = IS_WIN) {
  const P = win ? path.win32 : path.posix;
  let p;
  try { p = decodeURIComponent(rest); } catch { return null; }
  if (win ? /^~[\\/]/.test(p) : p.startsWith("~/")) p = P.join(home, p.slice(2));
  else if (!win && !p.startsWith("/")) p = "/" + p;
  else if (win && !/^[A-Za-z]:[\\/]/.test(p)) return null; // a share (\\server\x) or a drive-relative path: never
  const resolved = P.resolve(p);
  return within(resolved, home, win) ? resolved : null;
}


// Types that can't run scripts. Anything else (a page, an SVG) runs code,
// so it is only served under a link locked to its own folder, or sandboxed.
export const PASSIVE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".mp4", ".mov", ".webm", ".mp3", ".wav", ".txt", ".md", ".csv"]);

/**
 * The folder a previewed page may read: its own, with everything under it
 * (its images, scripts, styles). A page right in your home folder (or at
 * the top of the disk) gets only itself, never the whole home folder.
 */
export function previewScope(file, home, win = IS_WIN) {
  const P = win ? path.win32 : path.posix;
  const dir = P.dirname(file);
  // A private file you open yourself is shown on its own, with nothing beside it.
  if (isPrivate(P.basename(file))) return file;
  return within(home, dir, win) || dir === P.dirname(dir) ? file : dir;
}

// Names that hold secrets: keys, certificates, credentials, password stores.
const SECRET_NAME = /^(id_[a-z0-9]+(\.pub)?|.*\.(pem|key|p12|pfx|p8|jks|keystore|crt|cer|der|ovpn|kdbx|gpg|asc)|credentials(\..*)?|.*secret.*|.*service[-_]?account.*\.json|.*\.sqlite3?|.*\.db)$/i;

/**
 * Whether a path inside a page's folder is off limits to the page: anything
 * hidden (a name starting with a dot, like .env.local, .git, .ssh) or named
 * like a secret. A plan page needs its images, scripts and styles, never these.
 */
export function isPrivate(rel) {
  const parts = String(rel).split(/[\\/]/).filter(Boolean);
  return parts.some((p) => p.startsWith(".")) || SECRET_NAME.test(parts[parts.length - 1] || "");
}

/** Whether `file` is `scope` or inside it. */
export const inScope = (file, scope, win = IS_WIN) => within(file, scope, win);
