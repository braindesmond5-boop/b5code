import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Awake } from "../server/awake.js";

test("one caffeinate while wanted, tied to the server, gone when not", () => {
  const started = [];
  const spawn = (cmd, args) => { const p = new EventEmitter(); p.killed = false; p.kill = () => { p.killed = true; }; started.push({ cmd, args, p }); return p; };
  const a = new Awake({ spawn, pid: 42, win: false });
  a.set(true);
  a.set(true);
  assert.equal(started.length, 1);
  assert.deepEqual([started[0].cmd, ...started[0].args], ["caffeinate", "-i", "-w", "42"]);
  a.set(false);
  assert.equal(started[0].p.killed, true);
  assert.equal(a.on, false);
  a.set(true);
  started[1].p.emit("exit");
  assert.equal(a.on, false, "one that died isn't counted as on");
});
