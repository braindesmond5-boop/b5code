// One running OpenCode server per thread.
//
// `opencode serve` is started on a random local port, behind a password only
// this process knows. Messages go in over its HTTP API (prompt_async), its
// events come back on the /event stream, and openCodeEvents turns those into
// the same B5 Code events Claude Code's become (server/events.js), so the page
// draws both alike. A thread resumes by session id: OpenCode keeps its
// sessions on disk, so a restart of B5 Code loses the process, not the chat.
//
// It has the same methods and events as ClaudeSession (server/session.js).
// What it can't do is in server/agents.js: a message sent mid-turn waits for
// its turn rather than steering the running one, and there are no usage limits
// to show.

import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { toolSummary, toolChange } from "./tools.js";
import { toolDetail, resultPreview } from "./events.js";
import { HOME_DIR, IS_WIN } from "./platform.js";
import { baseName } from "../web/paths.js";
import { ASK_TOOL } from "../web/questions.js";

/** Where `opencode` is, or null: on the PATH, or where its installers put it. */
export function findOpenCode({ env = process.env, exists = fs.existsSync, home = HOME_DIR, win = IS_WIN } = {}) {
  const dirs = String(env.PATH || env.Path || "").split(win ? ";" : ":").filter(Boolean);
  dirs.push(path.join(home, ".local", "bin"), path.join(home, ".opencode", "bin"));
  for (const d of dirs) {
    const f = path.join(d, win ? "opencode.exe" : "opencode");
    if (exists(f)) return f;
  }
  return null;
}

/** `opencode models` output ("provider/model" a line) as the page's model list. The free ones are marked. */
export function parseModels(text) {
  const SAY = { glm: "GLM", gpt: "GPT", vl: "VL", deepseek: "DeepSeek", mimo: "MiMo" };
  const word = (w) => SAY[w] || (/^\d/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1));
  const words = (s) => s.replace(/-free$/, "").split(/[-_]/).filter(Boolean).map(word).join(" ");
  return String(text || "").split("\n").map((l) => l.trim()).filter((l) => /^[\w.-]+\/[\w.:@+-]+$/.test(l)).slice(0, 80).map((value) => {
    const [provider, ...rest] = value.split("/");
    const model = rest.join("/");
    const free = /-free$/.test(model) || value === "opencode/big-pickle";
    // The tag says "free" already; a model from another provider says which.
    return { value, name: words(model), description: provider === "opencode" ? "" : provider, free };
  });
}

/** The models OpenCode offers on this computer: the free ones need no sign-in, the rest are the providers you've added. */
export function listOpenCodeModels({ command = findOpenCode() } = {}) {
  return new Promise((resolve) => {
    if (!command) return resolve([]);
    execFile(command, ["models"], { timeout: 20000, maxBuffer: 1e6, windowsHide: true }, (err, out) => resolve(err ? [] : parseModels(out)));
  });
}

// OpenCode's tools by the names (and input fields) the rest of B5 Code words and draws them by.
const TOOL_NAMES = { read: "Read", write: "Write", edit: "Edit", bash: "Bash", grep: "Grep", glob: "Glob", webfetch: "WebFetch", websearch: "WebSearch", task: "Task", todowrite: "TodoWrite", question: ASK_TOOL };

/** OpenCode's questions as Claude's (the page draws both as the same card): `multiple` is `multiSelect`. */
export const questionsFrom = (list) => (Array.isArray(list) ? list : []).map((q) => ({
  question: String(q?.question || ""), header: String(q?.header || ""), multiSelect: q?.multiple === true,
  options: (Array.isArray(q?.options) ? q.options : []).map((o) => ({ label: String(o?.label || ""), description: String(o?.description || "") })),
}));

/** The labels a question's answer is made of, as OpenCode takes them: a multiple choice's picks were joined with ", ". */
export const labelsOf = (q, answer) => {
  const a = String(answer || "").trim();
  return q.multiSelect ? a.split(", ").map((x) => x.trim()).filter(Boolean) : [a];
};
const toolName = (t) => TOOL_NAMES[t] || String(t || "Tool");
function toolInput(tool, i = {}) {
  if (tool === "read" || tool === "write") return { file_path: i.filePath, content: i.content };
  if (tool === "edit") return { file_path: i.filePath, old_string: i.oldString, new_string: i.newString };
  if (tool === "question") return { questions: questionsFrom(i.questions) };
  return i;
}

