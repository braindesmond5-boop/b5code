// Reading `git status`, `git diff` and `git log` for the Changes pane. All
// are asked for with -z (NUL-separated, nothing quoted), so a path with
// spaces or accents comes through as it is, and a rename names its new path.
// Pure, tested in test/git.test.js.

/** `git status --porcelain=v1 -z` → [{ status, file, from? }] */
export function parseStatus(out) {
  const parts = String(out || "").split("\0");
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const item = { status: status.trim() || "?", file: entry.slice(3) };
    // A rename or copy is followed by the path it came from.
    if (status[0] === "R" || status[0] === "C") item.from = parts[++i];
    files.push(item);
  }
  return files;
}

/** `git diff --numstat -z` → Map(path → { add, del }); a rename counts under its new path. */
export function parseNumstat(out) {
  const parts = String(out || "").split("\0");
  const stats = new Map();
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    let file = m[3];
    if (file === "") { i += 2; file = parts[i]; } // rename: "add\tdel\t", then old, then new
    if (file) stats.set(file, { add: m[1] === "-" ? "" : m[1], del: m[2] === "-" ? "" : m[2] });
  }
  return stats;
}

/** `git diff --name-status -z <base>` → [{ status, file, from? }]; a rename names its new path. */
export function parseNameStatus(out) {
  const parts = String(out || "").split("\0");
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const status = code[0];
    if (status === "R" || status === "C") { const from = parts[++i], file = parts[++i]; if (file) files.push({ status, file, from }); }
    else { const file = parts[++i]; if (file) files.push({ status, file }); }
  }
  return files;
}

/** `git log --format=%h%x1f%s%x1f%ct -z` → [{ sha, subject, at }] */
export function parseLog(out) {
  return String(out || "").split("\0").filter(Boolean).map((rec) => {
    const [sha, subject = "", at = "0"] = rec.split("\x1f");
    return { sha: sha.trim(), subject, at: Number(at) * 1000 };
  });
}

/**
 * `git diff <since> -- <files…>` split back into each file's own diff, by the
 * path in its header: { path: text }. A path git had to quote (a tab or quote
 * in its name) is left out, to be asked for on its own.
 */
export function splitDiff(out) {
  const diffs = {};
  for (const chunk of String(out || "").split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith("diff --git ")) continue;
    const file = /^\+\+\+ b\/(.+)$/m.exec(chunk)?.[1] // added or changed
      ?? /^--- a\/(.+)$/m.exec(chunk)?.[1] // deleted
      ?? /^diff --git a\/(.+) b\/\1$/m.exec(chunk)?.[1]; // no lines: binary, or only its mode changed
    if (file && !file.startsWith('"')) diffs[file] = chunk;
  }
  return diffs;
}

/**
 * The commits a chat (or a turn) made itself, of those under HEAD since it
 * began: committed after it started. A `git pull` brings in commits made
 * elsewhere, earlier; they're under HEAD now, but they aren't its work.
 * (A minute's slack for a clock that's a little off.)
 */
export function ownCommits(commits, startedAt) {
  if (!startedAt) return commits;
  return commits.filter((c) => c.at >= startedAt - 60000);
}
