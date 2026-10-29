// Carrying a thread on with another agent when its own has hit a usage limit.
// The rules only: who is next, what a limit looks like, and what the next
// agent is told. The timer, the sending and the state are in server/index.js.
// Pure, tested in test/handoff.test.js.

export const HANDOFF_MS = 30 * 1000; // time to cancel before it starts by itself

/**
 * Whether an agent's error is a usage or rate limit (Claude's own are read by limitResetAt in server/events.js).
 * Only wordings that say so: "context window exhausted", or a credit mentioned in passing, are other errors.
 */
export const isAgentLimit = (error) => /rate.?limit|usage limit|too many requests|(?:status|http|error|code)\D{0,3}429|\b429 too|(?:exceeded|reached|hit)\b[^.]{0,30}\b(?:quota|limit)|quota (?:exceeded|reached)|(?:out of|insufficient|no more) (?:credits?|quota)|credits? (?:exhausted|depleted|ran out)/i.test(String(error || ""));

/**
 * The agent to carry on with: the first of `order` that isn't `current` and is free.
 * @param {{current: string, order: string[], free: (id: string) => boolean}} p
 * @returns {string|null}
 */
export function nextAgent({ current, order, free }) {
  return order.find((id) => id !== current && free(id)) || null;
}

const clip = (s, n) => {
  const t = String(s || "").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/**
 * The text the next agent starts with: the conversation so far, in short, and the files changed.
 * `log` is the thread's saved events. Your messages and the agent's replies are kept, the newest turns first
 * if the whole doesn't fit; B5 Code's own earlier hand-over messages are left out (they are in the log as well).
 */
export function handoffBrief({ log, fromName, budget = 12000 }) {
  // Each reply is named for the agent that wrote it: a thread that went Claude, OpenCode, Claude has had both.
  let agent = (log || []).find((e) => e.kind === "handoff_done")?.fromName || fromName;
  const turns = []; // { you, agent, replies: [] }; `you` is null for what an agent wrote after a handover, before you said anything more
  const files = new Set();
  for (const ev of log || []) {
    if (ev.kind === "handoff_done") { agent = ev.toName || agent; turns.push({ you: null, agent, replies: [] }); }
    else if (ev.kind === "user" && !ev.steer && ev.auto !== "handoff") turns.push({ you: ev.text, agent, replies: [] });
    else if (ev.kind === "user" && ev.steer && turns.length) turns[turns.length - 1].replies.push(`(You added: ${clip(ev.text, 400)})`);
    else if (ev.kind === "text" && turns.length) turns[turns.length - 1].replies.push(ev.text);
    else if (ev.kind === "tool" && ev.change?.file) files.add(ev.change.file);
  }
  const lines = turns.filter((t) => t.you !== null || t.replies.length).map((t) => {
    const said = `${t.agent}: ${clip(t.replies.join("\n\n") || "(no reply yet)", 1500)}`;
    return t.you === null ? said : `You: ${clip(t.you, 1500)}\n${said}`;
  });
  // The newest turns that fit, and always the very first request: it says what the thread is for.
  const kept = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (used + lines[i].length > budget && kept.length && i > 0) continue;
    kept.unshift(i);
    used += lines[i].length;
  }
  const shown = kept.map((i) => lines[i]);
  const left = lines.length - kept.length;
  const changed = [...files].slice(-40);
  return [
    `${fromName} reached its usage limit, so you are carrying on this conversation in its place. You can't see its conversation, so here it is in short${left ? ` (${left} turn${left === 1 ? "" : "s"} in the middle left out)` : ""}.`,
    "",
    "Conversation so far:",
    shown.join("\n\n") || "(nothing yet)",
    ...(changed.length ? ["", "Files it changed:", ...changed.map((f) => `- ${f}`)] : []),
    "",
    "Carry on from the last request. Look at the files before relying on this summary.",
  ].join("\n");
}
