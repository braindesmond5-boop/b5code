// ⌘K: one box for everything. Chats, actions, this chat's next steps, models,
// recipes, automations and files, found by a few letters ("cmp" finds
// "Commit & push", "mov sql" a MOVIERUSH chat about SQL). Pure: the matching
// and ranking, tested in test/palette.test.js; app.js builds the items and acts.

/**
 * How well `q` matches `text`: a score (higher is better), or -1 for no match.
 * Each word of the query must appear in order as letters of the text; letters
 * that start a word, or follow each other, count for more.
 */
export function matchScore(text, q) {
  const t = String(text || "").toLowerCase();
  const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  let total = 0;
  for (const w of words) {
    const s = wordScore(t, w);
    if (s < 0) return -1;
    total += s;
  }
  return total;
}

function wordScore(t, w) {
  if (t.includes(w)) return 100 + w.length * 4 - t.indexOf(w) / 10 + (t.indexOf(w) === 0 || /[\s/·_\-.(]/.test(t[t.indexOf(w) - 1]) ? 40 : 0);
  // Letters in order, the first starting a word ("cmp": Commit & push; "opus" isn't in it):
  // each at a word's start, or right after the last, counts more.
  const starts = (i) => i === 0 || /[\s/·_\-.(&]/.test(t[i - 1]);
  let at = -1;
  do at = t.indexOf(w[0], at + 1); while (at >= 0 && !starts(at));
  if (at < 0) return -1;
  let score = 8;
  for (const ch of w.slice(1)) {
    const next = t.indexOf(ch, at + 1);
    if (next < 0) return -1;
    score += next === at + 1 ? 6 : starts(next) ? 8 : 1;
    at = next;
  }
  return score;
}

/** Whether every word of `q` is in `text` as it's typed: how keywords match (letters spread out don't count there). */
function wordsIn(text, q) {
  const t = String(text || "").toLowerCase();
  const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  return words.length && words.every((w) => t.includes(w)) ? 60 + words.join("").length : -1;
}

/**
 * The items to show for `q`, best first: [{ ...item }]. An item is matched on its
 * label (a few letters will do) or its `keywords` (whole words as typed); `weight`
 * lifts a kind (this chat's steps over chats, say). With no query, items marked
 * `top` (the usual ones) come first, in their own order.
 */
export function rankItems(items, q, limit = 40) {
  if (!String(q || "").trim()) return items.filter((i) => i.top).concat(items.filter((i) => !i.top)).slice(0, limit);
  return items
    .map((i) => ({ i, s: Math.max(matchScore(i.label, q), wordsIn(`${i.label} ${i.keywords || ""}`, q)) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s + (b.i.weight || 0) - (a.s + (a.i.weight || 0)))
    .slice(0, limit)
    .map((x) => x.i);
}
