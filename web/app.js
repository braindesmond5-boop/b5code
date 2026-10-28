// B5 Code's page. State lives in `S`; every change calls render(). The
// conversation is rebuilt from the thread's feed (feed.js), so what you see
// after a reload is what you saw live.

import { renderMarkdown } from "./markdown.js";
import { chatSnapshot } from "./studio-chat.js";
import { friendlyError, emptyFeed, apply, stepsHeadline, statusOf, modelName, workingVerb, elapsedLabel, currentStep, phaseSeconds, turnOutput, tokensLabel, contextLabel, todoProgress, tasksProgress, recapLine, resumeLabel } from "./feed.js";
import { testsLabel, testsChange } from "./receipt.js";
import { icon } from "./icons.js";
import { inboxItems, inboxCount } from "./inbox.js";
import qrcode from "./vendor/qrcode.mjs";
import { createTerminalPane, loadLib as preloadTerminal } from "./terminal.js";
import { createFilesPane } from "./files-pane.js";
import { createGithubPane } from "./github-pane.js";
import { KINDS, branchName, worktreeDir } from "./branch-name.js";
import { lineDiff, foldSame, changeCounts, gitRows } from "./diff.js";
import { nextSteps, endsWithOffer } from "./next-steps.js";
import { GUIDE as MAC_GUIDE, SHORTCUTS as MAC_SHORTCUTS, searchGuide, forWindows } from "./guide.js";
import { needsReview, toolParts, reviewFields } from "./review.js";
import { rankItems } from "./palette.js";
import { questionsOf, answersFrom } from "./questions.js";
import { baseName } from "./paths.js";
import { highlight } from "./highlight.js";
import { SCREENS, screenById, fitScreen } from "./screens.js";

const TOKEN = document.querySelector('meta[name="desk-token"]').content;
const PAGE_PRINT = document.querySelector('meta[name="desk-page"]')?.content || ""; // this page's files, as loaded
const $ = (id) => document.getElementById(id);
// The app around the page: the Mac app (WKWebView) or the Windows app (WebView2, windows/B5Code.cs),
// which take the same messages. Only the Mac app draws the page edge to edge, without a title bar.
const macApp = window.webkit?.messageHandlers?.desk;
const winApp = !macApp && window.deskWindows && window.chrome?.webview ? { postMessage: (m) => window.chrome.webview.postMessage(m) } : null;
const native = macApp || winApp;
const WIN_GUIDE = forWindows();
const guideFor = () => (WIN() ? WIN_GUIDE : { guide: MAC_GUIDE, shortcuts: MAC_SHORTCUTS });
if (macApp) document.body.classList.add("native");

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * An element's children replaced, with nothing drawn for null or false (as h() does): the
 * browser's own replaceChildren writes a null as the word "null".
 */
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  return el;
}

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v; // only ever our own renderMarkdown output
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "style") el.style.cssText = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

const store = {
  get(k, d) { try { const v = localStorage.getItem("desk:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("desk:" + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "x-desk-token": TOKEN, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  // The server has a different token than this page (it was set up afresh):
  // reload once to pick the current one up, rather than failing every call.
  if (res.status === 403 && data.error === "Bad token.") {
    saveDraft();
    if (!sessionStorage.getItem("b5-reloaded")) { sessionStorage.setItem("b5-reloaded", "1"); location.reload(); }
    throw new Error(`B5 Code restarted. Reload the window (${KEY()}R).`);
  }
  sessionStorage.removeItem("b5-reloaded");
  // On a phone, 401 is the pairing page: this phone was removed (or its pairing ran out).
  if (res.status === 401 && S.phone) throw new Error("This phone isn't paired with B5 Code any more. Reload the page to pair it again.");
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

let toastTimer;
function toast(text, action = null) {
  document.querySelector(".toast")?.remove();
  const t = h("div", { class: "toast", role: "status" }, text,
    action ? h("button", { type: "button", class: "toast-action", onclick: () => { t.remove(); action.run(); } }, action.label) : null);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), action ? 9000 : 3200);
}

const ago = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};
// Paths come as the computer writes them: /Users/me/x on a Mac, C:\Users\me\x on Windows,
// where the page also says PC, Ctrl and File Explorer.
const WIN = () => S.platform === "windows";
const MAC = () => (WIN() ? "PC" : "Mac");
const KEY = () => (WIN() ? "Ctrl+" : "⌘");
const FINDER = () => (WIN() ? "File Explorer" : "Finder");
/** Whether a path is absolute, or in your home folder (~/…): /x, ~/x, C:\x, \\server\x. */
const isAbsPath = (p) => /^(\/|~[\\/]|[A-Za-z]:[\\/]|\\\\)/.test(String(p || ""));
/** The part of `p` inside your home folder ("" for the folder itself), or null; on Windows either slash and any case. */
function underHome(p) {
  const s = String(p || ""), hm = S.home;
  if (!hm) return null;
  const n = (x) => (WIN() ? x.replace(/\//g, "\\").toLowerCase() : x);
  if (n(s) === n(hm)) return "";
  return n(s).startsWith(n(hm) + (WIN() ? "\\" : "/")) ? s.slice(hm.length + 1) : null;
}
const home = (p) => {
  if (!WIN()) return String(p || "").replace(/^\/Users\/[^/]+/, "~");
  const r = underHome(p);
  return r == null ? String(p || "") : r ? "~\\" + r : "~";
};

// ── State ────────────────────────────────────────────────────────────────────

const S = {
  projects: [], threads: [], running: {}, commands: {}, account: null, models: [], usage: null,
  newModel: store.get("newModel", null), // model for threads not yet started
  newEffort: store.get("newEffort", null), // effort for threads not yet started
  newBranch: null, // { kind, issue, what } when the next new thread gets its own branch
  pr: {}, // threadId -> { pr, prompt, removed, loading, error } for threads on their own branch
  git: {}, // threadId -> where its folder stands in git (server: gitState), for the next-step buttons
  projectId: store.get("project", null),
  threadId: store.get("thread", null),
  closed: new Set(store.get("closed", [])), // collapsed project groups
  query: "",
  feeds: new Map(),
  open: new Set(),
  changes: null, diffs: {}, folded: new Set(),
  changesScope: store.get("changesScope", "chat"), // "chat": everything since the thread began, committed too; or "uncommitted"
  pane: store.get("pane", !matchMedia("(max-width: 1080px)").matches), // on a phone it's a sheet: closed until asked for
  paneTab: "changes", // or "preview", "terminal", "files"
  preview: store.get("preview", null), // the file shown in Preview
  paneWide: store.get("paneWide", false),
  previewBase: "", home: "",
  previewLinks: {}, // previewed path -> its folder-locked link
  previewVersion: null, // an artifact's earlier version being looked at (null: as it is now)
  previewVersions: {}, // artifact path -> [{ v, at }]
  previewMode: "view", // or "code"
  previewSource: {}, // "path@v" -> text, for the Code view and Markdown documents
  screen: store.get("screen", null), // the phone, tablet or computer a page is shown on (null: fill the pane)
  screenTurned: store.get("screenTurned", false),
  sideHidden: store.get("sideHidden", false),
  studioWide: false, // Studio hides the sidebar and the pane while a video is open (not saved)
  space: store.get("space", "code"), // the sidebar's space: chat, code, work or studio
  showAll: new Set(), // projects showing all their threads, not just the latest few
  studioPane: false, // you opened the pane in Studio anyway
  sideW: store.get("sideW", 264), paneW: store.get("paneW", 360),
  attach: [], // files added to the next message
  waiting: {}, // threadId -> permission questions waiting (from the server)
  seen: store.get("seen", {}), // threadId -> when you last looked at it
  view: "thread", // or "inbox"
  slash: { open: false, index: 0 },
  stick: true,
};

const project = () => S.projects.find((p) => p.id === S.projectId) || null;
const thread = () => S.threads.find((t) => t.id === S.threadId) || null;
const threadsOf = (pid) => S.threads.filter((t) => t.projectId === pid && !t.sideOf).sort((a, b) => b.updatedAt - a.updatedAt);
const sidesOf = (id) => S.threads.filter((t) => t.sideOf === id).sort((a, b) => a.createdAt - b.createdAt);
// A thread's events that came in live before its history was loaded make a partial
// feed: opening the thread loads the whole log (else a thread running when the page
// loaded would show only what it did since).
const feedOf = (id) => {
  if (!S.feeds.has(id)) S.feeds.set(id, { ...emptyFeed(), partial: true });
  return S.feeds.get(id);
};
const stateOf = (id) => {
  if (S.running[id] !== "working") return "idle";
  return feedOf(id).waiting ? "needs" : "working";
};

/** Where the open thread works: its own worktree, or the project's folder. */
function workDir() {
  const t = thread();
  return (t?.dir && !S.pr[t.id]?.removed ? t.dir : null) || project()?.dir || "";
}

async function loadState() {
  const s = await call("GET", "/api/state");
  S.projects = s.projects; S.threads = s.threads; S.running = s.running || {}; S.commands = s.commands || {}; S.account = s.account;
  S.recipes = s.recipes || [];
  S.automations = s.automations || [];
  S.models = s.models || []; S.usage = s.usage || S.usage; S.planUsage = s.planUsage || S.planUsage;
  // A restarted server has a new preview secret: links made before are dead.
  if ((s.previewBase || "") !== S.previewBase) S.previewLinks = {};
  S.previewBase = s.previewBase || ""; S.home = s.home || ""; S.platform = s.platform || "mac";
  S.defaultModel = s.defaultModel || "";
  S.waiting = s.waiting || {};
  S.settings = s.settings || {};
  S.accounts = s.accounts || [];
  S.queue = s.queue || S.queue;
  S.phone = s.phone || null; // set when this page is open on a paired phone
  if (!project()) S.projectId = S.projects[0]?.id || null;
  if (S.threadId && !thread()) S.threadId = null;
}

async function loadFeed(threadId) {
  const events = await call("GET", `/api/threads/${threadId}/log`);
  const feed = emptyFeed();
  for (const ev of events) apply(feed, ev);
  if (S.running[threadId] === "working") feed.working = true;
  S.feeds.set(threadId, feed);
}

async function openThread(id) {
  saveDraft();
  const t = S.threads.find((x) => x.id === id);
  if (!t) return;
  const sp = spaceOf(S.projects.find((p) => p.id === t.projectId));
  if (sp !== S.space) { S.space = sp; store.set("space", sp); }
  S.threadId = id;
  S.projectId = t.projectId;
  S.view = "thread";
  markSeen(id);
  store.set("thread", id);
  store.set("project", t.projectId);
  S.stick = true;
  if ($("app").classList.contains("side-open")) { $("app").classList.remove("side-open"); dropLayer(); }
  if (!S.feeds.has(id) || S.feeds.get(id).partial) await loadFeed(id);
  render();
  loadChanges();
  loadGit(id);
  // On a touch screen the keyboard would pop up over the conversation you opened to read.
  if (!matchMedia("(pointer: coarse)").matches) focusComposer();
  warm();
}

// Start Claude Code before the message is sent, so its load time is spent
// while you read or type. Cheap to repeat: the server ignores a warm one.
let warmedKey = "";
function warm() {
  const t = thread();
  const key = t ? "t:" + t.id : "p:" + S.projectId + ":" + (newModel() || "");
  // A thread on its own branch can't use the project's spare, so none is started for it.
  if (key === warmedKey || (t && S.running[t.id] === "working") || (!t && S.newBranch)) return;
  warmedKey = key;
  const req = t ? call("POST", `/api/threads/${t.id}/warm`) : S.projectId ? call("POST", `/api/projects/${S.projectId}/warm`, { model: newModel() }) : null;
  req?.catch(() => { warmedKey = ""; });
}

// A new thread is only a screen until its first message: nothing is created
// on the server for a thread you open and never use.
function startNew(projectId = S.projectId) {
  saveDraft();
  if (!projectId) return addProjectDialog();
  if (projectId !== S.projectId) S.newBranch = null;
  S.projectId = projectId;
  store.set("project", projectId);
  S.threadId = null;
  S.view = "thread";
  store.set("thread", null);
  $("app").classList.remove("side-open");
  render();
  loadChanges();
  focusComposer();
  warm();
}

function markSeen(id) {
  const t = S.threads.find((x) => x.id === id);
  S.seen[id] = Math.max(Date.now(), t?.lastDoneAt || 0);
  store.set("seen", S.seen);
}

function openInbox() {
  saveDraft();
  S.view = "inbox";
  $("app").classList.remove("side-open");
  render();
}

async function deleteThread(t, withWorktree = false) {
  if (S.running[t.id] === "working") return toast("Stop this thread before deleting it.");
  await call("DELETE", `/api/threads/${t.id}${withWorktree ? "?worktree=1" : ""}`);
  const gone = new Set([t.id, ...sidesOf(t.id).map((x) => x.id)]);
  S.threads = S.threads.filter((x) => !gone.has(x.id));
  for (const id of gone) S.feeds.delete(id);
  if (gone.has(S.threadId)) S.threadId = t.sideOf || null;
  render();
}

// ── Live events ──────────────────────────────────────────────────────────────

// The event stream's heartbeat: a ping every 20 s. A phone's connection can die without a word
// (the screen off, Wi-Fi to mobile data), so the page reconnects when the beats stop, when it comes
// back to the front with none heard for a while, and when the network comes back.
let stream = null, lastBeat = Date.now();
function reconnect() {
  try { stream?.close(); } catch { /* already closed */ }
  connect();
}
setInterval(() => { if (Date.now() - lastBeat > 50000) reconnect(); }, 10000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - lastBeat > 25000) reconnect(); });
window.addEventListener("online", () => reconnect());

function connect() {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(TOKEN)}`);
  stream = es;
  lastBeat = Date.now();
  es.addEventListener("ping", () => { lastBeat = Date.now(); });
  es.onmessage = (m) => {
    lastBeat = Date.now();
    let msg;
    try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.terminal) { paneView?.terminal.message(msg); return; }
    const { threadId, event } = msg;
    if (event.kind === "commands") {
      if (event.projectId) S.commands[event.projectId] = event.list;
      if (studioChat.threadId && S.threads.find((x) => x.id === studioChat.threadId)?.projectId === event.projectId) studioChatSoon();
      if (event.models?.length) { S.models = event.models; if (view) updateComposer(S.threadId ? feedOf(S.threadId) : emptyFeed()); if (studioChat.threadId) studioChatSoon(); }
      return;
    }
    if (event.kind === "usage" || event.kind === "plan-usage") {
      const id = event.account || "main";
      const a = (S.accounts || []).find((x) => x.id === id);
      if (a) a[event.kind === "usage" ? "usage" : "planUsage"] = event;
      if (id === "main") S[event.kind === "usage" ? "usage" : "planUsage"] = event;
      renderSide();
      if (event.kind === "plan-usage" && document.querySelector(".usage-sheet")) openUsage();
      return;
    }
    if (event.kind === "accounts") { S.accounts = event.accounts; if ("account" in event) S.account = event.account; scheduleRender(); return; }
    if (event.kind === "restarting") { comeBack(); return; } // updating itself
    if (event.kind === "automations") { S.automations = event.automations; scheduleRender(); return; }
    if (event.kind === "queue") { S.queue = event.queue; if (S.view === "queue" && !document.querySelector(".q-add textarea:focus, .q-add input:focus")) renderMain(); renderSide(); return; }
    if (event.kind === "account-limits") {
      for (const a of S.accounts || []) a.limitedUntil = (event.limits[a.id] || 0) > Date.now() ? event.limits[a.id] : 0;
      scheduleRender();
      return;
    }
    if (!threadId) return;
    // A thread the server started (an automation's run, the overnight queue's): the sidebar learns of it.
    if (!S.threads.some((x) => x.id === threadId)) reloadStateSoon();
    const feed = feedOf(threadId);
    apply(feed, event);
    noteCheckpoints(threadId, event);
    if (threadId === studioChat.threadId) studioChatSoon();
    // Changes show as they land: after an edit, or a command that may have written files.
    if (event.kind === "tool_result" && threadId === S.threadId) {
      const step = feed.items.flatMap((i) => i.steps || []).find((x) => x.id === event.id);
      if (step && (step.change || step.name === "Bash")) loadChangesSoon();
    }
    if (event.kind === "user" || event.kind === "delta" || event.kind === "tool" || event.kind === "steer_ack") S.running[threadId] = "working";
    if (event.kind === "permission") (S.waiting[threadId] ||= []).push({ requestId: event.requestId, summary: event.summary, detail: event.detail, tool: event.tool, canAllowEdits: event.canAllowEdits });
    if (event.kind === "permission_answer" || event.kind === "permission_closed") S.waiting[threadId] = (S.waiting[threadId] || []).filter((a) => a.requestId !== event.requestId);
    if ((event.kind === "done" && !event.more) || event.kind === "error") {
      S.running[threadId] = "idle";
      delete S.waiting[threadId];
      const t = S.threads.find((x) => x.id === threadId);
      if (t) {
        t.updatedAt = Date.now();
        Object.assign(t, event.inbox); // lastDoneAt, lastOk, lastReply, as the server saved them
        // Finishing in front of you counts as seen.
        if (threadId === S.threadId && S.view === "thread" && !document.hidden) markSeen(threadId);
      }
      if (threadId === S.threadId) { loadChanges(); loadGit(threadId); if (t?.branch) loadPr(threadId); }
      // What it wrote shows in the Files tab, whichever of the project's threads you're on (an automation's run, say).
      if (S.paneTab === "files" && t?.projectId === S.projectId) paneView?.files.refresh();
      notify(threadId, "Finished");
    }
    if (event.kind === "permission") notify(threadId, "Claude is asking: " + event.summary);
    if (event.kind === "account") {
      const t = S.threads.find((x) => x.id === threadId);
      if (t) t.account = event.to;
      if (event.why === "limit") notify(threadId, `Moved to ${event.toName}: ${event.fromName} reached its usage limit`);
    }
    if (event.kind === "limit" || event.kind === "limit_cleared") {
      const t = S.threads.find((x) => x.id === threadId);
      if (t) t.resume = event.kind === "limit" ? { at: event.resumeAt, known: event.known } : null; // the sidebar's clock
    }
    if (event.kind === "limit") notify(threadId, `Usage limit reached. Carries on ${resumeLabel(event.resumeAt)}`);
    if (event.kind === "artifact" && threadId === S.threadId) {
      const showing = S.preview === toHome(event.path);
      delete S.previewVersions[toHome(event.path)];
      for (const k of Object.keys(S.previewSource)) if (k.startsWith(toHome(event.path) + "@")) delete S.previewSource[k];
      // A page Claude just made opens by itself, like an artifact; one it changed reloads if it's showing.
      // (On a phone the pane is a full-screen sheet: the card is there to open it.)
      if (event.version === 1 && !showing && !narrow()) openPreview(event.path);
      else if (showing) { S.previewVersion = null; if (paneView) paneView.src = ""; }
    }
    scheduleRender();
  };
  es.onopen = async () => {
    lastBeat = Date.now();
    try {
      await loadState();
      // Events sent while disconnected (the Mac slept, B5 Code restarted) were
      // missed: every other thread reloads when next opened.
      for (const id of [...S.feeds.keys()]) if (id !== S.threadId) S.feeds.delete(id);
      if (S.threadId) await loadFeed(S.threadId);
      render();
      paneView?.terminal.resync();
      checkUpdate();
    } catch { /* the next reconnect retries */ }
  };
}

// In view: a toast for other threads. Away (another app in front): a Mac
// notification, through the native window; in a browser window (B5 Code's
// window on Windows), the browser's own notification.
function notify(threadId, what) {
  const t = S.threads.find((x) => x.id === threadId);
  if (!t) return;
  const away = document.hidden || !document.hasFocus();
  if (away || threadId !== S.threadId || what !== "Finished") playSound();
  if (!SET.notify) { if (!away && threadId !== S.threadId) toast(`${t.title}: ${what}`); return; }
  if (away && native) {
    const p = S.projects.find((x) => x.id === t.projectId);
    native.postMessage({ type: "notify", title: `${p ? p.name + ": " : ""}${t.title}`, body: what });
  } else if (away && browserNotifies() && Notification.permission === "granted") {
    const p = S.projects.find((x) => x.id === t.projectId);
    const n = new Notification(`${p ? p.name + ": " : ""}${t.title}`, { body: what, tag: threadId, icon: "icon-192.png" });
    n.onclick = () => { window.focus(); openThread(threadId); n.close(); };
  } else if (threadId !== S.threadId) {
    toast(`${t.title}: ${what}`);
  }
}

/** Notifications from the browser itself: on the computer, outside the Mac app (a phone has its own, web/sw.js). */
const browserNotifies = () => !native && !S.phone && "Notification" in window;

/** Settings › Notifications in a browser window: whether the browser lets B5 Code notify, and asking it. */
function browserNotifyRow() {
  const status = h("span", { class: "set-desc" });
  const allow = h("button", { class: "btn", type: "button" });
  const draw = () => {
    const p = Notification.permission;
    status.textContent = p === "granted" ? "Allowed. They show while B5 Code's window is in the background."
      : p === "denied" ? "Blocked for B5 Code. Allow them in the browser's site settings (the icon left of the address), then come back."
      : "Not allowed yet.";
    allow.textContent = p === "granted" ? "Test" : "Allow";
    allow.disabled = p === "denied";
  };
  allow.onclick = async () => {
    if (Notification.permission !== "granted") await Notification.requestPermission().catch(() => {});
    else new Notification("B5 Code", { body: "This is how a finished thread looks.", icon: "icon-192.png" });
    draw();
  };
  draw();
  return h("div", { class: "set-row" }, h("span", {}, h("span", { class: "set-title" }, WIN() ? "Windows notifications" : "Browser notifications"), status), allow);
}

/** The Mac sound picked in Settings, played by the Mac app (so it doesn't depend on macOS's notification settings). */
function playSound(name = SET.sound) {
  if (name && native && window.deskFeatures?.includes("sound")) native.postMessage({ type: "sound", name });
}

let renderQueued = false;
// At most one render a frame, and while Claude streams at most ~25 a second:
// each one lays out the whole conversation, which on a long thread is the cost.
const RENDER_GAP = 40;
let lastRender = 0;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  const wait = Math.max(0, lastRender + RENDER_GAP - performance.now());
  const go = () => requestAnimationFrame(() => { renderQueued = false; render(); });
  if (wait) setTimeout(go, wait); else go();
}

// ── Render ───────────────────────────────────────────────────────────────────

// The handles live outside the sidebar and pane (they would be clipped
// inside them), so they are placed on the boundaries after each layout.
let handlesKey = "";
function positionHandles() {
  // They move only when the sidebar or pane does: measuring each render would lay out the page again.
  const key = [S.sideHidden, S.sideW, S.pane, S.paneW, S.paneWide, $("pane").hidden, innerWidth, innerHeight, $("app").className].join("|");
  if (key === handlesKey) return;
  handlesKey = key;
  const side = document.querySelector(".side-handle");
  const pane = document.querySelector(".pane-handle");
  const sb = $("side").getBoundingClientRect();
  const pb = $("pane").getBoundingClientRect();
  if (side) { side.hidden = S.sideHidden || getComputedStyle($("side")).position === "fixed"; side.style.left = (sb.right - 3) + "px"; }
  if (pane) { pane.hidden = $("pane").hidden; pane.style.left = (pb.left - 3) + "px"; }
}
window.addEventListener("resize", () => requestAnimationFrame(positionHandles));

// Hide or show the sidebar. On a narrow window it slides over the
// conversation instead, so the same button opens it there.
function toggleSidebar() {
  if (matchMedia("(max-width: 760px)").matches) {
    const open = $("app").classList.toggle("side-open");
    if (open) pushLayer(); else dropLayer();
    return;
  }
  if (S.view === "studio" && S.studioWide) { S.studioWide = false; applySideHidden(); return; } // Studio had hidden it: just show it
  S.sideHidden = !S.sideHidden;
  store.set("sideHidden", S.sideHidden);
  applySideHidden();
}

// Drag handles on the sidebar's right edge and the side pane's left edge.
// The conversation always keeps MAIN_MIN; a double-click resets a width.
const MAIN_MIN = 420;
const SIDE_RANGE = [200, 420];
function applyWidths() {
  const app = $("app");
  app.style.setProperty("--side-w", S.sideW + "px");
  app.style.setProperty("--pane-w", S.paneW + "px");
}

function startResize(which, e) {
  e.preventDefault();
  const app = $("app");
  app.classList.add("resizing");
  document.body.classList.add("resizing");
  window.getSelection()?.removeAllRanges();
  const move = (ev) => {
    const vw = window.innerWidth;
    const sideNow = S.sideHidden ? 0 : S.sideW;
    if (which === "side") {
      const max = Math.min(SIDE_RANGE[1], vw - (S.pane ? S.paneW : 0) - MAIN_MIN);
      S.sideW = Math.round(Math.max(SIDE_RANGE[0], Math.min(ev.clientX, max)));
    } else {
      const max = vw - sideNow - MAIN_MIN;
      S.paneW = Math.round(Math.max(300, Math.min(vw - ev.clientX, max)));
      S.paneWide = false;
      $("app").classList.remove("pane-wide");
    }
    applyWidths();
    positionHandles();
  };
  const up = () => {
    app.classList.remove("resizing");
    document.body.classList.remove("resizing");
    window.getSelection()?.removeAllRanges();
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    store.set("sideW", S.sideW);
    store.set("paneW", S.paneW);
    store.set("paneWide", S.paneWide);
    renderPane();
    requestAnimationFrame(sendRegions);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function resetWidth(which) {
  if (which === "side") S.sideW = 264; else { S.paneW = 360; S.paneWide = false; }
  store.set("sideW", S.sideW); store.set("paneW", S.paneW); store.set("paneWide", S.paneWide);
  applyWidths();
  renderPane();
}

function render() {
  lastRender = performance.now();
  $("app").classList.toggle("side-hidden", S.sideHidden || (S.view === "studio" && S.studioWide));
  applyWidths();
  // Every change to the page first, then what's measured: one layout, not one per read.
  rendering = true;
  try {
    renderSide();
    renderMain();
    renderPane();
  } finally { rendering = false; }
  settleScroll();
  const t = thread();
  const n = inboxCount({ threads: S.threads, waiting: S.waiting, seen: S.seen, openThreadId: S.view === "thread" ? S.threadId : null });
  document.title = (n ? `(${n}) ` : "") + (S.view === "inbox" ? "Waiting for you" : t ? t.title : "B5 Code") + (S.view === "inbox" || t ? " · B5 Code" : "");
  sendRegionsSoon();
  positionHandles();
}
let rendering = false;

// The native window has no title bar: tell it where the page's top bars are
// (drag the window there) and where their buttons are (click those instead).
let lastRegions = "", regionsTimer = 0;
// It measures every button in the top bars: a few times a second is plenty.
function sendRegionsSoon() {
  if (!macApp || regionsTimer) return;
  regionsTimer = setTimeout(() => { regionsTimer = 0; sendRegions(); }, 250);
}
function sendRegions() {
  if (!macApp) return;
  const r = (el) => { const b = el.getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; };
  const bars = [...document.querySelectorAll(".side-top, .bar, .pane-bar")].filter((el) => el.offsetParent);
  const drag = bars.map(r);
  const noDrag = bars.flatMap((bar) => [...bar.querySelectorAll("button, a, input")].map(r))
    .concat([...document.querySelectorAll(".resize-handle")].filter((el) => !el.hidden).map(r));
  const key = JSON.stringify([drag, noDrag]);
  if (key === lastRegions) return;
  lastRegions = key;
  macApp.postMessage({ type: "regions", drag, noDrag });
}
window.addEventListener("resize", () => requestAnimationFrame(sendRegions));

// ── The sidebar ──────────────────────────────────────────────────────────────
// Four spaces, each showing only its own things: Chat (conversations, like claude.ai),
// Code (projects and their threads), Work (the Work space's tasks) and Studio (videos).
// Above them New (what it makes follows the space) and Search (⌘K); in Code, chips for
// Inbox, Queue and GitHub; at the foot one line: you, your session's usage, Guide, Settings.

// B5 Studio is a Mac project (it isn't part of the Windows install, and parts of it are Mac-only): not shown on Windows.
const ALL_SPACES = [["chat", "Chat", "chat"], ["code", "Code", "code"], ["work", "Work", "work"], ["studio", "Studio", "studio"]];
const SPACES_NOW = () => ALL_SPACES.filter(([id]) => !(id === "studio" && WIN()));
const spaceOf = (p) => (p?.kind === "chat" ? "chat" : p?.kind === "work" ? "work" : "code");
const SHOWN = 4; // a project's latest threads; the rest behind "Show N more"

function setSpace(space) {
  S.space = space;
  store.set("space", space);
  if (space === "studio") loadStudioVideos();
  renderSide();
}

/** New: a chat, a thread, a Work task or a video, by the space you're in. */
async function newInSpace() {
  try {
    if (S.space === "chat") { const p = await call("POST", "/api/chat"); if (!S.projects.some((x) => x.id === p.id)) await loadState(); return startNew(p.id); }
    if (S.space === "work") { const w = S.projects.find((x) => x.kind === "work"); return w ? startNew(w.id) : startWork(); }
    if (S.space === "studio") { studioRoute = ""; return openStudio(); }
    const p = project();
    startNew(p && spaceOf(p) === "code" ? p.id : S.projects.find((x) => spaceOf(x) === "code")?.id);
  } catch (e) { toast(e.message); }
}

let studioVideos = null; // the Studio space's list: null until asked
/** Seconds as m:ss, rounded to the second first (so 119.6 s is 2:00, not 1:60). */
const clock = (sec) => { const t = Math.max(0, Math.round(Number(sec) || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
function loadStudioVideos() {
  call("GET", "/api/studio/videos").then((v) => { studioVideos = Array.isArray(v) ? v : []; if (S.space === "studio") renderSide(); }, () => { studioVideos = []; });
}
function openVideo(id) {
  studioRoute = `#/v/${id}`;
  // Already showing: tell the editor to open it; otherwise Studio opens on it.
  const frame = document.querySelector(".studio-frame");
  if (frame && S.view === "studio" && studioOrigin) frame.contentWindow.postMessage({ type: "b5-open", route: studioRoute }, studioOrigin);
  openStudio();
}

function spaceList(space, q, hit) {
  if (space === "studio") {
    if (studioVideos === null) { loadStudioVideos(); return [h("div", { class: "empty-side" }, "Looking for your videos…")]; }
    if (!studioVideos.length) return [h("div", { class: "side-empty" }, h("b", {}, "No videos yet"), S.phone ? `Make videos in Studio on the ${MAC()}.` : "Make one in Studio: New video, or drop a clip in.")];
    return [h("div", { class: "side-sec" }, "Videos"), ...studioVideos.filter((v) => !q || v.name.toLowerCase().includes(q)).map((v) =>
      h("button", { type: "button", class: "vid-row", onclick: () => openVideo(v.id), title: v.name },
        h("span", { class: "vid-shape" + (v.aspect === "16:9" ? " wide" : v.aspect === "1:1" ? " square" : "") }, icon("studio", 13)),
        h("span", { class: "vid-text" }, h("b", {}, v.name), h("span", {}, `${v.aspect} · ${clock(v.length)}`))))];
  }
  if (space === "chat" || space === "work") {
    const p = S.projects.find((x) => x.kind === space);
    if (!p) return space === "work"
      ? [h("div", { class: "side-empty" }, h("b", {}, "Work"), "Documents, research, spreadsheets and files, made in ~/Documents/B5 Work.",
          S.phone ? null : h("button", { class: "btn small", type: "button", onclick: startWork }, "Start a Work space"))]
      : [h("div", { class: "side-empty" }, h("b", {}, "Chat"), "Conversations, like claude.ai: no project, no files. Start one with New chat.")];
    const list = threadsOf(p.id).filter((t) => hit(t) || sidesOf(t.id).some(hit));
    if (!list.length) return [h("div", { class: "empty-side" }, q ? "Nothing matches." : space === "chat" ? "No chats yet" : "No tasks yet")];
    if (space === "work") return [h("div", { class: "side-sec" }, "Tasks"), ...list.flatMap((t) => [renderRow(t), ...sidesOf(t.id).filter((x) => !q || hit(x)).map(renderRow)])];
    // Chats by day, like claude.ai.
    const day = (ts) => { const d = new Date(ts), n = new Date(); const start = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime(); return ts >= start ? "Today" : ts >= start - 864e5 ? "Yesterday" : ts >= start - 6 * 864e5 ? "This week" : "Earlier"; };
    const out = [];
    let last = null;
    for (const t of list) { const d = day(t.updatedAt); if (d !== last) { out.push(h("div", { class: "side-sec" }, d)); last = d; } out.push(renderRow(t)); }
    return out;
  }
  // Code: projects, each with its latest threads.
  const groups = S.projects.filter((p) => spaceOf(p) === "code").map((p) => {
    // A thread shows if it or one of its side chats matches; under a match, its matching side chats.
    const all = threadsOf(p.id).filter((t) => hit(t) || sidesOf(t.id).some(hit));
    if (q && !all.length) return null;
    const closed = S.closed.has(p.id) && !q;
    const open = q || S.showAll.has(p.id);
    let list = open ? all : all.slice(0, SHOWN);
    // The thread you're on stays in view, even if it's older than the first few.
    const cur = !open && all.find((t) => t.id === S.threadId || sidesOf(t.id).some((x) => x.id === S.threadId));
    if (cur && !list.includes(cur)) list = [...list, cur];
    const more = all.length - list.length;
    return h("div", { class: "group" + (closed ? " closed" : "") },
      h("div", { class: "group-head" },
        h("button", { type: "button", class: "group-name", "aria-expanded": String(!closed), onclick: () => toggleGroup(p.id) },
          h("span", { class: "chev" }, icon("chevronDown", 13)), h("span", { class: "name", title: home(p.dir) }, p.name),
          all.length ? h("span", { class: "group-count" }, String(threadsOf(p.id).length)) : null),
        h("button", { class: "add", type: "button", title: `${p.name} settings`, "aria-label": `${p.name} settings`, onclick: () => openProjectSettings(p) }, icon("settings", 13)),
        h("button", { class: "add", type: "button", title: `New thread in ${p.name}`, "aria-label": `New thread in ${p.name}`, onclick: () => startNew(p.id) }, icon("plus", 14))),
      h("div", { class: "rows" },
        ...(list.length ? list.flatMap((t) => [renderRow(t), ...sidesOf(t.id).filter((x) => !q || hit(x)).map(renderRow)])
          : [h("div", { class: "empty-side" }, "No threads yet")]),
        more > 0 || (S.showAll.has(p.id) && all.length > SHOWN && !q)
          ? h("button", { type: "button", class: "show-more", onclick: () => { if (!S.showAll.delete(p.id)) S.showAll.add(p.id); renderSide(); } }, more > 0 ? `Show ${more} more` : "Show fewer")
          : null));
  }).filter(Boolean);
  return [
    h("div", { class: "side-sec" }, "Projects",
      h("button", { class: "add", type: "button", title: "Add a project", "aria-label": "Add a project", onclick: addProjectDialog }, icon("plus", 14))),
    ...(groups.length ? groups : [h("div", { class: "side-empty" }, h("b", {}, q ? "Nothing matches" : "No projects yet"), q ? null : h("button", { class: "btn small", type: "button", onclick: addProjectDialog }, "Add a project folder"))]),
  ];
}

