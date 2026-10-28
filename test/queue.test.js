import { test } from "node:test";
import assert from "node:assert/strict";
import { queueAllows, commandPieces, overnightBrief, queueBranch, nextTask, afterTurn, CHECK_TRIES } from "../server/queue.js";

const dir = "/Users/me/Desktop/flaevo-queue-3-fix";
const bash = (command) => queueAllows("Bash", { command }, dir);

test("at night: tests, builds and git in the worktree run; nothing that reaches out", () => {
  for (const ok of ["npm test", "npm run build && npm test 2>&1 | tail -40", "git status", "git add -A && git commit -m \"Open the modal; install nothing\"",
    "npx tsc --noEmit", "node --test test/*.test.js", "cat src/goals.js | head -50", `cd ${dir}/web && npm run lint`, "grep -rn \"TODO\" src", "pytest -q",
    "ls src 2>/dev/null", "cat README.md 2>/dev/null || echo none", "echo hi > hello.txt && git add hello.txt", `echo x > ${dir}/notes.md`,
    "printf 'hi\\n' > hello.txt && git add hello.txt && git commit -q -m \"add hello\"", "git status --short && (test -f package.json && cat package.json || echo none)", "python3 script.py", "node -e 'console.log(1)'"]) {
    assert.equal(bash(ok).ok, true, ok);
  }
  for (const no of ["npm install left-pad", "npm i", "curl https://evil.example/x", "rm -rf build", "git push origin HEAD", "git reset --hard HEAD~1", "git checkout main",
    "sudo ls", "cat ~/.ssh/id_rsa", "cat /etc/passwd", "head ../other/.env", "cat $(echo ~/.ssh/id_rsa)", "$(echo cu)rl x", "echo `curl x`", "npm test > /tmp/out",
    "open https://x.com", "find . -delete", "git -c core.pager=x log", "env", "cd /Users/me/Desktop/other && ls", "",
    "cat $HOME/.npmrc", "cd && cat .git-credentials", "cd ~", "rm -f build.log", "echo x > ../outside.txt", "echo x >> ~/.zshrc"]) {
    assert.equal(bash(no).ok, false, no);
  }
});

test("edits and reads stay inside the worktree, and away from git's files and secrets", { skip: process.platform === "win32" && "the overnight queue is the Mac's" }, () => {
  assert.equal(queueAllows("Edit", { file_path: `${dir}/src/a.js` }, dir).ok, true);
  assert.equal(queueAllows("Write", { file_path: "src/new.js" }, dir).ok, true, "relative to the worktree");
  assert.equal(queueAllows("Edit", { file_path: "/Users/me/Desktop/Flaevo/src/a.js" }, dir).ok, false, "the main checkout");
  assert.equal(queueAllows("Write", { file_path: `${dir}/.env.local` }, dir).ok, false);
  assert.equal(queueAllows("Edit", { file_path: `${dir}/.git/config` }, dir).ok, false);
  assert.equal(queueAllows("Read", { file_path: `${dir}/README.md` }, dir).ok, true);
  assert.equal(queueAllows("Read", { file_path: "/Users/me/.ssh/id_ed25519" }, dir).ok, false);
  assert.equal(queueAllows("Grep", { pattern: "x" }, dir).ok, true, "no path: the worktree");
  assert.equal(queueAllows("WebFetch", { url: "https://x.com/?k=secret" }, dir).ok, false, "no web at night");
  assert.equal(queueAllows("mcp__claude_ai_Gmail__create_draft", {}, dir).ok, false);
  assert.equal(queueAllows("TodoWrite", { todos: [] }, dir).ok, true);
});

test("a command line splits at && || ; | but not inside quotes", () => {
  assert.deepEqual(commandPieces(`npm test && git commit -m "a; b | c" || echo x`), ["npm test", `git commit -m "a; b | c"`, "echo x"]);
});

