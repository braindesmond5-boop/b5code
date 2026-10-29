// The agent registry, and OpenCode's events as B5 Code's. The shapes are what
// `opencode serve` sent on /event in a real turn (a file written, then "done").
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS, providerOf, listProviders, createSession, providerModels, DEFAULT_PROVIDER } from "../server/agents.js";
import { openCodeEvents, newTurnState, findOpenCode, parseModels, questionsFrom, labelsOf } from "../server/opencode.js";
import { ASK_TOOL, questionsOf } from "../web/questions.js";
import { currentStep } from "../web/feed.js";
import { ClaudeSession } from "../server/session.js";

const run = (events, st = newTurnState()) => events.flatMap((e) => openCodeEvents(e, st));

test("a thread without a provider is Claude's, and an unknown one falls back to Claude", () => {
  assert.equal(providerOf({}), DEFAULT_PROVIDER);
  assert.equal(providerOf({ provider: "nope" }), "claude");
  assert.equal(providerOf({ provider: "opencode" }), "opencode");
});

test("the list says what each agent can do, and Claude is always there", () => {
  const list = listProviders();
  assert.deepEqual(list.map((p) => p.id), Object.keys(PROVIDERS));
  assert.equal(list.find((p) => p.id === "claude").installed, true);
  assert.equal(list.find((p) => p.id === "claude").caps.steer, true);
  assert.equal(list.find((p) => p.id === "opencode").caps.steer, false);
});

test("a Claude session comes from the registry as before", () => {
  assert.ok(createSession("claude", { cwd: "/tmp" }) instanceof ClaudeSession);
});

test("OpenCode is found on the PATH or where its installers put it, and is null when it's nowhere", () => {
  const has = (set) => (f) => set.includes(f);
  assert.equal(findOpenCode({ env: { PATH: "/a:/b" }, home: "/h", win: false, exists: has(["/b/opencode"]) }), "/b/opencode");
  assert.equal(findOpenCode({ env: { PATH: "/a" }, home: "/h", win: false, exists: has(["/h/.local/bin/opencode"]) }), "/h/.local/bin/opencode");
  assert.equal(findOpenCode({ env: { PATH: "/a" }, home: "/h", win: false, exists: () => false }), null);
  // The same on Windows, whichever computer this runs on.
  const win = (set) => (f) => set.includes(f);
  assert.equal(findOpenCode({ env: { Path: "C:\\a;C:\\b" }, home: "C:\\Users\\me", win: true, exists: win(["C:\\b\\opencode.exe"]) }), "C:\\b\\opencode.exe");
  assert.equal(findOpenCode({ env: { Path: "C:\\a" }, home: "C:\\Users\\me", win: true, exists: win(["C:\\Users\\me\\.opencode\\bin\\opencode.exe"]) }), "C:\\Users\\me\\.opencode\\bin\\opencode.exe");
});

const user = { type: "message.updated", properties: { info: { id: "m1", role: "user" } } };
const asst = { type: "message.updated", properties: { info: { id: "m2", role: "assistant" } } };

test("a turn: the reply streams, the write is a tool with its change, and idle ends it", () => {
  const out = run([
    user,
    { type: "message.part.updated", properties: { part: { id: "p0", type: "text", text: "make a.txt", messageID: "m1" } } },
    asst,
    { type: "message.part.updated", properties: { part: { id: "p1", type: "tool", tool: "write", callID: "c1", messageID: "m2", state: { status: "pending", input: {} } } } },
    { type: "message.part.updated", properties: { part: { id: "p1", type: "tool", tool: "write", callID: "c1", messageID: "m2", state: { status: "running", input: { filePath: "/w/a.txt", content: "hi\n" } } } } },
    { type: "message.part.updated", properties: { part: { id: "p1", type: "tool", tool: "write", callID: "c1", messageID: "m2", state: { status: "completed", input: { filePath: "/w/a.txt", content: "hi\n" }, output: "Wrote file successfully." } } } },
    { type: "message.part.delta", properties: { messageID: "m2", partID: "p2", field: "text", delta: "do" } },
    { type: "message.part.updated", properties: { part: { id: "p2", type: "text", text: "done", messageID: "m2", time: { start: 1, end: 2 } } } },
    { type: "message.part.updated", properties: { part: { id: "p2", type: "text", text: "done", messageID: "m2", time: { start: 1, end: 2 } } } },
    { type: "message.updated", properties: { info: { id: "m2", role: "assistant", time: { completed: 3 }, tokens: { output: 68 } } } },
    { type: "session.idle", properties: { sessionID: "s" } },
  ]);
  assert.deepEqual(out.map((e) => e.kind), ["tool", "tool_result", "delta", "text", "done"]);
  assert.equal(out[0].name, "Write");
  assert.equal(out[0].summary, "Wrote a.txt");
  assert.deepEqual(out[0].change, { file: "/w/a.txt", edits: [{ old: "", new: "hi\n" }], created: true });
  assert.equal(out[1].ok, true);
  assert.equal(out[3].text, "done", "a finished text shows once, however often it's sent");
  assert.deepEqual(out[4], { kind: "done", ok: true, error: "", durationMs: 0, output: 68 });
});

