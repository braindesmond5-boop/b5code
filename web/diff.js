// The green and red view of an edit: which lines went, which came, and a few
// unchanged ones around them. Pure, tested in test/diff.test.js.

const MAX_CELLS = 250000; // beyond this (500×500 lines), show it as all removed, then all added
const CONTEXT = 3;

/** Lines removed and added between two texts: [{ t: "same" | "del" | "add", text }] */
export function lineDiff(before, after) {
  const a = splitLines(before), b = splitLines(after);
  if (a.length * b.length > MAX_CELLS) return [...a.map((text) => ({ t: "del", text })), ...b.map((text) => ({ t: "add", text }))];
  // Longest common subsequence of lines, from the end, then walked forwards.
  const n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: "same", text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ t: "del", text: a[i++] });
    else out.push({ t: "add", text: b[j++] });
  }
  while (i < n) out.push({ t: "del", text: a[i++] });
  while (j < m) out.push({ t: "add", text: b[j++] });
  return out;
}

/** Long unchanged stretches folded to a few lines either side: { t: "skip", count } in their place. */
export function foldSame(rows, context = CONTEXT) {
  const out = [];
  let k = 0;
  while (k < rows.length) {
    if (rows[k].t !== "same") { out.push(rows[k++]); continue; }
    let end = k;
    while (end < rows.length && rows[end].t === "same") end++;
    const run = rows.slice(k, end);
    const head = k === 0 ? 0 : context, tail = end === rows.length ? 0 : context;
    if (run.length > head + tail + 1) {
      out.push(...run.slice(0, head), { t: "skip", count: run.length - head - tail }, ...run.slice(run.length - tail));
    } else out.push(...run);
    k = end;
  }
  return out;
}

/** Lines added and removed across a change's edits. */
export function changeCounts(change) {
  let add = 0, del = 0;
  for (const e of change?.edits || []) for (const r of lineDiff(e.old, e.new)) { if (r.t === "add") add++; else if (r.t === "del") del++; }
  return { add, del };
}

function splitLines(text) {
  const s = String(text ?? "");
  if (!s) return [];
  return (s.endsWith("\n") ? s.slice(0, -1) : s).split("\n");
}

/**
 * A git diff's lines with their numbers, as the terminal shows them: an added
 * or unchanged line has its number in the new file, a removed one its number
 * in the old. Each hunk starts with { t: "hunk", text } (the code it's in, from
 * the @@ line). The file header before the first hunk is left out.
 */
export function gitRows(text) {
  const rows = [];
  let oldN = 0, newN = 0;
  for (const l of String(text || "").split("\n")) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(l);
    if (m) { oldN = Number(m[1]); newN = Number(m[2]); rows.push({ t: "hunk", text: m[3] }); continue; }
    if (!rows.length || l.startsWith("\\")) continue; // header, or "\ No newline at end of file"
    if (l.startsWith("+")) rows.push({ t: "add", n: newN++, text: l.slice(1) });
    else if (l.startsWith("-")) rows.push({ t: "del", n: oldN++, text: l.slice(1) });
    else if (l.startsWith(" ")) { rows.push({ t: "same", n: newN++, text: l.slice(1) }); oldN++; }
  }
  return rows;
}
