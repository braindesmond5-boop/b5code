// A thread's events folded into the items the conversation shows: your
// messages, Claude's replies, runs of tool steps grouped into one quiet
// block, the pages Claude made (artifacts), permission questions and errors. Pure: the page re-runs `apply` for
// each event and draws the items, and the tests run it on recorded events.
//
// Also kept: Claude's to-do list (`todos`, shown above the composer), the
// work it has going in the background (`tasks`: commands, agents), a recap
// at the end of a turn that did real work, and a card while a thread waits
// out a usage limit.

import { changeCounts } from "./diff.js";
import { commandReceipt } from "./receipt.js";

export const emptyFeed = () => ({ items: [], working: false, waiting: 0, todos: [], tasks: [], turnStart: 0 });

const last = (feed) => feed.items[feed.items.length - 1];

function finishLive(feed) {
  const l = last(feed);
  if (l && l.type === "ai" && l.live) l.live = false;
}

function findStep(feed, id) {
  for (let i = feed.items.length - 1; i >= 0; i--) {
    const it = feed.items[i];
    if (it.type === "steps") {
      const s = it.steps.find((x) => x.id === id);
      if (s) return s;
    }
  }
  return null;
}

/** Fold one B5 Code event into the feed. Mutates and returns it. */
export function apply(feed, ev) {
  switch (ev.kind) {
    case "user":
      finishLive(feed);
      // Sent while Claude works: it steers the running turn, which carries on.
      if (ev.steer) {
        feed.items.push({ type: "user", text: ev.text, files: ev.files || [], steer: "queued" });
        feed.working = true;
        break;
      }
      feed.items.push({ type: "user", text: ev.text, files: ev.files || [], ...(ev.auto ? { auto: ev.auto } : {}) });
      feed.tasks = feed.tasks.filter((t) => t.status === "running"); // what finished was the last turn's news
      feed.turnStart = feed.items.length;
      feed.working = true;
      feed.startedAt = ev.at || Date.now();
      feed.seed = (feed.seed || 0) + 13;
      feed.out = { done: 0, now: 0, chars: 0, exact: false }; // this turn's output tokens
      if (!feed.phase) feed.phase = { phase: "waiting", since: Date.now() };
      break;

    case "message_start":
      // A new request: the last one's output is final, and its context is the conversation's size.
      if (feed.out) feed.out = { done: turnOutput(feed), now: 0, chars: 0, exact: false };
      if (ev.context) feed.context = ev.context;
      break;

    case "grow":
      if (feed.out && !feed.out.exact) feed.out.chars += ev.n || 0;
      break;

    case "tokens":
      if (feed.out) { feed.out.now = ev.output; feed.out.exact = true; }
      break;

    case "steer_ack":
    case "steer_lost": {
      // A steer called lost can still be taken in late: the oldest one waiting (or lost) is it.
      const m = feed.items.find((x) => x.type === "user" && x.steer === "queued") || (ev.kind === "steer_ack" ? feed.items.find((x) => x.type === "user" && x.steer === "lost") : null);
      if (m) m.steer = ev.kind === "steer_ack" ? "taken" : "lost";
      if (ev.kind === "steer_ack") feed.working = true;
      break;
    }

    case "note":
      feed.items.push({ type: "note", text: ev.text || "" });
      break;

    case "account":
      finishLive(feed);
      feed.items.push({ type: "note", account: true, text: accountNote(ev) });
      break;

    case "limit":
      finishLive(feed);
      for (const it of feed.items) if (it.type === "limit" && it.state === "waiting") it.state = "replaced";
      feed.items.push({ type: "limit", resumeAt: ev.resumeAt, known: ev.known !== false, state: "waiting" });
      feed.resumeAt = ev.resumeAt;
      break;

    // A thread carried on with another agent at a limit (server/index.js): offered, cancelled, or done.
    case "handoff_offer":
      finishLive(feed);
      for (const it of feed.items) {
        if (it.type === "handoff" && it.state === "offer") it.state = "replaced";
        if (it.type === "limit" && it.state === "waiting") { it.state = "replaced"; it.byHandoff = true; } // the offer says when the limit resets
      }
      feed.items.push({ type: "handoff", state: "offer", from: ev.from, to: ev.to, fromName: ev.fromName, toName: ev.toName, at: ev.at, resetAt: ev.resetAt || 0 });
      break;

    case "handoff_cancel": {
      const it = [...feed.items].reverse().find((x) => x.type === "handoff" && x.state === "offer");
      if (it) { it.state = "cancelled"; it.resetAt = ev.resetAt || it.resetAt; }
      // Staying put: the thread carries on at its reset as before, so that wait is shown again.
      const wait = [...feed.items].reverse().find((x) => x.type === "limit" && x.byHandoff);
      if (wait) { wait.state = "waiting"; wait.byHandoff = false; }
      break;
    }

    case "handoff_done": {
      const it = [...feed.items].reverse().find((x) => x.type === "handoff" && x.state === "offer");
      if (it) { it.state = "done"; it.how = ev.how; } else feed.items.push({ type: "handoff", state: "done", from: ev.from, to: ev.to, fromName: ev.fromName, toName: ev.toName, how: ev.how, at: ev.at || Date.now() });
      break;
    }

    case "limit_cleared": {
      const it = [...feed.items].reverse().find((x) => x.type === "limit" && x.state === "waiting");
      if (it) { it.state = ev.why || "cancelled"; if (ev.detail) it.detail = ev.detail; }
      feed.resumeAt = null;
      break;
    }

    case "phase":
      // "starting" can arrive just before the message it starts for.
      feed.phase = { phase: ev.phase, tool: ev.tool || "", label: ev.label || "", since: Date.now() };
      break;

    case "delta": {
      const l = last(feed);
      if (feed.out && !feed.out.exact) feed.out.chars += ev.text.length;
      if (l && l.type === "ai" && l.live) l.text += ev.text;
      else feed.items.push({ type: "ai", text: ev.text, live: true });
      feed.working = true;
      break;
    }

    case "text": {
      const l = last(feed);
      if (l && l.type === "ai" && l.live) { l.text = ev.text; l.live = false; }
      else feed.items.push({ type: "ai", text: ev.text, live: false });
      break;
    }

    case "tool": {
      finishLive(feed);
      const step = { id: ev.id, name: ev.name, summary: ev.summary, detail: ev.detail || "", change: ev.change || null, result: "", state: "run" };
      const l = last(feed);
      if (l && l.type === "steps") l.steps.push(step);
      else feed.items.push({ type: "steps", key: "s-" + ev.id, steps: [step] });
      feed.working = true;
      noteTodos(feed, ev);
      break;
    }

    case "task_start":
      if (ev.type === "command" && !ev.background) break; // a step Claude waited on (logs from before it was left out)
      if (!feed.tasks.some((t) => t.id === ev.id)) {
        feed.tasks.push({ id: ev.id, text: ev.text, type: ev.type, background: ev.background, status: "running", now: "", startedAt: ev.at || Date.now() });
      }
      break;

    case "task_progress": {
      const t = feed.tasks.find((x) => x.id === ev.id);
      if (t) Object.assign(t, { now: ev.now === t.text ? "" : ev.now }, ev.tools != null ? { tools: ev.tools } : {}, ev.tokens != null ? { tokens: ev.tokens } : {});
      break;
    }

    case "task_status": {
      const t = feed.tasks.find((x) => x.id === ev.id);
      if (!t || ev.status === "running") break;
      if (t.status === "running") t.endedAt = ev.at || Date.now();
      Object.assign(t, { status: ev.status, now: "" }, ev.summary ? { summary: ev.summary } : {});
      break;
    }

    // Checks B5 Code ran after a turn that edited files (server/checks.js): running, then the results.
    case "checks_running":
    case "checks": {
      let running = feed.items.length - 1; // (not findLastIndex: Safari 15.4+, and the Mac app may be older)
      while (running >= 0 && !(feed.items[running].type === "checks" && feed.items[running].status === "running")) running--;
      // A run's card keeps its key from running to done, so it stays open or folded.
      const key = running >= 0 ? feed.items[running].key : `checks-${(feed.checksSeen = (feed.checksSeen || 0) + 1)}`;
      const item = ev.kind === "checks_running" ? { type: "checks", key, status: "running", names: ev.names || [] }
        : { type: "checks", key, status: ev.status, results: ev.results || [], fix: ev.fix || "", checks: ev.checks || [], runs: ev.runs || [],
          changed: ev.changed || [], projectId: ev.projectId || "", why: ev.why || "" };
      if (running >= 0) feed.items[running] = item; else feed.items.push(item);
      break;
    }

    case "tool_result": {
      const s = findStep(feed, ev.id);
      if (s) { s.result = ev.preview || ""; s.state = ev.ok ? "ok" : "bad"; }
      // A new task's number comes back in its result; a task that failed to be made isn't on the list.
      const t = feed.todos.find((x) => x.toolId === ev.id);
      if (t) {
        const n = /Task #(\S+) created/.exec(ev.preview || "");
        if (n) t.id = n[1];
        else if (!ev.ok) feed.todos = feed.todos.filter((x) => x !== t);
      }
      break;
    }

    case "artifact": {
      // One card per page per turn: a later version in the same turn updates it.
      let turn = feed.items.length;
      while (turn > 0 && (feed.items[turn - 1].type !== "user" || feed.items[turn - 1].steer)) turn--;
      const have = feed.items.slice(turn).find((x) => x.type === "artifact" && x.path === ev.path);
      if (have) Object.assign(have, { version: ev.version, versions: ev.versions, title: ev.title });
      else feed.items.push({ type: "artifact", path: ev.path, version: ev.version, versions: ev.versions, title: ev.title, kind: ev.type });
      break;
    }

    case "permission":
      finishLive(feed);
      feed.items.push({ type: "ask", requestId: ev.requestId, tool: ev.tool, summary: ev.summary, detail: ev.detail || "", change: ev.change || null, canAllowEdits: !!ev.canAllowEdits, answer: null,
        ...(ev.input && typeof ev.input === "object" ? { input: ev.input } : {}) }); // the review card reads it (web/review.js)
      feed.waiting++;
      break;

    case "permission_answer":
    case "permission_closed": {
      const a = feed.items.find((x) => x.type === "ask" && x.requestId === ev.requestId);
      if (a && !a.answer) {
        a.answer = ev.kind === "permission_closed" ? "expired" : ev.choice;
        if (ev.answers) a.answers = ev.answers; // Claude's questions, answered (web/questions.js)
        feed.waiting = Math.max(0, feed.waiting - 1);
      }
      break;
    }

    case "done": {
      finishLive(feed);
      // A message sent mid-turn is still to be taken in: the turn carries on.
      if (ev.more) {
        if (ev.context) feed.context = ev.context;
        break;
      }
      for (const it of feed.items) {
        if (it.type === "steps") for (const s of it.steps) if (s.state === "run") s.state = "ok";
        if (it.type === "ask" && !it.answer) { it.answer = "expired"; }
      }
      feed.waiting = 0;
      feed.working = false;
      feed.phase = null;
      feed.out = null;
      if (ev.context) feed.context = ev.context;
      if (ev.contextWindow) feed.contextWindow = ev.contextWindow;
      const ms = ev.durationMs || (ev.at && feed.startedAt ? ev.at - feed.startedAt : 0);
      const recap = turnRecap(feed.items, feed.turnStart, { ms, tokens: ev.output || 0, testsBefore: feed.tests, commits: ev.commits });
      if (recap) feed.items.push(recap);
      feed.lastTurn = { from: feed.turnStart, ms, tokens: ev.output || 0, testsBefore: feed.tests };
      if (recap?.tests) feed.tests = recap.tests; // the next turn's run is compared with this one
      if (!ev.ok) feed.items.push({ type: "error", text: friendlyError(ev.error) });
      break;
    }

    // The commits a turn made, from the server just after it ended (git, off its event loop):
    // its receipt shows them, or one is made for a turn whose only work was committing.
    case "commits": {
      if (!feed.lastTurn) break;
      let i = feed.items.length - 1;
      while (i >= feed.lastTurn.from && feed.items[i].type !== "recap") i--;
      if (i >= feed.lastTurn.from) feed.items[i] = { ...feed.items[i], commits: ev.commits };
      else {
        const recap = turnRecap(feed.items, feed.lastTurn.from, { ms: feed.lastTurn.ms, tokens: feed.lastTurn.tokens, testsBefore: feed.lastTurn.testsBefore, commits: ev.commits });
        if (recap) feed.items.push(recap);
      }
      break;
    }

    // The files saved before this turn (its message gets a way back), and after it (a line to go back to).
    case "checkpoint": {
      for (let i = feed.items.length - 1; i >= 0; i--) {
        const it = feed.items[i];
        if (it.type === "user" && !it.steer) { if (!it.cp) it.cp = ev.n; break; }
      }
      break;
    }
    case "checkpoint_done":
      feed.items.push({ type: "cp", n: ev.n, files: ev.files || [], more: ev.more || 0, at: ev.at || 0 });
      break;
    case "rewind":
      feed.items.push({ type: "rewind", to: ev.to, label: ev.label || "", files: ev.files || [], more: ev.more || 0, undo: ev.undo || "", at: ev.at || 0 });
      break;

    case "error":
      finishLive(feed);
      feed.working = false;
      feed.items.push({ type: "error", text: ev.message || "Something went wrong." });
      break;

    default:
      break;
  }
  return feed;
}