/** The session's usage as a small ring, its colour turning amber then red near the limit. */
function usageRing() {
  const w = usageWindows().find((x) => x.label === "Session");
  if (!w) return null;
  const r = 7, c = 2 * Math.PI * r, pct = Math.min(1, w.used);
  const svg = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="${r}" fill="none" stroke="var(--border)" stroke-width="2.5"/><circle cx="10" cy="10" r="${r}" fill="none" stroke="${w.used >= 0.75 ? toneOf(w.used) : "var(--accent)"}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${(c * pct).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 10 10)"/></svg>`;
  const el = h("span", { class: "ring", title: `Session ${Math.round(w.used * 100)}% used` });
  el.innerHTML = svg;
  el.append(h("span", { class: "ring-pct", style: w.used >= 0.75 ? `color:${toneOf(w.used)}` : "" }, `${Math.round(w.used * 100)}%`));
  return el;
}

function renderSide() {
  const q = S.query.trim().toLowerCase();
  const hit = (t) => !q || t.title.toLowerCase().includes(q);
  if (!SPACES_NOW().some(([id]) => id === S.space)) S.space = "code"; // never stuck on a space that isn't one
  const space = S.space;
  const a = S.account;
  const inbox = inboxCount({ threads: S.threads, waiting: S.waiting, seen: S.seen, openThreadId: S.view === "thread" ? S.threadId : null });
  const queued = (S.queue?.tasks || []).filter((t) => ["queued", "running", "paused"].includes(t.status)).length;
  const chip = (view, ic, label, onclick, n, quiet) => h("button", { class: "chip" + (S.view === view ? " on" : ""), type: "button", onclick }, icon(ic, 13), label, n ? h("span", { class: "badge" + (quiet ? " quiet" : "") }, String(n)) : null);
  const many = accountsShown().length > 1;
  const phone = phoneWidth();
  const spaceTabs = h("div", { class: "spaces" + (phone ? " tabbar" : ""), role: "tablist", "aria-label": "Spaces" }, ...SPACES_NOW().map(([id, label, ic]) =>
    h("button", { type: "button", role: "tab", "aria-selected": String(space === id), class: space === id ? "on" : "", title: label, "aria-label": label, onclick: () => setSpace(id) }, icon(ic, phone ? 20 : 14), h("span", { class: "space-label" }, label))));
  fill($("side"), ...[
    phone
      // On a phone: the space's name, large, with Search, New and you; the spaces are a tab bar below.
      ? h("div", { class: "side-top phone-top" },
        h("h1", {}, SPACES_NOW().find(([id]) => id === space)[1]),
        h("button", { class: "icon", type: "button", "aria-label": "Search", onclick: openPalette }, icon("search", 19)),
        h("button", { class: "icon", type: "button", "aria-label": space === "chat" ? "New chat" : space === "work" ? "New task" : space === "studio" ? "New video" : "New thread", onclick: newInSpace }, icon("compose", 19)),
        h("button", { class: "avatar phone-me", type: "button", "aria-label": "You and Settings", onclick: () => openSettings() }, (a?.email || "?").slice(0, 1).toUpperCase()))
      : h("div", { class: "side-top" },
        h("div", { class: "brand" }, "B5 Code"),
        h("button", { class: "icon", type: "button", title: `Hide sidebar (${KEY()}\\)`, "aria-label": "Hide sidebar", onclick: toggleSidebar }, icon("sidebar", 16))),
    h("div", { class: "side-head" },
      phone ? null : h("div", { class: "side-new" },
        h("button", { class: "new-btn", type: "button", onclick: newInSpace }, icon("compose", 15),
          space === "chat" ? "New chat" : space === "work" ? "New task" : space === "studio" ? "New video" : "New thread", h("span", { class: "kbd" }, `${KEY()}N`)),
        h("button", { class: "search-btn", type: "button", title: `Search everything (${KEY()}K)`, "aria-label": "Search", onclick: openPalette }, icon("search", 15))),
      phone ? null : spaceTabs,
      // The overnight queue needs macOS's sandbox: not on Windows.
      space === "code" ? h("div", { class: "side-chips" + (WIN() ? " two" : "") },
        chip("inbox", "inbox", "Inbox", openInbox, inbox),
        WIN() ? null : chip("queue", "moon", "Queue", openQueue, queued, true),
        chip("github", "github", "GitHub", openGithub))
        : space === "studio" ? null
        : h("div", { class: "side-chips one" }, chip("inbox", "inbox", "Waiting for you", openInbox, inbox))),
    h("nav", { class: "side-list", "aria-label": SPACES_NOW().find(([id]) => id === space)[1] }, ...spaceList(space, q, hit)),
    // Two or more accounts: each one's card, with its meters and whether it's full, above the foot.
    !phone && many ? accountCards() : null,
    phone ? spaceTabs : h("div", { class: "side-foot" },
      h("button", { class: "me", type: "button", title: !a ? "Sign in to Claude" : many ? "Your accounts and their usage" : "Your account and usage", onclick: () => (a || S.phone ? openSettings("account") : signInDialog()) },
        h("span", { class: "avatar", "aria-hidden": "true" }, (a?.email || "?").slice(0, 1).toUpperCase()),
        h("span", { class: "who" },
          h("b", { title: a?.email || "" }, a?.email ? a.email.split("@")[0] : "Not signed in"),
          h("span", {}, a ? `${planShort(a.plan) || "Claude"}${many ? ` · ${accountsShown().length} accounts` : ""}` : S.phone ? `Sign in on the ${MAC()}` : "Sign in to Claude")),
        usageRing()),
      h("button", { class: "icon", type: "button", title: `Guide (${KEY()}/)`, "aria-label": "Guide", onclick: () => openGuide() }, icon("help", 16)),
      h("button", { class: "icon", type: "button", title: `Settings (${KEY()},)`, "aria-label": "Settings", onclick: () => openSettings() }, icon("settings", 16))),
  ].filter(Boolean));
}

// Plan usage, as the Claude app shows it: Claude Code's /usage (read by the
// server every 10 minutes), with each turn's rate-limit events laid on top
// when they are newer. Amber past 75%, red past 95%.
function usageWindows(acct = { planUsage: S.planUsage, usage: S.usage }) {
  const plan = acct.planUsage;
  const base = (plan?.windows || []).map((w) => ({ ...w }));
  const live = acct.usage;
  if (live && (!plan || (live.at || 0) > plan.at)) {
    const set = (label, w) => {
      if (!w) return;
      const have = base.find((x) => x.label === label);
      if (have) have.used = w.used; else base.push({ label, used: w.used, resets: "" });
    };
    set("Session", live.fiveHour);
    set("Week", live.week);
  }
  return base;
}

const toneOf = (used) => (used >= 0.95 ? "var(--bad)" : used >= 0.75 ? "var(--warn)" : "var(--muted)");

// With two or more accounts, the sidebar's foot is a card per account: who it
// is, its plan, whether new work goes to it, and its two meters at a size you
// can read. Clicking one opens Usage.
const ACCOUNT_COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ec4899"];
const planShort = (p) => String(p || "").replace(/^Claude\s+/, "");

/** An account's status, in a word or two, and its tone. */
function accountState(a) {
  if (!a.signedIn) return { text: "Signed out", tone: "warn" };
  if (a.sameAs) return { text: "Same account", tone: "warn", detail: `This is the same subscription as ${a.sameAs}, so switching to it gains nothing. Remove it and add your other subscription, or sign ${a.sameAs} in to the other one.` };
  if (a.limitedUntil || a.full) {
    const at = a.limitedUntil || (a.full > 0 ? a.full : 0);
    const when = at ? resumeLabel(at) : a.fullResets ? resetsShort(a.fullResets) : "";
    return { text: "Full", tone: "bad", detail: when ? `Back ${when}. New work goes to your other account.` : "New work goes to your other account." };
  }
  return a.next ? { text: "In use", tone: "ok" } : { text: "Standby", tone: "" };
}

/** /usage's "Oct 27, 1:00am": the time alone when it's today, else the date too. */
function resetsShort(text) {
  const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return text.startsWith(today + ",") ? `at ${text.slice(today.length + 1).trim()}` : `on ${text.replace(",", " at")}`;
}

function accountCards() {
  const list = S.accounts || [];
  return h("div", { class: "acct-side" },
    h("div", { class: "acct-head" },
      h("span", {}, "Accounts"),
      h("button", { class: "icon", type: "button", title: `Settings (${KEY()},)`, "aria-label": "Settings", onclick: () => openSettings() }, icon("settings", 15))), // not the click: it'd be taken for a page
    ...list.map((acct, i) => {
      const st = accountState(acct);
      const ws = usageWindows(acct.id === "main" ? { planUsage: S.planUsage, usage: S.usage } : { planUsage: acct.planUsage, usage: acct.usage })
        .filter((w) => w.label === "Session" || w.label === "Week");
      return h("button", { class: "acct-card" + (acct.next ? " next" : "") + (st.tone === "bad" ? " full" : ""), type: "button",
        title: `${acct.email}${acct.plan ? ` · ${acct.plan}` : ""}\nClick for this account's usage`, onclick: openUsage },
        h("span", { class: "avatar sm", style: `background:${ACCOUNT_COLORS[i % ACCOUNT_COLORS.length]}`, "aria-hidden": "true" }, shortName(acct).slice(0, 1).toUpperCase()),
        h("span", { class: "acct-body" },
          h("span", { class: "acct-top" },
            h("span", { class: "acct-name" }, shortName(acct)),
            acct.plan ? h("span", { class: "acct-plan" }, planShort(acct.plan)) : null,
            h("span", { class: "acct-state " + st.tone }, st.tone === "ok" ? h("span", { class: "dot" }) : null, st.text)),
          ws.length ? h("span", { class: "acct-meters" }, ...ws.map((w) => {
            const pct = Math.round(w.used * 100);
            return h("span", { class: "acct-meter" },
              h("span", { class: "acct-meter-top" }, h("span", {}, w.label === "Session" ? "5-hour" : "Week"), h("b", { style: `color:${toneOf(w.used)}` }, `${pct}%`)),
              h("span", { class: "acct-bar" }, h("span", { style: `width:${Math.min(100, pct)}%;background:${w.used >= 0.75 ? toneOf(w.used) : "var(--accent)"}` })));
          })) : h("span", { class: "acct-meters note" }, acct.signedIn ? "Reading usage…" : "Sign in again in Settings"),
          st.detail ? h("span", { class: "acct-note" }, st.detail) : null));
    }));
}

/** Extra accounts signed in: the sidebar and Usage show each account's meters. */
const accountsShown = () => (S.accounts || []).filter((a) => a.signedIn);

function usageRow(acct) {
  if (!acct && accountsShown().length > 1) {
    return h("div", { class: "usage-accts" }, ...accountsShown().map((a) => h("div", { class: "usage-acct" + (a.limitedUntil ? " limited" : "") },
      h("span", { class: "usage-name", title: a.email }, a.limitedUntil ? `${shortName(a)} · at its limit` : shortName(a)), usageRow(a))));
  }
  const ws = usageWindows(acct ? { planUsage: acct.planUsage, usage: acct.usage } : undefined).filter((w) => w.label === "Session" || w.label === "Week");
  if (!ws.length) return null;
  return h("button", { class: "usage", type: "button", title: "Plan usage: click for details", onclick: openUsage },
    ...ws.map((w) => {
      const pct = Math.round(w.used * 100);
      return h("span", { class: "meter" },
        h("span", { class: "meter-bar" }, h("span", { style: `width:${Math.min(100, pct)}%;background:${toneOf(w.used)}` })),
        h("span", { style: `color:${toneOf(w.used)}` }, `${w.label} ${pct}%`));
    }));
}

const shortName = (a) => (a.id === "main" ? (a.email ? a.email.split("@")[0] : "Main") : a.name && a.name !== a.email ? a.name : (a.email || "Other").split("@")[0]);

