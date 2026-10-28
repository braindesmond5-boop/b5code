import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAIN, allAccounts, accountEnv, pickAccount, firstReset, isLimited, ensureLinks, removeAccountDir, loginUrl, SHARED_DIRS, mergeUserConfig, syncUserConfig } from "../server/accounts.js";
import { accountNote } from "../web/feed.js";

const accts = allAccounts({ settings: { extraAccounts: true }, accounts: [{ id: "aaaa1111", name: "Work", dir: "/h/.claude-b5-aaaa1111" }] });

test("extra accounts are off until turned on: then only the main account works", () => {
  const state = { settings: {}, accounts: [{ id: "aaaa1111", name: "Work", dir: "/h/.claude-b5-aaaa1111" }] };
  assert.deepEqual(allAccounts(state).map((a) => a.id), [MAIN]);
  assert.deepEqual(allAccounts({ ...state, settings: { extraAccounts: true } }).map((a) => a.id), [MAIN, "aaaa1111"]);
});
const all = () => true;

test("the main account comes first and sets nothing; an extra one sets its folder", () => {
  assert.deepEqual(accts.map((a) => a.id), [MAIN, "aaaa1111"]);
  assert.equal(accountEnv({ CLAUDE_CONFIG_DIR: "/stray", PATH: "x" }, accts[0]).CLAUDE_CONFIG_DIR, undefined, "a stray setting isn't passed on");
  assert.equal(accountEnv({}, accts[1]).CLAUDE_CONFIG_DIR, "/h/.claude-b5-aaaa1111");
});

test("work goes to the first account that's signed in and not at its limit", () => {
  const now = 1000;
  assert.equal(pickAccount(accts, {}, all, now).id, MAIN);
  assert.equal(pickAccount(accts, { main: 5000 }, all, now).id, "aaaa1111");
  assert.equal(pickAccount(accts, { main: 500 }, all, now).id, MAIN, "a limit that has passed doesn't count");
  assert.equal(pickAccount(accts, { main: 5000 }, (id) => id === MAIN, now), null, "a signed-out account is never picked");
  assert.equal(pickAccount(accts, { main: 5000, aaaa1111: 9000 }, all, now), null);
  assert.equal(isLimited({ main: 5000 }, MAIN, now), true);
});

test("with every account at its limit, the wait is for the first to reset", () => {
  assert.equal(firstReset(accts, { main: 9000, aaaa1111: 4000 }, all, 1000), 4000);
  assert.equal(firstReset(accts, { main: 9000, aaaa1111: 4000 }, (id) => id === MAIN, 1000), 9000, "only signed-in accounts");
  assert.equal(firstReset(accts, {}, all), 0);
  assert.equal(firstReset(accts, { main: 9000, aaaa1111: 4000 }, all, 5000), 9000, "a reset already past doesn't count");
  assert.equal(firstReset(accts, { main: 100 }, all, 5000), 0);
});

test("an account folder links what's shared to ~/.claude, and keeps anything real in the way", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "b5-acct-"));
  const main = path.join(home, ".claude");
  fs.mkdirSync(path.join(main, "projects", "-x"), { recursive: true });
  fs.writeFileSync(path.join(main, "settings.json"), "{}");
  const dir = path.join(home, ".claude-b5-aaaa1111");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "its own"); // main has none: left alone, not linked
  fs.mkdirSync(path.join(dir, "skills")); // a real folder in the way: kept and reported
  const notLinked = ensureLinks(fs, main, dir);
  assert.deepEqual(notLinked, ["skills"]);
  assert.equal(fs.readlinkSync(path.join(dir, "projects")), path.join(main, "projects"));
  assert.equal(fs.readlinkSync(path.join(dir, "settings.json")), path.join(main, "settings.json"));
  assert.ok(fs.existsSync(path.join(dir, "projects", "-x")), "the main account's conversations are found through it");
  for (const d of SHARED_DIRS) assert.ok(fs.existsSync(path.join(main, d)), `${d} made in ~/.claude, so both write to one place`);
  assert.deepEqual(ensureLinks(fs, main, dir), ["skills"], "running it again changes nothing");

  // Removing it takes its links and own files, never what they point to.
  fs.writeFileSync(path.join(dir, ".claude.json"), "{}");
  removeAccountDir(fs, home, dir);
  assert.equal(fs.existsSync(dir), false);
  assert.ok(fs.existsSync(path.join(main, "projects", "-x")));
  assert.ok(fs.existsSync(path.join(main, "settings.json")));
  assert.throws(() => removeAccountDir(fs, home, main), /Not an account folder/);
  assert.throws(() => removeAccountDir(fs, home, path.join(home, "Desktop")), /Not an account folder/);
});

test("the sign-in link is found in what claude auth login prints", () => {
  const out = "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y\nPaste code here if prompted > ";
  assert.equal(loginUrl(out), "https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y");
  assert.equal(loginUrl("Opening browser"), "");
});

test("a thread that moved account says why", () => {
  assert.match(accountNote({ why: "limit", fromName: "me@a.com", toName: "Work" }), /me@a\.com reached its usage limit, so this thread carries on with Work/);
  assert.match(accountNote({ why: "you", toName: "Work" }), /^Moved to Work/);
});

test("MCP servers in ~/.claude.json reach an extra account; its own record stays its own", () => {
  const main = { oauthAccount: { email: "a@x" }, mcpServers: { db: { command: "db-mcp" } }, projects: { "/p": { mcpServers: { local: {} }, allowedTools: ["x"] } } };
  const own = { oauthAccount: { email: "b@x" }, numStartups: 3, projects: { "/p": { hasTrustDialogAccepted: true } } };
  const next = mergeUserConfig(main, own);
  assert.equal(next.oauthAccount.email, "b@x");
  assert.deepEqual(next.mcpServers, main.mcpServers);
  assert.deepEqual(next.projects["/p"], { hasTrustDialogAccepted: true, mcpServers: { local: {} } }, "only the MCP keys, beside its own");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b5-cfg-"));
  fs.writeFileSync(path.join(dir, "main.json"), JSON.stringify(main));
  fs.writeFileSync(path.join(dir, "own.json"), JSON.stringify(own));
  assert.equal(syncUserConfig(fs, path.join(dir, "main.json"), path.join(dir, "own.json")), true);
  assert.equal(syncUserConfig(fs, path.join(dir, "main.json"), path.join(dir, "own.json")), false, "unchanged: not written again");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "own.json"), "utf8")).oauthAccount.email, "b@x");
});
