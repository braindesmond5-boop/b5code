import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { folderKey, userText, sessionInfo, transcriptToEvents, listSessions, sessionFile, importSession, IMPORT_MAX } from "../server/transcripts.js";
import { emptyFeed, apply } from "../web/feed.js";

const u = (content, extra = {}) => ({ type: "user", message: { role: "user", content }, timestamp: "2026-10-20T10:00:00Z", ...extra });
const a = (content) => ({ type: "assistant", message: { role: "assistant", content }, timestamp: "2026-10-20T10:00:05Z" });

test("Claude Code's folder name: every character but letters and digits is a dash", () => {
  assert.equal(folderKey("/Users/mac/Desktop/my.app"), "-Users-mac-Desktop-my-app");
});

test("only your own words count as your messages", () => {
  assert.equal(userText(u("Fix the login")), "Fix the login");
  assert.equal(userText(u([{ type: "text", text: "Look" }, { type: "image" }])), "Look");
  assert.equal(userText(u("<command-name>/clear</command-name>")), null, "a terminal command");
  assert.equal(userText(u("<div class=x> why isn't this centred?")), "<div class=x> why isn't this centred?", "pasted HTML is still yours");
  assert.equal(userText(u("note", { isMeta: true })), null);
  assert.equal(userText(u([{ type: "tool_result", tool_use_id: "x", content: "ok" }])), null);
  assert.equal(userText(u("sub", { isSidechain: true })), null, "a subagent's");
});

test("a listing's title: Claude Code's own, else your first message", () => {
  assert.equal(sessionInfo([u("First thing")], [{ type: "ai-title", aiTitle: "Login fix" }]).title, "Login fix");
  assert.equal(sessionInfo([u("<command-name>/x</command-name>"), u("First thing")], []).title, "First thing");
});

test("a transcript becomes turns: your message, Claude's steps and reply, done", () => {
  const conv = transcriptToEvents();
  for (const l of [
    u("Fix it"),
    a([{ type: "thinking", thinking: "" }]),
    a([{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/p/a.js" } }]),
    u([{ type: "tool_result", tool_use_id: "t1", content: "code" }]),
    a([{ type: "text", text: "Fixed." }]),
    u("Thanks"),
    a([{ type: "text", text: "Any time." }]),
  ]) conv.add(l);
  const evs = conv.events();
  assert.deepEqual(evs.map((e) => e.kind), ["user", "tool", "tool_result", "text", "done", "user", "text", "done"]);
  const f = evs.reduce((feed, e) => apply(feed, e), emptyFeed());
  assert.equal(f.working, false);
  assert.deepEqual(f.items.map((i) => i.type), ["user", "steps", "ai", "user", "ai"]);
});

test("a very long conversation keeps its latest part, starting at one of your messages", () => {
  const conv = transcriptToEvents();
  for (let i = 0; i < IMPORT_MAX; i++) { conv.add(u(`q${i}`)); conv.add(a([{ type: "text", text: `a${i}` }])); }
  const evs = conv.events();
  assert.ok(evs.length <= IMPORT_MAX + 1);
  assert.equal(evs[0].kind, "note");
  assert.equal(evs[1].kind, "user");
  assert.equal(evs.at(-2).text, `a${IMPORT_MAX - 1}`);
});

test("listing and importing from a project's transcript folder (names matched ignoring case)", async () => {
  const claude = fs.mkdtempSync(path.join(os.tmpdir(), "b5-claude-"));
  const dir = path.join(claude, "projects", folderKey("/Users/x/Desktop/flaevo"));
  fs.mkdirSync(dir, { recursive: true });
  const id1 = "11111111-1111-4111-8111-111111111111", id2 = "22222222-2222-4222-8222-222222222222", id3 = "33333333-3333-4333-8333-333333333333";
  const write = (id, lines) => fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  write(id1, [{ type: "api-request-blob", message: { role: "user", content: "big" } }, u("Make the goals screen"), a([{ type: "text", text: "Done." }]), { type: "ai-title", aiTitle: "Goals screen" }]);
  write(id2, [u("Already in B5 Code")]);
  write(id3, [{ type: "mode", mode: "normal" }]); // never started
  const list = await listSessions(claude, "/Users/x/Desktop/Flaevo", new Set([id2]));
  assert.deepEqual(list.map((s) => [s.id, s.title]), [[id1, "Goals screen"]]);
  assert.equal(sessionFile(claude, "/Users/x/Desktop/Flaevo", "../../etc"), null);
  const { events, title } = await importSession(sessionFile(claude, "/Users/x/Desktop/Flaevo", id1));
  assert.equal(title, "Goals screen");
  assert.deepEqual(events.map((e) => e.kind), ["user", "text", "done"]);
});