function openUsage() {
  document.querySelector(".usage-sheet")?.closest(".overlay")?.b5close?.();
  const many = accountsShown().length > 1;
  const main = (S.accounts || []).find((a) => a.id === "main");
  const list = many ? accountsShown() : [main || { id: "main", planUsage: S.planUsage, usage: S.usage }];
  const age = S.planUsage ? Math.round((Date.now() - S.planUsage.at) / 60000) : null;
  const tips = S.planUsage?.text?.split(/\n(?=What's contributing)/)[1] || "";
  sheet("Usage", [
    h("div", { class: "usage-sheet" },
      ...list.map((acct) => {
      const ws = usageWindows(acct.id === "main" ? { planUsage: S.planUsage, usage: S.usage } : { planUsage: acct.planUsage, usage: acct.usage });
      return [many ? h("div", { class: "set-section" }, `${shortName(acct)}${acct.email ? ` · ${acct.email}` : ""}${acct.plan ? ` · ${acct.plan}` : ""}`) : null,
      acct.limitedUntil ? h("p", { class: "note", style: "color:var(--warn)" }, `At its usage limit until ${new Date(acct.limitedUntil).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}. New turns go to your other account.`) : null,
      ws.length ? ws.map((w) => {
        const pct = Math.round(w.used * 100);
        return h("div", { class: "u-row" },
          h("div", { class: "u-top" }, h("span", { class: "set-title" }, w.label), h("span", { style: `color:${toneOf(w.used)};font-weight:600` }, `${pct}% used`)),
          h("div", { class: "u-bar" }, h("span", { style: `width:${Math.min(100, pct)}%;background:${toneOf(w.used)}` })),
          w.resets ? h("div", { class: "set-desc" }, `Resets ${w.resets}`) : null);
      }) : h("p", { class: "note" }, "Reading your usage from Claude Code…")];
      }).flat(),
      tips ? h("details", { class: "u-tips" }, h("summary", {}, "What's using it"), h("pre", {}, tips.trim())) : null,
      h("div", { class: "btns", style: "justify-content:space-between;margin-top:8px" },
        h("span", { class: "note" }, age == null ? "" : age < 1 ? "Updated just now" : `Updated ${age} min ago`),
        h("button", { class: "btn", type: "button", onclick: async (e) => { e.currentTarget.disabled = true; e.currentTarget.textContent = "Checking…"; try { await call("POST", "/api/usage"); } catch (x) { toast(x.message); } } }, "Check now"))),
  ]);
}

function renderRow(t) {
  const st = stateOf(t.id);
  return h("div", { class: "row" + (t.sideOf ? " side-row" : "") + (t.id === S.threadId && S.view === "thread" ? " on" : ""), role: "presentation" },
    h("span", { class: "status-ic " + st, title: st === "needs" ? "Needs your answer" : st === "working" ? "Working" : "" },
      st === "working" ? h("span", { class: "spinner" }) : st === "needs" ? h("span", { class: "needs" }) : null),
    h("button", { type: "button", class: "title", style: "text-align:left;height:100%", onclick: () => openThread(t.id), title: t.title }, t.title),
    t.resume ? h("span", { class: "when", title: `Carries on ${resumeLabel(t.resume.at)}, when the usage limit resets` }, icon("clock", 12)) : h("span", { class: "when" }, ago(t.updatedAt)),
    h("button", { class: "del", type: "button", title: t.sideOf ? "Delete side chat" : "Delete thread", "aria-label": `Delete ${t.title}`, onclick: () => confirmDelete(t) }, icon("x", 13)));
}

function toggleGroup(id) {
  if (S.closed.has(id)) S.closed.delete(id); else S.closed.add(id);
  store.set("closed", [...S.closed]);
  renderSide();
}

function confirmDelete(t) {
  const sides = sidesOf(t.id).length;
  const content = [h("p", { class: "note", style: "margin:0" }, `"${t.title}" and its history leave B5 Code${sides ? `, with its ${sides === 1 ? "side chat" : `${sides} side chats`}` : ""}. Files Claude changed stay as they are.`)];
  // A thread on its own branch can take its worktree with it.
  const alsoTree = t.branch && !S.pr[t.id]?.removed ? h("input", { type: "checkbox", id: "del-tree" }) : null;
  if (alsoTree) content.push(h("label", { class: "check-row", for: "del-tree" }, alsoTree,
    h("span", {}, `Also delete its worktree (${home(t.root || t.dir)}) and the local branch ${t.branch}. Refused if anything there isn't committed or isn't on GitHub.`)));
  dialog("Delete this thread?", content, "Delete", async () => { await deleteThread(t, alsoTree?.checked); });
}

// The thread view is built once: the bar, the feed and the composer stay the
// same elements, so the cursor never leaves the composer mid-stream and the
// working line's spinner never restarts.
let view = null;
function threadView() {
  if (view) return view;
  const title = h("span", { class: "title" });
  const where = h("span", { class: "where" });
  const paneBtn = h("button", { class: "icon", type: "button", title: "Changes", "aria-label": "Show or hide changes", onclick: togglePane }, icon("panel", 16));
  const prBox = h("span", { class: "pr-box" });
  const back = h("button", { class: "btn small quiet back", type: "button", hidden: true, onclick: () => { const t = thread(); if (t?.sideOf) openThread(t.sideOf); } }, icon("chevronLeft", 13), h("span", {}));
  const sideBtn = h("button", { class: "icon", type: "button", title: "Side chat (/btw): ask about this thread while it works", "aria-label": "Side chat", onclick: () => openSide() }, icon("chat", 16));
  const bar = h("div", { class: "bar" },
    showSideButton(),
    back, title, where, h("span", { class: "spacer" }), prBox, sideBtn, paneBtn,
    h("button", { class: "icon mobile-only", type: "button", title: "New thread", "aria-label": "New thread", onclick: () => startNew() }, icon("compose", 17)));
  const items = h("div", { style: "display:contents" });
  const working = workingLine();
  working.hidden = true;
  const hello = h("div", { class: "hello" });
  const next = h("div", { class: "next-steps", hidden: true });
  const feed = h("div", { class: "feed", onscroll: onFeedScroll }, h("div", { class: "center" }, h("div", { class: "feed-inner", style: "width:100%" }, items, working, next), hello));
  const jump = h("button", { class: "jump", type: "button", hidden: true, onclick: () => { S.stick = true; scrollToEnd(); render(); } }, icon("arrowDown", 13), "Latest");
  const composer = buildComposer();
  // "Latest" rides just above the composer, whatever its height (to-dos, attachments and a growing message change it).
  new ResizeObserver(() => jump.style.setProperty("--composer-h", composer.offsetHeight + "px")).observe(composer);
  view = { title, where, prBox, paneBtn, back, sideBtn, items, working, next, hello, feed, jump, composer, nodes: [bar, feed, composer, jump] };
  return view;
}

// The chat panel's background: a dot grid, still while Claude is idle; ripples of light run through it
// while Claude works, brighter while it writes. Built once and put back after every redraw of the panel.
let bgEl = null;
function motionBackground(main, feed) {
  bgEl ||= h("div", { class: "bg", "aria-hidden": "true" }, h("div", { class: "bg-dots" }),
    h("div", { class: "bg-ripples" }, h("span", { class: "rip r1" }), h("span", { class: "rip r2" }), h("span", { class: "rip r3" })));
  if (bgEl.parentNode !== main) main.prepend(bgEl);
  const last = feed?.items[feed.items.length - 1];
  main.classList.toggle("claude-working", !!feed?.working && !feed.waiting);
  main.classList.toggle("claude-writing", !!feed?.working && last?.type === "ai" && !!last.live);
}

function renderMain() {
  const main = $("main");
  try { renderMainInner(main); } finally { motionBackground(main, S.view === "thread" && S.threadId ? feedOf(S.threadId) : null); }
}

function renderMainInner(main) {
  if (S.view === "studio") { renderStudio(main); return; } // needs no project
  if (!S.projects.length) {
    view = null;
    fill(main, h("div"), h("div", { class: "center" }, h("div", { class: "hello" },
      h("h1", {}, "Welcome to B5 Code"),
      // Signing in comes first: nothing works before it.
      ...(!S.account && !S.phone
        ? [h("p", {}, "Sign in with your Claude subscription to start. Then add a project folder: Claude works inside it, with its CLAUDE.md, skills and memory."),
          h("button", { class: "btn primary", type: "button", onclick: () => signInDialog() }, "Sign in to Claude")]
        : [h("p", {}, "Add a project folder to start. Claude works inside it, with its CLAUDE.md, skills and memory."),
          h("button", { class: "btn primary", type: "button", onclick: addProjectDialog }, "Add a project folder")]))));
    return;
  }
  if (S.view === "inbox") { renderInbox(main); return; }
  if (S.view === "queue") { renderQueue(main); return; }
  if (S.view === "github") { renderGithub(main); return; }
  if (S.view === "guide") { renderGuide(main); return; }
  const v = threadView();
  if (v.nodes[0].parentNode !== main) fill(main, ...v.nodes);
  const t = thread();
  const p = project();
  const feed = t ? feedOf(t.id) : emptyFeed();

  v.title.textContent = t ? t.title : "New thread";
  const parent = t?.sideOf ? S.threads.find((x) => x.id === t.sideOf) : null;
  v.back.hidden = !parent;
  if (parent) { v.back.querySelector("span:last-child").textContent = parent.title; v.back.title = `Back to ${parent.title}`; }
  v.sideBtn.hidden = !t || !!t.sideOf;
  const branch = t?.branch || p?.branch;
  fill(v.where, p ? p.name : "", branch ? h("span", { style: "display:inline-flex;align-items:center;gap:3px;color:var(--faint)" }, icon("branch", 12), branch) : "");
  renderPrBox(v.prBox, t);
  v.paneBtn.classList.toggle("on", S.pane);

  const prevScroll = v.feed.scrollTop;
  // Only the elements that changed are swapped in.
  const nodes = feed.items.map((it) => drawItem(it, t));
  const kids = v.items.childNodes;
  nodes.forEach((n, i) => { if (kids[i] !== n) (kids[i] ? v.items.replaceChild(n, kids[i]) : v.items.append(n)); });
  while (kids.length > nodes.length) v.items.lastChild.remove();
  const empty = !feed.items.length;
  v.hello.hidden = !empty;
  if (empty) {
    if (parent) fill(v.hello, 
      h("h1", {}, "Side chat"),
      h("p", {}, parent.sessionId ? `Ask anything about “${parent.title}”. This chat starts from a copy of that conversation, so it knows everything so far, and the thread carries on working while you talk here.`
        : `Ask anything about “${parent.title}”. That thread hasn't started yet, so this chat starts fresh in the same folder.`));
    else if (p?.kind === "work") fill(v.hello, ...workHello(p).filter(Boolean)); // a null would show as "null"
    else if (p?.kind === "chat") fill(v.hello, ...chatHello());
    else fill(v.hello, 
      h("h1", {}, p ? `What are we working on in ${p.name}?` : "What are we working on?"),
      h("p", {}, !p ? "" : t?.branch ? `Claude works in ${home(t.dir)}, on its own branch ${t.branch}. Type / for skills and commands.`
        : !t && S.newBranch ? `Claude will work on a new branch, ${newBranchName()}, in its own worktree. Type / for skills and commands.`
          : `Claude works in ${home(p.dir)}${p.branch ? ` on ${p.branch}` : ""}. Type / for skills and commands.`),
      ...(!t && p && !S.phone ? [h("button", { class: "btn quiet", type: "button", style: "margin-top:10px", onclick: () => openImport(p) }, icon("terminal", 14), "Continue a conversation from the terminal…")] : []));
  }
  v.working.hidden = !(feed.working && !feed.waiting);
  if (!v.working.hidden) fillWorking(v.working, feed);
  renderNextSteps(v.next, t, feed);
  updateComposer(feed);
  // Measured once the whole page has changed (see render).
  pendingScroll = () => {
    if (S.stick) scrollToEnd(); else v.feed.scrollTop = prevScroll;
    v.jump.hidden = S.stick || v.feed.scrollHeight - v.feed.scrollTop - v.feed.clientHeight < 40;
  };
  if (!rendering) settleScroll();
}
let pendingScroll = null;
function settleScroll() {
  const f = pendingScroll;
  pendingScroll = null;
  f?.();
}

// ── Waiting for you ──────────────────────────────────────────────────────────

function renderInbox(main) {
  const items = inboxItems({ threads: S.threads, waiting: S.waiting, seen: S.seen });
  const projectOf = (t) => S.projects.find((p) => p.id === t.projectId);
  const chip = (t) => {
    const p = projectOf(t);
    return h("span", { class: "in-proj" }, h("span", { class: "swatch", style: `background:${p?.color || "var(--muted)"}` }), p?.name || "");
  };
  const cards = items.map((it) => {
    const t = it.thread;
    if (it.kind === "ask") {
      return h("article", { class: "in-card ask-card" },
        h("div", { class: "in-top" }, chip(t), h("span", { class: "in-kind warn" }, h("span", { class: "needs" }), "Claude is asking"), h("span", { class: "spacer" }), h("span", { class: "in-when" }, ago(t.updatedAt))),
        h("div", { class: "in-title" }, t.title),
        ...it.asks.map((a) => { const qs = questionsOf(a.tool, a.input); return qs ? h("div", { class: "in-ask" },
          h("div", { class: "ask-what" }, qs[0].question),
          h("div", { class: "btns" },
            h("button", { class: "btn primary", type: "button", onclick: () => openThread(t.id) }, "Answer in the thread"),
            h("button", { class: "btn quiet", type: "button", onclick: () => answerFromInbox(t.id, a, "deny") }, "Skip")))
          : h("div", { class: "in-ask" },
          h("div", { class: "ask-what" }, a.summary),
          a.detail ? h("pre", {}, a.detail.slice(0, 600)) : null,
          h("div", { class: "btns" },
            h("button", { class: "btn primary", type: "button", onclick: () => answerFromInbox(t.id, a, "allow") }, "Allow once"),
            a.canAllowEdits ? h("button", { class: "btn", type: "button", onclick: () => answerFromInbox(t.id, a, "allow-edits") }, "Allow edits in this thread") : null,
            h("button", { class: "btn quiet", type: "button", onclick: () => answerFromInbox(t.id, a, "deny") }, "Don't allow"),
            h("span", { class: "spacer" }),
            h("button", { class: "btn quiet", type: "button", onclick: () => openThread(t.id) }, "Open thread"))); }));
    }
    return h("article", { class: "in-card" },
      h("div", { class: "in-top" }, chip(t), h("span", { class: "in-kind " + (t.lastOk === false ? "bad" : "ok") }, icon(t.lastOk === false ? "x" : "check", 13), t.lastOk === false ? "Stopped" : "Finished"), h("span", { class: "spacer" }), h("span", { class: "in-when" }, ago(t.lastDoneAt))),
      h("div", { class: "in-title" }, t.title),
      t.lastReply ? h("p", { class: "in-reply" }, t.lastOk === false ? friendlyError(t.lastReply) : t.lastReply) : null,
      h("div", { class: "btns" },
        h("button", { class: "btn primary", type: "button", onclick: () => openThread(t.id) }, "Open"),
        h("button", { class: "btn quiet", type: "button", onclick: () => { markSeen(t.id); render(); } }, "Mark as seen")));
  });
  fill(main, 
    h("div", { class: "bar" },
      showSideButton(),
      h("span", { class: "title" }, "Waiting for you"),
      h("button", { class: "icon mobile-only", type: "button", title: "New thread", "aria-label": "New thread", onclick: () => startNew() }, icon("compose", 17))),
    h("div", { class: "feed" }, h("div", { class: "inbox" },
      h("h1", {}, "Waiting for you"),
      h("p", { class: "note" }, items.length ? `${items.length} across your projects.` : ""),
      ...(cards.length ? cards : [h("div", { class: "in-empty" }, icon("check", 22), h("div", {}, "Nothing needs you right now."), h("div", { class: "note" }, "Questions from Claude and finished threads show up here."))]))),
    h("div"));
}

// ── GitHub ───────────────────────────────────────────────────────────────────
// Your GitHub account, read through the Mac's `gh` sign-in (server/github.js).
// Built once, so leaving and coming back doesn't ask GitHub again within a minute.

let githubPane = null;

function openGithub() {
  saveDraft();
  S.view = "github";
  if ($("app").classList.contains("side-open")) { $("app").classList.remove("side-open"); dropLayer(); }
  render();
}

function renderGithub(main) {
  githubPane ||= createGithubPane({ call, h, icon, toast });
  fill(main, 
    h("div", { class: "bar" },
      showSideButton(),
      h("span", { class: "title" }, "GitHub"),
      h("button", { class: "icon", type: "button", title: "Refresh", "aria-label": "Refresh GitHub", onclick: () => githubPane.refresh() }, icon("refresh", 16))),
    h("div", { class: "feed" }, h("div", { class: "inbox" }, githubPane.el)),
    h("div"));
  githubPane.show(project()?.id || "");
}

// ── Studio ───────────────────────────────────────────────────────────────────
// B5 Studio's video editor (its own project; server/studio.js finds and starts it),
// filling the main area. It has its own bar, with a sidebar button that asks this
// page to toggle the sidebar. While a video is open the sidebar makes way for it
// (S.studioWide, never saved), and it's back on the videos list and in every other view.

let studioOrigin = null; // the editor's origin, from /api/studio (messages from anywhere else are ignored)
let studioRoute = ""; // the editor's own #/v/<id>, so coming back reopens the same video
let studioNode = null; // what Studio shows in the main area: the editor's frame, or a message
let studioAsking = false;

function openStudio() {
  saveDraft();
  S.view = "studio";
  if ($("app").classList.contains("side-open")) { $("app").classList.remove("side-open"); dropLayer(); }
  render();
}

// The sidebar's shown state: your choice (S.sideHidden), plus Studio's while a video is open.
function applySideHidden() {
  $("app").classList.toggle("side-hidden", S.sideHidden || (S.view === "studio" && S.studioWide));
  requestAnimationFrame(sendRegions);
}

function renderStudio(main) {
  // Renders come often (every thread event); once something's showing, leave it alone.
  if (studioNode && main.contains(studioNode)) return;
  const put = (...nodes) => { fill(main, ...nodes); studioNode = nodes[nodes.length - 1]; };
  const msg = (title, text, action) => put(
    h("div", { class: "bar" },
      showSideButton(),
      h("span", { class: "title" }, "Studio")),
    h("div", { class: "studio-msg" }, h("b", {}, title), text ? h("p", {}, text) : null, action || null));
  if (S.phone) return msg(`Studio runs on the ${MAC()}`, `Video editing needs the ${MAC()}'s screen and files. Open B5 Code on the ${MAC()} to use Studio.`);
  const show = () => {
    if (S.view !== "studio") return;
    put(h("iframe", { class: "studio-frame", title: "Studio", src: `${studioOrigin}/?embed=1${studioRoute}`, allow: "fullscreen; clipboard-write" }));
  };
  msg("Opening Studio…");
  if (studioAsking) return;
  studioAsking = true;
  call("GET", "/api/studio").then((st) => {
    studioOrigin = new URL(st.url).origin;
    if (S.view !== "studio") return;
    if (st.running) return show();
    if (!st.dir) return msg(`B5 Studio isn't on this ${MAC()}`, "Studio is B5 Studio's video editor. B5 Code looks for it in ~/Desktop/B5 Studio.");
    const start = h("button", { class: "btn primary", type: "button", onclick: async () => {
      start.disabled = true;
      start.textContent = "Starting…";
      try { await call("POST", "/api/studio/start"); show(); }
      catch (e) { toast(e.message); start.disabled = false; start.textContent = "Start the editor"; }
    } }, "Start the editor");
    msg("Studio isn't running", `B5 Studio's editor runs on this ${MAC()} in the background. Start it once, and it keeps running after you close this.`, start);
  }, (e) => { if (S.view === "studio") msg("Studio didn't open", e.message); })
    .finally(() => { studioAsking = false; });
}

// Studio's Claude tab: a real thread in the B5 Studio project, one per video (studioVideo
// on the thread), so it has everything a thread has: permissions, skills, notifications,
// the overnight queue. This page runs it as any other and passes it to the editor
// (web/studio-chat.js); the editor sends back what you type, Stop and your answers.
const studioChat = { threadId: null, video: null, pending: false };

async function studioThread(video) {
  const st = await call("GET", "/api/studio");
  if (!st.dir) throw new Error(`B5 Studio isn't on this ${MAC()}.`);
  let p = S.projects.find((x) => x.dir === st.dir && x.kind !== "work");
  if (!p) {
    p = await call("POST", "/api/projects", { dir: st.dir, name: "B5 Studio" });
    if (!S.projects.some((x) => x.id === p.id)) S.projects.push(p);
  }
  let t = S.threads.find((x) => x.projectId === p.id && x.studioVideo === video.id);
  if (!t) {
    t = await call("POST", "/api/threads", { projectId: p.id, studioVideo: video.id, title: video.name });
    S.threads.unshift(t);
  }
  renderSide();
  return t;
}

function studioChatSoon() {
  if (studioChat.pending) return;
  studioChat.pending = true;
  requestAnimationFrame(() => { studioChat.pending = false; studioChatPost(); });
}

function studioChatPost(extra = {}) {
  const frame = document.querySelector(".studio-frame");
  const id = studioChat.threadId;
  if (!frame?.contentWindow || !id || !studioOrigin) return;
  const t = S.threads.find((x) => x.id === id);
  const snap = chatSnapshot(feedOf(id), { threadId: id, waiting: S.waiting[id] || [], commands: S.commands[t?.projectId] || [], markdown: renderMarkdown, headline: stepsHeadline, current: currentStep });
  const { pick, all, latest } = modelChoices(t);
  const list = latest.some((m) => m.value === pick) ? latest : all;
  // Before Claude has started, only the setting's alias is known ("opus[1m]"): say it as a name.
  const name = currentModelName(t).replace(/^([a-z])([a-z]*)(\[1m\])?$/i, (_, a, b, m) => a.toUpperCase() + b + (m ? " (1M)" : ""));
  const model = { name, pick, options: list.map((m) => ({ value: pickFor(m, all), name: m.name, description: m.description || "", on: m.value === pick })), more: S.models.length === 0 };
  frame.contentWindow.postMessage({ type: "b5-thread", video: studioChat.video?.id, ...snap, model, ...extra }, studioOrigin);
}

async function studioChatDo(d) {
  const reply = (error) => studioChatPost({ error });
  try {
    if (d.do === "chat-open") {
      if (typeof d.video?.id !== "string") return;
      studioChat.video = { id: d.video.id, name: String(d.video.name || d.video.id) };
      const t = await studioThread(studioChat.video);
      studioChat.threadId = t.id;
      if (!S.feeds.has(t.id) || S.feeds.get(t.id).partial) await loadFeed(t.id);
      call("POST", `/api/threads/${t.id}/warm`, {}).catch(() => {}); // Claude starts now, and its skills arrive for the / menu
      return studioChatPost();
    }
    const id = studioChat.threadId;
    if (!id) return;
    if (d.do === "chat-send" && typeof d.text === "string" && d.text.trim()) await call("POST", `/api/threads/${id}/send`, { text: d.text.slice(0, 20000) });
    else if (d.do === "chat-stop") await call("POST", `/api/threads/${id}/stop`, {});
    else if (d.do === "chat-answer") await call("POST", `/api/threads/${id}/permission`, { requestId: String(d.requestId || ""), choice: d.choice });
    else if (d.do === "chat-thread") { S.studioWide = false; openThread(id); }
    else if (d.do === "chat-model") {
      const t = S.threads.find((x) => x.id === id);
      const value = d.value === null ? null : String(d.value || "").slice(0, 80) || null;
      if (t) t.modelPref = value;
      await call("POST", `/api/threads/${id}/model`, { model: value });
      studioChatPost();
    }
  } catch (e) {
    reply(e.message);
  }
}

addEventListener("message", (e) => {
  if (!studioOrigin || e.origin !== studioOrigin || e.data?.type !== "b5-studio") return;
  if (e.data.do === "sidebar") return toggleSidebar();
  if (e.data.do === "palette") return openPalette();
  if (String(e.data.do || "").startsWith("chat-")) return studioChatDo(e.data);
  if (typeof e.data.route === "string") {
    studioRoute = /^#\/v\/[a-z0-9-]+$/.test(e.data.route) ? e.data.route : "";
    S.studioWide = !!studioRoute && SET.studioRoom !== false && !matchMedia("(max-width: 760px)").matches;
    S.studioPane = false;
    applySideHidden();
    renderPane();
  }
});

// ── The guide ────────────────────────────────────────────────────────────────
// How to use all of B5 Code, B5 Work included, as tips by topic (web/guide.js).

function openGuide(section = "") {
  saveDraft();
  S.view = "guide";
  if ($("app").classList.contains("side-open")) { $("app").classList.remove("side-open"); dropLayer(); }
  render();
  if (section) requestAnimationFrame(() => document.getElementById("guide-" + section)?.scrollIntoView({ block: "start" }));
}

function renderGuide(main) {
  const list = h("div", { class: "guide-list" });
  const refill = () => {
    const found = searchGuide(S.guideQuery, guideFor().guide);
    fill(list, ...(found.length ? found.map((s) => h("section", { class: "guide-sec", id: "guide-" + s.id },
      h("h2", {}, s.title), h("p", { class: "guide-intro" }, s.intro),
      h("ul", { class: "guide-tips" }, ...s.tips.map((tip) => h("li", { html: renderMarkdown(tip) })))))
      : [h("p", { class: "guide-intro" }, "Nothing in the guide matches that.")]),
      ...(S.guideQuery ? [] : [h("section", { class: "guide-sec", id: "guide-keys" }, h("h2", {}, "Keyboard shortcuts"),
        h("div", { class: "guide-keys" }, ...guideFor().shortcuts.flatMap(([k, what]) => [h("kbd", {}, k), h("span", {}, what)])))]));
  };
  const search = h("input", { type: "search", class: "guide-search", placeholder: "Search the guide: branch, recipe, phone…", value: S.guideQuery || "", "aria-label": "Search the guide",
    oninput: (e) => { S.guideQuery = e.target.value; refill(); } });
  refill();
  fill(main, 
    h("div", { class: "bar" },
      showSideButton(),
      h("span", { class: "title" }, "Guide")),
    h("div", { class: "feed" }, h("div", { class: "inbox guide" },
      h("h1", {}, "Use B5 Code like a pro"),
      h("p", { class: "guide-intro" }, "Everything it can do, in short tips. B5 Work and automations included."),
      search,
      h("div", { class: "guide-toc" }, ...guideFor().guide.map((s) => h("button", { type: "button", class: "chip", onclick: () => { S.guideQuery = ""; search.value = ""; refill(); document.getElementById("guide-" + s.id)?.scrollIntoView({ block: "start", behavior: "smooth" }); } }, s.title)),
        h("button", { type: "button", class: "chip", onclick: () => document.getElementById("guide-keys")?.scrollIntoView({ block: "start", behavior: "smooth" }) }, "Shortcuts")),
      list)),
    h("div"));
}

// ── The overnight queue ──────────────────────────────────────────────────────
// Tasks B5 Code works through on its own, one at a time, each on a branch of
// its own (server/queue.js). Nothing is pushed or merged: the PRs are yours.

function openQueue() {
  saveDraft();
  S.view = "queue";
  if ($("app").classList.contains("side-open")) { $("app").classList.remove("side-open"); dropLayer(); }
  render();
  call("GET", "/api/queue").then((q) => { S.queue = q; if (S.view === "queue") renderMain(); }, () => {});
}

const queueCall = async (method, url, body) => { try { S.queue = await call(method, url, body); renderMain(); renderSide(); } catch (e) { toast(e.message); } };

function renderQueue(main) {
  const q = S.queue || { on: false, tasks: [] };
  const projects = S.projects;
  // The add form keeps what you typed across redraws (a task finishing redraws the list).
  const draft = S.queueDraft ||= { projectId: S.projectId || projects[0]?.id, brief: "", checks: "" };
  const sel = h("select", { class: "art-pick", "aria-label": "Project", onchange: (e) => { draft.projectId = e.target.value; } },
    ...projects.map((p) => h("option", { value: p.id, selected: p.id === draft.projectId }, p.name)));
  const brief = h("textarea", { rows: "3", placeholder: "What to do, as you'd ask Claude. E.g. “Fix issue #12: the GPA card shows NaN when there are no grades. Add a test.”", "aria-label": "The task",
    oninput: (e) => { draft.brief = e.target.value; } });
  brief.value = draft.brief;
  const checks = h("input", { type: "text", placeholder: "Checks to pass, e.g. npm test (optional)", "aria-label": "Checks", autocomplete: "off", spellcheck: "false",
    oninput: (e) => { draft.checks = e.target.value; } });
  checks.value = draft.checks;
  const add = async () => {
    if (!draft.brief.trim()) return toast("Say what the task is.");
    await queueCall("POST", "/api/queue/tasks", { projectId: draft.projectId, brief: draft.brief, checks: draft.checks });
    S.queueDraft = { projectId: draft.projectId, brief: "", checks: draft.checks };
    renderMain();
  };
  const running = q.tasks.find((t) => t.status === "running");
  const left = q.tasks.filter((t) => t.status === "queued").length;
  const when = q.startAt && q.startAt > Date.now() ? resumeLabel(q.startAt) : "";
  const time = h("input", { type: "time", "aria-label": "Start at", value: (() => { const d = q.startAt ? new Date(q.startAt) : new Date(new Date().setHours(23, 0, 0, 0)); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; })() });
  const startAt = () => {
    const [hh, mm] = time.value.split(":").map(Number);
    const d = new Date(); d.setHours(hh, mm, 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    queueCall("POST", "/api/queue", { on: true, startAt: d.getTime() });
  };
  const status = !q.on ? (left ? "Off. Tasks wait here until you start the queue." : "Off. Add a task below, then start the queue.")
    : when ? `Starts ${when}${left ? `, with ${left} task${left === 1 ? "" : "s"}` : ""}.`
      : q.waiting ? "On, waiting: every account is at its usage limit. It starts again when one resets."
        : running ? `On: working on #${running.n}${left ? `, ${left} more after it` : ""}.` : left ? "On: starting the next task…" : "On: add a task and it starts.";
  const cards = q.tasks.map((t, i) => queueCard(t, i, q.tasks.length));
  fill(main, 
    h("div", { class: "bar" },
      showSideButton(),
      h("span", { class: "title" }, "Overnight queue"),
      h("button", { class: "icon mobile-only", type: "button", title: "New thread", "aria-label": "New thread", onclick: () => startNew() }, icon("compose", 17))),
    h("div", { class: "feed" }, h("div", { class: "inbox queue" },
      h("h1", {}, "Overnight queue"),
      h("p", { class: "note" }, `B5 Code works through these on its own, one at a time, each on a branch of its own, on whichever account has room. Edits, tests, builds and git in the task's folder run without asking; ${S.settings?.queueCarryOn !== false ? "anything else is skipped, and the task carries on without it" : "anything else pauses the task for you and the queue moves on"}. Nothing is pushed or merged: in the morning, each task has a report, and its thread has Open PR.`),
      h("div", { class: "in-card q-run" },
        h("div", { class: "q-status" }, h("span", { class: "q-dot" + (q.on ? " on" : "") }), h("span", {}, status)),
        h("div", { class: "btns" },
          q.on ? h("button", { class: "btn", type: "button", onclick: () => queueCall("POST", "/api/queue", { on: false, startAt: null }) }, "Pause the queue")
            : h("button", { class: "btn primary", type: "button", disabled: !left, onclick: () => queueCall("POST", "/api/queue", { on: true, startAt: null }) }, "Start now"),
          h("span", { class: "q-at" }, "or at", time, h("button", { class: "btn", type: "button", disabled: !left, onclick: startAt }, when ? "Change" : "Start then"))),
        h("div", { class: "q-nowait", onchange: () => setTimeout(renderMain) }, serverToggle("queueCarryOn", "Don't wait for me",
          "When a task wants to do something the overnight rules keep for you, or asks you a question, Claude skips it and carries on. Each task lists what it skipped. Off: the task waits for your answer."))),
      projects.length ? h("div", { class: "in-card q-add" },
        h("div", { class: "in-title" }, "Add a task"),
        h("div", { class: "q-row" }, sel), brief, checks,
        h("div", { class: "btns" }, h("button", { class: "btn primary", type: "button", onclick: add }, "Add to the queue"))) : h("p", { class: "note" }, "Add a project first."),
      ...(cards.length ? cards : [h("div", { class: "in-empty" }, icon("moon", 22), h("div", {}, "No tasks yet."), h("div", { class: "note" }, "Add a few before bed; read the reports with your coffee."))]))),
    h("div"));
}

const Q_TONE = { queued: "", running: "warn", paused: "warn", done: "ok", failing: "bad", stuck: "bad", stopped: "bad" };

function queueCard(t, i, count) {
  const th = S.threads.find((x) => x.id === t.threadId);
  const r = t.report;
  const finished = ["done", "failing", "stuck", "stopped"].includes(t.status);
  const btn = (label, fn, extra = {}) => h("button", { class: "btn small", type: "button", onclick: fn, ...extra }, label);
  return h("article", { class: "in-card q-task " + t.status },
    h("div", { class: "in-top" },
      h("span", { class: "q-n" }, `#${t.n}`),
      h("span", { class: "in-proj" }, h("span", { class: "swatch", style: `background:${S.projects.find((p) => p.id === t.projectId)?.color || "var(--muted)"}` }), t.project),
      h("span", { class: "in-kind " + (Q_TONE[t.status] || "") }, t.status === "running" ? h("span", { class: "spinner", style: "width:10px;height:10px" }) : null,
        t.checking ? "Running the checks" : t.label),
      h("span", { class: "spacer" }),
      t.endedAt ? h("span", { class: "in-when" }, ago(t.endedAt)) : null),
    h("p", { class: "q-brief" }, t.brief),
    t.checks ? h("div", { class: "q-meta" }, icon("check", 12), `Checks: ${t.checks}${t.checkTries ? ` · tried ${t.checkTries}×` : ""}`) : null,
    t.branch ? h("div", { class: "q-meta" }, icon("branch", 12), t.branch) : null,
    t.why ? h("p", { class: "q-why" }, t.why) : null,
    t.skipped?.length ? h("details", {}, h("summary", {}, `Skipped ${t.skipped.length} step${t.skipped.length === 1 ? "" : "s"} that needed you`),
      h("ul", { class: "q-skipped" }, ...t.skipped.map((x) => h("li", {}, x)))) : null,
    r ? h("div", { class: "q-report" },
      h("div", { class: "q-meta" }, `${r.commits.length} commit${r.commits.length === 1 ? "" : "s"}${r.stat ? ` · ${r.stat.replace(/ files? changed/, (m) => m)}` : ""}${r.dirty ? ` · ${r.dirty} file${r.dirty === 1 ? "" : "s"} left uncommitted` : ""}`),
      r.reply ? h("details", {}, h("summary", {}, "Claude's report"), h("div", { class: "msg-ai q-reply", html: md(r.reply) })) : null) : null,
    t.lastCheck && !t.lastCheck.ok && finished ? h("details", {}, h("summary", {}, "The checks' output"), h("pre", { class: "q-out" }, t.lastCheck.output)) : null,
    h("div", { class: "btns" },
      ...(t.status === "queued" ? [btn("↑", () => queueCall("POST", `/api/queue/tasks/${t.id}`, { action: "up" }), { disabled: i === 0, "aria-label": "Earlier" }),
        btn("↓", () => queueCall("POST", `/api/queue/tasks/${t.id}`, { action: "down" }), { disabled: i === count - 1, "aria-label": "Later" }),
        btn("Remove", () => queueCall("DELETE", `/api/queue/tasks/${t.id}`), { class: "btn small quiet" })] : []),
      ...(th ? [btn(t.status === "paused" ? "Answer its question" : "Open thread", () => openThread(th.id), { class: "btn small" + (t.status === "paused" || finished ? " primary" : "") })] : []),
      ...(finished && (t.status !== "done") ? [btn("Try again", () => queueCall("POST", `/api/queue/tasks/${t.id}`, { action: "retry" }))] : []),
      ...(finished && th ? [btn("Throw away", () => dialog(`Throw away #${t.n}?`, [h("p", { class: "note", style: "margin:0" }, `Deletes its thread, its worktree and the branch ${t.branch}. None of it was pushed, so it's gone for good.`)], "Throw away", () => queueCall("DELETE", `/api/queue/tasks/${t.id}/work`)), { class: "btn small quiet", style: "color:var(--bad)" })] : []),
      ...(finished && !th ? [btn("Remove", () => queueCall("DELETE", `/api/queue/tasks/${t.id}`), { class: "btn small quiet" })] : [])));
}

async function answerFromInbox(threadId, a, choice) {
  try {
    await call("POST", `/api/threads/${threadId}/permission`, { requestId: a.requestId, choice });
  } catch (e) {
    toast(e.message);
    S.waiting[threadId] = (S.waiting[threadId] || []).filter((x) => x.requestId !== a.requestId);
    render();
  }
}

function workingLine() {
  return h("div", { class: "working", role: "status" },
    h("span", { class: "spark", "aria-hidden": "true" }, "✻"), h("span", { class: "verb" }), h("span", { class: "meta" }));
}

function fillWorking(el, feed) {
  const secs = (Date.now() - (feed.startedAt || Date.now())) / 1000;
  const stage = currentStep(feed);
  const stageSecs = phaseSeconds(feed);
  el.querySelector(".verb").textContent = workingVerb(secs, feed.seed || 0) + "…";
  el.querySelector(".meta").textContent = [
    stage ? stage + (stageSecs >= 3 ? ` for ${elapsedLabel(stageSecs)}` : "") : "",
    elapsedLabel(secs),
    turnOutput(feed) ? `↓ ${tokensLabel(turnOutput(feed))} tokens` : "",
    "esc to stop",
  ].filter(Boolean).join(" · ");
}

setInterval(() => {
  const t = thread();
  if (t && feedOf(t.id).working && view && !view.working.hidden) fillWorking(view.working, feedOf(t.id));
  if (t && feedOf(t.id).tasks.some((x) => x.status === "running")) renderTasks(feedOf(t.id)); // their clocks
}, 1000);

function onFeedScroll(e) {
  const el = e.target;
  const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  if (atEnd !== S.stick) { S.stick = atEnd; if (view) view.jump.hidden = atEnd; }
}

function scrollToEnd() {
  if (view) view.feed.scrollTop = view.feed.scrollHeight;
}

// Finished replies only: a reply still streaming is new text on every word.
const mdCache = new Map();
function md(text, keep = true) {
  if (mdCache.has(text)) return mdCache.get(text);
  const html = renderMarkdown(text);
  if (!keep) return html;
  if (mdCache.size >= 400) mdCache.delete(mdCache.keys().next().value); // the oldest
  mdCache.set(text, html);
  return html;
}

// Each item's element is kept with a note of what it shows, so a streamed
// word redraws only the reply it belongs to, not the whole conversation.
const drawn = new WeakMap(); // feed item -> { sig, node }
function itemSig(it, t) {
  if (it.type === "ai") return (it.live ? "live:" : "") + it.text;
  if (it.type === "steps") return JSON.stringify([S.open.has(it.key), it.steps.map((x) => [x.state, x.summary, S.open.has("step-" + x.id), x.result || ""])]);
  if (it.type === "ask") return `${t?.id}:${it.answer}`;
  if (it.type === "user") return `${S.previewBase}:${it.steer || ""}:${it.cp || ""}`;
  if (it.type === "cp") return `${t?.cpHere || ""}:${it.files.length}`;
  if (it.type === "rewind") return `${canUndoRewind(it, t)}`;
  if (it.type === "limit") return `${it.state}:${it.resumeAt}`;
  if (it.type === "recap") return `${S.open.has(recapKey(it))}`;
  if (it.type === "artifact") return `${it.version}:${it.title}:${cardShowing(it)}`;
  if (it.type === "checks") return `${it.status}:${(it.results || []).length}:${S.open.has(it.key)}:${it.answered || ""}:${S.projects.find((p) => p.id === it.projectId)?.checksOn}:${t ? feedOf(t.id).working : ""}`;
  return it.text || "";
}
function drawItem(it, t) {
  const sig = itemSig(it, t);
  const have = drawn.get(it);
  if (have && have.sig === sig) return have.node;
  const node = renderItem(it, t);
  drawn.set(it, { sig, node });
  return node;
}

const SHOT = /\]\(([^)\s]+\.(?:png|jpe?g|gif|webp))\)/gi;
/** The pictures a step's result points to, as Claude's browser tools do: `[Screenshot of viewport](.playwright-mcp/home.png)`. */
const stepPictures = (s) => (S.previewBase && s.result ? [...new Set([...s.result.matchAll(SHOT)].map((m) => m[1]))].slice(0, 4) : []);
/** The picture a Read step looked at, or "": its result is the image, which only reaches the page as "[image]". */
function readImage(s) {
  if (s.name !== "Read" || !S.previewBase) return "";
  let file = "";
  try { file = String(JSON.parse(s.detail || "{}").file_path || ""); } catch { return ""; }
  return /\.(?:png|jpe?g|gif|webp|svg)$/i.test(file) ? file : "";
}
/** The picture itself, opening in the Preview pane; its path, once it's gone (a screenshot in /tmp, say). */
function readImageCard(file) {
  const card = h("button", { type: "button", class: "step-img", title: file, onclick: () => openPreview(file) });
  card.append(h("img", { src: previewUrl(stepPath(file)), alt: baseName(file), loading: "lazy",
    onerror: () => card.replaceWith(h("pre", {}, `${file}\n\nThe picture isn't there any more.`)) }));
  return card;
}
/** A picture's path made absolute, so it can be fetched. */
const stepPath = (p) => (isAbsPath(p) ? p : (workDir() || S.home) + "/" + p.replace(/^\.[\\/]/, ""));

function renderItem(it, t) {
  if (it.type === "user") {
    const files = it.files || [];
    return h("div", { class: "msg-user-wrap" },
      files.length ? h("div", { class: "sent-files" }, ...files.map((f) => /^image\//.test(f.type) && S.previewBase
        ? h("button", { type: "button", class: "sent-img", title: f.name, onclick: () => openPreview(f.path) }, h("img", { src: previewUrl(f.path), alt: f.name }))
        : h("button", { type: "button", class: "file-chip", title: f.path, onclick: () => openPreview(f.path) }, icon("file", 13), h("span", {}, f.name)))) : null,
      it.text ? h("div", { class: "msg-user" + (it.steer ? " steer" : "") }, it.text) : null,
      it.cp && !it.steer && t?.cps?.some((c) => c.n === it.cp && c.pre)
        ? h("button", { class: "msg-rewind", type: "button", title: "Rewind the files to before this message", "aria-label": "Rewind the files to before this message",
          onclick: () => rewindDialog(t, `${it.cp}-pre`, `before “${shortTitle(it.text)}”`) }, icon("undo", 14)) : null,
      it.steer ? h("div", { class: "msg-tag" + (it.steer === "lost" ? " bad" : "") }, it.steer === "queued" ? "Sent while working · Claude reads it at its next step"
        : it.steer === "taken" ? "Sent while working · Claude has it" : "Sent while working · Claude didn't get it. Send it again.") : null,
      it.auto ? h("div", { class: "msg-tag" }, it.auto === "switch" ? "Sent by B5 Code on your other account" : it.auto === "queue" ? "Sent by B5 Code's overnight queue"
        : it.auto === "restart" ? "Sent by B5 Code after it restarted for an update"
          : it.auto === "automation" ? "Started by an automation" : "Sent by B5 Code when your usage limit reset") : null);
  }
  if (it.type === "recap") return recapCard(it);
  if (it.type === "cp") return cpLine(it, t);
  if (it.type === "rewind") return rewindLine(it, t);
  if (it.type === "limit") return limitCard(it, t);
  if (it.type === "note") return h("div", { class: "note", style: "text-align:center" }, it.text);
  if (it.type === "ai") {
    const el = h("div", { class: "msg-ai" + (it.live ? " live" : ""), html: md(it.text, !it.live) });
    linkFiles(el);
    for (const pre of el.querySelectorAll("pre.code")) {
      pre.append(h("button", { class: "copy", type: "button", onclick: () => copy(pre.querySelector("code").textContent) }, "Copy"));
    }
    return el;
  }
  if (it.type === "steps") {
    const open = S.open.has(it.key);
    const failed = it.steps.some((s) => s.state === "bad");
    return h("div", { class: "steps" + (open ? " open" : "") },
      h("button", { class: "steps-head", type: "button", "aria-expanded": String(open), onclick: () => toggle(it.key) },
        h("span", { class: "chev" }, icon("chevron", 13)),
        h("span", { class: "txt" }, stepsHeadline(it.steps)),
        failed ? h("span", { class: "mark bad", title: "A step failed" }, icon("x", 12)) : null),
      // A screenshot Claude took shows under the group, folded or not.
      ...it.steps.flatMap(stepPictures).map((src) => h("button", { type: "button", class: "step-img", title: src, onclick: () => openPreview(src) }, h("img", { src: previewUrl(stepPath(src)), alt: baseName(src), loading: "lazy" }))),
      open ? h("div", { class: "steps-body" }, ...it.steps.map((s) => {
        const sk = "step-" + s.id;
        const so = S.open.has(sk);
        return h("div", { class: "step" },
          h("button", { class: "step-line", type: "button", "aria-expanded": String(so), onclick: () => toggle(sk) },
            h("span", { class: "mark " + s.state }, s.state === "run" ? h("span", { class: "spinner", style: "width:10px;height:10px" }) : icon(s.state === "bad" ? "x" : "check", 12)),
            h("span", { class: "txt" }, s.summary),
            s.change ? counts(s.change) : null),
          so ? (s.change ? renderChange(s.change, s.state === "bad" ? s.result : "")
            : readImage(s) && s.state !== "bad" ? readImageCard(readImage(s))
            : h("pre", {}, [s.detail, s.result ? "\n\n" + s.result : ""].join(""))) : null);
      })) : null);
  }
  if (it.type === "ask") {
    const questions = questionsOf(it.tool, it.input);
    if (questions) return questionCard(t, it, questions);
    if (it.answer) {
      const yes = it.answer === "allow" || it.answer === "allow-edits";
      const label = { allow: "Allowed", "allow-edits": "Allowed, with edits allowed for this thread", deny: "Not allowed", expired: "Question closed" }[it.answer];
      return h("div", { class: "answered" }, h("span", { class: "mark " + (yes ? "ok" : "bad") }, icon(yes ? "check" : "x", 12)), `${label}: ${it.summary}`);
    }
    if (needsReview(it.tool)) return reviewCard(t, it);
    return h("div", { class: "ask", role: "group", "aria-label": "Claude is asking permission" },
      h("div", { class: "ask-top" }, h("span", { class: "needs" }), "Claude wants to"),
      h("div", { class: "ask-what" }, it.summary),
      it.change ? renderChange(it.change) : it.detail ? h("pre", {}, it.detail) : null,
      h("div", { class: "btns" },
        h("button", { class: "btn primary", type: "button", onclick: () => answer(t.id, it, "allow") }, "Allow once"),
        it.canAllowEdits ? h("button", { class: "btn", type: "button", onclick: () => answer(t.id, it, "allow-edits") }, "Allow edits in this thread") : null,
        h("button", { class: "btn quiet", type: "button", onclick: () => answer(t.id, it, "deny") }, "Don't allow")));
  }
  if (it.type === "artifact") return artifactCard(it);
  if (it.type === "checks") return checksCard(t, it);
  if (it.type === "error") return h("div", { class: it.text === "Stopped." ? "note" : "err" }, it.text);
  return h("div");
}

/**
 * The review step: something about to go out (a post, a shared file, an edited doc),
 * shown as what it says rather than JSON, with Send it and Don't send.
 */
function reviewCard(t, it) {
  const parts = toolParts(it.tool);
  let input = it.input;
  if (!input) try { input = JSON.parse(it.detail); } catch { input = null; }
  const fields = reviewFields(input);
  return h("div", { class: "ask review", role: "group", "aria-label": "Review before it goes out" },
    h("div", { class: "ask-top" }, h("span", { class: "needs" }), `Before it goes out · ${parts.service}`),
    h("div", { class: "ask-what" }, parts.action[0].toUpperCase() + parts.action.slice(1)),
    fields.length ? h("div", { class: "review-fields" }, ...fields.map((f) => f.long
      ? h("div", { class: "review-long" }, h("div", { class: "review-label" }, f.label), h("div", { class: "review-text" }, f.text))
      : h("div", { class: "review-row" }, h("span", { class: "review-label" }, f.label), h("span", {}, f.text))))
      : it.detail ? h("pre", {}, it.detail) : null,
    h("div", { class: "btns" },
      h("button", { class: "btn primary", type: "button", onclick: () => answer(t.id, it, "allow") }, "Send it"),
      h("button", { class: "btn quiet", type: "button", onclick: () => answer(t.id, it, "deny") }, "Don't send")));
}

/**
 * Checks B5 Code ran after a turn that edited files: each one passed or failed,
 * a failure's output on a click, Fix this (Claude gets only what failed) and Run again.
 * The first time, an offer to turn them on for the project.
 */
function checksCard(t, it) {
  if (it.status === "running") return h("div", { class: "checks running" }, h("span", { class: "spinner", style: "width:11px;height:11px" }), `Running checks: ${it.names.join(", ")}…`);
  if (it.status === "cancelled") return h("div", { class: "note" }, `Checks stopped: ${it.why || "a new turn began"}.`);
  // What a check really runs (a script's own commands), as shown before it's allowed to.
  const runsList = (runs) => h("div", { class: "checks-runs" }, ...runs.map((r) => h("div", {}, h("span", { class: "review-label" }, `${r.name} · ${r.command}`), h("pre", {}, r.runs || r.now))));
  if (it.status === "changed") {
    // Run since (approved here, or in the project's settings): no buttons after a reload.
    const seq = (x) => Number(String(x.key).split("-")[1]);
    const ranSince = feedOf(t.id).items.some((x) => x.type === "checks" && seq(x) > seq(it) && (x.status === "done" || x.status === "running"));
    if (ranSince && !it.answered) it.answered = "on";
    const go = async (yes) => {
      // Approves exactly what this card shows; if it changed since, a new card says so and these buttons stay.
      if (yes) try { await call("POST", `/api/threads/${t.id}/checks`, { approve: it.changed.map((c) => c.key) }); } catch (e) { toast(e.message); return; }
      it.answered = yes ? "on" : "off";
      render();
    };
    return h("div", { class: "checks checks-card warn" },
      h("div", { class: "checks-title" }, icon("x", 13), "A check's script changed"),
      h("p", {}, "Checks run without asking, so they wait while what they run is different from what you turned on. Look before you let it run:"),
      ...it.changed.map((c) => h("div", { class: "checks-runs" }, h("span", { class: "review-label" }, `${c.name} · ${c.command}`),
        c.was ? h("pre", { class: "was" }, c.was) : null, h("pre", {}, c.now))),
      it.answered ? h("p", { class: "set-desc" }, it.answered === "on" ? "Allowed: it runs from now on." : "Not run.")
        : h("div", { class: "btns" },
          h("button", { class: "btn small primary", type: "button", onclick: () => go(true) }, "Run it"),
          h("button", { class: "btn small quiet", type: "button", onclick: () => go(false) }, "Not now")));
  }
  if (it.status === "offer") {
    const p = S.projects.find((x) => x.id === it.projectId);
    const turnOn = async (on) => {
      try {
        await call("POST", `/api/projects/${it.projectId}`, { checksOn: on });
        if (p) p.checksOn = on;
        // On: approves exactly what this card shows them running.
        if (on) await call("POST", `/api/threads/${t.id}/checks`, { approve: it.runs.map((r) => r.runs) });
      } catch (e) { toast(e.message); return; }
      it.answered = on ? "on" : "off";
      render();
    };
    // Answered already (here, or in the project's settings): no buttons after a reload.
    const answered = it.answered || (p?.checksOn === true ? "on" : p?.checksOn === false ? "off" : "");
    return h("div", { class: "checks checks-card" },
      h("div", { class: "checks-title" }, icon("check", 13), "Free checks after each change"),
      h("p", {}, `B5 Code can run ${p?.name || "this project"}'s ${it.checks.map((c) => c.name.toLowerCase()).join(", ")} itself whenever Claude edits files: no tokens, and you see at once if something broke. They run:`),
      runsList(it.runs.length ? it.runs : it.checks.map((c) => ({ ...c, runs: c.command }))),
      answered ? h("p", { class: "set-desc" }, answered === "on" ? "On. Change them in the project's settings." : "Off. Turn them on any time in the project's settings.")
        : h("div", { class: "btns" },
          h("button", { class: "btn small primary", type: "button", onclick: () => turnOn(true) }, "Turn on"),
          h("button", { class: "btn small quiet", type: "button", onclick: () => turnOn(false) }, "Not now")));
  }
  const results = it.results || [];
  const key = it.key;
  const open = S.open.has(key);
  const bad = results.filter((r) => !r.ok);
  return h("div", { class: "checks" + (bad.length ? " bad" : "") },
    h("div", { class: "checks-row" },
      h("span", { class: "checks-label" }, "Checks"),
      ...results.map((r) => h("button", { type: "button", class: "chip " + (r.ok ? "good" : "bad"), title: `${r.command} · ${Math.round(r.ms / 1000)}s` + (r.ok ? "" : " · click for its output"),
        onclick: () => (r.ok ? null : toggle(key)) }, icon(r.ok ? "check" : "x", 11), h("span", { class: "chip-text" }, `${r.name} · ${r.summary}`))),
      bad.length && it.fix && !feedOf(t.id).working ? h("button", { class: "btn small primary", type: "button", title: "Send Claude only what failed", onclick: () => sendStep(t, it.fix) }, "Fix this") : null,
      h("button", { class: "icon", type: "button", title: "Run them again", "aria-label": "Run the checks again", onclick: () => call("POST", `/api/threads/${t.id}/checks`).catch((e) => toast(e.message)) }, icon("refresh", 13))),
    open ? bad.map((r) => h("div", { class: "checks-out" }, h("div", { class: "review-label" }, `${r.name} · ${r.command}`), h("pre", {}, r.tail || "(no output)"))) : null);
}

function toggle(key) {
  if (S.open.has(key)) S.open.delete(key); else S.open.add(key);
  S.stick = false;
  render();
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied"); } catch { toast("Couldn't copy"); }
}

// ── Claude's questions ───────────────────────────────────────────────────────
// Its AskUserQuestion tool, as a card: each question with its options (one, or several when it
// says so) and room for your own answer (web/questions.js). Built once per question and kept,
// so a redraw never loses what you picked or are typing.

const questionCards = new Map(); // requestId -> the card, while it's open

function questionCard(t, it, questions) {
  if (it.answer) {
    questionCards.delete(it.requestId);
    const skipped = it.answer === "deny" || it.answer === "expired";
    return h("div", { class: "answered q-answered" },
      h("span", { class: "mark " + (skipped ? "bad" : "ok") }, icon(skipped ? "x" : "check", 12)),
      h("span", {}, skipped ? (it.answer === "expired" ? "Question closed" : "Skipped") + `: ${it.summary}`
        : questions.map((q, i) => [i ? h("br") : null, h("span", { class: "q-a-q" }, q.header || q.question), " ", h("b", {}, it.answers?.[q.question] || "")]).flat()));
  }
  const have = questionCards.get(it.requestId);
  if (have) return have;
  const picks = questions.map(() => ({ chosen: [], other: "" }));
  const send = h("button", { class: "btn primary", type: "button", disabled: true }, questions.length > 1 ? "Send answers" : "Send answer");
  const ready = () => { send.disabled = !answersFrom(questions, picks); };
  const blocks = questions.map((q, i) => {
    const rows = [];
    const draw = () => rows.forEach((r) => { const on = picks[i].chosen.includes(r.dataset.label); r.classList.toggle("on", on); r.setAttribute("aria-checked", String(on)); });
    const other = h("input", { class: "q-other", type: "text", placeholder: "Something else…", "aria-label": `Your own answer: ${q.question}`, maxlength: "2000",
      oninput: () => { picks[i].other = other.value; if (!q.multiSelect && other.value.trim()) { picks[i].chosen = []; draw(); } ready(); },
      onkeydown: (e) => { if (e.key === "Enter" && !send.disabled) { e.preventDefault(); send.click(); } } });
    for (const o of q.options) {
      const row = h("button", { class: "q-opt" + (q.multiSelect ? " multi" : ""), type: "button", role: q.multiSelect ? "checkbox" : "radio", "aria-checked": "false", "data-label": o.label,
        onclick: () => {
          const c = picks[i].chosen;
          if (q.multiSelect) picks[i].chosen = c.includes(o.label) ? c.filter((l) => l !== o.label) : [...c, o.label];
          else { picks[i].chosen = [o.label]; picks[i].other = ""; other.value = ""; }
          draw(); ready();
        } },
        h("span", { class: "q-tick" }, icon("check", 11)),
        h("span", { class: "q-text" }, h("span", { class: "q-label" }, o.label), o.description ? h("span", { class: "q-desc" }, o.description) : null));
      rows.push(row);
    }
    return h("div", { class: "q-block", role: q.multiSelect ? "group" : "radiogroup", "aria-label": q.question },
      q.header ? h("span", { class: "q-header" }, q.header) : null,
      h("div", { class: "ask-what" }, q.question),
      q.multiSelect ? h("div", { class: "q-hint" }, "Pick any that fit") : null,
      h("div", { class: "q-opts" }, ...rows, other));
  });
  send.onclick = async () => {
    const answers = answersFrom(questions, picks);
    if (!answers) return;
    send.disabled = true;
    try { await call("POST", `/api/threads/${t.id}/permission`, { requestId: it.requestId, choice: "allow", answers }); }
    catch (e) { toast(e.message); ready(); }
  };
  const card = h("div", { class: "ask q-card", role: "group", "aria-label": "Claude has a question" },
    h("div", { class: "ask-top" }, h("span", { class: "needs" }), questions.length > 1 ? `Claude has ${questions.length} questions` : "Claude has a question"),
    ...blocks,
    h("div", { class: "btns" }, send, h("button", { class: "btn quiet", type: "button", onclick: () => answer(t.id, it, "deny") }, "Skip")));
  questionCards.set(it.requestId, card);
  return card;
}

async function answer(threadId, it, choice) {
  try {
    await call("POST", `/api/threads/${threadId}/permission`, { requestId: it.requestId, choice });
  } catch (e) {
    toast(e.message);
    apply(feedOf(threadId), { kind: "permission_closed", requestId: it.requestId });
    render();
  }
}

// ── Composer ─────────────────────────────────────────────────────────────────

function buildComposer() {
  const ta = h("textarea", { id: "input", rows: "1", placeholder: "Ask Claude, or / for skills", "aria-label": "Message" });
  ta.addEventListener("input", onInput);
  ta.addEventListener("keydown", onKey);
  ta.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  const send = h("button", { class: "send", id: "send", type: "submit", title: "Send (Enter)", "aria-label": "Send" }, icon("up", 16));
  return h("div", { class: "composer-wrap" },
    h("div", { class: "todos tasks", id: "tasks", hidden: true }),
    h("div", { class: "todos", id: "todos", hidden: true }),
    h("form", { class: "composer", onsubmit: (e) => { e.preventDefault(); onSendButton(); },
      ondragover: (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) { e.preventDefault(); e.currentTarget.classList.add("drop"); } },
      ondragleave: (e) => e.currentTarget.classList.remove("drop"),
      ondrop: (e) => { e.currentTarget.classList.remove("drop"); if (e.dataTransfer?.files?.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } } },
      h("div", { class: "slash", id: "slash", hidden: true, role: "listbox", "aria-label": "Skills and commands" }),
      h("div", { class: "menu-pop", id: "plus-menu", hidden: true, role: "menu", "aria-label": "Add" }),
      h("div", { class: "offer", id: "answers-offer", hidden: true }),
      h("div", { class: "attach-row", id: "attach-row", hidden: true }),
      h("input", { type: "file", id: "file-input", multiple: true, hidden: true, onchange: (e) => { addFiles(e.target.files); e.target.value = ""; } }),
      ta,
      h("div", { class: "menu-pop", id: "model-menu", hidden: true, role: "menu", "aria-label": "Model" }),
      h("div", { class: "menu-pop", id: "effort-menu", hidden: true, role: "menu", "aria-label": "Effort" }),
      h("div", { class: "menu-pop wide", id: "cp-menu", hidden: true, role: "dialog", "aria-label": "Checkpoints" }),
      h("div", { class: "tools" },
        h("button", { class: "icon plus", id: "plus", type: "button", title: "Add photos, files and more", "aria-label": "Add", "aria-haspopup": "menu", onclick: togglePlusMenu }, icon("plus", 17)),
        h("button", { class: "chip", id: "model-chip", type: "button", title: "Model", "aria-haspopup": "menu", onclick: toggleModelMenu }),
        h("button", { class: "chip", id: "effort-chip", type: "button", "aria-haspopup": "menu", onclick: toggleEffortMenu }),
        h("button", { class: "chip", id: "cp-chip", type: "button", hidden: true, "aria-haspopup": "dialog", onclick: toggleCpMenu }),
        h("button", { class: "chip skills", type: "button", title: "Skills and commands", "aria-label": "Skills and commands", onclick: openSlash }, icon("slash", 13), h("span", {}, "Skills")),
        h("button", { class: "chip", id: "where-chip", type: "button", onclick: () => { if (!thread()) pickBranch(); } }),
        h("span", { class: "spacer" }),
        canDictate() ? h("button", { class: "icon mic", id: "mic", type: "button", title: "Dictate (speak your message)", "aria-label": "Dictate", "aria-pressed": "false", onclick: toggleDictation }, icon("mic", 16)) : null,
        send)),
    h("div", { class: "foot" }, h("span", { class: "keys" }, SET.sendKey === "enter" ? "Enter to send · Shift+Enter for a new line" : `${KEY()}Enter to send · Enter for a new line`),
      h("span", { class: "ctx", id: "ctx", hidden: true }),
      h("span", { class: "ctx acct", id: "acct", hidden: true, role: "button", tabindex: "0" }),
      h("div", { class: "menu-pop acct-menu", id: "acct-menu", hidden: true, role: "menu", "aria-label": "Account" })));
}

