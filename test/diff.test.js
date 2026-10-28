import { test } from "node:test";
import assert from "node:assert/strict";
import { lineDiff, foldSame, changeCounts, gitRows } from "../web/diff.js";

const kinds = (rows) => rows.map((r) => (r.t === "skip" ? "k" : r.t[0])).join("");

test("an edit shows only the lines that changed as removed and added", () => {
  const rows = lineDiff("a\nb\nc\n", "a\nB\nc\n");
  assert.deepEqual(rows, [{ t: "same", text: "a" }, { t: "del", text: "b" }, { t: "add", text: "B" }, { t: "same", text: "c" }]);
  assert.equal(kinds(lineDiff("", "x\ny")), "aa", "a new file is all added");
  assert.equal(kinds(lineDiff("x\ny", "")), "dd", "a cleared text is all removed");
  assert.equal(kinds(lineDiff("a\nc", "a\nb\nc")), "sas", "an inserted line");
});

test("long unchanged stretches fold, keeping three lines of context", () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
  const after = before.replace("l10", "L10");
  const folded = foldSame(lineDiff(before, after));
  assert.equal(kinds(folded), "ksssdasssk", "skip, context, the change, context, skip");
  assert.deepEqual(folded[0], { t: "skip", count: 7 }, "the start folds to the context");
  assert.equal(folded.filter((r) => r.t === "same").length, 6);
  assert.deepEqual(folded[folded.length - 1], { t: "skip", count: 6 });
});

test("counts add up across a change's edits, and huge edits still come back", () => {
  assert.deepEqual(changeCounts({ edits: [{ old: "a\nb", new: "a\nc\nd" }, { old: "", new: "x" }] }), { add: 3, del: 1 });
  assert.deepEqual(changeCounts(null), { add: 0, del: 0 });
  const big = Array.from({ length: 600 }, (_, i) => `x${i}`).join("\n");
  const rows = lineDiff(big, big + "\nmore");
  assert.equal(rows.length, 1201, "past the limit: all removed, then all added");
});

test("a git diff's lines carry their numbers: new for added and unchanged, old for removed", () => {
  const text = [
    "diff --git a/x.tsx b/x.tsx", "index 1..2 100644", "--- a/x.tsx", "+++ b/x.tsx",
    "@@ -85,4 +85,4 @@ async function Loaded() {", " <div>", "-  <section a>", "+  <section b>", "+  <hr>", " </div>",
    "\\ No newline at end of file",
    "@@ -120 +121 @@", "-old", "+new",
  ].join("\n");
  assert.deepEqual(gitRows(text), [
    { t: "hunk", text: "async function Loaded() {" },
    { t: "same", n: 85, text: "<div>" },
    { t: "del", n: 86, text: "  <section a>" },
    { t: "add", n: 86, text: "  <section b>" },
    { t: "add", n: 87, text: "  <hr>" },
    { t: "same", n: 88, text: "</div>" },
    { t: "hunk", text: "" },
    { t: "del", n: 120, text: "old" },
    { t: "add", n: 121, text: "new" },
  ]);
  assert.deepEqual(gitRows(""), []);
});
