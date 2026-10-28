#!/usr/bin/env node
// B5 Code's command on Windows, as bin/b5 is on the Mac (bin/b5.cmd runs it as `b5`):
//
//   b5             start the server if it isn't running, and open the B5 Code app
//   b5 --no-open   only start the server (the app runs this)
//   b5 stop        stop the server; b5 restart stops and starts it
//   b5 update      bring in the latest B5 Code from GitHub, and start it again
//   b5 setup       what the installer runs: npm install, build the app, the shortcuts
//
// The server is started detached with no window: on Windows that also gives it a hidden console,
// which every program it runs (claude, git) shares, so none of them opens a window of its own.

import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = process.env.B5_DATA || path.join(ROOT, "data");
const PORT = Number(process.env.B5_PORT || 4317);
const URL = `http://127.0.0.1:${PORT}`;
const LOG = path.join(DATA, "b5.log");
const WIN = process.platform === "win32";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function running() {
  try { await fetch(`${URL}/`, { method: "HEAD", signal: AbortSignal.timeout(1000) }); return true; } catch { return false; }
}

// One starter at a time: the app and a terminal `b5` can start together, and an update holds it
// throughout (npm, a build: minutes), so the app can't start the old server in the middle of one.
// The lock names its holder: one whose holder is gone (killed, or a PC that lost power) is cleared,
// and so is one held past half an hour, but never one a live update still holds.
const LOCK = path.join(DATA, ".starting");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
function lockHolder() {
  try { return { pid: Number(fs.readFileSync(path.join(LOCK, "pid"), "utf8")), at: fs.statSync(LOCK).mtimeMs }; } catch { return null; }
}
function takeLock() {
  fs.mkdirSync(DATA, { recursive: true });
  if (fs.existsSync(LOCK)) {
    const h = lockHolder();
    // A lock just made may not have its pid yet: only one older than a few seconds without one is stale.
    const stale = h ? !alive(h.pid) || Date.now() - h.at > 30 * 60000 : Date.now() - (fs.statSync(LOCK, { throwIfNoEntry: false })?.mtimeMs || 0) > 10000;
    if (stale) fs.rmSync(LOCK, { recursive: true, force: true });
  }
  try { fs.mkdirSync(LOCK); } catch { return false; }
  fs.writeFileSync(path.join(LOCK, "pid"), String(process.pid));
  return true;
}
/** Only ever our own lock. */
const dropLock = () => { if (lockHolder()?.pid === process.pid) fs.rmSync(LOCK, { recursive: true, force: true }); };

async function start({ locked = false } = {}) {
  if (await running()) return true;
  const mine = locked || takeLock();
  try {
    if (mine && !(await running())) {
      const log = fs.openSync(LOG, "a");
      spawn(process.execPath, [path.join(ROOT, "server", "index.js")], { cwd: ROOT, detached: true, windowsHide: true, stdio: ["ignore", log, log] }).unref();
      fs.closeSync(log);
    }
    // Another starter's server, or an update (npm install, a build) that takes a while.
    for (let i = 0; i < (mine ? 80 : 600); i++) { if (await running()) return true; if (!mine && !fs.existsSync(LOCK) && i > 8) break; await sleep(250); }
    return running();
  } finally {
    if (mine && !locked) dropLock();
  }
}

async function stop() {
  if (!(await running())) return;
  let token = "";
  try { token = fs.readFileSync(path.join(DATA, ".token"), "utf8").trim(); } catch { /* no token: can't ask */ }
  try { await fetch(`${URL}/api/quit`, { method: "POST", headers: { "x-desk-token": token }, signal: AbortSignal.timeout(3000) }); } catch { /* it went while answering */ }
  // Gone once its port is free (it also holds the preview port, which a new server needs).
  for (let i = 0; i < 40; i++) { if (!(await running())) { await sleep(300); return; } await sleep(250); }
  throw new Error("B5 Code didn't stop. Close it in Task Manager (node.exe), then try again.");
}

