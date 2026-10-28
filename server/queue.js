// The overnight queue: tasks B5 Code works through unattended, one at a
// time across every project, each as a thread of its own on a branch of its
// own (queue/<n>-<words>, a worktree from a fresh main), on whichever account
// has room. In the morning each task has a report: done (its checks pass),
// checks failing, paused on a question, or stuck.
//
// Nothing risky runs unattended. Edits inside the task's worktree, reading,
// and a short list of commands (tests, builds, git inside the worktree) are
// allowed on the owner's behalf; anything else pauses the task with its
// question in the inbox (and on the phone), and the queue moves on.
// Nothing is ever pushed or merged: Open PR is the owner's, in the morning.
//
// The rules are pure and tested; server/index.js runs them.

import fs from "node:fs";
import path from "node:path";

export const TASK_MINUTES = 45; // a task running longer is stopped and called stuck
export const CHECK_TRIES = 3; // the checks failing this many times: stuck
export const CHECK_MINUTES = 10; // one run of the checks

// ── What runs without asking ────────────────────────────────────────────────

// Claude Code's own list keeping. (No web fetches at night: a page's address can carry
// data out, and a file in the repo could ask for exactly that.)
const QUIET_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "ToolSearch"]);
// Reading: inside the worktree only.
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

// Commands that are always fine (tests, builds, git in the worktree, looking at files): kept as the
// record of what a task is expected to run; the rule itself is NEVER plus the sandbox.
export const SAFE_COMMANDS = [
  /^(npm|pnpm|yarn|bun) (run )?(test|build|lint|typecheck|type-check|check|format:check)\b/,
  /^(npm|pnpm|yarn) (run )?test:[\w:-]+\b/,
  /^npx (tsc|eslint|prettier --check|vitest|jest|playwright test)\b/,
  /^node --test\b/, /^(python3?|py) -m (pytest|unittest)\b/, /^pytest\b/,
  /^go (test|build|vet)\b/, /^cargo (test|build|check|clippy)\b/, /^make (test|check|build|lint)\b/,
  /^git (status|diff|log|show|add|commit|restore|rev-parse|branch --show-current|stash( list| push| pop)?)\b/,
  /^(ls|pwd|cat|head|tail|wc|grep|rg|echo|true|false|which|date|sort|uniq|cut|diff|test|stat|file|tree)\b/, /^\[ /,
  /^sed -n\b/, /^find (?!.*-(delete|exec|ok)\b)/, /^mkdir -p\b/, /^cd\b/,
];
// Never, whatever it starts with.
const NEVER = /\b(sudo|rm|curl|wget|ssh|scp|rsync|chmod|chown|kill|launchctl|osascript|open|install|uninstall|publish|deploy|eval|exec|nc|env|export|source)\b|git (push|reset|clean|checkout|switch|rebase|merge|remote|config|worktree|-c|update-ref|symbolic-ref|tag|replace|notes|reflog|gc|prune|filter-branch|filter-repo|fast-import|fetch|pull|am|cherry-pick|revert)\b|git branch\s+(-[a-zA-Z]*[dDmMcCf]|--(delete|force|move|copy|set-upstream|unset-upstream|edit-description))\b|npm (i|ci|add|update)\b|\bfind\b.*\s-(delete|exec|execdir|ok)\b/;

/** A command line's pieces: split at && || ; | (quotes kept whole). */
export function commandPieces(cmd) {
  const out = [];
  let cur = "", q = null;
  const s = String(cmd || "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if ((c === "&" && s[i + 1] === "&") || (c === "|" && s[i + 1] === "|")) { out.push(cur); cur = ""; i++; continue; }
    if (c === ";" || c === "|" || c === "\n") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((p) => p.trim()).filter(Boolean);
}

/** The real path of `p`, or of its nearest folder that exists (a file about to be made): symlinks followed. */
function realish(p) {
  let cur = p, rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest); } catch { /* not there (yet) */ }
    const up = path.dirname(cur);
    if (up === cur) return p;
    rest = [path.basename(cur), ...rest];
    cur = up;
  }
}

