import { test } from "node:test";
import assert from "node:assert/strict";
import { appDataDir, expandHome, within, pagePath, baseName, claudeCommand, terminalShell, isShell, revealCommand, editorCommand, findProgram } from "../server/platform.js";
import { previewPath, previewScope, isPrivate, inScope } from "../server/preview.js";
import { shortcutScript, powershellArgs, startupLink } from "../server/login.js";
import { awakeCommand } from "../server/awake.js";
import { worktreeDir } from "../web/branch-name.js";
import { cscArgs, needsBuild, sourceStamp, packageOk, findCsc, PACKAGE_FILES } from "../windows/build.mjs";

const WHOME = "C:\\Users\\Ama";

test("Windows paths: inside a folder by either slash and any case, never by a longer name", () => {
  assert.equal(within("C:\\Users\\Ama\\Desktop\\x.html", WHOME, true), true);
  assert.equal(within("c:/users/ama/desktop", WHOME, true), true);
  assert.equal(within("C:\\Users\\Amanda\\x", WHOME, true), false);
  assert.equal(within("D:\\Users\\Ama", WHOME, true), false);
  assert.equal(within("/Users/ama/x", "/Users/ama", false), true);
  assert.equal(within("/Users/AMA/x", "/Users/ama", false), false, "a Mac's paths compare as written");
  assert.equal(expandHome("~\\Desktop", WHOME), "C:\\Users\\Ama\\Desktop");
  assert.equal(expandHome("~/Desktop", "/Users/ama"), "/Users/ama/Desktop");
  assert.equal(expandHome("~bob", "/Users/ama"), "~bob");
  assert.equal(pagePath("C:\\Users\\Ama\\Desktop\\Plan", WHOME, true), "~/Desktop/Plan");
  assert.equal(baseName("C:\\Users\\Ama\\plan.html"), "plan.html");
  assert.equal(appDataDir(WHOME, { win: true, env: { APPDATA: "C:\\Users\\Ama\\AppData\\Roaming" } }), "C:\\Users\\Ama\\AppData\\Roaming\\B5 Code");
  assert.equal(appDataDir("/Users/ama", { win: false }), "/Users/ama/Library/Application Support/B5 Code");
});

test("Preview on Windows: drive paths in the home folder only; shares and other drives never", () => {
  assert.equal(previewPath("C%3A/Users/Ama/Desktop/plan.html", WHOME, true), "C:\\Users\\Ama\\Desktop\\plan.html");
  assert.equal(previewPath("~/Desktop/shots/home%20light.png", WHOME, true), "C:\\Users\\Ama\\Desktop\\shots\\home light.png");
  assert.equal(previewPath("C:/Users/Ama/../Bob/x", WHOME, true), null);
  assert.equal(previewPath("C:/Windows/win.ini", WHOME, true), null);
  assert.equal(previewPath("%5C%5Cevil%5Cshare%5Cx.html", WHOME, true), null, "a share on another computer");
  assert.equal(previewPath("Users/Ama/x", WHOME, true), null, "no drive: not a path here");
  assert.equal(previewScope("C:\\Users\\Ama\\plan.html", WHOME, true), "C:\\Users\\Ama\\plan.html", "a page right in the home folder gets only itself");
  assert.equal(previewScope("C:\\Users\\Ama\\Desktop\\p\\plan.html", WHOME, true), "C:\\Users\\Ama\\Desktop\\p");
  assert.equal(isPrivate("sub\\.ssh\\id_rsa"), true);
  assert.equal(inScope("c:\\users\\ama\\desktop\\p\\img.png", "C:\\Users\\Ama\\Desktop\\p", true), true);
});

test("claude on Windows: the native claude.exe, or npm's package run with node (never the .cmd)", () => {
  const env = { PATH: "C:\\Tools;C:\\Users\\Ama\\AppData\\Roaming\\npm", USERPROFILE: WHOME, APPDATA: "C:\\Users\\Ama\\AppData\\Roaming" };
  const npm = new Set(["C:\\Users\\Ama\\AppData\\Roaming\\npm\\claude.cmd", "C:\\Users\\Ama\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js"]);
  assert.deepEqual(claudeCommand({ win: true, env, exists: (p) => npm.has(p), node: "C:\\node\\node.exe" }),
    ["C:\\node\\node.exe", ["C:\\Users\\Ama\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js"]]);
  const native = "C:\\Users\\Ama\\.local\\bin\\claude.exe";
  assert.deepEqual(claudeCommand({ win: true, env, exists: (p) => p === native }), [native, []], "found where its installer puts it, off the PATH");
  assert.deepEqual(claudeCommand({ win: false }), ["claude", []]);
});

