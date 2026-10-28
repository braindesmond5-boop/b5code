// Steering, to-dos, recaps and usage limits: the feed's side (web/feed.js)
// and the event shapes behind them (server/events.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyFeed, apply, todoProgress, turnRecap, recapLine, resumeLabel } from "../web/feed.js";
import { normalize, limitResetAt, toolTodo, usageSummary } from "../server/events.js";

const run = (events) => events.reduce((f, e) => apply(f, e), emptyFeed());

test("a message sent mid-turn steers it: queued, then taken, and the turn carries on", () => {
  const f = run([
    { kind: "user", text: "Fix the tests" },
    { kind: "tool", id: "a", name: "Bash", summary: "Ran tests" },
    { kind: "user", text: "Skip the slow ones", steer: true },
  ]);
  const steer = f.items[2];
  assert.equal(steer.steer, "queued");
  assert.equal(f.turnStart, 1, "a steer doesn't start a new turn");
  apply(f, { kind: "steer_ack" });
  assert.equal(steer.steer, "taken");
  apply(f, { kind: "done", ok: true, more: true });
  assert.equal(f.working, true, "an end with a message still queued isn't the end");
  apply(f, { kind: "done", ok: true });
  assert.equal(f.working, false);
});

test("a steer Claude never took in says so", () => {
  const f = run([{ kind: "user", text: "Go" }, { kind: "user", text: "and this", steer: true }, { kind: "steer_lost" }]);
  assert.equal(f.items[1].steer, "lost");
});

test("Claude Code's echo of a message we sent is a replay event", () => {
  assert.deepEqual(normalize({ type: "user", isReplay: true, message: { role: "user", content: "hi" } }), [{ kind: "replay" }]);
  assert.deepEqual(normalize({ type: "user", isReplay: true, uuid: "u-1", message: { role: "user", content: "hi" } }), [{ kind: "replay", uuid: "u-1" }]);
});

test("TodoWrite replaces the to-do list", () => {
  const todos = [{ content: "Read the code", status: "completed" }, { content: "Write the fix", status: "in_progress", activeForm: "Writing the fix" }, { content: "Run tests", status: "pending" }];
  const [ev] = normalize({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "TodoWrite", input: { todos } }] } });
  const f = run([{ kind: "user", text: "Go" }, ev]);
  assert.deepEqual(f.todos.map((t) => t.status), ["completed", "in_progress", "pending"]);
  assert.deepEqual(todoProgress(f.todos), { done: 1, total: 3, now: "Write the fix", finished: false });
});

test("TaskCreate adds a task numbered by its result; TaskUpdate changes it by number", () => {
  const f = run([
    { kind: "user", text: "Go" },
    { kind: "tool", id: "c1", name: "TaskCreate", summary: "", ...toolTodo("TaskCreate", { subject: "Add the endpoint", description: "…" }) },
    { kind: "tool_result", id: "c1", ok: true, preview: "Task #4 created successfully: Add the endpoint" },
    { kind: "tool", id: "c2", name: "TaskCreate", summary: "", ...toolTodo("TaskCreate", { subject: "Broken" }) },
    { kind: "tool_result", id: "c2", ok: false, preview: "Error" },
    { kind: "tool", id: "u1", name: "TaskUpdate", summary: "", ...toolTodo("TaskUpdate", { taskId: "4", status: "completed" }) },
  ]);
  assert.equal(f.todos.length, 1, "a task that failed to be made isn't listed");
  assert.deepEqual([f.todos[0].id, f.todos[0].status], ["4", "completed"]);
  apply(f, { kind: "tool", id: "u2", name: "TaskUpdate", summary: "", ...toolTodo("TaskUpdate", { taskId: "4", status: "deleted" }) });
  assert.equal(f.todos.length, 0);
});

test("a turn that changed files ends with a recap; a quick answer doesn't", () => {
  const change = { file: "/p/a.js", edits: [{ old: "x\n", new: "y\nz\n" }] };
  const f = run([
    { kind: "user", text: "Go" },
    { kind: "tool", id: "a", name: "Edit", summary: "Edited a.js", change },
    { kind: "tool_result", id: "a", ok: true },
    { kind: "tool", id: "b", name: "Bash", summary: "Ran tests" },
    { kind: "done", ok: true, durationMs: 65000 },
  ]);
  const recap = f.items.at(-1);
  assert.equal(recap.type, "recap");
  assert.deepEqual(recap.files, [{ file: "/p/a.js", add: 2, del: 1, created: false }]);
  assert.equal(recapLine(recap), "Worked 1m 05s · changed 1 file +2 −1 · ran 1 command · 2 steps");
  const quick = run([{ kind: "user", text: "Hi" }, { kind: "text", text: "Hello" }, { kind: "done", ok: true }]);
  assert.equal(quick.items.at(-1).type, "ai");
  assert.equal(turnRecap([], 0), null);
});

test("a usage limit shows a card until it's carried on or called off", () => {
  const f = run([{ kind: "user", text: "Go" }, { kind: "done", ok: false, error: "You've hit your limit" }, { kind: "limit", resumeAt: 5000, known: true }]);
  assert.equal(f.items.at(-1).state, "waiting");
  assert.equal(f.resumeAt, 5000);
  apply(f, { kind: "limit_cleared", why: "cancelled" });
  assert.equal(f.items.find((i) => i.type === "limit").state, "cancelled");
  assert.equal(f.resumeAt, null);
});

test("when a limited turn can carry on: the latest reset among the refusing windows", () => {
  const u = usageSummary({ status: "rejected", resetsAt: 1000, unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1000, status: "rejected" }, seven_day: { utilization: 1, resetsAt: 9000, status: "rejected" } } });
  assert.equal(limitResetAt(u, ""), 9000 * 1000);
  assert.equal(limitResetAt(usageSummary({ status: "allowed", utilization: 0.4 }), "Stopped"), 0, "not the limit");
  assert.equal(limitResetAt(null, "You've hit your limit · resets 1am"), -1, "the limit, with no time given");
  assert.equal(limitResetAt(usageSummary({ status: "rejected", resetsAt: 50 }), ""), 50000);
});

test("resume times read naturally", () => {
  const now = new Date(2026, 9, 25, 22, 0).getTime();
  assert.match(resumeLabel(new Date(2026, 9, 25, 23, 30).getTime(), now), /^at /);
  assert.match(resumeLabel(new Date(2026, 9, 26, 1, 0).getTime(), now), /^tomorrow at /);
  assert.match(resumeLabel(new Date(2026, 9, 29, 1, 0).getTime(), now), /^on /);
});
