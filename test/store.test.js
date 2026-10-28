import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, emptyState, addProject, addThread, addSide, updateThread, removeThread, removeProject, titleFrom, addRecipe, removeRecipe, SERVER_DEFAULTS } from "../server/store.js";

test("a folder can be a project only once", () => {
  const { state } = addProject(emptyState(), { dir: "/Users/x/Desktop/Flaevo" });
  assert.equal(state.projects[0].name, "Flaevo");
  assert.throws(() => addProject(state, { dir: "/Users/x/Desktop/Flaevo/" }), /already/);
});

test("projects get different colours", () => {
  let s = emptyState();
  s = addProject(s, { dir: "/a" }).state;
  s = addProject(s, { dir: "/b" }).state;
  assert.notEqual(s.projects[0].color, s.projects[1].color);
});

test("threads belong to a real project, newest first", () => {
  const { state: s1, project } = addProject(emptyState(), { dir: "/a" });
  assert.throws(() => addThread(s1, "nope"), /No such project/);
  const { state: s2 } = addThread(s1, project.id, 1);
  const { state: s3, thread } = addThread(s2, project.id, 2);
  assert.equal(s3.threads[0].id, thread.id);
  const s4 = updateThread(s3, thread.id, { title: "T" }, 5);
  assert.equal(s4.threads[0].title, "T");
  assert.equal(s4.threads[0].updatedAt, 5);
  assert.equal(removeThread(s4, thread.id).threads.length, 1);
});

test("a title is the first line, cut at a word", () => {
  assert.equal(titleFrom("\n  Fix the login bug \nmore"), "Fix the login bug");
  const t = titleFrom("Write the goal tables migration and test it on staging first before anything else happens");
  assert.ok(t.length <= 61);
  assert.ok(t.endsWith("…"));
  assert.ok(!t.includes("  "));
});

test("state and logs survive a restart, and a torn line is skipped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-"));
  const a = new Store(dir);
  const { state, project } = addProject(a.state, { dir: "/a" });
  const { state: s2, thread } = addThread(state, project.id);
  a.save(s2);
  a.appendLog(thread.id, { kind: "user", text: "hi" });
  fs.appendFileSync(path.join(dir, "threads", `${thread.id}.jsonl`), '{"kind":"te');
  const b = new Store(dir);
  assert.equal(b.state.threads[0].id, thread.id);
  assert.deepEqual(b.readLog(thread.id).map((e) => e.text), ["hi"]);
  assert.throws(() => b.readLog("../../etc"), /Bad thread id/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a project can turn its connectors off, and be removed with its threads", async () => {
  const { updateProject, removeProject, projectArgs } = await import("../server/store.js");
  const { state: s1, project } = addProject(emptyState(), { dir: "/a" });
  assert.deepEqual(projectArgs(project), []);
  const s2 = updateProject(s1, project.id, { connectors: "off" });
  assert.deepEqual(projectArgs(s2.projects[0]), ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']);
  const { state: s3 } = addThread(s2, project.id);
  const s4 = removeProject(s3, project.id);
  assert.equal(s4.projects.length, 0);
  assert.equal(s4.threads.length, 0);
});

test("the model list survives a restart, and an unreadable state file is kept aside", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const { Store } = await import("../server/store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b5-store-"));
  try {
    const a = new Store(dir);
    a.save({ ...a.state, models: [{ value: "opus", name: "Opus" }] });
    assert.deepEqual(new Store(dir).state.models, [{ value: "opus", name: "Opus" }]);
    fs.writeFileSync(path.join(dir, "state.json"), "{ torn");
    const b = new Store(dir);
    assert.deepEqual(b.state.projects, []);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("state.json.unreadable-")), "the bad file is kept");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a side chat forks its parent's conversation in its folder, and goes with it", () => {
  let s = addProject(emptyState(), { dir: "/a" }).state;
  const { state, thread } = addThread(s, s.projects[0].id);
  s = updateThread(state, thread.id, { sessionId: "sess-1", dir: "/a-feat", root: "/a-feat", branch: "feat/x" });
  const { state: s2, thread: side } = addSide(s, thread.id);
  assert.equal(side.sideOf, thread.id);
  assert.equal(side.forkFrom, "sess-1");
  assert.equal(side.dir, "/a-feat");
  assert.equal(side.branch, undefined, "the branch's PR stays with the thread");
  assert.throws(() => addSide(s2, side.id), /side chats of its own/);
  assert.equal(removeThread(s2, thread.id).threads.length, 0);
});

test("the threads a restart cut short are still known to the server that starts after it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b5-carry-"));
  const a = new Store(dir);
  a.save({ ...a.state, carryOn: ["abc123def456"] });
  assert.deepEqual(new Store(dir).state.carryOn, ["abc123def456"]);
  assert.deepEqual(new Store(fs.mkdtempSync(path.join(os.tmpdir(), "b5-carry-"))).state.carryOn ?? [], []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a Work space keeps recipes: tasks to run again, gone with their space", () => {
  const { state: s1, project } = addProject(emptyState(), { dir: "/Users/x/Documents/B5 Work", name: "Work", kind: "work" });
  assert.equal(project.kind, "work");
  assert.equal(addProject(emptyState(), { dir: "/Users/x/code" }).project.kind, undefined, "a code project has no kind");
  const { state: s2, recipe } = addRecipe(s1, { projectId: project.id, name: "", prompt: "Turn these lecture slides into revision notes." }, 5);
  assert.equal(recipe.name, titleFrom("Turn these lecture slides into revision notes."), "named after what it asks, when not named");
  assert.equal(s2.recipes.length, 1);
  assert.throws(() => addRecipe(s1, { projectId: project.id, prompt: "  " }), /needs what to ask/);
  assert.throws(() => addRecipe(s1, { projectId: "nope", prompt: "x" }), /No such project/);
  assert.equal(removeRecipe(s2, recipe.id).recipes.length, 0);
  assert.equal(removeProject(s2, project.id).recipes.length, 0, "removing the space removes its recipes");
});

test("a project can be a Work space or Chat; any other kind is ignored", () => {
  let st = emptyState();
  ({ state: st } = addProject(st, { dir: "/tmp/b5-chat", kind: "chat" }));
  ({ state: st } = addProject(st, { dir: "/tmp/b5-work", kind: "work" }));
  ({ state: st } = addProject(st, { dir: "/tmp/b5-odd", kind: "admin" }));
  assert.deepEqual(st.projects.map((p) => p.kind || null), ["chat", "work", null]);
  assert.equal(SERVER_DEFAULTS.chatWeb, true, "web search is on in chats until switched off");
});

test("extra accounts are off for a new install, and stay on for one that already has accounts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-"));
  assert.equal(new Store(dir).state.settings.extraAccounts, false);
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ projects: [], threads: [], settings: { keepAwake: true }, accounts: [{ id: "aaaa1111", name: "Work" }] }));
  assert.equal(new Store(dir).state.settings.extraAccounts, true);
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ projects: [], threads: [], settings: { extraAccounts: false }, accounts: [{ id: "aaaa1111", name: "Work" }] }));
  assert.equal(new Store(dir).state.settings.extraAccounts, false, "turned off on purpose stays off");
  fs.rmSync(dir, { recursive: true, force: true });
});