test("Windows programs: PowerShell in the Terminal, Explorer, an editor or Notepad, gh where its installer puts it", () => {
  assert.deepEqual(terminalShell({ win: true, env: {}, exists: () => false }), ["powershell.exe", ["-NoLogo"]]);
  assert.deepEqual(terminalShell({ win: false, env: { SHELL: "/bin/bash" } }), ["/bin/bash", ["-l"]]);
  assert.ok(isShell("pwsh.exe") && isShell("-zsh") && !isShell("node.exe"));
  assert.deepEqual(revealCommand("C:\\p\\a.txt", { reveal: true, win: true }), ["explorer.exe", ["/select,C:\\p\\a.txt"]]);
  assert.deepEqual(revealCommand("/p", { win: false }), ["open", ["/p"]]);
  const code = "C:\\Users\\Ama\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe";
  assert.deepEqual(editorCommand("C:\\p\\a.js", { win: true, env: { LOCALAPPDATA: "C:\\Users\\Ama\\AppData\\Local" }, exists: (p) => p === code }), [code, ["C:\\p\\a.js"], "Visual Studio Code"]);
  assert.deepEqual(editorCommand("C:\\p\\a.js", { win: true, env: {}, exists: () => false }), ["notepad.exe", ["C:\\p\\a.js"], "Notepad"]);
  assert.equal(findProgram("gh", ["C:\\Program Files\\GitHub CLI\\gh.exe"], { win: true, env: { PATH: "C:\\x" }, exists: (p) => p === "C:\\Program Files\\GitHub CLI\\gh.exe" }), "C:\\Program Files\\GitHub CLI\\gh.exe");
  assert.equal(findProgram("gh", [], { win: true, env: { PATH: "C:\\x;C:\\bin" }, exists: (p) => p === "C:\\bin\\gh.exe" }), "C:\\bin\\gh.exe");
});

test("a worktree sits next to its repo on Windows too", () => {
  assert.equal(worktreeDir("C:\\Users\\Ama\\Flaevo", "feat/12-x"), "C:\\Users\\Ama\\flaevo-feat-12-x");
  assert.equal(worktreeDir("/Users/ama/Flaevo/", "fix/x"), "/Users/ama/flaevo-fix-x");
});

test("the Startup shortcut runs the app in the background; PowerShell gets it encoded", () => {
  const script = shortcutScript({ link: "C:\\S\\B5 Code.lnk", root: "C:\\Users\\O'Neil\\b5", args: ["--background"] });
  assert.match(script, /CreateShortcut\('C:\\S\\B5 Code\.lnk'\)/);
  assert.match(script, /TargetPath = 'C:\\Users\\O''Neil\\b5\\windows\\bin\\B5Code\.exe'/, "a quote in a name is doubled");
  assert.match(script, /Arguments = '--background'/);
  const args = powershellArgs(script);
  assert.equal(Buffer.from(args.at(-1), "base64").toString("utf16le"), script);
  assert.equal(startupLink({ APPDATA: "C:\\A" }), "C:\\A\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\B5 Code.lnk");
});

test("keeping Windows awake: a hidden PowerShell that ends with the server", () => {
  const [cmd, args] = awakeCommand(42, true);
  assert.equal(cmd, "powershell.exe");
  const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
  assert.match(script, /SetThreadExecutionState\(1\)/);
  assert.match(script, /Get-Process -Id 42/);
  assert.deepEqual(awakeCommand(42, false), ["caffeinate", ["-i", "-w", "42"]]);
});

test("the Windows app is built from its sources with the WebView2 package, and again only when they change", () => {
  const files = { "B5Code.cs": "class A {}", "B5Code.manifest": "<x/>", "b5code.ico": "ico" };
  const read = (f) => { const n = f.split(/[\\/]/).pop(); if (n === "stamp.txt") return stamp; if (!(n in files)) throw new Error("none"); return Buffer.from(files[n]); };
  const stamp = sourceStamp("/w", read);
  assert.equal(needsBuild("/w", () => true, read), false);
  files["B5Code.cs"] = "class B {}";
  assert.equal(needsBuild("/w", () => true, read), true, "the source changed");
  assert.equal(needsBuild("/w", () => false, read), true, "never built");
  const args = cscArgs({ windowsDir: "C:\\b5\\windows", out: "C:\\b5\\windows\\bin\\B5Code.new.exe", lib: "C:\\b5\\windows\\bin" });
  assert.ok(args.includes("/target:winexe") && args.includes("/codepage:65001") && args.includes("/r:C:\\b5\\windows\\bin\\Microsoft.Web.WebView2.WinForms.dll"));
  assert.equal(args.at(-1), "C:\\b5\\windows\\B5Code.cs");
  assert.equal(packageOk(Buffer.from("not the package")), false);
  assert.equal(findCsc({ WINDIR: "C:\\Windows" }, (p) => p.includes("Framework64")), "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe");
  assert.ok(PACKAGE_FILES.includes("runtimes/win-arm64/native/WebView2Loader.dll"));
});
