// How long ago a date was, for the GitHub view (pure, tested).

export function ago(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return "";
  const [n, unit] = s < 60 ? [s, "second"] : s < 3600 ? [Math.floor(s / 60), "minute"] : s < 86400 ? [Math.floor(s / 3600), "hour"] : s < 86400 * 30 ? [Math.floor(s / 86400), "day"] : s < 86400 * 365 ? [Math.floor(s / 86400 / 30), "month"] : [Math.floor(s / 86400 / 365), "year"];
  return s < 10 ? "just now" : `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}
