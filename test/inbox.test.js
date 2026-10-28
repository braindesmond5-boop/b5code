import { test } from "node:test";
import assert from "node:assert/strict";
import { inboxItems, inboxCount } from "../web/inbox.js";

const t = (id, extra = {}) => ({ id, title: id, updatedAt: 1, ...extra });

test("questions come first, then finished threads, newest first", () => {
  const items = inboxItems({
    threads: [t("a", { lastDoneAt: 50 }), t("b", { updatedAt: 9 }), t("c", { lastDoneAt: 80 })],
    waiting: { b: [{ requestId: "r", summary: "Wrote x" }] },
    seen: {},
  });
  assert.deepEqual(items.map((i) => `${i.kind}:${i.thread.id}`), ["ask:b", "done:c", "done:a"]);
});

test("a finished thread leaves once seen, or while it is open", () => {
  const threads = [t("a", { lastDoneAt: 50 }), t("b", { lastDoneAt: 60 })];
  assert.equal(inboxCount({ threads, seen: { a: 50 } }), 1);
  assert.equal(inboxCount({ threads, seen: { a: 50 }, openThreadId: "b" }), 0);
  assert.equal(inboxCount({ threads, seen: { a: 40 } }), 2, "finished again after it was seen");
});

test("a thread that never finished a turn is not listed", () => {
  assert.equal(inboxCount({ threads: [t("a")] }), 0);
});
