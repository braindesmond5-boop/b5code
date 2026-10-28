// One running `claude` process per thread.
//
// It speaks Claude Code's stream-json protocol: our messages go in on stdin,
// its events come out on stdout, one JSON object per line. Permission
// questions arrive as control requests and wait until the page answers them
// (see answerPermission). A thread's process is started on its first message
// and resumed by session id after it has been closed, so a restart of B5 Code
// never loses the conversation, only the process.
//
// A message sent while a turn is running steers it: Claude Code takes it in
// at its next step (or, if the turn is just ending, as the next turn). Each
// message is echoed back when Claude Code takes it in (--replay-user-messages),
// so the session knows which messages are still queued, and a turn's end
// with one still queued isn't the end ("more"). Each message carries its own
// uuid, which the echo repeats, so an echo is matched to its message exactly.

import { spawn } from "node:child_process";
import readline from "node:readline";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { normalize } from "./events.js";
import { claude } from "./platform.js";
import { ASK_TOOL } from "../web/questions.js";

const SETTLE_MS = 20000; // compaction or a hook can hold a queued message that long

export class ClaudeSession extends EventEmitter {
  /**
   * @param {{cwd: string, sessionId?: string|null, fork?: boolean, command?: string, extraArgs?: string[]}} opts
   * `fork`: start a new conversation from a copy of `sessionId`'s (a side chat).
   * The copy has no id of its own until Claude Code's init gives it one, so
   * `sessionId` stays null till then and a start before it forks again.
   * `command`: what to run instead of Claude Code (tests: a command, or [command, ...its args]); by default `claude` (server/platform.js).
   */
  constructor({ cwd, sessionId = null, fork = false, command = null, extraArgs = [], model = null, env = process.env, account = "main" }) {
    super();
    this.env = env; // an extra account's sets CLAUDE_CONFIG_DIR (server/accounts.js)
    this.account = account;
    this.cwd = cwd;
    this.forkFrom = fork && sessionId ? sessionId : null;
    this.sessionId = this.forkFrom ? null : sessionId;
    [this.command, this.commandArgs] = !command ? claude() : Array.isArray(command) ? [command[0], command.slice(1)] : [command, []];
    this.extraArgs = extraArgs;
    this.model = model;
    this.proc = null;
    this.busy = false;
    this.pending = new Map(); // requestId -> the tool input it asked about
    this.pendingTools = new Map(); // requestId -> the tool's name
    this.queued = []; // { uuid, steer } sent and not yet taken in, oldest first (steer: sent mid-turn)
    this.held = null; // a turn's end that came while a message was still queued
    this.stopping = false; // Stop was pressed: queued messages are dropped, not run
    this.dropped = new Map(); // uuid -> when: given up on at a Stop, though Claude Code may still start them
    this.swallow = false; // such a message's turn is running: it's stopped, and nothing of it shown
    this.late = new Set(); // uuids of steers given up on after SETTLE_MS, which Claude Code may still take in
  }

  get running() {
    return !!this.proc;
  }