function updateComposer(feed) {
  const ta = $("input");
  if (!ta) return;
  const key = S.threadId || "new:" + S.projectId;
  if (ta.dataset.key !== key) {
    ta.dataset.key = key;
    ta.value = store.get("draft:" + key, "");
    grow(ta);
  }
  // How full this conversation is, as the CLI's context meter shows it.
  const ctx = $("ctx"), c = contextLabel(feed.context, feed.contextWindow);
  ctx.hidden = !c;
  if (c) {
    ctx.textContent = `${S.phone ? "" : " · "}${c.text}`;
    ctx.title = `${feed.context.toLocaleString()} of ${c.window.toLocaleString()} tokens. When it fills up, Claude Code compacts the conversation (or type /compact).`;
    ctx.classList.toggle("full", c.percent >= 80);
  }
  const p = project();
  const t = thread(), chip = $("where-chip");
  if (t?.branch) fill(chip, icon("branch", 13), h("span", {}, t.branch));
  else if (!t && S.newBranch) fill(chip, icon("branch", 13), h("span", {}, newBranchName()));
  else fill(chip, icon("folder", 13), h("span", {}, p ? p.name : ""));
  chip.classList.toggle("static", !!t);
  chip.title = t ? (t.branch ? `On its own branch, in ${home(t.dir)}` : `In ${p ? home(p.dir) : ""}`) : "Where this thread works: the project, or a new branch of its own";
  fill($("model-chip"), h("span", {}, currentModelName()), icon("chevronDown", 12));
  fillEffortChip();
  fillCpChip();
  sendButton(feed);
  renderTodos(feed);
  renderTasks(feed);
  accountChip(thread());
}

// While Claude works the button stops it, unless there's a message to send:
// then it sends, and the message steers the running turn.
function sendButton(feed = thread() ? feedOf(thread().id) : emptyFeed()) {
  const send = $("send");
  if (!send) return;
  const steer = feed.working && ($("input").value.trim() || S.attach.length);
  const stop = feed.working && !steer;
  send.classList.toggle("stop", stop);
  fill(send, icon(stop ? "stop" : "up", 16));
  send.title = stop ? "Stop (Esc)" : steer ? "Send now: Claude reads it at its next step" : "Send (Enter)";
  send.setAttribute("aria-label", stop ? "Stop" : "Send");
  $("input").placeholder = feed.working ? (narrow() ? "Steer Claude while it works" : "Steer Claude while it works, or Esc to stop") : thread()?.sideOf ? "Ask about the thread" : "Ask Claude, or / for skills";
}

// Claude's to-do list, pinned above the composer while there's work on it.
function renderTodos(feed) {
  const box = $("todos");
  if (!box) return;
  const todos = feed.todos || [];
  const p = todoProgress(todos);
  box.hidden = !todos.length || (p.finished && !feed.working);
  if (box.hidden) return;
  const open = S.todosOpen ?? feed.working; // folded while Claude isn't working, unless you open it
  const key = JSON.stringify([open, todos.map((t) => [t.text, t.status])]);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  fill(box, 
    h("button", { class: "todos-head", type: "button", "aria-expanded": String(open), onclick: () => { S.todosOpen = !open; renderTodos(feed); } },
      h("span", { class: "chev" + (open ? " open" : "") }, icon("chevron", 12)),
      h("span", { class: "todos-title" }, "To-do"),
      h("span", { class: "todos-now" }, p.now || (p.finished ? "All done" : "")),
      h("span", { class: "todos-count" }, `${p.done} of ${p.total}`)),
    ...(open ? [h("ol", { class: "todos-list" }, ...todos.map((t) => h("li", { class: t.status },
      h("span", { class: "todo-mark" }, t.status === "completed" ? icon("check", 12) : t.status === "in_progress" ? h("span", { class: "spinner", style: "width:10px;height:10px" }) : null),
      h("span", {}, t.text))))] : []));
}

// The commands and agents Claude has going in the background, above the composer
// while one runs; once they've all finished, until your next message.
function renderTasks(feed) {
  const box = $("tasks");
  if (!box) return;
  const tasks = feed.tasks || [];
  const p = tasksProgress(tasks);
  box.hidden = !tasks.length || (!p.running && !feed.working);
  if (box.hidden) return;
  const open = S.tasksOpen ?? true;
  const ran = (t) => elapsedLabel(((t.endedAt || Date.now()) - t.startedAt) / 1000);
  const key = JSON.stringify([open, tasks.map((t) => [t.text, t.status, t.now, t.tools, ran(t)])]);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  const count = p.running ? `${p.running} running` : p.failed ? `${p.failed} failed` : "Finished";
  fill(box, 
    h("button", { class: "todos-head", type: "button", "aria-expanded": String(open), onclick: () => { S.tasksOpen = !open; box.dataset.key = ""; renderTasks(feed); } },
      h("span", { class: "chev" + (open ? " open" : "") }, icon("chevron", 12)),
      h("span", { class: "todos-title" }, "Background"),
      h("span", { class: "todos-now" }, p.now),
      h("span", { class: "todos-count" }, count)),
    ...(open ? [h("ol", { class: "todos-list" }, ...tasks.map((t) => h("li", { class: "task " + t.status },
      h("span", { class: "todo-mark" }, t.status === "running" ? h("span", { class: "spinner", style: "width:10px;height:10px" }) : t.status === "completed" ? icon("check", 12) : icon("x", 11)),
      h("span", { class: "task-what" },
        h("span", { class: "task-kind" }, t.type),
        h("span", { class: "task-text" }, t.text),
        t.now ? h("span", { class: "task-now" }, t.now) : null,
        t.summary && t.status !== "completed" ? h("span", { class: "task-now" }, t.summary) : null),
      h("span", { class: "task-meta" }, [t.tools ? `${t.tools} tool${t.tools === 1 ? "" : "s"}` : "", t.status === "running" || t.status === "completed" ? ran(t) : t.status].filter(Boolean).join(" · ")))))] : []));
}

const recapKey = (it) => "recap-" + it.ms + "-" + it.steps + "-" + it.files.length;

/**
 * A turn's receipt: one line of what it did, then what came of it (tests,
 * commits, a push, a command that failed), opening to the files with how much
 * each changed and every command it ran.
 */
function recapCard(it) {
  const key = recapKey(it);
  const open = S.open.has(key);
  const ran = it.ran || [], commits = it.commits || [];
  const failed = ran.filter((c) => !c.ok);
  const trouble = failed.length > 0 || (it.tests && !it.tests.ok);
  const chips = [
    it.tests ? h("span", { class: "chip " + (it.tests.ok ? "good" : "bad"), title: "The turn's last test run" },
      icon(it.tests.ok ? "check" : "x", 11), testsLabel(it.tests),
      testsChange(it.tests, it.testsBefore) ? h("span", { class: "chip-delta" }, testsChange(it.tests, it.testsBefore)) : null) : null,
    ...commits.map((c) => h("button", { class: "chip", type: "button", title: `Committed on ${c.branch}: ${c.subject}`, onclick: () => showChange("") },
      icon("branch", 11), h("span", { class: "sha" }, c.sha), h("span", { class: "chip-text" }, c.subject))),
    it.pushed ? h("span", { class: "chip good" }, icon("up", 11), "Pushed") : null,
    failed.length ? h("span", { class: "chip bad" }, icon("x", 11), `${failed.length} command${failed.length === 1 ? "" : "s"} failed`) : null,
  ].filter(Boolean);
  const most = Math.max(1, ...it.files.map((f) => f.add + f.del));
  return h("div", { class: "recap" + (open ? " open" : "") + (trouble ? " trouble" : "") },
    h("button", { class: "recap-head", type: "button", "aria-expanded": String(open), disabled: !it.files.length && !ran.length, onclick: () => toggle(key) },
      icon(trouble ? "x" : "check", 13), h("span", {}, recapLine(it)), it.files.length || ran.length ? h("span", { class: "chev" }, icon("chevron", 12)) : null),
    chips.length ? h("div", { class: "recap-chips" }, ...chips) : null,
    open && it.files.length ? h("div", { class: "recap-files" }, h("div", { class: "recap-label" }, "Files"), ...it.files.map((f) => {
      const rel = workDir() && f.file.startsWith(workDir() + "/") ? f.file.slice(workDir().length + 1) : home(f.file);
      return h("button", { class: "file", type: "button", title: f.file, onclick: () => (canPreview(f.file) ? openPreview(f.file) : showChange(rel)) },
        h("span", { class: "path" }, rel), f.created ? h("span", { class: "note" }, "new") : null,
        f.add ? h("span", { class: "add-n" }, "+" + f.add) : null, f.del ? h("span", { class: "del-n" }, "−" + f.del) : null,
        // How big this file's change is beside the others: green for lines added, red for removed.
        h("span", { class: "size-bar", "aria-hidden": "true" },
          h("span", { class: "a", style: `width:${(f.add / most) * 100}%` }), h("span", { class: "d", style: `width:${(f.del / most) * 100}%` })));
    })) : null,
    open && ran.length ? h("div", { class: "recap-files" }, h("div", { class: "recap-label" }, "Commands"), ...ran.flatMap((c) => [
      h("div", { class: "ran" + (c.ok ? "" : " bad"), title: c.command },
        h("span", { class: "ran-mark" }, icon(c.ok ? "check" : "x", 11)), h("span", { class: "ran-what" }, c.summary), h("code", { class: "ran-cmd" }, c.command.split("\n")[0])),
      ...(c.output ? [h("pre", { class: "ran-out" }, c.output)] : []),
    ])) : null);
}

/** A file's uncommitted changes, in the Changes pane. */
function showChange(rel) {
  S.paneTab = "changes";
  if (!S.pane) { S.pane = true; store.set("pane", true); if (narrow()) pushLayer(); }
  S.studioPane = true;
  S.folded.delete(rel);
  loadChanges();
}

/** The card while a thread waits out its plan's usage limit. */
function limitCard(it, t) {
  if (it.state !== "waiting") {
    const said = { sent: "B5 Code carried on after the usage limit reset.", you: "You carried on yourself.", cancelled: "Not carrying on by itself.", replaced: "Usage limit reached.",
      failed: `B5 Code couldn't carry on${it.detail ? `: ${it.detail}` : "."}` }[it.state] || "";
    return h("div", { class: "answered" }, h("span", { class: "mark" }, icon("clock", 12)), said);
  }
  return h("div", { class: "ask limit-card", role: "group", "aria-label": "Usage limit" },
    h("div", { class: "ask-top" }, icon("clock", 14), "Usage limit reached"),
    h("div", { class: "ask-what" }, it.known ? `B5 Code carries on ${resumeLabel(it.resumeAt)}, a minute after your limit resets.` : `Claude Code didn't say when your limit resets, so B5 Code tries again ${resumeLabel(it.resumeAt)}.`),
    h("p", { class: "note", style: "margin:0" }, `It sends: “Your usage limit has reset. Carry on where you left off.” Keep B5 Code running until then; the ${MAC()} can sleep.`),
    h("div", { class: "btns" },
      h("button", { class: "btn", type: "button", onclick: () => resumeThread(t, "now") }, "Carry on now"),
      h("button", { class: "btn quiet", type: "button", onclick: () => resumeThread(t, "cancel") }, "Don't carry on")));
}

async function resumeThread(t, action) {
  try { await call("POST", `/api/threads/${t.id}/resume`, { action }); } catch (e) { toast(e.message); }
}

// ── Side chats ───────────────────────────────────────────────────────────────
// A copy of a thread's conversation to ask about it while it works, like
// /btw in Claude Code: the copy starts when its first message is sent
// (claude --resume … --fork-session), and hangs under the thread in the sidebar.

async function openSide(text = "") {
  const t = thread();
  if (!t || t.sideOf) return;
  try {
    const side = await call("POST", `/api/threads/${t.id}/side`, { text });
    S.threads.unshift(side);
    S.feeds.delete(side.id); // its first message may already be in; the log has it
    await openThread(side.id);
  } catch (e) { toast(e.message); }
}

// ── From the terminal ────────────────────────────────────────────────────────
// Conversations started with `claude` in a terminal in a project's folder can
// carry on here: the thread resumes the same session, with its history shown.

async function openImport(p) {
  const list = h("div", { class: "imp-list" }, h("p", { class: "note" }, "Looking in Claude Code's history…"));
  sheet(`Continue from the terminal`, [
    h("p", { class: "note", style: "margin:0 0 10px" }, `Conversations you started with claude in ${home(p.dir)}. One you pick carries on here as a thread, with what was said so far. Don't keep typing in it in the terminal too.`),
    list]);
  let r;
  try { r = await call("GET", `/api/projects/${p.id}/sessions`); } catch (e) { fill(list, h("p", { class: "err" }, e.message)); return; }
  if (!r.sessions.length) { fill(list, h("p", { class: "note" }, "None found that aren't already in B5 Code.")); return; }
  const mb = (n) => (n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
  fill(list, ...r.sessions.map((s) => h("div", { class: "imp-row" },
    h("span", { class: "imp-text" }, h("span", { class: "set-title" }, s.title || "Untitled"),
      h("span", { class: "set-desc" }, `${ago(s.at) === "now" ? "just now" : ago(s.at) + " ago"} · ${mb(s.size)}${s.title !== s.first ? " · " + s.first.slice(0, 90) : ""}`)),
    h("button", { class: "btn small", type: "button", onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true; b.textContent = "Bringing it in…";
      try {
        const t = await call("POST", `/api/projects/${p.id}/sessions`, { sessionId: s.id });
        document.querySelector(".imp-list")?.closest(".overlay")?.b5close?.();
        S.threads.unshift(t);
        S.feeds.delete(t.id);
        await openThread(t.id);
        toast("Carrying on here. The next message resumes it.");
      } catch (x) { toast(x.message); b.disabled = false; b.textContent = "Continue here"; }
    } }, "Continue here"))));
}

// ── Model ────────────────────────────────────────────────────────────────────

function chosenModel(t = thread()) {
  return t ? t.modelPref || null : newModel();
}

// A new thread's model: Chat has its own default (Settings › Chat); everywhere else the last one you picked.
function newModel() {
  return project()?.kind === "chat" ? SET.chatModel || null : S.newModel;
}

/** What a thread runs with no choice made: your Claude Code setting (opus[1m] is "Opus 5.5 (1M)"), or null. */
function settingModel() {
  const v = S.defaultModel || "";
  if (!v) return null;
  const base = v.replace(/\[1m\]$/i, "");
  const m = S.models.find((x) => x.value !== "default" && (x.value === base || x.model === base));
  return { value: m ? m.value : v, name: m ? m.name + (base !== v ? " (1M)" : "") : modelName(v) || v };
}

function currentModelName(t = thread()) {
  const pick = chosenModel(t);
  const m = pick && S.models.find((x) => x.value === pick);
  if (m) return m.name;
  if (pick) return modelName(pick) || pick;
  if (t?.model) return modelName(t.model);
  if (settingModel()) return settingModel().name;
  return S.models.find((x) => x.value === "default")?.name.replace(/\s*\(.*\)$/, "") || "Default";
}

// The models to offer for a thread: which one is ticked, every one, and the newest of each family.
function modelChoices(t = thread()) {
  // With no choice made, tick what the thread actually runs (your Claude
  // Code setting), not Claude Code's own "Default" entry, which may differ.
  const running = t?.model;
  const pick = chosenModel(t) || (running ? S.models.find((m) => m.value !== "default" && m.model === running.replace(/\[1m\]$/i, ""))?.value : settingModel()?.value) || "default";
  const all = S.models.length ? S.models : [{ value: "default", name: "Default", description: "Your Claude Code setting" }];
  // Claude Code lists every version; lead with the newest of each family.
  const seen = new Set();
  const latest = all.filter((m) => {
    const family = m.value === "default" ? "default" : m.name.split(" ")[0];
    if (seen.has(family)) return false;
    seen.add(family);
    return true;
  });
  return { pick, all, latest };
}

function toggleModelMenu() {
  const menu = $("model-menu");
  if (!menu.hidden) { menu.hidden = true; return; }
  const { pick, all, latest } = modelChoices();
  const showAll = menu.dataset.all === "1" || !latest.some((m) => m.value === pick);
  const list = showAll ? all : latest;
  fill(menu, ...list.map((m) => h("button", {
    type: "button", role: "menuitemradio", "aria-checked": String(m.value === pick), class: m.value === pick ? "on" : "",
    onclick: () => chooseModel(pickFor(m, all)),
  }, h("span", { class: "tick" }, m.value === pick ? icon("check", 14) : null),
  h("span", {}, h("div", { class: "m-name" }, m.name), h("div", { class: "m-desc" }, m.description)))));
  if (!S.models.length) menu.append(h("div", { class: "note", style: "padding:6px 10px" }, "More models appear after this project's first message."));
  else if (!showAll && all.length > latest.length) {
    menu.append(h("button", { type: "button", class: "more", onclick: (e) => { e.stopPropagation(); menu.dataset.all = "1"; menu.hidden = true; toggleModelMenu(); } },
      h("span", { class: "tick" }), h("span", { class: "m-desc" }, `Older models (${all.length - latest.length})`)));
  }
  menu.hidden = false;
  const close = (e) => { if (!menu.contains(e.target) && e.target !== $("model-chip") && !$("model-chip").contains(e.target)) { menu.hidden = true; document.removeEventListener("mousedown", close); } };
  document.addEventListener("mousedown", close);
}

// Claude Code's "Default" entry names a model (Sonnet 5.5, say), but running
// with no model at all means your own Claude Code setting, which may be
// another one (Opus). So choosing it chooses the model it names, by the same
// alias as that model's own entry, so the tick lands there.
function pickFor(m, all) {
  if (m.value !== "default") return m.value;
  if (!m.model) return null;
  return all.find((x) => x.value !== "default" && x.model === m.model)?.value || m.model;
}

async function chooseModel(value) {
  $("model-menu").hidden = true;
  const t = thread();
  if (t) {
    t.modelPref = value;
    try { await call("POST", `/api/threads/${t.id}/model`, { model: value }); } catch (e) { toast(e.message); }
  } else if (project()?.kind === "chat") {
    setSetting("chatModel", value);
    warmedKey = "";
    warm();
  } else {
    S.newModel = value;
    store.set("newModel", value);
    warmedKey = "";
    warm();
  }
  updateComposer(t ? feedOf(t.id) : emptyFeed());
  toast(`Model: ${currentModelName()}`);
}

// ── Effort ───────────────────────────────────────────────────────────────────
// How hard Claude thinks: passed to Claude Code as --effort when it starts, so a change applies from the next message.

const EFFORTS = [
  { id: "low", name: "Low", desc: "Quick and cheap. Renames, small fixes, questions." },
  { id: "medium", name: "Medium", desc: "A balance for everyday changes." },
  { id: "high", name: "High", desc: "Thinks it through. Good for most features and bugs." },
  { id: "xhigh", name: "Extra high", desc: "Slower. Tricky bugs and changes across many files." },
  { id: "max", name: "Max", desc: "As deep as it goes. Slowest, and uses the most of your plan." },
];
const effortOf = (id) => EFFORTS.find((x) => x.id === id) || null;
const currentEffort = (t = thread()) => (t ? t.effort || null : S.newEffort || null);
const effortBars = (id) => { const n = EFFORTS.findIndex((x) => x.id === id) + 1; return h("span", { class: "bars", "aria-hidden": "true" }, ...[1, 2, 3, 4, 5].map((i) => h("i", { class: i <= n ? "on" : "" }))); };

function fillEffortChip() {
  const chip = $("effort-chip");
  if (!chip) return;
  const e = effortOf(currentEffort());
  fill(chip, effortBars(e?.id), h("span", { class: "effort-name" }, e ? e.name : "Effort"));
  chip.title = e ? `Effort: ${e.name}. How hard Claude thinks.` : "Effort: how hard Claude thinks. Now your Claude Code setting.";
}

/** Put a menu above its chip, inside the composer (on a phone, across it). */
function placeMenu(menu, chip) {
  const room = menu.parentElement.clientWidth;
  menu.style.left = narrow() ? "0" : `${Math.max(0, Math.min(chip.offsetLeft - 6, room - Math.max(menu.offsetWidth, 340)))}px`;
}

/** Open one of the composer's menus (closing the others); it closes on a click anywhere else. */
function openMenu(id, chipId, draw) {
  for (const other of ["model-menu", "effort-menu", "cp-menu"]) if (other !== id) $(other).hidden = true;
  const menu = $(id), chip = $(chipId);
  if (!menu.hidden) { menu.hidden = true; return; }
  draw(menu);
  menu.hidden = false;
  placeMenu(menu, chip);
  const close = (e) => { if (!menu.contains(e.target) && !chip.contains(e.target)) { menu.hidden = true; document.removeEventListener("mousedown", close); } };
  document.addEventListener("mousedown", close);
}

function toggleEffortMenu() {
  openMenu("effort-menu", "effort-chip", (menu) => {
    const pick = currentEffort();
    fill(menu,
      h("button", { type: "button", role: "menuitemradio", "aria-checked": String(!pick), class: !pick ? "on" : "", onclick: () => chooseEffort(null) },
        h("span", { class: "tick" }, !pick ? icon("check", 14) : null),
        h("span", { class: "eff-bars" }),
        h("span", {}, h("div", { class: "m-name" }, "Default"), h("div", { class: "m-desc" }, "What your Claude Code setting says for the model"))),
      ...EFFORTS.map((e) => h("button", { type: "button", role: "menuitemradio", "aria-checked": String(e.id === pick), class: e.id === pick ? "on" : "", onclick: () => chooseEffort(e.id) },
        h("span", { class: "tick" }, e.id === pick ? icon("check", 14) : null),
        h("span", { class: "eff-bars" }, effortBars(e.id)),
        h("span", {}, h("div", { class: "m-name" }, e.name), h("div", { class: "m-desc" }, e.desc)))),
      h("div", { class: "menu-tip" }, "Applies from your next message. Higher effort takes longer and uses more of your plan."));
  });
}

async function chooseEffort(value) {
  $("effort-menu").hidden = true;
  const t = thread();
  if (t) {
    t.effort = value;
    try { await call("POST", `/api/threads/${t.id}/effort`, { effort: value }); } catch (e) { toast(e.message); }
  } else {
    S.newEffort = value;
    store.set("newEffort", value);
  }
  updateComposer(t ? feedOf(t.id) : emptyFeed());
  toast(value ? `Effort: ${effortOf(value).name}, from your next message` : "Effort: your Claude Code setting, from your next message");
}

// ── Checkpoints ──────────────────────────────────────────────────────────────
// The project's files, saved before and after each turn (server/checkpoints.js): a way back under each of
// your messages, a line after each turn that changed files, and a list under the box.

const shortTitle = (s) => { const x = String(s || "").replace(/\s+/g, " ").trim(); return x.length > 48 ? x.slice(0, 47) + "…" : x; };
const timeOfDay = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
const filesWord = (n) => `${n} file${n === 1 ? "" : "s"}`;

/** A live checkpoint event: the thread's own record of them is kept up to date (the server's is the same). */
function noteCheckpoints(threadId, ev) {
  const t = S.threads.find((x) => x.id === threadId);
  if (!t) return;
  if (ev.kind === "checkpoint") { t.cps = [...(t.cps || []), { n: ev.n, pre: true, at: ev.at || Date.now(), title: ev.title || "" }].slice(-40); t.cpHere = null; }
  else if (ev.kind === "checkpoint_done") t.cps = (t.cps || []).map((c) => (c.n === ev.n ? { ...c, post: true, files: ev.files, more: ev.more } : c));
  else if (ev.kind === "rewind") { t.cpHere = ev.to; t.cpUndos = [...(t.cpUndos || []), ev.undo].slice(-5); }
  else return;
  if (threadId === S.threadId) { fillCpChip(); scheduleRender(); }
}

/** The checkpoints you can go back to, newest first: after each turn that changed files, then the start. */
function cpEntries(t) {
  const cps = t?.cps || [];
  const out = [...cps].reverse().filter((c) => c.post).map((c) => ({ name: `${c.n}-post`, title: c.title, at: c.at, files: (c.files?.length || 0) + (c.more || 0), start: false }));
  const first = cps[0];
  if (first?.pre && out.length) out.push({ name: `${first.n}-pre`, title: first.title, at: first.at, files: 0, start: true });
  return out;
}
/** Where the files are: the checkpoint last gone back to, else after the latest turn. */
const cpNow = (t) => t?.cpHere || cpEntries(t).find((e) => !e.start)?.name || null;
const cpLabel = (e) => (e.start ? `before “${shortTitle(e.title)}”` : `after “${shortTitle(e.title)}”`);

function fillCpChip() {
  const chip = $("cp-chip");
  if (!chip) return;
  const t = thread(), list = t ? cpEntries(t) : [];
  chip.hidden = !list.length;
  if (list.length) {
    fill(chip, icon("clock", 13), h("span", { class: "cp-word" }, "Checkpoints"), h("span", { class: "cp-count" }, String(list.length)));
    chip.title = "Go back to how the files were before or after an earlier turn";
  }
}

function toggleCpMenu() {
  openMenu("cp-menu", "cp-chip", (menu) => {
    const t = thread(), here = cpNow(t);
    fill(menu,
      h("div", { class: "cp-head" }, "Checkpoints", h("span", {}, "Saved before and after each turn")),
      h("div", { class: "cp-list" }, ...cpEntries(t).map((e) => h("button", { type: "button", class: "cp-item" + (e.name === here ? " now" : ""),
        onclick: () => { menu.hidden = true; if (e.name === here) toast("Your files are already here"); else rewindDialog(t, e.name, cpLabel(e)); } },
      h("span", { class: "cp-node" }),
      h("span", { class: "cp-text" }, h("span", { class: "cp-t" }, e.start ? `Start: ${shortTitle(e.title)}` : shortTitle(e.title)),
        h("span", { class: "cp-s" }, [timeOfDay(e.at), e.start ? "before the first message" : filesWord(e.files), e.name === here ? "where your files are now" : ""].filter(Boolean).join(" · "))),
      e.name === here ? null : h("span", { class: "cp-go" }, "Go back")))));
  });
}

const CP_WORD = { A: ["restored", "ok"], D: ["removed", "bad"], M: ["reverted", "warn"] };

/** What going back would change, then the question. `name`: the checkpoint ("3-pre", "2-post"); `label`: how it's called. */
async function rewindDialog(t, name, label) {
  let r;
  try { r = await call("POST", `/api/threads/${t.id}/checkpoints/preview`, { to: name }); } catch (e) { return toast(e.message); }
  if (!r.count) return toast("Nothing to go back: the files are already like that");
  const before = name.endsWith("-pre");
  dialog(before ? "Rewind to before this message?" : "Go back to this checkpoint?", [
    h("p", { class: "note", style: "margin:0" }, `${filesWord(r.count)} will go back to how ${r.count === 1 ? "it was" : "they were"} ${label}.`),
    h("div", { class: "cp-files" }, ...r.files.map((f) => h("div", {}, h("span", { class: "cp-k " + (CP_WORD[f.s]?.[1] || "") }, CP_WORD[f.s]?.[0] || "changed"), h("code", {}, f.path))),
      r.count > r.files.length ? h("div", { class: "cp-more" }, `and ${r.count - r.files.length} more`) : null),
    h("p", { class: "note cp-safe", style: "margin:0" }, "Nothing is lost: how the files are now is saved first, so you can undo this. Claude is told the files went back. Its conversation stays as it is."),
  ], "Go back", async () => {
    const done = await call("POST", `/api/threads/${t.id}/checkpoints/restore`, { to: name, label });
    toast(`${filesWord(done.files)} went back`, { label: "Undo", run: () => undoRewind(t, done.undo) });
  });
}

async function undoRewind(t, undo) {
  try {
    await call("POST", `/api/threads/${t.id}/checkpoints/restore`, { to: undo, label: "how they were before you went back" });
    toast("Back where you were");
  } catch (e) { toast(e.message); }
}

/** The line after a turn that changed files: click to go back to how they were then. */
function cpLine(it, t) {
  const c = t?.cps?.find((x) => x.n === it.n);
  const here = !!t && t.cpHere === `${it.n}-post`;
  const total = it.files.length + it.more;
  return h("div", { class: "cp-line" + (here ? " here" : "") },
    h("button", { type: "button", title: "Go back to how the files were after this turn",
      onclick: () => { if (here) toast("Your files are already here"); else rewindDialog(t, `${it.n}-post`, `after “${shortTitle(c?.title || "this turn")}”`); } },
    icon("clock", 12), h("span", {}, `${here ? "Files are here" : "Checkpoint"} · ${filesWord(total)}${it.at ? " · " + timeOfDay(it.at) : ""}`)));
}

const canUndoRewind = (it, t) => !!it.undo && !!t?.cpUndos?.includes(it.undo) && t.cpUndos[t.cpUndos.length - 1] === it.undo && t.cpHere === it.to;

