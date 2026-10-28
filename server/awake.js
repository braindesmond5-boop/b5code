// Keeps the Mac from going to sleep while Claude works, as the Claude app's
// "Keep computer awake" does: one `caffeinate -i` while any thread is busy.
// -w ties it to this server, so it can never outlive B5 Code. Closing a
// laptop's lid still sleeps it; this only stops idle sleep.
//
// Windows has no caffeinate: a hidden PowerShell tells Windows the system is
// in use (SetThreadExecutionState) every 30 seconds, and stops by itself
// when B5 Code's server is gone.

import { spawn as nodeSpawn } from "node:child_process";
import { IS_WIN } from "./platform.js";
import { powershellArgs } from "./login.js";

/** The PowerShell that keeps Windows awake while process `pid` runs. */
export const windowsAwakeScript = (pid) => [
  `Add-Type -Namespace B5 -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'`,
  `while (Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue) { [B5.Power]::SetThreadExecutionState(1) | Out-Null; Start-Sleep -Seconds 30 }`,
].join("\n");

/** The command that keeps the computer awake while `pid` runs. */
export const awakeCommand = (pid, win = IS_WIN) => (win ? ["powershell.exe", powershellArgs(windowsAwakeScript(pid))] : ["caffeinate", ["-i", "-w", String(pid)]]);

export class Awake {
  constructor({ spawn = nodeSpawn, pid = process.pid, win = IS_WIN } = {}) {
    this.spawn = spawn;
    this.pid = pid;
    this.win = win;
    this.proc = null;
  }

  get on() {
    return !!this.proc;
  }

  /** Awake while `want` is true; asleep-able again when it's false. */
  set(want) {
    if (want && !this.proc) {
      try {
        const [cmd, args] = awakeCommand(this.pid, this.win);
        const p = this.spawn(cmd, args, { stdio: "ignore", windowsHide: true });
        p.on("error", () => { if (this.proc === p) this.proc = null; });
        p.on("exit", () => { if (this.proc === p) this.proc = null; });
        this.proc = p;
      } catch { this.proc = null; }
    }
    if (!want && this.proc) {
      const p = this.proc;
      this.proc = null;
      p.kill();
    }
  }
}
