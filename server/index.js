// B5 Code's server: the page, a small JSON API, and one Server-Sent Events
// stream that carries every thread's events to the open page.
//
// It listens on 127.0.0.1 only. Any web page in Safari can send requests to
// localhost, and this server can edit files and run commands, so every API
// call must carry the token printed into B5 Code's own page, and the Host header
// must be ours (which stops a DNS-rebinding page posing as localhost).

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store, addProject, addThread, addSide, updateThread, removeThread, titleFrom, updateProject, removeProject, projectArgs, addRecipe, removeRecipe, addAutomation, updateAutomation, removeAutomation, SERVER_DEFAULTS } from "./store.js";
import { cleanTrigger, scheduleDue, nextRun, describeTrigger, newFiles, runText } from "./automations.js";
import { detectChecks, parseChecks, checksText, checkResult, fixMessage, whatRuns, sortRuns, runKey, sandboxProfile } from "./checks.js";
import { ClaudeSession } from "./session.js";
import { LIVE_ONLY, limitResetAt } from "./events.js";
import { listSessions, sessionFile, importSession } from "./transcripts.js";
import { Awake } from "./awake.js";
import { setLoginItem, plistPath, setLoginItemWindows, startupLink } from "./login.js";
import { queueAllows, overnightBrief, queueBranch, nextTask, afterTurn, TASK_MINUTES, CHECK_MINUTES, STATUS_LABEL, queueSandboxSettings, checksSandboxProfile } from "./queue.js";
import { findCli, parseStatus as parseTailscaleStatus, serveArgs, serving, adminLink, tailnetOrigins, TAILNET_PREVIEW_HTTPS } from "./tailscale.js";
import { loadVapid, cleanSubscription, sendPush } from "./push.js";
import { MAIN, allAccounts, accountEnv, accountDir, newAccountId, pickAccount, firstReset, isLimited, ensureLinks, removeAccountDir, loginUrl, syncUserConfig } from "./accounts.js";
import { PREVIEW_TYPES, PASSIVE, previewPath as previewPathIn, previewScope, inScope, isPrivate } from "./preview.js";
import { UPLOAD_MAX, safeName, isUpload, buildContent } from "./attachments.js";
import { parseUsageText } from "./usage.js";
import os from "node:os";
import { emptyDevices, newPairing, redeem, deviceFor, removeDevice, deviceName } from "./devices.js";
import { Terminals, loadPty } from "./terminal.js";
import { parseStatus, parseNumstat, parseNameStatus, parseLog, splitDiff, ownCommits } from "./git.js";
import { ensureCertificate } from "./tls.js";
import { listFolder, readFile, allFiles, findFiles, inside } from "./files.js";
import { Artifacts, ARTIFACT } from "./artifacts.js";
import { cachedOverview as githubOverview } from "./github.js";
import { STUDIO_URL, studioAsk, studioDir, studioRunning, startStudio } from "./studio.js";
import { ASK_TOOL, questionsOf, cleanAnswers } from "../web/questions.js";
import { IS_WIN, HOME_DIR, realPath, appDataDir, expandHome, within, pagePath, claude, isShell, revealCommand, editorCommand, FILE_MANAGER } from "./platform.js";
import { branchName, createWorktree, prStatus, mergePr, removeWorktree, prTemplate, openPrPrompt, unpushedCommits } from "./branches.js";

// Preview can show the apps you run on this Mac (npm run dev on localhost:3000, …) and
// sites on the web. The frame is another origin and can't reach B5 Code or navigate it.
const DEV_SERVERS = "http://localhost:* http://127.0.0.1:* https:";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");
export const PORT = Number(process.env.B5_PORT || 4317);
const HOST = "127.0.0.1";
// The page's token, made once and kept in data/.token (readable only by
// you), so a restart of the server doesn't lock out a window that is
// already open. It was new on every start, and an open window then got
// "Bad token" on everything until it was reloaded.
function loadToken(dir) {
  const file = path.join(dir, ".token");
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{48}$/.test(t)) return t;
  } catch { /* first start */ }
  const t = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, t, { mode: 0o600 });
  return t;
}
const TOKEN = loadToken(process.env.B5_DATA || path.join(ROOT, "data"));
// A paired phone gets a token of its own, never the Mac's: derived from its pairing, so it dies with
// it (removing the phone), and it's only taken on the phone ports, with that phone's cookie.
const deviceToken = (deviceId) => crypto.createHmac("sha256", TOKEN).update(`device:${deviceId}`).digest("hex").slice(0, 48);
const tokenFor = (remote) => (remote ? deviceToken(remote.device.id) : TOKEN);
const sameToken = (a, b) => typeof a === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
// A second secret, only for the file preview. Previews run other pages'
// scripts, so they never see the API token. A link with this secret serves
// pictures, PDFs and videos only (nothing that runs code). A file opened in
// the Preview pane gets a link locked to its own folder instead
// (previewLink): a page can load its own images and scripts and keep its
// saved answers, but nothing else in your home folder, and nothing hidden
// or secret even in its own folder.
const PREVIEW_TOKEN = crypto.randomBytes(16).toString("hex");
const scopeToken = (scope) => crypto.createHmac("sha256", PREVIEW_TOKEN).update(scope).digest("hex").slice(0, 32);
const REAL_HOME = (() => { try { return realPath(HOME_DIR); } catch { return HOME_DIR; } })();
// Previews are served from their own port, so the browser treats them as a
// different site: a plan page keeps its own saved answers, and can't reach
// B5 Code's page or API.
const PREVIEW_PORT = PORT + 1;
const PREVIEW_ORIGIN = `http://localhost:${PREVIEW_PORT}`;
const HOME = HOME_DIR;
const MAC = IS_WIN ? "PC" : "Mac"; // what messages call the computer B5 Code runs on
const IDLE_MS = 15 * 60 * 1000; // close a quiet thread's process: 4 GB of RAM
const MAX_RUNNING = 3;
// Extra flags for every `claude` B5 Code starts, e.g. B5_CLAUDE_ARGS="--model opus".
const CLAUDE_ARGS = (process.env.B5_CLAUDE_ARGS || "").split(/\s+/).filter(Boolean);
const BODY_MAX = 2 * 1024 * 1024;
const CLAUDE_DIR = path.join(HOME, ".claude");
// Claude Code's task tools are on (accountEnv), but Claude reaches for them only now and then:
// B5 Code shows the list above the composer, so it's asked to keep one.
const TASKS_PROMPT = "B5 Code shows your task list above the message box, and the user follows your work there. For any request that takes three or more steps, start by loading the task tools (ToolSearch with \"select:TaskCreate,TaskUpdate\"), create one task per step, and mark each in_progress when you start it and completed when it's done.";
// A Work space's threads are told what kind of work it is: everyday work, made as files they can open.
const WORK_PROMPT = "This is the user's Work space in B5 Code: everyday work, not coding. Documents, research, spreadsheets, slides, organising files, drafting posts and emails. Save what you make as files in this folder, in a sensible subfolder, with clear names: a Word, PDF, Excel or PowerPoint file when the user asks for one (your document skills make them), otherwise Markdown. Say where each file is. Use the user's connectors (Google Drive, Google Docs and others) when the task involves them. Before moving, renaming or deleting more than a few files, list what you'll do and ask first. When you learn a lasting preference (how they name files, cite sources, the tone of their posts), add it to CLAUDE.md in this folder so the next task knows it.";
const WORK_DIR = process.env.B5_WORK_DIR || path.join(HOME, "Documents", "B5 Work"); // B5_WORK_DIR: elsewhere (tests)
// Chat: conversations, like claude.ai. Its own private folder (nothing of yours to change),
// whose CLAUDE.md is the "About you" note every chat reads; only reading and web tools.
// Not inside B5 Code's folder: then a chat isn't working inside a git repo (whose status every
// turn would carry) and isn't next to B5 Code's private data (pairing keys, the HTTPS key).
const CHAT_DIR = process.env.B5_CHAT_DIR || path.join(appDataDir(HOME), "Chat");
const CHAT_NOTES = "# About me\n\nClaude reads this at the start of every chat in B5 Code. Write what it should know: your name, what you do, how you like answers (short, detailed, with examples).\n\n";
const CHAT_PROMPT = "This is a chat in B5 Code: a conversation, like claude.ai, not a coding task. Answer directly and conversationally, in plain language, with Markdown where it helps (lists, a code block, a table). There's no project here: don't create or edit files, and don't look around this folder unless the user asks. You can search the web and read web pages when an answer needs current or specific facts; say where facts come from. CLAUDE.md in this folder is what the user wrote about themselves: use it to fit your answers to them.";
// Chat can't touch the Mac: no commands, no edits, and no reading files either (a page in a
// web search could otherwise steer it into reading something private and fetching a URL with
// it). Attachments arrive inside the message, so it doesn't need to. Sub-agents are off too.
const CHAT_TOOLS_OFF = ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Read", "Glob", "Grep", "Task", "Agent"];
const CHAT_WEB = ["WebSearch", "WebFetch"];
/** Chat's tools: the web when Settings allows it (without asking each time), nothing else; no
 *  connectors at all (Gmail, Notion… can change things), with each known one denied as well. */
const chatArgs = (project) => {
  if (project?.kind !== "chat") return [];
  const web = store.state.settings?.chatWeb !== false;
  const connectors = reviewRules();
  return [
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--disallowedTools", ...CHAT_TOOLS_OFF, ...(web ? [] : CHAT_WEB),
    ...(web ? ["--allowedTools", ...CHAT_WEB] : []),
    ...(connectors.length ? ["--settings", JSON.stringify({ permissions: { deny: connectors } })] : []),
  ];
};
const chatWebOn = () => store.state.settings?.chatWeb !== false;
const WORK_NOTES = "# How I like my work done\n\nClaude reads this at the start of every task in this Work space, and adds what it learns about how you like things.\nWrite anything it should always know: your name, your course, how you cite sources, how you name files, the tone of your posts.\n\n";
/**
 * The review step: in a Work space, each connector tool that changes something (a post, a
 * shared file, an edited doc) is an "ask" rule, so even auto mode stops for a yes (web/review.js).
 * Your connectors are the same everywhere, so the list is learned from any session's start, code
 * chats' too. Before any session has said, a Work session asks before every connector tool of the
 * connectors projects have seen (a rule per connector), reads included: chattier, never unreviewed.
 */
function reviewRules() {
  if (store.state.reviewTools?.length) return store.state.reviewTools;
  const seen = new Set(store.state.projects.flatMap((p) => (p.knownConnectors || []).map((c) => c.name)));
  return [...seen].map((n) => `mcp__${String(n).replace(/[^A-Za-z0-9_-]/g, "_")}`);
}
const reviewArgs = (project) => {
  const rules = project?.kind === "work" ? reviewRules() : [];
  return rules.length ? ["--settings", JSON.stringify({ permissions: { ask: rules } })] : [];
};
/** A session's start says which connector tools change something: kept for every Work session after it. */
function noteReviewTools(ev) {
  if (!Array.isArray(ev.review) || !ev.review.length || JSON.stringify(ev.review) === JSON.stringify(store.state.reviewTools || [])) return;
  store.save({ ...store.state, reviewTools: ev.review });
  // Work spaces' spares were warmed with the old rules: the next ones have these.
  for (const p of store.state.projects.filter((x) => x.kind === "work")) {
    const spare = spares.get(p.id);
    if (spare) { spares.delete(p.id); spare.session.close(); }
  }
}
/** The system prompt B5 Code adds for a thread: the task list, and what a Work space or a side chat is. */
const threadPrompt = (project, side) => [project?.kind === "chat" ? "" : TASKS_PROMPT, project?.kind === "work" ? WORK_PROMPT : project?.kind === "chat" ? CHAT_PROMPT : "", side ? SIDE_PROMPT : ""].filter(Boolean).join("\n\n");
// A side chat is told what it is, so it answers rather than takes over the work.
const SIDE_PROMPT = "This is a side chat, started from a copy of a conversation in B5 Code. The main conversation may still be working in the same folder. Answer the user's questions here. Don't edit files or run commands that change anything unless the user asks you to.";
// What a thread is sent when its plan's usage limit has reset, or when it moved to another account at one.
const RESUME_TEXT = "Your usage limit has reset. Carry on where you left off.";
const SWITCH_TEXT = "That account reached its usage limit, so this conversation moved to another Claude account. Carry on where you left off.";
const LIMIT_RETRY_MS = 30 * 60 * 1000;
/** A model name as Claude Code takes it (opus, claude-opus-5-5[1m]…), or null: never one that reads as an option. */
const cleanModel = (m) => (typeof m === "string" && /^[A-Za-z0-9][\w.\-[\]]{0,79}$/.test(m) ? m : null); // the limit stopped it but gave no time: try again then

const store = new Store(process.env.B5_DATA || path.join(ROOT, "data"));
const UPLOADS = path.join(store.dataDir, "uploads");
fs.mkdirSync(UPLOADS, { recursive: true });

// Who is signed in to Claude Code, for the account row in the sidebar: the
// main account (~/.claude) and any extra ones (server/accounts.js). Read at
// start, every 10 minutes and after a sign-in; `claude auth status` prints JSON.
let account = null; // the main account's, as the page has always had it
const accountInfo = new Map(); // account id -> { signedIn, email, plan, org, notLinked }
const accountById = (id) => allAccounts(store.state).find((a) => a.id === id) || null;
// An account counts as signed in until `claude auth status` says otherwise (it takes a few
// seconds after a start, and a status call that fails says nothing either way).
const signedIn = (id) => accountInfo.get(id)?.signedIn ?? !!accountById(id);

/**
 * Until when an account's usage is full, going by its meters (the latest
 * rate-limit event, or a recent /usage): a window at 100% means a turn there
 * would be refused, so new work goes elsewhere before it is. -1: full, with
 * no reset time known. 0: not full.
 */
function fullUntil(id, now = Date.now()) {
  const live = liveUsageBy.get(id);
  if (live && now - live.at < 6 * 3600 * 1000) {
    if (live.status === "rejected" && live.resetsAt > now) return live.resetsAt;
    for (const w of [live.fiveHour, live.week]) if (w && w.used >= 1 && w.resetsAt > now) return w.resetsAt;
  }
  const plan = planUsageBy.get(id);
  // /usage is read every 10 minutes; one older than 20 may be from before a reset.
  // Only the windows every model shares: a full "Week · Opus" still leaves the account other models.
  if (plan && now - plan.at < 20 * 60 * 1000 && plan.windows.some((w) => (w.label === "Session" || w.label === "Week") && w.used >= 1)) return -1;
  return 0;
}
/** An account new work can go to: signed in, and its meters not full. */
const usable = (id) => signedIn(id) && !fullUntil(id);

function authStatus(acct) {
  return new Promise((resolve) => {
    execFile(claude()[0], [...claude()[1], "auth", "status"], { timeout: 15000, env: accountEnv(process.env, acct) }, (err, out) => {
      if (err && !out) return resolve(null);
      try {
        const a = JSON.parse(out);
        resolve({ signedIn: !!a.loggedIn, email: a.email || "", plan: a.loggedIn ? planName(a.subscriptionType) : "", org: a.orgName || "" });
      } catch { resolve(null); } // older output: no account row
    });
  });
}

async function loadAccount(acct = null) {
  for (const a of acct ? [acct] : allAccounts(store.state)) {
    // Removed while an earlier one was being asked: leave it gone.
    if (!accountById(a.id)) continue;
    let notLinked = [];
    try {
      // An extra account's links to ~/.claude are put right first (a missing one would hide its conversations).
      if (a.dir) notLinked = ensureLinks(fs, CLAUDE_DIR, a.dir);
      if (a.dir) syncUserConfig(fs, path.join(HOME, ".claude.json"), path.join(a.dir, ".claude.json"));
    } catch (e) {
      console.error(`Account ${a.id}: ${e.message}`);
      notLinked = [`(couldn't link: ${e.message})`];
    }
    const info = await authStatus(a);
    if (!info || !accountById(a.id)) continue;
    accountInfo.set(a.id, { ...info, notLinked });
    if (a.id === MAIN) account = info.signedIn ? { email: info.email, plan: info.plan, org: info.org } : null;
  }
}
export function planName(type) {
  const t = String(type || "").toLowerCase();
  return { pro: "Claude Pro", max: "Claude Max", team: "Claude Team", enterprise: "Claude Enterprise", free: "Claude Free" }[t] || (t ? `Claude ${t[0].toUpperCase()}${t.slice(1)}` : "Claude");
}

// Plan usage, as the Claude app shows it: Claude Code's /usage, which makes
// no model call, for each signed-in account. Read at start, every 10
// minutes, and when the meter is clicked; a turn's rate-limit events update
// it in between.
let planUsage = null; // the main account's
const planUsageBy = new Map(); // account id -> its /usage
const usageRunning = new Set();
function refreshUsage() {
  for (const a of allAccounts(store.state)) {
    if (usageRunning.has(a.id) || !signedIn(a.id)) continue;
    usageRunning.add(a.id);
    execFile(claude()[0], [...claude()[1], "-p", "/usage", "--output-format", "json"], { cwd: HOME, timeout: 90000, maxBuffer: 8 << 20, env: accountEnv(process.env, a) }, (err, out, errOut) => {
      usageRunning.delete(a.id);
      // Said in the log: a meter that silently stops updating looks like a wrong one.
      const fail = (why) => console.error(`Usage (${a.id}): ${why}`);
      if (err) return fail(`${err.killed ? "timed out" : `exit ${err.code}`}: ${String(errOut || out || err.message).trim().slice(-300)}`);
      let text = "";
      try { text = JSON.parse(out).result || ""; } catch { return fail(`not JSON: ${String(out).slice(0, 200)}`); }
      const parsed = parseUsageText(text);
      if (!parsed) return fail(`no meters in: ${text.slice(0, 200)}`);
      const u = { ...parsed, at: Date.now() };
      planUsageBy.set(a.id, u);
      if (a.id === MAIN) planUsage = u;
      broadcast(null, { kind: "plan-usage", account: a.id, ...u });
      broadcast(null, { kind: "accounts", accounts: accountsView() });
    });
  }
}
loadAccount().catch((e) => console.error(`Accounts: ${e.message}`)).then(refreshUsage);
setInterval(() => loadAccount().catch((e) => console.error(`Accounts: ${e.message}`)), 10 * 60 * 1000);
setInterval(refreshUsage, 10 * 60 * 1000);
// An account at (or near) its limit is read every 2 minutes, so its reset shows within minutes.
setInterval(() => {
  const near = allAccounts(store.state).some((a) => isLimited(store.state.accountLimits, a.id) || (planUsageBy.get(a.id)?.windows || []).some((w) => (w.label === "Session" || w.label === "Week") && w.used >= 0.9));
  if (near) refreshUsage();
}, 2 * 60 * 1000);

function gitBranch(dir) {
  return new Promise((resolve) => {
    execFile("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 3000 }, (err, out) => resolve(err ? "" : out.trim()));
  });
}

// Each project's branch for the sidebar, without a git process per project
// on every refresh: a known branch is answered at once and looked up again
// behind it once it's a few seconds old.
const branches = new Map(); // dir -> { branch, at, pending }
function projectBranch(dir) {
  const c = branches.get(dir);
  if (c && Date.now() - c.at < 5000) return c.branch;
  const lookup = c?.pending || gitBranch(dir).then((branch) => { branches.set(dir, { branch, at: Date.now(), pending: null }); return branch; });
  if (c) { c.pending = lookup; return c.branch; }
  branches.set(dir, { branch: "", at: 0, pending: lookup });
  return lookup;
}
const sessions = new Map(); // threadId -> { session, idleTimer }
const runningTasks = new Map(); // threadId -> ids of its background commands and agents still running
const artifacts = new Artifacts(path.join(store.dataDir, "artifacts"));
const clients = new Set(); // open SSE responses

function broadcast(threadId, event) {
  const data = `data: ${JSON.stringify({ threadId, event })}\n\n`;
  for (const res of clients) res.write(data);
}

// The Terminal pane. Its output goes to the Mac's page only: a paired phone
// never sees a shell, and can't type into one.
const pty = loadPty(ROOT);
const terminals = new Terminals({
  spawn: pty.spawn,
  onData: (id, { seq, data }) => broadcastLocal({ terminal: id, seq, data }),
  onExit: (id, { code }) => broadcastLocal({ terminal: id, exit: code }),
});
function broadcastLocal(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) if (!res.b5Remote) res.write(data);
}
/** A terminal's folder: its thread's own worktree, or its project's. */
function terminalDir(id) {
  const thread = store.state.threads.find((t) => t.id === id);
  const project = store.state.projects.find((p) => p.id === (thread ? thread.projectId : id));
  if (!project) throw Object.assign(new Error("No such thread or project."), { status: 404 });
  // A removed worktree is said so, not swapped for the project's checkout,
  // where you might carry on without noticing you're on another branch.
  if (thread?.dir && !fs.existsSync(thread.dir)) throw Object.assign(new Error("This thread's worktree has been removed, so it has no terminal. Start a new thread to carry on."), { status: 410 });
  return thread?.dir || project.dir;
}

// A spare per project: a fresh `claude` already loaded for the next new
// thread there, started when you open a new thread, taken by its first message.
const spares = new Map(); // projectId -> { session, timer }
let usage = null; // the main account's latest usage, from rate_limit_event
const liveUsageBy = new Map(); // account id -> its latest rate_limit_event

