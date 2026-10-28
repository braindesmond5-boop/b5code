import { test } from "node:test";
import assert from "node:assert/strict";
import { chatSnapshot } from "../web/studio-chat.js";
import { apply, emptyFeed, stepsHeadline, currentStep } from "../web/feed.js";
import { renderMarkdown } from "../web/markdown.js";

const tools = { markdown: renderMarkdown, headline: stepsHeadline, current: currentStep };
const fold = (events) => events.reduce((f, e) => apply(f, e), emptyFeed());

test("a turn becomes the tab's items: your message, the steps, the reply as safe HTML", () => {
  const feed = fold([
    { kind: "user", text: "[Studio · video \"hello\"]\nAdd a title" },
    { kind: "tool", id: "1", name: "Read", summary: "Read videos/hello/edit.json" },
    { kind: "tool_result", id: "1", ok: true },
    { kind: "tool", id: "2", name: "Edit", summary: "Edited videos/hello/edit.json" },
    { kind: "text", text: "Added **Welcome** at 0:02. <script>alert(1)</script>" },
    { kind: "done", ok: true },
  ]);
  const s = chatSnapshot(feed, { threadId: "t1", ...tools });
  assert.deepEqual(s.items.map((i) => i.type), ["user", "steps", "ai"]);
  assert.equal(s.items[0].text, "[Studio · video \"hello\"]\nAdd a title");
  assert.equal(s.items[1].headline, "Read videos/hello/edit.json, Edited videos/hello/edit.json");
  assert.match(s.items[2].html, /<strong>Welcome<\/strong>/);
  assert.doesNotMatch(s.items[2].html, /<script/);
  assert.equal(s.working, false);
  assert.equal(s.status, "");
});

test("while Claude works, the tab says what it's doing", () => {
  const feed = fold([{ kind: "user", text: "Cut the silences" }, { kind: "tool", id: "1", name: "Bash", summary: "Ran ffmpeg" }]);
  const s = chatSnapshot(feed, { threadId: "t1", ...tools });
  assert.equal(s.working, true);
  assert.equal(s.status, "Ran ffmpeg");
});

test("a question still open can be answered; one that's gone says so", () => {
  const feed = fold([
    { kind: "user", text: "Render it" },
    { kind: "permission", requestId: "a", tool: "Bash", summary: "Run npm run render -- hello" },
    { kind: "permission", requestId: "b", tool: "Bash", summary: "Delete out/" },
  ]);
  const s = chatSnapshot(feed, { threadId: "t1", waiting: [{ requestId: "a" }], ...tools });
  const asks = s.items.filter((i) => i.type === "ask");
  assert.deepEqual(asks.map((a) => [a.requestId, a.answer]), [["a", null], ["b", "closed"]]);
});

test("skills come along for the / menu; anything else in the feed stays in B5 Code", () => {
  const feed = fold([{ kind: "user", text: "hi" }]);
  feed.items.push({ type: "artifact", path: "/x.html" }, { type: "recap", text: "…" });
  const s = chatSnapshot(feed, { threadId: "t1", commands: [{ name: "make-video", description: "Make a new video" }, { description: "no name" }], ...tools });
  assert.deepEqual(s.items.map((i) => i.type), ["user"]);
  assert.deepEqual(s.skills, [{ name: "make-video", description: "Make a new video" }]);
});