test("your own message is not drawn back as the agent's", () => {
  const out = run([
    user,
    { type: "message.part.updated", properties: { part: { id: "p0", type: "text", text: "hello", messageID: "m1", time: { end: 1 } } } },
    { type: "message.part.delta", properties: { messageID: "m1", partID: "p0", field: "text", delta: "hello" } },
  ]);
  assert.deepEqual(out, []);
});

test("an edit and a failed tool", () => {
  const out = run([
    asst,
    { type: "message.part.updated", properties: { part: { id: "p1", type: "tool", tool: "edit", callID: "c1", messageID: "m2", state: { status: "running", input: { filePath: "/w/a.txt", oldString: "x", newString: "y" } } } } },
    { type: "message.part.updated", properties: { part: { id: "p2", type: "tool", tool: "bash", callID: "c2", messageID: "m2", state: { status: "error", input: { command: "false" }, error: "exit 1" } } } },
  ]);
  assert.deepEqual(out[0].change, { file: "/w/a.txt", edits: [{ old: "x", new: "y" }] });
  assert.equal(out[1].summary, "Ran false");
  assert.deepEqual(out.slice(2).map((e) => [e.kind, e.ok]), [["tool_result", false]]);
});

test("thinking is shown as growing, not as text", () => {
  const st = newTurnState();
  const out = run([
    asst,
    { type: "message.part.updated", properties: { part: { id: "r1", type: "reasoning", messageID: "m2" } } },
    { type: "message.part.delta", properties: { messageID: "m2", partID: "r1", field: "text", delta: "hmm" } },
  ], st);
  assert.deepEqual(out, [{ kind: "phase", phase: "thinking" }, { kind: "grow", n: 3 }]);
});

test("a permission asks, and closes when answered", () => {
  const [ask] = run([{ type: "permission.asked", properties: { id: "per_1", sessionID: "s", permission: "edit", patterns: ["/w/b.txt"], metadata: { filepath: "/w/b.txt", diff: "+hello" }, always: ["*"] } }]);
  assert.equal(ask.kind, "permission");
  assert.equal(ask.requestId, "per_1");
  assert.equal(ask.summary, "Edit b.txt");
  assert.equal(ask.canAllowEdits, true);
  const [bash] = run([{ type: "permission.asked", properties: { id: "per_2", sessionID: "s", permission: "bash", patterns: ["npm test"], metadata: {}, always: [] } }]);
  assert.equal(bash.summary, "Run npm test");
  assert.equal(bash.canAllowEdits, false);
  assert.deepEqual(run([{ type: "permission.replied", properties: { sessionID: "s", requestID: "per_1", reply: "once" } }]), [{ kind: "permission_closed", requestId: "per_1" }]);
});

test("an error ends the turn as a failure, with its message", () => {
  const out = run([{ type: "session.error", properties: { sessionID: "s", error: { name: "APIError", data: { message: "rate limited" } } } }]);
  assert.deepEqual(out, [{ kind: "done", ok: false, error: "rate limited", durationMs: 0, aborted: false }]);
  assert.equal(run([{ type: "session.error", properties: { error: { name: "MessageAbortedError" } } }])[0].aborted, true);
});

test("events that mean nothing to the page are dropped", () => {
  assert.deepEqual(run([{ type: "server.heartbeat", properties: {} }, { type: "plugin.added", properties: {} }, { type: "session.diff", properties: {} }]), []);
});

