// The review step: in a Work space, a connector tool that changes something
// out in the world (posting with Typefully, editing a Google Doc, sharing a
// Drive file, replying on YouTube) always waits for your yes, and its card
// shows what would go out, as text rather than JSON. Shared by the server
// (which tools get an "ask" rule) and the page (the card). Pure, tested in
// test/review.test.js.

// A connector tool's own name says what it does: these verbs change something.
const WRITE = /(^|_)(create|edit|update|delete|trash|share|copy|publish|upload|reply|post|send|apply|deploy|merge|reset|rebase|pause|restore|put|remove|add|execute|batch|save|resolve|import|move|rename|archive|schedule|invite|comment)(_|$)/i;
// Acting in your own browser, signed in as you (Claude in Chrome): clicks, typing, forms, scripts, uploads.
const BROWSER_ACTS = /^mcp__claude-in-chrome__(computer|form_input|javascript_tool|file_upload|upload_image|shortcuts_execute|browser_batch)$/;

/** A connector (MCP) tool name's parts: { service: "Typefully", action: "create draft" }, or null. */
export function toolParts(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name || ""));
  if (!m) return null;
  const service = m[1].replace(/^claude_ai_/, "").replace(/_-_.*$/, "").replace(/_/g, " ").trim();
  return { service, action: m[2].replace(/^vidiq_/, "").replace(/_/g, " ") };
}

/** Whether a tool changes something out in the world, so it waits for a yes. */
export const needsReview = (name) => !!toolParts(name) && (WRITE.test(name.slice(name.lastIndexOf("__") + 2)) || BROWSER_ACTS.test(name));

/** Of the tools a session has, the ones to ask about (its "ask" rules). */
export const reviewTools = (tools) => (Array.isArray(tools) ? tools : []).filter((t) => typeof t === "string" && needsReview(t)).sort();

const label = (key) => {
  const words = String(key).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
};
const SKIP = /^(id|.*_id|.*Id|uuid)$/;
// Keys that only make sense with their parent's name: posts[0].text is "Posts 1 text".
const GENERIC = /^(text|value|content|body|enabled|name|title|type|url)$/i;

/**
 * What a request would send, as fields to read: [{ label, text, long }].
 * Strings anywhere in the input (a list of posts, a document's body), ids left out.
 */
export function reviewFields(input) {
  const out = [];
  // `key` is the field's own name (its id test); `name` is what it's called on the card.
  const walk = (v, key, name, depth) => {
    if (out.length >= 12 || depth > 7 || v == null) return;
    if (typeof v === "string") { if (v.trim() && !SKIP.test(key)) out.push({ label: label(name), text: v, long: v.length > 80 || v.includes("\n") }); return; }
    if (typeof v === "number" || typeof v === "boolean") { if (!SKIP.test(key)) out.push({ label: label(name), text: String(v), long: false }); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, key, v.length > 1 ? `${name} ${i + 1}` : name, depth + 1)); return; }
    if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k, GENERIC.test(k) && name ? `${name} ${k}` : k, depth + 1);
  };
  walk(input, "", "", 0);
  // The long ones (what's being posted or written) last, under the short ones (where, who).
  return [...out.filter((f) => !f.long), ...out.filter((f) => f.long)];
}
