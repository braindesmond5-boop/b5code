// Automations: a task that starts itself, on a schedule ("every weekday at
// 07:30") or when files land in a folder ("lecture slides in Uni/Inbox").
// Each run is a new thread in its project, sent the automation's prompt; your
// phone hears when it finishes. Pure: what's due and what's new, tested in
// test/automations.test.js; server/index.js runs them.

import { pagePath } from "./platform.js";

const DAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];

/** "07:30" → minutes after midnight, or null. */
export function minutesOf(time) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(time || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** A trigger as it's kept: { type: "schedule", time, days } or { type: "folder", path }; null when it isn't one. */
export function cleanTrigger(t) {
  if (t?.type === "schedule") {
    const days = [...new Set((Array.isArray(t.days) ? t.days : []).map(Number).filter((d) => d >= 0 && d <= 6))].sort();
    return minutesOf(t.time) == null || !days.length ? null : { type: "schedule", time: String(t.time).trim().padStart(5, "0"), days };
  }
  if (t?.type === "folder") return typeof t.path === "string" && t.path.trim() ? { type: "folder", path: t.path.trim() } : null;
  return null;
}

/** Today's run time for a schedule, or null when it doesn't run today. */
function todaysRun(trigger, now) {
  if (!trigger.days.includes(now.getDay())) return null;
  const at = new Date(now);
  const min = minutesOf(trigger.time);
  at.setHours(Math.floor(min / 60), min % 60, 0, 0);
  return at;
}

/**
 * Whether a schedule should run now: its time has come today and it hasn't
 * run since. A Mac asleep at 07:30 runs it when it wakes, that day; a day
 * missed altogether isn't made up.
 */
export function scheduleDue(a, now = new Date()) {
  if (!a?.enabled || a.trigger?.type !== "schedule") return false;
  const at = todaysRun(a.trigger, now);
  return !!at && now >= at && (a.lastRun || 0) < at.getTime() && (a.createdAt || 0) < at.getTime();
}

/** When a schedule runs next (ms), or 0. */
export function nextRun(a, now = new Date()) {
  if (!a?.enabled || a.trigger?.type !== "schedule") return 0;
  for (let i = 0; i < 8; i++) {
    const day = new Date(now);
    day.setDate(day.getDate() + i);
    const at = todaysRun(a.trigger, day);
    if (at && at > now && !(i === 0 && (a.lastRun || 0) >= at.getTime())) return at.getTime();
    if (at && i === 0 && scheduleDue(a, now)) return now.getTime();
  }
  return 0;
}

/** "Weekdays at 07:30", "Sundays at 18:00", "When files land in ~/Downloads". */
export function describeTrigger(t, home = "") {
  if (t?.type === "folder") return `When files land in ${pagePath(t.path, home)}`;
  if (t?.type !== "schedule") return "";
  const d = t.days.join(",");
  const when = d === EVERY_DAY.join(",") ? "Every day" : d === WEEKDAYS.join(",") ? "Weekdays" : d === "0,6" ? "Weekends" : t.days.map((x) => DAY_NAMES[x]).join(", ");
  return `${when} at ${t.time}`;
}

// Not finished yet, or not anyone's: a download still coming in, the Finder's own files.
const SKIP = /^\.|\.(crdownload|download|part|partial|tmp|icloud)$|^~\$|^Icon\r?$/i;

/**
 * Files new to a watched folder: in `entries` ({ name, mtimeMs }) but not in
 * `seen` (names), and settled (unchanged for `settleMs`, so a file still being
 * written waits for the next look).
 */
export function newFiles(seen, entries, now = Date.now(), settleMs = 5000) {
  return entries.filter((e) => !seen.has(e.name) && !SKIP.test(e.name) && now - e.mtimeMs >= settleMs).map((e) => e.name).sort();
}

/** What a run is sent: the prompt, and for a folder, the files that came. */
export function runText(a, files = [], shownDir = "") {
  if (!files.length) return a.prompt;
  return `${a.prompt}\n\nNew in ${shownDir || a.trigger.path}:\n${files.map((f) => `- ${f}`).join("\n")}`;
}
