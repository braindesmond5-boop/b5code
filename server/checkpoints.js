// Checkpoints: the project's files, saved before and after each of Claude's turns, so you can go back.
//
// Each is a git commit of the working folder (everything not ignored), made with an index file of its
// own and kept under refs/b5/<thread>/…: never on your branch, never in your history, and the working
// folder's own index and stash are left alone. Going back restores the files of one checkpoint;
// first it saves how things are now, so a rewind can be undone.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseNameStatus, parseNumstat } from "./git.js";

const SNAP_MS = 5000; // a turn doesn't wait longer than this for its "before"
export const KEEP = 40; // checkpoints kept per thread; the oldest are let go
const NAMED = { GIT_AUTHOR_NAME: "B5 Code", GIT_AUTHOR_EMAIL: "b5code@localhost", GIT_COMMITTER_NAME: "B5 Code", GIT_COMMITTER_EMAIL: "b5code@localhost" };

function run(root, args, { env = {}, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", root, ...args], { timeout, maxBuffer: 16 << 20, env: { ...process.env, ...NAMED, ...env }, windowsHide: true }, (err, out, stderr) => {
      if (err) reject(Object.assign(new Error(String(stderr || err.message).trim().split("\n")[0]), { code: err.code }));
      else resolve(out);
    });
  });
}

/** The top folder of the repository `dir` is in, or null. */
export async function repoRoot(dir) {
  // Git writes C:/Users/me/repo on Windows: made into the path form the rest of B5 Code uses.
  try { const top = (await run(dir, ["rev-parse", "--show-toplevel"], { timeout: 5000 })).trim(); return top ? path.normalize(top) : null; } catch { return null; }
}

const refName = (threadId, name) => `refs/b5/${threadId}/${name}`;

/**
 * The folder as it is now, as a commit under refs/b5/<thread>/<name>. `indexFile` is this thread's
 * own index, kept between snapshots so only what changed is read again. Returns the commit's sha.
 */
export async function snapshot(root, indexFile, threadId, name) {
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  const env = { GIT_INDEX_FILE: indexFile };
  await run(root, ["add", "-A", "--ignore-errors"], { env }).catch((e) => {
    // A file that can't be read (a socket, a permission) isn't a reason to have no checkpoint.
    if (!/unable to|cannot|permission|ignore/i.test(e.message)) throw e;
  });
  const tree = (await run(root, ["write-tree"], { env })).trim();
  const sha = (await run(root, ["commit-tree", tree, "-m", `B5 Code checkpoint ${name}`], { env })).trim();
  await run(root, ["update-ref", refName(threadId, name), sha]);
  return sha;
}

/** `snapshot`, but given up on after SNAP_MS: the turn goes ahead, with no checkpoint, rather than wait. null then. */
export function snapshotSoon(root, indexFile, threadId, name) {
  let late = false;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { late = true; resolve(null); }, SNAP_MS);
    snapshot(root, indexFile, threadId, name).then(
      (sha) => { clearTimeout(timer); if (late) run(root, ["update-ref", "-d", refName(threadId, name)]).catch(() => {}); else resolve(sha); },
      () => { clearTimeout(timer); resolve(null); });
  });
}

/** What differs between two checkpoints: [{ s: "M"|"A"|"D", path, add, del }], `to` as the newer. */
export async function changes(root, from, to) {
  const [names, nums] = await Promise.all([
    run(root, ["diff", "--no-renames", "--name-status", "-z", from, to]),
    run(root, ["diff", "--no-renames", "--numstat", "-z", from, to]),
  ]);
  const stats = parseNumstat(nums);
  return parseNameStatus(names).map((f) => ({ s: f.status, path: f.file, add: stats.get(f.file)?.add ?? "", del: stats.get(f.file)?.del ?? "" }));
}

// A path from git, checked to be inside the folder (never ../ out of it, never through a link).
function inside(root, rel) {
  const full = path.resolve(root, rel);
  const r = path.relative(root, full);
  if (!r || r.startsWith("..") || path.isAbsolute(r)) return null;
  let at = root;
  for (const part of r.split(path.sep).slice(0, -1)) {
    at = path.join(at, part);
    try { if (fs.lstatSync(at).isSymbolicLink()) return null; } catch { return full; } // not there: nothing to follow
  }
  return full;
}

/**
 * Put the folder's files back as they were at `target` (a commit made by `snapshot`). First saves how
 * they are now as `undo-<n>`; returns { files, undo } with the files that changed (as `changes`, from
 * now to the target), and the sha to go back to. Nothing git tracks in the folder is touched but files.
 */
export async function restore(root, indexFile, threadId, target, undoName) {
  const now = await snapshot(root, indexFile, threadId, undoName);
  const files = await changes(root, now, target);
  // From now to the target: "A" is in the target and not here (written back), "M" differs (written back), "D" is here and not in the target (removed).
  const back = files.filter((f) => f.s !== "D").map((f) => f.path);
  for (let i = 0; i < back.length; i += 200) {
    await run(root, ["restore", `--source=${target}`, "--worktree", "--", ...back.slice(i, i + 200).map((p) => `:(literal)${p}`)]);
  }
  for (const f of files.filter((x) => x.s === "D")) {
    const full = inside(root, f.path);
    if (full) try { fs.rmSync(full, { force: true }); } catch { /* left; it's listed anyway */ }
  }
  return { files, undo: now };
}

/** Let the thread's checkpoints go (it was deleted, or some are older than KEEP). `names`: only these; else all. */
export async function forget(root, threadId, names = null) {
  if (!root) return;
  try {
    const refs = (await run(root, ["for-each-ref", "--format=%(refname)", `refs/b5/${threadId}/`], { timeout: 10000 })).split("\n").filter(Boolean);
    for (const r of refs) if (!names || names.includes(r.split("/").pop())) await run(root, ["update-ref", "-d", r], { timeout: 10000 }).catch(() => {});
  } catch { /* nothing to let go */ }
}

/** The files listed for a turn: short, newest-first isn't needed, and a long list is cut. */
export function brief(files, max = 30) {
  return { files: files.slice(0, max), more: Math.max(0, files.length - max) };
}