/**
 * The account a thread works on: the one it's on, or (a thread not yet
 * started) the first that's signed in and not at its limit. Threads from
 * before accounts were added are on the main one.
 */
function accountFor(thread) {
  const have = thread.account && accountById(thread.account);
  // An account signed out since (an expired sign-in) can't carry the thread: another one does.
  if (have && signedIn(have.id)) return have;
  if (thread.sessionId && !have) return accountById(MAIN);
  return pickAccount(allAccounts(store.state), store.state.accountLimits, usable) || accountById(MAIN);
}

function sessionFor(thread) {
  const have = sessions.get(thread.id);
  const project = store.state.projects.find((p) => p.id === thread.projectId);
  // A chat started before web search was switched on or off is started again (when it isn't mid-turn).
  if (have && project?.kind === "chat" && have.chatWeb !== chatWebOn() && !have.session.busy) closeSession(thread.id);
  else if (have) return have.session;
  if (!project) throw new Error("This thread's project is gone.");
  if (thread.dir && !fs.existsSync(thread.dir)) throw new Error("This thread's worktree has been removed. Start a new thread to carry on.");
  const acct = accountFor(thread);
  if (thread.account !== acct.id) {
    store.save(updateThread(store.state, thread.id, { account: acct.id }, thread.updatedAt));
    // Its account was signed out: it carries on with this one, and says so.
    if (thread.account && accountById(thread.account)) {
      const ev = { kind: "account", from: thread.account, to: acct.id, fromName: accountLabel(accountById(thread.account)), toName: accountLabel(acct), why: "signed-out" };
      store.appendLog(thread.id, ev);
      broadcast(thread.id, ev);
    }
  }
  if (sessions.size >= MAX_RUNNING) closeOldestIdle();
  let session;
  const spare = spares.get(project.id);
  // The spare runs in the project folder, so a thread on its own branch never takes it.
  if (!thread.sessionId && !thread.dir && !thread.sideOf && spare && spare.session.running && (spare.session.model || null) === (thread.modelPref || null) && spare.session.account === acct.id) {
    clearTimeout(spare.timer);
    spares.delete(project.id);
    session = spare.session;
    session.removeAllListeners("event");
    session.removeAllListeners("exit");
  } else {
    // A side chat's first start forks its parent's conversation; after that it resumes its own.
    // One --append-system-prompt: a second would replace the first.
    const side = ["--append-system-prompt", threadPrompt(project, !!thread.sideOf), ...reviewArgs(project)];
    // A queued task works unattended, inside Claude Code's sandbox (server/queue.js).
    // Only while the task is the queue's: once it's done, the thread is the owner's (Open PR pushes).
    const qt = thread.queueTask && queueState().tasks.find((x) => x.id === thread.queueTask);
    if (qt && ["queued", "running", "paused"].includes(qt.status)) {
      // Every step asks (your own auto mode would approve most by itself), so the overnight list decides.
      side.push("--permission-mode", "default");
      side.push("--settings", JSON.stringify(queueSandboxSettings({ home: HOME, dataDir: store.dataDir, projectDir: project.dir, worktree: qt.dir, gitDir: qt.gitDir, commonDir: qt.commonDir, shared: qt.shared })));
    }
    session = new ClaudeSession({ cwd: thread.dir || project.dir, sessionId: thread.sessionId || thread.forkFrom || null, fork: !thread.sessionId && !!thread.forkFrom,
      extraArgs: [...CLAUDE_ARGS, ...projectArgs(project), ...chatArgs(project), ...side], model: thread.modelPref || null, env: accountEnv(process.env, acct), account: acct.id });
  }
  session.on("event", (ev) => onEvent(thread.id, session, ev));
  session.on("exit", () => forgetSession(thread.id, session));
  sessions.set(thread.id, { session, idleTimer: null, chatWeb: project.kind === "chat" ? chatWebOn() : undefined });
  if (session.sessionId && session.sessionId !== thread.sessionId) store.save(updateThread(store.state, thread.id, { sessionId: session.sessionId }));
  return session;
}

function warmSpare(projectId, model = null) {
  const project = store.state.projects.find((p) => p.id === projectId);
  if (!project) throw Object.assign(new Error("No such project."), { status: 404 });
  // On the account the next new thread would get.
  const acct = pickAccount(allAccounts(store.state), store.state.accountLimits, usable) || accountById(MAIN);
  const have = spares.get(projectId);
  if (have && have.session.running && (have.session.model || null) === (model || null) && have.session.account === acct.id) { armSpare(projectId); return; }
  if (have) { have.session.close(); spares.delete(projectId); }
  const session = new ClaudeSession({ cwd: project.dir, extraArgs: [...CLAUDE_ARGS, ...projectArgs(project), ...chatArgs(project), "--append-system-prompt", threadPrompt(project, false), ...reviewArgs(project)], model: model || null, env: accountEnv(process.env, acct), account: acct.id });
  session.on("event", (ev) => {
    if (ev.kind === "init") noteReviewTools(ev); // a spare's start says which tools to review, too
    if (ev.kind === "commands" || ev.kind === "usage") onEvent(null, session, ev, projectId);
  });
  session.on("exit", () => { if (spares.get(projectId)?.session === session) spares.delete(projectId); });
  spares.set(projectId, { session, timer: null });
  session.warm();
  armSpare(projectId);
}

function armSpare(projectId) {
  const s = spares.get(projectId);
  if (!s) return;
  clearTimeout(s.timer);
  s.timer = setTimeout(() => { s.session.close(); spares.delete(projectId); }, 10 * 60 * 1000);
}

function closeOldestIdle() {
  for (const [id, s] of sessions) {
    if (!s.session.busy) { closeSession(id); return; }
  }
}

// A thread's process is tracked in `sessions` until it is closed or exits.
// Both go through these two, which only ever drop the entry if it is still
// that process: a process closed earlier must not untrack the one that
// replaced it (Stop and permission answers would then reach nothing).
function forgetSession(threadId, session) {
  const s = sessions.get(threadId);
  if (!s || s.session !== session) return;
  clearTimeout(s.idleTimer);
  sessions.delete(threadId);
  // Its background work went with the process.
  for (const id of runningTasks.get(threadId) || []) {
    const ev = { kind: "task_status", id, status: "stopped", at: Date.now() };
    if (store.state.threads.some((t) => t.id === threadId)) store.appendLog(threadId, ev);
    broadcast(threadId, ev);
  }
  if (runningTasks.delete(threadId)) updateAwake();
}
function closeSession(threadId) {
  const s = sessions.get(threadId);
  if (!s) return;
  forgetSession(threadId, s.session);
  s.session.close();
}

function onEvent(threadId, session, ev, spareProjectId = null) {
  if (ev.kind === "usage") {
    if (threadId) lastUsage.set(threadId, ev);
    const u = { ...ev, account: session.account, at: Date.now() };
    liveUsageBy.set(session.account, u);
    if (session.account === MAIN) usage = u;
    broadcast(null, u);
    return;
  }
  if (ev.kind === "commands") {
    // Skills differ per folder (a project's own .claude/skills), so the list
    // is kept per project, and saved so the "/" menu works before a message.
    const t = store.state.threads.find((x) => x.id === threadId);
    const projectId = t?.projectId || spareProjectId;
    if (projectId) {
      store.save({
        ...store.state,
        commands: { ...(store.state.commands || {}), [projectId]: ev.list },
        ...(ev.models?.length ? { models: ev.models } : {}),
      });
    }
    broadcast(threadId, { ...ev, projectId });
    return;
  }
  if (!threadId) return;
  if (ev.kind === "init" && ev.sessionId) {
    const t = store.state.threads.find((x) => x.id === threadId);
    if (t && t.sessionId !== ev.sessionId) store.save(updateThread(store.state, threadId, { sessionId: ev.sessionId, model: ev.model }));
    // Remember which connectors this project loads, for Project settings.
    const p = t && store.state.projects.find((x) => x.id === t.projectId);
    if (p && ev.connectors?.length) store.save(updateProject(store.state, p.id, { knownConnectors: ev.connectors }));
    noteReviewTools(ev);
  }
  // A queued task's question: answered for the owner when it's on the overnight list; otherwise the task waits.
  if (ev.kind === "permission" && queueAnswered(threadId, session, ev)) return;
  // A thread deleted while its process winds down: nothing more is kept.
  if (!store.state.threads.some((t) => t.id === threadId)) return;
  if (ev.kind === "tool") {
    const t = store.state.threads.find((x) => x.id === threadId);
    artifacts.noteTool(ev, t?.dir || store.state.projects.find((p) => p.id === t?.projectId)?.dir);
  }
  // How full the conversation is: the last request's context plus what it wrote,
  // kept with the finished turn so it's there when the thread is opened again.
  if (ev.kind === "message_start" && ev.context) contextNow.set(threadId, { input: ev.context, output: 0 });
  if (ev.kind === "tokens" && contextNow.has(threadId)) contextNow.get(threadId).output = ev.output;
  if (ev.kind === "done" && contextNow.has(threadId)) {
    const c = contextNow.get(threadId);
    ev = { ...ev, context: c.input + c.output };
    contextNow.delete(threadId);
  }
  // Background work: when it started (the page counts from there), and what's still running.
  if (ev.kind === "task_start" || ev.kind === "task_status") {
    ev = { ...ev, at: Date.now() };
    const running = runningTasks.get(threadId) || new Set();
    if (ev.kind === "task_start") running.add(ev.id);
    else if (ev.status !== "running") running.delete(ev.id);
    if (running.size) runningTasks.set(threadId, running); else runningTasks.delete(threadId);
  }
  // The finished turn's commits, for its receipt.
  // The turn's commits follow it (their receipt takes them; see "commits" in web/feed.js).
  if (ev.kind === "done" && !ev.more) turnCommits(threadId).then((commits) => { if (commits?.length) emit(threadId, { kind: "commits", commits }); }).catch(() => {});
  if (!LIVE_ONLY.has(ev.kind) && ev.kind !== "init") store.appendLog(threadId, ev);
  const inbox = ev.more ? null : trackForInbox(threadId, ev);
  if (ev.kind === "done" && !ev.more) armIdle(threadId);
  if (ev.kind === "done" || ev.kind === "user" || ev.kind === "task_start" || ev.kind === "task_status") updateAwake();
  if ((ev.kind === "done" && !ev.more) || ev.kind === "task_status") setTimeout(() => updateIfIdle().catch(() => {}), 2000); // an update waiting on this turn
  if (ev.kind === "done" && !ev.more) automationDone(threadId);
  if (ev.kind === "tool" && ev.change) turnEdited.add(threadId);
  if (ev.kind === "done" && !ev.more && turnEdited.delete(threadId) && ev.ok) checksAfterTurn(threadId).catch((e) => console.error(`Checks: ${e.message}`));
  // The page takes the inbox's facts from here rather than working them out again.
  broadcast(threadId, inbox ? { ...ev, inbox } : ev);
  // The thread's facts are saved by now (the finished turn's reply), so the phone gets them right.
  if (ev.kind === "permission" || ev.kind === "done") pushFor(threadId, ev);
  // A page Claude just wrote or changed: kept as a version, and shown as a card.
  const art = artifacts.noteResult(ev);
  if (art) { store.appendLog(threadId, art); broadcast(threadId, art); }
  if (ev.kind === "done" && !ev.ok && !ev.more) noteLimit(threadId, ev, session);
  // A turn that went through: its account isn't at its limit, whatever was thought.
  if (ev.kind === "done" && ev.ok && !ev.more && isLimited(store.state.accountLimits, session.account)) setLimit(session.account, 0);
  if (ev.kind === "done" && !ev.more) lastUsage.delete(threadId); // only a turn's own refusal counts
  // A queued task's turn has ended: its checks, then done, another try, or stuck.
  if (ev.kind === "done" && !ev.more) queueAfterTurn(threadId, ev).catch((e) => console.error(`Queue: ${e.message}`));
}

// ── Usage limits ─────────────────────────────────────────────────────────────
// A turn the plan's limit stopped carries on by itself once the limit resets
// (Settings › Carry on after a usage limit): the thread is sent RESUME_TEXT.
// The time is kept on the thread, so a restart of B5 Code keeps it.

const lastUsage = new Map(); // threadId -> the latest rate-limit event its process sent
const turnHeads = new Map(); // threadId -> { dir, sha }: where HEAD was when its turn began, for the receipt's commits

/**
 * The model a new thread runs when none is chosen: the "model" in Claude Code's
 * settings for the account it would get ("opus[1m]", say), or "" for Claude
 * Code's own default. The page names it, rather than Claude Code's "Default"
 * entry, which describes a model your setting may override.
 */
function defaultModel() {
  const acct = pickAccount(allAccounts(store.state), store.state.accountLimits, usable) || accountById(MAIN);
  const dir = acct.id === MAIN ? process.env.CLAUDE_CONFIG_DIR || CLAUDE_DIR : acct.dir;
  try { return cleanModel(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).model) || ""; } catch { return ""; }
}

/** The commits a turn made: those since its starting HEAD, newest first (a few ms of git, once a turn). */
async function turnCommits(threadId) {
  const start = turnHeads.get(threadId);
  turnHeads.delete(threadId);
  if (!start?.sha) return undefined;
  // Off the event loop: a slow repo mustn't stall every stream and request while it answers.
  const [out, branch] = await Promise.all([
    git(["log", "--format=%h%x1f%s%x1f%ct", "-z", "-n", "20", `${start.sha}..HEAD`], start.dir),
    git(["rev-parse", "--abbrev-ref", "HEAD"], start.dir),
  ]);
  return ownCommits(parseLog(out), start.at).map((c) => ({ sha: c.sha, subject: c.subject, branch })); // not what a pull brought in
}

function noteLimit(threadId, ev, session) {
  const at = limitResetAt(lastUsage.get(threadId), ev.error);
  lastUsage.delete(threadId);
  if (!at) return;
  // The account is at its limit until then (a guess when no time was given), for every thread on it.
  const until = at > 0 ? Math.max(at, Date.now()) : Date.now() + LIMIT_RETRY_MS;
  setLimit(session.account, until);
  // Another account that's signed in and not at its limit: carry on there now.
  if (store.state.settings?.autoSwitch !== false) {
    const other = pickAccount(allAccounts(store.state), store.state.accountLimits, usable);
    if (other && other.id !== session.account) {
      try {
        moveThread(threadId, other.id, "limit");
        sendToThread(store.state.threads.find((t) => t.id === threadId), SWITCH_TEXT, [], { auto: "switch" });
        return;
      } catch (e) { console.error(`Moving ${threadId} to another account: ${e.message}`); }
    }
  }
  if (!store.state.settings?.autoResume) return;
  // Every account refusing: wait for the first to reset, a minute past it so the first request isn't refused again.
  // Switching off: the thread stays on its own account, so it waits for that one.
  const first = (store.state.settings?.autoSwitch !== false ? firstReset(allAccounts(store.state), store.state.accountLimits, signedIn, Date.now()) : 0) || until;
  setResume(threadId, { at: first + 60 * 1000, known: at > 0 });
}

/** An account at its limit until `until` (0: not any more). Kept with B5 Code's state, so a restart keeps it. */
function setLimit(accountId, until) {
  const limits = { ...(store.state.accountLimits || {}) };
  if (until) limits[accountId] = until; else delete limits[accountId];
  store.save({ ...store.state, accountLimits: limits });
  broadcast(null, { kind: "account-limits", limits });
  broadcast(null, { kind: "accounts", accounts: accountsView() });
}

/**
 * Put a thread on another account. Its idle process goes; the next message
 * resumes the same conversation on the new account (conversations are
 * shared, see server/accounts.js). The thread says why, as a note.
 */
function moveThread(threadId, accountId, why) {
  const t = store.state.threads.find((x) => x.id === threadId);
  const to = accountById(accountId);
  if (!t || !to) throw new Error("No such thread or account.");
  if (sessions.get(threadId)?.session.busy) throw Object.assign(new Error("This thread is working. Move it when it's done."), { status: 409 });
  const from = accountFor(t);
  if (from.id === to.id) return false;
  closeSession(threadId);
  store.save(updateThread(store.state, threadId, { account: to.id }, t.updatedAt));
  const ev = { kind: "account", from: from.id, to: to.id, fromName: accountLabel(from), toName: accountLabel(to), why };
  store.appendLog(threadId, ev);
  broadcast(threadId, ev);
  pushFor(threadId, ev);
  return true;
}

const accountLabel = (a) => (a.id === MAIN ? accountInfo.get(MAIN)?.email || "Main" : a.name || accountInfo.get(a.id)?.email || "Other account");

/** Set or clear (null) when a thread carries on, and tell the page. */
function setResume(threadId, resume, why = "", detail = "") {
  const t = store.state.threads.find((x) => x.id === threadId);
  if (!t || (!resume && !t.resume)) return;
  store.save(updateThread(store.state, threadId, { resume }));
  const ev = resume ? { kind: "limit", resumeAt: resume.at, known: resume.known } : { kind: "limit_cleared", why, ...(detail ? { detail } : {}) };
  store.appendLog(threadId, ev);
  broadcast(threadId, ev);
  if (resume) pushFor(threadId, ev);
}

function resumeDue() {
  for (const t of store.state.threads) {
    if (!t.resume || t.resume.at > Date.now() || sessions.get(t.id)?.session.busy) continue;
    try { carryOn(t); } catch (e) { console.error(`Carrying on ${t.id}: ${e.message}`); }
  }
}

/** Send a waiting thread on its way. Its card says so only once the message is really sent. */
function carryOn(t, { now = false } = {}) {
  // Nothing free yet (the meters still say full, or a limit was moved on): wait again rather than be refused.
  // "Carry on now" is yours to press, so it always sends.
  const free = pickAccount(allAccounts(store.state), store.state.accountLimits, usable);
  if (!free && t.resume && !now) {
    const next = firstReset(allAccounts(store.state), store.state.accountLimits, signedIn, Date.now());
    store.save(updateThread(store.state, t.id, { resume: { ...t.resume, at: (next || Date.now() + LIMIT_RETRY_MS) + 60 * 1000 } }, t.updatedAt));
    const ev = { kind: "limit", resumeAt: store.state.threads.find((x) => x.id === t.id).resume.at, known: !!next };
    store.appendLog(t.id, ev);
    broadcast(t.id, ev);
    return;
  }
  try {
    // Whichever account is free now: the one that reset first may not be the thread's.
    if (free && free.id !== accountFor(t).id && store.state.settings?.autoSwitch !== false) moveThread(t.id, free.id, "reset");
    sendToThread(store.state.threads.find((x) => x.id === t.id), RESUME_TEXT, [], { auto: true });
  }
  catch (e) { setResume(t.id, null, "failed", e.message); throw e; }
  setResume(t.id, null, "sent");
}
setInterval(resumeDue, 30 * 1000);

// ── Accounts ─────────────────────────────────────────────────────────────────
// Adding one: a folder of its own with links to ~/.claude (server/accounts.js),
// then `claude auth login` for it. Without a terminal, Claude Code prints a
// sign-in link and waits for the code the sign-in page shows, which the page
// passes on. The account is only kept once it's signed in.

const logins = new Map(); // account id -> { id, name, dir, proc, out, state, message, timer }

function accountsView() {
  const limits = store.state.accountLimits || {};
  const next = pickAccount(allAccounts(store.state), limits, usable);
  return allAccounts(store.state).map((a) => {
    const info = accountInfo.get(a.id) || {};
    const plan = planUsageBy.get(a.id);
    return { id: a.id, name: a.id === MAIN ? "Main" : a.name || info.email || "Other account", email: info.email || a.email || "", plan: info.plan || "",
      signedIn: signedIn(a.id), limitedUntil: isLimited(limits, a.id) ? limits[a.id] : 0, planUsage: plan || null, usage: liveUsageBy.get(a.id) || null,
      // Full by its meters, and the reset /usage gives for the full window (text, e.g. "Oct 27, 1am").
      full: fullUntil(a.id), fullResets: plan?.windows.find((w) => w.used >= 1)?.resets || "", next: next?.id === a.id,
      // Signed in to the same subscription as an earlier account: switching to it gains nothing.
      sameAs: (() => { const email = (info.email || "").toLowerCase(); if (!email) return ""; const first = allAccounts(store.state).find((b) => (accountInfo.get(b.id)?.email || "").toLowerCase() === email); return first && first.id !== a.id ? (first.id === MAIN ? "Main" : first.name || first.email) : ""; })(),
      notLinked: info.notLinked || [], dir: a.dir ? a.dir.replace(HOME, "~") : "~/.claude" };
  });
}

const loginView = (l) => ({ id: l.id, url: loginUrl(l.out), state: l.state, message: l.message });

/**
 * `main`: signing in the main account itself (Claude Code's own ~/.claude), for someone who isn't
 * signed in yet: the same sign-in, without a folder of its own.
 */
