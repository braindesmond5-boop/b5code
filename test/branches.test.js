import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { branchName, worktreeDir, checksSummary, prSummary, openPrPrompt, createWorktree, removeWorktree, prTemplate, unpushedCommits } from "../server/branches.js";

test("branch names follow the team's kind/issue-what pattern", () => {
  assert.equal(branchName({ kind: "feat", issue: "12", what: "GPA Goals: the private table!" }), "feat/12-gpa-goals-the-private-table");
  assert.equal(branchName({ kind: "fix", issue: "#7", what: "Dark mode hero" }), "fix/7-dark-mode-hero");
  assert.equal(branchName({ kind: "docs", what: "Café notes" }), "docs/cafe-notes", "no issue, and accents folded");
  assert.ok(branchName({ kind: "feat", what: "a ".repeat(60) }).length <= "feat/".length + 40);
  assert.throws(() => branchName({ kind: "chore", what: "x" }), /Pick one of/);
  assert.throws(() => branchName({ kind: "feat", issue: "twelve", what: "x" }), /number/);
  assert.throws(() => branchName({ kind: "feat", what: "!!!" }), /few words/);
});

test("a worktree goes next to the project, named after the branch", () => {
  assert.equal(worktreeDir("/Users/mac/Desktop/Flaevo", "feat/12-gpa-goals"), "/Users/mac/Desktop/flaevo-feat-12-gpa-goals");
});

test("checks: any failure fails, anything running is pending, otherwise they pass", () => {
  const run = (status, conclusion, name = "checks") => ({ __typename: "CheckRun", name, status, conclusion });
  const ctx = (state) => ({ __typename: "StatusContext", context: "Vercel", state });
  assert.equal(checksSummary([]).state, "none");
  assert.equal(checksSummary(null).state, "none");
  assert.deepEqual(checksSummary([run("COMPLETED", "SUCCESS"), ctx("SUCCESS"), run("COMPLETED", "SKIPPED")]),
    { state: "pass", passed: 3, failed: 0, pending: 0, total: 3, failing: [] });
  assert.equal(checksSummary([run("IN_PROGRESS", ""), ctx("SUCCESS")]).state, "pending");
  assert.equal(checksSummary([ctx("PENDING")]).state, "pending");
  const bad = checksSummary([run("COMPLETED", "FAILURE", "lint"), run("IN_PROGRESS", "")]);
  assert.deepEqual([bad.state, bad.failing], ["fail", ["lint"]]);
  assert.equal(checksSummary([ctx("ERROR")]).state, "fail");
});

