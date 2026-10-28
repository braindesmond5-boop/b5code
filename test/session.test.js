// ClaudeSession against a fake `claude`: steering a running turn, and the
// flags a side chat starts with. The fake echoes each message as Claude Code
// does with --replay-user-messages, and answers each turn after a moment.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeSession } from "../server/session.js";

const FAKE = `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(process.env.B5_FAKE_ARGS, JSON.stringify(process.argv.slice(2)));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", session_id: "fake-1" });
let buf = "", queue = [], busy = false, timer = null;
const turn = () => {
  if (busy || !queue.length) return;
  busy = true;
  const first = queue.shift();
  out({ type: "user", isReplay: true, uuid: first.uuid, message: first.message });
  if (process.env.B5_FAKE_NOINIT_EXIT) process.exit(0);
  timer = setTimeout(() => {
    // A message that came in meanwhile is taken in mid-turn, as Claude Code does at a tool boundary.
    while (queue.length && process.env.B5_FAKE_MERGE) { const m = queue.shift(); out({ type: "user", isReplay: true, uuid: m.uuid, message: m.message }); }
    out({ type: "result", subtype: "success", is_error: false, result: "ok", duration_ms: 5 });
    busy = false;
    // B5_FAKE_GAP: a moment before the next queued message starts, as Claude Code may take.
    if (process.env.B5_FAKE_GAP) setTimeout(turn, Number(process.env.B5_FAKE_GAP)); else turn();
  }, 150);
};
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.type === "user") { queue.push(m); turn(); }
    // Stop: the running turn ends at once; anything queued still runs after, as Claude Code may do.
    if (m.type === "control_request" && m.request.subtype === "interrupt" && busy) {
      clearTimeout(timer); out({ type: "result", subtype: "error_during_execution", is_error: true, duration_ms: 1 }); busy = false; setTimeout(turn, 20);
    }
  }
});
`;

function fake(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b5-fake-"));
  const script = path.join(dir, "claude.cjs");
  fs.writeFileSync(script, FAKE);
  const cmd = [process.execPath, script]; // run with node: Windows can't run a script by its #! line
  const argsFile = path.join(dir, "args.json");
  Object.assign(process.env, { B5_FAKE_ARGS: argsFile }, env);
  return { cmd, args: () => JSON.parse(fs.readFileSync(argsFile, "utf8")) };
}

const until = (s, pred) => new Promise((resolve) => {
  const seen = [];
  s.on("event", (ev) => { seen.push(ev); if (pred(ev, seen)) resolve(seen); });
});

test("a message sent mid-turn is a steer: taken in, and the thread stays busy until its turn ends", async () => {
  delete process.env.B5_FAKE_MERGE;
  const f = fake();
  const s = new ClaudeSession({ cwd: os.tmpdir(), command: f.cmd });
  const finished = until(s, (ev, seen) => ev.kind === "done" && !ev.more && seen.some((e) => e.kind === "steer_ack"));
  assert.equal(s.send("first"), false);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.send("and also this"), true, "sent while busy: a steer");
  const seen = await finished;
  const kinds = seen.map((e) => (e.kind === "done" ? (e.more ? "done+more" : "done") : e.kind)).filter((k) => !["init", "phase"].includes(k));
  // Here the fake runs the steer as the next turn: the first end says there's more.
  assert.deepEqual(kinds, ["done+more", "steer_ack", "done"]);
  assert.equal(s.busy, false);
  assert.ok(f.args().includes("--replay-user-messages"));
  s.close({ now: true });
});

test("a steer taken in mid-turn: one end, not held", async () => {
  process.env.B5_FAKE_MERGE = "1";
  const f = fake();
  const s = new ClaudeSession({ cwd: os.tmpdir(), command: f.cmd });
  const finished = until(s, (ev) => ev.kind === "done" && !ev.more);
  s.send("first");
  await new Promise((r) => setTimeout(r, 50));
  s.send("steer");
  const seen = await finished;
  assert.deepEqual(seen.filter((e) => e.kind === "done" || e.kind === "steer_ack").map((e) => e.kind), ["steer_ack", "done"]);
  delete process.env.B5_FAKE_MERGE;
  s.close({ now: true });
});