/** Keep the to-do list as a tool call changes it (see toolTodo in server/events.js). */
function noteTodos(feed, ev) {
  if (ev.todos) feed.todos = ev.todos.map((t) => ({ text: t.text, status: t.status }));
  if (ev.task) feed.todos.push({ id: null, toolId: ev.id, text: ev.task.text, status: "pending" });
  if (ev.taskUpdate) {
    const u = ev.taskUpdate;
    const t = feed.todos.find((x) => x.id === u.id);
    if (u.status === "deleted") feed.todos = feed.todos.filter((x) => x !== t);
    else if (t) Object.assign(t, u.status ? { status: u.status } : {}, u.text ? { text: u.text } : {});
  }
}

/** Why a thread is on another account now, in a line. */
export function accountNote(ev) {
  const { fromName: from = "That account", toName: to = "another account" } = ev;
  switch (ev.why) {
    case "limit": return `${from} reached its usage limit, so this thread carries on with ${to}.`;
    case "limit-before": return `${from} is at its usage limit, so this thread moved to ${to}.`;
    case "reset": return `Carrying on with ${to}, the first account whose limit reset.`;
    case "signed-out": return `${from} is signed out, so this thread carries on with ${to}. Sign it in again in Settings › Accounts.`;
    default: return `Moved to ${to}. The next message carries on there.`;
  }
}