function startLogin(name, email, { main = false } = {}) {
  for (const l of logins.values()) endLogin(l, true); // one at a time
  const id = main ? MAIN : newAccountId();
  const dir = main ? null : accountDir(HOME, id);
  if (dir) ensureLinks(fs, CLAUDE_DIR, dir);
  const acct = { id, dir };
  // BROWSER: don't open it ourselves; the page offers the link, since the browser may be signed in to the other account.
  // (A Mac's /usr/bin/true: Windows has none, so there Claude Code may open the browser as well.)
  const proc = spawn(claude()[0], [...claude()[1], "auth", "login", "--claudeai", ...(email ? ["--email", email] : [])], { env: { ...accountEnv(process.env, acct), ...(IS_WIN ? {} : { BROWSER: "/usr/bin/true" }) }, stdio: ["pipe", "pipe", "pipe"] });
  const l = { id, name, dir, main, proc, out: "", state: "waiting", message: "", timer: null };
  const take = (d) => { l.out = (l.out + d).slice(-20000); };
  proc.stdout.on("data", take);
  proc.stderr.on("data", take);
  proc.stdin.on("error", () => {});
  proc.on("error", (e) => { l.state = "failed"; l.message = `Couldn't run claude: ${e.message}`; });
  proc.on("exit", () => { if (l.state === "waiting") { l.state = "ended"; } });
  l.timer = setTimeout(() => endLogin(l, true), 15 * 60 * 1000);
  logins.set(id, l);
  return loginView(l);
}

/** The code from the sign-in page: Claude Code takes it, then the account is checked and kept. */
async function finishLogin(l, code) {
  if (!code) throw new Error("Paste the code the sign-in page shows.");
  if (l.state === "waiting") l.proc.stdin.write(code + "\n");
  // Claude Code swaps the code for the sign-in and exits.
  await new Promise((resolve) => {
    if (l.proc.exitCode !== null) return resolve();
    const t = setTimeout(resolve, 30000);
    l.proc.once("exit", () => { clearTimeout(t); resolve(); });
  });
  if (l.main) {
    await loadAccount(accountById(MAIN));
    endLogin(l, false);
    if (!account) throw new Error("That didn't sign in. Start again, and paste the whole code.");
    refreshUsage();
    broadcast(null, { kind: "accounts", accounts: accountsView() });
    return { ok: true, account, accounts: accountsView() };
  }
  const info = await authStatus({ id: l.id, dir: l.dir });
  if (!info?.signedIn) {
    // Claude Code's own words about it, without its sign-in instructions.
    const said = l.out.split("\n").map((x) => x.replace(/Paste code here if prompted >/i, "").trim()).filter((x) => x && !/https?:\/\/|Opening browser/i.test(x)).pop() || "";
    endLogin(l, true);
    throw new Error(`That didn't sign in${said ? `: ${said}` : ""}. Start again, and paste the whole code.`);
  }
  // The same account twice would only move threads from one limit to the same one.
  const dup = allAccounts(store.state).find((a) => accountInfo.get(a.id)?.email && accountInfo.get(a.id).email.toLowerCase() === info.email.toLowerCase());
  if (dup) {
    await logout({ id: l.id, dir: l.dir });
    endLogin(l, true);
    throw new Error(`${info.email} is already in B5 Code${dup.id === MAIN ? " as your main account" : ""}. Sign in with your other Claude account.`);
  }
  store.save({ ...store.state, accounts: [...(store.state.accounts || []), { id: l.id, name: l.name || info.email, dir: l.dir, email: info.email, addedAt: Date.now() }] });
  accountInfo.set(l.id, { ...info, notLinked: [] });
  endLogin(l, false);
  refreshUsage();
  return { ok: true, accounts: accountsView() };
}

/** Stop a sign-in; `discard` also removes its folder (an account that never signed in). */
function endLogin(l, discard) {
  clearTimeout(l.timer);
  if (l.proc.exitCode === null) l.proc.kill();
  logins.delete(l.id);
  if (discard && l.dir && !(store.state.accounts || []).some((a) => a.id === l.id)) {
    try { removeAccountDir(fs, HOME, l.dir); } catch (e) { console.error(`Removing ${l.dir}: ${e.message}`); }
  }
}

function logout(acct) {
  return new Promise((resolve) => execFile(claude()[0], [...claude()[1], "auth", "logout"], { timeout: 20000, env: accountEnv(process.env, acct) }, () => resolve()));
}

/** Sign an extra account out and remove its folder (never the shared things it links to). Its threads move to the main account. */
async function removeAccount(id) {
  const acct = (store.state.accounts || []).find((a) => a.id === id);
  if (!acct) throw Object.assign(new Error("No such account. The main account is whichever Claude Code is signed in to."), { status: 404 });
  const on = store.state.threads.filter((t) => t.account === id);
  if (on.some((t) => sessions.get(t.id)?.session.busy)) throw Object.assign(new Error("A thread on this account is working. Remove it when it's done."), { status: 409 });
  for (const t of on) closeSession(t.id);
  for (const [pid, sp] of spares) if (sp.session.account === id) { sp.session.close(); spares.delete(pid); }
  await logout(acct);
  removeAccountDir(fs, HOME, acct.dir);
  const limits = { ...(store.state.accountLimits || {}) };
  delete limits[id];
  store.save({ ...store.state, accounts: store.state.accounts.filter((a) => a.id !== id), accountLimits: limits,
    threads: store.state.threads.map((t) => (t.account === id ? { ...t, account: MAIN } : t)) });
  accountInfo.delete(id); planUsageBy.delete(id); liveUsageBy.delete(id);
  return { ok: true, accounts: accountsView() };
}

// ── The overnight queue ──────────────────────────────────────────────────────
// Tasks worked through unattended, one at a time across every project, each
// as a thread on a branch of its own (server/queue.js has the rules). Every
// 20 seconds: a task past its time is stopped, and the next one starts if
// nothing is running, the start time has come, and an account has room.

const queueState = () => store.state.queue || { on: false, startAt: 0, seq: 0, tasks: [] };
let queueBusy = false; // a task is being started (making its worktree takes seconds)

function saveQueue(q) {
  store.save({ ...store.state, queue: q });
  broadcast(null, { kind: "queue", queue: queueView() });
  updateAwake();
}

