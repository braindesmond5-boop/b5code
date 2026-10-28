import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { repoRoot, snapshot, snapshotSoon, changes, restore, forget } from "../server/checkpoints.js";

function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "b5-cp-")));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString();
  git("init", "--quiet", "-b", "main"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules\n.env\n");
  fs.writeFileSync(path.join(root, "a.txt"), "one\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/b.js"), "export const b = 1;\n");
  git("add", "."); git("commit", "--quiet", "-m", "first");
  return { root, git, index: path.join(root, ".git", "b5-test.index"), done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const read = (root, f) => fs.readFileSync(path.join(root, f), "utf8");

test("a rewind puts back what changed, removes what was added, and can itself be undone", async () => {
  const r = repo();
  try {
    assert.equal(await repoRoot(r.root), r.root);
    assert.equal(await repoRoot(os.tmpdir()), null, "not a repository");
    const pre = await snapshot(r.root, r.index, "t1", "1-pre");

    // The turn: edits one file, adds one, deletes one, adds an ignored one.
    fs.writeFileSync(path.join(r.root, "a.txt"), "one\ntwo\n");
    fs.writeFileSync(path.join(r.root, "new file.md"), "hello");
    fs.rmSync(path.join(r.root, "src/b.js"));
    fs.mkdirSync(path.join(r.root, "node_modules")); fs.writeFileSync(path.join(r.root, "node_modules/x.js"), "x");
    fs.writeFileSync(path.join(r.root, ".env"), "SECRET=1");
    const post = await snapshot(r.root, r.index, "t1", "1-post");

    const files = await changes(r.root, pre, post);
    assert.deepEqual(files.map((f) => [f.s, f.path]).sort(), [["A", "new file.md"], ["D", "src/b.js"], ["M", "a.txt"]], "ignored files aren't part of it");
    assert.deepEqual(files.find((f) => f.path === "a.txt"), { s: "M", path: "a.txt", add: "1", del: "0" });

    const back = await restore(r.root, r.index, "t1", pre, "undo-1");
    assert.equal(read(r.root, "a.txt"), "one\n");
    assert.equal(read(r.root, "src/b.js"), "export const b = 1;\n");
    assert.equal(fs.existsSync(path.join(r.root, "new file.md")), false);
    assert.equal(read(r.root, ".env"), "SECRET=1", "ignored files are never touched");
    assert.equal(read(r.root, "node_modules/x.js"), "x");
    assert.deepEqual(back.files.map((f) => f.s).sort(), ["A", "D", "M"].sort());
    assert.match(r.git("status", "--porcelain"), /^\s*$/, "the working folder is as committed: nothing staged or changed behind git's back");
    assert.equal(r.git("branch", "--list").trim(), "* main", "no branch of ours");
    assert.equal(r.git("log", "--oneline").trim().split("\n").length, 1, "the history is untouched");

    // Undo the rewind: how things were just before it comes back, new file and all.
    await restore(r.root, r.index, "t1", back.undo, "undo-2");
    assert.equal(read(r.root, "a.txt"), "one\ntwo\n");
    assert.equal(read(r.root, "new file.md"), "hello");
    assert.equal(fs.existsSync(path.join(r.root, "src/b.js")), false);
  } finally { r.done(); }
});

test("a file you changed yourself between turns comes back too, and paths with odd names work", async () => {
  const r = repo();
  try {
    fs.writeFileSync(path.join(r.root, "café [plan] *.md"), "v1");
    const pre = await snapshot(r.root, r.index, "t2", "1-pre");
    fs.writeFileSync(path.join(r.root, "café [plan] *.md"), "v2");
    fs.writeFileSync(path.join(r.root, "a.txt"), "mine\n");
    await restore(r.root, r.index, "t2", pre, "undo-1");
    assert.equal(read(r.root, "café [plan] *.md"), "v1");
    assert.equal(read(r.root, "a.txt"), "one\n");
  } finally { r.done(); }
});

test("a path that climbs out of the folder is never deleted", async () => {
  const r = repo();
  const outside = path.join(path.dirname(r.root), "b5-cp-outside.txt");
  try {
    fs.writeFileSync(outside, "keep");
    const pre = await snapshot(r.root, r.index, "t3", "1-pre");
    fs.symlinkSync(path.dirname(r.root), path.join(r.root, "link"));
    fs.writeFileSync(path.join(r.root, "src/c.js"), "c");
    await restore(r.root, r.index, "t3", pre, "undo-1");
    assert.equal(fs.existsSync(outside), true);
    assert.equal(fs.existsSync(path.join(r.root, "src/c.js")), false);
  } finally { fs.rmSync(outside, { force: true }); r.done(); }
});

test("checkpoints are kept under refs/b5 and let go with the thread; one that's too slow is given up on", async () => {
  const r = repo();
  try {
    await snapshot(r.root, r.index, "t4", "1-pre");
    await snapshot(r.root, r.index, "t4", "1-post");
    await snapshot(r.root, r.index, "t5", "1-pre");
    assert.equal(r.git("for-each-ref", "refs/b5/t4/").trim().split("\n").length, 2);
    await forget(r.root, "t4", ["1-pre"]);
    assert.equal(r.git("for-each-ref", "refs/b5/t4/").trim().split("\n").length, 1);
    await forget(r.root, "t4");
    assert.equal(r.git("for-each-ref", "refs/b5/t4/").trim(), "");
    assert.equal(r.git("for-each-ref", "refs/b5/t5/").trim().split("\n").length, 1, "another thread's are kept");
    assert.match(await snapshotSoon(r.root, r.index, "t6", "1-pre"), /^[0-9a-f]{40}$/);
    assert.equal(await snapshotSoon("/no/such/folder", r.index, "t6", "x"), null, "no folder: no checkpoint, and no error");
  } finally { r.done(); }
});
