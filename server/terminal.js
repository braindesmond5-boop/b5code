// The Terminal pane: one real shell per thread (or per project, before a
// thread exists), in that thread's folder.
//
// A shell runs in a pseudo-terminal from node-pty, so colours, interactive
// programs and Ctrl-C work as in Terminal.app. Terminals takes the spawn
// function as an argument, so the rules (scrollback, numbering, restart)
// are tested with a fake shell and no native module.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { IS_WIN, terminalShell } from "./platform.js";

export const MAX_LINES = 5000;
export const MAX_SHELLS = 8; // more, and the one used longest ago is closed
export const MAX_CHARS = 2_000_000; // a flood with no newlines still stops somewhere
const TRIM_EVERY = 64 * 1024;

/** The last `maxLines` lines of `text`, cut at a line start, and at most `maxChars`. */
export function trimScrollback(text, maxLines = MAX_LINES, maxChars = MAX_CHARS) {
  let out = text.length > maxChars ? text.slice(text.length - maxChars) : text;
  let cut = out.endsWith("\n") ? out.length - 1 : out.length; // a final newline ends the last line
  for (let n = 0; n < maxLines; n++) {
    cut = out.lastIndexOf("\n", cut - 1);
    if (cut < 0) return out;
  }
  return out.slice(cut + 1);
}

/** The environment a shell starts with: yours, as a 256-colour UTF-8 terminal. */
export function shellEnv(env) {
  const out = { ...env, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "B5Code" };
  if (!out.LANG) out.LANG = "en_US.UTF-8"; // started from the Dock, there may be none
  for (const k of Object.keys(out)) if (k.startsWith("B5_") || k === "CLAUDECODE") delete out[k];
  return out;
}

export class Terminals {
  /**
   * spawn(cwd, cols, rows) returns a pty-like { onData(fn), onExit(fn), write, resize, kill }.
   * onData(id, { seq, data }) and onExit(id, { code }) report to the page.
   * Output is sent in batches every `batchMs` (0: at once).
   */
  constructor({ spawn, onData, onExit, batchMs = 8, maxShells = MAX_SHELLS }) {
    Object.assign(this, { spawn, onData, onExit, batchMs, maxShells });
    this.clock = 0;
    this.terms = new Map(); // id -> { pty, cwd, buffer, sinceTrim, seq, pending, timer, running, code }
  }

  /** Start the shell for `id` unless it has one (running or ended). Returns what the page shows. */
  open(id, { cwd, cols = 80, rows = 24 }) {
    if (!this.terms.has(id)) this.start(id, cwd, cols, rows);
    this.touch(id);
    return this.snapshot(id);
  }

  // Clicking through threads with the tab open starts a shell for each; past
  // MAX_SHELLS, the one used longest ago goes (ended ones first).
  touch(id) {
    const t = this.terms.get(id);
    if (t) t.usedAt = ++this.clock;
    if (this.terms.size <= this.maxShells) return;
    const victims = [...this.terms.entries()].filter(([k]) => k !== id)
      .sort(([, a], [, b]) => (a.running - b.running) || (a.usedAt - b.usedAt));
    for (const [k] of victims.slice(0, this.terms.size - this.maxShells)) this.close(k);
  }

  /** End the shell for `id`, clear it, and start a fresh one. */
  restart(id, { cwd, cols = 80, rows = 24 }) {
    this.close(id);
    this.start(id, cwd, cols, rows);
    this.touch(id);
    return this.snapshot(id);
  }

  start(id, cwd, cols, rows) {
    const t = { pty: null, cwd, buffer: "", sinceTrim: 0, seq: 0, pending: "", timer: null, running: true, code: null };
    this.terms.set(id, t);
    try {
      t.pty = this.spawn(cwd, cols, rows);
    } catch (e) {
      t.running = false;
      this.append(id, t, `\r\nCouldn't start a shell: ${e.message}\r\n`);
      return;
    }
    t.pty.onData((data) => this.terms.get(id) === t && this.append(id, t, data));
    t.pty.onExit(({ exitCode }) => {
      if (this.terms.get(id) !== t) return; // replaced by a restart
      this.flush(id, t);
      t.running = false;
      t.code = exitCode ?? null;
      t.pty = null;
      this.onExit(id, { code: t.code });
    });
  }