function updateTask(id, patch) {
  const q = queueState();
  saveQueue({ ...q, tasks: q.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
}

const queueHasWork = () => { const q = queueState(); return !!q.on && q.tasks.some((t) => t.status === "queued" || t.status === "running"); };
const taskOf = (threadId) => queueState().tasks.find((t) => t.threadId === threadId && store.state.threads.some((x) => x.id === threadId)) || null;

function queueView() {
  const q = queueState();
  return {
    on: !!q.on, startAt: q.startAt || 0, waiting: q.on && !pickAccount(allAccounts(store.state), store.state.accountLimits, usable) ? "limit" : "",
    tasks: q.tasks.map((t) => {
      const p = store.state.projects.find((x) => x.id === t.projectId);
      return { ...t, project: p ? p.name : "(removed project)", label: STATUS_LABEL[t.status] || t.status, working: !!(t.threadId && sessions.get(t.threadId)?.session.busy) };
    }),
  };
}

async function queueTick() {
  // Its tasks work unattended inside macOS's sandbox (server/queue.js), which Windows doesn't have.
  if (queueBusy || IS_WIN) return;
  const q = queueState();
  const now = Date.now();
  // A turn that runs past its time is stopped: it's stuck.
  for (const t of q.tasks) {
    if (t.status !== "running" || !t.turnAt || now - t.turnAt < TASK_MINUTES * 60 * 1000) continue;
    const s = sessions.get(t.threadId)?.session;
    if (s?.busy) { updateTask(t.id, { status: "stuck", why: `Ran past ${TASK_MINUTES} minutes`, endedAt: now }); s.interrupt(); }
  }
  // A task "running" that nothing is carrying on (its thread deleted, "Don't carry on" pressed on its
  // limit card, carrying on switched off) would hold the queue for good: it's stopped instead.
  for (const t of queueState().tasks) {
    if (t.status !== "running" || t.checking) continue;
    const th = store.state.threads.find((x) => x.id === t.threadId);
    if (!th) { updateTask(t.id, { status: "stopped", why: "Its thread was deleted", endedAt: now }); continue; }
    if (th.resume || sessions.get(th.id)?.session.busy || now - (t.turnAt || 0) < 2 * 60 * 1000) continue;
    updateTask(t.id, { status: "stopped", why: "Nothing is carrying it on (its usage limit wait was called off?)", endedAt: now });
  }
  const next = nextTask(queueState(), now);
  if (!next) return;
  // Every account at its limit: wait (the queue view says so) rather than start work that would be refused.
  if (!pickAccount(allAccounts(store.state), store.state.accountLimits, usable)) return;
  queueBusy = true;
  try { await startTask(next); }
  catch (e) { updateTask(next.id, { status: "stuck", why: `Couldn't start: ${e.message}`, endedAt: Date.now() }); }
  finally { queueBusy = false; }
}
setInterval(() => queueTick().catch((e) => console.error(`Queue: ${e.message}`)), 20 * 1000);

// ── Checks after each change ─────────────────────────────────────────────────
// A turn that edited files: the project's tests, typecheck and lint, run by
// B5 Code itself (no tokens), shown as a card; Fix this sends Claude what failed
// (server/checks.js). Off until you turn it on for the project, offered once.

const turnEdited = new Set(); // threads whose running turn has edited a file
const checking = new Map(); // threadId -> { gen, proc } of its run: a run whose gen isn't the latest has been stopped
let checkGen = 0;
const CHECK_MS = Number(process.env.B5_CHECK_MS) || 10 * 60 * 1000; // B5_CHECK_MS: shorter, for tests

/** A project folder's package.json (null for one that isn't Node) and its top-level names. */
function readProject(dir) {
  let pkg = null, files = new Set();
  try { files = new Set(fs.readdirSync(dir)); } catch { return { pkg, files }; }
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch { /* not a Node project */ }
  return { pkg, files };
}

/**
 * One check, in the folder: { code, output, timedOut } (code null when it timed out), or
 * null when its run was stopped. Its whole process group goes: npm's children too.
 */
const SANDBOX = "/usr/bin/sandbox-exec";
function runCheck(threadId, gen, dir, command, network) {
  return new Promise((resolve) => {
    let settled = false, timedOut = false;
    const done = (r) => { if (settled) return; settled = true; clearTimeout(timer); if (checking.get(threadId)?.proc === proc) checking.get(threadId).proc = null; resolve(checking.get(threadId)?.gen === gen ? r : null); };
    if (checking.get(threadId)?.gen !== gen) return resolve(null); // stopped before this one began
    let proc;
    // In a sandbox (server/checks.js): writes only in its folder and caches; the internet only if the project allows it.
    let real = dir;
    try { real = fs.realpathSync(dir); } catch { /* spawn says why */ }
    // Windows has no sandbox-exec: there the checks run as they would in your own terminal (cmd.exe).
    const argv = IS_WIN ? [command, [], { shell: true, windowsHide: true }]
      : fs.existsSync(SANDBOX) ? [SANDBOX, ["-p", sandboxProfile(real, HOME, { network, dataDir: REAL_DATA }), "/bin/sh", "-c", command]] : ["/bin/sh", ["-c", command]];
    try { proc = spawn(argv[0], argv[1], { cwd: dir, detached: true, env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" }, ...argv[2] }); }
    catch (e) { return resolve({ code: 127, output: e.message }); }
    checking.get(threadId).proc = proc;
    let out = "";
    const take = (d) => { out += d; if (out.length > 1 << 20) out = out.slice(-(1 << 19)); };
    proc.stdout.on("data", take);
    proc.stderr.on("data", take);
    const timer = setTimeout(() => { timedOut = true; killGroup(proc); }, CHECK_MS);
    proc.on("close", (code) => done({ code: timedOut ? null : code, output: out, timedOut }));
    proc.on("error", (e) => done({ code: 127, output: e.message })); // couldn't start: its folder gone, say
  });
}

/** SIGTERM to a check's process group, then SIGKILL for one that ignores it. (Windows: taskkill ends the tree.) */
function killGroup(proc) {
  if (!proc?.pid) return;
  if (IS_WIN) { execFile("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true }, () => {}); return; }
  try { process.kill(-proc.pid, "SIGTERM"); } catch { return; }
  setTimeout(() => { try { process.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ } }, 5000).unref();
}

/** Stop a thread's checks: `why` is said on its card ("a new turn began"); without one the run just ends (Run again). */
function stopChecks(threadId, why = "") {
  const run = checking.get(threadId);
  if (!run) return;
  checking.delete(threadId);
  killGroup(run.proc);
  if (why) emit(threadId, { kind: "checks", status: "cancelled", why });
}

const emit = (threadId, ev) => { ev = { ...ev, at: Date.now() }; if (!LIVE_ONLY.has(ev.kind)) store.appendLog(threadId, ev); broadcast(threadId, ev); };

/** After a turn that edited files (or Run again): run the project's checks, or offer them once. */
async function checksAfterTurn(threadId) {
  await null; // after the turn's end has gone out, so the card comes under its receipt
  const t = store.state.threads.find((x) => x.id === threadId);
  const p = t && store.state.projects.find((x) => x.id === t.projectId);
  if (!p || p.kind === "work" || p.kind === "chat" || t.queueTask) return; // the overnight queue runs its own; Work and Chat aren't code
  const dir = t.dir || p.dir;
  const { pkg, files } = readProject(dir);
  if (p.checksOn !== true) {
    if (p.checksOn === undefined && !p.checksOffered) {
      const found = detectChecks(pkg, files);
      if (found.length) { store.save(updateProject(store.state, p.id, { checksOffered: true })); emit(threadId, { kind: "checks", status: "offer", projectId: p.id, checks: found, runs: whatRuns(found, pkg) }); }
    }
    return;
  }
  const all = p.checks?.length ? p.checks : detectChecks(pkg, files);
  if (!all.length) return;
  // They run without Claude's permission questions: each only while it runs what you approved.
  // A new or changed one waits on a card (shown once while it stays the same); the rest run.
  const { ready, waiting } = sortRuns(p.checksApproved, whatRuns(all, pkg));
  const sig = waiting.map((w) => w.key).join("\0");
  if (waiting.length && shownWaiting.get(threadId) !== sig) emit(threadId, { kind: "checks", status: "changed", projectId: p.id, changed: waiting });
  shownWaiting.set(threadId, sig);
  const checks = all.filter((c) => ready.some((r) => r.command === c.command));
  if (!checks.length) return;
  stopChecks(threadId);
  const gen = ++checkGen;
  checking.set(threadId, { gen, proc: null });
  emit(threadId, { kind: "checks_running", names: checks.map((c) => c.name) });
  const results = [];
  for (const c of checks) {
    const started = Date.now();
    const r = await runCheck(threadId, gen, dir, c.command, p.checksNetwork === true);
    if (!r) return; // stopped: a new turn, or a newer run, says so itself
    results.push(checkResult(c, r.code, r.output, Date.now() - started));
  }
  if (checking.get(threadId)?.gen === gen) checking.delete(threadId);
  emit(threadId, { kind: "checks", status: "done", results, ...(results.some((r) => !r.ok) ? { fix: fixMessage(results) } : {}) });
}

const shownWaiting = new Map(); // threadId -> the waiting checks its card shows: shown again only when they change

/**
 * Approve exactly what you were shown: the keys (what each check runs) from a card or the
 * settings, as long as they're still what `dir` runs. { stale } when something changed since.
 */
function approveRuns(projectId, dir, keys) {
  const p = store.state.projects.find((x) => x.id === projectId);
  if (!p || !Array.isArray(keys)) return { stale: false };
  const { pkg, files } = readProject(dir);
  const now = new Set(whatRuns(p.checks?.length ? p.checks : detectChecks(pkg, files), pkg).map(runKey));
  const asked = keys.filter((k) => typeof k === "string");
  const fresh = asked.filter((k) => now.has(k));
  const kept = (Array.isArray(p.checksApproved) ? p.checksApproved : []).filter((k) => typeof k === "string" && !fresh.includes(k));
  store.save(updateProject(store.state, p.id, { checksApproved: [...fresh, ...kept].slice(0, 60) }));
  return { stale: fresh.length < asked.length };
}

// ── Automations ──────────────────────────────────────────────────────────────
// Tasks that start themselves (server/automations.js): on a schedule, or when
// files land in a watched folder. Each run is a new thread in its project; the
// phone hears when it's done, as for any thread.

const watched = new Map(); // automation id -> { dir, seen: Set of names, watcher, timer }
const homePath = (p) => pagePath(p, HOME);

/** A folder's files: { name, mtimeMs }. */
function listFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => {
      try { return { name: e.name, mtimeMs: fs.statSync(path.join(dir, e.name)).mtimeMs }; } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/** Start one run: a new thread, sent the prompt (and a folder's new files). The thread's id, or null when it didn't start. */
function runAutomation(id, files = []) {
  const a = (store.state.automations || []).find((x) => x.id === id);
  const project = a && store.state.projects.find((p) => p.id === a.projectId);
  if (!project) return null;
  // Its last run is still going: this one waits (a folder's files are looked at again).
  if (a.lastThreadId && sessions.get(a.lastThreadId)?.session.busy) return null;
  const { state, thread } = addThread(store.state, project.id);
  const day = new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  store.save(updateAutomation(updateThread(state, thread.id, { title: `${a.name} · ${day}`, automation: a.id }), a.id, { lastRun: Date.now(), lastThreadId: thread.id }));
  broadcastAutomations();
  try {
    sendToThread(store.state.threads.find((t) => t.id === thread.id), runText(a, files, a.trigger.type === "folder" ? homePath(a.trigger.path) : ""), [], { auto: "automation" });
  } catch (e) { console.error(`Automation ${a.name}: ${e.message}`); }
  return thread.id;
}

/** The automations as the page shows them: with when they run in words, and the next run. */
const automationsView = () => (store.state.automations || []).map((a) => ({ ...a, when: describeTrigger(a.trigger, HOME), next: nextRun(a) }));
const broadcastAutomations = () => broadcast(null, { kind: "automations", automations: automationsView() });

// Schedules: looked at every half minute.
setInterval(() => {
  for (const a of store.state.automations || []) if (scheduleDue(a)) runAutomation(a.id);
}, 30 * 1000);

/** Watch the folders of the automations that are on, and stop watching the rest. What's there already isn't new. */
function syncWatchers() {
  const want = new Map((store.state.automations || []).filter((a) => a.enabled && a.trigger?.type === "folder").map((a) => [a.id, a.trigger.path]));
  for (const [id, w] of watched) if (want.get(id) !== w.dir) { w.watcher?.close(); clearTimeout(w.timer); watched.delete(id); }
  for (const [id, dir] of want) {
    if (watched.has(id)) continue;
    const w = { dir, seen: new Set(listFiles(dir).map((f) => f.name)), watcher: null, timer: null };
    try { w.watcher = fs.watch(dir, () => { clearTimeout(w.timer); w.timer = setTimeout(() => lookAt(id), 6000); }); } catch { /* the minute's look still finds them */ }
    watched.set(id, w);
  }
}

/** New, settled files in a watched folder: one run for all of them. */
function lookAt(id) {
  const w = watched.get(id);
  if (!w) return;
  const files = newFiles(w.seen, listFiles(w.dir));
  if (files.length && runAutomation(id, files)) for (const f of files) w.seen.add(f);
}
setInterval(() => { for (const id of watched.keys()) lookAt(id); }, 60 * 1000); // fs.watch can miss a change
setTimeout(syncWatchers, 3000);

/** A run finished: what it wrote into its own watched folder isn't new work (else it would run on its own output). */
function automationDone(threadId) {
  const t = store.state.threads.find((x) => x.id === threadId);
  const w = t?.automation && watched.get(t.automation);
  if (w) for (const f of listFiles(w.dir)) w.seen.add(f.name);
}

/** A trigger from the page: a folder made absolute, and only one in your home folder. */
function triggerFrom(raw) {
  const t = cleanTrigger(raw);
  if (t?.type !== "folder") return t;
  const dir = path.resolve(expandHome(t.path, HOME));
  if (!within(dir, HOME) || within(HOME, dir)) throw Object.assign(new Error("Watch a folder inside your home folder (not the home folder itself)."), { status: 400 });
  let isDir = false;
  try { isDir = fs.statSync(dir).isDirectory(); } catch { /* missing */ }
  if (!isDir) throw Object.assign(new Error(`That folder doesn't exist on this ${MAC}.`), { status: 400 });
  return { type: "folder", path: dir };
}

// B5 Code restarted while a task was working (or waiting on a question, which went with its process):
// it carries on where it was, on its own conversation. A task whose thread is gone is stuck.
function recoverQueue() {
  const q = queueState();
  for (const task of q.tasks) {
    if (task.status !== "running" && task.status !== "paused") continue;
    const t = store.state.threads.find((x) => x.id === task.threadId);
    if (!t || (t.dir && !fs.existsSync(t.dir))) { updateTask(task.id, { status: "stuck", why: "Its thread or worktree is gone", endedAt: Date.now() }); continue; }
    if (t.resume) continue; // waiting out a usage limit: it carries on by itself
    updateTask(task.id, { status: "running", turnAt: Date.now(), checking: false, why: "" });
    try { sendToThread(t, "B5 Code restarted while you were on this task. Carry on where you left off, following the same overnight rules.", [], { auto: "queue" }); }
    catch (e) { updateTask(task.id, { status: "stuck", why: `Couldn't carry on after a restart: ${e.message}`, endedAt: Date.now() }); }
  }
}
setTimeout(() => { try { recoverQueue(); } catch (e) { console.error(`Queue: ${e.message}`); } }, 5000);

async function startTask(task) {
  const project = store.state.projects.find((p) => p.id === task.projectId);
  if (!project) throw new Error("its project is gone.");
  const branch = queueBranch(task.n, task.brief);
  const { dir, root, base } = await createWorktree(project.dir, branch, { copyLocal: false });
  // Where its commits are written (the repo's .git), for the sandbox: real paths, as the sandbox sees them.
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const gitDir = real(path.resolve(dir, await git(["rev-parse", "--git-dir"], dir)));
  const commonDir = real(path.resolve(dir, await git(["rev-parse", "--git-common-dir"], dir)));
  // A fresh checkout has no node_modules, and a task can't install (no network): the project's own are
  // linked in, read-only to it, and kept out of git (a link isn't matched by "node_modules/" in .gitignore).
  const shared = [];
  const mods = path.join(project.dir, "node_modules");
  if (fs.existsSync(mods) && !fs.existsSync(path.join(dir, "node_modules"))) {
    fs.symlinkSync(mods, path.join(dir, "node_modules"));
    shared.push(real(mods));
    try {
      const exclude = path.join(commonDir, "info", "exclude");
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      if (!(fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "").split("\n").includes("node_modules")) fs.appendFileSync(exclude, "\nnode_modules\n");
    } catch { /* git status shows it; the brief says not to commit it */ }
  }
  const { state, thread } = addThread(store.state, project.id);
  store.save(updateThread(state, thread.id, { dir, root, branch, title: titleFrom(task.brief), queueTask: task.id }));
  const now = Date.now();
  updateTask(task.id, { status: "running", threadId: thread.id, branch, dir: real(dir), base, gitDir, commonDir, shared, startedAt: now, turnAt: now, checkTries: 0, why: "" });
  sendToThread(store.state.threads.find((t) => t.id === thread.id), overnightBrief({ brief: task.brief, checks: task.checks, branch, dir }), [], { auto: "queue" });
}

/** A queued task's permission question: answered here if it's on the overnight list (true), else the task pauses. */
function queueAnswered(threadId, session, ev) {
  const task = taskOf(threadId);
  const t = store.state.threads.find((x) => x.id === threadId);
  if (!task || !t?.dir || (task.status !== "running" && task.status !== "paused")) return false;
  const verdict = queueAllows(ev.tool, ev.input, t.dir);
  if (verdict.ok) {
    if (!session.answerPermission(ev.requestId, "allow")) return false;
    // Kept as a step, so the morning's thread shows what ran on the owner's behalf.
    const shown = { kind: "permission_answer", requestId: ev.requestId, choice: "allow", auto: true, summary: ev.summary };
    store.appendLog(threadId, { ...ev, auto: true });
    store.appendLog(threadId, shown);
    broadcast(threadId, { ...ev, auto: true });
    broadcast(threadId, shown);
    return true;
  }
  updateTask(task.id, { status: "paused", why: `Claude wants to ${verdict.why}: ${ev.summary}` });
  return false; // the question goes on to the inbox and the phone, as any other
}

/** The owner answered a paused task's question: it's working again. */
function queueAnsweredByOwner(threadId) {
  const task = taskOf(threadId);
  if (task?.status === "paused") updateTask(task.id, { status: "running", turnAt: Date.now(), why: "" });
}

// The owner's checks command, in the task's worktree, inside macOS's sandbox (no network, writes only
// there, no secrets), with only the environment a test needs: no tokens or keys from B5 Code's own.
function runChecks(cmd, dir) {
  return new Promise((resolve) => {
    let worktree = dir;
    try { worktree = fs.realpathSync(dir); } catch { /* checked below */ }
    const task = queueState().tasks.find((t) => t.dir === worktree || t.dir === dir);
    const profile = checksSandboxProfile({ worktree, home: HOME, dataDir: REAL_DATA, gitDir: task?.gitDir, commonDir: task?.commonDir, shared: task?.shared });
    const env = { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", HOME, LANG: process.env.LANG || "en_US.UTF-8", TERM: "dumb", CI: "1", TMPDIR: process.env.TMPDIR || "/tmp" };
    execFile("/usr/bin/sandbox-exec", ["-p", profile, "/bin/zsh", "-c", cmd], { cwd: worktree, timeout: CHECK_MINUTES * 60 * 1000, maxBuffer: 8 << 20, env }, (err, out, errOut) => {
      resolve({ ok: !err, output: `${out || ""}${errOut || ""}`.slice(-20000) });
    });
  });
}

function git(args, dir) {
  return new Promise((resolve) => execFile("git", ["-C", dir, ...args], { timeout: 20000, maxBuffer: 4 << 20 }, (err, out) => resolve(err ? "" : out.trim())));
}

const prCache = new Map(); // dir \0 branch -> { pr, at }: gh takes a second or two, asked again after a minute
/**
 * Where a thread's folder stands: its branch, what isn't committed, what isn't pushed,
 * and the branch's PR. What the next-step buttons are chosen from (web/next-steps.js).
 */
async function gitState(thread) {
  const project = store.state.projects.find((p) => p.id === thread.projectId);
  const dir = thread.dir || project?.dir;
  if (!dir || !fs.existsSync(dir)) return { git: false };
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  if (!branch) return { git: false };
  const [status, upstream, remotes, head, origin] = await Promise.all([
    git(["status", "--porcelain=v1", "-z", "-uall"], dir), git(["rev-parse", "--abbrev-ref", "@{u}"], dir),
    git(["remote"], dir), git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir), git(["remote", "get-url", "origin"], dir)]);
  const remote = !!remotes;
  const github = /github\.com[:/]/.test(origin); // PRs go through gh
  const ahead = Number(await git(upstream ? ["rev-list", "--count", "@{u}..HEAD"] : ["rev-list", "--count", "HEAD", "--not", "--remotes"], dir)) || 0;
  const main = head.replace(/^origin\//, "") || "main";
  let pr = null;
  if (github && branch !== "HEAD" && branch !== main) {
    const key = dir + "\0" + branch, hit = prCache.get(key);
    if (hit && Date.now() - hit.at < 60000) pr = hit.pr;
    else { try { pr = await prStatus(dir, branch); } catch { pr = null; } prCache.set(key, { pr, at: Date.now() }); }
  }
  return { git: true, dir, branch, main, dirty: parseStatus(status).length, ahead, upstream: !!upstream, remote, github, pr,
    prPrompt: openPrPrompt({ branch, template: prTemplate(dir) }) };
}

async function queueAfterTurn(threadId, ev) {
  const task = taskOf(threadId);
  if (!task || task.status !== "running") return;
  const t = store.state.threads.find((x) => x.id === threadId);
  // Stopped by a usage limit: it waits or moved account, and carries on by itself.
  const limit = !ev.ok && (!!t?.resume || !!sessions.get(threadId)?.session.busy);
  let check = null;
  if (ev.ok && task.checks && t?.dir) {
    updateTask(task.id, { checking: true });
    check = await runChecks(task.checks, t.dir);
    updateTask(task.id, { checking: false });
  }
  const next = afterTurn(task, { ok: ev.ok, limit, error: ev.error }, check);
  const patch = { status: next.status, ...(next.checkTries !== undefined ? { checkTries: next.checkTries } : {}), why: next.why || "" };
  if (check) patch.lastCheck = { ok: check.ok, output: check.output.slice(-4000), at: Date.now() };
  if (next.followUp) {
    updateTask(task.id, { ...patch, turnAt: Date.now() });
    sendToThread(store.state.threads.find((x) => x.id === threadId), next.followUp, [], { auto: "queue" });
    return;
  }
  if (next.status !== "running") Object.assign(patch, { endedAt: Date.now(), report: await taskReport(t, task.base) });
  updateTask(task.id, patch);
  // Finished: its sandboxed process goes, so the owner's next message (Open PR) runs unboxed.
  if (next.status !== "running") closeSession(threadId);
  queueTick().catch(() => {});
}

/** The morning's facts about a task: its commits, the lines it changed, anything left uncommitted, and Claude's report. */
async function taskReport(t, base) {
  if (!t?.dir || !fs.existsSync(t.dir)) return null;
  // The branch it started from (main or master, from origin or not), as createWorktree said.
  base ||= (await git(["rev-parse", "--verify", "--quiet", "origin/main"], t.dir)) ? "origin/main" : "main";
  const commits = (await git(["log", "--oneline", `${base}..HEAD`], t.dir)).split("\n").filter(Boolean);
  const stat = await git(["diff", "--shortstat", `${base}...HEAD`], t.dir);
  const dirty = (await git(["status", "--porcelain"], t.dir)).split("\n").filter(Boolean).length;
  const log = store.readLog(t.id);
  const reply = [...log].reverse().find((e) => e.kind === "text")?.text || "";
  return { commits: commits.slice(0, 20), stat, dirty, reply: reply.slice(-3000) };
}

/** A task's work, thrown away: its thread, worktree and branch (none of it was pushed). */
async function throwAway(t) {
  const project = store.state.projects.find((p) => p.id === t.projectId);
  const sides = store.state.threads.filter((x) => x.sideOf === t.id);
  if (sides.some((x) => sessions.get(x.id)?.session.busy)) throw Object.assign(new Error("A side chat of this task is working. Stop it first."), { status: 409 });
  for (const x of [t, ...sides]) { closeSession(x.id); terminals.close(x.id); if (x !== t) store.deleteLog(x.id); }
  if (project && t.root && t.branch?.startsWith("queue/")) {
    await new Promise((resolve) => execFile("git", ["-C", project.dir, "worktree", "remove", "--force", t.root], { timeout: 60000 }, () => resolve()));
    await new Promise((resolve) => execFile("git", ["-C", project.dir, "branch", "-D", t.branch], { timeout: 20000 }, () => resolve()));
  }
  store.save(removeThread(store.state, t.id));
  store.deleteLog(t.id);
}

// ── Keep the Mac awake ───────────────────────────────────────────────────────

const awake = new Awake();
function updateAwake() {
  const busy = [...sessions.values()].some((s) => s.session.busy) || runningTasks.size > 0 || queueHasWork();
  awake.set(busy && store.state.settings?.keepAwake !== false);
}

/** Send a message to a thread: a new turn, or (while one runs) a steer for it. */
function sendToThread(thread, text, attachments, extra = {}) {
  // A new turn on an account at its limit goes to one that isn't, rather than be refused.
  const idle = !sessions.get(thread.id)?.session.busy;
  if (idle && thread.account && isLimited(store.state.accountLimits, thread.account) && store.state.settings?.autoSwitch !== false) {
    const other = pickAccount(allAccounts(store.state), store.state.accountLimits, usable);
    if (other && other.id !== thread.account) { moveThread(thread.id, other.id, "limit-before"); thread = store.state.threads.find((t) => t.id === thread.id); }
  }
  if (thread.title === "New thread" || (thread.sideOf && thread.title === "Side chat")) {
    store.save(updateThread(store.state, thread.id, { title: titleFrom(text || attachments[0]?.name) }));
  }
  const s = sessionFor(thread);
  clearTimeout(sessions.get(thread.id)?.idleTimer);
  const steer = s.busy;
  // A new turn, however it starts (you, an automation, a resume, a restart): the files are about to change again.
  if (!steer) stopChecks(thread.id, "a new turn began");
  if (!steer) lastUsage.delete(thread.id);
  // Where HEAD is as the turn begins: the receipt lists the commits made since, and the
  // thread's first one is where the Changes pane's "This chat" starts.
  const dir = thread.dir || store.state.projects.find((p) => p.id === thread.projectId)?.dir;
  if (!steer && dir) {
    turnHeads.delete(thread.id);
    git(["rev-parse", "HEAD"], dir).then((sha) => {
      if (!sha) return;
      turnHeads.set(thread.id, { dir, sha, at: Date.now() });
      const t = store.state.threads.find((x) => x.id === thread.id);
      if (t && !t.startSha) store.save(updateThread(store.state, thread.id, { startSha: sha }));
    });
  }
  const ev = { kind: "user", text, files: attachments.map((a) => ({ path: a.path, name: a.name, type: a.type })), ...(steer ? { steer: true } : {}), ...extra };
  store.appendLog(thread.id, ev);
  broadcast(thread.id, ev);
  s.send(buildContent(text, attachments, (p) => fs.readFileSync(p)));
  store.save(updateThread(store.state, thread.id, {}));
  // A queued task's time limit counts from its latest turn (carrying on after a limit, too).
  if (thread.queueTask && !steer) { const qt = queueState().tasks.find((x) => x.id === thread.queueTask && x.status === "running"); if (qt) updateTask(qt.id, { turnAt: Date.now() }); }
  updateAwake();
  return steer;
}

// What the inbox needs about every thread, open in the page or not: the
// permission questions waiting, and how the last turn ended.
const contextNow = new Map(); // threadId -> { input, output } of the running turn's latest request
const asks = new Map(); // threadId -> Map(requestId -> { summary, detail, tool, canAllowEdits })
const lastText = new Map(); // threadId -> the last reply text of the running turn

/** Keeps the inbox's facts; for a finished turn, returns what it saved about it. */
function trackForInbox(threadId, ev) {
  if (ev.kind === "permission") {
    if (!asks.has(threadId)) asks.set(threadId, new Map());
    asks.get(threadId).set(ev.requestId, { requestId: ev.requestId, summary: ev.summary, detail: ev.detail, tool: ev.tool, canAllowEdits: ev.canAllowEdits,
      ...(ev.tool === ASK_TOOL ? { input: ev.input } : {}) }); // the inbox shows the question
  }
  if (ev.kind === "permission_answer" || ev.kind === "permission_closed") asks.get(threadId)?.delete(ev.requestId);
  if (ev.kind === "text") lastText.set(threadId, ev.text);
  if (ev.kind === "done" || ev.kind === "error") {
    asks.delete(threadId);
    const reply = (lastText.get(threadId) || "").replace(/[#*_`>|]/g, "").replace(/\s+/g, " ").trim();
    lastText.delete(threadId);
    const t = store.state.threads.find((x) => x.id === threadId);
    const inbox = {
      lastDoneAt: Date.now(),
      lastOk: ev.kind === "done" ? !!ev.ok : false,
      lastReply: reply.slice(0, 200) || (ev.kind === "error" ? ev.message || "" : ev.error || ""),
    };
    if (t) store.save(updateThread(store.state, threadId, inbox));
    return inbox;
  }
  return null;
}

function armIdle(threadId) {
  const s = sessions.get(threadId);
  if (!s) return;
  clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (sessions.get(threadId) !== s || s.session.busy) return;
    // A command or agent still running in the background would die with the process.
    if (runningTasks.get(threadId)?.size) armIdle(threadId);
    else closeSession(threadId);
  }, IDLE_MS);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_MAX) { reject(new Error("Too large.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new Error("Bad JSON.")); }
    });
    req.on("error", reject);
  });
}

function hostOk(req) {
  return req.headers.host === `${HOST}:${PORT}` || req.headers.host === `localhost:${PORT}`;
}

// ── File preview ─────────────────────────────────────────────────────────────
// /preview/<secret>/<absolute path, or ~/…> serves a file from your home
// folder for the Preview pane: plan pages, screenshots, PDFs, videos.
// Relative links inside a plan page resolve under the same prefix, so its
// images and scripts load too. Symlinks are followed before the home-folder
// check, so a link inside your home folder can't reach outside it.

/** A link for the Preview pane: locked to the file's own folder. */
function previewLink(rest, base) {
  const file = realFile(previewPathIn(rest, HOME));
  if (!file) return null;
  const scope = previewScope(file, REAL_HOME);
  // A Mac's file name may hold a backslash: only Windows splits on it.
  return `${base}/${scopeToken(scope)}/${file.split(IS_WIN ? /[\\/]/ : "/").filter(Boolean).map(encodeURIComponent).join("/")}`;
}

/** The real path, if it exists and is in your home folder; else null. */
function realFile(file) {
  if (!file) return null;
  // Not even looked at unless it's in your home folder as written (a link in it may lead elsewhere in it).
  if (!within(path.resolve(file), HOME) && !within(path.resolve(file), REAL_HOME)) return null;
  try { file = realPath(file); } catch { return null; }
  return inScope(file, REAL_HOME) ? file : null;
}

// A previewed page may load what it likes (fonts, scripts, pictures from the web), but it can't send
// anything anywhere: no fetch/XHR/WebSocket beyond its own folder, and no form posts. A page that
// read your files couldn't hand them on.
// A previewed file (a page Claude wrote, say) may read its own folder, but nothing it loads may carry
// that anywhere: everything comes from its folder or the usual script and font CDNs, it can't post,
// and (in the page's frame, without allow-popups) it can't open a window. Images: its own, or inline.
const PREVIEW_CDNS = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://cdn.tailwindcss.com https://esm.sh https://fonts.googleapis.com https://fonts.gstatic.com";
const previewCsp = (frameAncestors) => [
  `default-src 'self' ${PREVIEW_CDNS}`,
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${PREVIEW_CDNS}`,
  `style-src 'self' 'unsafe-inline' ${PREVIEW_CDNS}`,
  `img-src 'self' data: blob:`, `media-src 'self' data: blob:`, `font-src 'self' data: ${PREVIEW_CDNS}`,
  `connect-src 'self'`, `frame-src 'self' data: blob:`, `worker-src 'self' blob:`,
  `form-action 'none'`, `frame-ancestors ${frameAncestors}`,
].join("; ");
// B5 Code's own data (its token, keys, conversations) is never previewed, whatever links to it.
let REAL_DATA = store.dataDir;
try { REAL_DATA = realPath(store.dataDir); } catch { /* made at start */ }

/**
 * Hidden and secret files (.ssh, .env, keys, credentials…) are the Mac's: a paired phone,
 * stolen or not, never reads them, through any route. `file` is absolute or ~-relative.
 */
const phoneMayNotRead = (req, file) => !!req.b5Remote && isPrivate(path.relative(REAL_HOME, String(file || "")).replace(/[\\/]\.playwright-mcp[\\/]/g, "/"));

function servePreview(req, res, secret, rest, frameAncestors, version = null, remote = false) {
  let file = realFile(previewPathIn(rest, HOME));
  if (!file) return send(res, 404, "Not found, or not in your home folder.", "text/plain");
  if (inScope(file, REAL_DATA)) return send(res, 403, "B5 Code's own data isn't shown.", "text/plain");
  if (remote && isPrivate(path.relative(REAL_HOME, file))) return send(res, 403, `Hidden and secret files open on the ${MAC} only.`, "text/plain");
  let st = fs.statSync(file);
  if (st.isDirectory()) {
    file = realFile(path.join(file, "index.html"));
    if (!file) return send(res, 404, "Not found", "text/plain");
    st = fs.statSync(file);
  }
  const ext = path.extname(file).toLowerCase();
  // The shared secret: pictures and media only, for the conversation's
  // thumbnails. A folder's secret: the file it was made for, and the files a
  // page needs from its folder (known types; nothing hidden or secret).
  if (secret === PREVIEW_TOKEN) {
    // Hidden folders are off limits, except where Playwright keeps the screenshots Claude takes.
    if (!PASSIVE.has(ext) || isPrivate(file.replace(/[\\/]\.playwright-mcp[\\/]/g, "/"))) return send(res, 403, "Not available here.", "text/plain");
  } else {
    let scope = null;
    for (let p = file; ; p = path.dirname(p)) {
      if (scopeToken(p) === secret) { scope = p; break; }
      if (p === path.dirname(p)) break;
    }
    if (!scope) return send(res, 403, "This page can only open files in its own folder.", "text/plain");
    const rel = path.relative(scope, file);
    if (rel && (isPrivate(rel) || !PREVIEW_TYPES[ext])) return send(res, 403, "A previewed page can't open hidden or private files.", "text/plain");
  }
  // An artifact's earlier version, at the file's own address, so its relative links still work.
  if (version) {
    const old = artifacts.read(file, version);
    if (!old) return send(res, 404, "That version isn't kept.", "text/plain");
    res.writeHead(200, { "content-type": PREVIEW_TYPES[ext] || "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": previewCsp(frameAncestors) });
    return res.end(old);
  }
  const type = PREVIEW_TYPES[ext] || "application/octet-stream";
  const headers = {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // Only B5 Code's own page may frame a preview.
    "content-security-policy": previewCsp(frameAncestors),
    "accept-ranges": "bytes",
  };
  // Videos seek with Range requests.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range && st.size > 0) {
    let start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2] || 0));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) { res.writeHead(416, { "content-range": `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "content-length": st.size });
  fs.createReadStream(file).pipe(res);
}

function serveStatic(req, res, urlPath, previewOrigin = `${PREVIEW_ORIGIN} http://127.0.0.1:${PREVIEW_PORT}`, token = TOKEN) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.resolve(WEB, rel);
  if (!file.startsWith(WEB + path.sep)) return send(res, 404, "Not found", "text/plain");
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, "Not found", "text/plain");
    let body = buf;
    if (rel === "index.html") body = buf.toString("utf8").replace("__DESK_TOKEN__", token).replace("__DESK_PAGE__", pagePrint());
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": `default-src 'self'; img-src 'self' data: blob: https://avatars.githubusercontent.com ${previewOrigin}; media-src 'self' blob: ${previewOrigin}; frame-src 'self' ${previewOrigin} ${DEV_SERVERS}; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'`,
    });
    res.end(body);
  });
}

/**
 * A folder's changed files. Against HEAD: what isn't committed yet. Against a
 * thread's base: everything since the chat began, committed or not, so work
 * Claude has already committed still shows. The commits since the base come too.
 */
