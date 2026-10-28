import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUsageText } from "../server/usage.js";

const SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 79% used · resets Oct 25, 12:49pm (Africa/Accra)
Current week (all models): 96% used · resets Oct 26, 12:59am (Africa/Accra)
Current week (Opus): 40% used · resets Oct 26, 12:59am (Africa/Accra)

What's contributing to your limits usage?`;

test("the session and week lines, as Claude Code prints them", () => {
  const u = parseUsageText(SAMPLE);
  assert.deepEqual(u.windows, [
    { label: "Session", used: 0.79, resets: "Oct 25, 12:49pm" },
    { label: "Week", used: 0.96, resets: "Oct 26, 12:59am" },
    { label: "Week · Opus", used: 0.4, resets: "Oct 26, 12:59am" },
  ]);
  assert.match(u.text, /contributing/);
});

test("anything else is not usage", () => {
  assert.equal(parseUsageText("Unknown command: /usage"), null);
  assert.equal(parseUsageText(""), null);
});
