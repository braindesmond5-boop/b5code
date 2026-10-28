// B5 Code's service worker, on a paired phone: what makes it installable as
// an app, the page shown when the Mac can't be reached, what's shared to it
// from another app (the manifest's share_target), and notifications
// (Web Push, sent by server/push.js). A question's Don't allow is answered from
// the notification itself, with the one-time key it came with; Allow… opens the app.

const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>B5 Code</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;font:16px system-ui,sans-serif;background:#0b0b0c;color:#e4e4e7;text-align:center}
main{max-width:340px}h1{font-size:20px;margin:0 0 10px;color:#fafafa}p{color:#a1a1aa;line-height:1.5;margin:0 0 18px}button{height:46px;padding:0 22px;border:0;border-radius:12px;background:#7c7bf0;color:#0b0b0c;font-size:15px;font-weight:600}</style></head>
<body><main><h1>Can't reach your Mac</h1><p>Check that Tailscale is on (on this phone and the Mac), that the Mac is awake, and that B5 Code is running on it.</p><button onclick="location.reload()">Try again</button></main></body></html>`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Shared from another app (Android's Share menu): kept here a moment, then B5 Code
// opens and takes it into a new Work chat (takeShared in app.js).
const SHARE = "b5-share";
async function keepShared(request) {
  const form = await request.formData();
  const cache = await caches.open(SHARE);
  for (const key of await cache.keys()) await cache.delete(key); // only the latest share
  const files = form.getAll("files").filter((f) => f && typeof f === "object" && f.size);
  await Promise.all(files.map((f, i) => cache.put(`shared/file/${i}`, new Response(f, { headers: { "content-type": f.type || "application/octet-stream", "x-name": encodeURIComponent(f.name || `shared-${i + 1}`) } }))));
  const meta = { title: String(form.get("title") || ""), text: String(form.get("text") || ""), url: String(form.get("url") || ""), files: files.length };
  await cache.put("shared/meta", new Response(JSON.stringify(meta), { headers: { "content-type": "application/json" } }));
  return Response.redirect("./?share=1", 303);
}

// Page loads, and a share; everything else (the API, the live event stream) goes straight to the Mac.
self.addEventListener("fetch", (e) => {
  if (e.request.method === "POST" && new URL(e.request.url).pathname.endsWith("/share")) { e.respondWith(keepShared(e.request)); return; }
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, { headers: { "content-type": "text/html; charset=utf-8" } })));
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() || "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "B5 Code", {
    body: d.body || "", tag: d.tag, data: d, icon: "icon-192.png", badge: "icon-192.png",
    actions: d.actions || [],
    // A question stays until it's answered.
    requireInteraction: !!d.answerKey, renotify: !!d.answerKey,
  }));
});

const say = (body, tag) => self.registration.showNotification("B5 Code", { body, tag, icon: "icon-192.png", badge: "icon-192.png" });

self.addEventListener("notificationclick", (e) => {
  const d = e.notification.data || {};
  e.notification.close();
  // Don't allow is answered from here. Allow opens the app (which needs the phone unlocked).
  if (d.answerKey && e.action === "deny") {
    e.waitUntil(fetch("push-answer", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: d.answerKey, choice: "deny" }) })
      .then((r) => (r.ok ? null : say("That question had already closed.", d.tag)))
      .catch(() => say("Couldn't reach your Mac to answer. Open B5 Code to answer there.", d.tag)));
    return;
  }
  // Anything else: open B5 Code at the thread.
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) { w.postMessage({ type: "b5:open", threadId: d.threadId || null }); return w.focus(); }
    return self.clients.openWindow(d.threadId ? `./?thread=${encodeURIComponent(d.threadId)}` : "./");
  })());
});