/** How the background work stands: how many are running, and the one to name in a line. */
export function tasksProgress(tasks) {
  const running = tasks.filter((t) => t.status === "running");
  const failed = tasks.filter((t) => t.status === "failed");
  return { running: running.length, failed: failed.length, total: tasks.length, now: running[0] ? running[0].now || running[0].text : "" };
}

/** "3 of 7 done", and what's being done now. */
export function todoProgress(todos) {
  const done = todos.filter((t) => t.status === "completed").length;
  const now = todos.find((t) => t.status === "in_progress");
  return { done, total: todos.length, now: now ? now.text : "", finished: todos.length > 0 && done === todos.length };
}

/**
 * A turn's receipt, at its end: how long it took, the files it changed (with
 * lines added and removed), the commands it ran and how they went, the tests
 * (against the thread's run before), and any commits and push. Only for turns
 * that changed something or took a few steps; a quick answer needs none.
 */
export function turnRecap(items, from, { ms = 0, tokens = 0, testsBefore = null, commits } = {}) {
  const steps = items.slice(from).filter((it) => it.type === "steps").flatMap((it) => it.steps);
  const files = new Map();
  for (const s of steps) {
    if (!s.change || s.state === "bad") continue;
    const c = changeCounts(s.change);
    const f = files.get(s.change.file) || { file: s.change.file, add: 0, del: 0, created: false };
    f.add += c.add; f.del += c.del; f.created = f.created || !!s.change.created;
    files.set(s.change.file, f);
  }
  const ran = commandReceipt(steps);
  // The server's list (git log since the turn began) when it sent one; else what git printed as it committed.
  if (commits) ran.commits = commits;
  if (!files.size && steps.length < 3 && !ran.commits.length && !ran.tests) return null;
  return {
    type: "recap", ms, tokens, files: [...files.values()],
    commands: ran.commands.length,
    ran: ran.commands, commits: ran.commits, tests: ran.tests, testsBefore: ran.tests ? testsBefore : null, pushed: ran.pushed,
    steps: steps.length,
    failed: steps.filter((s) => s.state === "bad").length,
  };
}