test("a PR can be merged only when open, green (or checkless) and without conflicts", () => {
  const green = [{ __typename: "CheckRun", name: "checks", status: "COMPLETED", conclusion: "SUCCESS" }];
  const pr = (over) => prSummary({ number: 34, url: "u", title: "t", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", statusCheckRollup: green, ...over });
  assert.equal(pr().canMerge, true);
  assert.equal(pr({ statusCheckRollup: [] }).canMerge, true, "no checks configured");
  assert.equal(pr({ statusCheckRollup: [{ status: "QUEUED" }] }).canMerge, false);
  assert.equal(pr({ isDraft: true }).state, "draft");
  assert.equal(pr({ isDraft: true }).canMerge, false);
  assert.equal(pr({ mergeable: "CONFLICTING" }).conflicts, true);
  assert.equal(pr({ mergeable: "CONFLICTING" }).canMerge, false);
  assert.equal(pr({ state: "MERGED" }).state, "merged");
  assert.equal(prSummary(null), null);
});

test("the Open PR message names the template and the issue", () => {
  const m = openPrPrompt({ branch: "feat/12-gpa-goals", template: ".github/pull_request_template.md" });
  assert.match(m, /feat\/12-gpa-goals/);
  assert.match(m, /pull_request_template\.md/);
  assert.match(m, /Closes #12/);
  assert.match(m, /Don't merge/);
  assert.doesNotMatch(openPrPrompt({ branch: "docs/notes", template: null }), /Closes/);
});

// A real repo in a temp folder, with a bare "origin", to check the git side.
test("a worktree is made from origin's main with settings copied, and removed after", async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "b5-branches-")));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
  try {
    git(root, "init", "--quiet", "--bare", "-b", "main", "origin.git");
    const proj = path.join(root, "Proj");
    git(root, "clone", "--quiet", path.join(root, "origin.git"), proj);
    git(proj, "config", "user.email", "t@t"); git(proj, "config", "user.name", "t");
    fs.writeFileSync(path.join(proj, "a.txt"), "1");
    fs.mkdirSync(path.join(proj, ".github"));
    fs.writeFileSync(path.join(proj, ".github", "pull_request_template.md"), "## What");
    git(proj, "add", "."); git(proj, "commit", "--quiet", "-m", "one"); git(proj, "push", "--quiet", "origin", "HEAD:main");
    fs.writeFileSync(path.join(proj, ".env.local"), "SECRET=1");
    fs.mkdirSync(path.join(proj, "android")); fs.writeFileSync(path.join(proj, "android", "local.properties"), "sdk.dir=/x");

    const { dir, base, copied } = await createWorktree(proj, "feat/3-thing");
    assert.equal(dir, path.join(root, "proj-feat-3-thing"));
    assert.equal(base, "origin/main");
    assert.deepEqual(copied, [".env.local", "android/local.properties"]);
    assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "feat/3-thing");
    assert.equal(fs.readFileSync(path.join(dir, ".env.local"), "utf8"), "SECRET=1");
    assert.equal(git(proj, "rev-parse", "--abbrev-ref", "HEAD"), "main", "your checkout is untouched");
    assert.equal(prTemplate(dir), ".github/pull_request_template.md");
    await assert.rejects(createWorktree(proj, "feat/3-thing"), /already exists/);

    fs.writeFileSync(path.join(dir, "a.txt"), "changed");
    await assert.rejects(removeWorktree(proj, dir, "feat/3-thing"), /uncommitted/);
    git(dir, "checkout", "--quiet", "a.txt");
    await removeWorktree(proj, dir, "feat/3-thing");
    assert.equal(fs.existsSync(dir), false);
    assert.equal(git(proj, "branch", "--list", "feat/3-thing"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The ways removing or making a worktree could lose work, each refused.
test("worktrees never lose work: tracked settings, unpushed commits, unreadable status, reused names", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b5-safety-"));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
  try {
    git(root, "init", "--quiet", "--bare", "-b", "main", "origin.git");
    const proj = path.join(root, "Proj");
    git(root, "clone", "--quiet", path.join(root, "origin.git"), proj);
    git(proj, "config", "user.email", "t@t"); git(proj, "config", "user.name", "t");
    fs.writeFileSync(path.join(proj, ".env"), "TEMPLATE=1");
    git(proj, "add", "."); git(proj, "commit", "--quiet", "-m", "one"); git(proj, "push", "--quiet", "origin", "HEAD:main");
    fs.writeFileSync(path.join(proj, ".env"), "SECRET=1"); // your local secrets in a tracked file

    const { dir, copied } = await createWorktree(proj, "fix/1-a");
    assert.deepEqual(copied, [], "a tracked .env is not copied over");
    assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), "TEMPLATE=1");

    git(dir, "config", "user.email", "t@t"); git(dir, "config", "user.name", "t");
    fs.writeFileSync(path.join(dir, "b.txt"), "work");
    git(dir, "add", "b.txt"); git(dir, "commit", "--quiet", "-m", "work");
    assert.equal(await unpushedCommits(proj, "fix/1-a"), 1);
    git(dir, "push", "--quiet", "origin", "HEAD:fix/1-a");
    git(proj, "fetch", "--quiet", "origin");
    assert.equal(await unpushedCommits(proj, "fix/1-a"), 0, "pushed work is safe to remove");

    await assert.rejects(createWorktree(proj, "fix/1-a"), /already/);
    fs.rmSync(path.join(root, "proj-fix-1-a"), { recursive: true, force: true });
    git(proj, "worktree", "prune");
    git(proj, "branch", "-D", "fix/1-a");
    await assert.rejects(createWorktree(proj, "fix/1-a"), /already exists on GitHub/, "a name used before on GitHub is refused");

    const { dir: d2 } = await createWorktree(proj, "fix/2-b");
    fs.rmSync(path.join(d2, ".git")); // Git for Windows hides it, and Windows won't overwrite a hidden file
    fs.writeFileSync(path.join(d2, ".git"), "gitdir: /nowhere"); // git can't read it
    await assert.rejects(removeWorktree(proj, d2, "fix/2-b"), /left alone/);
    assert.ok(fs.existsSync(d2), "nothing was removed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a project in a folder of a bigger repo: the worktree is of the whole repo, and the thread works in the same folder inside it", async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "b5-mono-")));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
  try {
    const mono = path.join(root, "Mono");
    fs.mkdirSync(path.join(mono, "apps", "web"), { recursive: true });
    git(mono, "init", "--quiet", "-b", "main"); git(mono, "config", "user.email", "t@t"); git(mono, "config", "user.name", "t");
    fs.writeFileSync(path.join(mono, "apps", "web", "index.js"), "1");
    git(mono, "add", "."); git(mono, "commit", "--quiet", "-m", "one");
    fs.writeFileSync(path.join(mono, "apps", "web", ".env.local"), "S=1");
    const r = await createWorktree(path.join(mono, "apps", "web"), "feat/1-x");
    assert.equal(r.root, path.join(root, "mono-feat-1-x"));
    assert.equal(r.dir, path.join(root, "mono-feat-1-x", "apps", "web"));
    assert.equal(fs.readFileSync(path.join(r.dir, ".env.local"), "utf8"), "S=1", "settings land next to the app, where it looks for them");
    await removeWorktree(mono, r.root, "feat/1-x");
    assert.equal(fs.existsSync(r.root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
