import { test } from "node:test";
import assert from "node:assert/strict";
import { createGithubPane } from "../web/github-pane.js";

// Elements as plain objects: enough to read what the pane drew.
const h = (tag, props, ...kids) => {
  const el = { tag, props: props || {}, kids: kids.flat(Infinity).filter((k) => k != null && k !== false), replaceChildren(...k) { this.kids = k.flat(Infinity).filter((x) => x != null); } };
  return el;
};
const icon = (name) => ({ tag: "icon", props: {}, kids: [], name });
const text = (el) => (typeof el === "string" ? el : el.kids.map(text).join(" "));
const find = (el, fn, out = []) => { if (typeof el === "object") { if (fn(el)) out.push(el); el.kids.forEach((k) => find(k, fn, out)); } return out; };

const answer = (extra = {}) => ({
  me: { login: "me", name: "Me", avatar: "", url: "https://github.com/me" },
  prs: [], reviews: [], issues: [], repos: [], here: null, ...extra,
});

function pane(replies) {
  const asked = [];
  const call = async (_m, path) => { asked.push(path); const r = replies.shift(); if (r instanceof Error) throw r; return r; };
  const toasts = [];
  const p = createGithubPane({ call, h, icon, toast: (m) => toasts.push(m) });
  return { p, asked, toasts, tick: () => new Promise((r) => setTimeout(r, 0)) };
}

test("a part that failed says why, and the others still show", async () => {
  const { p, tick } = pane([answer({ prs: { error: "GitHub's rate limit was reached." }, issues: [{ number: 2, title: "An issue", url: "https://github.com/a/b/issues/2", repo: "a/b", labels: [] }] })]);
  p.show("");
  await tick();
  const t = text(p.el);
  assert.match(t, /rate limit was reached/);
  assert.match(t, /An issue/);
});

test("a row without a vouched address is text, not a link", async () => {
  const { p, tick } = pane([answer({ issues: [{ number: 2, title: "Bad", url: "", repo: "a/b", labels: [] }, { number: 3, title: "Good", url: "https://github.com/a/b/issues/3", repo: "a/b", labels: [] }] })]);
  p.show("");
  await tick();
  assert.deepEqual(find(p.el, (e) => e.tag === "a" && /\/issues\//.test(e.props.href)).map((e) => e.props.href), ["https://github.com/a/b/issues/3"]);
});

test("the project's repo shows its pull requests with their checks", async () => {
  const here = { name: "me/app", url: "https://github.com/me/app", prs: [{ number: 5, title: "Add it", url: "https://github.com/me/app/pull/5", branch: "add", checks: "failing", review: "", author: "me", updatedAt: null, draft: false, labels: [] }], runs: [] };
  const { p, asked, tick } = pane([answer({ here })]);
  p.show("proj1");
  await tick();
  assert.match(asked[0], /project=proj1/);
  assert.match(text(p.el), /me\/app/);
  assert.match(text(p.el), /checks failing/);
});

test("a folder that isn't on GitHub adds nothing", async () => {
  const { p, tick } = pane([answer({ here: { none: true } })]);
  p.show("proj1");
  await tick();
  assert.doesNotMatch(text(p.el), /This repo/);
});

test("an old answer stays on screen while a refresh fails", async () => {
  const { p, toasts, tick } = pane([answer({ issues: [{ number: 2, title: "Kept", url: "https://github.com/a/b/issues/2", repo: "a/b", labels: [] }] }), new Error("offline")]);
  p.show("");
  await tick();
  p.refresh();
  await tick();
  assert.match(text(p.el), /Kept/);
  assert.deepEqual(toasts, ["offline"]);
});

test("switching project asks again, refresh asks for fresh", async () => {
  const { p, asked, tick } = pane([answer(), answer(), answer()]);
  p.show("a"); await tick();
  p.show("a"); await tick();
  assert.equal(asked.length, 1);
  p.show("b"); await tick();
  assert.equal(asked.length, 2);
  p.refresh(); await tick();
  assert.match(asked[2], /fresh=1/);
});