/** The line where files went back: what it was, and Undo while it's the latest. */
function rewindLine(it, t) {
  const total = it.files.length + it.more;
  return h("div", { class: "cp-line rewound" },
    h("span", { class: "cp-rw" }, icon("undo", 12), h("span", {}, `Files went back to ${it.label} · ${filesWord(total)}`)),
    canUndoRewind(it, t) ? h("button", { type: "button", class: "cp-undo", onclick: () => undoRewind(t, it.undo) }, "Undo") : null);
}

// ── Dictation ────────────────────────────────────────────────────────────────
// In the Mac app, the native side listens (Apple's speech recognition) and
// sends the words back through window.deskDictation. In a browser that has
// it, the Web Speech API does the same job.

const WebSpeech = window.SpeechRecognition || window.webkitSpeechRecognition;
// The Mac app listens itself; WebView2 has no speech recognition, so the Windows app has no dictation.
const canDictate = () => !!(macApp || (!winApp && WebSpeech && window.isSecureContext));
const dict = { on: false, base: "", rec: null };

function toggleDictation() {
  if (dict.on) return stopDictation();
  const ta = $("input");
  dict.base = ta.value && !/\s$/.test(ta.value) ? ta.value + " " : ta.value;
  dict.on = true;
  setMic(true);
  if (macApp) { macApp.postMessage({ type: "dictate", action: "start" }); return; }
  const rec = new WebSpeech();
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (e) => {
    let text = "";
    for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
    window.deskDictation({ text, state: "listening" });
  };
  rec.onerror = (e) => window.deskDictation({ state: "error", message: e.error });
  rec.onend = () => window.deskDictation({ state: "stopped" });
  dict.rec = rec;
  rec.start();
}

function stopDictation() {
  if (macApp) macApp.postMessage({ type: "dictate", action: "stop" });
  dict.rec?.stop();
  dict.on = false;
  setMic(false);
}

function setMic(on) {
  const b = $("mic");
  if (!b) return;
  b.classList.toggle("on", on);
  b.setAttribute("aria-pressed", String(on));
  b.title = on ? "Stop dictating" : "Dictate (speak your message)";
}

window.deskDictation = ({ text, state, message }) => {
  const ta = $("input");
  if (typeof text === "string" && ta) {
    ta.value = dict.base + text;
    grow(ta);
    saveDraft();
  }
  if (state === "stopped") { dict.on = false; setMic(false); focusComposer(); }
  if (state === "error") { dict.on = false; setMic(false); toast(message || "Dictation stopped."); }
};

// ── Plan answers ─────────────────────────────────────────────────────────────
// A plan page's "Copy my answers" (the Mac app sees the block arrive on the
// clipboard), or a page that hands its answers over with postMessage. Either
// way B5 Code only offers; you choose to put them in the message and send.

function offerAnswers(text, from) {
  const box = $("answers-offer");
  if (!box || !text) return;
  fill(box, 
    icon("check", 15),
    h("span", { class: "offer-text" }, `Plan answers copied${from ? ` from ${from}` : ""}`),
    h("button", { class: "btn primary", type: "button", onclick: () => {
      const ta = $("input");
      ta.value = ta.value.trim() ? ta.value.trimEnd() + "\n\n" + text : text;
      grow(ta); saveDraft(); warm();
      box.hidden = true;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    } }, "Put in message"),
    h("button", { class: "btn quiet", type: "button", onclick: () => { box.hidden = true; } }, "Not now"));
  box.hidden = false;
}

window.deskPlanAnswers = (text) => offerAnswers(text, S.preview ? baseName(S.preview) : "");

// A previewed page may hand its answers over itself. Only the preview
// server's pages are listened to, and only plain text is taken.
window.addEventListener("message", (e) => {
  if (!S.previewBase || new URL(S.previewBase).origin !== e.origin) return;
  const d = e.data;
  if (d && d.type === "b5:answers" && typeof d.text === "string" && d.text.length < 200000) offerAnswers(d.text, S.preview ? baseName(S.preview) : "");
});

// ── Attachments and the + menu ───────────────────────────────────────────────

function togglePlusMenu() {
  const menu = $("plus-menu");
  if (!menu.hidden) { menu.hidden = true; return; }
  const item = (ic, name, desc, fn) => h("button", { type: "button", role: "menuitem", onclick: () => { menu.hidden = true; fn(); } },
    h("span", { class: "tick" }, typeof ic === "string" ? icon(ic, 15) : ic), h("span", {}, h("div", { class: "m-name" }, name), h("div", { class: "m-desc" }, desc)));
  fill(menu, 
    item("paperclip", "Add photos & files", "Screenshots go in as images Claude can see", () => $("file-input").click()),
    item("slash", "Skills and commands", "Run a skill, like /flaevo-plan", openSlash),
    item("eye", "Open a file in Preview", "A plan page, screenshot, PDF or video", pickPreviewFile),
    // On a phone the row is full: effort and the checkpoints list are here instead of chips.
    narrow() ? item(effortBars(currentEffort()), `Effort: ${effortOf(currentEffort())?.name || "Default"}`, "How hard Claude thinks", toggleEffortMenu) : null,
    narrow() && thread() && cpEntries(thread()).length ? item("clock", "Checkpoints", "Go back to how the files were earlier", toggleCpMenu) : null);
  menu.hidden = false;
  const close = (e) => { if (!menu.contains(e.target) && !$("plus").contains(e.target)) { menu.hidden = true; document.removeEventListener("mousedown", close); } };
  document.addEventListener("mousedown", close);
}

async function addFiles(list) {
  for (const file of [...list].slice(0, 10 - S.attach.length)) {
    const a = { name: file.name || "pasted.png", type: file.type || "application/octet-stream", uploading: true,
      thumb: /^image\//.test(file.type) ? URL.createObjectURL(file) : null };
    S.attach.push(a);
    renderAttachments();
    try {
      const res = await fetch("/api/uploads", { method: "POST", headers: { "x-desk-token": TOKEN, "x-file-name": encodeURIComponent(a.name), "content-type": a.type }, body: file });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't add that file.");
      Object.assign(a, data, { uploading: false });
    } catch (e) {
      S.attach = S.attach.filter((x) => x !== a);
      toast(e.message);
    }
    renderAttachments();
  }
  warm();
  focusComposer();
}

function removeAttachment(a) {
  S.attach = S.attach.filter((x) => x !== a);
  if (a.thumb) URL.revokeObjectURL(a.thumb);
  renderAttachments();
}

function clearAttachments() {
  for (const a of S.attach) if (a.thumb) URL.revokeObjectURL(a.thumb);
  S.attach = [];
  renderAttachments();
}

function renderAttachments() {
  const row = $("attach-row");
  if (!row) return;
  row.hidden = !S.attach.length;
  fill(row, ...S.attach.map((a) => h("div", { class: "att" + (a.uploading ? " busy" : ""), title: a.name },
    a.thumb ? h("img", { src: a.thumb, alt: "" }) : h("span", { class: "att-ic" }, icon("file", 16)),
    a.thumb ? null : h("span", { class: "att-name" }, a.name),
    h("button", { type: "button", class: "att-x", "aria-label": `Remove ${a.name}`, onclick: () => removeAttachment(a) }, icon("x", 11)))));
}

function focusComposer() {
  requestAnimationFrame(() => $("input")?.focus());
}

function saveDraft() {
  const ta = $("input");
  if (ta && ta.dataset.key) store.set("draft:" + ta.dataset.key, ta.value);
}

function grow(ta) {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + "px";
}

function slashMatches(value) {
  const m = value.match(/^\/(\S*)$/);
  if (!m) return null;
  const q = m[1].toLowerCase();
  const own = thread() && !thread().sideOf && !(S.commands[S.projectId] || []).some((c) => c.name === "btw")
    ? [{ name: "btw", description: "Side chat: ask about this thread while it carries on", hint: "<question>" }] : [];
  return [...own, ...(S.commands[S.projectId] || [])]
    .filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
    .sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1))
    .slice(0, 40);
}

function openSlash() {
  const ta = $("input");
  if (!ta.value.startsWith("/")) ta.value = "/";
  ta.focus();
  renderSlash(ta.value);
  if (!S.slash.open) toast("Skills appear after this project's first message.");
}

function onInput(e) {
  warm();
  grow(e.target);
  saveDraft();
  renderSlash(e.target.value);
  sendButton();
}

function renderSlash(value) {
  const box = $("slash");
  const list = slashMatches(value);
  if (!list || !list.length) { box.hidden = true; S.slash.open = false; return; }
  S.slash.open = true;
  S.slash.index = Math.min(S.slash.index, list.length - 1);
  box.hidden = false;
  fill(box, ...list.map((c, i) => h("button", {
    type: "button", role: "option", "aria-selected": String(i === S.slash.index), class: i === S.slash.index ? "on" : "",
    onmousedown: (e) => { e.preventDefault(); pickSlash(c); },
  }, h("span", { class: "name" }, "/" + c.name), h("span", { class: "desc" }, c.description))));
  box.querySelector(".on")?.scrollIntoView({ block: "nearest" });
}

function pickSlash(c) {
  const ta = $("input");
  ta.value = "/" + c.name + " ";
  S.slash.index = 0;
  renderSlash(ta.value);
  ta.focus();
  grow(ta);
}

function onKey(e) {
  const ta = e.target;
  if (S.slash.open) {
    const list = slashMatches(ta.value) || [];
    if (e.key === "ArrowDown") { e.preventDefault(); S.slash.index = (S.slash.index + 1) % list.length; renderSlash(ta.value); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); S.slash.index = (S.slash.index - 1 + list.length) % list.length; renderSlash(ta.value); return; }
    if ((e.key === "Enter" || e.key === "Tab") && list[S.slash.index]) { e.preventDefault(); pickSlash(list[S.slash.index]); return; }
    if (e.key === "Escape") { e.preventDefault(); $("slash").hidden = true; S.slash.open = false; return; }
  }
  const wantsSend = SET.sendKey === "enter" ? !e.shiftKey && !e.metaKey : e.metaKey || e.ctrlKey;
  if (e.key === "Enter" && wantsSend && !e.isComposing) { e.preventDefault(); sendMessage(); }
}

function onSendButton() {
  const t = thread();
  if (t && feedOf(t.id).working && !$("input").value.trim() && !S.attach.length) stop(); else sendMessage();
}

let sendingNow = false; // a second Enter while the first send is on its way does nothing
async function sendMessage() {
  if (sendingNow) return;
  sendingNow = true;
  try { await sendNow(); } finally { sendingNow = false; }
}

async function sendNow() {
  if (dict.on) stopDictation();
  const ta = $("input");
  const text = ta.value.trim();
  if (S.attach.some((a) => a.uploading)) return toast("Still adding a file. One moment.");
  const attachments = S.attach.filter((a) => a.path).map(({ path, name, type }) => ({ path, name, type }));
  if (!text && !attachments.length) return;
  let t = thread();
  if (!S.projectId) return addProjectDialog();
  // /btw <question>: a side chat about this thread, as in Claude Code.
  const btw = /^\/btw(?:\s+([\s\S]*))?$/.exec(text);
  if (btw && t && !t.sideOf) {
    ta.value = "";
    grow(ta);
    store.set("draft:" + ta.dataset.key, "");
    $("slash").hidden = true;
    S.slash.open = false;
    return openSide((btw[1] || "").trim());
  }
  const draftKey = ta.dataset.key;
  ta.value = "";
  grow(ta);
  store.set("draft:" + draftKey, "");
  $("slash").hidden = true;
  S.slash.open = false;
  S.stick = true;
  try {
    if (!t) {
      if (S.newBranch) toast(`Making the branch ${newBranchName()}…`);
      t = await call("POST", "/api/threads", { projectId: S.projectId, model: newModel(), effort: S.newEffort, branch: S.newBranch });
      S.newBranch = null;
      S.threads.unshift(t);
      S.feeds.set(t.id, emptyFeed());
      S.threadId = t.id;
      store.set("thread", t.id);
      ta.dataset.key = t.id;
    }
    await call("POST", `/api/threads/${t.id}/send`, { text, attachments });
    clearAttachments();
    sendButton();
    // Your message comes back over the event stream. If it hasn't in a few seconds, the stream is
    // dead (a phone that slept): reload the thread, and reconnect.
    const sentTo = t.id;
    setTimeout(() => {
      const items = feedOf(sentTo).items;
      if (items.some((it) => it.type === "user" && it.text === text)) return;
      reconnect();
    }, 4000);
    if (t.title === "New thread" || (t.sideOf && t.title === "Side chat")) { await loadState(); render(); }
  } catch (e) {
    ta.value = text;
    grow(ta);
    toast(e.message);
  }
}

async function stop() {
  const t = thread();
  if (!t) return;
  try { await call("POST", `/api/threads/${t.id}/stop`); } catch (e) { toast(e.message); }
}

// ── Own branch and its PR ────────────────────────────────────────────────────
// A new thread can work on a branch of its own, in a worktree next to the
// project (server/branches.js). Its top bar then shows the PR: Open PR asks
// the thread's Claude to push and open it, filling the repo's template;
// Merge squash-merges once checks are green, after you say so; and once
// merged, the worktree can go.

const newBranchName = () => { try { return branchName(S.newBranch); } catch { return "new branch"; } };

function pickBranch() {
  const p = project();
  if (!p) return;
  const b = S.newBranch || { kind: "feat", issue: "", what: "" };
  const kind = h("select", { id: "bkind", "aria-label": "Kind" }, ...KINDS.map((k) => h("option", { value: k, selected: k === b.kind }, k)));
  const issue = h("input", { id: "bissue", placeholder: "12", inputmode: "numeric", autocomplete: "off", value: b.issue || "", style: "width:80px" });
  const what = h("input", { id: "bwhat", placeholder: "gpa goals", autocomplete: "off", spellcheck: "false", value: b.what || "" });
  const preview = h("p", { class: "branch-preview" });
  const show = () => {
    try {
      const name = branchName({ kind: kind.value, issue: issue.value, what: what.value });
      const dir = home(worktreeDir(p.dir, name));
      fill(preview, icon("branch", 13), h("b", {}, name), h("span", {}, ` from a fresh main, in ${dir}`));
    } catch (e) { fill(preview, h("span", { style: "color:var(--faint)" }, what.value ? e.message : "The branch name appears here.")); }
  };
  for (const el of [kind, issue, what]) el.addEventListener("input", show);
  show();
  const content = [
    h("p", { style: "margin:0 0 10px;color:var(--muted)" }, `This thread works in its own worktree, so ${p.name}'s checkout is never touched. The worktree is made when you send the first message.`),
    h("div", { class: "branch-fields" },
      h("div", {}, h("label", { for: "bkind" }, "Kind"), kind),
      h("div", {}, h("label", { for: "bissue" }, "Issue"), issue),
      h("div", { style: "flex:1" }, h("label", { for: "bwhat" }, "What it's for"), what)),
    preview,
  ];
  if (S.newBranch) content.push(h("button", { class: "btn quiet", type: "button", style: "margin-top:6px", onclick: (e) => { S.newBranch = null; e.target.closest(".overlay").remove(); render(); focusComposer(); } }, `Work in ${p.name} instead`));
  dialog("Work on a new branch", content, "Use this branch", async () => {
    const next = { kind: kind.value, issue: issue.value.trim(), what: what.value.trim() };
    branchName(next); // says what's wrong, in the dialog
    S.newBranch = next;
    render();
    focusComposer();
  });
  setTimeout(() => what.focus(), 0);
}

let prTimer = null;
async function loadPr(id) {
  const cur = S.pr[id] || {};
  S.pr[id] = { ...cur, loading: true };
  try {
    S.pr[id] = { ...(await call("GET", `/api/threads/${id}/pr`)), loading: false };
  } catch (e) {
    S.pr[id] = { ...cur, loading: false, error: e.message };
  }
  // Checks still running: look again in a minute.
  clearTimeout(prTimer);
  if (S.pr[id].pr?.checks.state === "pending" && S.pr[id].pr.state !== "merged") prTimer = setTimeout(() => { if (S.threadId === id) loadPr(id); }, 60000);
  if (S.threadId === id) render();
}

function renderPrBox(box, t) {
  if (!t?.branch) return fill(box);
  const st = S.pr[t.id];
  if (!st) { loadPr(t.id); return fill(box); }
  const pr = st.pr;
  const working = feedOf(t.id).working;
  const btn = (label, attrs) => h("button", { class: "btn small", type: "button", ...attrs }, label);
  const kids = [];
  if (st.error && !pr) kids.push(h("span", { class: "pr-note", title: st.error }, "PR status unavailable"), h("button", { class: "icon", type: "button", title: "Try again", "aria-label": "Refresh PR status", onclick: () => loadPr(t.id) }, icon("refresh", 13)));
  else if (!pr && st.loading && !st.prompt) kids.push(h("span", { class: "pr-note" }, "Checking PR…"));
  else if (!pr) {
    if (!st.removed) kids.push(btn("Open PR", { disabled: working || st.loading, title: working ? "Wait until this turn is done" : "Ask Claude to push this branch and open its PR, filling the template", onclick: () => openPr(t) }));
  } else {
    const c = pr.checks;
    const checks = { pass: ["ok", "Checks passed"], fail: ["bad", `${c.failed} failing`], pending: ["warn", "Checks running"], none: ["", "No checks"] }[c.state];
    kids.push(h("a", { class: "pr-link", href: pr.url, target: "_blank", rel: "noopener", title: pr.title }, icon("external", 12), `PR #${pr.number}`));
    if (pr.state === "merged") kids.push(h("span", { class: "pr-badge ok" }, "Merged"));
    else if (pr.state === "closed") kids.push(h("span", { class: "pr-badge" }, "Closed"));
    else {
      if (pr.state === "draft") kids.push(h("span", { class: "pr-badge" }, "Draft"));
      kids.push(h("button", { class: `pr-badge ${checks[0]}`, type: "button", title: (c.failing.length ? `Failing: ${c.failing.join(", ")}. ` : "") + "Click to check again", onclick: () => loadPr(t.id) }, st.loading ? "Checking…" : checks[1]));
      if (pr.conflicts) kids.push(h("span", { class: "pr-badge bad" }, "Conflicts"));
      kids.push(btn("Merge", { class: "btn small primary", disabled: !pr.canMerge || working, title: pr.canMerge ? "Squash-merge into main" : "Merging waits for green checks", onclick: () => mergePr(t, pr) }));
    }
    if (pr.state === "merged" && !st.removed) kids.push(btn("Remove worktree", { title: home(t.dir), onclick: () => removeWorktree(t) }));
  }
  if (st.removed) kids.push(h("span", { class: "pr-note" }, "Worktree removed"));
  fill(box, ...kids);
}

// ── Next steps ───────────────────────────────────────────────────────────────
// Under a finished turn: Commit, Push, Open PR, Merge (from where the folder
// stands in git), and a yes when Claude ended by offering something.

async function loadGit(id) {
  try { S.git[id] = await call("GET", `/api/threads/${id}/git`); } catch { S.git[id] = { git: false }; }
  if (S.threadId === id) scheduleRender();
}

function renderNextSteps(box, t, feed) {
  const steps = t ? stepsFor(t) : [];
  const key = JSON.stringify(steps.map((s) => [s.id, s.label, s.title]));
  box.hidden = !steps.length;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  fill(box, ...stepButtons(t, steps));
}

const doStep = (t, s) => (s.text ? sendStep(t, s.text) : s.id === "merge" ? mergeBranch(t) : s.id === "recipe" ? saveRecipe(t) : s.id === "build" ? buildIn(t) : s.id === "post" ? writePost(t) : null);
const stepButtons = (t, steps) => steps.map((s, i) => h("button", {
  type: "button", class: "btn small" + (i === 0 ? " primary" : ""), title: s.title, onclick: () => doStep(t, s),
}, s.label));

/** The next steps for a thread, as under its last turn (for ⌘K too). */
function stepsFor(t) {
  const feed = feedOf(t.id);
  const last = feed.items[feed.items.length - 1];
  const reply = [...feed.items].reverse().find((it) => it.type === "ai");
  const p = S.projects.find((x) => x.id === t.projectId);
  if (feed.working || feed.waiting || S.running[t.id] === "working" || !feed.items.length || last?.type === "user" || t.sideOf) return [];
  return nextSteps(S.git[t.id], { offer: !!reply && !reply.live && endsWithOffer(reply.text), recipe: p?.kind === "work",
    build: p?.kind === "work" && !!reply && S.projects.some((x) => x.kind !== "work"), post: shippedNow(t, feed) && S.projects.some((x) => x.kind === "work") });
}

/** The same steps at the top of the Changes pane, while the thread isn't working. */
function paneSteps() {
  const t = thread();
  if (!t || t.sideOf || feedOf(t.id).working || S.running[t.id] === "working") return [];
  const steps = nextSteps(S.git[t.id]);
  return steps.length ? [h("div", { class: "next-steps pane-steps" }, ...stepButtons(t, steps))] : [];
}

// ── Work space ───────────────────────────────────────────────────────────────
// Everyday work in ~/Documents/B5 Work: starters and your recipes on its
// new-thread screen, and Save as recipe after a task that went well.

async function startWork() {
  try {
    const p = await call("POST", "/api/work");
    await loadState();
    startNew(p.id);
  } catch (e) { toast(e.message); }
}

// [Brackets] are what to fill in: picking a task selects the first.
const WORK_STARTERS = [
  ["Revision notes", "Turn the lecture slides or PDF I attach into clear revision notes: the key ideas, definitions and likely exam questions. Save them as Markdown in Uni/Notes."],
  ["Research", "Research [topic] on the web and write a one-page summary with its sources. Save it in Research."],
  ["Spreadsheet", "Make an Excel spreadsheet of [what], with a total row and a chart. Save it in Sheets."],
  ["Document", "Write a Word document: [what it's for]. Save it in Documents."],
  ["Posts", "Draft three short posts about [what] for X, in my tone. Save them in Posts and show them here."],
  ["Tidy a folder", "Look through my [Downloads] folder and suggest how to organise it into subfolders. List every move and wait for my yes before moving anything."],
];

/** A new chat: a greeting for the time of day, like claude.ai. */
function chatHello() {
  const hr = new Date().getHours();
  return [
    h("h1", { class: "chat-hi" }, hr < 5 ? "Good evening" : hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening"),
    h("p", {}, `Ask anything. Chats are conversations: no project, no files. Web search is ${S.settings?.chatWeb === false ? "off" : "on"} (Settings › Chat).`),
  ];
}

function workHello(p) {
  const recipes = (S.recipes || []).filter((r) => r.projectId === p.id);
  const autos = (S.automations || []).filter((a) => a.projectId === p.id);
  const card = (label, text, extra = null) => h("div", { class: "work-card" },
    h("button", { type: "button", class: "work-pick", title: text, onclick: () => useTask(text) }, h("span", { class: "work-name" }, label), h("span", { class: "work-text" }, text)),
    extra);
  return [
    h("h1", {}, "What should we get done?"),
    h("p", {}, `Documents, research, spreadsheets and files, made in ${home(p.dir)}. Claude remembers how you like things in its CLAUDE.md. `,
      h("button", { type: "button", class: "link", onclick: () => openGuide("work") }, "How to use it")),
    h("div", { class: "work-head" }, "Automations",
      h("button", { type: "button", class: "btn small quiet", title: "A task that starts itself: on a schedule, or when files land in a folder", onclick: () => automationDialog(p) }, icon("plus", 12), "New")),
    autos.length ? h("div", { class: "autos" }, ...autos.map(automationRow))
      : h("p", { class: "work-note" }, "Tasks that start themselves: a brief every morning, or notes made from every PDF you drop in a folder. Your phone hears when each is done."),
    recipes.length ? h("div", { class: "work-head" }, "Your recipes") : null,
    recipes.length ? h("div", { class: "work-grid" }, ...recipes.map((r) => card(r.name, r.prompt, h("span", { class: "work-acts" },
      h("button", { type: "button", class: "icon", title: "Run it by itself: on a schedule, or when files land in a folder", "aria-label": `Automate ${r.name}`, onclick: () => automationDialog(p, { name: r.name, prompt: r.prompt }) }, icon("clock", 12)),
      h("button", { type: "button", class: "icon", title: "Delete this recipe", "aria-label": `Delete ${r.name}`, onclick: () => deleteRecipe(r) }, icon("x", 12)))))) : null,
    h("div", { class: "work-head" }, recipes.length ? "Or start from" : "Start from"),
    h("div", { class: "work-grid" }, ...WORK_STARTERS.map(([label, text]) => card(label, text))),
  ];
}

/** A task into the composer, its first [blank] selected so typing fills it. */
function useTask(text) {
  const ta = $("input");
  if (!ta) return;
  // What's there already (something shared from the phone) stays, under the task.
  const had = ta.value.trim();
  ta.value = had && !had.startsWith(text.trim()) ? `${text.trimEnd()}\n\n${had}` : text;
  grow(ta);
  ta.focus();
  const at = text.indexOf("[");
  const end = at < 0 ? -1 : text.indexOf("]", at);
  if (end > at) ta.setSelectionRange(at, end + 1); else ta.setSelectionRange(text.length, text.length);
  saveDraft();
}

/** Save as recipe: what this thread was first asked, named and kept for next time. */
function saveRecipe(t) {
  const first = feedOf(t.id).items.find((it) => it.type === "user" && !it.auto);
  const name = h("input", { id: "rname", value: t.title === "New thread" ? "" : t.title, placeholder: "Revision notes from slides" });
  const prompt = h("textarea", { id: "rprompt", rows: 6 }, first?.text || "");
  dialog("Save as recipe", [
    h("p", { class: "set-desc" }, "Next time, pick it on the Work space's new thread screen: it goes into the message box for you to add the new material. Put [brackets] round what changes each time."),
    h("label", { for: "rname" }, "Name"), name,
    h("label", { for: "rprompt" }, "What to ask Claude"), prompt,
  ], "Save recipe", async () => {
    await call("POST", "/api/recipes", { projectId: t.projectId, name: name.value.trim(), prompt: prompt.value });
    await loadState();
    toast("Recipe saved");
  });
}

/** An automation in the Work space's list: when it runs, its last run, and its controls. */
function automationRow(a) {
  const last = a.lastThreadId && S.threads.find((t) => t.id === a.lastThreadId);
  const when = a.enabled ? a.when + (a.next ? ` · next ${new Date(a.next).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "") : `${a.when} · off`;
  return h("div", { class: "auto-row" + (a.enabled ? "" : " off") },
    h("span", { class: "auto-icon" }, icon(a.trigger.type === "folder" ? "folder" : "clock", 14)),
    h("span", { class: "auto-what" },
      h("span", { class: "work-name" }, a.name),
      h("span", { class: "work-text" }, when),
      last ? h("button", { type: "button", class: "auto-last", onclick: () => openThread(last.id) }, `Last run ${ago(a.lastRun) === "now" ? "just now" : ago(a.lastRun) + " ago"}`) : null),
    h("button", { type: "button", class: "btn small", title: "Run it now", onclick: () => runAutomationNow(a) }, "Run now"),
    h("input", { type: "checkbox", class: "switch", "aria-label": `${a.name} on`, checked: a.enabled ? true : null, onchange: (e) => patchAutomation(a, { enabled: e.target.checked }) }),
    h("button", { type: "button", class: "icon", title: "Edit", "aria-label": `Edit ${a.name}`, onclick: () => automationDialog(project(), a) }, icon("settings", 13)));
}

async function patchAutomation(a, patch) {
  try { await call("PATCH", `/api/automations/${a.id}`, patch); } catch (e) { toast(e.message); }
}

async function runAutomationNow(a) {
  try {
    const r = await call("POST", `/api/automations/${a.id}/run`);
    await loadState();
    openThread(r.threadId);
  } catch (e) { toast(e.message); }
}

/** New automation, or edit one: what to ask, and when (a schedule, or a folder to watch). */
function automationDialog(p, a = {}) {
  const t = a.trigger || { type: "schedule", time: "07:30", days: [1, 2, 3, 4, 5] };
  const name = h("input", { id: "aname", value: a.name || "", placeholder: "Morning brief" });
  const prompt = h("textarea", { id: "aprompt", rows: 5, placeholder: "What Claude is asked each time" }, a.prompt || "");
  const presets = [["daily", "Every day", [0, 1, 2, 3, 4, 5, 6]], ["weekdays", "Weekdays", [1, 2, 3, 4, 5]], ["weekends", "Weekends", [0, 6]], ["sunday", "Sundays", [0]], ["folder", "When files land in a folder", null]];
  const now = t.type === "folder" ? "folder" : presets.find(([, , d]) => d && d.join() === t.days.join())?.[0] || "daily";
  const when = h("select", { id: "awhen" }, ...presets.map(([v, label]) => h("option", { value: v, selected: v === now ? true : null }, label)));
  const time = h("input", { id: "atime", type: "time", value: t.time || "07:30" });
  const dir = h("input", { id: "adir", value: t.type === "folder" ? home(t.path) : "", placeholder: "~/Downloads", autocomplete: "off", spellcheck: "false" });
  const browser = h("div", { class: "folder-browser", hidden: true });
  const take = (path) => { dir.value = home(path); browser.hidden = true; };
  window.deskPickedFolder = take;
  const choose = h("button", { class: "btn", type: "button", onclick: () => {
    if (native && window.deskFeatures?.includes("pickFolder")) native.postMessage({ type: "pickFolder" });
    else if (browser.hidden) browse(browser, dir.value.trim() || "~", take); else browser.hidden = true;
  } }, icon("folder", 14), "Choose…");
  const timeRow = h("div", {}, h("label", { for: "atime" }, "At"), time);
  const dirRow = h("div", {}, h("label", { for: "adir" }, "Folder to watch"), h("div", { class: "pick-row" }, dir, choose), browser,
    h("p", { class: "set-desc" }, "Each time files land there, Claude is sent this with their names. What's there already is left alone."));
  const show = () => { const f = when.value === "folder"; timeRow.hidden = f; dirRow.hidden = !f; };
  when.addEventListener("change", show);
  show();
  const remove = a.id ? h("button", { type: "button", class: "btn quiet danger", onclick: async () => {
    try { await call("DELETE", `/api/automations/${a.id}`); document.querySelector(".overlay")?.remove(); } catch (e) { toast(e.message); }
  } }, "Delete automation") : null;
  dialog(a.id ? "Edit automation" : "New automation", [
    h("label", { for: "aname" }, "Name"), name,
    h("label", { for: "aprompt" }, "What to ask Claude"), prompt,
    h("label", { for: "awhen" }, "When"), when, timeRow, dirRow, remove,
  ], a.id ? "Save" : "Create", async () => {
    const preset = presets.find(([v]) => v === when.value);
    const trigger = when.value === "folder" ? { type: "folder", path: dir.value.trim() } : { type: "schedule", time: time.value, days: preset[2] };
    const body = { name: name.value.trim(), prompt: prompt.value, trigger };
    if (a.id) await call("PATCH", `/api/automations/${a.id}`, body);
    else await call("POST", "/api/automations", { projectId: p.id, ...body });
    toast(a.id ? "Saved" : "Automation on");
  });
}

/**
 * What another app shared (kept by web/sw.js): a new chat in the Work space (or the
 * project you were in), the files attached and the link or text in the message box,
 * waiting for what to do with it.
 */
async function takeShared() {
  let cache;
  try { cache = await caches.open("b5-share"); } catch { return; }
  const metaRes = await cache.match("shared/meta");
  if (!metaRes) return;
  const meta = await metaRes.json();
  const files = [];
  for (let i = 0; i < meta.files; i++) {
    const r = await cache.match(`shared/file/${i}`);
    if (r) files.push(new File([await r.blob()], decodeURIComponent(r.headers.get("x-name") || `shared-${i + 1}`), { type: r.headers.get("content-type") || "" }));
  }
  for (const key of await cache.keys()) await cache.delete(key);
  // Anything can post a form to ./share (another site open in the phone's browser, too):
  // what came in is shown first, and only your tap starts a chat with it.
  const words0 = [meta.title, meta.text, meta.url].filter(Boolean).join("\n");
  const go = await new Promise((resolve) => dialog("Shared to B5 Code", [
    h("p", { class: "set-desc" }, "Check this is what you shared. It goes into a new Work chat for you to say what to do with it; nothing is sent until you send it."),
    words0 ? h("pre", { class: "review-text" }, words0.slice(0, 1200)) : null,
    files.length ? h("div", { class: "set-desc" }, `${files.length === 1 ? "File" : `${files.length} files`}: ${files.map((f) => f.name).join(", ")}`) : null,
  ].filter(Boolean), "Start a Work chat", () => resolve(true), () => resolve(false)));
  if (!go) return;
  const work = S.projects.find((p) => p.kind === "work");
  startNew(work?.id || S.projectId);
  const words = [meta.title && meta.title !== meta.text ? meta.title : "", meta.text, meta.url && !meta.text.includes(meta.url) ? meta.url : ""].filter(Boolean).join("\n");
  if (words) useTask(`${words}\n\n`);
  if (files.length) await addFiles(files);
  toast(files.length ? `Shared ${files.length === 1 ? "a file" : `${files.length} files`}: say what to do with ${files.length === 1 ? "it" : "them"}` : "Shared: say what to do with it");
}

// ── Work and code, handing over ──────────────────────────────────────────────
// Research done in the Work space becomes a code chat; shipped code becomes a
// post drafted in the Work space. Each opens a new chat with the message ready:
// you add to it, then send.

/** Whether this code chat just shipped: its PR merged, or its latest turn pushed to the main branch. */
function shippedNow(t, feed) {
  const g = S.git[t.id];
  if (!g?.git || project()?.kind === "work") return false;
  if (g.pr?.state === "merged") return true;
  const recap = [...feed.items].reverse().find((it) => it.type === "recap");
  return !!recap?.pushed && g.branch === g.main;
}

/** A new chat in `projectId` with `text` in its message box, ready to send. */
function newChatWith(projectId, text) {
  startNew(projectId);
  requestAnimationFrame(() => { const ta = $("input"); if (!ta) return; ta.value = text; grow(ta); ta.focus(); ta.setSelectionRange(0, 0); ta.scrollTop = 0; saveDraft(); });
}

/** The files a chat wrote or edited, by path. */
const chatFiles = (feed) => [...new Set(feed.items.flatMap((it) => it.steps || []).map((s) => s.change?.file).filter(Boolean))];

/** Build this in…: the Work chat's findings, as the brief for a code chat in the project you pick. */
function buildIn(t) {
  const feed = feedOf(t.id);
  const reply = [...feed.items].reverse().find((it) => it.type === "ai");
  const files = chatFiles(feed);
  const brief = [
    "Build this, from research done in my Work space:",
    "",
    String(reply?.text || "").trim().slice(0, 6000),
    ...(files.length ? ["", "Its files (read them for the detail):", ...files.map((f) => `- ${f}`)] : []),
    "",
    "Start by saying how you'd fit it into this project, then build it.",
  ].join("\n");
  const code = S.projects.filter((p) => p.kind !== "work");
  if (code.length === 1) return newChatWith(code[0].id, brief);
  const pick = h("select", { id: "bproj" }, ...code.map((p) => h("option", { value: p.id }, p.name)));
  dialog("Build this in…", [h("label", { for: "bproj" }, "Project"), pick,
    h("p", { class: "set-desc" }, "A new chat opens there with these findings in the message box. Add anything, then send.")],
  "Open chat", () => newChatWith(pick.value, brief));
}

/** Write the post: what this code chat shipped, as a release post drafted in the Work space. */
function writePost(t) {
  const g = S.git[t.id] || {};
  const feed = feedOf(t.id);
  const commits = feed.items.filter((it) => it.type === "recap").flatMap((r) => r.commits || []).slice(-8);
  const what = g.pr?.state === "merged" ? `PR #${g.pr.number}${g.pr.title ? `, "${g.pr.title}"` : ""}` : "the latest work";
  const brief = [
    `Write a short release post for X about what just shipped in ${project()?.name || "the project"}: ${what}.`,
    ...(commits.length ? ["", "What changed:", ...commits.map((c) => `- ${c.subject}`)] : []),
    "",
    "Say what's new for people who use it, not how it was built. In my tone. Save a draft in Posts and show it here.",
  ].join("\n");
  newChatWith(S.projects.find((p) => p.kind === "work").id, brief);
}

// ── ⌘K ───────────────────────────────────────────────────────────────────────
// One box for everything: chats, actions, this chat's next steps, models,
// recipes, automations and the project's files (ranking: web/palette.js).

function paletteItems() {
  const t = thread();
  const p = project();
  const work = S.projects.find((x) => x.kind === "work");
  const item = (group, label, run, extra = {}) => ({ group, label, run, ...extra });
  const pane = (tab, label) => item("Actions", `Show ${label}`, () => { S.pane = true; S.studioPane = true; store.set("pane", true); S.paneTab = tab; render(); }, { keywords: "pane tab side" });
  return [
    ...(t ? stepsFor(t).map((s) => item("This chat", s.label, () => doStep(t, s), { keywords: s.title, top: true, weight: 30 })) : []),
    item("Actions", "New chat", () => startNew(), { keywords: `thread start ${KEY()}N`, top: true, weight: 20, hint: `${KEY()}N` }),
    ...(work ? [item("Actions", "New Work chat", () => startNew(work.id), { keywords: "work document research", top: true, weight: 15 })]
      : S.phone ? [] : [item("Actions", "Start a Work space", startWork, { keywords: "work cowork documents" })]),
    ...S.projects.filter((x) => x.id !== p?.id).map((x) => item("Actions", `New chat in ${x.name}`, () => startNew(x.id), { keywords: "thread project" })),
    item("Go to", "Waiting for you", openInbox, { keywords: "inbox questions finished", top: true, weight: 8 }),
    item("Go to", "GitHub", openGithub, { keywords: "pull requests prs issues reviews" }),
    ...(WIN() ? [] : [item("Go to", "Studio", openStudio, { keywords: "video editor b5 studio animation film remotion" })]),
    ...(WIN() ? [] : [item("Go to", "Overnight queue", openQueue, { keywords: "night tasks later" })]),
    item("Go to", "Guide", () => openGuide(), { keywords: "help how to tips shortcuts", top: true, hint: `${KEY()}/` }),
    item("Go to", "Settings", openSettings, { keywords: "preferences options accounts phone", hint: `${KEY()},` }),
    item("Actions", S.sideHidden ? "Show the sidebar" : "Hide the sidebar", toggleSidebar, { hint: `${KEY()}\\` }),
    item("Actions", S.pane ? "Hide the side pane" : "Show the side pane", togglePane, { keywords: "panel changes files" }),
    ...(p?.kind === "work" ? [] : [pane("changes", "changes")]), pane("files", "files"), pane("preview", "preview"), ...(S.phone ? [] : [pane("terminal", "terminal")]),
    ...(S.models || []).filter((m) => m.value !== "default").slice(0, 8).map((m) => item("Model", `Use ${m.name}`, () => chooseModel(m.value), { keywords: `model ${m.description}` })),
    ...(S.recipes || []).map((r) => item("Recipes", r.name, () => { startNew(r.projectId); requestAnimationFrame(() => useTask(r.prompt)); }, { keywords: `recipe ${r.prompt}` })),
    ...(S.automations || []).map((a) => item("Automations", `Run ${a.name} now`, () => runAutomationNow(a), { keywords: `automation ${a.when}` })),
    ...(update.need ? [item("Actions", update.need === "restart" ? "Restart into the update" : "Reload the page", update.need === "restart" ? restartNow : () => location.reload(), { keywords: "update new version", weight: 5 })] : []),
    ...[...S.threads].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map((x) => item("Chats", x.title, () => openThread(x.id),
      { keywords: S.projects.find((y) => y.id === x.projectId)?.name || "", hint: S.projects.find((y) => y.id === x.projectId)?.name || "", weight: -5 })),
  ];
}

function openPalette() {
  if (document.querySelector(".palette")) return;
  const items = paletteItems();
  const t = thread();
  const where = !S.phone && (t || S.projectId) ? { project: S.projectId, thread: t?.id || "" } : null;
  let shown = [], pick = 0, files = [], asked = 0, timer = 0;
  const input = h("input", { class: "palette-input", placeholder: "Type a chat, an action, a file…", "aria-label": "Search everything", autocomplete: "off", spellcheck: "false" });
  const list = h("div", { class: "palette-list", role: "listbox" });
  const close = () => { ov.remove(); document.removeEventListener("keydown", keys, true); };
  const run = (it) => { close(); it?.run(); };
  const draw = () => {
    const ranked = [...rankItems(items, input.value), ...files].slice(0, 60);
    // One heading per kind, the kinds in the order of their best match.
    shown = [...new Set(ranked.map((it) => it.group))].flatMap((g) => ranked.filter((it) => it.group === g));
    pick = Math.min(pick, Math.max(0, shown.length - 1));
    let group = "";
    fill(list, ...(shown.length ? shown.flatMap((it, i) => {
      const head = it.group !== group ? [h("div", { class: "palette-group" }, (group = it.group))] : [];
      return [...head, h("button", { type: "button", role: "option", class: "palette-item" + (i === pick ? " on" : ""), "aria-selected": String(i === pick),
        onmousemove: () => { if (pick !== i) { pick = i; draw(); } }, onclick: () => run(it) },
      h("span", { class: "palette-label" }, it.label), it.hint ? h("span", { class: "palette-hint" }, it.hint) : null)];
    }) : [h("div", { class: "palette-empty" }, "Nothing matches.")]));
    list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  };
  // Files, from the project's folder: asked for as you type.
  const findFiles = () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!where || q.length < 2) { files = []; return; }
    timer = setTimeout(async () => {
      const n = ++asked;
      try {
        const r = await call("GET", `/api/files/find?project=${encodeURIComponent(where.project)}&thread=${encodeURIComponent(where.thread)}&q=${encodeURIComponent(q)}`);
        if (n !== asked) return;
        files = r.files.slice(0, 8).map((f) => ({ group: "Files", label: f, run: () => { S.pane = true; store.set("pane", true); openPreview(workDir() + "/" + f); } }));
        draw();
      } catch { /* files are a bonus */ }
    }, 150);
  };
  input.addEventListener("input", () => { pick = 0; files = []; draw(); findFiles(); });
  const keys = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); pick = Math.min(pick + 1, shown.length - 1); draw(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); pick = Math.max(pick - 1, 0); draw(); }
    else if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); run(shown[pick]); }
  };
  document.addEventListener("keydown", keys, true);
  const ov = h("div", { class: "overlay palette-overlay", onclick: (e) => { if (e.target === ov) close(); } },
    h("div", { class: "palette", role: "dialog", "aria-modal": "true", "aria-label": "Search everything" }, input, list,
      h("div", { class: "palette-foot" }, "↑↓ to move · Enter to open · Esc to close")));
  document.body.append(ov);
  draw();
  input.focus();
}

