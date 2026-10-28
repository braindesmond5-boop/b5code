import { test } from "node:test";
import assert from "node:assert/strict";
import { GUIDE, SHORTCUTS, searchGuide } from "../web/guide.js";

test("the guide covers the whole app, B5 Work included", () => {
  const ids = GUIDE.map((s) => s.id);
  for (const id of ["start", "chats", "talking", "watching", "pane", "shipping", "work", "automations", "accounts", "phone", "running"]) assert.ok(ids.includes(id), id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const s of GUIDE) assert.ok(s.title && s.intro && s.tips.length, s.id);
  assert.ok(SHORTCUTS.some(([k]) => k === "⌘/"), "it names its own shortcut");
});

test("search keeps the tips with every word, or a whole section by its title", () => {
  const r = searchGuide("recipe bracket");
  assert.deepEqual(r.map((s) => s.id), ["work"]);
  assert.equal(r[0].tips.length, 1);
  assert.equal(searchGuide("automations").find((s) => s.id === "automations").tips.length, GUIDE.find((s) => s.id === "automations").tips.length, "a title match keeps the section");
  assert.equal(searchGuide("").length, GUIDE.length);
  assert.deepEqual(searchGuide("zzqx"), []);
});
