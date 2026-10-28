import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Artifacts, artifactTitle, artifactKind, ARTIFACT } from "../server/artifacts.js";

test("titles come from the page, the document's heading, or the file name", () => {
  assert.equal(artifactTitle("plan.html", "<html><head><title>GPA Goals &amp; plan</title></head>"), "GPA Goals & plan");
  assert.equal(artifactTitle("plan.html", "<body><h1>Home <em>screens</em></h1>"), "Home screens", "no <title>: the first heading");
  assert.equal(artifactTitle("notes.md", "Intro line\n\n## Release notes\n"), "Release notes");
  assert.equal(artifactTitle("logo.svg", "<svg></svg>"), "logo.svg");
  assert.deepEqual(["a.html", "b.svg", "c.md"].map(artifactKind), ["page", "image", "document"]);
  assert.ok(ARTIFACT.test("x.HTM") && !ARTIFACT.test("x.js"));
});

test("each successful write keeps a version; failed or unchanged writes don't", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "b5-art-")));
  try {
    const a = new Artifacts(path.join(root, "store"));
    const page = path.join(root, "proj", "plan.html");
    fs.mkdirSync(path.dirname(page));
    const write = (id, text, ok = true) => {
      a.noteTool({ kind: "tool", id, change: { file: "plan.html" } }, path.join(root, "proj"));
      if (ok) fs.writeFileSync(page, text);
      return a.noteResult({ kind: "tool_result", id, ok });
    };
    const v1 = write("t1", "<title>Plan</title>v1");
    assert.deepEqual([v1.version, v1.versions, v1.title, v1.type, v1.path], [1, 1, "Plan", "page", page]);
    assert.equal(write("t2", "<title>Plan</title>v2").version, 2);
    assert.equal(write("t3", "<title>Plan</title>v2").version, 2, "the same content isn't a new version");
    assert.equal(write("t4", "", false), null, "a failed write saves nothing");
    assert.equal(a.noteResult({ kind: "tool_result", id: "nope", ok: true }), null);
    a.noteTool({ kind: "tool", id: "t5", change: { file: "app.js" } }, root);
    assert.equal(a.noteResult({ kind: "tool_result", id: "t5", ok: true }), null, "not an artifact type");

    assert.deepEqual(a.versions(page).map((x) => x.v), [1, 2]);
    assert.equal(a.read(page, 1).toString(), "<title>Plan</title>v1");
    assert.equal(a.read(page, 9), null);
    assert.equal(a.read(page, "../../etc"), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
