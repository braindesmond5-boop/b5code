// Checks after each change: B5 Code runs a project's tests, typecheck and
// lint itself when a turn has edited files, so you see what broke without
// spending tokens on Claude running them, and Fix this hands Claude only
// what failed. Pure: finding a project's checks, reading a run's output,
// the Fix this message; tested in test/checks.test.js. server/index.js runs them.

import { testResult } from "../web/receipt.js";
import { SECRET_DIRS } from "./queue.js";

const NPM_DEFAULT_TEST = /no test specified/;

/**
 * The checks a project has, from its package.json, lock files and Python setup:
 * [{ name, command }]. `files` is the set of file names at the project's top.
 */
export function detectChecks(pkg, files = new Set()) {
  const out = [];
  if (pkg) {
    const pm = files.has("pnpm-lock.yaml") ? "pnpm" : files.has("yarn.lock") ? "yarn" : files.has("bun.lockb") || files.has("bun.lock") ? "bun" : "npm";
    const run = (script) => `${pm} run ${script}`;
    const s = pkg.scripts || {};
    // (`bun test` is Bun's own test runner, not the project's script: `bun run test` is.)
    if (s.test && !NPM_DEFAULT_TEST.test(s.test)) out.push({ name: "Tests", command: pm === "npm" ? "npm test" : pm === "bun" ? "bun run test" : `${pm} test` });
    const tc = ["typecheck", "type-check", "check-types", "tsc"].find((k) => s[k]);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (tc) out.push({ name: "Typecheck", command: run(tc) });
    else if (files.has("tsconfig.json") && deps.typescript) out.push({ name: "Typecheck", command: pm === "npm" ? "npx tsc --noEmit" : `${pm} exec tsc --noEmit` });
    if (s.lint) out.push({ name: "Lint", command: run("lint") });
  } else if (files.has("pytest.ini") || files.has("conftest.py") || files.has("pyproject.toml") || files.has("tests")) {
    out.push({ name: "Tests", command: "python3 -m pytest -q" });
  }
  return out;
}

/**
 * "Tests: npm test" lines (from the project's settings) to checks, and back. A name is
 * what comes before ": " (a colon and a space), so `npm run test:unit` is a command.
 */
export function parseChecks(text) {
  return String(text || "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = /^([^:]{1,40}):\s+(.+)$/.exec(l);
    return m ? { name: m[1].trim(), command: m[2].trim() } : { name: l.split(/\s+/).slice(0, 2).join(" "), command: l };
  }).slice(0, 6);
}
export const checksText = (checks) => (checks || []).map((c) => `${c.name}: ${c.command}`).join("\n");

/**
 * A run's pass and fail counts from its summary lines only, anywhere in the output (Node's
 * CI output lists the failures after its summary, and a test's own name can hold "2 failed"):
 * Node's "ℹ pass 4", TAP's "# fail 1", Jest's and Vitest's "Tests: 1 failed, 4 passed",
 * pytest's "=== 1 failed, 4 passed in 0.2s ===", Mocha's "4 passing". The last one wins.
 */
