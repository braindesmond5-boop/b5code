// Studio's Claude tab: a video's thread, as the editor (B5 Studio, in a frame) draws it.
// The page folds the thread's events as for any thread (feed.js); this cuts that feed
// down to what the tab shows and renders replies here, with B5 Code's own Markdown,
// so the frame only ever receives safe HTML. Pure: the tests run it on made-up feeds.

const KEEP = 80; // the latest items; the whole thread is a click away in B5 Code

/** feed: a thread's folded feed. waiting: its open permission questions. tools: { markdown, headline, current }. */
export function chatSnapshot(feed, { threadId, waiting = [], commands = [], markdown, headline, current }) {
  const items = feed.items.slice(-KEEP).map((it) => {
    switch (it.type) {
      case "user": return { type: "user", text: it.text, steer: it.steer || null };
      case "ai": return { type: "ai", html: markdown(it.text), live: !!it.live };
      case "steps": return { type: "steps", headline: headline(it.steps), steps: it.steps.map((s) => ({ summary: s.summary, state: s.state })) };
      case "ask": return { type: "ask", requestId: it.requestId, summary: it.summary, detail: it.detail || "", canAllowEdits: !!it.canAllowEdits, answer: it.answer || null };
      case "error": return { type: "error", text: it.text };
      case "note": return { type: "note", text: it.text };
      case "limit": return { type: "note", text: it.state === "waiting" ? "Waiting out a usage limit. Claude carries on by itself." : "The usage limit has passed." };
      default: return null; // checks, recaps, artifacts: shown in B5 Code's thread view
    }
  }).filter(Boolean);
  const open = new Set(waiting.map((w) => w.requestId));
  for (const it of items) if (it.type === "ask" && !it.answer && !open.has(it.requestId)) it.answer = "closed";
  return {
    threadId,
    items,
    working: !!feed.working,
    status: feed.working ? current(feed) || "Working" : "",
    skills: commands.filter((c) => c && c.name).map((c) => ({ name: c.name, description: String(c.description || "").slice(0, 140) })).slice(0, 60),
  };
}