test("a question becomes Claude's question card, and closes when answered or skipped", () => {
  const asked = { type: "question.asked", properties: { id: "que_1", sessionID: "s", questions: [
    { question: "Which colour?", header: "Colour", multiple: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "" }] },
    { question: "Which sizes?", header: "Sizes", multiple: true, options: [{ label: "S", description: "" }, { label: "M", description: "" }] },
  ] } };
  const [ev] = run([asked]);
  assert.equal(ev.kind, "permission");
  assert.equal(ev.tool, ASK_TOOL);
  assert.equal(ev.summary, "Asked you 2 questions");
  const qs = questionsOf(ASK_TOOL, ev.input);
  assert.deepEqual(qs.map((q) => [q.question, q.multiSelect, q.options.map((o) => o.label)]), [["Which colour?", false, ["Red", "Blue"]], ["Which sizes?", true, ["S", "M"]]]);
  for (const type of ["question.replied", "question.rejected"]) assert.deepEqual(run([{ type, properties: { sessionID: "s", requestID: "que_1" } }]), [{ kind: "permission_closed", requestId: "que_1" }]);
});

test("answers go back as the labels picked, in the order of the questions", () => {
  const [single, multi] = questionsFrom([{ question: "a", options: [] }, { question: "b", multiple: true, options: [] }]);
  assert.deepEqual(labelsOf(single, "Blue"), ["Blue"]);
  assert.deepEqual(labelsOf(multi, "S, M"), ["S", "M"]);
  assert.deepEqual(labelsOf(multi, " "), []);
});

test("OpenCode's own question tool is drawn as Claude's", () => {
  const out = run([asst, { type: "message.part.updated", properties: { part: { id: "q1", type: "tool", tool: "question", callID: "c9", messageID: "m2", state: { status: "running", input: { questions: [{ question: "Which colour?", header: "c", options: [{ label: "Red", description: "" }] }] } } } } }]);
  assert.equal(out[0].name, ASK_TOOL);
  assert.equal(out[0].summary, "Asked you: Which colour?");
});

test("model names are made readable, the free ones marked, and noise lines dropped", () => {
  const list = parseModels("opencode/glm-5.3-flash-free\nopencode/deepseek-v4.1-flash-free\nopencode/flint-40b-free\nopencode/big-pickle\nanthropic/claude-x\nsome noise\n");
  assert.deepEqual(list.map((m) => m.name), ["GLM 5.3 Flash", "DeepSeek V4.1 Flash", "Flint 40B", "Big Pickle", "Claude X"]);
  assert.deepEqual(list.map((m) => m.free), [true, true, true, true, false]);
  assert.equal(list[4].description, "anthropic", "another provider's model says whose it is");
  assert.equal(list[0].description, "", "the free tag says it already");
});

test("the working line names the agent", () => {
  const feed = (phase) => ({ items: [], phase: { phase } });
  assert.equal(currentStep(feed("starting")), "Starting Claude Code");
  assert.equal(currentStep(feed("waiting")), "Waiting for Claude");
  assert.equal(currentStep(feed("starting"), "OpenCode"), "Starting OpenCode");
  assert.equal(currentStep(feed("waiting"), "OpenCode"), "Waiting for OpenCode");
});

test("an agent's models are looked up once at a time, and a failed lookup is remembered only for a moment", async () => {
  const real = { installed: PROVIDERS.opencode.installed, models: PROVIDERS.opencode.models };
  try {
    PROVIDERS.opencode.installed = () => true;
    let calls = 0, answer = [];
    PROVIDERS.opencode.models = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return answer; };
    const t0 = Date.now();
    const [a, b] = await Promise.all([providerModels("opencode", t0), providerModels("opencode", t0)]);
    assert.equal(calls, 1, "two asks at once share one lookup");
    assert.deepEqual([a, b], [[], []]);
    await providerModels("opencode", t0 + 5000);
    assert.equal(calls, 1, "an empty answer (it failed, or wasn't ready) isn't asked again at once: each menu opened would start the program again");
    await providerModels("opencode", t0 + 11000);
    assert.equal(calls, 2, "but it is asked again after a few seconds");
    answer = [{ value: "opencode/x", name: "X" }];
    assert.equal((await providerModels("opencode", t0 + 12000)).length, 0, "the empty answer still stands");
    assert.equal((await providerModels("opencode", t0 + 22000)).length, 1);
    assert.equal(calls, 3);
    assert.equal((await providerModels("opencode", t0 + 22000 + 30000)).length, 1);
    assert.equal(calls, 3, "an answer is kept for a minute");
    await providerModels("opencode", t0 + 22000 + 61000);
    assert.equal(calls, 4);
  } finally { Object.assign(PROVIDERS.opencode, real); }
});
