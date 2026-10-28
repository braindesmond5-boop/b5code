import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyFeed, apply, stepsHeadline, statusOf, friendlyError, turnOutput, tokensLabel, contextLabel, tasksProgress } from "../web/feed.js";

const run = (events) => events.reduce((f, e) => apply(f, e), emptyFeed());

test("streamed words become one reply, replaced by the final text", () => {
  const f = run([{ kind: "user", text: "Hi" }, { kind: "delta", text: "Hel" }, { kind: "delta", text: "lo" }]);
  assert.equal(f.items[1].text, "Hello");
  assert.equal(f.items[1].live, true);
  apply(f, { kind: "text", text: "Hello there" });
  assert.equal(f.items.length, 2);
  assert.equal(f.items[1].text, "Hello there");
  assert.equal(f.items[1].live, false);
});

test("a replayed log (no deltas) still shows the reply", () => {
  const f = run([{ kind: "user", text: "Hi" }, { kind: "text", text: "Hello" }, { kind: "done", ok: true }]);
  assert.deepEqual(f.items.map((i) => i.type), ["user", "ai"]);
});

test("tool calls in a row are one block, and results land on the right step", () => {
  const f = run([
    { kind: "user", text: "Go" },
    { kind: "tool", id: "a", summary: "Read a.js" },
    { kind: "tool", id: "b", summary: "Read b.js" },
    { kind: "tool_result", id: "a", ok: true, preview: "x" },
    { kind: "tool_result", id: "b", ok: false, preview: "no" },
  ]);
  const block = f.items[1];
  assert.equal(block.type, "steps");
  assert.deepEqual(block.steps.map((s) => s.state), ["ok", "bad"]);
});

test("text between tools splits the blocks", () => {
  const f = run([{ kind: "tool", id: "a", summary: "A" }, { kind: "text", text: "Now B." }, { kind: "tool", id: "b", summary: "B" }]);
  assert.deepEqual(f.items.map((i) => i.type), ["steps", "ai", "steps"]);
});

test("a permission waits until it is answered", () => {
  const f = run([{ kind: "user", text: "Write it" }, { kind: "permission", requestId: "r1", summary: "Wrote out.txt" }]);
  assert.equal(f.waiting, 1);
  assert.equal(statusOf(f).tone, "waiting");
  apply(f, { kind: "permission_answer", requestId: "r1", choice: "allow" });
  assert.equal(f.waiting, 0);
  assert.equal(f.items[1].answer, "allow");
});

test("the end of a turn closes open questions and running steps", () => {
  const f = run([{ kind: "tool", id: "a", summary: "A" }, { kind: "permission", requestId: "r", summary: "W" }, { kind: "done", ok: true }]);
  assert.equal(f.items[0].steps[0].state, "ok");
  assert.equal(f.items[1].answer, "expired");
  assert.equal(f.working, false);
});

test("a failed turn says why, a stopped one just says stopped", () => {
  assert.equal(run([{ kind: "done", ok: false, error: "error_during_execution" }]).items[0].text, "Stopped.");
  assert.equal(run([{ kind: "done", ok: false, error: "Credit balance is too low" }]).items[0].text, "Credit balance is too low");
  assert.equal(friendlyError(""), "Stopped.");
});

test("the closed block reads as a sentence", () => {
  assert.equal(stepsHeadline([{ summary: "Read a" }]), "Read a");
  assert.equal(stepsHeadline([{ summary: "Read a" }, { summary: "Ran tests" }, { summary: "X" }, { summary: "Y" }]), "Read a, Ran tests and 2 more");
});

test("the status line names the running step", () => {
  const f = run([{ kind: "user", text: "Go" }, { kind: "tool", id: "a", summary: "Run the tests" }]);
  assert.deepEqual(statusOf(f), { tone: "working", text: "Working: Run the tests" });
  assert.deepEqual(statusOf(emptyFeed()), { tone: "idle", text: "Ready" });
});

test("model ids read as names", async () => {
  const { modelName } = await import("../web/feed.js");
  assert.equal(modelName("claude-opus-5-5"), "Opus 5.5");
  assert.equal(modelName("claude-sonnet-5-5[1m]"), "Sonnet 5.5 (1M)");
  assert.equal(modelName("claude-fable-5-1"), "Fable 5.1");
  assert.equal(modelName("something-else"), "something-else");
});

test("the working word holds for a few seconds, then moves on, and never runs out", async () => {
  const { workingVerb, WORKING_VERBS, VERB_EVERY_S, elapsedLabel, currentStep } = await import("../web/feed.js");
  assert.equal(workingVerb(0), workingVerb(VERB_EVERY_S - 0.1));
  assert.notEqual(workingVerb(0), workingVerb(VERB_EVERY_S));
  for (let s = 0; s < 3600; s += VERB_EVERY_S) assert.ok(WORKING_VERBS.includes(workingVerb(s, 99)));
  assert.ok(WORKING_VERBS.includes("Skedaddling") && WORKING_VERBS.includes("Flibbertigibbeting") && WORKING_VERBS.includes("Cooking"));
  assert.equal(elapsedLabel(8.7), "8s");
  assert.equal(elapsedLabel(65), "1m 05s");
  assert.equal(elapsedLabel(3720), "1h 02m");
  const f = run([{ kind: "user", text: "Go" }, { kind: "tool", id: "a", summary: "Read app.js" }]);
  assert.equal(currentStep(f), "Read app.js");
});

