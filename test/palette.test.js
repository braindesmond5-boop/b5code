import { test } from "node:test";
import assert from "node:assert/strict";
import { matchScore, rankItems } from "../web/palette.js";

test("a few letters find a thing: in order, words' starts count most", () => {
  assert.ok(matchScore("Commit & push", "cmp") > 0);
  assert.equal(matchScore("Commit & push", "pmc"), -1, "out of order");
  assert.ok(matchScore("there was some sql in this repo · MOVIERUSH", "mov sql") > 0, "every word, anywhere");
  assert.equal(matchScore("Settings", "mov"), -1);
  assert.ok(matchScore("Guide", "gui") > matchScore("Go to GitHub (UI)", "gui"), "a word's start beats letters spread out");
  assert.equal(matchScore("Anything", ""), 0);
});

test("ranking: best first, keywords help, the usual ones first with no query", () => {
  const items = [
    { id: "chat", label: "Hello · b5code" },
    { id: "settings", label: "Settings", keywords: "preferences options", top: true, weight: 5 },
    { id: "commit", label: "Commit & push", keywords: "git", weight: 10 },
    { id: "guide", label: "Guide", keywords: "help how to", top: true },
  ];
  assert.deepEqual(rankItems(items, "").map((i) => i.id), ["settings", "guide", "chat", "commit"]);
  assert.deepEqual(rankItems(items, "help").map((i) => i.id), ["guide"], "found by a keyword");
  assert.equal(rankItems(items, "cmp")[0].id, "commit");
  assert.deepEqual(rankItems(items, "zzz"), []);
  assert.equal(rankItems(items, "e", 2).length, 2, "a limit");
});

test("keywords count as words, not as letters spread through a sentence", () => {
  const items = [
    { id: "commit", label: "Commit & push", keywords: "Claude commits them and pushes the branch." },
    { id: "settings", label: "Settings", keywords: "preferences options accounts phone" },
    { id: "opus", label: "Use Opus 5.5", keywords: "model" },
  ];
  assert.deepEqual(rankItems(items, "opus").map((i) => i.id), ["opus"]);
  assert.deepEqual(rankItems(items, "branch").map((i) => i.id), ["commit"], "a word from its description");
});
