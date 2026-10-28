// What a turn's commands came to, read from the commands and their output:
// a test run's counts, a commit, a push. Feeds the receipt at the end of a
// turn (turnRecap in feed.js). Pure, tested in test/receipt.test.js.

const TEST_COMMAND = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnode\s+--test\b|\b(?:jest|vitest|pytest|mocha|rspec|phpunit|ava)\b|\bgo\s+test\b|\bcargo\s+test\b|\bplaywright\s+test\b|\bpython3?\s+-m\s+(?:pytest|unittest)\b/;

const count = (line, words) => {
  // "40 passed", "40 passing", or node's "ℹ pass 40".
  const m = new RegExp(`(\\d+)\\s+(?:${words})\\b|\\b(?:${words})\\s+(\\d+)\\b`, "i").exec(line);
  return m ? Number(m[1] ?? m[2]) : null;
};

/**
 * A test run's result: { passed, failed, ok }, or null for a command that
 * isn't one. The summary is read from the end of the output, where test tools
 * print it; without one, only whether the command passed is known.
 */
export function testResult(command, output = "", ok = true, lookBack = 20) {
  if (!TEST_COMMAND.test(String(command || ""))) return null;
  // The summary is in the last lines; further up, a test's own name could hold "3 failed".
  // (A whole run's output, as B5 Code's own checks have it, can have the failures listed after it.)
  const lines = String(output || "").trimEnd().split("\n").reverse().slice(0, lookBack);
  let passed = null, failed = null;
  for (const line of lines) {
    if (passed === null) passed = count(line, "passed|passing|pass");
    if (failed === null) failed = count(line, "failed|failing|fail");
    if (passed !== null && failed !== null) break;
  }
  if (passed === null && failed === null) return { passed: null, failed: null, ok: !!ok };
  failed ||= 0;
  return { passed: passed ?? 0, failed, ok: !!ok && failed === 0 };
}

/** A commit a command made: { sha, subject, branch }, from git's "[main d8f9e0b] Subject". */
export function commitFrom(command, output = "") {
  if (!/\bgit\b[^|;&]*\bcommit\b/.test(String(command || ""))) return null;
  const m = /^\[([^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.*)$/m.exec(String(output || ""));
  return m ? { branch: m[1], sha: m[2], subject: m[3] } : null;
}

/** Whether a command pushed: a git push that didn't fail. */
export function pushed(command, ok) {
  return !!ok && /\bgit\b[^|;&]*\bpush\b/.test(String(command || ""));
}

/**
 * The commands a turn ran, and what came of them. `steps` are the turn's tool
 * steps as feed.js keeps them (a Bash step's command is in its detail).
 */
export function commandReceipt(steps) {
  const commands = [], commits = [];
  let tests = null, push = false;
  for (const s of steps) {
    if (s.name !== "Bash") continue;
    const ok = s.state !== "bad";
    const t = testResult(s.detail, s.result, ok);
    if (t) tests = t; // the latest run counts: an earlier one was before the fix
    const c = commitFrom(s.detail, s.result);
    if (c && ok) commits.push(c);
    if (pushed(s.detail, ok)) push = true;
    commands.push({ summary: s.summary, command: s.detail || "", ok, ...(t ? { test: true } : {}), ...(ok ? {} : { output: tail(s.result) }) });
  }
  return { commands, commits, tests, pushed: push };
}

/** The last few lines of a failed command: where its error usually is. */
function tail(text, lines = 8) {
  return String(text || "").trimEnd().split("\n").slice(-lines).join("\n");
}

/** "43 passed", "2 failed · 41 passed", or "passed" when the tool printed no counts. */
export function testsLabel(t) {
  if (!t) return "";
  if (t.passed === null) return t.ok ? "Tests passed" : "Tests failed";
  return [t.failed ? `${t.failed} failed` : "", `${t.passed} passed`].filter(Boolean).join(" · ");
}

/** How the run compares with the one before it in this thread: "+2" new passing, or "" when there's nothing to say. */
export function testsChange(t, before) {
  if (!t || !before || t.passed === null || before.passed === null) return "";
  const d = t.passed - before.passed;
  return d > 0 ? `+${d}` : d < 0 ? `${d}` : "";
}
