import { test } from "node:test";
import assert from "node:assert/strict";
import { questionsOf, answersFrom, cleanAnswers, ASK_TOOL } from "../web/questions.js";

const input = { questions: [
  { question: "Which kind of OS should I build?", header: "OS type", multiSelect: false, options: [{ label: "Web OS", description: "In the browser" }, { label: "Real kernel", description: "Boots in QEMU" }] },
  { question: "Which features?", header: "Features", multiSelect: true, options: [{ label: "Terminal" }, { label: "Files" }, { label: "" }] },
] };

test("Claude's question tool is read as questions; anything else isn't", () => {
  const qs = questionsOf(ASK_TOOL, input);
  assert.equal(qs.length, 2);
  assert.deepEqual(qs[1].options.map((o) => o.label), ["Terminal", "Files"], "an option without a label is dropped");
  assert.equal(questionsOf("Bash", input), null);
  assert.equal(questionsOf(ASK_TOOL, { questions: [] }), null);
  assert.equal(questionsOf(ASK_TOOL, null), null);
});

test("answers need every question, keyed by its text; several picks are joined, your own words count", () => {
  const qs = questionsOf(ASK_TOOL, input);
  assert.equal(answersFrom(qs, [{ chosen: ["Web OS"] }, { chosen: [] }]), null, "one unanswered");
  assert.deepEqual(answersFrom(qs, [{ chosen: ["Web OS"] }, { chosen: ["Terminal", "Files"], other: "a clock" }]),
    { "Which kind of OS should I build?": "Web OS", "Which features?": "Terminal, Files, a clock" });
  assert.deepEqual(answersFrom(qs, [{ chosen: [], other: "  a phone OS " }, { chosen: ["Files"] }])["Which kind of OS should I build?"], "a phone OS");
  assert.equal(answersFrom(qs, [{ chosen: ["Not an option"] }, { chosen: ["Files"] }]), null, "only its own options");
});

test("the server keeps answers only when they answer exactly the questions asked", () => {
  const qs = questionsOf(ASK_TOOL, input);
  const good = { "Which kind of OS should I build?": "Web OS", "Which features?": "Files" };
  assert.deepEqual(cleanAnswers(qs, good), good);
  assert.equal(cleanAnswers(qs, { "Which kind of OS should I build?": "Web OS" }), null, "one missing");
  assert.equal(cleanAnswers(qs, { ...good, extra: "x" }), null, "one not asked");
  assert.equal(cleanAnswers(qs, { ...good, "Which features?": "x".repeat(5000) }), null, "too long");
  assert.equal(cleanAnswers(null, good), null, "not a question");
});
