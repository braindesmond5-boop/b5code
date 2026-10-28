// One branch per thread: a thread can work in its own git worktree, on a
// branch made from a fresh main, so its changes never touch your checkout.
// Then the thread's PR: open, checks, squash-merge, and removing the worktree.
//
// The rules (branch names, where a worktree goes, what PR checks add up to)
// are pure and tested; the git and gh calls below them are thin.

import fs from "node:fs";
import path from "node:path";
import { realPath } from "./platform.js";
import { execFile } from "node:child_process";

// The naming rule is shared with the page, which previews the name as you type.
export { KINDS, branchName, worktreeDir } from "../web/branch-name.js";
import { worktreeDir } from "../web/branch-name.js";

// Settings files git doesn't track, which a fresh checkout needs to run.
export const LOCAL_FILES = [".env", ".env.local", ".env.development.local", "android/local.properties"];

/**
 * What a PR's checks add up to, from gh's statusCheckRollup: CheckRuns have
 * status + conclusion, StatusContexts have a state.
 */
export function checksSummary(rollup) {
  const out = { state: "none", passed: 0, failed: 0, pending: 0, total: 0, failing: [] };
  for (const c of Array.isArray(rollup) ? rollup : []) {
    const name = c.name || c.context || "check";
    let r;
    if (c.__typename === "StatusContext" || ("state" in c && !("status" in c))) {
      r = { SUCCESS: "pass", FAILURE: "fail", ERROR: "fail" }[c.state] || "pending";
    } else if (c.status !== "COMPLETED") {
      r = "pending";
    } else {
      r = ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion) ? "pass" : "fail";
    }
    out.total++;
    if (r === "pass") out.passed++;
    else if (r === "fail") { out.failed++; out.failing.push(name); }
    else out.pending++;
  }
  if (out.total) out.state = out.failed ? "fail" : out.pending ? "pending" : "pass";
  return out;
}

/** gh pr view's JSON, cut down to what the top bar shows. */
export function prSummary(pr) {
  if (!pr || !pr.number) return null;
  const checks = checksSummary(pr.statusCheckRollup);
  const state = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open";
  return {
    number: pr.number, url: pr.url, title: pr.title || "", state, checks,
    // Merging waits for green checks (or none), and for GitHub to say it can.
    canMerge: state === "open" && checks.state !== "fail" && checks.state !== "pending" && pr.mergeable !== "CONFLICTING",
    conflicts: pr.mergeable === "CONFLICTING",
  };
}

/** The message that asks the thread's Claude to open the PR. */
export function openPrPrompt({ branch, template }) {
  // feat/12-…: an issue. (queue/3-… is the overnight queue's own task number, not an issue.)
  const issue = /^(feat|fix|docs)\/(\d+)-/.exec(branch)?.[2];
  return [
    `Open the pull request for this branch (${branch}).`,
    "Commit any work that belongs in it first, staging your own files by path, then push with `git push -u origin HEAD` (a pre-push hook may run lint and tests; fix what it finds).",
    template ? `Open it with \`gh pr create\`, filling in ${template} from what this branch changed.` : "Open it with `gh pr create`, with a clear title and a body that says what changed and how it was checked.",
    issue ? `Put "Closes #${issue}" in the body.` : "",
    "Don't merge it. Reply with the PR's link.",
  ].filter(Boolean).join(" ");
}

// ── git and gh ───────────────────────────────────────────────────────────────

function run(cmd, args, cwd, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error((stderr || stdout || err.message).trim().split("\n").slice(-3).join(" ")), { code: err.code }));
      else resolve(stdout.trim());
    });
  });
}

/** The branch new work starts from: origin's main (or master), freshly fetched; else the local one. */
async function baseRef(dir) {
  for (const name of ["main", "master"]) {
    try {
      await run("git", ["fetch", "--quiet", "origin", name], dir);
      return `origin/${name}`;
    } catch { /* no such remote branch, or offline */ }
  }
  for (const name of ["main", "master"]) {
    try { await run("git", ["rev-parse", "--verify", "--quiet", name], dir); return name; } catch { /* next */ }
  }
  throw new Error("Couldn't find a main branch to start from.");
}

/**
 * Make the worktree for a new branch, with the local settings files copied
 * in. The worktree is a checkout of the whole repo, next to it; `dir` is the
 * project's folder inside it (the same as `root`, unless the project is a
 * folder within a bigger repo).
 */