function openApp() {
  const exe = path.join(ROOT, "windows", "bin", "B5Code.exe");
  if (WIN && fs.existsSync(exe)) spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
  else if (WIN) spawn("cmd.exe", ["/d", "/c", "start", "", `http://localhost:${PORT}/`], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  else spawn("open", [`http://localhost:${PORT}/`], { detached: true, stdio: "ignore" }).unref();
}

const git = (...args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
const npm = (...args) => execFileSync(WIN ? "npm.cmd" : "npm", args, { cwd: ROOT, stdio: "inherit", windowsHide: true, shell: WIN });

/** Build the app if it isn't built from today's sources. */
async function buildIfNeeded(force = false) {
  if (!WIN) return;
  const { needsBuild, buildApp } = await import("../windows/build.mjs");
  if (force || needsBuild(path.join(ROOT, "windows"))) await buildApp(ROOT);
}

/** The newest B5 Code from GitHub's main, fast-forward only: never over changes made here. */
async function update({ quiet = false } = {}) {
  const say = quiet ? () => {} : console.log;
  git("fetch", "--quiet", "origin", "main");
  const head = git("rev-parse", "HEAD"), next = git("rev-parse", "origin/main");
  if (head === next) { say("B5 Code is up to date."); return false; }
  if (git("status", "--porcelain", "--untracked-files=no")) throw new Error(`B5 Code's folder has changes of its own (${ROOT}), so it wasn't updated.`);
  const changed = git("diff", "--name-only", head, next).split("\n");
  const wasRunning = await running();
  if (!takeLock()) throw new Error("B5 Code is starting or updating already. Try again in a minute.");
  say("Updating B5 Code…");
  try {
    await stop();
    git("merge", "--ff-only", "--quiet", "origin/main");
    // npm ci: exactly the lockfile, which it never rewrites (npm install would, and the folder would
    // then have changes of its own, which stops every update after).
    if (changed.some((f) => /^package(-lock)?\.json$/.test(f))) npm("ci", "--no-audit", "--no-fund");
    await buildIfNeeded();
  } finally {
    if (wasRunning) await start({ locked: true });
    dropLock();
  }
  say("B5 Code is up to date.");
  return true;
}

/** What the installer runs once B5 Code's folder is there. */
async function setup() {
  if (!WIN) throw new Error("`b5 setup` sets up B5 Code on Windows. On a Mac, build the app with mac/build.sh.");
  if (!fs.existsSync(path.join(ROOT, "node_modules", "node-pty"))) npm("ci", "--no-audit", "--no-fund");
  await buildIfNeeded(true);
  const { menuLink, desktopLink, shortcutScript, powershellArgs } = await import("../server/login.js");
  for (const link of [menuLink(), desktopLink()]) {
    execFileSync("powershell.exe", powershellArgs(shortcutScript({ link, root: ROOT })), { stdio: "ignore", windowsHide: true });
  }
  // Updates come from GitHub from now on (server/index.js reads this).
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, "install.json"), JSON.stringify({ updates: "github", at: new Date().toISOString() }, null, 2));
  console.log("B5 Code is in the Start menu and on the Desktop.");
}

const cmd = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "";
const noOpen = process.argv.includes("--no-open");
try {
  if (cmd === "stop") { await stop(); console.log("B5 Code stopped."); }
  else if (cmd === "update") await update({ quiet: process.argv.includes("--quiet") });
  else if (cmd === "setup") await setup();
  else if (cmd === "restart" || cmd === "") {
    if (cmd === "restart") await stop();
    if (!(await start())) { console.error(`B5 Code could not start. See ${LOG}`); process.exit(1); }
    if (!noOpen) openApp();
  } else { console.error(`Unknown command: b5 ${cmd}. Try b5, b5 stop, b5 restart, b5 update or b5 setup.`); process.exit(2); }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
