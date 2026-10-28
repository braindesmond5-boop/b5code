// What "Waiting for you" lists, across every project. Pure, so tested.
//
// Two kinds, in this order: Claude asking permission (it can't go on until
// you answer), then threads that finished since you last looked at them.

/**
 * @param {{threads: object[], waiting: Record<string, object[]>, seen: Record<string, number>, openThreadId?: string|null}} s
 * @returns {{kind: "ask"|"done", thread: object, asks?: object[]}[]}
 */
export function inboxItems({ threads = [], waiting = {}, seen = {}, openThreadId = null }) {
  const asks = threads
    .filter((t) => waiting[t.id]?.length)
    .map((t) => ({ kind: "ask", thread: t, asks: waiting[t.id] }))
    .sort((a, b) => (b.thread.updatedAt || 0) - (a.thread.updatedAt || 0));
  const done = threads
    .filter((t) => !waiting[t.id]?.length && t.id !== openThreadId && t.lastDoneAt && t.lastDoneAt > (seen[t.id] || 0))
    .map((t) => ({ kind: "done", thread: t }))
    .sort((a, b) => b.thread.lastDoneAt - a.thread.lastDoneAt);
  return [...asks, ...done];
}

/** The number on the sidebar's "Waiting for you". */
export const inboxCount = (s) => inboxItems(s).length;
