import { test } from "node:test";
import assert from "node:assert/strict";
import { testResult, commitFrom, pushed, commandReceipt, testsLabel, testsChange } from "../web/receipt.js";
import { emptyFeed, apply } from "../web/feed.js";
import { resultPreview } from "../server/events.js";

test("test runs are read from the summary each tool prints", () => {
  assert.deepEqual(testResult("npm test", "✔ a\nℹ tests 166\nℹ pass 166\nℹ fail 0\nℹ cancelled 0"), { passed: 166, failed: 0, ok: true });
  assert.deepEqual(testResult("npx jest", "Tests:       1 failed, 40 passed, 41 total\nTime: 2s", false), { passed: 40, failed: 1, ok: false });
  assert.deepEqual(testResult("pytest -q", "..F\n==== 1 failed, 12 passed in 0.31s ====", false), { passed: 12, failed: 1, ok: false });
  assert.deepEqual(testResult("npx vitest run", " Tests  42 passed (42)\n Duration 1s"), { passed: 42, failed: 0, ok: true });
  assert.deepEqual(testResult("npx mocha", "  40 passing (2s)\n  2 failing", false), { passed: 40, failed: 2, ok: false });
  assert.deepEqual(testResult("cargo test", "test result: ok. 12 passed; 0 failed; 0 ignored"), { passed: 12, failed: 0, ok: true });
  assert.deepEqual(testResult("go test ./...", "ok  pkg 0.1s"), { passed: null, failed: null, ok: true });
  assert.equal(testResult("ls -la", "3 passed"), null);
});

test("a commit and a push, from git's own output", () => {
  assert.deepEqual(commitFrom('git commit -q -F - <<EOF', "[main d8f9e0b] Changes pane: committed work shows\n 5 files changed"), { branch: "main", sha: "d8f9e0b", subject: "Changes pane: committed work shows" });
  assert.deepEqual(commitFrom("git commit -m x", "[main (root-commit) 1a2b3c4] x"), { branch: "main", sha: "1a2b3c4", subject: "x" });
  assert.equal(commitFrom("git log", "[main d8f9e0b] x"), null);
  assert.equal(pushed("git push origin main", true), true);
  assert.equal(pushed("git push", false), false);
  assert.equal(pushed("npm run push-notes", true), false);
});

test("a turn's receipt: tests compared with the run before, commits, a failed command's output", () => {
  const f = emptyFeed();
  const bash = (id, command, result, ok = true) => [
    { kind: "tool", id, name: "Bash", summary: command, detail: command },
    { kind: "tool_result", id, ok, preview: result },
  ];
  for (const ev of [{ kind: "user", text: "a" }, ...bash("t1", "npm test", "ℹ pass 41\nℹ fail 0"), { kind: "done", ok: true }]) apply(f, ev);
  for (const ev of [
    { kind: "user", text: "b" },
    ...bash("l", "npm run lint", "src/a.js\n  3:1 error  no-undef", false),
    ...bash("t2", "npm test", "ℹ pass 43\nℹ fail 0"),
    ...bash("c", "git commit -m 'Fix login'", "[main a1b2c3d] Fix login"),
    ...bash("p", "git push", "To github.com:x/y.git"),
    { kind: "done", ok: true },
  ]) apply(f, ev);
  const r = f.items.at(-1);
  assert.equal(r.type, "recap");
  assert.deepEqual(r.tests, { passed: 43, failed: 0, ok: true });
  assert.equal(testsChange(r.tests, r.testsBefore), "+2");
  assert.equal(testsLabel(r.tests), "43 passed");
  assert.deepEqual(r.commits, [{ branch: "main", sha: "a1b2c3d", subject: "Fix login" }]);
  assert.equal(r.pushed, true);
  assert.equal(r.ran.length, 4);
  assert.equal(r.ran[0].ok, false);
  assert.match(r.ran[0].output, /no-undef/);
});

test("the receipt sees a long run's summary: a preview keeps the end", () => {
  const long = "x\n".repeat(3000) + "ℹ pass 9\nℹ fail 1";
  const p = resultPreview(long);
  assert.ok(p.length < 2000);
  assert.deepEqual(testResult("npm test", p, false), { passed: 9, failed: 1, ok: false });
  assert.deepEqual(commandReceipt([]), { commands: [], commits: [], tests: null, pushed: false });
});

test("the server's list of a turn's commits wins over reading git's output", () => {
  const f = emptyFeed();
  for (const ev of [
    { kind: "user", text: "commit it" },
    { kind: "tool", id: "c", name: "Bash", summary: "Commit", detail: "git commit -q -m x && git log --oneline -2" },
    { kind: "tool_result", id: "c", ok: true, preview: "a1b2c3d x\n9f8e7d6 older" },
    { kind: "done", ok: true, commits: [{ sha: "a1b2c3d", subject: "x", branch: "main" }] },
  ]) apply(f, ev);
  const r = f.items.at(-1);
  assert.equal(r.type, "recap", "a turn that only committed still gets a receipt");
  assert.deepEqual(r.commits, [{ sha: "a1b2c3d", subject: "x", branch: "main" }]);
});

test("a turn's commits arrive just after it ends, onto its receipt", () => {
  const edit = { kind: "tool", id: "e1", name: "Edit", summary: "Edit a.js", change: { file: "/p/a.js", edits: [{ old: "a", new: "b" }] } };
  let f = [{ kind: "user", text: "Fix it" }, edit, { kind: "tool_result", id: "e1", ok: true }, { kind: "done", ok: true, durationMs: 5000 }].reduce(apply, emptyFeed());
  f = apply(f, { kind: "commits", commits: [{ sha: "abc1234", subject: "Fix it", branch: "main" }] });
  const recaps = f.items.filter((it) => it.type === "recap");
  assert.equal(recaps.length, 1);
  assert.deepEqual(recaps[0].commits.map((c) => c.sha), ["abc1234"]);
  // A turn whose only work was a commit gets a receipt when its commits come.
  let g = [{ kind: "user", text: "Commit" }, { kind: "done", ok: true, durationMs: 900 }].reduce(apply, emptyFeed());
  assert.equal(g.items.filter((it) => it.type === "recap").length, 0);
  g = apply(g, { kind: "commits", commits: [{ sha: "def5678", subject: "Commit", branch: "main" }] });
  assert.deepEqual(g.items.filter((it) => it.type === "recap").map((r) => r.commits[0].sha), ["def5678"]);
});