async function gitChanges(dir, base, scope, startedAt = 0) {
  const run = (args) => new Promise((resolve) => execFile("git", ["-C", dir, ...args], { maxBuffer: 4 << 20 }, (err, out) => resolve(err ? null : out)));
  const status = await run(["status", "--porcelain=v1", "-z", "-uall"]);
  if (status === null) return { git: false, files: [], commits: [] };
  const all = base ? parseLog(await run(["log", "--format=%h%x1f%s%x1f%ct", "-z", "-n", "50", `${base}..HEAD`])) : [];
  const commits = ownCommits(all, startedAt);
  let since = scope === "chat" && commits.length ? base : "HEAD";
  let only = null; // the files the chat's own commits touched, when a pull brought in others
  if (since !== "HEAD" && commits.length < all.length) {
    // Its own commits' files (a merge lists none), from just before the first of them, and whatever's uncommitted.
    only = new Set(parseStatus(status).map((f) => f.file));
    let first = "";
    for (const c of commits) {
      const names = String(await run(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", c.sha]) || "").split("\0").filter(Boolean);
      if (names.length) { names.forEach((n) => only.add(n)); first = c.sha; }
    }
    since = first ? String(await run(["rev-parse", `${first}^`]) || "").trim() || base : "HEAD";
  }
  const untracked = parseStatus(status).filter((f) => f.status === "??");
  const tracked = (since === "HEAD" ? parseStatus(status).filter((f) => f.status !== "??") : parseNameStatus(await run(["diff", "--name-status", "-z", since])))
    .filter((f) => !only || only.has(f.file));
  const stats = parseNumstat(await run(["diff", "--numstat", "-z", since]));
  const files = [...tracked, ...untracked].slice(0, 200).map((f) => {
    const s = stats.get(f.file) || (f.status === "??" ? { add: newFileLines(path.join(dir, f.file)) } : {});
    return { ...f, add: s.add || "", del: s.del || "" };
  });
  return { git: true, files, commits, scope: since === "HEAD" ? "uncommitted" : "chat", since };
}

/** Where a thread's work began: the commit it was on when it first ran (else the last one before it was made), as far as it's still under HEAD. */
async function threadBase(t, dir) {
  if (!t) return "";
  const start = t.startSha || await git(["rev-list", "-1", `--before=${Math.floor((t.createdAt || 0) / 1000)}`, "HEAD"], dir);
  // After a rebase or a branch switch, the part of it still in HEAD's history.
  return start ? git(["merge-base", start, "HEAD"], dir) : "";
}

const fileLists = new Map(); // work folder -> { files, at }: finding by name doesn't walk the project on every key


// ── Updates ──────────────────────────────────────────────────────────────────
// The page loads its files fresh on every reload, but the server only reads
// its own code when it starts. Each side's files are fingerprinted (names,
// sizes, change times), so the page can say "B5 Code was updated" and offer
// a restart (the server's code changed) or a reload (only the page's did).

function fingerprint(dir, match) {
  const h = crypto.createHash("sha1");
  try {
    for (const f of fs.readdirSync(dir).filter((f) => match.test(f)).sort()) {
      const st = fs.statSync(path.join(dir, f));
      h.update(`${f}:${st.size}:${st.mtimeMs};`);
    }
  } catch { /* unreadable: no fingerprint */ }
  return h.digest("hex").slice(0, 12);
}
const serverPrint = () => fingerprint(path.join(ROOT, "server"), /\.js$/) + fingerprint(ROOT, /^package(-lock)?\.json$/);
const pagePrint = () => fingerprint(WEB, /\.(js|css|html)$/);
const STARTED_AS = serverPrint();

// B5 Code updates itself: once its code has changed (a pull, an edit) and settled for a
// minute, it restarts by itself as soon as nothing would be cut short. "Restart now"
// doesn't wait: the threads that were working are told to carry on once it's back.
const RESTART_TEXT = "B5 Code restarted for an update while you were working. Carry on where you left off.";
const SETTLE_MS = 60 * 1000;
let codeSeen = { print: STARTED_AS, at: Date.now() };

/** What a restart now would cut short, in words: thread titles, the overnight queue, a command in the Terminal. */
function whatsRunning() {
  const title = (id) => store.state.threads.find((t) => t.id === id)?.title || "A thread";
  const ids = new Set([...sessions].filter(([, s]) => s.session.busy).map(([id]) => id));
  for (const [id, m] of asks) if (m.size) ids.add(id);
  for (const id of runningTasks.keys()) ids.add(id);
  const out = [...ids].map(title);
  if (queueState().tasks.some((t) => t.status === "running")) out.push("the overnight queue");
  if (busyTerminals()) out.push("a command in the Terminal");
  return out;
}

/** Shells in the Terminal pane running something (a dev server, say) rather than waiting at the prompt. */
function busyTerminals() {
  if (IS_WIN) return winTermsBusy;
  let n = 0;
  for (const t of terminals.terms.values()) {
    const fg = path.basename(String(t.pty?.process || ""));
    if (fg && !isShell(fg)) n++;
  }
  return n;
}

/** Whether the new code would start at all: a restart into a syntax error would leave no B5 Code. */
async function codeStarts() {
  const files = fs.readdirSync(path.join(ROOT, "server")).filter((f) => f.endsWith(".js"));
  const ok = await Promise.all(files.map((f) => new Promise((resolve) => execFile(process.execPath, ["--check", path.join(ROOT, "server", f)], { timeout: 15000 }, (err) => resolve(!err)))));
  return ok.every(Boolean);
}

// On Windows node-pty names only the shell, never the program running in it: a shell is busy when it
// has started a program of its own (the console host it runs in doesn't count). Asked just before a
// restart or an update decides whether anything would be cut short.
let winTermsBusy = 0;
function checkWindowsTerminals() {
  const pids = [...terminals.terms.values()].filter((t) => t.running && t.pty?.pid).map((t) => Number(t.pty.pid));
  if (!IS_WIN || !pids.length) { winTermsBusy = 0; return Promise.resolve(); }
  const filter = pids.map((p) => `ParentProcessId=${p}`).join(" OR ");
  const script = `Get-CimInstance Win32_Process -Filter '${filter}' | Where-Object { $_.Name -notmatch '^(conhost|OpenConsole)\\.exe$' } | ForEach-Object { $_.ParentProcessId }`;
  return new Promise((resolve) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15000 }, (err, out) => {
    if (!err) winTermsBusy = new Set(String(out).split(/\s+/).filter(Boolean)).size;
    resolve();
  }));
}

/** Restart for the update if it's waiting and nothing is running. */
async function updateIfIdle() {
  if (store.state.settings?.autoUpdate === false || updating) return;
  await checkWindowsTerminals();
  const now = serverPrint();
  if (now === STARTED_AS) return;
  if (now !== codeSeen.print) { codeSeen = { print: now, at: Date.now() }; return; } // still being changed
  if (Date.now() - codeSeen.at < SETTLE_MS || whatsRunning().length || !(await codeStarts())) return;
  if (!updating && !whatsRunning().length) restartForUpdate([]); // nothing started while it checked
}
setInterval(() => updateIfIdle().catch((e) => console.error(`Update: ${e.message}`)), 20 * 1000);

// Installed by the installer (data/install.json, written by `b5 setup`): B5 Code follows GitHub's main
// by itself. Every half hour it looks; a newer version comes in when nothing is running, through
// `b5 update` (bin/b5.mjs), which stops this server, fast-forwards, reinstalls or rebuilds the app if
// those changed, and starts it again. A folder with changes of its own is never updated.
const INSTALL = (() => { try { return JSON.parse(fs.readFileSync(path.join(store.dataDir, "install.json"), "utf8")); } catch { return null; } })();
let fetching = false, cantUpdate = "";
async function updateFromGitHub() {
  if (INSTALL?.updates !== "github" || store.state.settings?.autoUpdate === false || fetching || updating) return;
  await checkWindowsTerminals();
  if (whatsRunning().length) return;
  fetching = true;
  try {
    await new Promise((resolve) => execFile("git", ["-C", ROOT, "fetch", "--quiet", "origin", "main"], { timeout: 120000, windowsHide: true }, () => resolve()));
    const [head, next, base, dirty] = await Promise.all([git(["rev-parse", "HEAD"], ROOT), git(["rev-parse", "origin/main"], ROOT), git(["merge-base", "HEAD", "origin/main"], ROOT), git(["status", "--porcelain", "--untracked-files=no"], ROOT)]);
    if (!head || !next || head === next) return; // up to date
    // What `b5 update` would refuse: said once in the log, and nothing is stopped for it.
    const why = base !== head ? "this folder has commits GitHub's main doesn't" : dirty ? "this folder has changes of its own" : fs.existsSync(path.join(store.dataDir, ".starting")) ? "" : null;
    if (why !== null) { if (why && why !== cantUpdate) console.log(`Not updating from GitHub: ${why} (${ROOT}).`); cantUpdate = why; return; }
    if (whatsRunning().length) return;
    console.log(`Updating from GitHub: ${head.slice(0, 7)} → ${next.slice(0, 7)}`);
    updating = true;
    // No "restarting" word to the page: this server stays up until `b5 update` stops it, and a page
    // told now would reload onto the old code at once. It sees the server go, and reconnects.
    const log = fs.openSync(path.join(store.dataDir, "b5.log"), "a");
    spawn(process.execPath, [path.join(ROOT, "bin", "b5.mjs"), "update", "--quiet"], { cwd: ROOT, detached: true, windowsHide: true, stdio: ["ignore", log, log] }).unref();
    fs.closeSync(log);
    // It stops this server; one still here after ten minutes means the update didn't happen (its reason is in the log).
    setTimeout(() => { updating = false; }, 10 * 60 * 1000).unref();
  } finally { fetching = false; }
}
if (INSTALL?.updates === "github") {
  setTimeout(() => updateFromGitHub().catch((e) => console.error(`Update: ${e.message}`)), 2 * 60 * 1000);
  setInterval(() => updateFromGitHub().catch((e) => console.error(`Update: ${e.message}`)), 30 * 60 * 1000);
}

let updating = false;
/** Restart into the new code; `carryOn` threads are sent RESTART_TEXT when it's back. */
function restartForUpdate(carryOn) {
  updating = true;
  if (carryOn.length) store.save({ ...store.state, carryOn });
  broadcast(null, { kind: "restarting" });
  setTimeout(restartSelf, 300); // after the word has gone out
}

// Back from a restart that cut threads short: each carries on where it was.
function carryOnAfterRestart() {
  const ids = store.state.carryOn || [];
  if (!ids.length) return;
  store.save({ ...store.state, carryOn: [] });
  for (const id of ids) {
    const t = store.state.threads.find((x) => x.id === id);
    if (!t || t.resume || t.queueTask) continue; // waiting out a limit, or the overnight queue's (it recovers its own)
    try { sendToThread(t, RESTART_TEXT, [], { auto: "restart" }); } catch (e) { console.error(`Carry on: ${e.message}`); }
  }
}
setTimeout(carryOnAfterRestart, 5000);

/** Start a fresh copy of this server and step aside; it takes the ports as they come free. */
function restartSelf() {
  const log = fs.openSync(path.join(store.dataDir, "b5.log"), "a");
  spawn(process.execPath, [fileURLToPath(import.meta.url)], { detached: true, windowsHide: true, stdio: ["ignore", log, log], env: { ...process.env, B5_RESTARTED: "1" } }).unref();
  console.log("Restarting for an update.");
  shutdown();
}

// A file git doesn't track yet has no diff against HEAD: its lines are counted, and its diff is against nothing.
function newFileLines(file) {
  try {
    if (fs.statSync(file).size > 2 << 20) return "";
    const text = fs.readFileSync(file);
    if (text.includes(0)) return ""; // not text
    const n = text.toString().split("\n").length - (text.at(-1) === 10 ? 1 : 0);
    return n ? String(n) : "";
  } catch { return ""; }
}

function gitDiff(dir, file, since = "HEAD") {
  return new Promise((resolve) => {
    execFile("git", ["-C", dir, "diff", since, "--", file], { maxBuffer: 4 << 20 }, (err, out) => {
      if (!err && out) return resolve(out.slice(0, 200000));
      // Untracked, as git itself says (so the path can't reach outside the repo): `--no-index` exits 1
      // when the files differ, which they always do here.
      execFile("git", ["-C", dir, "ls-files", "--others", "--exclude-standard", "-z", "--", file], { maxBuffer: 1 << 20 }, (err2, listed) => {
        if (err2 || !String(listed).split("\0").includes(file)) return resolve("");
        execFile("git", ["-C", dir, "diff", "--no-index", "--", "/dev/null", file], { maxBuffer: 4 << 20 }, (_err3, out2) => {
          resolve(String(out2 || "").slice(0, 200000));
        });
      });
    });
  });
}

/** Several files' diffs at once: one git diff for the tracked ones, then the new (untracked) ones each. */
async function gitDiffs(dir, files, since = "HEAD") {
  const run = (args) => new Promise((resolve) => execFile("git", ["-C", dir, ...args], { maxBuffer: 16 << 20 }, (_err, out) => resolve(String(out || ""))));
  const tracked = files.filter((f) => f.status !== "??").map((f) => f.file);
  const diffs = tracked.length ? splitDiff(await run(["-c", "core.quotePath=false", "diff", since, "--", ...tracked])) : {};
  for (const f of files) if (f.status === "??") diffs[f.file] = await gitDiff(dir, f.file, since);
  for (const k of Object.keys(diffs)) diffs[k] = diffs[k].slice(0, 200000);
  return diffs;
}

// ── Routes ───────────────────────────────────────────────────────────────────