  #start() {
    const args = [
      ...this.commandArgs,
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-prompts", "host",
      "--permission-prompt-tool", "stdio",
      "--replay-user-messages",
      ...this.extraArgs,
    ];
    if (this.sessionId) args.push("--resume", this.sessionId);
    else if (this.forkFrom) args.push("--resume", this.forkFrom, "--fork-session");
    if (this.model) args.push("--model", this.model);
    this.emit("event", { kind: "phase", phase: "starting" });
    const proc = spawn(this.command, args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], env: this.env });
    this.proc = proc;

    readline.createInterface({ input: proc.stdout }).on("line", (line) => this.#onLine(line));
    let errTail = "";
    proc.stderr.on("data", (d) => { errTail = (errTail + d).slice(-2000); });
    // Writing to a process that already went away must not crash the server.
    proc.stdin.on("error", () => {});
    let ended = false;
    const end = (code, error) => {
      if (ended) return;
      ended = true;
      if (this.proc === proc) this.proc = null;
      clearTimeout(this.held?.timer);
      this.held = null;
      for (const q of this.queued) if (q.steer) this.emit("event", { kind: "steer_lost" });
      this.queued = [];
      this.dropped.clear();
      this.swallow = false;
      this.stopping = false;
      if (this.busy) {
        this.busy = false;
        this.emit("event", { kind: "done", ok: false, error: error || errTail.trim().split("\n").pop() || `Claude Code stopped (exit ${code}).`, durationMs: 0 });
      }
      for (const id of this.pending.keys()) this.emit("event", { kind: "permission_closed", requestId: id });
      this.pending.clear();
      this.pendingTools.clear();
      this.emit("exit", code);
    };
    // A process that never started (no `claude` on the PATH) reports only
    // "error", never "exit": end the same way, or the thread stays "working".
    proc.on("error", (e) => end(null, `Could not start Claude Code: ${e.message}`));
    proc.on("exit", (code) => end(code));

    this.#write({ type: "control_request", request_id: "init-" + crypto.randomUUID(), request: { subtype: "initialize" } });
  }

  #write(obj) {
    if (!this.proc) return false;
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
    return true;
  }

  #onLine(line) {
    let raw;
    try { raw = JSON.parse(line); } catch { return; }
    if (raw.type === "system" && raw.subtype === "init" && raw.session_id) { this.sessionId = raw.session_id; this.forkFrom = null; }
    if (raw.type === "control_request" && raw.request?.subtype === "can_use_tool") {
      this.pending.set(raw.request_id, raw.request.input);
      this.pendingTools.set(raw.request_id, raw.request.tool_name);
    }
    for (const ev of normalize(raw)) {
      if (ev.kind === "replay") { this.#taken(ev.uuid); continue; }
      if (this.swallow) { if (ev.kind === "done") this.swallow = false; continue; }
      if (ev.kind === "done") { this.#turnEnded(ev); continue; }
      this.emit("event", ev);
    }
  }

  /** Claude Code took in a message: the one with this uuid, or (no uuid given) the oldest. */
  #taken(uuid) {
    // One given up on at a Stop: Claude Code started it anyway, so stop that too, unseen.
    const dropped = uuid ? this.dropped.has(uuid) : !this.queued.length && this.dropped.size > 0;
    if (dropped) {
      this.dropped.delete(uuid || this.dropped.keys().next().value);
      this.swallow = true;
      this.#write({ type: "control_request", request_id: "stop-" + crypto.randomUUID(), request: { subtype: "interrupt" } });
      return;
    }
    // A steer given up on after the wait, taken in after all: a turn is running for it.
    if (uuid && this.late.has(uuid)) {
      this.late.delete(uuid);
      this.busy = true;
      this.emit("event", { kind: "steer_ack" });
      return;
    }
    if (!this.queued.length) return;
    // A real message taken in while a dropped one was being stopped: its turn is shown, not swallowed.
    this.swallow = false;
    const i = Math.max(0, this.queued.findIndex((q) => q.uuid === uuid));
    const [q] = this.queued.splice(i, 1);
    if (this.held) { clearTimeout(this.held.timer); this.held = null; }
    if (q.steer) this.emit("event", { kind: "steer_ack" });
  }

  /** At a Stop: queued messages won't run. Kept by uuid a minute, in case Claude Code starts one anyway. */
  #dropQueued() {
    const now = Date.now();
    for (const [id, at] of this.dropped) if (now - at > 60000) this.dropped.delete(id);
    for (const q of this.queued) {
      if (q.steer) this.emit("event", { kind: "steer_lost" });
      this.dropped.set(q.uuid, now);
    }
    this.queued = [];
  }

  // A turn's end. With a message still queued Claude Code carries on with it,
  // so it's sent as "more" and the thread stays busy. If the message is never
  // taken in (a Stop can drop it), the end counts after a few seconds.
  #turnEnded(ev) {
    // After a Stop, the turn ends here: anything still queued is dropped.
    if (this.stopping) {
      this.stopping = false;
      this.#dropQueued();
    }
    if (!this.queued.length) { clearTimeout(this.held?.timer); this.held = null; this.busy = false; this.emit("event", ev); return; }
    this.emit("event", { ...ev, more: true });
    clearTimeout(this.held?.timer);
    this.held = { timer: setTimeout(() => {
      if (!this.held) return;
      this.held = null;
      for (const q of this.queued) { if (q.steer) this.emit("event", { kind: "steer_lost" }); this.late.add(q.uuid); }
      this.queued = [];
      this.busy = false;
      this.emit("event", { ...ev, durationMs: 0 });
    }, SETTLE_MS) };
  }

  /**
   * Start Claude Code now, before there is anything to send, so the two or
   * three seconds it takes to load are spent while you are still typing.
   */
  warm() {
    if (!this.proc) this.#start();
  }

  /**
   * @param {string | object[]} text plain text, or content blocks (text and images)
   * @returns {boolean} whether it steers a turn that's already running
   */
  send(text) {
    const cold = !this.proc;
    if (cold) this.#start();
    const steer = this.busy;
    this.busy = true;
    this.stopping = false;
    const uuid = crypto.randomUUID();
    this.queued.push({ uuid, steer });
    // A warm process was already waiting: the next stage is the model.
    if (!cold && !steer) this.emit("event", { kind: "phase", phase: "waiting" });
    this.#write({ type: "user", uuid, message: { role: "user", content: text } });
    return steer;
  }

  /** Switch model; a running process changes at once, a later one starts on it. */
  setModel(model) {
    this.model = model || null;
    if (!this.proc) return true;
    return this.#write({ type: "control_request", request_id: "model-" + crypto.randomUUID(), request: { subtype: "set_model", model: model || "default" } });
  }

  /** @param {"allow"|"deny"|"allow-edits"} choice */
  /**
   * `answers`: Claude's questions answered (web/questions.js), given to the tool with its input.
   * A question can't be allowed without them: it would reach Claude unanswered.
   */
  answerPermission(requestId, choice, { answers = null } = {}) {
    if (!this.pending.has(requestId)) return false;
    const input = this.pending.get(requestId);
    // Claude's own question tool, not just any tool whose input has questions (a survey connector's, say).
    const question = this.pendingTools.get(requestId) === ASK_TOOL && Array.isArray(input?.questions);
    if (question && choice !== "deny" && !answers) return false;
    this.pending.delete(requestId);
    this.pendingTools.delete(requestId);
    const response = choice === "deny"
      ? { behavior: "deny", message: question ? "The user skipped the question. Ask in your reply instead, or carry on with your best judgement." : "The user said no." }
      : {
        behavior: "allow",
        updatedInput: answers ? { ...input, answers } : input,
        ...(choice === "allow-edits" ? { updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] } : {}),
      };
    return this.#write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
  }

  /** Stop the current turn; the process stays for the next message. */
  interrupt() {
    if (!this.busy) return false;
    this.stopping = true;
    // A turn's end already held for a queued message: it ends now.
    if (this.held) {
      clearTimeout(this.held.timer);
      this.held = null;
      this.#dropQueued();
      this.busy = false;
      this.stopping = false;
      this.emit("event", { kind: "done", ok: false, error: "interrupted", durationMs: 0 });
    }
    return this.#write({ type: "control_request", request_id: "stop-" + crypto.randomUUID(), request: { subtype: "interrupt" } });
  }

  /** End the process; the thread resumes from its session id next time. `now` (B5 Code is quitting) doesn't wait for it to finish. */
  close({ now = false } = {}) {
    if (!this.proc) return;
    this.proc.stdin.end();
    const p = this.proc;
    if (now) { p.kill("SIGTERM"); return; }
    setTimeout(() => { if (!p.killed && p.exitCode === null) p.kill("SIGTERM"); }, 3000);
  }
}
