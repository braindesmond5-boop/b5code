// What differs on Windows: where the home folder and app data are, how paths
// compare (either slash, any case), how `claude` is started, which shell the
// Terminal opens, and how a folder or file is shown. Everything else in
// B5 Code is the same on both. The rules take the platform as an argument,
// so the Windows side is tested on a Mac too.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const IS_WIN = process.platform === "win32";
const P = (win) => (win ? path.win32 : path.posix);

/**
 * A path with its links followed. On Windows, the long name with its true case (fs.realpathSync.native):
 * the plain one keeps short 8.3 names ("SECRET~1.KEY") and trailing dots, which name rules would miss.
 */
export const realPath = (p) => (IS_WIN ? fs.realpathSync.native(p) : fs.realpathSync(p));

/** Your home folder: HOME on a Mac, USERPROFILE on Windows (os.homedir reads the right one). */
export const HOME_DIR = os.homedir();

/** Where B5 Code keeps things outside its own folder (Chat's folder): Application Support, or %APPDATA%. */
export function appDataDir(home, { win = IS_WIN, env = process.env } = {}) {
  return win ? P(win).join(env.APPDATA || P(win).join(home, "AppData", "Roaming"), "B5 Code") : P(win).join(home, "Library", "Application Support", "B5 Code");
}

/** `~`, `~/x` (or `~\x`) as a path in `home`; anything else as it was. */
export const expandHome = (p, home) => String(p ?? "").replace(/^~(?=$|[\\/])/, () => home);

/** Whether `p` is `dir` or inside it: on Windows either slash counts, and case doesn't. */
export function within(p, dir, win = IS_WIN) {
  if (!p || !dir) return false;
  const norm = (s) => { const n = String(s).replace(win ? /[\\/]+/g : /\/+/g, win ? "\\" : "/").replace(/[\\/]$/, ""); return win ? n.toLowerCase() : n; };
  const a = norm(p), b = norm(dir);
  return a === b || a.startsWith(b + (win ? "\\" : "/")) || (b === "" && a.startsWith("/"));
}

/** A path as the page takes it: "/" between the parts (C:/Users/me/x on Windows), and ~ for your home folder when `home` is given. */
export function pagePath(p, home = "", win = IS_WIN) {
  if (p == null) return p;
  const s = win ? String(p).replace(/\\/g, "/") : String(p);
  if (!home) return s;
  const h = win ? String(home).replace(/\\/g, "/") : String(home);
  return within(s, h, win) ? "~" + s.slice(h.length) : s;
}

/** The last part of a path, either slash. */
export const baseName = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || String(p || "");

/**
 * How to start `claude`: [command, leading args]. On a Mac it's on the PATH. On Windows the native
 * installer's claude.exe is found the same way, but npm's claude.cmd can't be started without a
 * shell (whose quoting would mangle B5 Code's JSON arguments), so its JavaScript is run with node.
 */
export function claudeCommand({ win = IS_WIN, env = process.env, exists = fs.existsSync, node = process.execPath } = {}) {
  if (!win) return ["claude", []];
  const p = P(win);
  const dirs = String(env.PATH || env.Path || "").split(";").filter(Boolean);
  const home = env.USERPROFILE || "";
  // Where the native installer and npm put it, should the PATH B5 Code got not have them.
  if (home) dirs.push(p.join(home, ".local", "bin"));
  if (env.APPDATA) dirs.push(p.join(env.APPDATA, "npm"));
  for (const d of dirs) {
    const exe = p.join(d, "claude.exe");
    if (exists(exe)) return [exe, []];
    if (exists(p.join(d, "claude.cmd"))) {
      const cli = p.join(d, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
      if (exists(cli)) return [node, [cli]];
    }
  }
  return ["claude", []]; // not found: the spawn says so ("Could not start Claude Code")
}

let claudeCached = null;
/** claudeCommand(), looked up once (it reads the disk). */
export const claude = () => (claudeCached ||= claudeCommand());

/** The Terminal's shell: yours on a Mac (as a login shell); PowerShell on Windows (7 if it's installed). */
export function terminalShell({ win = IS_WIN, env = process.env, exists = fs.existsSync, userShell = "" } = {}) {
  if (!win) return [env.SHELL || userShell || "/bin/zsh", ["-l"]];
  const pwsh7 = path.win32.join(env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
  return [exists(pwsh7) ? pwsh7 : "powershell.exe", ["-NoLogo"]];
}

/** Whether a program's name is a shell waiting at its prompt (not a dev server running in it). */
export const isShell = (name) => /^-?(zsh|bash|fish|sh|login|pwsh|powershell|cmd|conhost|openconsole)(\.exe)?$/i.test(String(name || ""));

/**
 * The command that shows `target` in the file manager: Finder on a Mac (`reveal`: the file selected
 * in its folder), Explorer on Windows.
 */
export function revealCommand(target, { reveal = false, win = IS_WIN } = {}) {
  if (win) return ["explorer.exe", reveal ? [`/select,${target}`] : [target]];
  return ["open", reveal ? ["-R", target] : [target]];
}

// Code editors, by where each installs itself; the first one there opens a file.
const MAC_EDITORS = ["Visual Studio Code", "Cursor", "Zed", "Sublime Text", "Nova", "BBEdit"];
const WIN_EDITORS = [["Visual Studio Code", "Programs\\Microsoft VS Code\\Code.exe"], ["Cursor", "Programs\\cursor\\Cursor.exe"], ["Zed", "Programs\\Zed\\Zed.exe"], ["Sublime Text", "Sublime Text\\sublime_text.exe"], ["Notepad++", "Notepad++\\notepad++.exe"]];

/** The command that opens `file` in a code editor, and the editor's name ("" for the system's own text editor). */
export function editorCommand(file, { win = IS_WIN, env = process.env, home = HOME_DIR, exists = fs.existsSync } = {}) {
  if (!win) {
    const app = MAC_EDITORS.find((a) => exists(`/Applications/${a}.app`) || exists(path.join(home, "Applications", `${a}.app`)));
    return app ? ["open", ["-a", app, file], app] : ["open", ["-t", file], ""];
  }
  const roots = [env.LOCALAPPDATA, env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean);
  for (const [name, rel] of WIN_EDITORS) {
    for (const r of roots) {
      const exe = path.win32.join(r, rel);
      if (exists(exe)) return [exe, [file], name];
    }
  }
  return ["notepad.exe", [file], "Notepad"];
}

/** The file manager's name, as the page says it. */
export const FILE_MANAGER = IS_WIN ? "File Explorer" : "Finder";

/**
 * A program on the PATH (with .exe on Windows), else in one of `places`, else null. B5 Code started at
 * login or from its icon has a bare PATH, so each program's usual install folders are tried too.
 */
export function findProgram(name, places = [], { env = process.env, win = IS_WIN, exists = fs.existsSync } = {}) {
  const P = win ? path.win32 : path.posix;
  const file = win ? `${name}.exe` : name;
  for (const dir of String(env.PATH || env.Path || "").split(win ? ";" : ":")) if (dir && exists(P.join(dir, file))) return P.join(dir, file);
  return places.find((p) => exists(p)) || null;
}

/** Program Files on Windows, as an install folder is written there. */
export const programFiles = (rel, env = process.env) => path.win32.join(env.ProgramFiles || "C:\\Program Files", rel);