async function api(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean).slice(1); // after "api"
  const method = req.method;
  const findThread = (id) => {
    const t = store.state.threads.find((x) => x.id === id);
    if (!t) throw Object.assign(new Error("No such thread."), { status: 404 });
    return t;
  };

  if (method === "GET" && parts[0] === "state") {
    const running = {};
    for (const [id, s] of sessions) running[id] = s.session.busy ? "working" : "idle";
    const waiting = {};
    for (const [id, m] of asks) if (m.size) waiting[id] = [...m.values()];
    const names = await Promise.all(store.state.projects.map((p) => projectBranch(p.dir)));
    const projects = store.state.projects.map((p, i) => ({ ...p, branch: names[i] }));
    return send(res, 200, { ...store.state, projects, running, waiting, account, usage, planUsage, accounts: accountsView(), queue: queueView(), automations: automationsView(), defaultModel: defaultModel(), previewBase: req.b5Remote ? `${req.b5Remote.preview}/preview/${PREVIEW_TOKEN}` : `${PREVIEW_ORIGIN}/preview/${PREVIEW_TOKEN}`,
      phone: req.b5Remote ? { device: req.b5Remote.device.name, via: req.b5Remote.via, push: !!req.b5Remote.device.push } : null, home: HOME, platform: IS_WIN ? "windows" : "mac" });
  }

  if (method === "GET" && parts[0] === "version") {
    const stale = serverPrint() !== STARTED_AS;
    return send(res, 200, { server: STARTED_AS, serverNow: serverPrint(), page: pagePrint(), stale, ...(stale ? { running: whatsRunning(), autoUpdate: store.state.settings?.autoUpdate !== false } : {}) });
  }
  // `b5 stop` on Windows (bin/b5.mjs), which has no SIGTERM: the same shutdown, asked with the token in data/.token.
  if (method === "POST" && parts[0] === "quit") {
    if (req.b5Remote) return send(res, 403, { error: `Stop B5 Code from the ${MAC}.` });
    send(res, 200, { ok: true });
    setTimeout(shutdown, 100);
    return;
  }
  if (method === "POST" && parts[0] === "restart") {
    if (req.b5Remote) return send(res, 403, { error: `Restart B5 Code from the ${MAC}.` });
    if (!(await codeStarts())) return send(res, 409, { error: "The new code has a mistake that would stop B5 Code starting, so it keeps running the old one." });
    const body = await readBody(req);
    await checkWindowsTerminals();
    const busy = whatsRunning();
    if (busy.length && !body.carryOn) return send(res, 409, { error: `Still working: ${busy.join(", ")}. Restart when ${busy.length === 1 ? "it's" : "they're"} done.`, busy });
    // Cut short now, carried on after: the threads working or asking.
    const ids = [...new Set([...[...sessions].filter(([, s]) => s.session.busy).map(([id]) => id), ...[...asks].filter(([, m]) => m.size).map(([id]) => id)])];
    send(res, 200, { ok: true });
    restartForUpdate(ids);
    return;
  }

  // An artifact's versions, and one version's source (the Code view, and Markdown shown as a document).
  if (method === "GET" && parts[0] === "artifacts") {
    const file = realFile(previewPathIn(String(url.searchParams.get("path") || "").replace(/^\/+(?=~\/)/, ""), HOME));
    if (!file || !ARTIFACT.test(file) || isPrivate(path.basename(file)) || phoneMayNotRead(req, file)) return send(res, 404, { error: "That isn't a page or document B5 Code can show." });
    if (parts[1] === "versions") return send(res, 200, { path: file, versions: artifacts.versions(file) });
    if (parts[1] === "source") {
      const v = url.searchParams.get("v");
      const buf = v ? artifacts.read(file, v) : fs.readFileSync(file);
      if (!buf) return send(res, 404, { error: "That version isn't kept." });
      return send(res, 200, { path: file, text: buf.toString("utf8").slice(0, 1 << 20) });
    }
  }

  if (method === "GET" && parts[0] === "preview-link") {
    const base = req.b5Remote ? `${req.b5Remote.preview}/preview` : `${PREVIEW_ORIGIN}/preview`;
    const asked = String(url.searchParams.get("path") || "").replace(/^\/+(?=~\/)/, "");
    if (phoneMayNotRead(req, realFile(previewPathIn(asked, HOME)))) return send(res, 403, { error: `Hidden and secret files open on the ${MAC} only.` });
    const link = previewLink(asked, base);
    if (!link) return send(res, 404, { error: "That file isn't in your home folder, or doesn't exist." });
    return send(res, 200, { url: link });
  }

  // The folder browser in "Add a project" (Safari and phones; the Mac app
  // uses Finder's own picker): the folders inside one folder of your home.
  if (method === "GET" && parts[0] === "folders") {
    const asked = expandHome(url.searchParams.get("path") || "~", HOME);
    const dir = realFile(path.resolve(asked));
    if (!dir || !fs.statSync(dir).isDirectory()) return send(res, 404, { error: "That folder isn't in your home folder." });
    const folders = [];
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.name.startsWith(".") || !(d.isDirectory() || d.isSymbolicLink())) continue;
      const full = path.join(dir, d.name);
      try { if (!fs.statSync(full).isDirectory()) continue; } catch { continue; }
      folders.push({ name: d.name, path: full, git: fs.existsSync(path.join(full, ".git")) });
    }
    folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return send(res, 200, { path: dir, home: REAL_HOME, parent: within(REAL_HOME, dir) ? null : path.dirname(dir), git: fs.existsSync(path.join(dir, ".git")), folders: folders.slice(0, 500) });
  }

  // Accounts: the main one and extra ones, signed in through `claude auth login` (Mac only).
  if (parts[0] === "accounts") {
    if (req.b5Remote) return send(res, 403, { error: `Accounts are managed from the ${MAC}.` });
    const body = method === "POST" ? await readBody(req) : {};
    if (method === "GET" && parts.length === 1) return send(res, 200, { accounts: accountsView() });
    // Signing in the main account (Settings, or the sidebar's "Sign in"): only while it isn't, so a
    // click can't swap whose account Claude Code works on.
    if (method === "POST" && parts[1] === MAIN && parts[2] === "sign-in") {
      await loadAccount(accountById(MAIN));
      if (account) return send(res, 409, { error: `Claude Code is signed in already, as ${account.email}.` });
      return send(res, 200, startLogin("", String(body.email || "").trim().slice(0, 200), { main: true }));
    }
    if (method === "POST" && parts.length === 1 && !store.state.settings?.extraAccounts) return send(res, 409, { error: "Turn on More than one account first (Settings › Account)." });
    if (method === "POST" && parts.length === 1) return send(res, 200, startLogin(String(body.name || "").trim().slice(0, 40), String(body.email || "").trim().slice(0, 200)));
    const id = parts[1];
    if (parts[2] === "login") {
      const l = logins.get(id);
      if (!l) return send(res, 404, { error: "That sign-in has ended. Start again." });
      if (method === "GET") return send(res, 200, loginView(l));
      if (method === "POST") return send(res, 200, await finishLogin(l, String(body.code || "").trim()));
      if (method === "DELETE") { endLogin(l, true); return send(res, 200, { ok: true }); }
    }
    if (method === "POST" && parts.length === 2 && typeof body.name === "string") {
      if (!(store.state.accounts || []).some((a) => a.id === id)) return send(res, 404, { error: "No such account." });
      store.save({ ...store.state, accounts: store.state.accounts.map((a) => (a.id === id ? { ...a, name: body.name.trim().slice(0, 40) || a.name } : a)) });
      return send(res, 200, { accounts: accountsView() });
    }
    if (method === "DELETE" && parts.length === 2) return send(res, 200, await removeAccount(id));
    return send(res, 404, { error: "Not found." });
  }

  // The overnight queue: its tasks, on/off and a start time, and each task's actions.
  if (parts[0] === "queue") {
    const body = method === "POST" ? await readBody(req) : {};
    if (method === "GET" && parts.length === 1) return send(res, 200, queueView());
    if (method === "POST" && parts.length === 1) {
      if (IS_WIN && body.on) return send(res, 409, { error: "The overnight queue needs a Mac: its tasks work inside macOS's sandbox." });
      const q = queueState();
      const startAt = body.startAt === null ? 0 : Number.isFinite(body.startAt) ? Math.max(0, body.startAt) : q.startAt || 0;
      saveQueue({ ...q, on: typeof body.on === "boolean" ? body.on : q.on, startAt });
      queueTick();
      return send(res, 200, queueView());
    }
    if (method === "POST" && parts[1] === "tasks" && parts.length === 2) {
      const project = store.state.projects.find((p) => p.id === body.projectId);
      if (!project) return send(res, 404, { error: "No such project." });
      const brief = String(body.brief || "").trim().slice(0, 8000);
      if (!brief) return send(res, 400, { error: "Say what the task is." });
      const checks = String(body.checks || "").trim().slice(0, 300);
      const q = queueState();
      const n = (q.seq || 0) + 1;
      const task = { id: crypto.randomBytes(6).toString("hex"), n, projectId: project.id, brief, checks, status: "queued", createdAt: Date.now() };
      saveQueue({ ...q, seq: n, tasks: [...q.tasks, task] });
      return send(res, 200, queueView());
    }
    if (parts[1] === "tasks" && parts[2]) {
      const q = queueState();
      const i = q.tasks.findIndex((t) => t.id === parts[2]);
      if (i < 0) return send(res, 404, { error: "No such task." });
      const task = q.tasks[i];
      if (method === "POST" && (body.action === "up" || body.action === "down")) {
        const j = body.action === "up" ? i - 1 : i + 1;
        if (j >= 0 && j < q.tasks.length) { const tasks = [...q.tasks]; [tasks[i], tasks[j]] = [tasks[j], tasks[i]]; saveQueue({ ...q, tasks }); }
        return send(res, 200, queueView());
      }
      if (method === "POST" && body.action === "retry") {
        if (task.status === "running" || task.status === "queued") return send(res, 409, { error: "That task hasn't finished." });
        // A new go, on a branch of its own: the old one's work stays until you throw it away.
        const n = (q.seq || 0) + 1;
        saveQueue({ ...q, seq: n, tasks: q.tasks.map((t) => (t.id === task.id ? { id: t.id, n, projectId: t.projectId, brief: t.brief, checks: t.checks, status: "queued", createdAt: t.createdAt, before: t.threadId ? [...(t.before || []), t.threadId] : t.before } : t)) });
        queueTick();
        return send(res, 200, queueView());
      }
      if (method === "DELETE" && parts.length === 3) {
        if (task.status === "running" && sessions.get(task.threadId)?.session.busy) return send(res, 409, { error: "That task is working. Stop its thread first." });
        saveQueue({ ...q, tasks: q.tasks.filter((t) => t.id !== task.id) });
        return send(res, 200, queueView());
      }
      // Throw away a task's work: its worktree and branch (never pushed), and its thread.
      if (method === "DELETE" && parts[3] === "work") {
        const t = store.state.threads.find((x) => x.id === task.threadId);
        if (t && sessions.get(t.id)?.session.busy) return send(res, 409, { error: "That task is working. Stop its thread first." });
        if (t) await throwAway(t);
        saveQueue({ ...queueState(), tasks: queueState().tasks.filter((x) => x.id !== task.id) });
        return send(res, 200, queueView());
      }
    }
    return send(res, 404, { error: "Not found." });
  }

  // Start B5 Code at login (a LaunchAgent, or Windows's Startup folder; server/login.js). On the computer only.
  if (parts[0] === "login-item") {
    if (req.b5Remote) return send(res, 403, { error: `That's set on the ${MAC}.` });
    if (method === "GET") return send(res, 200, { on: fs.existsSync(IS_WIN ? startupLink() : plistPath(HOME)) });
    if (method === "POST") {
      const body = await readBody(req);
      const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 15000, windowsHide: true }, () => resolve()));
      if (IS_WIN) return send(res, 200, { on: await setLoginItemWindows(!!body.on, { fs, run, root: ROOT }) });
      const on = await setLoginItem(!!body.on, { fs, run, root: ROOT, home: HOME, log: path.join(store.dataDir, "login.log"), uid: process.getuid() });
      return send(res, 200, { on });
    }
  }

  // Settings the server acts on: keeping the Mac awake, carrying on after a usage limit.
  if (method === "POST" && parts[0] === "settings") {
    const body = await readBody(req);
    const prevWeb = store.state.settings?.chatWeb !== false;
    const next = { ...SERVER_DEFAULTS, ...(store.state.settings || {}) };
    for (const k of Object.keys(SERVER_DEFAULTS)) if (typeof body[k] === "boolean") next[k] = body[k];
    store.save({ ...store.state, settings: next });
    updateAwake();
    if (typeof body.extraAccounts === "boolean") broadcast(null, { kind: "accounts", accounts: accountsView() });
    // Switched off: threads waiting out a limit don't carry on after all.
    if (!next.autoResume) for (const t of store.state.threads) if (t.resume) setResume(t.id, null, "cancelled");
    // Web search switched on or off: Chat's warmed spare has the old tools; open chats are started again on their next message.
    if (prevWeb !== (next.chatWeb !== false)) for (const p of store.state.projects.filter((x) => x.kind === "chat")) { const spare = spares.get(p.id); if (spare) { spares.delete(p.id); spare.session.close(); } }
    return send(res, 200, next);
  }

  // Conversations started with `claude` in a terminal in this project's folder, to carry on here.
  if (parts[0] === "projects" && parts[1] && parts[2] === "sessions") {
    const p = store.state.projects.find((x) => x.id === parts[1]);
    if (!p) return send(res, 404, { error: "No such project." });
    const known = new Set(store.state.threads.map((t) => t.sessionId).filter(Boolean));
    if (method === "GET") return send(res, 200, { sessions: await listSessions(CLAUDE_DIR, p.dir, known) });
    if (method === "POST") {
      const body = await readBody(req);
      const id = String(body.sessionId || "");
      if (known.has(id)) return send(res, 409, { error: "That conversation is already in B5 Code." });
      const file = sessionFile(CLAUDE_DIR, p.dir, id);
      if (!file) return send(res, 404, { error: "That conversation isn't in this project's folder." });
      const { events, title } = await importSession(file);
      const firstText = events.find((e) => e.kind === "user")?.text || "";
      const { state, thread } = addThread(store.state, p.id);
      const last = events[events.length - 1]?.at || Date.now();
      store.save(updateThread(state, thread.id, { sessionId: id, title: titleFrom(title || firstText || "From the terminal"), imported: true }, last));
      store.appendLogs(thread.id, events);
      return send(res, 200, store.state.threads.find((t) => t.id === thread.id));
    }
  }

  if (method === "POST" && parts[0] === "projects" && parts.length === 1) {
    const body = await readBody(req);
    const dir = path.resolve(expandHome(body.dir || "", HOME));
    // From a phone, only a folder in your home folder (a stolen phone can't point Claude at the whole disk).
    if (req.b5Remote && !realFile(dir)) return send(res, 403, { error: "From a phone, a project's folder has to be in your home folder." });
    let isDir = false;
    try { isDir = fs.statSync(dir).isDirectory(); } catch { /* missing */ }
    if (!isDir) return send(res, 400, { error: `That folder doesn't exist on this ${MAC}.` });
    const { state, project } = addProject(store.state, { name: body.name, dir });
    store.save(state);
    return send(res, 200, project);
  }

  // Chat: its private folder and "About you" note, made the first time.
  if (method === "POST" && parts[0] === "chat" && parts.length === 1) {
    const have = store.state.projects.find((p) => p.kind === "chat");
    if (have) return send(res, 200, have);
    fs.mkdirSync(CHAT_DIR, { recursive: true });
    const notes = path.join(CHAT_DIR, "CLAUDE.md");
    if (!fs.existsSync(notes)) fs.writeFileSync(notes, CHAT_NOTES);
    const { state, project } = addProject(store.state, { name: "Chat", dir: CHAT_DIR, kind: "chat" });
    store.save(state);
    return send(res, 200, project);
  }

  // Settings › Work's "Notes for Claude" and Settings › Chat's "About you": that space's CLAUDE.md.
  if (parts[0] === "notes" && (parts[1] === "work" || parts[1] === "chat") && !parts[2]) {
    const p = store.state.projects.find((x) => x.kind === parts[1]);
    if (!p) return send(res, 404, { error: parts[1] === "work" ? "Start a Work space first." : "Start a chat first." });
    const file = path.join(p.dir, "CLAUDE.md");
    if (method === "GET") { let text = ""; try { text = fs.readFileSync(file, "utf8"); } catch {} return send(res, 200, { text, path: homePath(file) }); }
    if (method === "PUT") {
      if (req.b5Remote) return send(res, 403, { error: `Edit these notes on the ${MAC}.` });
      const { text } = await readBody(req);
      if (typeof text !== "string" || text.length > 20000) return send(res, 400, { error: "The notes need to be text, under 20,000 characters." });
      fs.writeFileSync(file, text);
      return send(res, 200, { ok: true });
    }
  }

  // Show in Finder, for a folder Settings names (never a path the page sends).
  if (method === "POST" && parts[0] === "reveal") {
    if (req.b5Remote) return send(res, 403, { error: `That opens on the ${MAC}.` });
    const { which } = await readBody(req);
    const dir = which === "studio" ? studioDir(store.state.projects, HOME) : store.state.projects.find((x) => x.kind === which && (which === "work" || which === "chat"))?.dir;
    if (!dir || !fs.existsSync(dir)) return send(res, 404, { error: "That folder isn't there yet." });
    execFile(...revealCommand(dir), { windowsHide: true }, () => {});
    return send(res, 200, { ok: true });
  }

  // A Work space: ~/Documents/B5 Work, made with its notes file the first time.
  if (method === "POST" && parts[0] === "work" && parts.length === 1) {
    if (req.b5Remote) return send(res, 403, { error: `Start a Work space from the ${MAC}.` });
    const have = store.state.projects.find((p) => p.kind === "work");
    if (have) return send(res, 200, have);
    fs.mkdirSync(WORK_DIR, { recursive: true });
    const notes = path.join(WORK_DIR, "CLAUDE.md");
    if (!fs.existsSync(notes)) fs.writeFileSync(notes, WORK_NOTES);
    const known = store.state.projects.find((p) => p.dir === WORK_DIR);
    if (known) { store.save(updateProject(store.state, known.id, { kind: "work" })); return send(res, 200, { ...known, kind: "work" }); }
    const { state, project } = addProject(store.state, { name: "Work", dir: WORK_DIR, kind: "work" });
    store.save(state);
    return send(res, 200, project);
  }

  // Automations: made, changed, run now, removed.
  if (parts[0] === "automations") {
    const done = (body) => { syncWatchers(); broadcastAutomations(); return send(res, 200, body); };
    if (method === "POST" && parts.length === 1) {
      const body = await readBody(req);
      const { state, automation } = addAutomation(store.state, { projectId: body.projectId, name: body.name, prompt: body.prompt, trigger: triggerFrom(body.trigger) });
      store.save(state);
      return done(automation);
    }
    const a = (store.state.automations || []).find((x) => x.id === parts[1]);
    if (!a) return send(res, 404, { error: "No such automation." });
    if (method === "PATCH" && parts.length === 2) {
      const body = await readBody(req);
      const patch = {};
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (typeof body.name === "string") patch.name = body.name.trim().slice(0, 60) || a.name;
      if (typeof body.prompt === "string" && body.prompt.trim()) patch.prompt = body.prompt.trim().slice(0, 4000);
      if (body.trigger) { const t = triggerFrom(body.trigger); if (!t) return send(res, 400, { error: "Pick when it runs." }); patch.trigger = t; }
      store.save(updateAutomation(store.state, a.id, patch));
      return done(store.state.automations.find((x) => x.id === a.id));
    }
    if (method === "DELETE" && parts.length === 2) { store.save(removeAutomation(store.state, a.id)); return done({ ok: true }); }
    if (method === "POST" && parts[2] === "run") {
      const threadId = runAutomation(a.id);
      if (!threadId) return send(res, 409, { error: "Its last run is still working." });
      return send(res, 200, { threadId });
    }
  }

  // Recipes: a Work space's tasks kept to run again.
  if (parts[0] === "recipes") {
    if (method === "POST" && parts.length === 1) {
      const body = await readBody(req);
      const { state, recipe } = addRecipe(store.state, { projectId: body.projectId, name: body.name, prompt: body.prompt });
      store.save(state);
      return send(res, 200, recipe);
    }
    if (method === "DELETE" && parts.length === 2) { store.save(removeRecipe(store.state, parts[1])); return send(res, 200, { ok: true }); }
  }

  // The Files tab: ?project=&thread= name the work folder (a branch thread's worktree, or the project's).
  // The GitHub tab: read-only, through the Mac's own `gh` sign-in.
  // Studio: B5 Studio's editor, shown in the main area. It runs on this Mac only.
  if (parts[0] === "studio") {
    const dir = studioDir(store.state.projects, HOME);
    // The sidebar's Studio space and Settings › Studio, asked of the editor itself (an empty answer when it's off).
    if (method === "GET" && parts[1] === "videos") return send(res, 200, dir ? await studioAsk("GET", "/api/videos", []) : []);
    if (method === "GET" && parts[1] === "status") {
      const running = dir ? await studioRunning() : false;
      const st = running ? await studioAsk("GET", "/api/status", {}) : {};
      return send(res, 200, { dir: dir ? homePath(dir) : null, url: STUDIO_URL, running, ...st });
    }
    if (method === "POST" && (parts[1] === "restart" || parts[1] === "clear-cache")) {
      if (req.b5Remote) return send(res, 403, { error: `That's done on the ${MAC}.` });
      if (!dir) return send(res, 404, { error: `B5 Studio isn't on this ${MAC}.` });
      if (parts[1] === "clear-cache") {
        const r = await studioAsk("POST", "/api/cache/clear", null);
        if (!r) return send(res, 409, { error: "Studio's editor isn't running, so there's nothing to clear right now." });
        return r.error ? send(res, 409, { error: r.error }) : send(res, 200, r);
      }
      // Ask the old editor to stop (it refuses during an export), then wait until it has.
      const quit = await studioAsk("POST", "/api/quit", {});
      if (quit?.error) return send(res, 409, { error: quit.error });
      for (let i = 0; i < 25 && (await studioRunning(300)); i++) await new Promise((r) => setTimeout(r, 200));
      if (await studioRunning(300)) return send(res, 409, { error: "The editor that's running didn't stop (it may be an older one). Quit it from its terminal, then try again." });
      const ok = await startStudio(dir, path.join(store.dataDir, "studio.log"));
      return ok ? send(res, 200, { running: true }) : send(res, 500, { error: "B5 Studio's editor didn't start again. Its log is in B5 Code's data/studio.log." });
    }
    if (method === "GET" && !parts[1]) return send(res, 200, { dir, url: STUDIO_URL, running: dir ? await studioRunning() : false });
    if (method === "POST" && parts[1] === "start") {
      if (req.b5Remote) return send(res, 403, { error: `Studio runs on the ${MAC}. Open B5 Code there to edit videos.` });
      if (!dir) return send(res, 404, { error: `B5 Studio isn't on this ${MAC} (looked for ~/Desktop/B5 Studio).` });
      const ok = await startStudio(dir, path.join(store.dataDir, "studio.log"));
      return ok ? send(res, 200, { dir, url: STUDIO_URL, running: true }) : send(res, 500, { error: "B5 Studio's editor didn't start. Its log is in B5 Code's data/studio.log." });
    }
  }

  if (method === "GET" && parts[0] === "github" && !parts[1]) {
    const p = store.state.projects.find((x) => x.id === url.searchParams.get("project"));
    return send(res, 200, await githubOverview(p?.dir || "", { fresh: url.searchParams.has("fresh") }));
  }

  if (parts[0] === "files") {
    const p = store.state.projects.find((x) => x.id === url.searchParams.get("project"));
    if (!p) return send(res, 404, { error: "No such project." });
    const t = store.state.threads.find((x) => x.id === url.searchParams.get("thread") && x.projectId === p.id);
    if (t?.dir && !fs.existsSync(t.dir)) return send(res, 410, { error: "This thread's worktree has been removed." });
    const root = t?.dir || p.dir;
    if (method === "GET" && !parts[1]) return send(res, 200, await listFolder(root, url.searchParams.get("dir") || ""));
    if (method === "GET" && parts[1] === "read") {
      // A phone isn't shown hidden or secret-named files (.env, keys): open those on the Mac.
      const rel = String(url.searchParams.get("path") || "");
      if (req.b5Remote && isPrivate(rel)) return send(res, 403, { error: `Hidden and secret files open on the ${MAC} only.` });
      return send(res, 200, readFile(root, rel));
    }
    if (method === "GET" && parts[1] === "find") {
      const c = fileLists.get(root);
      const files = c && Date.now() - c.at < 10000 ? c.files : await allFiles(root);
      fileLists.set(root, { files, at: Date.now() });
      return send(res, 200, { files: findFiles(files, url.searchParams.get("q") || "") });
    }
    // Opening on the Mac itself: never from a phone.
    if (method === "POST" && parts[1] === "open") {
      if (req.b5Remote) return send(res, 403, { error: `That opens on the ${MAC}, so it's only available there.` });
      const body = await readBody(req);
      const target = inside(root, String(body.path || ""));
      if (!target) return send(res, 404, { error: "That file isn't in this project." });
      const [cmd, args, app] = body.how === "finder" ? [...revealCommand(target, { reveal: true }), FILE_MANAGER] : editorCommand(target);
      // An editor on Windows stays running as the command's own process: started, not waited for.
      // (Explorer's exit code is 1 even when it opened the folder, so only a failure to start counts there.)
      if (IS_WIN) await new Promise((resolve, reject) => { const p = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: false }); p.on("error", (e) => reject(new Error(`Couldn't open it: ${e.message}`))); p.on("spawn", () => { p.unref(); resolve(); }); });
      else await new Promise((resolve, reject) => execFile(cmd, args, { timeout: 10000 }, (err) => (err ? reject(new Error(`Couldn't open it: ${err.message}`)) : resolve())));
      return send(res, 200, { ok: true, app: app || "your text editor" });
    }
    return send(res, 404, { error: "Not found." });
  }

  if (method === "GET" && parts[0] === "projects" && parts[2] === "changes") {
    const p = store.state.projects.find((x) => x.id === parts[1]);
    if (!p) return send(res, 404, { error: "No such project." });
    // A thread on its own branch shows its worktree's changes.
    const t = store.state.threads.find((x) => x.id === url.searchParams.get("thread") && x.projectId === p.id);
    if (t?.dir && !fs.existsSync(t.dir)) return send(res, 200, { git: true, files: [], removed: true });
    const dir = t?.dir || p.dir;
    // A file's diff is against the commit the list was made against (a commit id, never an option for git).
    if (url.searchParams.get("file")) {
      if (req.b5Remote && isPrivate(url.searchParams.get("file"))) return send(res, 403, { error: `Hidden and secret files open on the ${MAC} only.` });
      const since = /^[0-9a-f]{7,64}$/.test(url.searchParams.get("since") || "") ? url.searchParams.get("since") : "HEAD";
      return send(res, 200, { diff: await gitDiff(dir, url.searchParams.get("file"), since) });
    }
    const scope = url.searchParams.get("scope") === "uncommitted" ? "uncommitted" : "chat";
    const changes = await gitChanges(dir, await threadBase(t, dir), scope, t?.createdAt || 0);
    // The first files' diffs come with the list: one git diff for all of them, not a request each.
    const n = Math.min(Number(url.searchParams.get("diffs")) || 0, 50);
    if (n && changes.files?.length) changes.diffs = await gitDiffs(dir, changes.files.slice(0, n).filter((f) => !(req.b5Remote && isPrivate(f.file))), changes.since || "HEAD");
    return send(res, 200, changes);
  }

  // Phone access: managed from the Mac only, never from a paired device.
  if (parts[0] === "phone") {
    if (req.b5Remote) return send(res, 403, { error: `Phone access is managed from the ${MAC}.` });
    if (method === "GET" && parts.length === 1) return send(res, 200, phoneStatus());
    if (method === "POST" && parts.length === 1) {
      const body = await readBody(req);
      await setPhoneAccess(!!body.enabled);
      return send(res, 200, phoneStatus());
    }
    if (method === "POST" && parts[1] === "pair") {
      // Over Tailscale, the home network's access isn't needed to pair.
      if (!phone.enabled && !tailnet.on) await setPhoneAccess(true);
      const { state, pair } = newPairing(phone);
      savePhone(state);
      // The Tailscale address first: it works on Wi-Fi and away.
      const links = [...(tailnet.on && tailnet.dnsName ? [`${tailnetOrigins(tailnet.dnsName).app}/pair?code=${pair.secret}`] : []),
        ...(phone.enabled ? lanAddresses().map((ip) => `https://${ip}:${PHONE_PORT}/pair?code=${pair.secret}`) : [])];
      return send(res, 200, { ...phoneStatus(), pair: { digits: pair.digits, expires: pair.expires, links } });
    }
    if (method === "POST" && parts[1] === "tailscale") {
      const body = await readBody(req);
      await setTailnet(!!body.enabled);
      return send(res, 200, phoneStatus());
    }
    if (method === "DELETE" && parts[1] === "devices" && parts[2]) {
      savePhone(removeDevice(phone, parts[2]));
      // A removed phone stops hearing anything at once, not when its stream happens to drop.
      for (const c of clients) if (c.b5Device === parts[2]) { clients.delete(c); c.end(); }
      return send(res, 200, phoneStatus());
    }
  }

  // Notifications on a paired phone (Web Push). Signing up is done from the phone itself.
  if (parts[0] === "push") {
    if (method === "GET" && parts[1] === "key") return send(res, 200, { publicKey: vapid.publicKey });
    if (!req.b5Remote) return send(res, 403, { error: "Turn notifications on from the phone." });
    const body = method === "POST" ? await readBody(req) : {};
    const id = req.b5Remote.device.id;
    if (method === "POST" && parts[1] === "subscribe") {
      const sub = cleanSubscription(body.subscription);
      if (!sub) return send(res, 400, { error: "That isn't a notification subscription." });
      savePhone({ ...phone, devices: phone.devices.map((d) => (d.id === id ? { ...d, push: sub } : d)) });
      return send(res, 200, { ok: true });
    }
    if (method === "POST" && parts[1] === "unsubscribe") {
      savePhone({ ...phone, devices: phone.devices.map((d) => (d.id === id ? withoutPush(d) : d)) });
      return send(res, 200, { ok: true });
    }
    if (method === "POST" && parts[1] === "test") {
      const d = phone.devices.find((x) => x.id === id);
      if (!d?.push) return send(res, 409, { error: "Notifications aren't on for this phone." });
      const r = await pushTo(d, { title: "B5 Code", body: "Notifications work. Questions, finished threads and account switches arrive like this.", tag: "test" });
      if (!r.ok) console.error(`Test notification: ${r.status || ""} ${r.said || r.error || ""}`);
      return send(res, r.ok ? 200 : 502, r.ok ? { ok: true } : { error: `The push service refused it (${r.status || r.error})${r.said ? `: ${r.said}` : ""}.` });
    }
    return send(res, 404, { error: "Not found." });
  }

  // Which windows are in front, so the phone isn't buzzed while you're looking at B5 Code.
  if (method === "POST" && parts[0] === "presence") {
    const body = await readBody(req);
    presence.set(req.b5Remote ? req.b5Remote.device.id : "mac", body.active ? Date.now() : 0);
    return send(res, 200, { ok: true });
  }

  if (method === "POST" && parts[0] === "usage") {
    refreshUsage();
    return send(res, 200, { ok: true });
  }

  // A file for the next message: the raw bytes, named in x-file-name.
  if (method === "POST" && parts[0] === "uploads") {
    const name = safeName(decodeURIComponent(String(req.headers["x-file-name"] || "file")));
    const type = String(req.headers["content-type"] || "application/octet-stream").split(";")[0];
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > UPLOAD_MAX) return send(res, 413, { error: "Files can be up to 25 MB." });
      chunks.push(c);
    }
    const file = path.join(UPLOADS, `${crypto.randomBytes(4).toString("hex")}-${name}`);
    fs.writeFileSync(file, Buffer.concat(chunks));
    return send(res, 200, { path: file, name, type, size });
  }

  // Project settings: name, connectors. Running threads pick the change up
  // on their next message (their process is closed and resumed).
  if (method === "POST" && parts[0] === "projects" && parts[1] && !parts[2]) {
    const body = await readBody(req);
    const patch = {};
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 40);
    if (body.connectors === "on" || body.connectors === "off") patch.connectors = body.connectors;
    // Checks run commands on the Mac: what they are, whether they run and what they may reach is the Mac's to say.
    if (req.b5Remote && ["checks", "checksOn", "checksNetwork", "approve"].some((k) => k in body)) return send(res, 403, { error: `Change checks on the ${MAC}.` });
    if (typeof body.checksOn === "boolean") patch.checksOn = body.checksOn;
    if (typeof body.checksNetwork === "boolean") patch.checksNetwork = body.checksNetwork;
    if (typeof body.checks === "string") patch.checks = parseChecks(body.checks);
    store.save(updateProject(store.state, parts[1], patch));
    // Turning them on approves exactly what the settings showed (a new command waits on a card instead).
    if (Array.isArray(body.approve)) approveRuns(parts[1], store.state.projects.find((x) => x.id === parts[1])?.dir, body.approve);
    if (patch.connectors) {
      const s = spares.get(parts[1]);
      if (s) { s.session.close(); spares.delete(parts[1]); }
      for (const t of store.state.threads.filter((x) => x.projectId === parts[1])) {
        const live = sessions.get(t.id);
        if (live && !live.session.busy) closeSession(t.id);
      }
    }
    return send(res, 200, store.state.projects.find((x) => x.id === parts[1]));
  }

  // A project's checks: what it has, as set or as found.
  if (method === "GET" && parts[0] === "projects" && parts[2] === "checks") {
    const p = store.state.projects.find((x) => x.id === parts[1]);
    if (!p) return send(res, 404, { error: "No such project." });
    const { pkg, files } = readProject(p.dir);
    const found = detectChecks(pkg, files);
    const checks = p.checks?.length ? p.checks : found;
    return send(res, 200, { on: p.checksOn === true, network: p.checksNetwork === true, checks, text: checksText(checks), found, runs: whatRuns(checks, pkg) });
  }

  if (method === "DELETE" && parts[0] === "projects" && parts[1]) {
    for (const t of store.state.threads.filter((x) => x.projectId === parts[1])) {
      if (sessions.get(t.id)?.session.busy) return send(res, 409, { error: "A thread in this project is still working." });
    }
    for (const t of store.state.threads.filter((x) => x.projectId === parts[1])) { closeSession(t.id); store.deleteLog(t.id); terminals.close(t.id); asks.delete(t.id); lastText.delete(t.id); }
    const spare = spares.get(parts[1]);
    if (spare) { clearTimeout(spare.timer); spare.session.close(); spares.delete(parts[1]); }
    terminals.close(parts[1]);
    store.save(removeProject(store.state, parts[1]));
    return send(res, 200, { ok: true });
  }

  if (method === "POST" && parts[0] === "projects" && parts[2] === "warm") {
    const body = await readBody(req);
    warmSpare(parts[1], cleanModel(body.model));
    return send(res, 200, { ok: true });
  }

  // /api/terminals/<thread or project id>[/input|/resize|/stop|/restart]
  if (parts[0] === "terminals" && parts[1]) {
    if (req.b5Remote) return send(res, 403, { error: `The terminal is only available on the ${MAC}.` });
    if (!pty.spawn) return send(res, 503, { error: pty.error });
    const id = parts[1], action = parts[2] || "";
    const body = method === "POST" ? await readBody(req) : {};
    if (method === "GET" && !action) return send(res, 200, terminals.snapshot(id));
    if (method === "POST" && (!action || action === "restart")) {
      const size = { cwd: terminalDir(id), cols: Number(body.cols) || 80, rows: Number(body.rows) || 24 };
      return send(res, 200, action ? terminals.restart(id, size) : terminals.open(id, size));
    }
    if (method === "POST" && action === "input") return send(res, 200, { ok: terminals.write(id, String(body.data ?? "")) });
    if (method === "POST" && action === "resize") return send(res, 200, { ok: terminals.resize(id, Number(body.cols), Number(body.rows)) });
    if (method === "POST" && action === "stop") return send(res, 200, { ok: terminals.stop(id) });
    return send(res, 404, { error: "Not found." });
  }

  if (method === "POST" && parts[0] === "threads" && parts.length === 1) {
    const body = await readBody(req);
    const patch = cleanModel(body.model) ? { modelPref: cleanModel(body.model) } : {};
    // Studio's Claude tab: one thread per video, named after it (so it isn't renamed from its first message).
    if (typeof body.studioVideo === "string" && /^[a-z0-9-]{1,60}$/.test(body.studioVideo)) {
      patch.studioVideo = body.studioVideo;
      patch.title = titleFrom(`${String(body.title || body.studioVideo).slice(0, 60)} (video)`);
    }
    // Its own branch: the worktree is made before the thread exists, so a
    // failure (a name that's taken, no Git) leaves nothing behind.
    if (body.branch) {
      const project = store.state.projects.find((p) => p.id === body.projectId);
      if (!project) return send(res, 404, { error: "No such project." });
      const branch = branchName(body.branch);
      const { dir, root } = await createWorktree(project.dir, branch);
      Object.assign(patch, { dir, root, branch });
    }
    // Built from the state as it is now: making a worktree takes seconds, and
    // other threads save meanwhile.
    const { state, thread } = addThread(store.state, body.projectId);
    const next = Object.keys(patch).length ? updateThread(state, thread.id, patch) : state;
    store.save(next);
    return send(res, 200, next.threads.find((t) => t.id === thread.id));
  }

  if (parts[0] === "threads" && parts[1]) {
    const thread = findThread(parts[1]);
    const action = parts[2];

    if (method === "GET" && action === "log") return send(res, 200, store.readLog(thread.id));

    if (method === "DELETE" && !action) {
      if (sessions.get(thread.id)?.session.busy) return send(res, 409, { error: "This thread is still working. Stop it first." });
      const sides = store.state.threads.filter((t) => t.sideOf === thread.id);
      if (sides.some((t) => sessions.get(t.id)?.session.busy)) return send(res, 409, { error: "A side chat of this thread is still working. Stop it first." });
      // ?worktree=1: its worktree and local branch go too, but never with work only they hold.
      if (url.searchParams.get("worktree") === "1" && thread.branch) {
        const project = store.state.projects.find((p) => p.id === thread.projectId);
        const unpushed = await unpushedCommits(project.dir, thread.branch);
        if (unpushed) return send(res, 409, { error: `${thread.branch} has ${unpushed} commit${unpushed === 1 ? "" : "s"} that aren't on GitHub. Push ${unpushed === 1 ? "it" : "them"}, or keep the worktree.` });
        await removeWorktree(project.dir, thread.root || thread.dir, thread.branch);
      }
      for (const t of [thread, ...sides]) {
        closeSession(t.id);
        terminals.close(t.id);
        asks.delete(t.id);
        lastText.delete(t.id);
        store.deleteLog(t.id);
      }
      store.save(removeThread(store.state, thread.id));
      return send(res, 200, { ok: true });
    }

    // Where the thread's folder stands in git, for the next-step buttons (no tokens: git and gh).
    if (method === "GET" && action === "git") return send(res, 200, await gitState(thread));
    if (method === "POST" && action === "merge-branch") {
      const st = await gitState(thread);
      if (!st.git || !st.pr) return send(res, 409, { error: "This branch has no PR to merge." });
      return send(res, 200, { pr: await mergePr(thread.dir || store.state.projects.find((p) => p.id === thread.projectId)?.dir, st.branch).finally(() => prCache.delete(st.dir + "\0" + st.branch)) });
    }

    // A thread on its own branch: its PR, merging it, and removing the worktree.
    if (["pr", "merge", "worktree"].includes(action)) {
      if (!thread.branch) return send(res, 400, { error: "This thread isn't on its own branch." });
      const project = store.state.projects.find((p) => p.id === thread.projectId);
      const exists = fs.existsSync(thread.dir);
      const where = exists ? thread.dir : project.dir;
      if (method === "GET" && action === "pr") {
        return send(res, 200, { branch: thread.branch, dir: thread.dir, removed: !exists, pr: await prStatus(where, thread.branch),
          prompt: openPrPrompt({ branch: thread.branch, template: exists ? prTemplate(thread.dir) : null }) });
      }
      if (method === "POST" && action === "merge") return send(res, 200, { pr: await mergePr(where, thread.branch) });
      if (method === "DELETE" && action === "worktree") {
        const pr = await prStatus(where, thread.branch);
        if (pr?.state !== "merged") return send(res, 409, { error: "Remove the worktree after its PR is merged." });
        // Its side chats work in the same worktree.
        const sides = store.state.threads.filter((t) => t.sideOf === thread.id);
        if ([thread, ...sides].some((t) => sessions.get(t.id)?.session.busy)) return send(res, 409, { error: "This thread or one of its side chats is still working." });
        const unpushed = await unpushedCommits(project.dir, thread.branch);
        if (unpushed) return send(res, 409, { error: `${thread.branch} has ${unpushed} commit${unpushed === 1 ? "" : "s"} that aren't on GitHub. Push or drop ${unpushed === 1 ? "it" : "them"} first.` });
        for (const t of [thread, ...sides]) { closeSession(t.id); terminals.close(t.id); }
        await removeWorktree(project.dir, thread.root || thread.dir, thread.branch);
        return send(res, 200, { ok: true });
      }
    }

    // Run the project's checks now (Run again, or just turned on).
    if (method === "POST" && action === "checks") {
      if (sessions.get(thread.id)?.session.busy) return send(res, 409, { error: "Wait until this turn is done." });
      const body = await readBody(req);
      if (body.approve) {
        // What checks run is the Mac's to say: a phone can only run them again.
        if (req.b5Remote) return send(res, 403, { error: `Approve checks on the ${MAC}.` });
        const { stale } = approveRuns(thread.projectId, thread.dir || store.state.projects.find((p) => p.id === thread.projectId)?.dir, body.approve);
        if (stale) {
          shownWaiting.delete(thread.id); // its card shows the change as it is now
          checksAfterTurn(thread.id).catch(() => {});
          return send(res, 409, { error: "It changed again since that card. Look at the new one." });
        }
      }
      checksAfterTurn(thread.id).catch((e) => console.error(`Checks: ${e.message}`));
      return send(res, 200, { ok: true });
    }

    if (method === "POST" && action === "send") {
      const body = await readBody(req);
      const text = String(body.text || "").trim();
      const attachments = (Array.isArray(body.attachments) ? body.attachments : [])
        .filter((a) => a && isUpload(a.path, UPLOADS) && fs.existsSync(a.path))
        .slice(0, 10)
        .map((a) => ({ path: path.resolve(a.path), name: safeName(a.name), type: String(a.type || ""), size: fs.statSync(a.path).size }));
      if (!text && !attachments.length) return send(res, 400, { error: "Nothing to send." });
      // You took over from a thread waiting out a usage limit.
      if (thread.resume) setResume(thread.id, null, "you");
      const steer = sendToThread(thread, text, attachments);
      return send(res, 200, { ok: true, steer });
    }

    // A thread waiting out a usage limit: carry on now, or don't carry on.
    if (method === "POST" && action === "resume") {
      const body = await readBody(req);
      if (!thread.resume) return send(res, 410, { error: "This thread isn't waiting for a usage limit." });
      if (body.action === "now") carryOn(thread, { now: true });
      else setResume(thread.id, null, "cancelled");
      return send(res, 200, { ok: true });
    }

    // Move a thread to another account; its next message resumes the conversation there.
    if (method === "POST" && action === "account") {
      const body = await readBody(req);
      const to = accountById(String(body.account || ""));
      if (!to) return send(res, 404, { error: "No such account." });
      if (!signedIn(to.id)) return send(res, 409, { error: "That account isn't signed in." });
      moveThread(thread.id, to.id, "you");
      return send(res, 200, store.state.threads.find((t) => t.id === thread.id));
    }

    // A side chat: a copy of this conversation to ask about it while it carries on.
    if (method === "POST" && action === "side") {
      const body = await readBody(req);
      const { state, thread: side } = addSide(store.state, thread.id);
      store.save(state);
      const text = String(body.text || "").trim();
      if (text) sendToThread(side, text, []);
      return send(res, 200, store.state.threads.find((t) => t.id === side.id));
    }

    if (method === "POST" && action === "warm") {
      sessionFor(thread).warm();
      clearTimeout(sessions.get(thread.id)?.idleTimer);
      armIdle(thread.id);
      return send(res, 200, { ok: true });
    }

    if (method === "POST" && action === "model") {
      const body = await readBody(req);
      const model = cleanModel(body.model);
      store.save(updateThread(store.state, thread.id, { modelPref: model }));
      sessions.get(thread.id)?.session.setModel(model);
      return send(res, 200, { ok: true });
    }

    if (method === "POST" && action === "stop") {
      return send(res, 200, { ok: !!sessions.get(thread.id)?.session.interrupt() });
    }

    if (method === "POST" && action === "permission") {
      const body = await readBody(req);
      const choice = ["allow", "deny", "allow-edits"].includes(body.choice) ? body.choice : "deny";
      const s = sessions.get(thread.id)?.session;
      // Claude's question: the answers must answer its questions (web/questions.js).
      const asked = s?.pending.get(String(body.requestId || ""));
      const answers = body.answers ? cleanAnswers(questionsOf(ASK_TOOL, asked), body.answers) : null;
      if (body.answers && !answers) return send(res, 400, { error: "Answer each question." });
      const ok = !!s?.answerPermission(String(body.requestId || ""), choice, { answers });
      if (ok) {
        const ev = { kind: "permission_answer", requestId: body.requestId, choice, ...(answers ? { answers } : {}) };
        store.appendLog(thread.id, ev);
        broadcast(thread.id, ev);
        queueAnsweredByOwner(thread.id);
      }
      return send(res, ok ? 200 : 410, ok ? { ok } : { error: "That question has expired." });
    }
  }

  return send(res, 404, { error: "Not found." });
}