export const newTurnState = () => ({ roles: new Map(), types: new Map(), tools: new Set(), texts: new Set(), output: 0, error: "" });

/**
 * One OpenCode event in, a list of B5 Code events out. `st` (newTurnState) is
 * what the stream has said so far: who wrote each message, what each part is.
 */
export function openCodeEvents(raw, st) {
  const p = raw?.properties || {};
  switch (raw?.type) {
    case "message.updated": {
      const i = p.info;
      if (!i) return [];
      st.roles.set(i.id, i.role);
      if (i.role === "assistant" && i.time?.completed) st.output += i.tokens?.output || 0;
      if (i.error) st.error = i.error.data?.message || i.error.name || "Stopped";
      return [];
    }
    case "message.part.updated": {
      const part = p.part;
      if (!part || st.roles.get(part.messageID) === "user") return [];
      st.types.set(part.id, part.type);
      if (part.type === "reasoning") return [{ kind: "phase", phase: "thinking" }];
      if (part.type === "text") {
        if (!part.time?.end || st.texts.has(part.id) || !part.text) return [];
        st.texts.add(part.id);
        return [{ kind: "text", text: part.text }];
      }
      if (part.type === "tool") return toolEvents(part, st);
      return [];
    }
    case "message.part.delta": {
      if (p.field !== "text" || st.roles.get(p.messageID) === "user") return [];
      return st.types.get(p.partID) === "reasoning" ? [{ kind: "grow", n: (p.delta || "").length }] : [{ kind: "delta", text: p.delta || "" }];
    }
    case "session.status":
      if (p.status?.type === "busy") return [{ kind: "phase", phase: "waiting" }];
      return p.status?.type === "retry" ? [{ kind: "phase", phase: "status", label: "retrying" }] : [];
    case "session.idle":
      return [{ kind: "done", ok: !st.error, error: st.error, durationMs: 0, ...(st.output ? { output: st.output } : {}) }];
    case "session.error": {
      const e = p.error;
      return [{ kind: "done", ok: false, error: e?.data?.message || e?.name || "Stopped", durationMs: 0, aborted: e?.name === "MessageAbortedError" }];
    }
    case "permission.asked": {
      const tool = toolName(p.permission);
      const input = { ...(p.metadata || {}), patterns: p.patterns || [] };
      const file = p.metadata?.filepath || p.metadata?.filePath || p.patterns?.[0] || "";
      const summary = p.permission === "bash" ? `Run ${String(p.patterns?.[0] || p.metadata?.command || "a command").slice(0, 60)}` : p.permission === "edit" ? `Edit ${baseName(file)}` : `${tool} ${String(p.patterns?.[0] || "").slice(0, 50)}`.trim();
      return [{ kind: "permission", requestId: p.id, tool, summary, detail: p.metadata?.command || p.metadata?.diff || (p.patterns || []).join("\n"), input, canAllowEdits: p.permission === "edit" }];
    }
    case "question.asked": {
      const input = { questions: questionsFrom(p.questions) };
      return [{ kind: "permission", requestId: p.id, tool: ASK_TOOL, summary: toolSummary(ASK_TOOL, input), detail: "", input, canAllowEdits: false }];
    }
    case "permission.replied":
    case "question.replied":
    case "question.rejected":
      return [{ kind: "permission_closed", requestId: p.requestID }];
    default:
      return [];
  }
}

function toolEvents(part, st) {
  const s = part.state || {};
  const out = [];
  if (!st.tools.has(part.callID) && (s.status === "running" || s.status === "completed" || s.status === "error")) {
    st.tools.add(part.callID);
    const input = toolInput(part.tool, s.input);
    const name = toolName(part.tool);
    const change = toolChange(name, input);
    out.push({ kind: "tool", id: part.callID, name, summary: toolSummary(name, input), detail: change ? "" : toolDetail(s.input), ...(change ? { change } : {}) });
  }
  if (s.status === "completed") out.push({ kind: "tool_result", id: part.callID, ok: true, preview: resultPreview(s.output) });
  if (s.status === "error") out.push({ kind: "tool_result", id: part.callID, ok: false, preview: resultPreview(s.error) });
  return out;
}

const CONFIG = { permission: { edit: "ask", bash: "ask" } }; // asks before changing a file or running a command, as a Claude thread does

