import { test } from "node:test";
import assert from "node:assert/strict";
import { item, repo, profile, explain, safeUrl, checks, repoPr, run, findGh, cachedOverview } from "../server/github.js";
import { ago } from "../web/ago.js";

test("a pull request is cut down to what the view shows", () => {
  const pr = item({ number: 7, title: "Fix it", url: "https://github.com/a/b/pull/7", repository: { nameWithOwner: "a/b" }, updatedAt: "2026-10-01T00:00:00Z", isDraft: true, author: { login: "me" }, extra: 1 });
  assert.deepEqual(pr, { number: 7, title: "Fix it", url: "https://github.com/a/b/pull/7", repo: "a/b", updatedAt: "2026-10-01T00:00:00Z", draft: true, author: "me", labels: [] });
});

test("an issue keeps up to three label names", () => {
  const i = item({ number: 1, title: "x", url: "https://github.com/a/b/issues/1", repository: { nameWithOwner: "a/b" }, labels: [{ name: "bug" }, { name: "ui" }, { name: "p1" }, { name: "extra" }] });
  assert.deepEqual(i.labels, ["bug", "ui", "p1"]);
});

test("a repo and a profile are shaped, with gaps filled", () => {
  assert.deepEqual(repo({ nameWithOwner: "a/b", url: "https://github.com/a/b", pushedAt: "2026-01-01T00:00:00Z", isPrivate: true }),
    { name: "a/b", description: "", url: "https://github.com/a/b", pushedAt: "2026-01-01T00:00:00Z", private: true, fork: false, language: null, stars: 0 });
  assert.equal(profile({ login: "me" }).url, "https://github.com/me");
});

test("gh's failures become words for the view", () => {
  assert.equal(explain("gh: command not found").code, "missing");
  assert.equal(explain("To get started with GitHub CLI, please run:  gh auth login").code, "signed-out");
  assert.equal(explain("error connecting to api.github.com: could not resolve host").code, "offline");
  assert.equal(explain("something odd\nhappened").code, "error");
});

test("a date reads as how long ago", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  assert.equal(ago("2026-10-26T11:59:58Z", now), "just now");
  assert.equal(ago("2026-10-26T11:57:00Z", now), "3 minutes ago");
  assert.equal(ago("2026-10-25T12:00:00Z", now), "1 day ago");
  assert.equal(ago("2026-08-20T12:00:00Z", now), "2 months ago");
  assert.equal(ago("nonsense", now), "");
});

test("only github.com addresses become links", () => {
  assert.equal(safeUrl("https://github.com/a/b/pull/7"), "https://github.com/a/b/pull/7");
  assert.equal(safeUrl("javascript:alert(1)"), "");
  assert.equal(safeUrl("http://github.com/a"), "");
  assert.equal(safeUrl("https://github.com.evil.example/a"), "");
  assert.equal(item({ number: 1, title: "x", url: "javascript:alert(1)" }).url, "");
  assert.equal(profile({ login: "me", avatar_url: "https://evil.example/a.png" }).avatar, "");
  assert.equal(profile({ login: "me", avatar_url: "https://avatars.githubusercontent.com/u/1?v=4" }).avatar, "https://avatars.githubusercontent.com/u/1?v=4");
});

test("a 404 from gh isn't mistaken for gh missing, and a rate limit has its own words", () => {
  assert.equal(explain("gh: Not Found (HTTP 404)").code, "error");
  assert.equal(explain("gh: command not found").code, "missing");
  assert.equal(explain("gh: API rate limit exceeded (HTTP 403)").code, "rate-limit");
});

test("checks reduce to one word", () => {
  assert.equal(checks([]), "");
  assert.equal(checks(null), "");
  assert.equal(checks([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }]), "passing");
  assert.equal(checks([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }]), "pending");
  assert.equal(checks([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "FAILURE" }]), "failing");
  assert.equal(checks([{ state: "PENDING" }]), "pending");
  assert.equal(checks([{ state: "ERROR" }]), "failing");
});

test("a repo's pull request and workflow run are shaped", () => {
  const pr = repoPr({ number: 3, title: "T", url: "https://github.com/a/b/pull/3", headRefName: "fix", reviewDecision: "APPROVED", author: { login: "me" }, statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] });
  assert.equal(pr.branch, "fix");
  assert.equal(pr.review, "approved");
  assert.equal(pr.checks, "passing");
  assert.equal(pr.repo, "");
  assert.equal(run({ databaseId: 9, displayTitle: "CI", status: "completed", conclusion: "failure", url: "https://github.com/a/b/actions/runs/9" }).state, "failing");
  assert.equal(run({ status: "in_progress" }).state, "running");
  assert.equal(run({ status: "completed", conclusion: "cancelled" }).state, "other");
});

test("gh is found on a bare PATH through its usual homes", () => {
  const has = (...ps) => (p) => ps.includes(p);
  assert.equal(findGh({ PATH: "/usr/bin:/bin" }, has("/opt/homebrew/bin/gh"), false), "/opt/homebrew/bin/gh");
  assert.equal(findGh({ PATH: "/x/bin" }, has("/x/bin/gh", "/opt/homebrew/bin/gh"), false), "/x/bin/gh");
  assert.equal(findGh({ PATH: "/usr/bin", HOME: "/Users/me" }, has("/Users/me/.local/bin/gh"), false), "/Users/me/.local/bin/gh");
  assert.equal(findGh({ PATH: "/usr/bin" }, has(), false), null);
});

test("the overview is reused for a short while, asked once at a time, and refreshed on request", async () => {
  let calls = 0;
  const load = async (dir) => { calls++; await new Promise((r) => setTimeout(r, 5)); return { dir, n: calls }; };
  const [a, b] = await Promise.all([cachedOverview("/t1", { load }), cachedOverview("/t1", { load })]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal((await cachedOverview("/t1", { load })).n, 1);
  assert.equal((await cachedOverview("/t1", { load, fresh: true })).n, 2);
  assert.equal((await cachedOverview("/t1", { load, now: Date.now() + 60000 })).n, 3);
  await assert.rejects(cachedOverview("/t2", { load: async () => { throw new Error("no"); } }));
  assert.equal((await cachedOverview("/t2", { load })).dir, "/t2"); // a failure isn't remembered
});
