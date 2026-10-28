// Starting B5 Code when you log in to the Mac, so a restart doesn't leave the
// phone with "Can't reach your Mac" until someone opens it. A LaunchAgent
// (~/Library/LaunchAgents/com.b5code.start.plist) runs `bin/b5 --no-open` at
// login: the same start the Dock icon does (the server only if it isn't
// running; no Safari). AbandonProcessGroup keeps the server running after b5
// itself exits, which launchd would otherwise stop with it.
//
// The plist is pure and tested; installing takes fs and execFile.

import path from "node:path";

export const LABEL = "com.b5code.start";

export const plistPath = (home) => path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The LaunchAgent: run b5 --no-open once at login, its output in data/login.log. */
export function loginPlist({ root, home, log }) {
  const arg = (s) => `    <string>${esc(s)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[arg("/bin/bash"), arg(path.join(root, "bin", "b5")), arg("--no-open")].join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${esc(home)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${esc(log)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(log)}</string>
</dict>
</plist>
`;
}

/** Install or remove the LaunchAgent. `run(cmd, args)` resolves when the command is done (its failures don't matter here). */
export async function setLoginItem(on, { fs, run, root, home, log, uid }) {
  const file = plistPath(home);
  if (on) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, loginPlist({ root, home, log }), { mode: 0o644 });
    // Loaded now, so it's known to launchd without waiting for the next login; its run starts
    // nothing new while B5 Code is already up.
    await run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]);
    await run("launchctl", ["bootstrap", `gui/${uid}`, file]);
  } else {
    await run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]);
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }
  return fs.existsSync(file);
}

// ── Windows ──────────────────────────────────────────────────────────────────
// No launchd: a shortcut in your Startup folder runs the B5 Code app with --background at
// login, which starts the server and opens no window. The same app, without it, is B5 Code
// in the Start menu and on the Desktop (`b5 setup`). Shortcuts are made by Windows itself
// (WScript.Shell, from PowerShell); the script is pure and tested.

const programs = (env) => path.win32.join(env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs");
/** The Startup folder's shortcut. */
export const startupLink = (env = process.env) => path.win32.join(programs(env), "Startup", "B5 Code.lnk");
/** The Start menu's and the Desktop's. */
export const menuLink = (env = process.env) => path.win32.join(programs(env), "B5 Code.lnk");
export const desktopLink = (env = process.env) => path.win32.join(env.USERPROFILE || "", "Desktop", "B5 Code.lnk");
/** The app (windows/build.mjs puts it there). */
export const appExe = (root) => path.win32.join(root, "windows", "bin", "B5Code.exe");

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** The PowerShell that makes a shortcut to B5 Code's app, with `args`. */
export function shortcutScript({ link, root, args = [] }) {
  return [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(link)})`,
    `$s.TargetPath = ${psQuote(appExe(root))}`,
    `$s.Arguments = ${psQuote(args.join(" "))}`,
    `$s.WorkingDirectory = ${psQuote(root)}`,
    `$s.IconLocation = ${psQuote(path.win32.join(root, "windows", "b5code.ico"))}`,
    `$s.Description = 'B5 Code'`,
    "$s.Save()",
  ].join("; ");
}

/** powershell.exe's arguments for a script: encoded, so no quoting of the command line can change it. */
export const powershellArgs = (script) => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];

/** Make or remove the Startup shortcut. `run(cmd, args)` resolves when the command is done. */
export async function setLoginItemWindows(on, { fs, run, root, env = process.env }) {
  const link = startupLink(env);
  if (on) await run("powershell.exe", powershellArgs(shortcutScript({ link, root, args: ["--background"] })));
  else try { fs.unlinkSync(link); } catch { /* already gone */ }
  return fs.existsSync(link);
}
