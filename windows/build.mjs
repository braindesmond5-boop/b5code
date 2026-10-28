// Builds B5 Code's Windows app (windows/B5Code.cs) into windows/bin/B5Code.exe, on the PC
// itself: with the C# compiler .NET Framework puts on every Windows PC, against Microsoft's
// WebView2 package from NuGet, checked against the hash NuGet publishes for it. Built here, it
// carries no "downloaded from the internet" mark, so Windows runs it without a warning.
//
// `node windows/build.mjs` builds it; bin/b5.mjs runs it at setup and after an update that
// changes windows/. The running app is renamed aside (Windows allows that), so a build never
// waits for the window to close: the new one starts next time.
//
// The rules (where things go, whether a build is needed) are pure and tested.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Microsoft.Web.WebView2 from NuGet, and the SHA-512 NuGet's catalog gives for it.
export const WEBVIEW2 = { version: "1.0.4191.47", sha512: "rfkb2hpx2GDAmM0OQmtaI44Yfqc8aUgy+P3jaAmpFl/aiET8nCufyKhwsNpTzZ65fsFA2aLxBKIoMB/66EHbjA==" };
export const packageUrl = (v = WEBVIEW2.version) => `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${v}/microsoft.web.webview2.${v}.nupkg`;

// What the app needs from the package: the two .NET libraries, and the loader for each kind of PC
// (the WebView2 library picks runtimes\win-<arch>\native\ by the app's own architecture).
export const PACKAGE_FILES = ["lib/net462/Microsoft.Web.WebView2.Core.dll", "lib/net462/Microsoft.Web.WebView2.WinForms.dll",
  ...["x64", "arm64", "x86"].map((a) => `runtimes/win-${a}/native/WebView2Loader.dll`)];

const SOURCES = ["B5Code.cs", "B5Code.manifest", "b5code.ico"];

/** Whether `buf` is the package NuGet published. */
export const packageOk = (buf, sha512 = WEBVIEW2.sha512) => crypto.createHash("sha512").update(buf).digest("base64") === sha512;

/** What the app is built from: its sources and the package version. A change means a new build. */
export function sourceStamp(windowsDir, read = (f) => fs.readFileSync(f)) {
  const h = crypto.createHash("sha256").update(WEBVIEW2.version);
  for (const f of SOURCES) h.update(f).update(read(path.join(windowsDir, f)));
  return h.digest("hex").slice(0, 16);
}

/** Whether the app needs building: none yet, or built from other sources. */
export function needsBuild(windowsDir, exists = fs.existsSync, read = (f) => fs.readFileSync(f)) {
  const bin = path.join(windowsDir, "bin");
  if (!exists(path.join(bin, "B5Code.exe"))) return true;
  try { return String(read(path.join(bin, "stamp.txt"))).trim() !== sourceStamp(windowsDir, read); } catch { return true; }
}

/** .NET Framework's C# compiler. */
export function findCsc(env = process.env, exists = fs.existsSync) {
  const win = env.WINDIR || env.windir || "C:\\Windows";
  return ["Framework64", "Framework"].map((f) => path.win32.join(win, "Microsoft.NET", f, "v4.0.30319", "csc.exe")).find(exists) || null;
}

/** csc's arguments for the app. */
export function cscArgs({ windowsDir, out, lib }) {
  const W = (f) => path.win32.join(windowsDir, f);
  return ["/nologo", "/target:winexe", "/platform:anycpu", "/optimize+", "/codepage:65001", `/out:${out}`,
    `/win32icon:${W("b5code.ico")}`, `/win32manifest:${W("B5Code.manifest")}`,
    "/r:System.dll", "/r:System.Drawing.dll", "/r:System.Windows.Forms.dll", "/r:System.Web.Extensions.dll",
    `/r:${path.win32.join(lib, "Microsoft.Web.WebView2.Core.dll")}`, `/r:${path.win32.join(lib, "Microsoft.Web.WebView2.WinForms.dll")}`,
    W("B5Code.cs")];
}

/** The WebView2 package, unpacked once into B5 Code's local app data (checked before it's unpacked). */
async function webview2Package(log) {
  const dir = path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local"), "B5 Code", "webview2", WEBVIEW2.version);
  if (PACKAGE_FILES.every((f) => fs.existsSync(path.join(dir, ...f.split("/"))))) return dir;
  log(`Downloading Microsoft's WebView2 ${WEBVIEW2.version}…`);
  const res = await fetch(packageUrl());
  if (!res.ok) throw new Error(`Couldn't download WebView2 from NuGet (${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!packageOk(buf)) throw new Error("The WebView2 package from NuGet isn't the one expected (its hash differs), so it wasn't used.");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, "package.zip");
  fs.writeFileSync(zip, buf);
  // Windows 10 and 11 have tar, which reads zip files.
  execFileSync("tar", ["-xf", zip, "-C", dir, ...PACKAGE_FILES], { stdio: "ignore", windowsHide: true });
  fs.rmSync(zip, { force: true });
  return dir;
}

/** Copy `from` to `to` unless it's the same file already (one the running app has open can't be replaced, and needn't be). */
function copyIfChanged(from, to) {
  try { if (fs.readFileSync(from).equals(fs.readFileSync(to))) return; } catch { /* not there yet */ }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

export async function buildApp(root, { log = console.log } = {}) {
  if (process.platform !== "win32") throw new Error("The Windows app is built on Windows.");
  const windowsDir = path.join(root, "windows");
  const bin = path.join(windowsDir, "bin");
  const csc = findCsc();
  if (!csc) throw new Error("This PC has no .NET Framework 4 C# compiler (it comes with Windows 10 and 11).");
  const pkg = await webview2Package(log);
  for (const f of PACKAGE_FILES) {
    const name = f.startsWith("lib/") ? path.basename(f) : path.join(...f.split("/").slice(0, 3), "WebView2Loader.dll");
    copyIfChanged(path.join(pkg, ...f.split("/")), path.join(bin, name));
  }
  log("Building the B5 Code app…");
  const fresh = path.join(bin, "B5Code.new.exe");
  try { execFileSync(csc, cscArgs({ windowsDir, out: fresh, lib: bin }), { stdio: "pipe", windowsHide: true }); }
  catch (e) { throw new Error(`The app didn't compile:\n${String(e.stdout || "")}${String(e.stderr || "")}`.trim()); }
  // The running app can't be overwritten, but it can be renamed: it carries on, and the new one starts next time.
  const exe = path.join(bin, "B5Code.exe"), old = path.join(bin, "B5Code.old.exe");
  try { fs.rmSync(old, { force: true }); } catch { /* the one before is still running: kept */ }
  if (fs.existsSync(exe)) { try { fs.renameSync(exe, old); } catch { fs.rmSync(exe, { force: true }); } }
  fs.renameSync(fresh, exe);
  fs.writeFileSync(path.join(bin, "stamp.txt"), sourceStamp(windowsDir));
  log(`Built ${exe}`);
  return exe;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildApp(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")).catch((e) => { console.error(e.message); process.exit(1); });
}
