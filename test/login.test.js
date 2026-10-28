import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loginPlist, setLoginItem, plistPath, LABEL } from "../server/login.js";

test("the LaunchAgent runs b5 --no-open at login, and keeps the server it starts", { skip: process.platform !== "darwin" && "macOS checks the plist" }, () => {
  const xml = loginPlist({ root: "/Users/me/b5 & co", home: "/Users/me", log: "/Users/me/b5/data/login.log" });
  assert.match(xml, /<string>\/Users\/me\/b5 &amp; co\/bin\/b5<\/string>\s*<string>--no-open<\/string>/);
  assert.match(xml, /<key>AbandonProcessGroup<\/key>\s*<true\/>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  // macOS's own plist checker accepts it.
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "b5-plist-")), "x.plist");
  fs.writeFileSync(f, xml);
  assert.match(execFileSync("plutil", ["-lint", f]).toString(), /OK/);
});

test("switching it on writes and loads it; off unloads and removes it", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "b5-home-"));
  const ran = [];
  const run = async (cmd, args) => { ran.push([cmd, ...args].join(" ")); };
  assert.equal(await setLoginItem(true, { fs, run, root: "/r", home, log: "/r/l", uid: 501 }), true);
  assert.ok(fs.existsSync(plistPath(home)));
  assert.deepEqual(ran, [`launchctl bootout gui/501/${LABEL}`, `launchctl bootstrap gui/501 ${plistPath(home)}`]);
  assert.equal(await setLoginItem(false, { fs, run, root: "/r", home, log: "/r/l", uid: 501 }), false);
  assert.ok(!fs.existsSync(plistPath(home)));
});