/** The recap's line: "Worked 3m 05s · changed 4 files +120 −30 · ran 6 commands". */
export function recapLine(r) {
  const add = r.files.reduce((n, f) => n + f.add, 0), del = r.files.reduce((n, f) => n + f.del, 0);
  return [
    r.ms >= 1000 ? `Worked ${elapsedLabel(r.ms / 1000)}` : "Done",
    r.files.length ? `changed ${r.files.length} file${r.files.length === 1 ? "" : "s"}` + (add || del ? ` +${add} −${del}` : "") : "",
    r.commands ? `ran ${r.commands} command${r.commands === 1 ? "" : "s"}` : "",
    `${r.steps} step${r.steps === 1 ? "" : "s"}${r.failed ? ` (${r.failed} failed)` : ""}`,
  ].filter(Boolean).join(" · ");
}

/** "at 1:00 am" today, "tomorrow at 9:30", or a date further off. */
export function resumeLabel(at, now = Date.now()) {
  const d = new Date(at), n = new Date(now);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(n)) / 86400000);
  if (days <= 0) return `at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  return `on ${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} at ${time}`;
}

/** The running turn's output tokens: exact for finished requests, about 4 characters a token for the one streaming. */
export function turnOutput(feed) {
  const o = feed.out;
  if (!o) return 0;
  return o.done + (o.exact ? o.now : Math.round(o.chars / 4));
}

/** 850, 1.2k, 45k, 1.2M: token counts as the CLI writes them. */
export function tokensLabel(n) {
  if (n < 1000) return String(Math.round(n));
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  if (n < 1e6) return Math.round(n / 1000) + "k";
  return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
}

/** "Context 45k of 200k (23%)", or null before the first reply. The window defaults to 200k, or 1M past that. */
export function contextLabel(context, windowSize) {
  if (!context) return null;
  const size = windowSize || (context > 200000 ? 1000000 : 200000);
  const percent = Math.min(100, Math.round((context / size) * 100));
  return { text: `Context ${tokensLabel(context)} of ${tokensLabel(size)} (${percent}%)`, percent, window: size };
}

export function friendlyError(err) {
  const e = String(err || "");
  if (!e || /interrupt|aborted|error_during_execution/i.test(e)) return "Stopped.";
  if (/max_turns/i.test(e)) return "Stopped after too many steps. Send a message to carry on.";
  return e.length > 300 ? e.slice(0, 300) + "…" : e;
}

/** The closed line for a run of steps: "Read app.js, ran tests and 3 more". */
export function stepsHeadline(steps) {
  if (!steps.length) return "";
  const shown = steps.slice(0, 2).map((s) => s.summary);
  const more = steps.length - shown.length;
  return shown.join(", ") + (more > 0 ? ` and ${more} more` : "");
}

// The playful words on the working line while Claude is busy, like the
// terminal's. One is picked per few seconds, so a long job keeps moving.
export const WORKING_VERBS = [
  "Thinking", "Cooking", "Skedaddling", "Flibbertigibbeting", "Pondering", "Brewing", "Tinkering",
  "Noodling", "Percolating", "Conjuring", "Whittling", "Simmering", "Mulling", "Puzzling",
  "Crafting", "Untangling", "Rummaging", "Scheming", "Hatching", "Moseying", "Ruminating",
  "Doodling", "Fiddling", "Marinating", "Spelunking", "Clambering", "Wrangling", "Jiggling",
  "Kneading", "Sleuthing", "Galumphing", "Dilly-dallying", "Bamboozling", "Lollygagging",
  "Hullaballooing", "Discombobulating", "Shenaniganing", "Gallivanting", "Zigzagging", "Boondoggling",
];
export const VERB_EVERY_S = 5;

/** The word for this moment of a turn: stable for VERB_EVERY_S, then the next. */
export function workingVerb(elapsedS, seed = 0) {
  const n = WORKING_VERBS.length;
  const i = (Math.floor(Math.max(0, elapsedS) / VERB_EVERY_S) * 7 + seed) % n;
  return WORKING_VERBS[(i + n) % n];
}

/** "8s", "1m 05s", "1h 02m": how long the turn has been going. */
export function elapsedLabel(s) {
  const t = Math.max(0, Math.floor(s));
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, "0")}s`;
  return `${Math.floor(t / 3600)}h ${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}m`;
}

