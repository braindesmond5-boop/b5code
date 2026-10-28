// More than one Claude account: when one hits its usage limit, threads carry
// on with another.
//
// Claude Code keeps an account's sign-in by its config folder: with
// CLAUDE_CONFIG_DIR set, the Keychain item is "Claude Code-credentials-<hash
// of the folder>" (on Windows, <folder>/.credentials.json) and the account
// record is <folder>/.claude.json. So each
// extra account gets a folder of its own (~/.claude-b5-<id>), and the main
// account is ~/.claude, as Claude Code has it with nothing set.
//
// Everything that isn't the sign-in is shared, by links into ~/.claude (on
// Windows, folders are linked as junctions, which need no administrator):
// conversations (projects/, which also holds each project's memory), skills,
// plugins, settings, task lists. A conversation is then found by either
// account, so a thread can move to another account and resume where it was.
// ~/.claude.json holds the account's own record, so it can't be linked; its
// MCP servers are copied over instead (syncUserConfig).
//
// The rules (which account to use, which links an account folder needs) are
// pure and tested; the folder work takes the fs module as an argument.

import path from "node:path";
import crypto from "node:crypto";
import { IS_WIN, within } from "./platform.js";

export const MAIN = "main";

// Folders shared with ~/.claude: made there if missing, so both accounts write to one place.
export const SHARED_DIRS = ["projects", "file-history", "tasks", "todos", "plans", "skills", "plugins", "agents", "commands", "output-styles"];
// Files shared when ~/.claude has them.
export const SHARED_FILES = ["settings.json", "CLAUDE.md", "keybindings.json"];

export const newAccountId = () => crypto.randomBytes(4).toString("hex");

/** The folder for an extra account. */
export const accountDir = (home, id) => path.join(home, `.claude-b5-${id}`);

const SESSION_VARS = ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN"];

/** The environment for a `claude` of this account: the main account sets nothing. */
export function accountEnv(env, account) {
  const out = { ...env };
  delete out.CLAUDE_CONFIG_DIR;
  // B5 Code started from inside a Claude Code session inherits its variables (CLAUDECODE,
  // CLAUDE_CODE_SESSION_ID, its messaging socket…): every claude it runs would take itself for
  // that session's child. They never pass on.
  // (Your own Claude Code settings, CLAUDE_CODE_USE_BEDROCK and the like, are kept.)
  for (const k of SESSION_VARS) delete out[k];
  // Claude Code's task tools (TaskCreate, TaskUpdate…) aren't on by default: they're what B5 Code's
  // to-do list shows. Your own setting (0, say) wins.
  if (out.CLAUDE_CODE_ENABLE_TODO_TOOLS === undefined) out.CLAUDE_CODE_ENABLE_TODO_TOOLS = "1";
  if (account && account.id !== MAIN && account.dir) out.CLAUDE_CONFIG_DIR = account.dir;
  return out;
}

/** Every account, the main one first, as the server knows them: the main one alone while extra accounts are off (Settings). */
export function allAccounts(state) {
  const main = { id: MAIN, name: "Main", dir: null };
  return state.settings?.extraAccounts ? [main, ...(state.accounts || [])] : [main];
}

/** Whether an account's limit is still on at `now`. */
export const isLimited = (limits, id, now = Date.now()) => (limits?.[id] || 0) > now;

/**
 * The account to work on: the first in order that's signed in and not at its
 * limit, else null. `signedIn(id)` says which are signed in.
 */
export function pickAccount(accounts, limits, signedIn, now = Date.now(), except = null) {
  return accounts.find((a) => a.id !== except && signedIn(a.id) && !isLimited(limits, a.id, now)) || null;
}

/** When the first limited account frees up (for a thread every account is refusing); 0 if none is known. Past times don't count. */
export function firstReset(accounts, limits, signedIn, now = Date.now()) {
  const times = accounts.filter((a) => signedIn(a.id) && (limits?.[a.id] || 0) > now).map((a) => limits[a.id]);
  return times.length ? Math.min(...times) : 0;
}