test("a side chat's first start forks the conversation; later starts resume its own", async () => {
  const f = fake();
  const s = new ClaudeSession({ cwd: os.tmpdir(), command: f.cmd, sessionId: "parent-1", fork: true });
  const done = until(s, (ev) => ev.kind === "done");
  s.send("q");
  await done;
  const args = f.args();
  assert.deepEqual(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2), ["--resume", "parent-1"]);
  assert.ok(args.includes("--fork-session"));
  assert.equal(s.sessionId, "fake-1", "the copy's own id, from init");
  s.close({ now: true });
  await new Promise((r) => setTimeout(r, 100));
  const again = until(s, (ev) => ev.kind === "done");
  s.send("q2");
  await again;
  assert.ok(!f.args().includes("--fork-session"), "forked once");
  assert.ok(f.args().includes("fake-1"));
  s.close({ now: true });
});

test("Stop with a message queued: the turn ends, the message is dropped, and nothing of it runs", async () => {
  delete process.env.B5_FAKE_MERGE;
  const f = fake();
  const s = new ClaudeSession({ cwd: os.tmpdir(), command: f.cmd });
  const all = [];
  s.on("event", (ev) => all.push(ev));
  const ended = until(s, (ev) => ev.kind === "done");
  s.send("first");
  await new Promise((r) => setTimeout(r, 50));
  s.send("queued steer");
  s.interrupt();
  await ended;
  // The fake then starts the dropped message anyway: it's stopped, and nothing of it is shown.
  await new Promise((r) => setTimeout(r, 600));
  const kinds = all.map((e) => e.kind).filter((k) => !["init", "phase"].includes(k));
  assert.deepEqual(kinds, ["steer_lost", "done"]);
  assert.equal(s.busy, false);
  s.close({ now: true });
});

test("a side chat closed before Claude Code gave it an id forks again, never resuming its parent", async () => {
  const f = fake();
  const s = new ClaudeSession({ cwd: os.tmpdir(), command: f.cmd, sessionId: "parent-1", fork: true });
  assert.equal(s.sessionId, null, "no id of its own yet");
  s.close({ now: true });
  const again = until(s, (ev) => ev.kind === "done");
  s.send("q");
  await again;
  assert.ok(f.args().includes("--fork-session"));
  s.close({ now: true });
});

test("Stop while a turn's end is held, then a new message at once: the dropped one runs unseen, the new one is shown", async () => {
  delete process.env.B5_FAKE_MERGE;
  const f = fake({ B5_FAKE_GAP: "300" });
  const s = new ClaudeSession({ cwd: os.tmpdir(), command: f.cmd });
  const firstTurn = until(s, (ev) => ev.kind === "done" && ev.more);
  s.send("first");
  await new Promise((r) => setTimeout(r, 50));
  s.send("queued");
  await firstTurn; // the first turn ended with "queued" still waiting: held
  const after = [];
  s.on("event", (ev) => after.push(ev));
  s.interrupt(); // Stop: the held end counts now, and "queued" is dropped
  assert.equal(s.busy, false);
  const shown = until(s, (ev) => ev.kind === "done");
  s.send("new one");
  await shown;
  await new Promise((r) => setTimeout(r, 200));
  const kinds = after.map((e) => e.kind).filter((k) => !["init", "phase"].includes(k));
  // Stop's end, the dropped steer, then the new message's own turn: never swallowed.
  assert.deepEqual(kinds, ["steer_lost", "done", "done"]);
  assert.equal(after.filter((e) => e.kind === "done")[1].error, "");
  assert.equal(s.busy, false);
  s.close({ now: true });
  delete process.env.B5_FAKE_GAP;
});

test("a question is answered by allowing it with the answers; never allowed without them", async () => {
  const { ClaudeSession } = await import("../server/session.js");
  const s = new ClaudeSession({ cwd: "/tmp", command: "true" });
  const sent = [];
  s.proc = { stdin: { write: (l) => sent.push(JSON.parse(l)) } };
  const input = { questions: [{ question: "Which?", header: "H", options: [{ label: "A" }] }] };
  s.pending.set("r1", input);
  assert.equal(s.answerPermission("r1", "allow"), false, "no answers: refused, still waiting");
  assert.equal(s.answerPermission("r1", "allow", { answers: { "Which?": "A" } }), true);
  assert.deepEqual(sent[0].response.response, { behavior: "allow", updatedInput: { ...input, answers: { "Which?": "A" } } });
  s.pending.set("r2", input);
  assert.equal(s.answerPermission("r2", "deny"), true, "skipping is a no");
  assert.match(sent[1].response.response.message, /skipped the question/);
});