// Whatever goes wrong in one request answers that request, and never takes
// the server (and every running thread with it) down.
const guarded = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => {
  console.error(`Request failed: ${req.method} ${String(req.url).split("?")[0].slice(0, 200)}: ${e.stack || e.message}`);
  if (!res.headersSent) send(res, 500, "Something went wrong.", "text/plain"); else res.end();
});
const server = http.createServer(guarded((req, res) => handle(req, res)));

/** The request's URL, or null for a malformed one (which must not crash the server). */
function urlOf(req) {
  try { return new URL(req.url, "http://b5.invalid"); } catch { return null; }
}

// Every request, from the Mac (remote = null) or a paired device.
async function handle(req, res, remote = null) {
  if (!remote && !hostOk(req)) return send(res, 421, "Wrong host", "text/plain");
  req.b5Remote = remote;
  const url = urlOf(req);
  if (!url) return send(res, 400, "Bad request", "text/plain");

  if (url.pathname === "/api/events") {
    if (!sameToken(url.searchParams.get("token"), tokenFor(remote))) return send(res, 403, { error: "Bad token." });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(": hello\n\n");
    res.b5Remote = !!remote;
    res.b5Device = remote?.device.id || null;
    clients.add(res);
    // A named event, not a comment: the page sees it, and reconnects when they stop coming
    // (a phone's connection can die quietly when it sleeps or changes network).
    const ping = setInterval(() => res.write("event: ping\ndata: 1\n\n"), 20000);
    req.on("close", () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    if (!sameToken(req.headers["x-desk-token"], tokenFor(remote))) return send(res, 403, { error: "Bad token." });
    try {
      return await api(req, res, url);
    } catch (e) {
      return send(res, e.status || 400, { error: e.message || "Something went wrong." });
    }
  }

  if (req.method !== "GET") return send(res, 405, "Method not allowed", "text/plain");
  return serveStatic(req, res, url.pathname, remote ? remote.preview : undefined, tokenFor(remote));
}

const previewServer = http.createServer(guarded((req, res) => {
  if (req.headers.host !== `localhost:${PREVIEW_PORT}` && req.headers.host !== `127.0.0.1:${PREVIEW_PORT}`) return send(res, 421, "Wrong host", "text/plain");
  const u = urlOf(req);
  const pv = (u?.pathname || "").match(/^\/preview\/([0-9a-f]+)\/(.*)$/);
  if (!pv) return send(res, 403, "Bad preview link. Reopen it from B5 Code.", "text/plain");
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed", "text/plain");
  return servePreview(req, res, pv[1], pv[2], `http://localhost:${PORT} http://127.0.0.1:${PORT}`, u.searchParams.get("v"));
}));
// A port already taken means another B5 Code is running (or the last one
// is still closing): say so and leave, rather than crash with a stack trace.
// A server started by a restart (B5_RESTARTED) waits up to 15 s for the old
// one to let go of the ports.
let portTries = 0;
for (const [srv, port] of [[server, PORT], [previewServer, PREVIEW_PORT]]) {
  srv.on("error", (e) => {
    if (e.code === "EADDRINUSE" && process.env.B5_RESTARTED && portTries++ < 60) { setTimeout(() => srv.listen(port, HOST), 250); return; }
    if (e.code === "EADDRINUSE") console.error(`Port ${port} is in use: B5 Code is already running, or still closing. Exiting.`);
    else console.error(`Server error on port ${port}: ${e.message}`);
    process.exit(1);
  });
}
previewServer.listen(PREVIEW_PORT, HOST);

// ── Phone access ─────────────────────────────────────────────────────────────
// Off unless switched on in Settings. Then B5 Code also listens on your
// network over HTTPS (PHONE_PORT for the app, PHONE_PREVIEW_PORT for
// previews), with a certificate from its own authority (server/tls.js), and
// every request needs a paired device's cookie. Pairing is by a one-time
// QR link or six digits made on the Mac (server/devices.js).

const PHONE_PORT = PORT + 2;
const PHONE_PREVIEW_PORT = PORT + 3;
const PHONE_FILE = path.join(store.dataDir, "devices.json");
let phone = loadPhone();
let phoneServers = [];
let phoneTls = null; // { key, cert, ca } while phone access is on
let phoneTlsTimer = null;

function loadPhone() {
  try { return { ...emptyDevices(), ...JSON.parse(fs.readFileSync(PHONE_FILE, "utf8")) }; } catch { return emptyDevices(); }
}
function savePhone(next) {
  phone = next;
  fs.writeFileSync(PHONE_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
}

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a.address);
}

