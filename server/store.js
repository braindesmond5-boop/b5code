// Projects, threads and each thread's saved events, kept in data/.
//
// The rules (what a valid project is, how a thread gets its title) are pure
// functions on a plain state object; Store only adds reading and writing it.
// Writes go to a temp file and are renamed into place, so a crash mid-write
// never leaves a half-written state.json.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const COLORS = ["#2563eb", "#16a34a", "#ea580c", "#9333ea", "#0891b2", "#db2777", "#ca8a04", "#4f46e5"];
const TITLE_MAX = 60;

export const emptyState = () => ({ projects: [], threads: [], settings: { ...SERVER_DEFAULTS } });
// Settings the server acts on (the page's own look and feel stays in the browser).
// extraAccounts: more than one Claude account (server/accounts.js), off until you turn it on.
export const SERVER_DEFAULTS = { keepAwake: true, autoResume: true, autoSwitch: true, autoUpdate: true, chatWeb: true, studioAutostart: true, extraAccounts: false, queueCarryOn: true, agentHandoff: true };
const newId = () => crypto.randomBytes(6).toString("hex");

export function addProject(state, { name, dir, kind }) {
  const clean = path.resolve(dir);
  if (state.projects.some((p) => p.dir === clean)) throw new Error("That folder is already a project.");
  const project = {
    id: newId(),
    name: (name || path.basename(clean)).trim().slice(0, 40) || path.basename(clean),
    dir: clean,
    color: COLORS[state.projects.length % COLORS.length],
    ...(kind === "work" || kind === "chat" ? { kind } : {}), // a Work space (everyday work, not code: WORK_PROMPT) or Chat (conversations: CHAT_PROMPT)
  };
  return { state: { ...state, projects: [...state.projects, project] }, project };
}

export function addThread(state, projectId, now = Date.now()) {
  if (!state.projects.some((p) => p.id === projectId)) throw new Error("No such project.");
  const thread = { id: newId(), projectId, title: "New thread", sessionId: null, createdAt: now, updatedAt: now };
  return { state: { ...state, threads: [thread, ...state.threads] }, thread };
}

export function updateThread(state, id, patch, now = Date.now()) {
  let found = false;
  const threads = state.threads.map((t) => {
    if (t.id !== id) return t;
    found = true;
    return { ...t, ...patch, updatedAt: now };
  });
  if (!found) throw new Error("No such thread.");
  return { ...state, threads };
}

export function updateProject(state, id, patch) {
  if (!state.projects.some((p) => p.id === id)) throw new Error("No such project.");
  return { ...state, projects: state.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) };
}

export function removeProject(state, id) {
  return { ...state, projects: state.projects.filter((p) => p.id !== id), threads: state.threads.filter((t) => t.projectId !== id),
    recipes: (state.recipes || []).filter((r) => r.projectId !== id), automations: (state.automations || []).filter((a) => a.projectId !== id) };
}

/** Extra `claude` flags a project's settings ask for. */
export function projectArgs(project) {
  // No connectors: start Claude Code with an empty MCP list and nothing else.
  // Measured on Flaevo: a short reply in about 5 s instead of 7 s, and no
  // slow outliers while 17 connectors connect.
  return project?.connectors === "off" ? ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'] : [];
}

/**
 * A recipe: a task that went well, kept to run again with new material
 * ("Turn these lecture slides into revision notes"). Shown on its Work
 * space's new-thread screen; picking one puts its prompt in the composer.
 */
export function addRecipe(state, { projectId, name, prompt }, now = Date.now()) {
  if (!state.projects.some((p) => p.id === projectId)) throw new Error("No such project.");
  const text = String(prompt || "").trim().slice(0, 4000);
  if (!text) throw new Error("A recipe needs what to ask Claude.");
  const recipe = { id: newId(), projectId, name: String(name || "").trim().slice(0, 60) || titleFrom(text), prompt: text, createdAt: now };
  return { state: { ...state, recipes: [recipe, ...(state.recipes || [])] }, recipe };
}

export function removeRecipe(state, id) {
  return { ...state, recipes: (state.recipes || []).filter((r) => r.id !== id) };
}

/** An automation: a prompt run as a new thread on a schedule or when files land in a folder (server/automations.js). */
export function addAutomation(state, { projectId, name, prompt, trigger }, now = Date.now()) {
  if (!state.projects.some((p) => p.id === projectId)) throw new Error("No such project.");
  const text = String(prompt || "").trim().slice(0, 4000);
  if (!text) throw new Error("An automation needs what to ask Claude.");
  if (!trigger) throw new Error("Pick when it runs.");
  const automation = { id: newId(), projectId, name: String(name || "").trim().slice(0, 60) || titleFrom(text), prompt: text, trigger, enabled: true, createdAt: now, lastRun: 0, lastThreadId: null };
  return { state: { ...state, automations: [...(state.automations || []), automation] }, automation };
}

