// Plan usage, read from Claude Code's own /usage command (no model call, so
// it costs nothing). Pure parsing here; the server runs the command.
//
// The lines look like:
//   Current session: 79% used · resets Oct 25, 12:49pm (Africa/Accra)
//   Current week (all models): 96% used · resets Oct 26, 12:59am (Africa/Accra)

const LINE = /^\s*Current ([^:]+):\s*(\d{1,3})% used(?:\s*·\s*resets\s+(.+?))?\s*$/i;

/** @returns {{windows: {label: string, used: number, resets: string}[], text: string} | null} */
export function parseUsageText(text) {
  const s = String(text || "");
  const windows = [];
  for (const line of s.split("\n")) {
    const m = LINE.exec(line);
    if (m) windows.push({ label: tidyLabel(m[1]), used: Math.min(100, Number(m[2])) / 100, resets: (m[3] || "").replace(/\s*\([^)]*\)\s*$/, "") });
  }
  return windows.length ? { windows, text: s.trim() } : null;
}

function tidyLabel(raw) {
  const l = raw.trim();
  if (/^session$/i.test(l)) return "Session";
  const week = /^week(?:\s*\((.+)\))?$/i.exec(l);
  if (week) return !week[1] || /all models/i.test(week[1]) ? "Week" : `Week · ${week[1]}`;
  return l[0].toUpperCase() + l.slice(1);
}