const TOOL_WORDS = { Read: "a file", Edit: "an edit", Write: "a file", Bash: "a command", Grep: "a search", Glob: "a search", WebSearch: "a web search", WebFetch: "a page", Skill: "a skill", Task: "a helper", Agent: "a helper" };

/**
 * What Claude is doing right now, in words, the way Claude Code shows it:
 * starting up, waiting for the model, thinking, getting a tool ready,
 * running it, or writing. Empty when nothing is happening.
 */
export function currentStep(feed, who = "Claude") {
  const l = feed.items[feed.items.length - 1];
  const running = l?.type === "steps" ? [...l.steps].reverse().find((s) => s.state === "run") : null;
  const p = feed.phase;
  // A tool that has started running outranks the stage before it.
  if (running && (!p || p.phase === "tool" || p.phase === "waiting")) return running.summary;
  if (!p) return l?.type === "ai" && l.live ? "Writing" : "";
  switch (p.phase) {
    case "starting": return `Starting ${who === "Claude" ? "Claude Code" : who}`;
    case "waiting": return `Waiting for ${who}`;
    case "thinking": return "Thinking";
    case "tool": return `Getting ${TOOL_WORDS[p.tool] || (p.tool ? p.tool.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ") : "a tool")} ready`;
    case "writing": return "Writing";
    case "status": return p.label ? p.label[0].toUpperCase() + p.label.slice(1) : "";
    default: return "";
  }
}

/** How long the current stage has lasted, shown once it passes a few seconds. */
export function phaseSeconds(feed, now = Date.now()) {
  return feed.phase ? Math.max(0, (now - feed.phase.since) / 1000) : 0;
}

/** "claude-opus-5-5" reads as "Opus 5.5"; anything else is shown as it is. */
export function modelName(id) {
  const m = String(id || "").match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/);
  if (!m) return String(id || "");
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? "." + m[3] : ""}${m[4] ? " (1M)" : ""}`;
}

/** The header's status line for a thread. */
export function statusOf(feed) {
  if (feed.waiting) return { tone: "waiting", text: "Waiting for your answer" };
  if (!feed.working) return { tone: "idle", text: "Ready" };
  const l = feed.items[feed.items.length - 1];
  if (l?.type === "steps") {
    const run = [...l.steps].reverse().find((s) => s.state === "run");
    if (run) return { tone: "working", text: `Working: ${run.summary}` };
  }
  if (l?.type === "ai" && l.live) return { tone: "working", text: "Writing…" };
  return { tone: "working", text: `${workingVerb((Date.now() - (feed.startedAt || Date.now())) / 1000, feed.seed || 0)}…` };
}