export function summaryCounts(text) {
  let passed = null, failed = null, broken = 0; // broken: test files or suites that failed to run at all
  const num = (line, word) => { const m = new RegExp(`(\\d+)\\s+${word}`, "i").exec(line); return m ? Number(m[1]) : null; };
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    let m;
    if ((m = /^(?:ℹ|#)\s*(pass|fail|cancelled)\s+(\d+)$/i.exec(line))) {
      const k = m[1].toLowerCase();
      if (k === "pass") passed = Number(m[2]); else if (k === "fail") failed = Number(m[2]); else broken = Math.max(broken, Number(m[2]));
      continue;
    }
    // Jest's "Test Suites: 1 failed" and Vitest's "Test Files 1 failed": a file that didn't run, which the "Tests:" line after it leaves out.
    if (/^Test (Suites|Files):?\s/.test(line)) { broken = Math.max(broken, num(line, "failed") || 0); continue; }
    if (/^Tests?:?\s/.test(line) || /^=+ .*\b(passed|failed|errors?)\b.* =+$/.test(line)) {
      const p = num(line, "passed"), f = num(line, "failed"), e = num(line, "errors?");
      if (p != null || f != null || e != null) { passed = p ?? 0; failed = (f ?? 0) + (e ?? 0); }
      continue;
    }
    if ((m = /^(\d+) (passing|failing)\b/.exec(line))) { if (m[2] === "passing") passed = Number(m[1]); else failed = Number(m[1]); }
  }
  if (passed == null && failed == null) return null;
  return { passed: passed ?? 0, failed: Math.max(failed ?? 0, broken) };
}

/** A finished check: whether it passed, a short summary ("152 passed", "3 errors"), and its output's end. */
export function checkResult(check, code, output, ms) {
  const text = String(output || "").replace(/\x1b\[[0-9;]*m/g, ""); // colours off
  const ok = code === 0;
  const t = summaryCounts(text) || testResult(check.command.replace(/^(\w+) run test$/, "$1 test"), text, ok);
  const errors = /(\d+)\s+(errors?|problems?)\b/i.exec(text.split("\n").slice(-15).join("\n"));
  // A run that failed with nothing counted as failing (a crash, a file that didn't load) still says failed.
  const summary = code === null ? "timed out"
    : t?.passed != null ? [t.failed ? `${t.failed} failed` : !ok ? "failed" : "", `${t.passed} passed`].filter(Boolean).join(" · ")
      : errors && !ok ? `${errors[1]} ${errors[2]}` : ok ? "passed" : "failed";
  return { name: check.name, command: check.command, ok, summary, ms, tail: ok ? "" : text.trimEnd().split("\n").slice(-40).join("\n") };
}

// A package manager's flags that take a value (`pnpm --filter web test`): skipped with it.
const VALUE_FLAG = /^(--filter|-F|--prefix|-C|--workspace|-w|--cwd|--dir)$/;
// Scripts that run other scripts by pattern or through another tool: what they run can't be told.
const RUNNERS = /\b(npm-run-all2?|run-s|run-p|concurrently|turbo|nx|lerna|wireit)\b/;

/**
 * The package.json scripts a check's command runs, followed into the scripts they run
 * (`"test": "npm run build && vitest"` runs build too): their names, or null when it
 * can't be told (another package's scripts, a runner by pattern), so all of them count.
 * [] for a command that isn't a package manager's.
 */
export function scriptsRun(command, scripts = {}) {
  const m = /^\s*(npm|pnpm|yarn|bun)\s+(.*)$/.exec(String(command || ""));
  if (!m) return [];
  const words = m[2].split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && words[i].startsWith("-")) { if (VALUE_FLAG.test(words[i])) return null; i++; } // a filter: another package's scripts
  if (words[i] === "run" || words[i] === "run-script") i++;
  const name = words[i] === "t" ? "test" : words[i];
  if (!name || !Object.hasOwn(scripts, name)) return null;
  const seen = new Set();
  const walk = (n) => {
    for (const k of [`pre${n}`, n, `post${n}`]) {
      if (!Object.hasOwn(scripts, k) || seen.has(k)) continue;
      seen.add(k);
      for (const sub of String(scripts[k]).matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+|run-script\s+)?([\w:.-]+)/g)) if (Object.hasOwn(scripts, sub[1])) walk(sub[1]);
    }
  };
  walk(name);
  return [...seen].some((k) => RUNNERS.test(scripts[k])) ? null : [...seen].sort();
}

/**
 * What each check really runs: its command, then every package.json script it runs
 * ("name: body"; all of them when that can't be told). Checks run without Claude's
 * permission questions, so a check runs only while this is what you approved.
 */
export function whatRuns(checks, pkg) {
  const scripts = pkg?.scripts || {};
  return (checks || []).map((c) => {
    const names = scriptsRun(c.command, scripts);
    const list = names === null ? Object.keys(scripts).sort() : names;
    return { name: c.name, command: c.command, runs: [c.command, ...list.map((k) => `${k}: ${scripts[k]}`)].join("\n") };
  });
}

/** An approval's key: exactly what was shown (the command and what it runs). */
export const runKey = (r) => r.runs;

/**
 * Which checks may run (their keys are among `approved`) and which wait for a look,
 * each with what it ran when last approved ({ name, command, was, now, key }).
 */
export function sortRuns(approved, runs) {
  const ok = new Set(Array.isArray(approved) ? approved.filter((k) => typeof k === "string") : []);
  const before = (command) => [...ok].find((k) => k.split("\n")[0] === command) || "";
  return {
    ready: runs.filter((r) => ok.has(runKey(r))),
    waiting: runs.filter((r) => !ok.has(runKey(r))).map((r) => ({ name: r.name, command: r.command, was: before(r.command), now: r.runs, key: runKey(r) })),
  };
}

/**
 * The sandbox a check runs in (macOS sandbox-exec): it may write only in its folder,
 * temporary folders and package caches, and reach only this Mac (localhost), unless the
 * project lets its checks use the internet. Reading is open (tools live all over the disk)
 * except your secrets (.ssh, .aws, keychains…) and B5 Code's own data.
 */
export function sandboxProfile(dir, home, { network = false, dataDir = "" } = {}) {
  const q = (p) => JSON.stringify(p);
  const caches = [".npm", ".cache", "Library/Caches", ".yarn", ".bun", "Library/pnpm", ".local/share/pnpm", ".pnpm-store"].map((c) => `(subpath ${q(`${home}/${c}`)})`);
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (subpath ${q(dir)}) (subpath "/private/tmp") (subpath "/private/var/folders") ${caches.join(" ")} (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))`,
    ...(network ? [] : ["(deny network-outbound)", '(allow network-outbound (remote ip "localhost:*") (remote unix-socket))']),
    `(deny file-read* ${[...SECRET_DIRS.map((d) => `${home}/${d}`), dataDir].filter(Boolean).map((d) => `(subpath ${q(d)})`).join(" ")})`,
  ].join("\n");
}

/** Fix this: what Claude is sent about the checks that failed. */
export function fixMessage(results) {
  const bad = (results || []).filter((r) => !r.ok);
  return [
    `These checks failed after your last change (B5 Code ran them):`,
    ...bad.flatMap((r) => ["", `**${r.name}** (\`${r.command}\`): ${r.summary}`, "```", r.tail || "(no output)", "```"]),
    "",
    "Fix what they found, then run them again to confirm.",
  ].join("\n");
}