test("the brief keeps the owner's words and the overnight rules", () => {
  const b = overnightBrief({ brief: "Fix the login bug", checks: "npm test", branch: "queue/3-fix-the-login-bug", dir });
  assert.match(b, /Fix the login bug/);
  assert.match(b, /Don't push, open a PR, merge or deploy/);
  assert.match(b, /run `npm test` and make it pass/);
  assert.equal(queueBranch(3, "Fix the login bug on Android, please!"), "queue/3-fix-the-login-bug-on");
  assert.equal(queueBranch(4, "!!!"), "queue/4-task");
});

test("one task at a time across every project, in order, once the start time has come", () => {
  const q = { on: true, tasks: [{ id: "a", status: "done" }, { id: "b", status: "queued" }, { id: "c", status: "queued" }] };
  assert.equal(nextTask(q).id, "b");
  assert.equal(nextTask({ ...q, tasks: [{ id: "x", status: "running" }, ...q.tasks] }), null, "one is running");
  assert.equal(nextTask({ ...q, on: false }), null);
  assert.equal(nextTask({ ...q, startAt: 5000 }, 1000), null, "not yet");
  assert.equal(nextTask({ ...q, startAt: 5000 }, 6000).id, "b");
  assert.equal(nextTask({ on: true, tasks: [{ id: "p", status: "paused" }, { id: "d", status: "queued" }] }).id, "d", "a paused task doesn't hold the queue");
});

test("after a turn: checks pass → done; fail → try again, then failing; a limit → carries on", () => {
  const t = { checks: "npm test", checkTries: 0 };
  assert.deepEqual(afterTurn(t, { ok: true }, { ok: true }), { status: "done" });
  const again = afterTurn(t, { ok: true }, { ok: false, output: "1 failing" });
  assert.equal(again.status, "running");
  assert.match(again.followUp, /npm test.*failed.*1 failing/s);
  assert.equal(afterTurn({ ...t, checkTries: CHECK_TRIES - 1 }, { ok: true }, { ok: false }).status, "failing");
  assert.equal(afterTurn(t, { ok: false, limit: true }, null).status, "running");
  assert.equal(afterTurn(t, { ok: false, error: "Stopped" }, null).status, "stuck");
  assert.deepEqual(afterTurn({}, { ok: true }, null), { status: "done" }, "no checks");
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { queueSandboxSettings, checksSandboxProfile } from "../server/queue.js";

test("a symlink committed in the worktree can't carry an edit or a read outside it", () => {
  const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "b5-wt-")));
  fs.symlinkSync(os.homedir(), path.join(w, "home"));
  assert.equal(queueAllows("Write", { file_path: path.join(w, "home", ".zshrc") }, w).ok, false);
  assert.equal(queueAllows("Read", { file_path: path.join(w, "home", "notes.txt") }, w).ok, false);
  assert.equal(queueAllows("Write", { file_path: path.join(w, "src", "new", "file.js") }, w).ok, true, "a file in a folder not made yet");
});

test("queued tasks run boxed in: Claude Code's sandbox with no way out, and the checks under sandbox-exec", { skip: process.platform === "win32" && "the overnight queue is the Mac's" }, () => {
  const s = queueSandboxSettings({ home: "/Users/me", dataDir: "/Users/me/b5/data", projectDir: "/Users/me/app" }).sandbox;
  assert.deepEqual([s.enabled, s.failIfUnavailable, s.allowUnsandboxedCommands, s.autoAllowBashIfSandboxed], [true, true, false, false]);
  assert.deepEqual(s.network.allowedDomains, []);
  assert.ok(s.filesystem.denyRead.includes("/Users/me/.ssh") && s.filesystem.denyRead.includes("/Users/me/b5/data") && s.filesystem.denyRead.includes("/Users/me/app/.env"));
  // The profile works for real: no network, no writes outside, no secrets; the worktree and node are fine.
  const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "b5-sbx-")));
  const outside = path.join(os.homedir(), `.b5-sandbox-test-${process.pid}`);
  const profile = checksSandboxProfile({ worktree: w, home: os.homedir(), dataDir: path.join(w, "data-not-here") });
  const run = (cmd) => { try { execFileSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/zsh", "-c", cmd], { cwd: w, stdio: "pipe" }); return true; } catch { return false; } };
  assert.equal(run("curl -s -m 5 -o /dev/null http://1.1.1.1"), false, "network");
  assert.equal(run(`touch ${outside}`), false, "write outside");
  assert.equal(fs.existsSync(outside), false);
  assert.equal(run("ls ~/.ssh"), false, "read ~/.ssh");
  assert.equal(run("echo hi > inside.txt && node -e 1"), true, "the worktree, and node");
});