  append(id, t, data) {
    t.pending += data;
    if (!this.batchMs) return this.flush(id, t);
    t.timer ||= setTimeout(() => this.flush(id, t), this.batchMs);
  }

  flush(id, t) {
    clearTimeout(t.timer);
    t.timer = null;
    if (!t.pending) return;
    const data = t.pending;
    t.pending = "";
    t.buffer += data;
    t.sinceTrim += data.length;
    if (t.sinceTrim > TRIM_EVERY) { t.buffer = trimScrollback(t.buffer); t.sinceTrim = 0; }
    this.onData(id, { seq: ++t.seq, data });
  }

  /** Everything up to `seq`, so the page can skip live chunks it already has. */
  snapshot(id) {
    const t = this.terms.get(id);
    if (!t) return { exists: false, running: false, seq: 0, data: "" };
    this.flush(id, t);
    t.buffer = trimScrollback(t.buffer);
    t.sinceTrim = 0;
    return { exists: true, running: t.running, code: t.code, cwd: t.cwd, seq: t.seq, data: t.buffer };
  }

  write(id, data) {
    const t = this.terms.get(id);
    if (!t?.running) return false;
    t.usedAt = ++this.clock;
    t.pty.write(String(data));
    return true;
  }

  resize(id, cols, rows) {
    const t = this.terms.get(id);
    const c = Math.floor(cols), r = Math.floor(rows);
    if (!t?.running || !(c > 1 && c < 1000 && r > 1 && r < 500)) return false;
    try { t.pty.resize(c, r); } catch { /* it just ended */ }
    return true;
  }

  /** Stop: hang up the shell, as closing a terminal window does; force it after 2 s. */
  stop(id) {
    const t = this.terms.get(id);
    if (!t?.running) return false;
    const pty = t.pty;
    try { pty.kill("SIGHUP"); } catch { /* gone */ }
    setTimeout(() => { if (t.running && t.pty === pty) try { pty.kill("SIGKILL"); } catch { /* gone */ } }, 2000).unref?.();
    return true;
  }

  /** Forget `id` entirely (its thread was removed, or it restarts). */
  close(id) {
    const t = this.terms.get(id);
    if (!t) return;
    this.terms.delete(id);
    clearTimeout(t.timer);
    if (t.running) try { t.pty.kill("SIGHUP"); } catch { /* gone */ }
  }

  closeAll() {
    for (const id of [...this.terms.keys()]) this.close(id);
  }
}

/**
 * node-pty's spawn, or null with the reason. Loaded lazily, so B5 Code still
 * starts without `npm install`; only the Terminal pane then says so.
 */
export function loadPty(root) {
  try {
    const require = createRequire(path.join(root, "package.json"));
    const dir = path.dirname(require.resolve("node-pty/package.json"));
    // npm unpacks the prebuilt helper without its execute bit, and without it
    // every spawn fails with "posix_spawnp failed".
    for (const helper of [path.join(dir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"), path.join(dir, "build", "Release", "spawn-helper")]) {
      try { if (!(fs.statSync(helper).mode & 0o100)) fs.chmodSync(helper, 0o755); } catch { /* not this one */ }
    }
    const pty = require("node-pty");
    const [shell, args] = terminalShell({ userShell: IS_WIN ? "" : os.userInfo().shell });
    return {
      spawn: (cwd, cols, rows) => {
        const p = pty.spawn(shell, args, { name: "xterm-256color", cols, rows, cwd, env: shellEnv(process.env) });
        // Windows has no signals: node-pty throws at kill("SIGHUP"), and kill() ends the shell.
        if (IS_WIN) { const end = p.kill.bind(p); p.kill = () => end(); }
        return p;
      },
      error: null,
    };
  } catch (e) {
    return { spawn: null, error: `The terminal needs node-pty. Run \`npm install\` in ${root}, then \`b5 restart\`. (${e.message})` };
  }
}
