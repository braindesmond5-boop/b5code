// When an agent hits its limit: what counts as one, who carries on, and what they're told.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAgentLimit, nextAgent, handoffBrief, HANDOFF_MS } from "../server/handoff.js";
import { emptyFeed, apply } from "../web/feed.js";

test("the time to cancel is 30 seconds", () => assert.equal(HANDOFF_MS, 30000));

test("an agent's limit is told from its other errors", () => {
  for (const e of ["Rate limit exceeded", "429 Too Many Requests", "You exceeded your current quota", "Usage limit reached", "Free credits exhausted"]) assert.equal(isAgentLimit(e), true, e);
  for (const e of ["", null, "spawn opencode ENOENT", "interrupted", "Could not start OpenCode: x", "Context window exhausted", "Invalid API key: see the credits page", "ENOENT: file 4290.txt not found", "The model hit an error"]) assert.equal(isAgentLimit(e), false, String(e));
  for (const e of ["HTTP 429", "status 429: slow down", "You have reached your monthly limit", "Insufficient credits", "Out of quota"]) assert.equal(isAgentLimit(e), true, e);
});

test("the next agent is the first in order that isn't this one and is free", () => {
  const order = ["claude", "opencode", "codex"];
  assert.equal(nextAgent({ current: "claude", order, free: () => true }), "opencode");
  assert.equal(nextAgent({ current: "opencode", order, free: () => true }), "claude");
  assert.equal(nextAgent({ current: "claude", order, free: (id) => id === "codex" }), "codex", "one at its limit is passed over");
  assert.equal(nextAgent({ current: "claude", order, free: () => false }), null, "none free");
  assert.equal(nextAgent({ current: "claude", order: ["claude"], free: () => true }), null, "nothing else installed");
});

const log = [
  { kind: "user", text: "Add a footer" },
  { kind: "tool", name: "Write", change: { file: "/p/footer.html", edits: [] } },
  { kind: "text", text: "Added footer.html" },
  { kind: "user", text: "Also make it dark" },
  { kind: "user", text: "and keep it small", steer: true },
  { kind: "tool", name: "Edit", change: { file: "/p/footer.css", edits: [] } },
  { kind: "tool", name: "Write", change: { file: "/p/footer.html", edits: [] } },
  { kind: "text", text: "Dark styles added" },
];

test("the summary has each of your messages, its replies, and the files changed once", () => {
  const brief = handoffBrief({ log, fromName: "Claude" });
  assert.match(brief, /Claude reached its usage limit/);
  assert.match(brief, /You: Add a footer\nClaude: Added footer\.html/);
  assert.match(brief, /You: Also make it dark\nClaude: \(You added: and keep it small\)\n\nDark styles added/);
  assert.deepEqual(brief.split("Files it changed:\n")[1].split("\n\n")[0].split("\n"), ["- /p/footer.html", "- /p/footer.css"]);
  assert.match(brief, /Look at the files before relying on this summary\.$/);
});

test("an earlier hand-over message isn't a turn of its own, and an empty thread says so", () => {
  const brief = handoffBrief({ log: [{ kind: "user", text: "Add a footer" }, { kind: "text", text: "ok" }, { kind: "user", text: "HAND-OVER TEXT", auto: "handoff" }, { kind: "text", text: "carried on" }], fromName: "OpenCode" });
  assert.doesNotMatch(brief, /HAND-OVER TEXT/);
  assert.match(brief, /OpenCode: ok\n\ncarried on/);
  assert.match(handoffBrief({ log: [], fromName: "Claude" }), /\(nothing yet\)/);
});

test("a long conversation keeps its first request and its newest turns, and says what was left out", () => {
  const long = [];
  for (let i = 0; i < 30; i++) long.push({ kind: "user", text: `request ${i} ${"x".repeat(900)}` }, { kind: "text", text: `reply ${i} ${"y".repeat(900)}` });
  const brief = handoffBrief({ log: long, fromName: "Claude", budget: 6000 });
  assert.match(brief, /request 0 /);
  assert.match(brief, /request 29 /);
  assert.doesNotMatch(brief, /request 15 /);
  assert.match(brief, /\(\d+ turns in the middle left out\)/);
  assert.ok(brief.length < 9000, `short enough: ${brief.length}`);
});

const feedOf = (events) => events.reduce((f, e) => apply(f, e), emptyFeed());
const offer = { kind: "handoff_offer", from: "claude", to: "opencode", fromName: "Claude Code", toName: "OpenCode", at: 1000, resetAt: 5000 };

test("an offer replaces the wait for the reset, and carrying on shows as done", () => {
  const f = feedOf([{ kind: "user", text: "Go" }, { kind: "limit", resumeAt: 5000, known: true }, offer, { kind: "handoff_done", from: "claude", to: "opencode", fromName: "Claude Code", toName: "OpenCode", how: "auto" }]);
  assert.deepEqual(f.items.map((i) => [i.type, i.state]), [["user", undefined], ["limit", "replaced"], ["handoff", "done"]]);
  assert.equal(f.items[2].how, "auto");
  assert.equal(f.items[2].toName, "OpenCode");
});

test("cancelling keeps the thread where it is, and its wait for the reset shows again", () => {
  const f = feedOf([{ kind: "user", text: "Go" }, { kind: "limit", resumeAt: 5000, known: true }, offer, { kind: "handoff_cancel", resetAt: 5000 }]);
  assert.deepEqual(f.items.map((i) => [i.type, i.state]), [["user", undefined], ["limit", "waiting"], ["handoff", "cancelled"]]);
  assert.equal(f.items[2].resetAt, 5000);
});

test("switching back is a done line of its own, with no offer before it", () => {
  const f = feedOf([{ kind: "handoff_done", from: "opencode", to: "claude", fromName: "OpenCode", toName: "Claude Code", how: "back" }]);
  assert.deepEqual(f.items.map((i) => [i.type, i.state, i.how]), [["handoff", "done", "back"]]);
});

test("a second offer replaces the first", () => {
  const f = feedOf([offer, { ...offer, at: 2000 }]);
  assert.deepEqual(f.items.map((i) => i.state), ["replaced", "offer"]);
});

test("each reply is named for the agent that wrote it, across hand-overs", () => {
  const log = [
    { kind: "user", text: "Add a footer" }, { kind: "text", text: "claude one" },
    { kind: "handoff_done", from: "claude", to: "opencode", fromName: "Claude Code", toName: "OpenCode", how: "auto" },
    { kind: "user", text: "HAND-OVER ONE", auto: "handoff" }, { kind: "text", text: "opencode one" },
    { kind: "user", text: "Make it dark" }, { kind: "text", text: "opencode two" },
    { kind: "handoff_done", from: "opencode", to: "claude", fromName: "OpenCode", toName: "Claude Code", how: "back" },
    { kind: "user", text: "HAND-OVER TWO", auto: "handoff" }, { kind: "text", text: "claude two" },
  ];
  const brief = handoffBrief({ log, fromName: "Claude Code" });
  assert.match(brief, /You: Add a footer\nClaude Code: claude one\n\nOpenCode: opencode one\n\nYou: Make it dark\nOpenCode: opencode two\n\nClaude Code: claude two/);
  assert.doesNotMatch(brief, /HAND-OVER/);
});
