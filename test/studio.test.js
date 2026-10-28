import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { studioDir } from "../server/studio.js";

const home = "/Users/me";
const has = (...dirs) => (f) => dirs.some((d) => f === path.join(d, "editor", "server.mjs"));

test("a B5 Code project that is B5 Studio wins", () => {
  const projects = [{ dir: "/work/b5code" }, { dir: "/work/B5 Studio" }];
  assert.equal(studioDir(projects, home, has("/work/B5 Studio")), "/work/B5 Studio");
});

test("a project named like it but without the editor doesn't count", () => {
  const projects = [{ dir: "/work/b5-studio-notes" }];
  assert.equal(studioDir(projects, home, has(path.join(home, "Desktop", "B5 Studio"))), path.join(home, "Desktop", "B5 Studio"));
});

test("otherwise ~/Desktop/B5 Studio, if it's there", () => {
  assert.equal(studioDir([], home, has(path.join(home, "Desktop", "B5 Studio"))), path.join(home, "Desktop", "B5 Studio"));
  assert.equal(studioDir([], home, has()), null);
});

test("a Work space is never B5 Studio", () => {
  assert.equal(studioDir([{ dir: "/work/B5 Studio", kind: "work" }], home, has("/work/B5 Studio")), null);
});
