import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize } from "../server/events.js";
import { toolSummary } from "../server/tools.js";

// Shapes recorded from Claude Code 2.1.310's stream-json output.

test("init gives the session id and model", () => {
  const [ev] = normalize({ type: "system", subtype: "init", session_id: "abc", model: "claude-opus-5-5", cwd: "/x" });
  assert.deepEqual(ev, { kind: "init", sessionId: "abc", model: "claude-opus-5-5", cwd: "/x", connectors: [], review: [] });
  const [withMcp] = normalize({ type: "system", subtype: "init", session_id: "abc", mcp_servers: [{ name: "claude.ai Gmail", status: "pending" }],
    tools: ["Bash", "mcp__claude_ai_Google_Docs__read_doc", "mcp__claude_ai_Google_Docs__update_doc"] });
  assert.deepEqual(withMcp.connectors, [{ name: "claude.ai Gmail", status: "pending" }]);
  assert.deepEqual(withMcp.review, ["mcp__claude_ai_Google_Docs__update_doc"], "the connector tools that change something");
});

test("a text delta streams; other deltas only count towards the tokens", () => {
  assert.deepEqual(normalize({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } } }), [{ kind: "delta", text: "Hi" }]);
  assert.deepEqual(normalize({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } } }), [{ kind: "grow", n: 1 }]);
  assert.deepEqual(normalize({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "signature_delta", signature: "x" } } }), []);
});

test("an assistant message gives its text and its tool calls, in order", () => {
  const evs = normalize({ type: "assistant", message: { content: [
    { type: "thinking", thinking: "" },
    { type: "text", text: "Reading it." },
    { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a/b/note.txt" } },
  ] } });
  assert.equal(evs.length, 2);
  assert.deepEqual(evs[0], { kind: "text", text: "Reading it." });
  assert.equal(evs[1].kind, "tool");
  assert.equal(evs[1].summary, "Read note.txt");
});

test("a tool result says whether it worked", () => {
  const [ok] = normalize({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "1\thello" }] } });
  assert.deepEqual(ok, { kind: "tool_result", id: "t1", ok: true, preview: "1\thello" });
  const [bad] = normalize({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: [{ type: "text", text: "denied" }] }] } });
  assert.equal(bad.ok, false);
  assert.equal(bad.preview, "denied");
});

test("a permission question carries what is asked and whether edits can be allowed", () => {
  const [ev] = normalize({ type: "control_request", request_id: "r1", request: {
    subtype: "can_use_tool", tool_name: "Write", input: { file_path: "/w/out.txt", content: "ok" },
    permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
  } });
  assert.equal(ev.kind, "permission");
  assert.equal(ev.requestId, "r1");
  assert.equal(ev.summary, "Wrote out.txt");
  assert.equal(ev.canAllowEdits, true);
});

test("the initialize answer gives the skills and commands", () => {
  const [ev] = normalize({ type: "control_response", response: { subtype: "success", request_id: "i", response: { commands: [{ name: "flaevo", description: "The engine", argumentHint: "" }] } } });
  assert.deepEqual(ev, { kind: "commands", list: [{ name: "flaevo", description: "The engine", hint: "" }], models: [] });
});

test("a subagent's own messages are not drawn twice", () => {
  assert.deepEqual(normalize({ type: "assistant", parent_tool_use_id: "t9", message: { content: [{ type: "text", text: "inner" }] } }), []);
});

test("a result ends the turn, ok or not", () => {
  assert.equal(normalize({ type: "result", subtype: "success", is_error: false, duration_ms: 5 })[0].ok, true);
  const [bad] = normalize({ type: "result", subtype: "error_during_execution", is_error: true });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "error_during_execution");
});

test("junk is ignored", () => {
  assert.deepEqual(normalize(null), []);
  assert.deepEqual(normalize({ type: "rate_limit_event" }), []);
});

test("tool lines read as plain words", () => {
  assert.equal(toolSummary("Bash", { command: "npm test", description: "Run the tests" }), "Run the tests");
  assert.equal(toolSummary("Bash", { command: "npm test" }), "Ran npm test");
  assert.equal(toolSummary("Edit", { file_path: "/x/app.js" }), "Edited app.js");
  assert.equal(toolSummary("WebFetch", { url: "https://nodejs.org/dist/index.json" }), "Read nodejs.org");
  assert.equal(toolSummary("Skill", { skill: "flaevo" }), "Used the flaevo skill");
  assert.equal(toolSummary("mcp__claude_ai_Gmail__search_threads", {}), "search threads (Gmail)");
});

