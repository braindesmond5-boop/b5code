import { test } from "node:test";
import assert from "node:assert/strict";
import { trimScrollback, shellEnv, Terminals } from "../server/terminal.js";

// A shell that does nothing until the test makes it print or exit.
function fakeShells() {
  const made = [];
  const spawn = (cwd, cols, rows) => {
    const sh = { cwd, cols, rows, written: "", killed: null, data: null, exit: null };
    sh.onData = (fn) => { sh.data = fn; };
    sh.onExit = (fn) => { sh.exit = fn; };
    sh.write = (d) => { sh.written += d; };
    sh.resize = (c, r) => { sh.cols = c; sh.rows = r; };
    sh.kill = (signal) => { sh.killed = signal; };
    made.push(sh);
    return sh;
  };
  return { made, spawn };
}

function setup() {
  const { made, spawn } = fakeShells();
  const sent = [], exits = [];
  const terms = new Terminals({ spawn, onData: (id, m) => sent.push({ id, ...m }), onExit: (id, m) => exits.push({ id, ...m }), batchMs: 0 });
  return { made, sent, exits, terms };
}

test("scrollback keeps the last lines, cut at a line start", () => {
  const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n") + "\n";
  assert.equal(trimScrollback(text, 3), "line 7\nline 8\nline 9\n");
  assert.equal(trimScrollback("a\nb", 5), "a\nb", "short output is untouched");
  assert.equal(trimScrollback("x".repeat(100), 5, 10), "x".repeat(10), "a flood with no newlines is capped by size");
});

test("the shell's environment is a UTF-8 colour terminal without B5 Code's own settings", () => {
  const env = shellEnv({ PATH: "/bin", B5_PORT: "4327", CLAUDECODE: "1" });
  assert.equal(env.TERM, "xterm-256color");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.B5_PORT, undefined);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(shellEnv({ LANG: "de_DE.UTF-8" }).LANG, "de_DE.UTF-8", "your language is kept");
});

test("opening starts one shell in the folder, and opening again reuses it", () => {
  const { made, sent, terms } = setup();
  const first = terms.open("t1", { cwd: "/p", cols: 100, rows: 30 });
  assert.deepEqual([made.length, made[0].cwd, made[0].cols, first.running, first.seq], [1, "/p", 100, true, 0]);
  made[0].data("hello\r\n");
  assert.deepEqual(sent, [{ id: "t1", seq: 1, data: "hello\r\n" }]);
  const again = terms.open("t1", { cwd: "/p" });
  assert.equal(made.length, 1, "no second shell");
  assert.deepEqual([again.seq, again.data], [1, "hello\r\n"], "the page catches up from the snapshot");
});

test("typing and resizing reach the running shell only", () => {
  const { made, terms } = setup();
  assert.equal(terms.write("t1", "ls\r"), false, "no shell yet");
  terms.open("t1", { cwd: "/p" });
  assert.equal(terms.write("t1", "ls\r"), true);
  assert.equal(made[0].written, "ls\r");
  terms.resize("t1", 120.7, 40);
  assert.deepEqual([made[0].cols, made[0].rows], [120, 40]);
  assert.equal(terms.resize("t1", 0, 40), false, "nonsense sizes are ignored");
});

test("a shell that ends keeps its output until restarted", () => {
  const { made, sent, exits, terms } = setup();
  terms.open("t1", { cwd: "/p" });
  made[0].data("bye\r\n");
  made[0].exit({ exitCode: 0 });
  assert.deepEqual(exits, [{ id: "t1", code: 0 }]);
  const ended = terms.open("t1", { cwd: "/p" });
  assert.deepEqual([made.length, ended.running, ended.data], [1, false, "bye\r\n"], "opening doesn't start a new one by itself");
  assert.equal(terms.write("t1", "x"), false);

  const fresh = terms.restart("t1", { cwd: "/p" });
  assert.deepEqual([made.length, fresh.running, fresh.data, fresh.seq], [2, true, "", 0]);
  made[0].data("late output from the old shell");
  assert.equal(sent.length, 1, "the old shell is ignored after a restart");
});

test("stop hangs up the shell; close forgets it", () => {
  const { made, terms } = setup();
  terms.open("t1", { cwd: "/p" });
  assert.equal(terms.stop("t1"), true);
  assert.equal(made[0].killed, "SIGHUP");
  terms.open("t2", { cwd: "/q" });
  terms.close("t2");
  assert.equal(made[1].killed, "SIGHUP");
  assert.equal(terms.snapshot("t2").exists, false);
});

test("a shell that can't start says why", () => {
  const terms = new Terminals({ spawn: () => { throw new Error("posix_spawnp failed."); }, onData: () => {}, onExit: () => {}, batchMs: 0 });
  const snap = terms.open("t1", { cwd: "/p" });
  assert.equal(snap.running, false);
  assert.match(snap.data, /posix_spawnp failed/);
});

test("output is sent in batches", async () => {
  const { made, spawn } = fakeShells();
  const sent = [];
  const terms = new Terminals({ spawn, onData: (id, m) => sent.push(m), onExit: () => {}, batchMs: 5 });
  terms.open("t1", { cwd: "/p" });
  made[0].data("a");
  made[0].data("b");
  assert.equal(sent.length, 0);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, [{ seq: 1, data: "ab" }]);
});

test("past the limit, the shell used longest ago is closed, ended ones first", () => {
  const { made, spawn } = fakeShells();
  const terms = new Terminals({ spawn, onData: () => {}, onExit: () => {}, batchMs: 0, maxShells: 2 });
  terms.open("a", { cwd: "/a" });
  terms.open("b", { cwd: "/b" });
  terms.write("a", "x"); // a is now the more recent
  terms.open("c", { cwd: "/c" });
  assert.equal(terms.snapshot("b").exists, false, "b, used longest ago, is gone");
  assert.equal(made[1].killed, "SIGHUP");
  assert.ok(terms.snapshot("a").exists && terms.snapshot("c").exists);
  made[2].exit({ exitCode: 0 }); // c ends
  terms.open("d", { cwd: "/d" });
  assert.equal(terms.snapshot("c").exists, false, "an ended shell goes before a running one");
  assert.ok(terms.snapshot("a").exists);
});