let stateTimer = 0;
function reloadStateSoon() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => loadState().then(scheduleRender).catch(() => {}), 400);
}

async function deleteRecipe(r) {
  try { await call("DELETE", `/api/recipes/${r.id}`); await loadState(); render(); } catch (e) { toast(e.message); }
}

/** A step for Claude: sent as your message, so you see exactly what it was asked. Your draft stays in the composer. */
function sendStep(t, text) {
  S.stick = true;
  call("POST", `/api/threads/${t.id}/send`, { text }).catch((e) => toast(e.message));
}

function mergeBranch(t) {
  const g = S.git[t.id];
  if (!g?.pr) return;
  dialog(`Merge PR #${g.pr.number}?`, [h("p", {}, `Squash-merges ${g.branch} into ${g.main} on GitHub.`)], "Merge", async () => {
    try { await call("POST", `/api/threads/${t.id}/merge-branch`); toast(`Merged PR #${g.pr.number}`); } catch (e) { toast(e.message); }
    loadGit(t.id);
  });
}

/** Open PR: the request goes into the thread as your message, so you see exactly what Claude was asked. */
function openPr(t) {
  const st = S.pr[t.id];
  if (!st?.prompt) return;
  // Sent on its own: whatever you were typing stays in the composer.
  S.stick = true;
  call("POST", `/api/threads/${t.id}/send`, { text: st.prompt }).catch((e) => toast(e.message));
}

function mergePr(t, pr) {
  dialog(`Merge PR #${pr.number}?`, [
    h("p", { style: "margin:0" }, `Squash-merges “${pr.title}” into main on GitHub. Anything that deploys from main will ship.`),
  ], "Squash-merge", async () => {
    const r = await call("POST", `/api/threads/${t.id}/merge`);
    S.pr[t.id] = { ...S.pr[t.id], pr: r.pr };
    render();
  });
}

function removeWorktree(t) {
  dialog("Remove the worktree?", [
    h("p", { style: "margin:0" }, `Deletes ${home(t.dir)} and the local branch ${t.branch}. The PR is merged, so the work is in main. The conversation stays, but this thread can't carry on.`),
  ], "Remove", async () => {
    await call("DELETE", `/api/threads/${t.id}/worktree`);
    S.pr[t.id] = { ...S.pr[t.id], removed: true };
    render();
    loadChanges();
  });
}

// ── Updates ──────────────────────────────────────────────────────────────────
// The server's code changed since it started: offer a restart. Only the
// page's files changed: offer a reload. The restart is refused while a
// thread works; the page then waits for the new server and reloads.

const update = { need: null, restarting: false, note: "" };

async function checkUpdate() {
  if (update.restarting) return;
  let v;
  try { v = await call("GET", "/api/version"); } catch { return; }
  update.need = v.stale ? "restart" : PAGE_PRINT && v.page !== PAGE_PRINT ? "reload" : null;
  update.running = v.running || [];
  update.auto = !!v.autoUpdate;
  if (!update.need) update.note = "";
  // A page-only update, while you aren't looking at it: reloaded for you (drafts are kept).
  if (update.need === "reload" && document.hidden) { saveDraft(); location.reload(); return; }
  renderUpdate();
}
document.addEventListener("visibilitychange", () => { if (document.hidden && update.need === "reload") { saveDraft(); location.reload(); } });

function renderUpdate() {
  document.querySelector(".update-bar")?.remove();
  if (!update.need) return;
  const restart = update.need === "restart";
  const action = update.restarting ? h("span", { class: "spinner", style: "width:12px;height:12px" })
    : restart && S.phone ? null
      : h("button", { class: "btn small primary", type: "button", onclick: restart ? restartNow : () => { saveDraft(); location.reload(); } }, restart ? (update.running?.length ? "Restart now" : "Restart") : "Reload");
  document.body.append(h("div", { class: "update-bar", role: "status" },
    icon("refresh", 14),
    h("span", {}, update.restarting ? "Updating B5 Code…"
      : update.note || (restart ? (S.phone ? `B5 Code was updated. Restart it from the ${MAC()}.`
        : update.running?.length ? `B5 Code was updated. ${update.auto ? "It restarts by itself" : "Restart"} when ${update.running.join(", ")} ${update.running.length === 1 ? "finishes" : "finish"}, or now: ${update.running.length === 1 ? "it carries" : "they carry"} on after.`
          : update.auto ? "B5 Code was updated. It restarts by itself in a moment." : "B5 Code was updated. Restart to use the new version.")
        : "B5 Code's page was updated. Reload to use it.")),
    action,
    update.restarting ? null : h("button", { class: "icon", type: "button", title: "Not now", "aria-label": "Hide until the next check", onclick: () => { update.need = null; renderUpdate(); } }, icon("x", 13))));
}

async function restartNow() {
  saveDraft();
  update.restarting = true;
  renderUpdate();
  try {
    // Threads still working are cut short, and carry on once it's back.
    await call("POST", "/api/restart", { carryOn: true });
  } catch (e) {
    update.restarting = false;
    update.note = e.message;
    renderUpdate();
    return;
  }
  await comeBack();
}

let comingBack = false;
/** The old server goes and the new one comes up on the same ports: reload once it answers, up to date. */
async function comeBack() {
  if (comingBack) return;
  comingBack = true;
  saveDraft();
  update.need = "restart";
  update.restarting = true;
  renderUpdate();
  // The old server goes, the new one comes up on the same ports: reload once it answers, up to date.
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 600));
    try {
      const v = await call("GET", "/api/version");
      if (!v.stale) { location.reload(); return; }
    } catch { /* not up yet */ }
  }
  comingBack = false;
  update.restarting = false;
  update.note = "B5 Code didn't come back. Run b5 in a terminal, or reopen the app.";
  renderUpdate();
}

// ── Changes pane ─────────────────────────────────────────────────────────────

function togglePane() {
  if (S.view === "studio" && S.studioWide && S.pane && !S.studioPane) { S.studioPane = true; render(); return; } // Studio had it out of the way: show it
  S.pane = !S.pane;
  store.set("pane", S.pane);
  if (narrow()) { if (S.pane) pushLayer(); else dropLayer(); }
  render();
}

// ── Phones ───────────────────────────────────────────────────────────────────
// On a narrow screen the drawer, the pane and sheets sit over the
// conversation. Android's back gesture closes the top one (each opening adds
// a history entry), and a swipe in from the left edge opens the drawer.

const narrow = () => matchMedia("(max-width: 1080px)").matches;
// A phone's width: the sidebar is the home screen, with the spaces as a tab bar.
const phoneWidth = () => matchMedia("(max-width: 760px)").matches;
matchMedia("(max-width: 760px)").addEventListener?.("change", () => render());

/** The bar's way to the sidebar: its icon on the Mac; on a phone, back to the home screen. */
function showSideButton() {
  return h("button", { class: "icon show-side", type: "button", title: phoneWidth() ? "Back" : `Show sidebar (${KEY()}\\)`, "aria-label": phoneWidth() ? "Back" : "Show sidebar", onclick: toggleSidebar },
    icon(phoneWidth() ? "chevronLeft" : "sidebar", phoneWidth() ? 20 : 16));
}

function pushLayer() {
  try { history.pushState({ b5layer: true }, ""); } catch { /* not allowed: back leaves as before */ }
}

/** A sheet or dialog opening: it takes the drawer's place (and its history entry), or gets one of its own. */
function enterSheet() {
  if (!narrow()) return;
  if ($("app").classList.contains("side-open")) $("app").classList.remove("side-open");
  else pushLayer();
}

// A layer closed by its own button takes its history entry with it, so the next back isn't a dud.
let ignorePops = 0;
function dropLayer() {
  if (!history.state?.b5layer) return;
  ignorePops++;
  history.back();
}

window.addEventListener("popstate", () => {
  if (ignorePops) { ignorePops--; return; }
  const ov = [...document.querySelectorAll(".overlay")].pop();
  // Back on a sheet: just take it away (its history entry is already gone).
  if (ov) { (ov.b5close || (() => ov.remove()))(true); return; }
  if (S.pane && narrow()) { S.pane = false; store.set("pane", false); render(); return; }
  if ($("app").classList.contains("side-open")) $("app").classList.remove("side-open");
});

$("scrim")?.addEventListener("click", () => { if ($("app").classList.contains("side-open")) toggleSidebar(); });

let swipe = null;
window.addEventListener("touchstart", (e) => {
  const t = e.touches[0];
  const open = $("app").classList.contains("side-open");
  // From the left edge to open; anywhere on the open drawer to close.
  swipe = (!open && t.clientX < 24) || open ? { x: t.clientX, y: t.clientY, open } : null;
}, { passive: true });
window.addEventListener("touchend", (e) => {
  if (!swipe || !matchMedia("(max-width: 760px)").matches) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - swipe.x, dy = Math.abs(t.clientY - swipe.y);
  if (!swipe.open && dx > 60 && dy < 50) toggleSidebar();
  else if (swipe.open && dx < -60 && dy < 50) toggleSidebar();
  swipe = null;
}, { passive: true });

let changesTimer = null;
/** A burst of edits reloads the pane once. */
function loadChangesSoon() {
  clearTimeout(changesTimer);
  changesTimer = setTimeout(loadChanges, 300);
}

let changesAsked = 0;
async function loadChanges() {
  const p = project();
  if (!p) { S.changes = null; return renderPane(); }
  // Only the latest answer counts: switching quickly must not show another folder's files.
  const asked = ++changesAsked;
  const fresh = () => asked === changesAsked;
  const where = `/api/projects/${p.id}/changes?thread=${S.threadId || ""}`;
  // The tab's count needs the list; the code only matters while the Changes tab is showing.
  const show = changesShowing();
  let changes = null, diffs = {};
  try {
    // Every changed file's code is shown, as Claude Code's terminal does; the first few files only, so a big change set stays quick.
    changes = await call("GET", `${where}&scope=${S.changesScope}&diffs=${show ? DIFF_FILES : 0}`);
    if (!fresh()) return;
    diffs = changes.diffs || {};
    // A file the combined diff couldn't name (a quoted path) is asked for on its own.
    if (show) await Promise.all(changes.files.slice(0, DIFF_FILES).filter((f) => !(f.file in diffs)).map(async (f) => {
      try { diffs[f.file] = (await call("GET", `${where}&since=${changes.since || "HEAD"}&file=${encodeURIComponent(f.file)}`)).diff; } catch { /* its row still shows */ }
    }));
  } catch { changes = null; }
  if (!fresh()) return;
  S.changes = changes;
  S.diffs = diffs;
  S.diffsSkipped = !show;
  renderPane();
}

const changesShowing = () => S.pane && S.paneTab === "changes" && !document.hidden;
document.addEventListener("visibilitychange", () => { if (S.diffsSkipped && changesShowing()) { S.diffsSkipped = false; loadChanges(); } });

const DIFF_FILES = 20;

function setChangesScope(scope) {
  S.changesScope = scope;
  store.set("changesScope", scope);
  loadChanges();
}

/**
 * Above the files, once the thread has made commits: this chat's work (committed
 * or not) or only what's uncommitted, and the commits themselves.
 */
const STATUS_WORD = { M: "Changed", A: "Added", D: "Deleted", R: "Renamed", "??": "New, not yet added" };

/** The top of Changes: the branch and its PR, how many files, and the lines added and removed. */
function changesSummary(c, files) {
  const t = thread();
  const g = (t && S.git[t.id]) || {};
  const branch = g.branch || project()?.branch || "";
  const add = files.reduce((n, f) => n + (f.add || 0), 0), del = files.reduce((n, f) => n + (f.del || 0), 0);
  const pr = g.pr;
  const checks = pr?.checks?.state;
  return h("div", { class: "chg-sum" },
    h("div", { class: "chg-top" }, icon("branch", 14), h("b", { title: branch }, branch || "No branch"),
      pr ? h("span", { class: "pill " + (checks === "failing" ? "bad" : checks === "passing" || pr.state === "merged" ? "ok" : "") },
        `PR #${pr.number}${pr.state === "merged" ? " · merged" : checks ? ` · checks ${checks === "passing" ? "pass" : checks}` : ""}`) : null),
    h("div", { class: "chg-n" },
      h("span", {}, `${files.length} file${files.length === 1 ? "" : "s"}`),
      add ? h("span", { class: "add-n" }, `+${add}`) : null, del ? h("span", { class: "del-n" }, `−${del}`) : null,
      add + del ? h("span", { class: "ratio", title: `${add} added, ${del} removed` }, h("i", { style: `width:${Math.round((100 * add) / (add + del))}%` })) : null,
      h("button", { class: "icon", type: "button", title: "Refresh", "aria-label": "Refresh changes", onclick: loadChanges }, icon("refresh", 14))));
}

function changesHead(c) {
  const commits = c?.commits || [];
  if (!commits.length) return [];
  const opt = (v, label) => h("button", { type: "button", role: "radio", "aria-checked": String(S.changesScope === v), class: S.changesScope === v ? "on" : "", onclick: () => setChangesScope(v) }, label);
  return [
    h("div", { class: "changes-head" },
      h("span", { class: "seg", role: "radiogroup", "aria-label": "Show changes" }, opt("chat", "This chat"), opt("uncommitted", "Uncommitted")),
      h("span", { class: "changes-note" }, `${commits.length}${commits.length === 50 ? "+" : ""} commit${commits.length === 1 ? "" : "s"} in this chat`)),
    ...(c.scope === "chat" ? [h("div", { class: "commits" }, ...commits.map((x) =>
      h("div", { class: "commit", title: `${x.sha} ${x.subject}` }, h("span", { class: "sha" }, x.sha), h("span", { class: "subject" }, x.subject))))] : []),
  ];
}

function foldDiff(file) {
  if (!S.folded.delete(file)) S.folded.add(file);
  renderPane();
}

// The side pane: Changes (the project's uncommitted files), Preview (a
// plan page, screenshot, PDF or video) and Terminal (a shell in the thread's
// folder; on the Mac only). Its parts are built once; the preview frame is
// only reloaded when the file changes, not on every streamed word, and the
// shell keeps running while another tab is shown.
let paneView = null;
function paneParts() {
  if (paneView) return paneView;
  const tabs = h("div", { class: "pane-tabs", role: "tablist" });
  const actions = h("span", { class: "pane-actions" });
  const changes = h("div", { class: "pane-body" });
  // Served from its own port: another site to the browser, so the page keeps
  // its saved answers but can't reach B5 Code. Copying is allowed for a plan
  // page's "Copy my answers".
  const frame = h("iframe", { class: "preview-frame", title: "Preview", sandbox: "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads", allow: "clipboard-write" });
  const previewHead = h("div", { class: "preview-head" });
  // The address box: a link (localhost:3000, a deployed site) or a file path. Built once, so
  // a redraw while Claude streams never wipes what you're typing.
  const addr = h("input", { class: "addr", type: "text", placeholder: "Type a link or a file path", "aria-label": "Link or file to preview",
    autocomplete: "off", spellcheck: "false", autocapitalize: "off" });
  addr.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); const to = addressFor(addr.value); addr.blur(); if (to) openPreview(to); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); addr.value = addr.dataset.shown || ""; addr.blur(); }
  });
  addr.addEventListener("focus", () => addr.select());
  addr.addEventListener("blur", () => { addr.value = addr.dataset.shown || ""; });
  const empty = h("div", { class: "pane-empty" });
  const doc = h("div", { class: "preview-doc" }); // Markdown as a document, or any artifact's code
  // The page sits in a device frame, drawn at the device's own size and scaled to fit.
  const device = h("div", { class: "device" }, h("span", { class: "cam" }), frame);
  const deviceBox = h("div", { class: "device-box" }, device);
  const caption = h("div", { class: "device-caption" });
  const stage = h("div", { class: "stage" }, deviceBox, caption);
  new ResizeObserver(() => layoutScreen()).observe(stage);
  const preview = h("div", { class: "preview" }, previewHead, stage, doc, empty);
  const terminal = createTerminalPane({ call, h, icon, win: WIN });
  terminal.onChange = () => renderPane();
  const files = createFilesPane({ call, h, icon, toast, onMac: !S.phone,
    onMention: mention, onPreview: (rel) => openPreview(workDir() + "/" + rel) });
  paneView = { tabs, actions, changes, preview, frame, previewHead, addr, empty, doc, terminal, files, stage, device, deviceBox, caption, src: "" };
  fill($("pane"), h("div", { class: "pane-bar" }, tabs, h("span", { class: "spacer" }), actions), changes, preview, terminal.el, files.el);
  return paneView;
}

