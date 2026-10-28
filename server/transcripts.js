// Conversations started with `claude` in a terminal, so they can carry on in
// B5 Code. Claude Code keeps each one as a JSON-lines file under
// ~/.claude/projects/<the folder, every other character a dash>/<id>.jsonl.
// Those files can be hundreds of megabytes (they keep request copies too), so
// a listing reads only each file's start and end, and an import streams it.
//
// The line rules (which lines are your messages, what the title is, how a
// transcript becomes B5 Code's events) are pure and tested.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { normalize } from "./events.js";

/** Claude Code's folder name for a working folder: /Users/me/App → -Users-me-App. */
export const folderKey = (dir) => String(dir).replace(/[^a-zA-Z0-9]/g, "-");

/** The transcript folders for a project (the Mac's disk ignores case, and so do the names Claude Code made). */
export function transcriptDirs(claudeDir, dir) {
  const root = path.join(claudeDir, "projects");
  const want = folderKey(dir).toLowerCase();
  try {
    return fs.readdirSync(root).filter((n) => n.toLowerCase() === want).map((n) => path.join(root, n));
  } catch { return []; }
}

// <command-name>, <local-command-stdout>, <bash-input>…: the terminal's own commands and their output, not your words.
const TERMINAL_TAG = /^<(command-(name|message|args)|local-command-[a-z-]+|bash-(input|stdout|stderr)|user-prompt-submit-hook|task-notification|system-reminder)>/;

/** Your own words in a transcript line, or null for anything else (tool results, commands, notes Claude Code adds). */
export function userText(line) {
  if (!line || line.type !== "user" || line.isMeta || line.isSidechain || line.isCompactSummary) return null;
  const c = line.message?.content;
  const text = typeof c === "string" ? c
    : Array.isArray(c) && !c.some((b) => b.type === "tool_result") ? c.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";
  const t = String(text || "").trim();
  if (!t || TERMINAL_TAG.test(t)) return null;
  return t;
}

/** A listing row from a transcript's first and last lines. */
export function sessionInfo(headLines, tailLines) {
  let title = "", first = "", cwd = "";
  for (const l of tailLines) if (l.type === "ai-title" && l.aiTitle) title = l.aiTitle;
  for (const l of tailLines) if (!title && l.type === "summary" && l.summary) title = l.summary;
  for (const l of headLines) {
    if (!cwd && l.cwd) cwd = l.cwd;
    if (!first) first = userText(l) || "";
  }
  if (!first) for (const l of tailLines) if (l.type === "last-prompt" && l.lastPrompt) first = l.lastPrompt;
  return { title: String(title || first || "").replace(/\s+/g, " ").trim().slice(0, 120), first: first.replace(/\s+/g, " ").slice(0, 200), cwd };
}

/** The lines of a byte range that parse (the cut lines at either end don't). */
function parseLines(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    if (!raw || raw.includes('"type":"api-request')) continue;
    try { out.push(JSON.parse(raw)); } catch { /* cut at the edge of the range */ }
  }
  return out;
}

async function readRange(file, start, length) {
  const fh = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally { await fh.close(); }
}

const HEAD = 256 * 1024, TAIL = 512 * 1024;
const LOOK_AT = 120; // files read for one listing at most, so a folder of thousands stays quick

/**
 * A project's terminal conversations, newest first, without the ones B5 Code
 * already has. Read without blocking: other threads keep streaming meanwhile.
 */
export async function listSessions(claudeDir, dir, knownIds = new Set(), limit = 40) {
  const files = [];
  for (const d of transcriptDirs(claudeDir, dir)) {
    for (const n of fs.readdirSync(d)) {
      const id = n.replace(/\.jsonl$/, "");
      if (id === n || knownIds.has(id) || !/^[0-9a-f-]{36}$/.test(id)) continue;
      try { const st = fs.statSync(path.join(d, n)); files.push({ id, file: path.join(d, n), size: st.size, at: st.mtimeMs }); } catch { /* gone */ }
    }
  }
  files.sort((a, b) => b.at - a.at);
  const out = [];
  for (let i = 0; i < Math.min(files.length, LOOK_AT) && out.length < limit; i += 8) {
    const batch = await Promise.all(files.slice(i, Math.min(i + 8, LOOK_AT)).map(async (f) => {
      try {
        const head = parseLines(await readRange(f.file, 0, HEAD));
        const tail = f.size > HEAD ? parseLines(await readRange(f.file, Math.max(0, f.size - TAIL), TAIL)) : head;
        return { f, info: sessionInfo(head, tail) };
      } catch { return null; } // removed meanwhile
    }));
    for (const r of batch) {
      // Nothing you said: a session that never started.
      if (r?.info.first && out.length < limit) out.push({ id: r.f.id, title: r.info.title, first: r.info.first, at: r.f.at, size: r.f.size });
    }
  }
  return out;
}

/** The file for one session id, found in the project's transcript folders. */
export function sessionFile(claudeDir, dir, id) {
  if (!/^[0-9a-f-]{36}$/.test(String(id))) return null;
  for (const d of transcriptDirs(claudeDir, dir)) {
    const f = path.join(d, `${id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

export const IMPORT_MAX = 3000; // events kept from a long conversation: its latest part

/**
 * A transcript as B5 Code's events, so the thread shows the conversation so
 * far. Feed it lines in order; `events()` gives the result. Each of your
 * messages starts a turn and the next one ends it; subagents' own lines are
 * left out, as they are live.
 */
export function transcriptToEvents() {
  let out = [];
  let open = false;
  let cut = false;
  const push = (ev) => {
    out.push(ev);
    if (out.length > IMPORT_MAX * 1.5) { out = out.slice(out.length - IMPORT_MAX); cut = true; }
  };
  return {
    add(line) {
      if (!line || (line.type !== "user" && line.type !== "assistant") || line.isSidechain) return;
      const at = Date.parse(line.timestamp) || undefined;
      const text = userText(line);
      if (text !== null) {
        if (open) push({ kind: "done", ok: true, durationMs: 0, at });
        push({ kind: "user", text, files: [], at });
        open = true;
        return;
      }
      if (line.isMeta || line.isCompactSummary) return;
      for (const ev of normalize({ type: line.type, message: line.message })) push({ ...ev, at });
    },
    events() {
      let list = out;
      if (open) list = [...list, { kind: "done", ok: true, durationMs: 0, at: list[list.length - 1]?.at }];
      if (list.length > IMPORT_MAX) { list = list.slice(list.length - IMPORT_MAX); cut = true; }
      // Start at one of your messages, so the first turn shown is whole.
      if (cut) {
        const i = list.findIndex((e) => e.kind === "user");
        list = [{ kind: "note", text: "Earlier messages of this conversation are in Claude Code, but not shown here." }, ...(i > 0 ? list.slice(i) : list)];
      }
      return list;
    },
  };
}

/** Read a whole transcript (streamed: they can be very large) into B5 Code's events. */
export async function importSession(file) {
  const conv = transcriptToEvents();
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let title = "";
  for await (const raw of rl) {
    if (!raw || raw.includes('"type":"api-request') || raw.includes('"type":"file-history') || raw.includes('"type":"attachment"')) continue;
    let line;
    try { line = JSON.parse(raw); } catch { continue; }
    if (line.type === "ai-title" && line.aiTitle) title = line.aiTitle;
    conv.add(line);
  }
  return { events: conv.events(), title };
}