export class OpenCodeSession extends EventEmitter {
  /** @param {{cwd: string, sessionId?: string|null, fork?: boolean, command?: string|null, model?: string|null}} opts `model`: "provider/model"; none means OpenCode's own default. */
  constructor({ cwd, sessionId = null, fork = false, command = null, model = null, effort = null, env = process.env, account = "main" }) {
    super();
    this.cwd = cwd;
    this.env = env;
    this.account = account;
    this.effort = effort; // not used: OpenCode has no such setting
    this.command = command || findOpenCode({ env }) || "opencode";
    this.forkFrom = fork && sessionId ? sessionId : null;
    this.sessionId = this.forkFrom ? null : sessionId;
    this.model = model;
    this.proc = null;
    this.busy = false;
    this.pending = new Map(); // requestId -> the permission's input
    this.gate = null;
    this.stopping = false;
    this.turnAt = 0;
    this.st = newTurnState();
    this.base = "";
    this.auth = "";
    this.stream = null;
  }

  get running() {
    return !!this.proc;
  }

  #start() {
    const password = crypto.randomBytes(16).toString("hex");
    this.auth = "Basic " + Buffer.from("opencode:" + password).toString("base64");
    this.emit("event", { kind: "phase", phase: "starting" });
    const proc = spawn(this.command, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: this.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...this.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify(CONFIG) },
    });
    this.proc = proc;
    let errTail = "";
    proc.stderr.on("data", (d) => { errTail = (errTail + d).slice(-2000); });
    const listening = new Promise((resolve, reject) => {
      let out = "";
      proc.stdout.on("data", (d) => {
        out = (out + d).slice(-2000);
        const m = /listening on (http:\/\/\S+)/.exec(out);
        if (m) resolve(m[1]);
      });
      proc.on("exit", () => reject(new Error(errTail.trim().split("\n").pop() || "OpenCode stopped before it was ready.")));
      proc.on("error", (e) => reject(new Error(`Could not start OpenCode: ${e.message}`)));
    });
    let ended = false;
    const end = (code, error) => {
      if (ended) return;
      ended = true;
      if (this.proc === proc) this.proc = null;
      this.stream?.abort();
      if (this.busy) {
        this.busy = false;
        this.emit("event", { kind: "done", ok: false, error: error || errTail.trim().split("\n").pop() || (code == null ? "OpenCode stopped." : `OpenCode stopped (exit ${code}).`), durationMs: 0 });
      }
      for (const id of this.pending.keys()) this.emit("event", { kind: "permission_closed", requestId: id });
      this.pending.clear();
      this.emit("exit", code);
    };
    proc.on("error", (e) => end(null, `Could not start OpenCode: ${e.message}`));
    proc.on("exit", (code) => end(code));
    this.ready = listening.then(async (base) => {
      this.base = base;
      await this.#openSession();
      await this.#listen(); // before anything is sent: what the server says meanwhile would be missed
      await this.#pendingPermissions();
      this.emit("event", { kind: "init", sessionId: this.sessionId, model: this.model || "", cwd: this.cwd, connectors: [], review: [] });
    });
    this.ready.catch((e) => end(null, e.message));
  }

  async #openSession() {
    if (this.forkFrom) {
      this.sessionId = (await this.#http("POST", `/session/${this.forkFrom}/fork`, {})).id;
      this.forkFrom = null;
    } else if (!this.sessionId) {
      this.sessionId = (await this.#http("POST", "/session", {})).id;
    }
  }

  async #http(method, route, body) {
    const url = `${this.base}${route}${route.includes("?") ? "&" : "?"}directory=${encodeURIComponent(this.cwd)}`;
    const r = await fetch(url, { method, headers: { authorization: this.auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`OpenCode ${method} ${route}: ${r.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  /** Open the event stream; resolves once the server says it's connected (or after 3 s, so a quiet one can't hold a message back). */
  #listen() {
    const ac = (this.stream = new AbortController());
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      const connected = () => { clearTimeout(timer); resolve(); };
      fetch(`${this.base}/event?directory=${encodeURIComponent(this.cwd)}`, { headers: { authorization: this.auth }, signal: ac.signal })
        .then(async (r) => {
          const dec = new TextDecoder();
          let buf = "";
          for await (const chunk of r.body) {
            buf += dec.decode(chunk, { stream: true });
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
              if (!data) continue;
              try {
                const ev = JSON.parse(data);
                if (ev.type === "server.connected") connected();
                this.#onEvent(ev);
              } catch { /* a line that isn't an event */ }
            }
          }
        })
        .catch(connected);
    });
  }

  /** A resumed session may be waiting on a permission asked before this connection (B5 Code restarted mid-turn): ask again. */
  async #pendingPermissions() {
    try {
      const waiting = await this.#http("GET", "/permission");
      for (const p of Array.isArray(waiting) ? waiting : []) if (p.sessionID === this.sessionId) this.#onEvent({ type: "permission.asked", properties: p });
    } catch { /* none to show */ }
  }

  #onEvent(raw) {
    const p = raw.properties || {};
    const sid = p.sessionID || p.info?.sessionID || p.part?.sessionID;
    if (sid && sid !== this.sessionId) return;
    for (const ev of openCodeEvents(raw, this.st)) {
      if (ev.kind === "permission") this.pending.set(ev.requestId, ev.input);
      if (ev.kind === "permission_closed") this.pending.delete(ev.requestId);
      if (ev.kind === "done") {
        if (!this.busy) continue; // an idle with no turn of ours behind it
        this.busy = false;
        const aborted = ev.aborted || this.stopping;
        this.stopping = false;
        const done = { ...ev, durationMs: Date.now() - this.turnAt, sessionId: this.sessionId };
        delete done.aborted;
        if (aborted) { done.ok = false; done.error = "interrupted"; }
        this.st = newTurnState();
        this.emit("event", done);
        continue;
      }
      this.emit("event", ev);
    }
  }

  /** Start OpenCode now, before there is anything to send. */
  warm() {
    if (!this.proc) this.#start();
  }

  /**
   * @param {string | object[]} text plain text, or content blocks (text and images)
   * @param {{before?: Promise}} opts `before`: the message goes to OpenCode only once this settles
   * @returns {boolean} whether it steers a running turn: never, OpenCode runs it after
   */
  send(text, { before = null } = {}) {
    if (!this.proc) this.#start();
    if (!this.busy) { this.busy = true; this.turnAt = Date.now(); this.stopping = false; }
    this.gate = Promise.resolve(this.gate)
      .then(() => before).catch(() => {})
      .then(() => this.ready)
      .then(() => this.#http("POST", `/session/${this.sessionId}/prompt_async`, {
        ...(this.model && this.model.includes("/") ? { model: { providerID: this.model.split("/")[0], modelID: this.model.split("/").slice(1).join("/") } } : {}),
        parts: toParts(text),
      }))
      .catch((e) => {
        if (!this.busy) return;
        this.busy = false;
        this.emit("event", { kind: "done", ok: false, error: e.message, durationMs: 0 });
      });
    return false;
  }

  /** The next message goes to this model ("provider/model"). */
  setModel(model) {
    this.model = model || null;
    return true;
  }

  /** @param {"allow"|"deny"|"allow-edits"} choice */
  answerPermission(requestId, choice, { answers = null, message = null } = {}) {
    if (!this.pending.has(requestId)) return false;
    const questions = this.pending.get(requestId)?.questions;
    if (Array.isArray(questions)) {
      // Its question: answered with the picks, or skipped.
      if (choice !== "deny" && !answers) return false;
      this.pending.delete(requestId);
      const call = choice === "deny" ? this.#http("POST", `/question/${requestId}/reject`, {}) : this.#http("POST", `/question/${requestId}/reply`, { answers: questions.map((q) => labelsOf(q, answers[q.question])) });
      call.catch(() => {});
      return true;
    }
    this.pending.delete(requestId);
    const reply = choice === "deny" ? "reject" : choice === "allow-edits" ? "always" : "once";
    this.#http("POST", `/permission/${requestId}/reply`, { reply, ...(message && reply === "reject" ? { message } : {}) }).catch(() => {});
    return true;
  }

  /** Stop the current turn; the server stays for the next message. */
  interrupt() {
    if (!this.busy) return false;
    this.stopping = true;
    this.#http("POST", `/session/${this.sessionId}/abort`, {}).catch(() => {});
    return true;
  }

  /** End the server; the thread resumes from its session id next time. */
  close() {
    this.stream?.abort();
    this.proc?.kill("SIGTERM");
  }
}

/** Text and images (Claude's content blocks) as OpenCode message parts. */
function toParts(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return (Array.isArray(content) ? content : []).flatMap((b) => {
    if (b?.type === "text") return [{ type: "text", text: b.text || "" }];
    if (b?.type === "image" && b.source?.type === "base64") return [{ type: "file", mime: b.source.media_type, url: `data:${b.source.media_type};base64,${b.source.data}` }];
    return [];
  });
}