function renderPane() {
  const pane = $("pane");
  // While a video is open in Studio, the pane makes way, unless you open it there yourself.
  pane.hidden = !S.pane || !S.projects.length || (S.view === "studio" && S.studioWide && !S.studioPane) || (S.view === "thread" && project()?.kind === "chat");
  $("app").classList.toggle("pane-wide", !pane.hidden && S.paneWide);
  if (pane.hidden) { paneView?.terminal.hide(); return; }
  // The code was left out while the Changes tab wasn't showing: it is now.
  if (S.diffsSkipped && changesShowing()) { S.diffsSkipped = false; loadChanges(); }
  const v = paneParts();
  if (S.phone && S.paneTab === "terminal") S.paneTab = "changes";
  const c = S.changes;
  const files = c?.files || [];

  // Tabs as a segmented switch: an icon each, the open one named (all named when the pane is wide).
  const TAB_ICON = { changes: "diff", files: "folder", preview: "eye", terminal: "terminal" };
  const tab = (id, label, count) => h("button", { type: "button", role: "tab", "aria-selected": String(S.paneTab === id), class: S.paneTab === id ? "on" : "", title: label, onclick: () => { S.paneTab = id; render(); } },
    icon(TAB_ICON[id], 14), h("span", { class: "tab-label" }, label), count ? h("span", { class: "count" }, String(count)) : null);
  // A Work space isn't code: its pane is the files Claude makes, and what they look like.
  const work = project()?.kind === "work";
  if (work && S.paneTab === "changes") S.paneTab = "files";
  fill(v.tabs, ...(work ? [] : [tab("changes", "Changes", files.length)]), tab("files", "Files"), tab("preview", "Preview"), ...(S.phone ? [] : [tab("terminal", "Terminal")]));
  const term = v.terminal;
  fill(v.actions, 
    ...(S.paneTab === "changes"
      ? []
      : S.paneTab === "files"
        ? [h("button", { class: "icon", type: "button", title: "Find a file", "aria-label": "Find a file", onclick: () => v.files.focusFilter() }, icon("search", 15)),
          h("button", { class: "icon", type: "button", title: "Refresh", "aria-label": "Refresh the files", onclick: () => { v.files.refresh(); loadChanges(); } }, icon("refresh", 15))]
      : S.paneTab === "preview"
        ? [h("button", { class: "icon", type: "button", title: "Open a file", "aria-label": "Open a file to preview", onclick: pickPreviewFile }, icon("folder", 15))]
        // Find (⌘F) and Clear (⌘K) are keys inside the terminal: four tabs leave room for two buttons here.
        : [term.running
            ? h("button", { class: "icon", type: "button", title: "Stop the shell", "aria-label": "Stop the shell", onclick: term.stop }, icon("stop", 15))
            : null,
          h("button", { class: "icon", type: "button", title: "New shell", "aria-label": "Start a new shell", onclick: term.restart }, icon("refresh", 15))]),
    h("button", { class: "icon desktop-only" + (S.paneWide ? " on" : ""), type: "button", title: S.paneWide ? "Narrow pane" : "Wide pane", "aria-label": "Wide pane", onclick: () => { S.paneWide = !S.paneWide; store.set("paneWide", S.paneWide); renderPane(); requestAnimationFrame(sendRegions); } }, icon("wide", 15)),
    h("button", { class: "icon pane-close", type: "button", title: "Close", "aria-label": "Close the pane", onclick: togglePane }, icon("close", 16)));
  positionHandles();

  v.changes.hidden = S.paneTab !== "changes";
  v.preview.hidden = S.paneTab !== "preview";
  term.el.hidden = S.paneTab !== "terminal";
  v.files.el.hidden = S.paneTab !== "files";
  if (S.paneTab === "files") v.files.show(project()?.id || null, S.threadId, workDir(), c?.removed ? [] : files);
  if (S.paneTab === "terminal") term.show(S.threadId || project()?.id || null);
  else term.hide();

  // Rebuilt only when what it shows changed: every diff is highlighted, and renders come many a second while Claude works.
  const changesKey = S.paneTab === "changes" ? [c, S.diffs, [...S.folded].join("\0"), S.changesScope, paneSteps().map((x) => x.textContent).join("|")] : null;
  const sameChanges = changesKey && v.changesKey && changesKey.every((k, i) => k === v.changesKey[i]);
  if (changesKey) v.changesKey = changesKey;
  if (S.paneTab === "changes" && !sameChanges) {
    fill(v.changes, ...[].concat(!c ? h("div", { class: "pane-empty" }, "Pick a project to see its changes.")
      : c.removed ? h("div", { class: "pane-empty" }, "This thread's worktree has been removed.")
      : !c.git ? h("div", { class: "pane-empty" }, "This folder isn't a Git repo.")
        : [...paneSteps(), changesSummary(c, files), ...changesHead(c), ...(!files.length ? [h("div", { class: "pane-empty" }, c.scope === "chat" ? "No changes in this chat." : "No uncommitted changes.")]
          : files.flatMap((f) => [
            h("button", { class: "file" + (S.folded.has(f.file) ? "" : " on"), type: "button", title: `${f.file} · ${STATUS_WORD[f.status] || "Changed"}`, "aria-expanded": String(!S.folded.has(f.file)), onclick: () => foldDiff(f.file) },
            h("span", { class: "st-dot " + (f.status === "??" ? "A" : f.status.replace(/[^AMDR]/g, "") || "M"), "aria-label": STATUS_WORD[f.status] || "Changed" }),
            h("span", { class: "fname" }, h("b", {}, f.file.split("/").pop()), f.file.includes("/") ? h("span", {}, f.file.slice(0, f.file.lastIndexOf("/"))) : null),
            // The row shows what changed; the eye shows the file itself.
            canPreview(f.file) ? h("span", { class: "add-n", style: "color:var(--muted)", title: `Preview ${f.file}`, onclick: (e) => { e.stopPropagation(); openPreview(workDir() + "/" + f.file); } }, icon("eye", 13)) : null,
            f.add ? h("span", { class: "add-n" }, "+" + f.add) : null, f.del ? h("span", { class: "del-n" }, "−" + f.del) : null),
            ...(S.folded.has(f.file) || !(f.file in S.diffs) ? [] : [renderDiff(S.diffs[f.file], f.file)]),
          ]))]));
  } else {
    const p = S.preview;
    // A page gets a link locked to its own folder, asked for once per file.
    const isUrl = isWebAddress(p);
    const base = isUrl ? p : p ? S.previewLinks[p] || "" : "";
    if (p && !isUrl && !(p in S.previewLinks)) {
      S.previewLinks[p] = "";
      call("GET", `/api/preview-link?path=${encodeURIComponent(p)}`)
        .then((r) => { S.previewLinks[p] = r.url; }, (e) => toast(e.message))
        .then(() => renderPane());
    }
    // An artifact: its versions, a Preview/Code switch, and Markdown as a document.
    const isArt = !!p && !isUrl && ARTIFACT_FILE.test(p);
    if (isArt) loadVersions(p);
    const versions = isArt ? S.previewVersions[p] || [] : [];
    const latest = versions.length ? versions[versions.length - 1].v : null;
    const ver = S.previewVersion && S.previewVersion !== latest ? S.previewVersion : null;
    const src = base && (ver ? `${base}?v=${ver}` : base);
    const isMd = isArt && /\.(md|markdown)$/i.test(p);
    const code = isArt && S.previewMode === "code";
    // A picture is drawn fitted to the pane: in a frame, WebKit shows it at its full size.
    const isImg = !!p && !isUrl && IMAGE_FILE.test(p);
    const useDoc = isMd || code || isImg;
    const shown = !p ? "" : isUrl ? p.replace(/^https?:\/\//, "").replace(/^([^/]+)\/$/, "$1") : p;
    v.addr.dataset.shown = shown;
    if (document.activeElement !== v.addr) { v.addr.value = shown; v.addr.title = p || ""; }
    if (!p) fill(v.previewHead, v.addr);
    v.stage.hidden = !src || useDoc;
    // Pages and dev servers can be shown on a phone, tablet or computer screen.
    const isPage = isUrl || /\.html?$/i.test(p || "");
    v.screen = isPage ? screenById(S.screen) : null;
    v.doc.hidden = !p || !useDoc;
    v.empty.hidden = !!p && (useDoc || !!src);
    if (p) {
      const arts = threadArtifacts();
      const cur = ver || latest;
      const step = (d) => { const i = versions.findIndex((x) => x.v === cur) + d; if (versions[i]) { S.previewVersion = versions[i].v; render(); } };
      // replaceChildren would show a null as the text "null": empty slots are dropped first.
      fill(v.previewHead, ...[
        arts.length > 1
          ? h("select", { class: "art-pick", "aria-label": "This thread's pages", onchange: (e) => openPreview(e.target.value) },
            ...(arts.some((a) => toHome(a.path) === p) ? [] : [h("option", { value: p, selected: true }, baseName(p))]),
            ...arts.map((a) => h("option", { value: a.path, selected: toHome(a.path) === p }, a.title)))
          : null,
        v.addr,
        versions.length > 1 ? h("span", { class: "ver-step" },
          h("button", { class: "icon", type: "button", title: "Earlier version", "aria-label": "Earlier version", disabled: cur === versions[0].v, onclick: () => step(-1) }, icon("chevron", 13)),
          h("span", { class: "ver-n", title: ver ? "An earlier version" : "As it is now" }, `v${cur} of ${versions.length}`),
          h("button", { class: "icon", type: "button", title: "Later version", "aria-label": "Later version", disabled: cur === latest, onclick: () => step(1) }, icon("chevron", 13))) : null,
        isPage && !code ? screenPicker() : null,
        isArt ? h("span", { class: "seg", role: "group", "aria-label": "Show as" },
          h("button", { type: "button", class: S.previewMode === "view" ? "on" : "", onclick: () => { S.previewMode = "view"; renderPane(); } }, isMd ? "Document" : "Preview"),
          h("button", { type: "button", class: code ? "on" : "", onclick: () => { S.previewMode = "code"; renderPane(); } }, "Code")) : null,
        h("button", { class: "icon", type: "button", title: "Reload", "aria-label": "Reload preview", onclick: () => {
          for (const k of Object.keys(S.previewSource)) if (k.startsWith(p + "@")) delete S.previewSource[k];
          delete S.previewVersions[p];
          if (isImg) { const im = v.doc.querySelector("img"); if (im) im.src = `${src}${src.includes("?") ? "&" : "?"}r=${Date.now()}`; } else if (useDoc) renderPane(); else v.frame.src = src;
        } }, icon("refresh", 14)),
        src ? h("a", { class: "icon", href: src, target: "_blank", rel: "noopener", title: "Open in browser", "aria-label": "Open in browser" }, icon("external", 14)) : null,
        h("button", { class: "icon", type: "button", title: "Close", "aria-label": "Close the preview", onclick: closePreview }, icon("close", 14))].filter(Boolean));
    }
    if (isImg) {
      if (v.doc.dataset.img !== src) {
        v.doc.dataset.img = src;
        const view = h("div", { class: "img-view", title: "Click for actual size" });
        view.append(h("img", { src, alt: baseName(p), onclick: () => { const full = view.classList.toggle("full"); view.title = full ? "Click to fit" : "Click for actual size"; },
          onerror: () => view.replaceWith(h("div", { class: "pane-empty" }, "The picture isn't there any more.")) }));
        fill(v.doc, view);
      }
    } else if (useDoc) {
      delete v.doc.dataset.img;
      const text = S.previewSource[`${p}@${ver || ""}`];
      if (text === undefined) loadSource(p, ver);
      fill(v.doc, text == null ? h("div", { class: "pane-empty" }, "Opening…")
        : text.error ? h("div", { class: "pane-empty" }, text.error)
          : code ? h("div", { class: "code-view" },
            h("pre", { class: "gutter", "aria-hidden": "true" }, Array.from({ length: text.split("\n").length }, (_, i) => i + 1).join("\n")),
            h("pre", { class: "src" }, h("code", { html: highlight(text, p) })))
            : h("div", { class: "msg-ai md-doc", html: renderMarkdown(text) }));
    } else if (src && v.src !== src) {
      // A previewed file gets no popups (a window could carry what it read out); your own dev server keeps them.
      v.frame.setAttribute("sandbox", `allow-scripts allow-same-origin allow-forms allow-modals allow-downloads${isUrl ? " allow-popups" : ""}`);
      v.src = src; v.frame.src = src;
    }
    if (!v.stage.hidden) layoutScreen();
    if (p && !useDoc && !src) fill(v.empty, h("div", {}, "Opening…"));
    if (!p) fill(v.empty, h("div", {}, "Nothing to preview yet."),
      h("div", { style: "margin-top:4px" }, "Type a link above (localhost:3000, or a site), or open a file. Pages Claude makes open here by themselves, and file paths and localhost links in replies open here when clicked. Pick a phone or tablet to see a page at its size."),
      h("button", { class: "btn", type: "button", style: "margin-top:12px", onclick: pickPreviewFile }, "Open a file…"));
  }
}

const PREVIEWABLE = /\.(html?|png|jpe?g|gif|webp|svg|pdf|mp4|mov|webm|mp3|wav|txt|md|csv)$/i;
const canPreview = (f) => PREVIEWABLE.test(String(f || ""));

/** A picture's link (under the shared secret, which never runs a file's code with access to anything). */
function previewUrl(p) {
  // A Mac's path loses its first "/"; Windows's starts with its drive (C:/Users/…).
  const abs = /^~[\\/]/.test(p) ? p : p.replace(/^\/+/, "");
  return `${S.previewBase}/${abs.split(WIN() ? /[\\/]/ : "/").filter(Boolean).map(encodeURIComponent).join("/")}`;
}

/** Show a file in the Preview pane. Relative paths are inside the project. */
function openPreview(p) {
  let path = String(p || "").trim().replace(/^file:\/\//, "");
  if (!path) return;
  if (LOCAL_ADDRESS.test(path)) path = "http://" + path;
  path = path.replace(/^(https?:\/\/)0\.0\.0\.0(?=[:/]|$)/i, "$1localhost"); // a dev server listening everywhere
  if (isWebAddress(path)) path = path.replace(/^(https?:\/\/[^/?#]+)$/i, "$1/");
  else if (!isAbsPath(path)) path = (workDir() || S.home) + "/" + path.replace(/^\.[\\/]/, "");
  else path = toHome(path);
  if (S.preview !== path) { S.previewVersion = null; S.previewMode = "view"; }
  S.preview = path;
  store.set("preview", path);
  S.paneTab = "preview";
  if (!S.pane) { S.pane = true; store.set("pane", true); if (narrow()) pushLayer(); }
  S.studioPane = true;
  if ((/\.html?$/i.test(path) || isWebAddress(path)) && !S.paneWide) { S.paneWide = true; store.set("paneWide", true); }
  render();
}
window.deskOpenPreview = openPreview; // the Mac app's file picker answers here

/** Stop showing anything in Preview. */
function closePreview() {
  S.preview = null; S.previewVersion = null; S.previewMode = "view";
  store.set("preview", null);
  if (paneView) { paneView.src = ""; paneView.frame.src = "about:blank"; }
  renderPane();
}

/** What a typed address means: a site (example.com → https://example.com), a local app, or a file path. */
function addressFor(text) {
  const t = String(text || "").trim();
  if (!t || isWebAddress(t) || LOCAL_ADDRESS.test(t)) return t;
  // A bare name with a dot (vercel.app, www.site.com/about) that isn't a file Preview shows is a site.
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(t) && !PREVIEWABLE.test(t.split(/[?#]/)[0]) && !t.startsWith(".")) return "https://" + t;
  return t;
}

// A running app on this Mac: localhost:3000, 127.0.0.1:5173/about, …
const LOCAL_ADDRESS = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d{2,5})?(\/\S*)?$/i;
const isWebAddress = (p) => /^https?:\/\//i.test(String(p || ""));

/** The screen menu: fill the pane, or a phone, tablet or computer, and a turn button. */
function screenPicker() {
  const scr = screenById(S.screen);
  return h("span", { class: "screen-pick" },
    h("select", { class: "art-pick", "aria-label": "Show the page on", title: "Show the page on a phone, tablet or computer",
      onchange: (e) => { S.screen = e.target.value || null; store.set("screen", S.screen); renderPane(); } },
    h("option", { value: "", selected: !scr }, "Fill the pane"),
    ...SCREENS.map((g) => h("optgroup", { label: g.group }, ...g.items.map((s) => h("option", { value: s.id, selected: scr?.id === s.id }, `${s.name}`))))),
    scr ? h("button", { class: "icon", type: "button", title: S.screenTurned ? "Turn upright" : "Turn sideways", "aria-label": "Turn the screen",
      onclick: () => { S.screenTurned = !S.screenTurned; store.set("screenTurned", S.screenTurned); renderPane(); } }, icon("rotate", 14)) : null);
}

/** Size the device frame to the pane: the page gets the device's own width, scaled down to fit. */
function layoutScreen() {
  const v = paneView;
  if (!v || v.stage.hidden) return;
  const scr = v.screen;
  v.stage.classList.toggle("fit", !scr);
  if (!scr) {
    for (const el of [v.deviceBox, v.device, v.frame]) el.removeAttribute("style");
    v.device.className = "device";
    fill(v.caption);
    return;
  }
  const f = fitScreen(scr, S.screenTurned, v.stage.clientWidth, v.stage.clientHeight - 30);
  v.device.className = `device ${scr.kind}${S.screenTurned ? " turned" : ""}`;
  v.device.style.cssText = `width:${f.outerW}px;height:${f.outerH}px;padding:${S.screenTurned ? `${f.bezel}px ${f.bezel + f.chin}px` : `${f.bezel + f.chin}px ${f.bezel}px`};transform:scale(${f.scale})`;
  v.deviceBox.style.cssText = `width:${Math.round(f.outerW * f.scale)}px;height:${Math.round(f.outerH * f.scale)}px`;
  v.frame.style.cssText = `width:${f.w}px;height:${f.h}px`;
  fill(v.caption, ...[h("span", {}, scr.name), h("span", { class: "dim" }, `${f.w} × ${f.h}`), f.scale < 1 ? h("span", { class: "dim" }, `${Math.round(f.scale * 100)}%`) : null].filter(Boolean));
}

function pickPreviewFile() {
  if (native) { native.postMessage({ type: "pickFile" }); return; }
  const input = h("input", { id: "ppath", placeholder: "~/Desktop/flaevo-home-screens/plan.html", autocomplete: "off", spellcheck: "false" });
  dialog("Open a file to preview", [h("label", { for: "ppath" }, `Path on this ${MAC()}, or a running app (localhost:3000)`), input], "Open", async () => openPreview(input.value));
}

// File paths in replies (`~/Desktop/…/plan.html`, `shots/home.png`) open in
// Preview when clicked.
const PATHISH = /^(~[\\/]|\/Users\/|[A-Za-z]:[\\/]|\.?\.?[\\/])?[\w@.\- /\\]+\.(html?|png|jpe?g|gif|webp|svg|pdf|mp4|mov|webm)$/i;
function linkFiles(el) {
  for (const code of el.querySelectorAll("code")) {
    if (code.closest("pre")) continue;
    const text = code.textContent.trim();
    if (LOCAL_ADDRESS.test(text) || /^https?:\/\//i.test(text) && LOCAL_ADDRESS.test(text.replace(/^https?:\/\//i, ""))) {
      code.classList.add("file-link");
      code.title = "Open in Preview";
      code.addEventListener("click", () => openPreview(text));
      continue;
    }
    if (!PATHISH.test(text) || !/[\\/]/.test(text) && !/\.(html?|pdf|mp4)$/i.test(text)) continue;
    code.classList.add("file-link");
    code.title = "Open in Preview";
    code.addEventListener("click", () => openPreview(text));
  }
  for (const a of el.querySelectorAll("a.file-link")) {
    a.addEventListener("click", (e) => { e.preventDefault(); openPreview(a.dataset.path); });
  }
  // A link to the app Claude is running (http://localhost:3000) opens in Preview too.
  for (const a of el.querySelectorAll("a[href]")) {
    if (a.classList.contains("file-link") || !/^https?:\/\//i.test(a.getAttribute("href")) || !LOCAL_ADDRESS.test(a.getAttribute("href").replace(/^https?:\/\//i, ""))) continue;
    a.title = "Open in Preview";
    a.addEventListener("click", (e) => { e.preventDefault(); openPreview(a.getAttribute("href")); });
  }
}

/** /Users/me/x (C:\Users\me\x) → ~/x, the form the Preview pane keeps paths in. */
const toHome = (p) => { const r = underHome(p); return r ? "~/" + (WIN() ? r.replace(/\\/g, "/") : r) : String(p); };

// ── Artifacts ────────────────────────────────────────────────────────────────
// A page, picture or document Claude writes shows as a card in the chat and
// opens in Preview; each change to it is a version (server/artifacts.js).

const ARTIFACT_FILE = /\.(html?|svg|md|markdown)$/i;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i; // an SVG is a page: it has a Code view
const ARTIFACT_LABEL = { page: "Page", image: "Picture", document: "Document" };

function artifactCard(it) {
  const showing = cardShowing(it);
  const latest = threadArtifacts().find((a) => a.path === it.path) === it;
  // Each card opens its own version: the latest card the page as it is now, an earlier one how it was then.
  const open = () => { openPreview(it.path); S.previewVersion = latest ? null : it.version; S.previewMode = "view"; render(); };
  return h("button", { class: "art-card" + (showing ? " on" : ""), type: "button", title: it.path, onclick: open },
    h("span", { class: "art-icon" }, icon(it.kind === "document" ? "file" : it.kind === "image" ? "eye" : "external", 16)),
    h("span", { class: "art-text" }, h("span", { class: "art-title" }, it.title), h("span", { class: "art-sub" }, `${ARTIFACT_LABEL[it.kind] || "Page"} · ${baseName(it.path)}${it.version > 1 ? ` · version ${it.version}` : ""}`)),
    h("span", { class: "art-open" }, showing ? "Showing" : "Open"));
}

/** Whether this card's version is the one in Preview now. */
function cardShowing(it) {
  if (S.paneTab !== "preview" || !S.pane || S.preview !== toHome(it.path)) return false;
  const latest = threadArtifacts().find((a) => a.path === it.path) === it;
  return S.previewVersion ? S.previewVersion === it.version : latest;
}

/** The thread's artifacts, newest last, one per file. */
function threadArtifacts() {
  const t = thread();
  const seen = new Map();
  for (const it of t ? feedOf(t.id).items : []) if (it.type === "artifact") seen.set(it.path, it);
  return [...seen.values()];
}

async function loadVersions(p) {
  if (p in S.previewVersions) return;
  S.previewVersions[p] = [];
  try { S.previewVersions[p] = (await call("GET", `/api/artifacts/versions?path=${encodeURIComponent(p)}`)).versions; } catch { /* not versioned */ }
  renderPane();
}

async function loadSource(p, v) {
  const key = `${p}@${v || ""}`;
  if (key in S.previewSource) return S.previewSource[key];
  S.previewSource[key] = null;
  try { S.previewSource[key] = (await call("GET", `/api/artifacts/source?path=${encodeURIComponent(p)}${v ? `&v=${v}` : ""}`)).text; }
  catch (e) { S.previewSource[key] = { error: e.message }; }
  renderPane();
}

/** Mention a file in the message being written: "@src/goals.js ", at the cursor. */
function mention(rel) {
  const ta = $("input");
  if (!ta) return;
  const at = ta.selectionStart ?? ta.value.length;
  const before = ta.value.slice(0, at), after = ta.value.slice(ta.selectionEnd ?? at);
  const text = (before && !/\s$/.test(before) ? " " : "") + "@" + rel + " ";
  ta.value = before + text + after;
  ta.selectionStart = ta.selectionEnd = (before + text).length;
  ta.dispatchEvent(new Event("input"));
  ta.focus();
}

// ── Changes in green and red ─────────────────────────────────────────────────

/** "+3 −1" beside an edit's line. */
function counts(change) {
  const c = changeCounts(change);
  return h("span", { class: "chg-n" }, c.add ? h("span", { class: "add-n" }, "+" + c.add) : null, c.del ? h("span", { class: "del-n" }, "−" + c.del) : null);
}

const CHANGE_LINES = 400; // a long new file shows its start, then how much more there is

/** An edit as Claude Code's terminal shows it: removed lines red, added lines green, coloured by language. */
function renderChange(change, error = "") {
  const rows = [];
  change.edits.forEach((e, n) => {
    if (n) rows.push({ t: "skip", count: 0 });
    rows.push(...foldSame(lineDiff(e.old, e.new)));
  });
  const shown = rows.slice(0, CHANGE_LINES);
  const line = (r) => r.t === "skip"
    ? h("span", { class: "chg-skip" }, r.count ? `⋯ ${r.count} unchanged line${r.count === 1 ? "" : "s"}` : "⋯")
    : h("span", { class: "chg-" + r.t }, h("i", {}, r.t === "add" ? "+" : r.t === "del" ? "−" : " "), h("code", { html: highlight(r.text, change.file) || " " }));
  return h("div", { class: "chg" },
    h("div", { class: "chg-file", title: change.file }, home(change.file), change.created ? h("span", {}, " · new file") : null),
    h("div", { class: "chg-body" }, ...shown.map(line),
      rows.length > shown.length ? h("span", { class: "chg-skip" }, `⋯ ${rows.length - shown.length} more lines`) : null),
    error ? h("pre", { class: "chg-err" }, error) : null);
}

function renderDiff(text, file = "") {
  if (!text) return h("div", { class: "pane-empty", style: "padding:10px" }, "New file, or no line changes to show.");
  // As the terminal shows it: each line's number, its +/− mark, its code coloured by the file's language.
  const rows = gitRows(text);
  const shown = rows.slice(0, CHANGE_LINES);
  const width = String(Math.max(0, ...shown.map((r) => r.n || 0))).length;
  return h("div", { class: "diff", style: `--ln:${width}ch` }, ...shown.map((r) => r.t === "hunk"
    ? h("span", { class: "h" }, h("i", { class: "ln" }), h("i", { class: "mk" }, "⋯"), r.text)
    : h("span", { class: r.t === "add" ? "a" : r.t === "del" ? "d" : "" },
      h("i", { class: "ln" }, String(r.n)), h("i", { class: "mk" }, r.t === "add" ? "+" : r.t === "del" ? "−" : ""),
      h("code", { html: highlight(r.text, file) || " " }))),
  rows.length > shown.length ? h("span", { class: "h" }, h("i", { class: "ln" }), h("i", { class: "mk" }), `${rows.length - shown.length} more lines`) : null);
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

function dialog(title, content, okLabel, onOk, onCancel = null) {
  let done = false;
  enterSheet();
  const close = (fromBack) => { ov.remove(); document.removeEventListener("keydown", esc, true); if (!done) onCancel?.(); if (fromBack !== true && narrow()) dropLayer(); };
  const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  const err = h("p", { class: "err", hidden: true, style: "margin:0" });
  const ok = h("button", { class: "btn primary", type: "submit" }, okLabel);
  const ov = h("div", { class: "overlay", onclick: (e) => { if (e.target === ov) close(); } },
    h("form", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-label": title, onsubmit: async (e) => {
      e.preventDefault();
      ok.disabled = true;
      // A step of a longer dialog throws keepOpen: no error shown, the dialog stays.
      try { await onOk(); done = true; close(); } catch (x) { err.hidden = !x.message; err.textContent = x.message; ok.disabled = false; }
    } },
    h("h2", {}, title), ...content, err,
    h("div", { class: "btns" }, h("button", { class: "btn quiet", type: "button", onclick: () => close() }, "Cancel"), ok)));
  ov.b5close = close;
  document.body.append(ov);
  document.addEventListener("keydown", esc, true);
  requestAnimationFrame(() => (ov.querySelector("input") || ok).focus());
}

function addProjectDialog() {
  const dir = h("input", { id: "pdir", placeholder: "~/Desktop/MyProject", autocomplete: "off", spellcheck: "false" });
  const name = h("input", { id: "pname", placeholder: "Optional" });
  // A picked folder fills the box, and names the project after itself.
  const take = (p) => {
    dir.value = home(p);
    name.placeholder = baseName(p) || "Optional";
    browser.hidden = true;
  };
  window.deskPickedFolder = take; // the Mac app's Finder picker answers here
  const browser = h("div", { class: "folder-browser", hidden: true });
  const choose = h("button", { class: "btn", type: "button", onclick: () => {
    // Finder's picker, from an app new enough to have it; otherwise the in-page browser.
    if (native && window.deskFeatures?.includes("pickFolder")) native.postMessage({ type: "pickFolder" });
    else if (browser.hidden) browse(browser, dir.value.trim() || "~", take); else browser.hidden = true;
  } }, icon("folder", 14), "Choose…");
  dialog("Add a project", [
    h("label", { for: "pdir" }, `Folder on this ${MAC()}`),
    h("div", { class: "pick-row" }, dir, choose),
    browser,
    h("label", { for: "pname" }, "Name"), name,
  ], "Add project", async () => {
    const p = await call("POST", "/api/projects", { dir: dir.value.trim(), name: name.value.trim() });
    await loadState();
    startNew(p.id);
  });
}

/** The in-page folder browser (Safari and phones): click into folders, then choose one. */
async function browse(box, at, onPick) {
  let r;
  try { r = await call("GET", `/api/folders?path=${encodeURIComponent(at)}`); }
  catch { if (at !== "~") return browse(box, "~", onPick); return; } // a typed path that isn't there: start at home
  const crumbs = home(r.path).split(/[\\/]/);
  box.hidden = false;
  fill(box, 
    h("div", { class: "fb-head" },
      r.parent ? h("button", { class: "icon", type: "button", title: "Up one folder", "aria-label": "Up one folder", onclick: () => browse(box, r.parent, onPick) }, icon("up", 14)) : null,
      h("span", { class: "fb-path", title: r.path }, crumbs.join(" / ")),
      h("button", { class: "btn small primary", type: "button", onclick: () => onPick(r.path) }, r.git ? "Choose this project" : "Choose this folder")),
    h("div", { class: "fb-list", role: "list" },
      ...(r.folders.length ? r.folders.map((f) => h("button", { class: "fb-item", type: "button", role: "listitem", title: f.path,
        onclick: () => browse(box, f.path, onPick), ondblclick: () => onPick(f.path) },
        icon(f.git ? "branch" : "folder", 14), h("span", { class: "fb-name" }, f.name), f.git ? h("span", { class: "fb-git" }, "Git") : null))
        : [h("div", { class: "fb-empty" }, "No folders in here.")])));
}

// ── Theme, keys, start ───────────────────────────────────────────────────────

const isDark = () => document.documentElement.dataset.theme
  ? document.documentElement.dataset.theme === "dark"
  : matchMedia("(prefers-color-scheme: dark)").matches;

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  native?.postMessage({ type: "theme", value: theme || "system" });
  paneView?.terminal.retheme();
}

// ── Settings ─────────────────────────────────────────────────────────────────
// Kept in this browser's storage: they are about how B5 Code looks and behaves
// on this Mac, not about any project.

const DEFAULTS = { theme: null, textSize: 1, sendKey: "enter", notify: true, playful: true, sound: "Ping", motion: "subtle", chatModel: null, studioRoom: true };
const SET = { ...DEFAULTS, ...store.get("settings", {}) };
if (store.get("theme", undefined) !== undefined && SET.theme === null) SET.theme = store.get("theme", null);
export const TEXT_SIZES = [[0.9, "Small"], [1, "Default"], [1.1, "Large"], [1.2, "Larger"]];

function setSetting(k, v) {
  SET[k] = v;
  store.set("settings", SET);
  applySettings();
}

function applySettings() {
  applyTheme(SET.theme);
  // The Mac app zooms the whole page natively; a browser uses CSS zoom.
  if (native) native.postMessage({ type: "zoom", value: SET.textSize });
  else document.documentElement.style.setProperty("--zoom", String(SET.textSize));
  document.documentElement.classList.toggle("plain-words", !SET.playful);
  document.documentElement.dataset.motion = SET.motion || "subtle";
  const hint = document.querySelector(".foot .keys");
  if (hint) hint.textContent = SET.sendKey === "enter" ? "Enter to send · Shift+Enter for a new line" : `${KEY()}Enter to send · Enter for a new line`;
}

// ── Settings ─────────────────────────────────────────────────────────────────
// A window with its groups as rows on the left: General, Chat, Code, Work, Studio, Account.
// On a phone, the groups are a list and each opens as its own page.
const ALL_SETTINGS_PAGES = [["general", "General", "general"], ["chat", "Chat", "chat"], ["code", "Code", "code"], ["work", "Work", "work"], ["studio", "Studio", "studio"], ["account", "Account", "account"]];

const settingsPages = () => ALL_SETTINGS_PAGES.filter(([id]) => !(id === "studio" && WIN()));

function openSettings(page = null) {
  const mm = $("model-menu");
  if (mm) mm.hidden = true;
  document.querySelector(".settings-win")?.closest(".overlay")?.b5close?.();
  enterSheet();
  const phone = phoneWidth();
  let at = page || (phone ? null : "general");
  // The same rule as enterSheet(): a history entry on narrow windows, taken back on close.
  const close = (fromBack) => { ov.remove(); document.removeEventListener("keydown", esc, true); if (!fromBack && narrow()) dropLayer(); };
  const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); if (phone && at && !page) { at = null; draw(); } else close(); } };
  const nav = h("nav", { class: "set-nav", "aria-label": "Settings" });
  const body = h("div", { class: "set-body" });
  const win = h("div", { class: "settings-win" + (phone ? " phone" : ""), role: "dialog", "aria-modal": "true", "aria-label": "Settings" }, nav, body);
  const ov = h("div", { class: "overlay set-overlay", onclick: (e) => { if (e.target === ov) close(); } }, win);
  const draw = () => {
    fill(nav, h("h2", {}, "Settings"), ...settingsPages().map(([id, label, ic]) =>
      h("button", { type: "button", class: id === at ? "on" : "", "aria-current": id === at ? "page" : null, onclick: () => { at = id; draw(); } }, icon(ic, 16), h("span", { class: "set-nav-label" }, label), phone ? icon("chevron", 14) : null)));
    win.classList.toggle("at-page", !!at);
    if (phone && !at) {
      fill(body);
      nav.prepend(h("div", { class: "set-bar" }, h("button", { class: "icon", type: "button", "aria-label": "Close", onclick: () => close() }, icon("x", 18))));
      return;
    }
    const [, title] = settingsPages().find(([id]) => id === at);
    fill(body, 
      h("div", { class: "set-top" },
        phone ? h("button", { class: "icon", type: "button", "aria-label": "Back to Settings", onclick: () => { at = null; draw(); } }, icon("chevronLeft", 18)) : null,
        h("h2", {}, title), h("span", { class: "set-sub" }, SETTINGS_SUBS[at]),
        h("button", { class: "icon", type: "button", "aria-label": "Close", title: "Close (Esc)", onclick: () => close() }, icon("x", 16))),
      h("div", { class: "set-scroll" }, ...SETTINGS_BUILD[at]()));
  };
  ov.b5close = close;
  document.body.append(ov);
  document.addEventListener("keydown", esc, true);
  draw();
  requestAnimationFrame(() => (nav.querySelector("button.on") || nav.querySelector("button"))?.focus());
}

const SETTINGS_SUBS = {
  general: "How B5 Code looks and talks to you",
  chat: "Conversations, like claude.ai",
  code: "Threads in your projects",
  work: "Documents, research and everyday tasks",
  studio: "B5 Studio's video editor",
  account: "Claude accounts, usage and your phone",
};

/** A group of settings: a small heading over a card of rows. */
const setGroup = (title, ...rows) => h("section", { class: "set-group" }, h("h3", {}, title), h("div", { class: "set-card" }, ...rows.filter(Boolean)));
const setRow = (title, desc, ...ctrl) => h("div", { class: "set-row" }, h("span", {}, h("span", { class: "set-title" }, title), desc ? h("span", { class: "set-desc" }, desc) : null), ...ctrl.filter(Boolean));
const macOnly = (btn) => (S.phone ? h("button", { class: "btn", type: "button", disabled: true, title: `Only from the ${MAC()}` }, `On the ${MAC()}`) : btn);

function segSetting(key, options) {
  return h("div", { class: "seg", role: "radiogroup" }, ...options.map(([v, label]) =>
    h("button", { type: "button", role: "radio", "aria-checked": String(SET[key] === v), class: SET[key] === v ? "on" : "",
      onclick: (e) => { setSetting(key, v); e.currentTarget.parentElement.querySelectorAll("button").forEach((b) => { const on = b === e.currentTarget; b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on)); }); } }, label)));
}
function toggleSetting(key, title, desc) {
  return h("label", { class: "set-row" },
    h("span", {}, h("span", { class: "set-title" }, title), h("span", { class: "set-desc" }, desc)),
    h("input", { type: "checkbox", class: "switch", checked: SET[key] ? true : null, onchange: (e) => setSetting(key, e.target.checked) }));
}

/** A model picker for a setting: Claude Code's models, newest of each family first. */
function modelSelect(value, onPick) {
  const { all, latest } = modelChoices(null);
  const list = all.length > latest.length ? latest : all;
  return h("select", { class: "art-pick", "aria-label": "Model", onchange: (e) => onPick(e.target.value || null) },
    h("option", { value: "", selected: !value }, `Your Claude Code setting${settingModel() ? ` (${settingModel().name})` : ""}`),
    ...list.filter((m) => m.value !== "default").map((m) => h("option", { value: m.value, selected: value === m.value }, m.name)));
}

/** Edit a space's CLAUDE.md (Work's notes, Chat's "About you"). */
async function notesDialog(kind) {
  let r;
  try { r = await call("GET", `/api/notes/${kind}`); } catch (e) { return toast(e.message); }
  const ta = h("textarea", { id: "notes-text", class: "notes-text", rows: 12, spellcheck: "true" });
  ta.value = r.text;
  dialog(kind === "chat" ? "About you" : "Notes for Claude", [
    h("p", { class: "note", style: "margin:0 0 6px" }, kind === "chat"
      ? "Claude reads this in every chat: your name, what you do, how you like answers."
      : `Claude reads this at the start of every Work task, and adds what it learns. It's ${r.path}.`),
    ta,
  ], "Save", async () => { await call("PUT", `/api/notes/${kind}`, { text: ta.value }); toast("Saved"); });
  setTimeout(() => ta.focus(), 0);
}

const reveal = (which) => call("POST", "/api/reveal", { which }).catch((e) => toast(e.message));
const megabytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

const SETTINGS_BUILD = {
  general: () => [
    setGroup("Appearance",
      setRow("Theme", null, segSetting("theme", [[null, "System"], ["light", "Light"], ["dark", "Dark"]])),
      setRow("Text size", null, segSetting("textSize", TEXT_SIZES)),
      setRow("Background", "A dot grid behind the chat that ripples while Claude works.", segSetting("motion", [["off", "Off"], ["subtle", "Subtle"], ["lively", "Lively"]]))),
    setGroup("Messages",
      setRow("Send with", null, segSetting("sendKey", [["enter", "Enter"], ["cmd", `${KEY()}Enter`]])),
      toggleSetting("playful", "Playful working words", "Skedaddling, Cooking… while Claude works. Off shows plain stages only.")),
    setGroup("Notifications",
      toggleSetting("notify", "Notifications", "When a thread finishes or Claude asks you something while B5 Code is in the background."),
      ...(native && window.deskFeatures?.includes("sound") ? [soundRows()].flat() : []),
      ...(browserNotifies() ? [browserNotifyRow()] : [])),
    S.phone ? null : setGroup(`This ${MAC()}`, loginRow()),
  ].filter(Boolean),

  chat: () => [
    setGroup("Chats",
      setRow("Model", "What a new chat starts with. Each chat can change its own.", modelSelect(SET.chatModel, (v) => setSetting("chatModel", v))),
      serverToggle("chatWeb", "Web search", "Claude can search the web and read pages to answer. Off: it answers from what it knows."),
      setRow("About you", "A few lines Claude reads in every chat: your name, what you do, how you like answers.",
        S.projects.some((p) => p.kind === "chat") ? macOnly(h("button", { class: "btn", type: "button", onclick: () => notesDialog("chat") }, "Edit…")) : h("span", { class: "set-desc" }, "After your first chat"))),
  ],

  code: () => [
    setGroup("While Claude works",
      serverToggle("keepAwake", `Keep the ${MAC()} awake`, `Stops the ${MAC()} going to sleep while a thread is working, so a long job isn't paused. Closing a laptop's lid still sleeps it.`),
      serverToggle("autoResume", "Carry on after a usage limit", "When a thread stops because your plan's limit is reached, B5 Code sends it on its way again once the limit resets.")),
    setGroup("New threads",
      setRow("Model", "What a new thread starts with. Each thread can change its own.", modelSelect(S.newModel, (v) => { S.newModel = v; store.set("newModel", v); warmedKey = ""; })),
      setRow("Free checks after each change", "Tests, typecheck and lint run by themselves after Claude edits files. Turned on for each project, in its settings (the gear beside its name).")),
    setGroup("Updates",
      serverToggle("autoUpdate", "Update by itself", "When B5 Code's code changes, it restarts into the new version as soon as nothing is running. Restart now carries working threads on afterwards.")),
  ],

  work: () => {
    const w = S.projects.find((p) => p.kind === "work");
    if (!w) return [setGroup("Work space", setRow("Start a Work space", "Documents, research, spreadsheets and files, made in ~/Documents/B5 Work.", macOnly(h("button", { class: "btn", type: "button", onclick: () => { document.querySelector(".set-overlay")?.b5close?.(); startWork(); } }, "Start"))))];
    return [setGroup("Work space",
      setRow("Folder", home(w.dir), macOnly(h("button", { class: "btn", type: "button", onclick: () => reveal("work") }, `Show in ${FINDER()}`))),
      setRow("Notes for Claude", "What Claude knows for every Work task: who you are, how you like things done. It adds what it learns.", macOnly(h("button", { class: "btn", type: "button", onclick: () => notesDialog("work") }, "Edit…"))))];
  },

  studio: () => {
    const status = h("span", { class: "set-status" }, "Checking…");
    const restart = macOnly(h("button", { class: "btn", type: "button", onclick: async (e) => {
      const b = e.currentTarget; b.disabled = true; b.textContent = "Restarting…";
      try { await call("POST", "/api/studio/restart"); toast("Studio's editor restarted"); refresh(); } catch (x) { toast(x.message); }
      b.disabled = false; b.textContent = "Restart";
    } }, "Restart"));
    const transcripts = h("span", { class: "set-status" }, "…");
    const cacheDesc = h("span", { class: "set-desc" }, "Light copies the editor plays, with waveforms and thumbnails. They're made again when needed.");
    const clear = macOnly(h("button", { class: "btn", type: "button", onclick: async () => { try { const r = await call("POST", "/api/studio/clear-cache"); toast("Cleared"); cacheDesc.textContent = `Light copies the editor plays, with waveforms and thumbnails. ${megabytes(r.cacheBytes || 0)} now.`; } catch (x) { toast(x.message); } } }, "Clear"));
    const folder = h("span", { class: "set-desc" }, "…");
    const refresh = () => call("GET", "/api/studio/status").then((st) => {
      status.className = "set-status " + (st.running ? "ok" : "");
      status.textContent = !st.dir ? `Not on this ${MAC()}` : st.running ? "Running" : "Stopped";
      folder.textContent = st.dir || `B5 Studio isn't on this ${MAC()} (looked for ~/Desktop/B5 Studio).`;
      transcripts.className = "set-status " + (st.transcripts ? "ok" : "");
      transcripts.textContent = !st.running ? "Start the editor to check" : st.transcripts ? "Set up" : "Not set up";
      if (st.running) cacheDesc.textContent = `Light copies the editor plays, with waveforms and thumbnails. ${megabytes(st.cacheBytes || 0)}.`;
    }, () => { status.textContent = "Unknown"; });
    refresh();
    return [
      setGroup("Editor",
        h("div", { class: "set-row" }, h("span", {}, h("span", { class: "set-title" }, "Editor"), h("span", { class: "set-desc" }, `Runs on this ${MAC()}, at 127.0.0.1:4320.`)), status, restart),
        serverToggle("studioAutostart", "Start with B5 Code", "The editor starts when B5 Code does, so Studio opens straight away."),
        h("div", { class: "set-row" }, h("span", {}, h("span", { class: "set-title" }, "Folder"), folder), macOnly(h("button", { class: "btn", type: "button", onclick: () => reveal("studio") }, `Show in ${FINDER()}`)))),
      setGroup("Footage",
        h("div", { class: "set-row" }, h("span", {}, h("span", { class: "set-title" }, "Transcripts"), h("span", { class: "set-desc" }, `Used for captions and removing ums, made on this ${MAC()}. Set up once in B5 Studio's folder: npm run setup-transcripts.`)), transcripts),
        h("div", { class: "set-row" }, h("span", {}, h("span", { class: "set-title" }, "Preview copies"), cacheDesc), clear)),
      setGroup("While a video is open",
        toggleSetting("studioRoom", "Make room", "Hide the sidebar and side pane while you edit, and bring them back on the videos list.")),
    ];
  },

  account: () => [
    setGroup("Claude accounts", accountsSection()),
    setGroup("Usage", setRow("Plan usage", "Your session and week, as Claude Code reports them.", usageRing(), h("button", { class: "btn", type: "button", onclick: openUsage }, "Details"))),
    S.phone ? setGroup("This phone", thisPhone()) : setGroup("Phone access", phoneSection()),
  ],
};

// ── Accounts (Settings) ──────────────────────────────────────────────────────
// The main account is whichever Claude Code is signed in to (~/.claude). Extra
// ones each have their own folder; when one reaches its usage limit, threads
// carry on with another (server/accounts.js).

function accountsSection() {
  const box = h("div", { class: "accts" });
  const draw = () => {
    const list = S.accounts?.length ? S.accounts : [{ id: "main", name: "Main", email: S.account?.email || "", plan: S.account?.plan || "", signedIn: !!S.account }];
    const extra = list.length > 1;
    // replaceChildren would draw a null as the word "null": only the rows that are there.
    fill(box, ...[
      ...list.map((a) => h("div", { class: "set-row" },
        h("span", {},
          h("span", { class: "set-title" }, a.id === "main" ? (a.email || "Not signed in") : `${a.name}${a.email && a.name !== a.email ? ` · ${a.email}` : ""}`),
          h("span", { class: "set-desc" }, [
            a.id === "main" ? "Main account: the one Claude Code is signed in to" : a.signedIn ? "Extra account" : "Signed out: remove it and add it again",
            a.plan, a.limitedUntil ? `at its usage limit until ${new Date(a.limitedUntil).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : "",
            a.notLinked?.length ? `not sharing: ${a.notLinked.join(", ")}` : "",
          ].filter(Boolean).join(" · "))),
        a.id === "main" && !a.signedIn && !S.phone ? h("button", { class: "btn primary", type: "button", onclick: () => signInDialog(draw) }, "Sign in…")
          : a.id === "main" || S.phone ? usageRow(a) : h("button", { class: "btn quiet", type: "button", style: "color:var(--bad)", onclick: () => removeAccountDialog(a, draw) }, "Remove"))),
      S.phone ? null : h("label", { class: "set-row" },
        h("span", {}, h("span", { class: "set-title" }, "More than one account"),
          h("span", { class: "set-desc" }, "Add your other Claude subscriptions, and carry a thread on with another when one reaches its usage limit. Check that your plan's terms allow it.")),
        h("input", { type: "checkbox", class: "switch", checked: S.settings?.extraAccounts ? true : null, onchange: async (e) => {
          try { S.settings = await call("POST", "/api/settings", { extraAccounts: e.target.checked }); S.accounts = (await call("GET", "/api/accounts")).accounts; draw(); }
          catch (x) { toast(x.message); e.target.checked = !e.target.checked; }
        } })),
      S.phone || !S.settings?.extraAccounts ? null : h("div", { class: "set-row" },
        h("span", {}, h("span", { class: "set-title" }, "Add another Claude account"),
          h("span", { class: "set-desc" }, "Another subscription of yours. Conversations, skills, memory and settings are shared; only the sign-in is its own.")),
        h("button", { class: "btn", type: "button", onclick: () => addAccountDialog(draw) }, "Add…")),
      extra ? serverToggle("autoSwitch", "Switch accounts at a usage limit", "When a thread stops at an account's limit, it carries on straight away with another account that isn't at its limit, in the same conversation. New threads start on the first account that isn't.") : null,
    ].filter(Boolean));
  };
  draw();
  return box;
}

/**
 * Sign in to Claude when Claude Code isn't: its sign-in page in the browser, then the code it shows
 * pasted here (`claude auth login`, run for you). B5 Code never sees the password.
 */
async function signInDialog(onDone) {
  let login = null;
  const step2 = h("div", { hidden: true });
  const code = h("input", { id: "scode", placeholder: "Paste the code here", autocomplete: "off", spellcheck: "false", style: "width:100%" });
  const linkRow = h("div", { class: "btns", style: "justify-content:flex-start;margin:6px 0 10px" });
  dialog("Sign in to Claude", [
    h("p", { class: "note", style: "margin:0 0 10px" }, "B5 Code works with your Claude subscription (Pro or Max) through Claude Code. You sign in on Claude's own page in your browser; B5 Code never sees your password."),
    step2,
  ], "Continue", async () => {
    if (!login) {
      login = await call("POST", "/api/accounts/main/sign-in", {});
      // Claude Code prints the sign-in link a moment after it starts.
      for (let i = 0; i < 40 && !login.url && login.state === "waiting"; i++) { await new Promise((r) => setTimeout(r, 300)); login = await call("GET", "/api/accounts/main/login"); }
      if (!login.url) {
        call("DELETE", "/api/accounts/main/login").catch(() => {});
        login = null;
        throw new Error("Claude Code didn't give a sign-in link. Press Continue to try again.");
      }
      fill(linkRow,
        h("a", { class: "btn primary", href: login.url, target: "_blank", rel: "noopener" }, icon("external", 13), "Open the sign-in page"),
        h("button", { class: "btn quiet", type: "button", onclick: () => copy(login.url) }, "Copy the link"));
      fill(step2, h("label", { for: "scode" }, "1. Sign in, and approve. 2. Copy the code the page shows. 3. Paste it here."), linkRow, code);
      step2.hidden = false;
      document.querySelector(".dialog .btn.primary[type=submit]").textContent = "Sign in";
      setTimeout(() => code.focus(), 0);
      throw Object.assign(new Error(""), { keepOpen: true });
    }
    let r;
    try { r = await call("POST", "/api/accounts/main/login", { code: code.value }); }
    catch (e) {
      // That sign-in has ended: Continue starts a new one.
      login = null; code.value = ""; step2.hidden = true;
      document.querySelector(".dialog .btn.primary[type=submit]").textContent = "Continue";
      throw new Error(`${e.message.replace(/ Start again,? and paste the whole code\.$/, "")} Press Continue to try again, and paste the whole code.`);
    }
    S.account = r.account; S.accounts = r.accounts;
    toast(`Signed in as ${r.account.email}`);
    onDone?.();
    render();
  }, () => { if (login) call("DELETE", "/api/accounts/main/login").catch(() => {}); });
}

/** Sign in another account: Claude Code's sign-in page in the browser, then its code pasted here. */
async function addAccountDialog(onDone) {
  const name = h("input", { id: "aname", placeholder: "Work", autocomplete: "off", style: "width:100%" });
  const email = h("input", { id: "aemail", placeholder: "Optional: fills in the sign-in page", type: "email", autocomplete: "off", style: "width:100%" });
  let login = null;
  const step2 = h("div", { hidden: true });
  const code = h("input", { id: "acode", placeholder: "Paste the code here", autocomplete: "off", spellcheck: "false", style: "width:100%" });
  const linkRow = h("div", { class: "btns", style: "justify-content:flex-start;margin:6px 0 10px" });
  dialog("Add a Claude account", [
    h("p", { class: "note", style: "margin:0 0 10px" }, "Sign in with your other subscription. In the browser, make sure you're signed in to claude.ai as that account (or use a private window), or you'll be signed in as this one again."),
    h("label", { for: "aname" }, "Name in B5 Code"), name,
    h("label", { for: "aemail" }, "Its email"), email,
    step2,
  ], "Continue", async () => {
    if (!login) {
      login = await call("POST", "/api/accounts", { name: name.value, email: email.value });
      // Claude Code prints the sign-in link a moment after it starts.
      for (let i = 0; i < 40 && !login.url && login.state === "waiting"; i++) { await new Promise((r) => setTimeout(r, 300)); login = await call("GET", `/api/accounts/${login.id}/login`); }
      if (!login.url) {
        // Start afresh next time: this sign-in is ended, not left waiting for a code.
        call("DELETE", `/api/accounts/${login.id}/login`).catch(() => {});
        login = null;
        throw new Error("Claude Code didn't give a sign-in link. Press Continue to try again.");
      }
      name.disabled = email.disabled = true;
      fill(linkRow, 
        h("a", { class: "btn primary", href: login.url, target: "_blank", rel: "noopener" }, icon("external", 13), "Open the sign-in page"),
        h("button", { class: "btn quiet", type: "button", onclick: () => copy(login.url) }, "Copy the link"));
      fill(step2, h("label", { for: "acode" }, "1. Sign in, and approve. 2. Copy the code the page shows. 3. Paste it here."), linkRow, code);
      step2.hidden = false;
      document.querySelector(".dialog .btn.primary[type=submit]").textContent = "Add account";
      setTimeout(() => code.focus(), 0);
      throw Object.assign(new Error(""), { keepOpen: true });
    }
    const r = await call("POST", `/api/accounts/${login.id}/login`, { code: code.value });
    S.accounts = r.accounts;
    toast("Account added");
    onDone?.();
    renderSide();
  }, () => { if (login) call("DELETE", `/api/accounts/${login.id}/login`).catch(() => {}); });
}

function removeAccountDialog(a, onDone) {
  dialog(`Remove ${a.name}?`, [h("p", { class: "note", style: "margin:0" }, `Signs ${a.email || "it"} out of B5 Code and removes its folder (${a.dir}). Your conversations, skills and settings stay: they're shared with your main account. Its threads move to your main account.`)],
    "Remove", async () => { const r = await call("DELETE", `/api/accounts/${a.id}`); S.accounts = r.accounts; onDone?.(); renderSide(); });
}

/** The composer's account label, with two or more accounts: which one the thread is on, and a menu to move it. */
function accountChip(t) {
  const el = $("acct");
  if (!el) return;
  const list = accountsShown();
  el.hidden = list.length < 2 || S.phone;
  if (el.hidden) return;
  const on = (S.accounts || []).find((a) => a.id === (t?.account || (t?.sessionId ? "main" : list.find((x) => x.next)?.id || "main")));
  el.textContent = ` · ${on ? shortName(on) : "Main"}${on?.limitedUntil || on?.full ? " (full)" : ""}`;
  el.title = t ? "This thread's Claude account. Click to move it to another." : "The account a new thread starts on: the first that isn't at its limit.";
  el.onclick = () => {
    if (!t) return;
    const menu = $("acct-menu");
    // A second click on the label closes the menu (and its one outside-click listener).
    if (!menu.hidden) { menu.hidden = true; document.removeEventListener("mousedown", menu.closer); return; }
    fill(menu, ...list.map((a) => h("button", { type: "button", role: "menuitemradio", "aria-checked": String(a.id === on?.id), class: a.id === on?.id ? "on" : "",
      onclick: async () => {
        menu.hidden = true;
        if (a.id === on?.id) return;
        try { Object.assign(t, await call("POST", `/api/threads/${t.id}/account`, { account: a.id })); render(); } catch (x) { toast(x.message); }
      } }, h("span", { class: "tick" }, a.id === on?.id ? icon("check", 14) : null),
      h("span", {}, h("div", { class: "m-name" }, shortName(a)), h("div", { class: "m-desc" }, [a.email, planShort(a.plan), accountState(a).text].filter(Boolean).join(" · "))))));
    menu.hidden = false;
    document.removeEventListener("mousedown", menu.closer);
    menu.closer = (e) => { if (!menu.contains(e.target) && e.target !== el) { menu.hidden = true; document.removeEventListener("mousedown", menu.closer); } };
    document.addEventListener("mousedown", menu.closer);
  };
}

/** Settings › Start B5 Code when you log in: a LaunchAgent, so the phone reaches the Mac after a restart. */
function loginRow() {
  const toggle = h("input", { type: "checkbox", class: "switch", disabled: true, "aria-label": "Start B5 Code when you log in",
    onchange: async (e) => {
      e.target.disabled = true;
      try { e.target.checked = (await call("POST", "/api/login-item", { on: e.target.checked })).on; toast(e.target.checked ? "B5 Code starts when you log in" : "B5 Code won't start by itself"); }
      catch (x) { toast(x.message); e.target.checked = !e.target.checked; }
      e.target.disabled = false;
    } });
  call("GET", "/api/login-item").then((r) => { toggle.checked = r.on; toggle.disabled = false; }, () => {});
  return h("label", { class: "set-row" },
    h("span", {}, h("span", { class: "set-title" }, "Start B5 Code when you log in"),
      h("span", { class: "set-desc" }, `It runs in the background after the ${MAC()} restarts, so your phone can reach it without you opening it first. Your threads, the queue and Tailscale access carry on.`)),
    toggle);
}

/** A setting the server acts on, kept with B5 Code's data rather than in this browser. */
function serverToggle(key, title, desc) {
  return h("label", { class: "set-row" },
    h("span", {}, h("span", { class: "set-title" }, title), h("span", { class: "set-desc" }, desc)),
    h("input", { type: "checkbox", class: "switch", checked: S.settings?.[key] !== false ? true : null, onchange: async (e) => {
      try { S.settings = await call("POST", "/api/settings", { [key]: e.target.checked }); } catch (x) { toast(x.message); e.target.checked = !e.target.checked; }
    } }));
}

/** Sound and a notification test, in the Mac app. */
function soundRows() {
  const pick = h("select", { class: "art-pick", "aria-label": "Sound", onchange: (e) => { setSetting("sound", e.target.value); playSound(e.target.value); } },
    h("option", { value: "", selected: !SET.sound }, "None"),
    ...SOUNDS.map((n) => h("option", { value: n, selected: SET.sound === n }, n)));
  const status = h("span", { class: "set-desc" }, "Sends one now, so you can see and hear it.");
  const STATUS = {
    on: "macOS shows B5 Code's notifications.",
    quiet: "macOS lets B5 Code notify, but only in Notification Centre, without banners. Change it in Notifications settings.",
    off: "macOS has notifications for B5 Code turned off. Turn them on in Notifications settings.",
    unasked: "macOS hasn't asked about B5 Code yet. Quit B5 Code (⌘Q), open it again, and click Allow.",
  };
  window.deskNotifyStatus = (st) => fill(status, STATUS[st] || st, " ",
    st === "on" ? "" : h("a", { href: "#", onclick: (e) => { e.preventDefault(); native.postMessage({ type: "openNotificationSettings" }); } }, "Open Notifications settings"));
  const test = h("button", { class: "btn small", type: "button", onclick: () => {
    native.postMessage({ type: "notify", title: "B5 Code", body: "This is how a finished thread looks." });
    playSound();
    native.postMessage({ type: "notifyStatus" });
  } }, "Test");
  return [
    h("div", { class: "set-row" }, h("span", {}, h("span", { class: "set-title" }, "Sound"), h("span", { class: "set-desc" }, "Played when a thread finishes or Claude asks you something.")), pick),
    h("div", { class: "set-row" }, h("span", {}, h("span", { class: "set-title" }, "Test the notification"), status), test),
  ];
}
const SOUNDS = ["Ping", "Glass", "Pop", "Tink", "Hero", "Purr", "Submarine", "Blow", "Bottle", "Frog", "Funk", "Morse", "Sosumi", "Basso"];

// ── Project settings ─────────────────────────────────────────────────────────

const connectorName = (n) => n.replace(/^claude\.ai /, "").replace(/^plugin:[^:]+:/, "").replace(/ - .*$/, "");

function openProjectSettings(p) {
  let connectors = p.connectors === "off" ? "off" : "on";
  const name = h("input", { value: p.name, "aria-label": "Project name", style: "width:220px" });
  const known = p.knownConnectors || [];
  const list = h("div", { class: "conn-list" });
  const drawList = () => fill(list, ...(known.length
    ? known.map((c) => h("span", { class: "conn" + (connectors === "off" ? " off" : "") , title: c.status }, connectorName(c.name)))
    : [h("span", { class: "set-desc" }, "The list appears after this project's first message.")]));
  drawList();
  const seg = h("div", { class: "seg", role: "radiogroup" }, ...[["on", "On"], ["off", "Off"]].map(([v, label]) =>
    h("button", { type: "button", role: "radio", "aria-checked": String(connectors === v), class: connectors === v ? "on" : "",
      onclick: async (e) => {
        connectors = v;
        seg.querySelectorAll("button").forEach((b) => { const on = b === e.currentTarget; b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on)); });
        drawList();
        try { await call("POST", `/api/projects/${p.id}`, { connectors: v }); p.connectors = v; toast(v === "off" ? "Connectors off: faster answers from the next message" : "Connectors on"); } catch (x) { toast(x.message); }
        warmedKey = "";
      } }, label)));
  sheet(`${p.name} settings`, [
    h("div", { class: "set-row" }, h("span", { class: "set-title" }, "Name"),
      h("span", { class: "btns" }, name, h("button", { class: "btn", type: "button", onclick: async () => {
        try { await call("POST", `/api/projects/${p.id}`, { name: name.value }); await loadState(); render(); toast("Renamed"); } catch (x) { toast(x.message); }
      } }, "Save"))),
    h("div", { class: "set-row" }, h("span", {}, h("span", { class: "set-title" }, "Folder"), h("span", { class: "set-desc mono-s" }, home(p.dir)))),
    h("div", { class: "set-section" }, "Connectors"),
    h("div", { class: "set-row" },
      h("span", {}, h("span", { class: "set-title" }, "Load connectors"),
        h("span", { class: "set-desc" }, "Gmail, Notion, Supabase and the rest. Off makes answers start a second or two sooner and more steadily (tested on Flaevo: about 5 s instead of 7 s for a short reply). Claude can still use the terminal, files and the web.")),
      seg),
    list,
    ...(p.kind === "work" ? [] : checksSettings(p)),
    S.phone ? null : h("div", { class: "set-section" }, "From the terminal"),
    S.phone ? null : h("div", { class: "set-row" },
      h("span", {}, h("span", { class: "set-title" }, "Continue a terminal conversation"), h("span", { class: "set-desc" }, "Bring in a conversation you started with claude in this folder, and carry on here.")),
      h("button", { class: "btn", type: "button", onclick: () => { document.querySelector(".overlay")?.b5close?.(); openImport(p); } }, "Choose…")),
    h("div", { class: "set-section" }, "Remove"),
    h("div", { class: "set-row" },
      h("span", {}, h("span", { class: "set-title" }, "Remove from B5 Code"), h("span", { class: "set-desc" }, `Its threads leave B5 Code. The folder and its files stay on your ${MAC()}.`)),
      h("button", { class: "btn", type: "button", style: "color:var(--bad)", onclick: async () => {
        try { await call("DELETE", `/api/projects/${p.id}`); document.querySelector(".overlay")?.remove(); S.threadId = null; await loadState(); render(); } catch (x) { toast(x.message); }
      } }, "Remove")),
  ]);
}

/** Project settings › Checks after each change: on or off, and the commands (one per line, "Name: command"). */
function checksSettings(p) {
  // What they run is the Mac's to say: on a phone it's shown, not changed.
  const ro = S.phone;
  const box = h("textarea", { rows: 3, class: "mono-s", "aria-label": "Checks, one per line", placeholder: "Tests: npm test\nTypecheck: npx tsc --noEmit", style: "width:100%", readonly: ro ? true : null });
  const on = h("input", { type: "checkbox", class: "switch", "aria-label": "Run checks after each change", disabled: ro ? true : null });
  const net = h("input", { type: "checkbox", class: "switch", "aria-label": "Checks can use the internet", disabled: ro ? true : null });
  const runs = h("div", { class: "checks-runs" });
  const note = h("span", { class: "set-desc" }, "Looking at this project…");
  let shown = [];
  const load = () => call("GET", `/api/projects/${p.id}/checks`).then((c) => {
    box.value = c.text;
    on.checked = c.on;
    net.checked = c.network;
    shown = c.runs;
    fill(runs, ...c.runs.map((r) => h("div", {}, h("span", { class: "review-label" }, r.name), h("pre", {}, r.runs))));
    note.textContent = ro ? `Change checks on the ${MAC()}.` : c.found.length ? `Found in this project: ${c.found.map((x) => x.name).join(", ")}.` : "None found: add your own, one per line.";
  }, () => { note.textContent = ""; });
  load();
  const save = async (patch) => { try { await call("POST", `/api/projects/${p.id}`, patch); toast("Saved"); } catch (x) { toast(x.message); } };
  // Turning them on approves exactly what's shown below; a check added later waits on a card.
  on.addEventListener("change", () => save(on.checked ? { checksOn: true, approve: shown.map((r) => r.runs) } : { checksOn: false }));
  net.addEventListener("change", () => save({ checksNetwork: net.checked }));
  return [
    h("div", { class: "set-section" }, "Checks after each change"),
    h("label", { class: "set-row" },
      h("span", {}, h("span", { class: "set-title" }, "Run them after Claude edits files"),
        h("span", { class: "set-desc" }, "B5 Code runs these itself, no tokens, in a sandbox: they can change files only in this project. A failure shows under the turn with Fix this, which sends Claude only what failed.")),
      on),
    h("label", { class: "set-row" },
      h("span", {}, h("span", { class: "set-title" }, "Checks can use the internet"),
        h("span", { class: "set-desc" }, `Off: they reach only this ${MAC()}. Turn on for tests that call real services.`)),
      net),
    box,
    h("div", { class: "set-row" }, note, ro ? null : h("button", { class: "btn", type: "button", onclick: async () => { await save({ checks: box.value }); load(); } }, "Save checks")),
    h("div", { class: "set-desc" }, "They run:"), runs,
  ];
}

// ── Phone access (Settings) ──────────────────────────────────────────────────

function phoneSection() {
  const box = h("div", { class: "phone-box" }, h("p", { class: "note" }, "Loading…"));
  const draw = (st, pair) => {
    const toggle = h("input", { type: "checkbox", class: "switch", checked: st.enabled ? true : null, "aria-label": "Phone access",
      onchange: async (e) => {
        try { draw(await call("POST", "/api/phone", { enabled: e.target.checked })); }
        catch (x) { toast(x.message); call("GET", "/api/phone").then((st) => draw(st), () => {}); } // shows it as it really is
      } });
    const kids = [
      h("label", { class: "set-row" },
        h("span", {}, h("span", { class: "set-title" }, "Use B5 Code from your phone"),
          h("span", { class: "set-desc" }, "Each phone is paired once with a code from here, and the connection is encrypted (HTTPS). The first time, the phone warns about B5 Code's own certificate; the pairing page has a link to install it so the warning stops.")),
        toggle),
    ];
    kids.push(...tailscaleRows(st, draw));
    if (st.enabled || st.tailscale?.on) {
      kids.push(h("div", { class: "set-row" },
        h("span", {}, h("span", { class: "set-title" }, "Pair a phone"), h("span", { class: "set-desc" },
          st.tailscale?.on ? `Open on the phone: ${st.tailscale.address}${st.enabled && st.addresses.length ? ` (or at home: ${st.addresses[0]})` : ""}`
            : st.addresses.length ? `Open on the phone: ${st.addresses.join(" or ")}` : `This ${MAC()} isn't on a network right now.`)),
        h("button", { class: "btn", type: "button", onclick: async () => { try { const r = await call("POST", "/api/phone/pair"); draw(r, r.pair); } catch (x) { toast(x.message); } } }, pair ? "New code" : "Show QR code")));
      if (pair) {
        const qr = qrcode(0, "M");
        qr.addData(pair.links[0] || "");
        qr.make();
        const mins = Math.max(1, Math.round((pair.expires - Date.now()) / 60000));
        kids.push(h("div", { class: "pair" },
          h("div", { class: "qr", html: qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true }) }),
          h("div", { class: "pair-side" },
            h("div", { class: "set-title" }, "Scan with the phone's camera"),
            h("div", { class: "set-desc" }, "Or open the address above on the phone and type:"),
            h("div", { class: "digits" }, pair.digits.slice(0, 3) + " " + pair.digits.slice(3)),
            h("div", { class: "set-desc" }, `Works once, for the next ${mins} min.`))));
      }
      kids.push(...(st.devices.length ? st.devices.map((d) => h("div", { class: "set-row" },
        h("span", {}, h("span", { class: "set-title" }, d.name), h("span", { class: "set-desc" }, `Paired ${new Date(d.createdAt).toLocaleDateString()} · last used ${ago(d.lastSeen || d.createdAt) === "now" ? "just now" : ago(d.lastSeen || d.createdAt) + " ago"}${d.push ? " · notifications on" : ""}`)),
        h("button", { class: "btn quiet", type: "button", style: "color:var(--bad)", onclick: async () => { try { draw(await call("DELETE", `/api/phone/devices/${d.id}`)); } catch (x) { toast(x.message); } } }, "Remove")))
        : [h("div", { class: "set-desc", style: "padding:4px 0 8px" }, "No phones paired yet.")]));
    }
    fill(box, ...kids);
  };
  call("GET", "/api/phone").then((st) => draw(st)).catch((x) => fill(box, h("p", { class: "note" }, x.message)));
  return box;
}

// ── Tailscale (Settings › Phone access, on the Mac) ──────────────────────────
// Reach B5 Code from anywhere: Tailscale serves it on the Mac's own name on
// your tailnet, with a real certificate (server/tailscale.js).

function tailscaleRows(st, redraw) {
  const ts = st.tailscale || {};
  const toggle = h("input", { type: "checkbox", class: "switch", checked: ts.on ? true : null, disabled: ts.busy || !ts.installed ? true : null, "aria-label": "Reach B5 Code from anywhere",
    onchange: async (e) => {
      e.target.disabled = true;
      note.textContent = e.target.checked ? "Setting up Tailscale…" : "Turning it off…";
      try { redraw(await call("POST", "/api/phone/tailscale", { enabled: e.target.checked })); }
      catch (x) { call("GET", "/api/phone").then((s) => redraw(s), () => {}); toast(x.message); }
    } });
  const desc = !ts.installed ? [`Install Tailscale on this ${MAC()} and on your phone, signed in to the same account. `, h("a", { href: "https://tailscale.com/download", target: "_blank", rel: "noopener" }, "Get Tailscale")]
    : ts.on ? [`On: ${ts.address}. Works on Wi‑Fi and away, with no certificate warning. Pair the phone with the code below if it isn't yet.`]
      : ["Your phone reaches B5 Code over Tailscale's private network, anywhere, with notifications. Nothing is opened to the internet."];
  const note = h("span", { class: "set-desc" }, ...desc);
  const rows = [h("label", { class: "set-row" }, h("span", {}, h("span", { class: "set-title" }, "Reach B5 Code from anywhere (Tailscale)"), note), toggle)];
  if (ts.problem) rows.push(h("div", { class: "set-row" }, h("span", { class: "set-desc", style: "color:var(--warn)" }, ts.problem, " ",
    ts.link ? h("a", { href: ts.link, target: "_blank", rel: "noopener" }, "Open Tailscale's page") : null)));
  return rows;
}

// ── This phone (Settings, on a paired phone) ─────────────────────────────────

let installPrompt = null; // Chrome's "install this app", kept until asked for
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; });

function thisPhone() {
  const box = h("div", { class: "phone-box" });
  const draw = async () => {
    const can = "serviceWorker" in navigator && "PushManager" in window && window.isSecureContext;
    const reg = can ? await navigator.serviceWorker.getRegistration() : null;
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    // The phone has a subscription the Mac doesn't (it was refused, or the phone was paired again): send it again.
    if (sub && !S.phone?.push && Notification.permission === "granted") {
      try { await call("POST", "/api/push/subscribe", { subscription: sub.toJSON() }); S.phone.push = true; } catch { /* shown as off */ }
    }
    // On only when both sides have it: the browser's subscription, and the server's copy (gone if the push service dropped it).
    const on = !!sub && !!S.phone?.push;
    const rows = [
      h("div", { class: "set-row" },
        h("span", {}, h("span", { class: "set-title" }, "Notifications"),
          h("span", { class: "set-desc" }, !can ? (S.phone?.via === "tailnet" ? "This browser can't show notifications from B5 Code." : `Open B5 Code at its Tailscale address (Settings on the ${MAC()}) to have notifications: they need its real certificate.`)
            : Notification.permission === "denied" ? "Blocked for this site in Chrome. Allow them in Chrome's site settings, then come back."
              : on ? "On: questions (with Allow / Don't allow), finished threads and account switches, when B5 Code isn't open in front of you." : "Questions with Allow / Don't allow, finished threads and account switches.")),
        can && Notification.permission !== "denied" ? h("span", { class: "btns" },
          on ? h("button", { class: "btn quiet", type: "button", onclick: async () => { try { await call("POST", "/api/push/test"); toast("Sent"); } catch (x) { toast(x.message); } } }, "Test") : null,
          h("button", { class: "btn", type: "button", onclick: async () => { try { await (on ? pushOff(sub) : pushOn()); draw(); } catch (x) { toast(x.message); } } }, on ? "Turn off" : "Turn on")) : null),
    ];
    const installed = matchMedia("(display-mode: standalone)").matches;
    rows.push(h("div", { class: "set-row" },
      h("span", {}, h("span", { class: "set-title" }, "B5 Code as an app"),
        h("span", { class: "set-desc" }, installed ? "Installed: opening from its icon." : installPrompt ? "Its own icon on your Home screen, full screen, without Chrome's bar." : "In Chrome's menu (⋮), choose Install app or Add to Home screen. It needs the Tailscale address.")),
      !installed && installPrompt ? h("button", { class: "btn", type: "button", onclick: async () => { installPrompt.prompt(); await installPrompt.userChoice.catch(() => {}); installPrompt = null; draw(); } }, "Install") : null));
    fill(box, ...rows);
  };
  draw().catch((x) => fill(box, h("p", { class: "note" }, x.message)));
  return box;
}

async function pushOn() {
  if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications weren't allowed.");
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await call("GET", "/api/push/key");
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)) });
  await call("POST", "/api/push/subscribe", { subscription: sub.toJSON() });
  if (S.phone) S.phone.push = true;
  toast("Notifications on");
}

