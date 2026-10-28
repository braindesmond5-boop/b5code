import { test } from "node:test";
import assert from "node:assert/strict";
import { nextSteps, endsWithOffer, PROMPTS } from "../web/next-steps.js";

const ids = (steps) => steps.map((s) => s.id);
const at = (g) => ({ git: true, branch: "main", main: "main", dirty: 0, ahead: 0, upstream: true, remote: true, github: true, pr: null, prPrompt: "Open the PR…", ...g });

test("uncommitted work: commit, or commit and push", () => {
  const steps = nextSteps(at({ dirty: 3 }));
  assert.deepEqual(ids(steps), ["commit", "commit-push"]);
  assert.match(steps[0].title, /^3 files aren't committed/);
  assert.equal(steps[1].text, PROMPTS.commitPush);
  assert.deepEqual(ids(nextSteps(at({ dirty: 1, remote: false }))), ["commit"], "nowhere to push");
});

test("committed but not on GitHub: push", () => {
  assert.deepEqual(ids(nextSteps(at({ ahead: 2 }))), ["push"]);
  assert.deepEqual(ids(nextSteps(at({}))), [], "all pushed, on main: nothing to do");
});

test("a branch of its own: open its PR, merge it, then back to main", () => {
  assert.deepEqual(ids(nextSteps(at({ branch: "import" }))), ["open-pr"]);
  assert.deepEqual(ids(nextSteps(at({ branch: "import", dirty: 2 }))), ["commit", "commit-push", "open-pr"]);
  const open = { number: 5, state: "open", canMerge: true };
  const merge = nextSteps(at({ branch: "import", pr: open })).find((s) => s.id === "merge");
  assert.equal(merge.label, "Merge PR #5");
  assert.equal(merge.text, undefined, "B5 Code merges it itself");
  assert.deepEqual(ids(nextSteps(at({ branch: "import", pr: { ...open, canMerge: false } }))), [], "waiting on checks");
  assert.deepEqual(ids(nextSteps(at({ branch: "import", pr: { number: 5, state: "merged" } }))), ["main"]);
  assert.deepEqual(ids(nextSteps(at({ branch: "HEAD" }))), [], "detached: no branch to open a PR for");
  assert.deepEqual(ids(nextSteps(at({ branch: "import", github: false }))), [], "a remote that isn't GitHub: no PRs");
});

test("an offer at the end of a reply gets a yes", () => {
  assert.ok(endsWithOffer("Done.\n\nSay the word and I'll commit it and open a PR."));
  assert.ok(endsWithOffer("All fixed.\n\nWant me to push it?"));
  assert.ok(endsWithOffer("Shall I run the migration?"));
  assert.ok(!endsWithOffer("Want me to explain?\n\nAnyway, it's all pushed and merged."), "an offer further up, already past");
  assert.ok(!endsWithOffer("It's committed and pushed."));
  assert.deepEqual(ids(nextSteps(at({ dirty: 1 }), { offer: true })), ["yes", "commit", "commit-push"]);
  assert.deepEqual(ids(nextSteps({ git: false }, { offer: true })), ["yes"]);
});

test("a Work space's finished task can be saved as a recipe", () => {
  assert.deepEqual(ids(nextSteps({ git: false }, { recipe: true })), ["recipe"]);
  assert.deepEqual(ids(nextSteps({ git: false }, { offer: true, recipe: true })), ["yes", "recipe"]);
});

test("Work and code hand over: build the findings, post about what shipped", () => {
  assert.deepEqual(ids(nextSteps({ git: false }, { recipe: true, build: true })), ["recipe", "build"]);
  assert.deepEqual(ids(nextSteps(at({}), { post: true })), ["post"]);
});