export function updateAutomation(state, id, patch) {
  if (!(state.automations || []).some((a) => a.id === id)) throw new Error("No such automation.");
  return { ...state, automations: state.automations.map((a) => (a.id === id ? { ...a, ...patch } : a)) };
}

export function removeAutomation(state, id) {
  return { ...state, automations: (state.automations || []).filter((a) => a.id !== id) };
}

/** A thread and its side chats. */
export function removeThread(state, id) {
  return { ...state, threads: state.threads.filter((t) => t.id !== id && t.sideOf !== id) };
}

/**
 * A side chat: a new thread that starts from a copy of `parent`'s
 * conversation (forked when its first message is sent), in the same folder,
 * while the parent carries on. It hangs under the parent in the sidebar.
 */
export function addSide(state, parentId, now = Date.now()) {
  const parent = state.threads.find((t) => t.id === parentId);
  if (!parent) throw new Error("No such thread.");
  if (parent.sideOf) throw new Error("A side chat can't have side chats of its own.");
  const { state: next, thread } = addThread(state, parent.projectId, now);
  const side = { ...thread, title: "Side chat", sideOf: parent.id, forkFrom: parent.sessionId || null,
    ...(parent.dir ? { dir: parent.dir, root: parent.root } : {}), ...(parent.modelPref ? { modelPref: parent.modelPref } : {}),
    ...(parent.provider ? { provider: parent.provider } : {}) }; // forks the parent's own conversation, so it has to be the same agent
  return { state: { ...next, threads: next.threads.map((t) => (t.id === thread.id ? side : t)) }, thread: side };
}

/** A thread's title from its first message: the first line, cut at a word. */
export function titleFrom(text) {
  const line = String(text || "").split("\n").map((l) => l.trim()).find(Boolean) || "New thread";
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX);
  const space = cut.lastIndexOf(" ");
  return (space > 30 ? cut.slice(0, space) : cut) + "…";
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, "state.json");
    this.logDir = path.join(dataDir, "threads");
    fs.mkdirSync(this.logDir, { recursive: true });
    // Conversations, keys and the token: readable by you only (files made before keep theirs, but
    // nobody else can reach them through a folder they can't open).
    for (const d of [dataDir, this.logDir]) { try { fs.chmodSync(d, 0o700); } catch { /* not ours */ } }
    this.state = this.#load();
  }

  #load() {
    let text;
    try { text = fs.readFileSync(this.file, "utf8"); } catch { return emptyState(); } // first run
    try {
      const s = JSON.parse(text);
      // Extra accounts added before their setting existed stay on.
      const accountsOn = s.accounts?.length && s.settings?.extraAccounts === undefined ? { extraAccounts: true } : {};
      return { projects: s.projects || [], threads: s.threads || [], commands: s.commands || {}, models: s.models || [],
        settings: { ...SERVER_DEFAULTS, ...accountsOn, ...(s.settings || {}) },
        accounts: s.accounts || [], accountLimits: s.accountLimits || {}, agentLimits: s.agentLimits || {}, queue: s.queue || { on: false, startAt: 0, seq: 0, tasks: [] },
        carryOn: s.carryOn || [], // threads a restart cut short, to carry on (server/index.js)
        recipes: s.recipes || [], automations: s.automations || [],
        reviewTools: s.reviewTools || [] }; // connector tools a Work space asks before (server/index.js reviewRules)
    } catch {
      // Unreadable: keep it aside rather than let the next save write an
      // empty project list over it.
      const aside = `${this.file}.unreadable-${Date.now()}`;
      try { fs.copyFileSync(this.file, aside); } catch { /* best effort */ }
      console.error(`state.json couldn't be read; kept a copy at ${aside} and started empty.`);
      return emptyState();
    }
  }

  save(next) {
    this.state = next;
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, this.file);
    return next;
  }

  #logFile(threadId) {
    if (!/^[0-9a-f]{12}$/.test(threadId)) throw new Error("Bad thread id.");
    return path.join(this.logDir, `${threadId}.jsonl`);
  }

  appendLog(threadId, event) {
    this.appendLogs(threadId, [event]);
  }

  /** Events that already have a time (an imported conversation's) keep it. */
  appendLogs(threadId, events) {
    if (!events.length) return;
    fs.appendFileSync(this.#logFile(threadId), events.map((e) => JSON.stringify({ ...e, at: e.at || Date.now() })).join("\n") + "\n");
  }

  readLog(threadId) {
    const file = this.#logFile(threadId);
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
    const out = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* a torn last line after a crash */ }
    }
    return out;
  }

  deleteLog(threadId) {
    try { fs.unlinkSync(this.#logFile(threadId)); } catch { /* already gone */ }
  }
}