export async function createWorktree(projectDir, branch, { copyLocal = true } = {}) {
  let top;
  // Real long names on both sides: on Windows git gives C:\Users\runneradmin where Node may keep RUNNER~1.
  try { top = realPath(await run("git", ["rev-parse", "--show-toplevel"], projectDir)); } catch { throw new Error("This project isn't a Git repo."); }
  const sub = path.relative(top, realPath(projectDir));
  const root = worktreeDir(top, branch);
  const dir = sub ? path.join(root, sub) : root;
  if (fs.existsSync(root)) throw new Error(`${root} already exists. Pick another name.`);
  const taken = await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], projectDir).then(() => true, () => false);
  if (taken) throw new Error(`There's already a branch called ${branch}.`);
  // A name used before (say, by a merged PR) would show that old PR as this thread's.
  const remote = await run("git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], projectDir, 20000).catch(() => "");
  if (remote) throw new Error(`${branch} already exists on GitHub. Pick another name.`);
  const base = await baseRef(projectDir);
  // --no-track: the branch pushes to its own name later (git push -u origin HEAD), not to main.
  await run("git", ["worktree", "add", "--no-track", "-b", branch, root, base], projectDir, 120000);
  const copied = [];
  // A queued task's worktree gets no secrets: it works unattended (server/queue.js).
  for (const f of copyLocal ? LOCAL_FILES : []) {
    const from = path.join(projectDir, f);
    if (!fs.existsSync(from)) continue;
    // Only untracked settings: a file the repo tracks comes with the checkout.
    if (await run("git", ["ls-files", "--", f], dir).catch(() => "x")) continue;
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(from, path.join(dir, f));
    copied.push(f);
  }
  return { dir, root, base, copied };
}

/** The PR for this branch, or null when there is none yet. */
export async function prStatus(dir, branch) {
  let out;
  try {
    out = await run("gh", ["pr", "view", branch, "--json", "number,url,title,state,isDraft,mergeable,statusCheckRollup"], dir, 30000);
  } catch (e) {
    if (/no pull requests found|could not find/i.test(e.message)) return null;
    throw new Error(`Couldn't ask GitHub about the PR: ${e.message}`);
  }
  return prSummary(JSON.parse(out));
}

/** Squash-merge the branch's PR, after checking again that it may be merged. */
export async function mergePr(dir, branch) {
  const pr = await prStatus(dir, branch);
  if (!pr) throw new Error("This branch has no PR yet.");
  if (!pr.canMerge) throw new Error(pr.conflicts ? "The PR has conflicts with main." : `The PR can't be merged yet (${pr.state}, checks ${pr.checks.state}).`);
  await run("gh", ["pr", "merge", String(pr.number), "--squash"], dir, 120000);
  return prStatus(dir, branch);
}

/** Remove a merged branch's worktree and its local branch. Refuses if there's uncommitted work. */
export async function removeWorktree(projectDir, dir, branch) {
  const real = (p) => { try { return realPath(p); } catch { return p; } };
  if (real(dir) === real(projectDir)) throw new Error("That's the project's own folder, not a worktree. Nothing was removed.");
  if (fs.existsSync(dir)) {
    // The settings files copied in at the start don't count, even where git doesn't ignore them.
    // If git can't say (busy, broken), nothing is removed.
    let status;
    try { status = await run("git", ["status", "--porcelain", "-uall"], dir); } catch (e) { throw new Error(`Couldn't check the worktree for unsaved work, so it was left alone: ${e.message}`); }
    const copiedIn = (p) => LOCAL_FILES.some((f) => p === f || p.endsWith("/" + f)); // in a subfolder project they sit deeper
    const dirty = status.split("\n").filter((l) => l && !(l.startsWith("?? ") && copiedIn(l.slice(3))));
    if (dirty.length) throw new Error("The worktree has uncommitted changes. Commit or discard them first.");
    await run("git", ["worktree", "remove", "--force", dir], projectDir); // --force: only the copied settings files are left
  } else {
    await run("git", ["worktree", "prune"], projectDir).catch(() => {});
  }
  // A squash-merge leaves the branch looking unmerged to git, so -D; only ever after GitHub says merged.
  await run("git", ["branch", "-D", branch], projectDir).catch(() => {});
}

/** Commits on the branch that are on no remote: work that removing the branch would lose. */
export async function unpushedCommits(projectDir, branch) {
  try {
    const out = await run("git", ["rev-list", branch, "--not", "--remotes"], projectDir);
    return out ? out.split("\n").length : 0;
  } catch {
    return 0; // the branch is already gone
  }
}

/** The PR template's path in the repo, if it has one. */
export function prTemplate(dir) {
  for (const f of [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md", "pull_request_template.md"]) {
    if (fs.existsSync(path.join(dir, f))) return f;
  }
  return null;
}
