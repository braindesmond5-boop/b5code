// The Files tab: a project's folders and files, one folder at a time, a file
// to read, and finding a file by name. Every path is relative to the work
// folder (the project's, or a branch thread's worktree) and must stay inside
// it, symlinks included.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { realPath, within } from "./platform.js";

export const READ_MAX = 512 * 1024; // larger files open truncated
const LIST_MAX = 2000;

/** The real path of `rel` inside `root`, or null if it would leave it. */
export function inside(root, rel = "") {
  let realRoot, target;
  try { realRoot = realPath(root); } catch { return null; }
  const asked = path.resolve(realRoot, String(rel).replace(/^[\\/]+/, ""));
  // Outside before links are followed: never looked at (on Windows, a share on another computer would be asked).
  if (!within(asked, realRoot)) return null;
  try { target = realPath(asked); } catch { return null; }
  return within(target, realRoot) ? target : null;
}

function git(args, cwd, input) {
  return new Promise((resolve) => {
    const p = execFile("git", args, { cwd, maxBuffer: 16 << 20, timeout: 10000 }, (err, out) => resolve(err && !out ? null : out));
    if (input != null) { p.stdin.on("error", () => {}); p.stdin.end(input); }
  });
}

/** One folder's entries: folders first, then files, with git-ignored ones marked. */
export async function listFolder(root, rel = "") {
  const dir = inside(root, rel);
  if (!dir) throw Object.assign(new Error("That folder isn't in this project."), { status: 404 });
  const realRoot = realPath(root);
  const entries = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name === ".git" || d.name === ".DS_Store") continue;
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) { try { isDir = fs.statSync(path.join(dir, d.name)).isDirectory(); } catch { continue; } }
    // "/" between folders, as git writes them (and so on Windows too): the page and git share these.
    entries.push({ name: d.name, path: path.relative(realRoot, path.join(dir, d.name)).split(path.sep).join("/"), dir: isDir });
  }
  entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
  const shown = entries.slice(0, LIST_MAX);
  // Which of them git ignores (node_modules, build output): shown dimmed.
  const ignored = await git(["check-ignore", "--stdin", "-z"], realRoot, shown.map((e) => e.path + (e.dir ? "/" : "")).join("\0"));
  const set = new Set(String(ignored || "").split("\0").filter(Boolean).map((p) => p.replace(/\/$/, "")));
  return { path: path.relative(realRoot, dir).split(path.sep).join("/"), entries: shown.map((e) => (set.has(e.path) ? { ...e, ignored: true } : e)), more: Math.max(0, entries.length - LIST_MAX) };
}

/** A file to read: its text (cut at READ_MAX), or that it isn't text. */
export function readFile(root, rel) {
  const file = inside(root, rel);
  if (!file) throw Object.assign(new Error("That file isn't in this project."), { status: 404 });
  const st = fs.statSync(file);
  if (st.isDirectory()) throw Object.assign(new Error("That's a folder."), { status: 400 });
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(st.size, READ_MAX));
    fs.readSync(fd, buf, 0, buf.length, 0);
    // A NUL byte in the first 8 KB: an image, a binary, not something to read as text.
    if (buf.subarray(0, 8192).includes(0)) return { path: rel, size: st.size, binary: true };
    return { path: rel, size: st.size, text: buf.toString("utf8"), truncated: st.size > READ_MAX };
  } finally {
    fs.closeSync(fd);
  }
}

/** Every file of the project (git's list where there is one, ignored files left out). */
export async function allFiles(root) {
  const out = await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], root);
  if (out != null) return [...new Set(out.split("\0").filter(Boolean))];
  // Not a Git repo: walk it, skipping the usual heavy folders.
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 12 || files.length > 20000) return;
    for (const d of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (d.name.startsWith(".") || d.name === "node_modules") continue;
      const rel = dir ? `${dir}/${d.name}` : d.name;
      if (d.isDirectory()) walk(rel, depth + 1); else files.push(rel);
    }
  };
  try { walk("", 0); } catch { /* unreadable */ }
  return files;
}

/** Files whose path matches every letter of `query` in order, best first. Pure. */
export function findFiles(files, query, limit = 50) {
  const q = String(query || "").toLowerCase().replace(/\s+/g, "");
  if (!q) return [];
  const scored = [];
  for (const f of files) {
    const s = score(f.toLowerCase(), q);
    if (s != null) scored.push([s, f]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length).slice(0, limit).map(([, f]) => f);
}

// Lower is better: a match in the file's name beats one spread across the path.
function score(path, q) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const at = name.indexOf(q);
  if (at >= 0) return at;
  if (path.includes(q)) return 100 + path.indexOf(q);
  let i = 0, gaps = 0, last = -1;
  for (let j = 0; j < path.length && i < q.length; j++) {
    if (path[j] === q[i]) { if (last >= 0) gaps += j - last - 1; last = j; i++; }
  }
  return i === q.length ? 1000 + gaps : null;
}