test("stages and usage come through", async () => {
  const { usageSummary } = await import("../server/events.js");
  assert.deepEqual(normalize({ type: "system", subtype: "status", status: "requesting" }), [{ kind: "phase", phase: "waiting" }]);
  assert.deepEqual(normalize({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "thinking" } } }), [{ kind: "phase", phase: "thinking" }]);
  assert.deepEqual(normalize({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "Edit" } } }), [{ kind: "phase", phase: "tool", tool: "Edit" }]);
  const u = usageSummary({ status: "allowed_warning", unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 100, status: "allowed" }, seven_day: { utilization: 0.92, resetsAt: 200, status: "allowed_warning" } } });
  assert.equal(u.week.used, 0.92);
  assert.equal(u.week.resetsAt, 200000);
  assert.equal(u.fiveHour.used, 0.5);
  const [m] = normalize({ type: "control_response", response: { response: { commands: [], models: [{ value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "Complex work" }] } } });
  assert.deepEqual(m.models, [{ value: "opus", model: "claude-opus-5-5", name: "Opus 5.5", description: "Complex work" }]);
});

test("token counts: each request's context, the streamed size, the exact output, and the turn's totals", () => {
  const ev = (event) => normalize({ type: "stream_event", event });
  assert.deepEqual(ev({ type: "message_start", message: { usage: { input_tokens: 3, cache_read_input_tokens: 40000, cache_creation_input_tokens: 2000 } } }), [{ kind: "message_start", context: 42003 }]);
  assert.deepEqual(ev({ type: "message_delta", usage: { output_tokens: 812 } }), [{ kind: "tokens", output: 812 }]);
  assert.deepEqual(ev({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Let me" } }), [{ kind: "grow", n: 6 }]);
  assert.deepEqual(ev({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"a":' } }), [{ kind: "grow", n: 5 }]);
  const done = normalize({ type: "result", subtype: "success", usage: { output_tokens: 1500 }, modelUsage: { "claude-haiku": { contextWindow: 200000 }, "claude-opus": { contextWindow: 1000000 } } })[0];
  assert.deepEqual([done.output, done.contextWindow], [1500, 1000000]);
});

test("background work: a task's start, its progress, and how it ended", () => {
  // As Claude Code 2.1.310 sends them, for a background agent and a background command.
  assert.deepEqual(normalize({ type: "system", subtype: "task_started", task_id: "ac14", tool_use_id: "toolu_1", description: "Count files", subagent_type: "general-purpose", is_backgrounded: true, task_type: "local_agent", prompt: "Run ls…" }),
    [{ kind: "task_start", id: "ac14", toolId: "toolu_1", text: "Count files", type: "agent", background: true }]);
  assert.deepEqual(normalize({ type: "system", subtype: "task_progress", task_id: "ac14", description: "Running List entries in current directory", usage: { total_tokens: 19175, tool_uses: 1, duration_ms: 1638 }, last_tool_name: "Bash" }),
    [{ kind: "task_progress", id: "ac14", now: "Running List entries in current directory", tools: 1, tokens: 19175 }]);
  assert.deepEqual(normalize({ type: "system", subtype: "task_updated", task_id: "ac14", patch: { status: "completed", end_time: 1 } }), [{ kind: "task_status", id: "ac14", status: "completed" }]);
  assert.deepEqual(normalize({ type: "system", subtype: "task_notification", task_id: "ac14", status: "completed", summary: "This agent's report was delivered to you as a message" }),
    [{ kind: "task_status", id: "ac14", status: "completed" }], "an agent's summary is about its report, not how it went");
  assert.equal(normalize({ type: "system", subtype: "task_started", task_id: "b1", description: "Sleep", task_type: "local_bash", is_backgrounded: true })[0].type, "command");
  assert.deepEqual(normalize({ type: "system", subtype: "task_started", task_id: "b2", description: "Commit", task_type: "local_bash", is_backgrounded: false }), [], "a command Claude waits on is a step, not background work");
  assert.deepEqual(normalize({ type: "system", subtype: "task_notification", task_id: "b1", status: "failed", summary: 'Background command "Sleep" failed (exit code 1)' }),
    [{ kind: "task_status", id: "b1", status: "failed", summary: 'Background command "Sleep" failed (exit code 1)' }]);
  assert.deepEqual(normalize({ type: "system", subtype: "task_updated", task_id: "b1", patch: { end_time: 1 } }), [], "a change that isn't its status");
  assert.deepEqual(normalize({ type: "system", subtype: "task_started" }), [], "no id");
});
