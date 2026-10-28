// On a Windows machine (GitHub Actions): B5 Code started the way the app starts it, and used.
// The server answers as Windows, previews a file in the home folder, lists a project's files,
// opens a PowerShell in the Terminal's pseudo-terminal, stops with `b5 stop`, and the app's
// --background start brings it up again. Fails loudly at the first thing that's wrong.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.homedir(), "b5-smoke-"));
const env = { ...process.env, B5_PORT: "4517", B5_STUDIO_PORT: "4599", B5_DATA: path.join(tmp, "data"), B5_WORK_DIR: path.join(tmp, "work"), B5_CHAT_DIR: path.join(tmp, "chat") };
const URL = "http://127.0.0.1:4517";
const b5 = (...args) => spawnSync(process.execPath, [path.join(ROOT, "bin", "b5.mjs"), ...args], { env, encoding: "utf8", timeout: 120000 });
const step = (s) => console.log(`\n▸ ${s}`);

step("b5 --no-open starts the server");
let r = b5("--no-open");
assert.equal(r.status, 0, r.stderr + r.stdout);
const token = fs.readFileSync(path.join(env.B5_DATA, ".token"), "utf8").trim();
const api = async (method, p, body) => {
  const res = await fetch(URL + p, { method, headers: { "x-desk-token": token, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(data)}`);
  return data;
};

step("it says it's Windows, with a Windows home folder");
const state = await api("GET", "/api/state");
assert.equal(state.platform, "windows");
assert.match(state.home, /^[A-Z]:\\/);
assert.equal(state.settings.extraAccounts, false, "extra accounts are off for a new install");

step("Preview serves a page in the home folder, and its picture beside it, and nothing outside");
const site = path.join(tmp, "site");
fs.mkdirSync(site);
fs.writeFileSync(path.join(site, "plan.html"), "<title>Plan</title><img src=pic.png>");
fs.writeFileSync(path.join(site, "pic.png"), Buffer.from("89504e470d0a1a0a", "hex"));
fs.writeFileSync(path.join(site, ".env"), "SECRET=1");
const { url } = await api("GET", `/api/preview-link?path=${encodeURIComponent(path.join(site, "plan.html"))}`);
assert.match(url, /\/C%3A\/|\/[A-Z]%3A\//, url);
let res = await fetch(url);
assert.equal(res.status, 200);
assert.match(await res.text(), /<title>Plan/);
assert.equal((await fetch(new globalThis.URL("pic.png", url))).status, 200, "its own picture");
assert.equal((await fetch(new globalThis.URL(".env", url))).status, 403, "never a hidden file");
assert.equal((await fetch(url.replace(/\/[^/]+\/[^/]+\/plan\.html$/, "/Windows/win.ini"))).status >= 400, true, "nothing outside its folder");
const tilde = await api("GET", `/api/preview-link?path=${encodeURIComponent("~/" + path.relative(os.homedir(), path.join(site, "plan.html")).replace(/\\/g, "/"))}`);
assert.equal((await fetch(tilde.url)).status, 200, "a ~/ path too");

step("a project: its files listed with / between folders, read, and nothing outside it");
fs.mkdirSync(path.join(site, "src"));
fs.writeFileSync(path.join(site, "src", "a.js"), "export const a = 1;\n");
const project = await api("POST", "/api/projects", { dir: site, name: "Smoke" });
const list = await api("GET", `/api/files?project=${project.id}&dir=src`);
assert.deepEqual(list.entries.map((e) => e.path), ["src/a.js"]);
assert.match((await api("GET", `/api/files/read?project=${project.id}&path=${encodeURIComponent("src\\a.js")}`)).text, /export const a/);
await assert.rejects(api("GET", `/api/files/read?project=${project.id}&path=${encodeURIComponent("..\\..\\x")}`));
await assert.rejects(api("GET", `/api/files/read?project=${project.id}&path=${encodeURIComponent("C:\\Windows\\win.ini")}`));

step("the folder browser starts at home");
const folders = await api("GET", "/api/folders?path=~");
assert.equal(folders.parent, null);

step("the Terminal's pseudo-terminal runs PowerShell");
const { loadPty } = await import("../server/terminal.js");
const pty = loadPty(ROOT);
assert.ok(pty.spawn, pty.error);
const out = await new Promise((resolve, reject) => {
  const p = pty.spawn(tmp, 100, 30);
  let text = "";
  const timer = setTimeout(() => { p.kill(); reject(new Error(`No answer from PowerShell: ${JSON.stringify(text.slice(-500))}`)); }, 30000);
  p.onData((d) => { text += d; if (text.includes("b5-says-hi")) { clearTimeout(timer); p.kill("SIGHUP"); resolve(text); } });
  setTimeout(() => p.write("Write-Output ('b5-says-' + 'hi')\r"), 2000);
});
assert.match(out, /b5-says-hi/);

step("claude is found (or said to be missing) without a shell");
const { claude } = await import("../server/platform.js");
console.log("  claude:", claude());

step("b5 stop stops it");
r = b5("stop");
assert.equal(r.status, 0, r.stderr + r.stdout);
await assert.rejects(fetch(URL + "/", { signal: AbortSignal.timeout(1500) }));

step("the app's --background start brings it up");
const exe = path.join(ROOT, "windows", "bin", "B5Code.exe");
assert.ok(fs.existsSync(exe), "the app was built");
// stdio ignored: the server it starts would otherwise hold this test's pipe open till the timeout.
const bg = spawnSync(exe, ["--background"], { env, timeout: 120000, stdio: "ignore" });
assert.equal(bg.status, 0, "B5Code.exe --background");
assert.equal((await fetch(URL + "/")).status, 200);

step("the app's window opens, stays open, and shows B5 Code (a picture of the screen is kept)");
const shot = path.join(ROOT, "windows-app.png");
const win = spawnSync("powershell.exe", ["-NoProfile", "-Command", [
  `$p = Start-Process -FilePath '${exe}' -PassThru; Start-Sleep -Seconds 15`,
  `if ($p.HasExited) { Write-Output "exited $($p.ExitCode)"; exit 1 }`,
  "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
  "$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height",
  "[System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)",
  `$bmp.Save('${shot}', [System.Drawing.Imaging.ImageFormat]::Png)`,
  "$p.Refresh(); Write-Output \"title: $($p.MainWindowTitle)\"; Stop-Process -Id $p.Id"].join("; ")], { env, encoding: "utf8", timeout: 90000 });
console.log(" ", (win.stdout || "").trim(), (win.stderr || "").trim());
assert.equal(win.status, 0, "the window crashed");

r = b5("stop");
assert.equal(r.status, 0);
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\nB5 Code works on Windows.");
