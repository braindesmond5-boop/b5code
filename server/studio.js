// Studio: B5 Studio's video editor (its own project, ~/Desktop/B5 Studio), shown in
// B5 Code's main area. B5 Studio runs its own small server on 127.0.0.1:4320; this
// finds the project, says whether that server is up, and starts it when it isn't.
// Which folder is B5 Studio is pure and tested; the checks and the start are thin.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

// The one place the port is chosen: B5 Studio's server is started with the same B5_STUDIO_PORT.
export const STUDIO_PORT = Number(process.env.B5_STUDIO_PORT || 4320);
export const STUDIO_URL = `http://127.0.0.1:${STUDIO_PORT}`;

/** B5 Studio's folder: a B5 Code project that is one (it has editor/server.mjs), else ~/Desktop/B5 Studio. */
export function studioDir(projects, home, exists = fs.existsSync) {
  const isStudio = (dir) => exists(path.join(dir, "editor", "server.mjs"));
  const named = projects.filter((p) => p.kind !== "work" && /b5[ -]?studio/i.test(path.basename(p.dir || "")));
  const found = named.find((p) => isStudio(p.dir));
  if (found) return found.dir;
  const fallback = path.join(home, "Desktop", "B5 Studio");
  return isStudio(fallback) ? fallback : null;
}

/** Whether B5 Studio's editor answers, within `ms`. Its /api/ping does no work, so a slow
 *  disk or a broken video file can't make a running editor look stopped. */
export async function studioRunning(ms = 1500) {
  try {
    const r = await fetch(`${STUDIO_URL}/api/ping`, { signal: AbortSignal.timeout(ms) });
    return r.ok && (await r.json()).app === "b5-studio";
  } catch { return false; }
}

/** Starts the editor in `dir`, detached so it outlives a B5 Code restart, and waits up to `ms` for it to answer. */
export async function startStudio(dir, logFile, ms = 20000) {
  if (await studioRunning()) return true;
  const log = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [path.join("editor", "server.mjs")], { cwd: dir, detached: true, windowsHide: true, stdio: ["ignore", log, log], env: { ...process.env, B5_STUDIO_PORT: String(STUDIO_PORT) } });
  child.unref();
  fs.closeSync(log);
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await studioRunning(500)) return true;
    if (child.exitCode !== null) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** Asks B5 Studio's editor something: its answer, { error } when it refuses, `fallback` when it isn't running or answers badly. */
export async function studioAsk(method, apiPath, fallback, ms = 3000) {
  try {
    const r = await fetch(STUDIO_URL + apiPath, { method, headers: method === "GET" ? {} : { "x-b5-studio": "1" }, signal: AbortSignal.timeout(ms) });
    const data = await r.json().catch(() => null);
    if (r.ok) return data ?? fallback;
    return data?.error ? { error: data.error } : fallback; // a refusal says why (an export running, say)
  } catch { return fallback; }
}