test("the working line names each stage, like Claude Code", async () => {
  const { currentStep } = await import("../web/feed.js");
  const f = run([{ kind: "phase", phase: "starting" }, { kind: "user", text: "Go" }]);
  assert.equal(currentStep(f), "Starting Claude Code");
  apply(f, { kind: "phase", phase: "waiting" });
  assert.equal(currentStep(f), "Waiting for Claude");
  apply(f, { kind: "phase", phase: "thinking" });
  assert.equal(currentStep(f), "Thinking");
  apply(f, { kind: "phase", phase: "tool", tool: "Edit" });
  assert.equal(currentStep(f), "Getting an edit ready");
  apply(f, { kind: "tool", id: "e", summary: "Edited app.js" });
  assert.equal(currentStep(f), "Edited app.js");
  apply(f, { kind: "phase", phase: "writing" });
  assert.equal(currentStep(f), "Writing");
  apply(f, { kind: "done", ok: true });
  assert.equal(f.phase, null);
});

test("a page Claude writes becomes a card; a later version in the same turn updates it", () => {
  const f = emptyFeed();
  apply(f, { kind: "user", text: "make a plan page" });
  apply(f, { kind: "artifact", path: "/p/plan.html", version: 1, versions: 1, title: "Plan", type: "page" });
  apply(f, { kind: "artifact", path: "/p/plan.html", version: 2, versions: 2, title: "Plan v2", type: "page" });
  const cards = f.items.filter((x) => x.type === "artifact");
  assert.deepEqual(cards.map((c) => [c.version, c.title]), [[2, "Plan v2"]]);
  apply(f, { kind: "user", text: "change it" });
  apply(f, { kind: "artifact", path: "/p/plan.html", version: 3, versions: 3, title: "Plan v3", type: "page" });
  assert.equal(f.items.filter((x) => x.type === "artifact").length, 2, "a new turn gets its own card");
});

test("a turn's output tokens count up live, then become exact; the context is kept after the turn", () => {
  const f = run([{ kind: "user", text: "Hi" }, { kind: "message_start", context: 30000 }, { kind: "grow", n: 400 }, { kind: "delta", text: "x".repeat(400) }]);
  assert.equal(turnOutput(f), 200, "about four characters a token while streaming");
  apply(f, { kind: "tokens", output: 180 });
  assert.equal(turnOutput(f), 180, "the exact count once the request ends");
  apply(f, { kind: "message_start", context: 31000 });
  apply(f, { kind: "delta", text: "y".repeat(40) });
  assert.equal(turnOutput(f), 190, "earlier requests stay counted");
  apply(f, { kind: "done", ok: true, context: 31050, contextWindow: 200000 });
  assert.deepEqual([turnOutput(f), f.context, f.contextWindow], [0, 31050, 200000]);
});

test("token labels read like the CLI's", () => {
  assert.deepEqual([850, 1000, 1234, 21200, 999999, 1200000].map(tokensLabel), ["850", "1k", "1.2k", "21k", "1000k", "1.2M"]);
  assert.equal(contextLabel(0), null);
  assert.equal(contextLabel(46000).text, "Context 46k of 200k (23%)");
  assert.equal(contextLabel(300000).window, 1000000, "past 200k it must be a 1M window");
});

test("background work is kept while it runs, and cleared once it's finished and you write again", () => {
  let f = run([
    { kind: "user", text: "Go" },
    { kind: "task_start", id: "a", text: "Count files", type: "agent", background: true, at: 1000 },
    { kind: "task_start", id: "b", text: "Dev server", type: "command", background: true, at: 2000 },
    { kind: "task_progress", id: "a", now: "Running ls", tools: 1 },
    { kind: "done", ok: true },
  ]);
  assert.deepEqual(tasksProgress(f.tasks), { running: 2, failed: 0, total: 2, now: "Running ls" });
  f = [
    { kind: "task_progress", id: "a", now: "Count files", tools: 2 }, // back on its own description: nothing more to say
    { kind: "task_status", id: "a", status: "completed", at: 9000 },
    { kind: "task_status", id: "a", status: "completed", at: 9500 }, // its notification, after the update
  ].reduce(apply, f);
  const a = f.tasks.find((t) => t.id === "a");
  assert.deepEqual([a.status, a.now, a.tools, a.endedAt], ["completed", "", 2, 9000]);
  assert.equal(tasksProgress(f.tasks).now, "Dev server");
  f = apply(f, { kind: "user", text: "Next" });
  assert.deepEqual(f.tasks.map((t) => t.id), ["b"], "the finished one was the last turn's");
  f = apply(f, { kind: "task_status", id: "b", status: "stopped", summary: "" });
  assert.deepEqual(tasksProgress(f.tasks), { running: 0, failed: 0, total: 1, now: "" });
});

test("a command Claude waited on isn't background work, even from an older log", () => {
  const f = run([{ kind: "user", text: "Go" }, { kind: "task_start", id: "c", text: "Commit", type: "command", background: false }]);
  assert.deepEqual(f.tasks, []);
});