function phoneStatus() {
  return {
    enabled: !!phone.enabled,
    addresses: lanAddresses().map((ip) => `https://${ip}:${PHONE_PORT}`),
    devices: phone.devices.map(({ id, name, createdAt, lastSeen, push }) => ({ id, name, createdAt, lastSeen, push: !!push })),
    tailscale: { on: tailnet.on, installed: !!findCli(), state: tailnet.state, address: tailnet.on && tailnet.dnsName ? tailnetOrigins(tailnet.dnsName).app : "",
      dnsName: tailnet.dnsName, https: tailnet.https, problem: tailnet.problem, link: tailnet.link, busy: tailnet.busy },
  };
}

function cookieKey(req) {
  const m = /(?:^|;\s*)b5_device=([0-9a-f]{48})/.exec(req.headers.cookie || "");
  return m ? m[1] : "";
}

function pairPage(res, message = "", status = 200) {
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; script-src 'self'; manifest-src 'self'; img-src 'self'; worker-src 'self'" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair with B5 Code</title><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#4b49d6"><link rel="icon" href="/icon-192.png"><script src="/pair.js" defer></script>
<style>body{margin:0;font:16px -apple-system,system-ui,sans-serif;background:#f4f5f7;color:#18181b;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
main{max-width:360px;width:100%;background:#fff;border-radius:18px;padding:24px;box-shadow:0 8px 30px rgba(0,0,0,.08)}h1{font-size:20px;margin:0 0 8px}p{color:#5d6470;margin:0 0 16px;line-height:1.5}
input{width:100%;box-sizing:border-box;font-size:26px;letter-spacing:8px;text-align:center;padding:12px;border:1px solid #e1e4ea;border-radius:12px}
button{margin-top:12px;width:100%;height:48px;border:0;border-radius:12px;background:#18181b;color:#fff;font-size:16px;font-weight:600}.err{color:#b91c1c}
.small{font-size:13px;margin:18px 0 0}a{color:#4b49d6}</style></head>
<body><main><h1>Pair with B5 Code</h1><p>On your Mac, open B5 Code › Settings › Phone access and scan the QR code, or type the six digits shown there.</p>
${message ? `<p class="err">${esc(message)}</p>` : ""}<form method="post" action="/pair"><input name="digits" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000000" aria-label="Six-digit code" required><button>Pair this device</button></form>
<p class="small">Saw a certificate warning? That's B5 Code's own certificate. <a href="/b5-certificate">Install it</a> to stop the warnings: on iPhone, open Settings › Profile Downloaded › Install, then Settings › General › About › Certificate Trust Settings and switch on B5 Code.</p></main></body></html>`);
}

const PUBLIC_FILES = new Set(["/manifest.webmanifest", "/sw.js", "/pair.js", "/icon-192.png", "/icon-512.png", "/icon-maskable.png", "/icon.svg"]);

/** Where a phone reaches B5 Code: the home network's address, or the tailnet's. */
function remoteOrigins(via, host) {
  if (via === "tailnet") return tailnetOrigins(tailnet.dnsName);
  return { app: `https://${host}:${PHONE_PORT}`, preview: `https://${host}:${PHONE_PREVIEW_PORT}` };
}

// Tailscale hands requests on from this Mac: the Host must be the tailnet name
// (or Tailscale's own 127.0.0.1 forward), never anything else a page might send.
function tailnetHostOk(req) {
  const h = String(req.headers.host || "").toLowerCase();
  return !!tailnet.dnsName && (h === tailnet.dnsName || h === `${tailnet.dnsName}:443` || h === `${tailnet.dnsName}:${TAILNET_PREVIEW_HTTPS}` ||
    h === `127.0.0.1:${TAILNET_PORT}` || h === `127.0.0.1:${TAILNET_PREVIEW_PORT}`);
}

async function handlePhone(req, res, via = "lan") {
  if (via === "tailnet" && !tailnetHostOk(req)) return send(res, 421, "Wrong host", "text/plain");
  const host = String(req.headers.host || "").replace(/:\d+$/, "");
  const url = urlOf(req);
  if (!url) return send(res, 400, "Bad request", "text/plain");
  // The authority's certificate is public: installing it on the phone ends the warnings.
  if (url.pathname === "/b5-certificate" && phoneTls && via === "lan") {
    res.writeHead(200, { "content-type": "application/x-x509-ca-cert", "content-disposition": 'attachment; filename="B5 Code.crt"', "cache-control": "no-store" });
    return res.end(phoneTls.ca);
  }
  if (url.pathname === "/pair") {
    let secret = "", digits = "";
    // Only the QR code's link opened as itself (or the pairing page's own form) may try: another
    // site's image, link or form would use up the five tries and lock out your real code.
    const site = String(req.headers["sec-fetch-site"] || "");
    const fromElsewhere = site && site !== "same-origin" && site !== "none";
    if (req.method === "GET") {
      secret = url.searchParams.get("code") || "";
      if (!secret) return pairPage(res);
      if (fromElsewhere || (req.headers["sec-fetch-dest"] && req.headers["sec-fetch-dest"] !== "document")) return pairPage(res, "Open the link from the QR code itself.", 403);
    } else if (req.method === "POST") {
      if (fromElsewhere) return pairPage(res, "Pair from this page.", 403);
      // Six digits fit in a few bytes; anything long is cut off and the rest ignored.
      const body = await new Promise((resolve) => {
        let b = "";
        req.on("data", (c) => { if (b.length < 1000) b += c; });
        req.on("end", () => resolve(b.slice(0, 1000)));
        req.on("error", () => resolve(""));
      });
      digits = new URLSearchParams(body).get("digits") || "";
    } else return send(res, 405, "Method not allowed", "text/plain");
    const r = redeem(phone, { secret, digits, name: deviceName(req.headers["user-agent"]) });
    savePhone(r.state);
    if (!r.ok) return pairPage(res, r.reason, 403);
    res.writeHead(303, { location: "/", "set-cookie": `b5_device=${r.key}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 3600}`, "cache-control": "no-store" });
    return res.end();
  }
  // What Chrome needs to install B5 Code as an app, which it fetches without the site's cookies:
  // the manifest, its icons and the service worker. Nothing in them is private.
  if (req.method === "GET" && PUBLIC_FILES.has(url.pathname)) return serveStatic(req, res, url.pathname, remoteOrigins(via, host).preview);
  const device = deviceFor(phone, cookieKey(req));
  if (!device) return pairPage(res, "", 401);
  if (Date.now() - (device.lastSeen || 0) > 10 * 60 * 1000) savePhone({ ...phone, devices: phone.devices.map((d) => (d.id === device.id ? { ...d, lastSeen: Date.now() } : d)) });
  // A notification's Allow / Don't allow, from the phone's service worker: its one-time key, and the device's cookie.
  if (url.pathname === "/push-answer" && req.method === "POST") return pushAnswer(req, res, device);
  return handle(req, res, { device, host, via, ...remoteOrigins(via, host) });
}

function handlePhonePreview(req, res, via = "lan") {
  if (via === "tailnet" && !tailnetHostOk(req)) return send(res, 421, "Wrong host", "text/plain");
  if (!deviceFor(phone, cookieKey(req))) return send(res, 401, "Pair this device with B5 Code first.", "text/plain");
  const u = urlOf(req);
  const pv = (u?.pathname || "").match(/^\/preview\/([0-9a-f]+)\/(.*)$/);
  if (!pv) return send(res, 403, "Bad preview link.", "text/plain");
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed", "text/plain");
  const host = String(req.headers.host || "").replace(/:\d+$/, "");
  return servePreview(req, res, pv[1], pv[2], remoteOrigins(via, host).app, u.searchParams.get("v"), true);
}

// ── Tailscale ────────────────────────────────────────────────────────────────
// Settings › Phone access › Reach B5 Code from anywhere: two local ports of
// B5 Code's own (the app and its previews), which Tailscale serves over HTTPS
// on the Mac's tailnet name (server/tailscale.js). Every request on them needs
// a paired device, as on the home network.

const TAILNET_PORT = PORT + 4;
const TAILNET_PREVIEW_PORT = PORT + 5;
const tailnet = { on: false, state: "", dnsName: "", https: false, problem: "", link: "", busy: false, servers: [] };

function tsRun(args, timeout = 20000) {
  return new Promise((resolve) => {
    const cli = findCli();
    if (!cli) return resolve({ ok: false, out: `Tailscale isn't installed on this ${MAC}.` });
    execFile(cli, args, { timeout, maxBuffer: 1 << 20 }, (err, out, errOut) => resolve({ ok: !err, out: `${out || ""}${errOut || ""}` }));
  });
}

async function readTailnet() {
  const r = await tsRun(["status", "--json"], 10000);
  const st = parseTailscaleStatus(r.out);
  Object.assign(tailnet, { state: findCli() ? st.state : "missing", dnsName: st.dnsName, https: st.https });
  return st;
}

/** Switch reaching B5 Code over Tailscale on or off; what went wrong is kept for Settings to show. */
async function setTailnet(on) {
  if (tailnet.busy) throw Object.assign(new Error("Tailscale is still being set up."), { status: 409 });
  tailnet.busy = true;
  try {
    tailnet.problem = ""; tailnet.link = "";
    if (on) {
      const st = await readTailnet();
      if (!findCli()) throw new Error(`Install Tailscale on this ${MAC} first, and sign in.`);
      if (st.state !== "running") throw new Error(st.state === "signed-out" ? `Open Tailscale on this ${MAC} and sign in, with the same account as your phone.` : `Open Tailscale on this ${MAC} and connect it.`);
      if (!st.dnsName) throw new Error(`Tailscale hasn't given this ${MAC} a name yet. Turn on MagicDNS in Tailscale's admin console (DNS page).`);
      // B5 Code's own ports first, so Tailscale never forwards to nothing.
      if (!tailnet.servers.length) tailnet.servers = await listenLocal([[TAILNET_PORT, (q, r) => handlePhone(q, r, "tailnet")], [TAILNET_PREVIEW_PORT, (q, r) => handlePhonePreview(q, r, "tailnet")]]);
      for (const [https, local] of [[443, TAILNET_PORT], [TAILNET_PREVIEW_HTTPS, TAILNET_PREVIEW_PORT]]) {
        const r = await tsRun(serveArgs(https, local), 25000);
        const status = await tsRun(["serve", "status", "--json"], 10000);
        if (!serving(status.out, st.dnsName, https, local)) {
          // Serve or HTTPS certificates not yet allowed for the tailnet: Tailscale prints where to allow it.
          tailnet.link = adminLink(r.out);
          throw new Error(tailnet.link ? "Tailscale needs you to allow HTTPS for your devices first. Open the link, allow it, then switch this on again."
            : `Tailscale didn't set it up: ${r.out.trim().split("\n").pop() || "no answer"}`);
        }
      }
      tailnet.on = true;
      await readTailnet(); // the certificate's name is known now
    } else {
      // Only B5 Code's own two entries go; anything else you serve is left alone.
      for (const [https, local] of [[443, TAILNET_PORT], [TAILNET_PREVIEW_HTTPS, TAILNET_PREVIEW_PORT]]) {
        const status = await tsRun(["serve", "status", "--json"], 10000);
        if (serving(status.out, tailnet.dnsName, https, local)) await tsRun(serveArgs(https, local, true));
      }
      for (const srv of tailnet.servers) { srv.closeAllConnections?.(); srv.close(); }
      tailnet.servers = [];
      tailnet.on = false;
    }
    if (!!phone.tailscale !== on) savePhone({ ...phone, tailscale: on });
  } catch (e) {
    tailnet.problem = e.message;
    if (on) { tailnet.on = false; for (const srv of tailnet.servers) srv.close(); tailnet.servers = []; }
    throw e;
  } finally {
    tailnet.busy = false;
  }
}

/** Listen on 127.0.0.1 only, all the ports or none. */
async function listenLocal(list) {
  const servers = [], taken = [];
  await Promise.all(list.map(([port, fn]) => new Promise((resolve) => {
    const srv = http.createServer(guarded(fn));
    srv.once("error", (e) => { taken.push(`${port} (${e.code})`); resolve(); });
    srv.listen(port, HOST, () => { servers.push(srv); resolve(); });
  })));
  if (taken.length) { for (const srv of servers) srv.close(); throw new Error(`Port ${taken.join(" and ")} is in use by another app.`); }
  return servers;
}

// ── Notifications (Web Push) ─────────────────────────────────────────────────
// A paired phone that turned notifications on gets one when Claude asks
// something (with Allow / Don't allow), when a thread finishes, and when a
// thread moves account or waits out a limit; but not while a B5 Code window
// (the Mac's or that phone's) is in front, since then you can see it.

const vapid = loadVapid(path.join(store.dataDir, "vapid.json"));
const presence = new Map(); // "mac" or a device id -> when its window was last in front
const answerKeys = new Map(); // one-time key -> { threadId, requestId, exp }
const withoutPush = ({ push, ...rest }) => rest;

const someoneLooking = () => [...presence.values()].some((at) => Date.now() - at < 90 * 1000);

async function pushTo(device, data) {
  try {
    const r = await sendPush(device.push, data, vapid);
    // The phone has unsubscribed (or reinstalled): forget it.
    if (r.gone) savePhone({ ...phone, devices: phone.devices.map((d) => (d.id === device.id ? withoutPush(d) : d)) });
    return r;
  } catch (e) { return { ok: false, error: e.message }; }
}

function notifyPhones(data) {
  if (someoneLooking()) return;
  for (const d of phone.devices) if (d.push) pushTo(d, data).catch(() => {});
}

/** What a thread's events tell the phone. */
function pushFor(threadId, ev) {
  if (!phone.devices.some((d) => d.push)) return;
  const t = store.state.threads.find((x) => x.id === threadId);
  if (!t) return;
  const p = store.state.projects.find((x) => x.id === t.projectId);
  const title = `${p ? p.name + ": " : ""}${t.title}`;
  if (ev.kind === "permission") {
    const key = crypto.randomBytes(18).toString("base64url");
    for (const [k, v] of answerKeys) if (v.exp < Date.now()) answerKeys.delete(k);
    answerKeys.set(key, { threadId, requestId: ev.requestId, exp: Date.now() + 24 * 3600 * 1000 });
    const question = ev.tool === ASK_TOOL;
    notifyPhones({ title, body: question ? `Claude has a question: ${questionsOf(ASK_TOOL, ev.input)?.[0]?.question || ev.summary}` : `Claude is asking: ${ev.summary}`, tag: `ask-${ev.requestId}`, threadId, answerKey: key,
      actions: question ? [{ action: "open", title: "Answer…" }, { action: "deny", title: "Skip" }] : [{ action: "open", title: "Allow…" }, { action: "deny", title: "Don't allow" }] });
  }
  if (ev.kind === "done" && !ev.more) notifyPhones({ title, body: ev.ok ? (t.lastReply || "Finished.") : `Stopped: ${String(ev.error || "").slice(0, 120)}`, tag: `done-${threadId}`, threadId });
  if (ev.kind === "account" && ev.why === "limit") notifyPhones({ title, body: `${ev.fromName} reached its usage limit, so this carries on with ${ev.toName}.`, tag: `acct-${threadId}`, threadId });
  if (ev.kind === "limit") notifyPhones({ title, body: "Usage limit reached on every account. It carries on by itself when one resets.", tag: `limit-${threadId}`, threadId });
}

async function pushAnswer(req, res, device) {
  let body = {};
  try { body = await readBody(req); } catch { return send(res, 400, { error: "Bad request." }); }
  const key = String(body.key || "");
  const k = answerKeys.get(key);
  if (!k || k.exp < Date.now()) return send(res, 410, { error: "That question has closed." });
  answerKeys.delete(key); // one use
  // Only "Don't allow" is answered from a notification: allowing needs the phone unlocked, in the app,
  // so nobody holding a locked phone can approve a command.
  const choice = "deny";
  const ok = !!sessions.get(k.threadId)?.session.answerPermission(k.requestId, choice);
  if (ok) {
    const ev = { kind: "permission_answer", requestId: k.requestId, choice, from: device.name };
    store.appendLog(k.threadId, ev);
    broadcast(k.threadId, ev);
    queueAnsweredByOwner(k.threadId);
  }
  return send(res, ok ? 200 : 410, ok ? { ok } : { error: "That question has closed." });
}

// One at a time: switching on and pairing at once would make two certificates over each other,
// and the loser's "port taken" would switch off what the winner just started.
let phoneAccessTurn = Promise.resolve();
function setPhoneAccess(on) {
  const next = phoneAccessTurn.then(() => setPhoneAccessNow(on), () => setPhoneAccessNow(on));
  phoneAccessTurn = next.catch(() => {});
  return next;
}

async function setPhoneAccessNow(on) {
  if (on && !phoneServers.length) {
    const tls = await ensureCertificate(path.join(store.dataDir, "tls"), lanAddresses());
    const servers = [https.createServer({ key: tls.key, cert: tls.cert }, guarded(handlePhone)), https.createServer({ key: tls.key, cert: tls.cert }, guarded(handlePhonePreview))];
    const taken = [];
    await Promise.all(servers.map((srv, i) => new Promise((resolve) => {
      const port = i ? PHONE_PREVIEW_PORT : PHONE_PORT;
      srv.once("error", (e) => { taken.push(`${port} (${e.code})`); resolve(); });
      srv.listen(port, "0.0.0.0", resolve);
    })));
    // Both ports or neither: half of phone access would hand a phone's code
    // and cookie to whatever else is listening on the other port.
    if (taken.length) {
      for (const srv of servers) if (srv.listening) srv.close();
      if (phone.enabled) savePhone({ ...phone, enabled: false, pair: null });
      throw new Error(`Port ${taken.join(" and ")} is in use by another app, so phone access stays off.`);
    }
    phoneServers = servers;
    phoneTls = tls;
    // A Mac that moves to another network gets a certificate for its new address.
    phoneTlsTimer = setInterval(async () => {
      try {
        const next = await ensureCertificate(path.join(store.dataDir, "tls"), lanAddresses());
        if (next.cert !== phoneTls?.cert) { phoneTls = next; for (const srv of phoneServers) srv.setSecureContext({ key: next.key, cert: next.cert }); }
      } catch (e) { console.error(`Phone access certificate: ${e.message}`); }
    }, 60000);
  }
  if (!on && phoneServers.length) {
    for (const srv of phoneServers) { srv.closeAllConnections?.(); srv.close(); }
    phoneServers = [];
    phoneTls = null;
    clearInterval(phoneTlsTimer);
  }
  if (!!phone.enabled !== on) savePhone({ ...phone, enabled: on, pair: on ? phone.pair : null });
}
if (phone.enabled) setPhoneAccess(true).catch((e) => console.error(`Phone access: ${e.message}`));
// On at the last start: B5 Code's ports come back, and Tailscale's serve is checked (it keeps its own across restarts).
// At login B5 Code can be up before Tailscale has connected: it tries again every 30 s until it is.
function tailnetAtStart() {
  if (!phone.tailscale || tailnet.on) return;
  setTailnet(true).catch((e) => { console.error(`Tailscale: ${e.message}`); setTimeout(tailnetAtStart, 30000); });
}
tailnetAtStart();

// Chat's first version kept its folder in B5 Code's data folder: moved out, while no chat has a
// conversation to resume there (Claude Code finds a conversation by its folder).
{
  const chat = store.state.projects.find((p) => p.kind === "chat");
  if (chat && chat.dir !== CHAT_DIR && chat.dir === path.join(store.dataDir, "chat") && !store.state.threads.some((t) => t.projectId === chat.id && t.sessionId) && !fs.existsSync(CHAT_DIR)) {
    try {
      fs.mkdirSync(path.dirname(CHAT_DIR), { recursive: true });
      if (fs.existsSync(chat.dir)) fs.renameSync(chat.dir, CHAT_DIR); else fs.mkdirSync(CHAT_DIR);
      store.save(updateProject(store.state, chat.id, { dir: CHAT_DIR }));
    } catch (e) { console.error(`Chat's folder didn't move: ${e.message}`); }
  }
}

server.listen(PORT, HOST, () => {
  // Settings › Studio › Start with B5 Code: the editor is ready before Studio is opened.
  if (store.state.settings?.studioAutostart !== false) {
    const dir = studioDir(store.state.projects, HOME);
    if (dir) startStudio(dir, path.join(store.dataDir, "studio.log")).catch(() => {});
  }
  console.log(`B5 Code is running at http://localhost:${PORT}`);
});

// Every child goes with the server: a turn left running would carry on with
// nobody to stop it or answer its questions, and the next server would resume
// the same conversation beside it.
function shutdown() {
  awake.set(false);
  // Detached, they'd outlive the server: killed outright (it exits before a SIGTERM's follow-up could run).
  for (const run of checking.values()) { if (IS_WIN) killGroup(run.proc); else try { process.kill(-run.proc?.pid, "SIGKILL"); } catch { /* gone */ } }
  for (const l of logins.values()) endLogin(l, true);
  for (const { session } of sessions.values()) session.close({ now: true });
  for (const { session } of spares.values()) session.close({ now: true });
  terminals.closeAll();
  for (const srv of [server, ...phoneServers, ...tailnet.servers]) { srv.closeAllConnections?.(); srv.close(); }
  setTimeout(() => process.exit(0), 800);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