// Inside the worktree, after following symlinks: a link committed in the repo can't carry an edit or read out.
const inside = (dir, file) => {
  if (!file) return false;
  const root = realish(dir), target = realish(path.resolve(dir, String(file)));
  const rel = path.relative(root, target);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
};
// Inside the worktree, but not git's own files or secrets.
const PRIVATE = /(^|\/)(\.git|\.env[^/]*|.*\.(pem|key|p12)|id_rsa[^/]*)$|(^|\/)\.git\//;

/**
 * Whether a queued task may do this without asking. `dir` is the task's
 * worktree. Returns { ok, why } (why: what the owner is asked, if not).
 */
export function queueAllows(tool, input, dir) {
  const i = input || {};
  if (QUIET_TOOLS.has(tool)) return { ok: true };
  if (READ_TOOLS.has(tool)) {
    const where = i.file_path || i.notebook_path || i.path || dir;
    // A Glob's pattern can be a path of its own (/Users/me/**/*.pem).
    if (typeof i.pattern === "string" && /^[~/]|\.\./.test(i.pattern) && !inside(dir, i.pattern.replace(/[*?[{].*$/, "") || ".")) return { ok: false, why: "read files outside its worktree" };
    return inside(dir, where) && !PRIVATE.test(path.relative(dir, path.resolve(dir, where))) ? { ok: true } : { ok: false, why: "read files outside its worktree" };
  }
  if (EDIT_TOOLS.has(tool)) {
    const file = i.file_path || i.notebook_path;
    if (!inside(dir, file)) return { ok: false, why: "edit a file outside its worktree" };
    if (PRIVATE.test(path.relative(dir, path.resolve(dir, file)))) return { ok: false, why: "change a git or secret file" };
    return { ok: true };
  }
  if (tool === "Bash") {
    const cmd = String(i.command || "");
    // Words inside quotes (a commit message) aren't commands; $( and ` run one even inside "…".
    const bare = cmd.replace(/'[^']*'|"[^"]*"/g, "''");
    // A command built at run time ($(…) or `…` outside quotes) could be anything: asked. Inside "…" it's
    // how Claude writes a commit message, and the sandbox holds it either way.
    if (!cmd.trim() || NEVER.test(bare) || /\$\(|`/.test(bare)) return { ok: false, why: "run a command that isn't on the overnight list" };
    // A variable naming home ($HOME) or a bare "cd" (which goes home): the sandbox closes it, but it's asked.
    if (/\$\{?HOME\b|\$\{?USER\b/.test(bare)) return { ok: false, why: "touch files outside its worktree" };
    if (commandPieces(bare).some((p) => /^cd(\s+(~|-)?)?$/.test(p))) return { ok: false, why: "leave its worktree" };
    // Redirects: to /dev/null, to another output (2>&1), or into the worktree (the sandbox holds writes there too).
    for (const m of bare.replace(/\d?>&\d/g, "").matchAll(/(\d?>>?|<)\s*(\S*)/g)) {
      const target = m[2];
      if (!target) return { ok: false, why: "run a command that writes to a file" };
      if (target === "/dev/null" || target === "''") continue;
      if (!inside(dir, target.replace(/^~(?=\/|$)/, "/__home__"))) return { ok: false, why: "write a file outside its worktree" };
    }
    // Every path a command names stays in the worktree (no cat ~/.ssh/…).
    for (const word of bare.split(/\s+/)) {
      const w = word.replace(/^[-\w]+=/, ""); // --file=/x
      if ((/^[~/]/.test(w) || w.includes("..")) && !inside(dir, w.replace(/^~(?=\/|$)/, "/__home__"))) return { ok: false, why: "touch files outside its worktree" };
    }
    // Inside the sandbox (no network, writes only in the worktree, the home folder closed), a command
    // runs unless it's on NEVER: those wait for the owner. A fixed list of allowed commands paused
    // nearly every real task (printf, a ( … ) group), so it only names what's always fine.
    const pieces = commandPieces(cmd);
    if (!pieces.length) return { ok: false, why: "run a command that isn't on the overnight list" };
    // A cd must stay in the worktree.
    for (const p of pieces) if (/^cd\b/.test(p) && !inside(dir, p.replace(/^cd\s*/, "").replace(/^["']|["']$/g, "") || ".")) return { ok: false, why: "leave its worktree" };
    return { ok: true };
  }
  return { ok: false, why: `use ${String(tool || "a tool").replace(/^mcp__[^_]+__/, "")}` };
}

// ── The brief ───────────────────────────────────────────────────────────────

/** What a queued task's Claude is told, around the owner's own words. */
export function overnightBrief({ brief, checks, branch, dir }) {
  return [
    "You're working through B5 Code's overnight queue, on your own: nobody will answer questions until the morning.",
    "",
    "The task:",
    String(brief || "").trim(),
    "",
    "How to work:",
    `- Work only in ${dir}, on its branch ${branch}. Don't touch other folders.`,
    "- Don't push, open a PR, merge or deploy. Don't install packages or use the network unless the task can't be done without it: B5 Code holds those steps for the owner.",
    checks ? `- When you're done, run \`${checks}\` and make it pass.` : "- Run the project's tests if it has them.",
    "- Commit your work on this branch, with clear messages.",
    "- End with a short report: what you changed, what you checked, and anything left undone or uncertain.",
    "If the task can't be done without the owner, say so in the report and stop.",
  ].join("\n");
}

/** The message after the checks failed: what failed, and to fix it. */
export function checksFailedMessage(checks, output, tries) {
  const tail = String(output || "").trim().split("\n").slice(-40).join("\n").slice(-4000);
  return [
    `B5 Code ran \`${checks}\` and it failed (try ${tries} of ${CHECK_TRIES}):`,
    "```",
    tail || "(no output)",
    "```",
    "Fix it, run the checks again, commit, and update your report.",
  ].join("\n");
}

// ── Order ───────────────────────────────────────────────────────────────────

/** The branch for a task: queue/<n>-<a few words>. */
export function queueBranch(n, brief) {
  const words = String(brief || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 5).join("-").slice(0, 32).replace(/-+$/, "");
  return `queue/${n}-${words || "task"}`;
}

/**
 * The next task to start, or null: the queue is on (and its start time has
 * come), no task is running (one at a time across every project), and this
 * is the first one waiting, in order.
 */
export function nextTask(queue, now = Date.now()) {
  if (!queue?.on || (queue.startAt && queue.startAt > now)) return null;
  if ((queue.tasks || []).some((t) => t.status === "running")) return null;
  return (queue.tasks || []).find((t) => t.status === "queued") || null;
}

/**
 * What happens when a task's turn has ended: `turn` is { ok, limit }; `check`
 * is the checks' result { ok, output } (null when it has none). Returns the
 * task's new status, and a follow-up message if it carries on.
 */
export function afterTurn(task, turn, check) {
  if (turn.limit) return { status: "running" }; // waiting out a usage limit: it carries on by itself
  if (!turn.ok) return { status: "stuck", why: turn.error || "Claude stopped" };
  if (!check) return { status: "done" };
  if (check.ok) return { status: "done" };
  const tries = (task.checkTries || 0) + 1;
  if (tries >= CHECK_TRIES) return { status: "failing", checkTries: tries, why: `${task.checks} still fails after ${tries} tries` };
  return { status: "running", checkTries: tries, followUp: checksFailedMessage(task.checks, check.output, tries) };
}

/** A task's line in the morning: what came of it, in a word. */
export const STATUS_LABEL = {
  queued: "Waiting", running: "Working", done: "Done", failing: "Checks failing", paused: "Waiting for you",
  stuck: "Stuck", stopped: "Stopped", cancelled: "Removed",
};

// ── The sandbox ─────────────────────────────────────────────────────────────
// Running a project's tests runs the project's code, and a task can edit that
// code (a package.json script, a test, a hook). So whatever a queued task
// runs is boxed in by macOS itself: no network, writes only inside its
// worktree (and temp folders), and the owner's secrets unreadable. Claude's
// own commands run in Claude Code's sandbox; the checks B5 Code runs after a
// turn run under the same rules with sandbox-exec.

export const SECRET_DIRS = [".ssh", ".aws", ".claude", ".config", ".gnupg", ".kube", ".docker", "Library/Keychains"];

// What a task may read in the home folder (everything else there is closed): its worktree and the
// repo's git data, git's own settings, and the caches and toolchains a build or test needs.
const READABLE = [".gitconfig", ".config/git", ".npm", ".nvm", ".cache", "Library/Caches", ".node-gyp", ".bun", ".cargo", ".rustup", "go", ".pyenv", "Library/Python", ".local/bin"];

/**
 * A linked worktree keeps its index in the repo's .git/worktrees/<name> and shares the repo's objects
 * and refs: a commit writes there. Never its hooks or config, which would run or apply in the owner's
 * own checkout, unboxed.
 */
// Only its own branch's records (queue/…): never main's or any other branch's, tag or packed ref.
const gitWrites = ({ gitDir, commonDir }) => (gitDir && commonDir ? [gitDir, ...["objects", "refs/heads/queue", "logs/refs/heads/queue"].map((p) => path.join(commonDir, p))] : []);

/** Claude Code's settings for a queued task's session (--settings): its sandbox, with no way out. */
export function queueSandboxSettings({ home, dataDir, projectDir, worktree, gitDir, commonDir, shared = [] }) {
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true, // no sandbox, no task: never unboxed
      autoAllowBashIfSandboxed: false, // each command still goes through queueAllows (pause on anything else)
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [] },
      filesystem: {
        denyRead: [home, dataDir, ...SECRET_DIRS.map((d) => path.join(home, d)), ...[".env", ".env.local", ".env.development.local", ".env.production"].map((f) => path.join(projectDir, f))],
        allowRead: [worktree, commonDir, ...shared, ...READABLE.map((d) => path.join(home, d))].filter(Boolean),
        allowWrite: gitWrites({ gitDir, commonDir }),
      },
    },
  };
}

/** The folders from `home` down to `p`'s parent: home, home/Desktop, …. */
function above(home, p) {
  const out = [];
  for (let d = path.dirname(p); d.startsWith(home) && d !== path.dirname(d); d = path.dirname(d)) out.push(d);
  return out;
}

const sbQuote = (p) => `"${String(p).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The sandbox-exec profile for running a task's checks in its worktree. (Later rules win.) */
export function checksSandboxProfile({ worktree, home, dataDir, gitDir, commonDir, shared = [] }) {
  return [
    "(version 1)",
    "(allow default)",
    // No network, but local servers (tests often start one) and local sockets.
    "(deny network*)",
    "(allow network* (remote unix-socket))",
    '(allow network-outbound (remote ip "localhost:*"))',
    '(allow network-bind (local ip "localhost:*"))',
    '(allow network-inbound (local ip "localhost:*"))',
    // Writes: the worktree, temp folders, and tool caches only.
    "(deny file-write*)",
    `(allow file-write* (subpath ${sbQuote(worktree)}) ${gitWrites({ gitDir, commonDir }).map((p) => `(subpath ${sbQuote(p)})`).join(" ")} (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/dev") (subpath ${sbQuote(path.join(home, ".npm"))}) (subpath ${sbQuote(path.join(home, "Library/Caches"))}) (subpath ${sbQuote(path.join(home, ".cache"))}))`,
    // The home folder is closed but for the worktree, the repo's git data, git's settings and toolchains;
    // the owner's secrets and B5 Code's own data stay closed whatever else is open.
    `(deny file-read* (subpath ${sbQuote(home)}))`,
    // Git (and node) look at the folders above what they work in: those folders themselves, not what's in them.
    `(allow file-read* ${[...new Set([worktree, commonDir, ...shared].filter(Boolean).flatMap((p) => above(home, p)))].map((d) => `(literal ${sbQuote(d)})`).join(" ")})`,
    `(allow file-read* (literal ${sbQuote(home)}) (subpath ${sbQuote(worktree)}) ${commonDir ? `(subpath ${sbQuote(commonDir)})` : ""} ${shared.map((p) => `(subpath ${sbQuote(p)})`).join(" ")} ${READABLE.map((d) => `(subpath ${sbQuote(path.join(home, d))})`).join(" ")})`,
    `(deny file-read* ${[...SECRET_DIRS.map((d) => path.join(home, d)), dataDir].map((d) => `(subpath ${sbQuote(d)})`).join(" ")})`,
  ].join("\n");
}
