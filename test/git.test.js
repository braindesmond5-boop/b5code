import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseStatus, parseNumstat, parseNameStatus, parseLog, splitDiff, ownCommits } from "../server/git.js";

test("paths with spaces and accents, and renames, come through as they are", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b5-git-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString();
  try {
    git("init", "--quiet"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
    fs.writeFileSync(path.join(root, "old name.txt"), "a\nb\nc\nd\n");
    fs.writeFileSync(path.join(root, "keep.txt"), "1\n");
    git("add", "."); git("commit", "--quiet", "-m", "one");
    git("mv", "old name.txt", "new name.txt");
    fs.writeFileSync(path.join(root, "keep.txt"), "1\n2\n");
    fs.writeFileSync(path.join(root, "café plan.html"), "x");

    const files = parseStatus(git("status", "--porcelain=v1", "-z", "-uall"));
    const by = Object.fromEntries(files.map((f) => [f.file, f]));
    assert.deepEqual(Object.keys(by).sort(), ["café plan.html", "keep.txt", "new name.txt"]);
    assert.equal(by["new name.txt"].status, "R");
    assert.equal(by["new name.txt"].from, "old name.txt");
    assert.equal(by["café plan.html"].status, "??");

    const stats = parseNumstat(git("diff", "--numstat", "-z", "HEAD"));
    assert.deepEqual(stats.get("keep.txt"), { add: "1", del: "0" });
    assert.ok(stats.has("new name.txt"), "the rename counts under its new name");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("binary files and empty output", () => {
  assert.deepEqual(parseNumstat("-\t-\tlogo.png\0"), new Map([["logo.png", { add: "", del: "" }]]));
  assert.deepEqual(parseStatus(""), []);
});

test("since a chat began: committed work and the commits that made it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b5-git-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString();
  try {
    git("init", "--quiet"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
    fs.writeFileSync(path.join(root, "old name.txt"), "a\nb\nc\nd\n");
    fs.writeFileSync(path.join(root, "gone.txt"), "x\n");
    git("add", "."); git("commit", "--quiet", "-m", "start");
    const base = git("rev-parse", "HEAD").trim();
    git("mv", "old name.txt", "new name.txt");
    git("rm", "--quiet", "gone.txt");
    fs.writeFileSync(path.join(root, "café.txt"), "1\n");
    git("add", "."); git("commit", "--quiet", "-m", "Claude's work, committed");
    fs.writeFileSync(path.join(root, "café.txt"), "1\n2\n");

    const by = Object.fromEntries(parseNameStatus(git("diff", "--name-status", "-z", base)).map((f) => [f.file, f]));
    assert.deepEqual(Object.keys(by).sort(), ["café.txt", "gone.txt", "new name.txt"]);
    assert.equal(by["new name.txt"].status, "R");
    assert.equal(by["new name.txt"].from, "old name.txt");
    assert.equal(by["gone.txt"].status, "D");
    assert.equal(by["café.txt"].status, "A");

    const commits = parseLog(git("log", "--format=%h%x1f%s%x1f%ct", "-z", `${base}..HEAD`));
    assert.equal(commits.length, 1);
    assert.equal(commits[0].subject, "Claude's work, committed");
    assert.match(commits[0].sha, /^[0-9a-f]{7,}$/);
    assert.ok(commits[0].at > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("no commits and no changes", () => {
  assert.deepEqual(parseNameStatus(""), []);
  assert.deepEqual(parseLog(""), []);
});

test("one diff of several files splits back into each file's", () => {
  const out = [
    "diff --git a/web/app.js b/web/app.js", "index 1..2 100644", "--- a/web/app.js", "+++ b/web/app.js", "@@ -1 +1 @@", "-a", "+b",
    "diff --git a/old.txt b/old.txt", "deleted file mode 100644", "index 3..0", "--- a/old.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-gone",
    "diff --git a/logo.png b/logo.png", "index 4..5 100644", "Binary files a/logo.png and b/logo.png differ",
    "diff --git a/my file.md b/my file.md", "--- a/my file.md", "+++ b/my file.md", "@@ -1 +1 @@", "-x", "+y",
    'diff --git "a/tab\\there" "b/tab\\there"', '--- "a/tab\\there"', '+++ "b/tab\\there"', "@@ -1 +1 @@", "-1", "+2", "",
  ].join("\n");
  const d = splitDiff(out);
  assert.deepEqual(Object.keys(d), ["web/app.js", "old.txt", "logo.png", "my file.md"], "a quoted path is asked for on its own");
  assert.ok(d["web/app.js"].startsWith("diff --git a/web/app.js") && d["web/app.js"].endsWith("+b\n"));
  assert.match(d["old.txt"], /^-gone$/m);
  assert.deepEqual(splitDiff(""), {});
});

test("a chat's own commits leave out what a pull brought in", () => {
  const start = Date.parse("2026-10-26T19:05:00Z");
  const log = [
    { sha: "3d53b46", subject: "Merge pull request #5", at: Date.parse("2026-10-26T19:54:00Z") },
    { sha: "7d28070", subject: "Import review fixes", at: Date.parse("2026-10-26T19:54:00Z") },
    { sha: "8d51d74", subject: "Import: emails (work in progress)", at: Date.parse("2026-10-23T02:49:00Z") },
    { sha: "34fb6ae", subject: "Merge pull request #1", at: Date.parse("2026-10-20T23:36:00Z") },
  ];
  assert.deepEqual(ownCommits(log, start).map((c) => c.sha), ["3d53b46", "7d28070"]);
  assert.equal(ownCommits(log, 0).length, 4, "no start known: all of them");
  assert.equal(ownCommits([{ sha: "a", at: start - 30000 }], start).length, 1, "a clock a little off");
});