/**
 * ~/.claude.json isn't shared (it holds the account's own record), but MCP
 * servers you added with `claude mcp add --scope user`, and each project's
 * own, live there. They're copied into an extra account's .claude.json, so
 * a thread that moves account keeps its tools. Only those keys change.
 */
export function mergeUserConfig(main, own) {
  const out = { ...own };
  if (main.mcpServers) out.mcpServers = main.mcpServers;
  const projects = { ...(own.projects || {}) };
  for (const [dir, p] of Object.entries(main.projects || {})) {
    const keep = {};
    for (const k of ["mcpServers", "enabledMcpjsonServers", "disabledMcpjsonServers", "enableAllProjectMcpServers"]) if (p && p[k] !== undefined) keep[k] = p[k];
    if (Object.keys(keep).length) projects[dir] = { ...(projects[dir] || {}), ...keep };
  }
  if (Object.keys(projects).length) out.projects = projects;
  return out;
}

/** Copy the shared parts of ~/.claude.json into an account's own (written only if it changes). */
export function syncUserConfig(fsx, mainFile, ownFile) {
  let main, own = {};
  try { main = JSON.parse(fsx.readFileSync(mainFile, "utf8")); } catch { return false; }
  try { own = JSON.parse(fsx.readFileSync(ownFile, "utf8")); } catch { /* first time */ }
  const next = mergeUserConfig(main, own);
  if (JSON.stringify(next) === JSON.stringify(own)) return false;
  const tmp = `${ownFile}.b5-${process.pid}`;
  fsx.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fsx.renameSync(tmp, ownFile);
  return true;
}

/**
 * Make an account folder's links to ~/.claude (and the shared folders there
 * if they're missing). Safe to run on every start: a link already right is
 * left alone, and a real file or folder in the way is kept, never replaced,
 * and reported, so nothing an account wrote is lost.
 */
export function ensureLinks(fsx, mainDir, dir, win = IS_WIN) {
  fsx.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const notLinked = [];
  const want = [...SHARED_DIRS.map((n) => [n, true]), ...SHARED_FILES.map((n) => [n, false])];
  for (const [name, isDir] of want) {
    const target = path.join(mainDir, name);
    const at = path.join(dir, name);
    if (isDir) fsx.mkdirSync(target, { recursive: true });
    else if (!fsx.existsSync(target)) continue;
    let st = null;
    try { st = fsx.lstatSync(at); } catch { /* not there yet */ }
    if (st?.isSymbolicLink()) {
      const to = fsx.readlinkSync(at); // a junction's may end in a backslash
      if (to === target || (win && within(to, target, win) && within(target, to, win))) continue;
      fsx.unlinkSync(at); // a link to somewhere else: point it home
    } else if (st) { notLinked.push(name); continue; }
    // A file link on Windows needs Developer Mode (or an administrator): without it, the file stays unshared.
    try { fsx.symlinkSync(target, at, win ? (isDir ? "junction" : "file") : undefined); }
    catch (e) { if (!win) throw e; notLinked.push(name); }
  }
  return notLinked;
}

/**
 * Remove an account folder: its links go (never what they point to), then
 * what's left is its own (.claude.json, caches).
 */
export function removeAccountDir(fsx, home, dir) {
  // Only ever one of ours.
  if (path.dirname(dir) !== home || !/^\.claude-b5-[0-9a-f]{8}$/.test(path.basename(dir))) throw new Error("Not an account folder.");
  let names = [];
  try { names = fsx.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const at = path.join(dir, n);
    if (fsx.lstatSync(at).isSymbolicLink()) fsx.unlinkSync(at);
  }
  fsx.rmSync(dir, { recursive: true, force: true });
}

/** The sign-in link `claude auth login` prints, from its output so far. */
export function loginUrl(text) {
  const m = /https:\/\/\S+oauth\/authorize\?\S+/.exec(String(text || ""));
  return m ? m[0] : "";
}