async function pushOff(sub) {
  await sub?.unsubscribe().catch(() => {});
  await call("POST", "/api/push/unsubscribe");
  if (S.phone) S.phone.push = false;
}

// Which window is in front: the server holds the phone's notifications while you're looking at B5 Code.
let presenceSent = null;
function sendPresence() {
  const active = !document.hidden && document.hasFocus();
  if (active === presenceSent && !active) return;
  presenceSent = active;
  call("POST", "/api/presence", { active }).catch(() => {});
}
for (const ev of ["visibilitychange", "focus", "blur"]) window.addEventListener(ev, sendPresence);
setInterval(() => { if (!document.hidden && document.hasFocus()) { presenceSent = null; sendPresence(); } }, 45000);

function sheet(title, content) {
  enterSheet();
  const close = (fromBack) => { ov.remove(); document.removeEventListener("keydown", esc, true); if (!fromBack && narrow()) dropLayer(); };
  const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  const ov = h("div", { class: "overlay", onclick: (e) => { if (e.target === ov) close(); } },
    h("div", { class: "dialog settings", role: "dialog", "aria-modal": "true", "aria-label": title },
      h("div", { class: "set-head" }, h("h2", {}, title), h("button", { class: "icon", type: "button", "aria-label": "Close", onclick: () => close() }, icon("x", 16))),
      ...content));
  ov.b5close = close;
  document.body.append(ov);
  document.addEventListener("keydown", esc, true);
  requestAnimationFrame(() => ov.querySelector("button")?.focus());
}

document.addEventListener("keydown", (e) => {
  // In the terminal, Ctrl and Esc keys belong to the shell, and ⌘K / ⌘F to the terminal.
  if (e.target.closest?.(".term") && !((e.metaKey || (WIN() && e.ctrlKey)) && ["n", ",", "\\"].includes(e.key.toLowerCase()))) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "n") { e.preventDefault(); newInSpace(); return; }
  if (mod && e.key === ",") { e.preventDefault(); openSettings(); return; }
  if (mod && e.key === "\\") { e.preventDefault(); toggleSidebar(); return; }
  if (mod && e.key === "/") { e.preventDefault(); openGuide(); return; }
  if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
  if (e.key === "Escape" && !document.querySelector(".overlay") && !S.slash.open) {
    const t = thread();
    if (t && feedOf(t.id).working) { e.preventDefault(); stop(); }
    else $("app").classList.remove("side-open");
  }
});
window.addEventListener("beforeunload", saveDraft);
// Nothing moves while B5 Code isn't on screen.
document.addEventListener("visibilitychange", () => document.documentElement.classList.toggle("bg-paused", document.hidden));
window.addEventListener("focus", () => checkUpdate());
setInterval(checkUpdate, 60000);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { renderSide(); paneView?.terminal.retheme(); });
window.deskSettings = openSettings; // the Mac app's B5 Code > Settings… menu
window.deskToggleSidebar = toggleSidebar; // View > Toggle Sidebar

applySettings();
for (const [which, host] of [["side", $("side")], ["pane", $("pane")]]) {
  const handle = h("div", { class: `resize-handle ${which}-handle`, role: "separator", "aria-orientation": "vertical", "aria-label": `Resize ${which === "side" ? "sidebar" : "side pane"}`, title: "Drag to resize · double-click to reset",
    onpointerdown: (e) => startResize(which, e), onmousedown: (e) => e.preventDefault(), ondblclick: () => resetWidth(which) });
  host.after(handle);
  // The handle sits on the boundary, positioned against the app grid.
  handle.dataset.for = which;
}
(async () => {
  try {
    await loadState();
    if (S.threadId) await loadFeed(S.threadId);
  } catch (e) {
    toast(e.message);
  }
  // Shared from another app on the phone: a new Work chat with it.
  if (new URLSearchParams(location.search).get("share")) { history.replaceState(null, "", location.pathname); await takeShared(); }
  // Opened from a notification: straight to its thread.
  const wanted = new URLSearchParams(location.search).get("thread");
  if (wanted && S.threads.some((t) => t.id === wanted)) { history.replaceState(null, "", location.pathname); await openThread(wanted); }
  render();
  loadChanges();
  connect();
  checkUpdate();
  sendPresence();
  // On a paired phone: installable, offline page, notifications (web/sw.js).
  if (S.phone && "serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
    navigator.serviceWorker.addEventListener("message", (e) => { if (e.data?.type === "b5:open" && e.data.threadId) openThread(e.data.threadId); });
  }
  if (!S.phone) setTimeout(() => preloadTerminal().catch(() => {}), 1500);
})();
