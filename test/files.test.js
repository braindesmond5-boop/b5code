import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { inside, listFolder, readFile, allFiles, findFiles } from "../server/files.js";

function project() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "b5-files-")));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  w("src/app/page.tsx", "export default function Page() {}\n");
  w("src/goals.js", "export const x = 1;\n");
  w("README.md", "# Hi\n");
  w("node_modules/lib/index.js", "x");
  w(".gitignore", "node_modules/\n");
  w("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

test("a folder lists folders first, marks ignored ones, and hides .git", async () => {
  const root = project();
  try {
    const top = await listFolder(root, "");
    assert.deepEqual(top.entries.map((e) => e.name), ["node_modules", "src", ".gitignore", "logo.png", "README.md"]);
    assert.equal(top.entries.find((e) => e.name === "node_modules").ignored, true);
    assert.equal(top.entries.find((e) => e.name === "src").ignored, undefined);
    const src = await listFolder(root, "src");
    assert.deepEqual(src.entries.map((e) => e.path), ["src/app", "src/goals.js"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("nothing outside the project can be listed or read, symlinks included", async () => {
  const root = project();
  try {
    fs.symlinkSync("/etc", path.join(root, "etc-link"));
    assert.equal(inside(root, "../"), null);
    assert.equal(inside(root, "/etc/hosts"), null, "an absolute path is taken inside the project, where there's no etc/hosts");
    assert.equal(inside(root, "/src/goals.js"), path.join(root, "src", "goals.js"));
    assert.equal(inside(root, "etc-link/hosts"), null, "a symlink out of the project");
    await assert.rejects(listFolder(root, "../.."), /isn't in this project/);
    assert.throws(() => readFile(root, "../../etc/hosts"), /isn't in this project/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("files read as text, or say they're binary", () => {
  const root = project();
  try {
    assert.equal(readFile(root, "src/goals.js").text, "export const x = 1;\n");
    assert.equal(readFile(root, "logo.png").binary, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("finding a file by name: name matches first, then path, then letters in order", async () => {
  const root = project();
  try {
    const files = await allFiles(root);
    assert.ok(files.includes("src/app/page.tsx") && !files.some((f) => f.startsWith("node_modules")), "git's list, ignored files left out");
    assert.equal(findFiles(files, "goals")[0], "src/goals.js");
    assert.equal(findFiles(files, "app/pa")[0], "src/app/page.tsx");
    assert.equal(findFiles(files, "sgj")[0], "src/goals.js", "letters in order");
    assert.deepEqual(findFiles(files, "zzz"), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
