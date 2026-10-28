import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTrigger, scheduleDue, nextRun, describeTrigger, newFiles, runText, minutesOf } from "../server/automations.js";

// Tuesday 27 October 2026, local time.
const at = (h, m = 0, day = 27) => new Date(2026, 9, day, h, m);
const daily = (patch = {}) => ({ enabled: true, createdAt: at(1).getTime() - 864e5, trigger: { type: "schedule", time: "07:30", days: [0, 1, 2, 3, 4, 5, 6] }, ...patch });

test("a trigger is kept only when it makes sense", () => {
  assert.deepEqual(cleanTrigger({ type: "schedule", time: "7:30", days: [5, 1, 1, 9] }), { type: "schedule", time: "07:30", days: [1, 5] });
  assert.equal(cleanTrigger({ type: "schedule", time: "25:00", days: [1] }), null);
  assert.equal(cleanTrigger({ type: "schedule", time: "08:00", days: [] }), null, "no day to run on");
  assert.deepEqual(cleanTrigger({ type: "folder", path: " /Users/x/Downloads " }), { type: "folder", path: "/Users/x/Downloads" });
  assert.equal(cleanTrigger({ type: "rocket" }), null);
  assert.equal(minutesOf("23:59"), 1439);
});

test("a schedule runs once when its time comes, and late if the Mac was asleep", () => {
  assert.equal(scheduleDue(daily(), at(7, 29)), false, "not yet");
  assert.equal(scheduleDue(daily(), at(7, 30)), true);
  assert.equal(scheduleDue(daily(), at(11, 0)), true, "asleep at 07:30: runs on waking, that day");
  assert.equal(scheduleDue(daily({ lastRun: at(7, 30).getTime() }), at(7, 31)), false, "ran already");
  assert.equal(scheduleDue(daily({ enabled: false }), at(7, 30)), false, "switched off");
  assert.equal(scheduleDue(daily({ createdAt: at(9).getTime() }), at(10)), false, "made after today's time: starts tomorrow");
  const weekdays = daily({ trigger: { type: "schedule", time: "07:30", days: [1, 2, 3, 4, 5] } });
  assert.equal(scheduleDue(weekdays, at(8, 0, 31)), false, "Saturday");
});

test("the next run is today's if it's still to come, else the next day it runs", () => {
  assert.equal(nextRun(daily(), at(6)), at(7, 30).getTime());
  assert.equal(nextRun(daily({ lastRun: at(7, 30).getTime() }), at(8)), at(7, 30, 28).getTime());
  const sundays = daily({ trigger: { type: "schedule", time: "18:00", days: [0] } });
  assert.equal(nextRun(sundays, at(9)), new Date(2026, 10, 1, 18, 0).getTime());
  assert.equal(nextRun({ ...daily(), enabled: false }, at(6)), 0);
});

test("triggers in words", () => {
  assert.equal(describeTrigger({ type: "schedule", time: "07:30", days: [0, 1, 2, 3, 4, 5, 6] }), "Every day at 07:30");
  assert.equal(describeTrigger({ type: "schedule", time: "07:30", days: [1, 2, 3, 4, 5] }), "Weekdays at 07:30");
  assert.equal(describeTrigger({ type: "schedule", time: "18:00", days: [0] }), "Sundays at 18:00");
  assert.equal(describeTrigger({ type: "folder", path: "/Users/x/Downloads" }, "/Users/x"), "When files land in ~/Downloads");
});

test("a watched folder's new files: settled ones, not downloads still coming or hidden files", () => {
  const now = 100000;
  const seen = new Set(["old.pdf"]);
  const entries = [
    { name: "old.pdf", mtimeMs: 0 }, { name: "slides.pdf", mtimeMs: 1000 }, { name: "notes.docx", mtimeMs: 2000 },
    { name: "film.mp4.crdownload", mtimeMs: 0 }, { name: ".DS_Store", mtimeMs: 0 }, { name: "~$draft.docx", mtimeMs: 0 },
    { name: "writing.pdf", mtimeMs: now - 1000 }, // still being written
  ];
  assert.deepEqual(newFiles(seen, entries, now), ["notes.docx", "slides.pdf"]);
  assert.equal(runText({ prompt: "Make revision notes.", trigger: { type: "folder", path: "/x/Inbox" } }, ["a.pdf"], "~/Inbox"), "Make revision notes.\n\nNew in ~/Inbox:\n- a.pdf");
  assert.equal(runText({ prompt: "Brief me." }, []), "Brief me.");
});
