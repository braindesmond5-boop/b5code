// The Terminal pane: xterm.js drawing a real shell that the server runs in
// the thread's folder (server/terminal.js). Keys go up as small POSTs, in
// order; output comes down the page's one event stream, numbered, so a
// snapshot and the live chunks join up without gaps or repeats.
//
// xterm.js (web/vendor/xterm) is only loaded the first time the tab opens.

const LIGHT = ["#27272a", "#c42b1c", "#0f7b3e", "#946200", "#2f5bd3", "#a3329e", "#0b7a8a", "#a1a1aa",
  "#71717a", "#dc2626", "#16a34a", "#b07800", "#3b6ff0", "#c026d3", "#0891b2", "#d4d4d8"];
const DARK = ["#3f3f46", "#f87171", "#4ade80", "#facc15", "#60a5fa", "#e879f9", "#22d3ee", "#d4d4d8",
  "#71717a", "#fca5a5", "#86efac", "#fde68a", "#93c5fd", "#f0abfc", "#67e8f9", "#fafafa"];
const NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

let lib = null;
/** Load xterm.js ahead of time, so the tab opens at once and no key is lost. */
export function loadLib() {
  lib ||= loadNow();
  return lib;
}
async function loadNow() {
  // The stylesheet first: xterm measures its characters when it opens.
  const css = Object.assign(document.createElement("link"), { rel: "stylesheet", href: "vendor/xterm/xterm.css" });
  const cssLoaded = new Promise((resolve) => { css.onload = css.onerror = resolve; });
  document.head.append(css);
  const [, { Terminal }, { FitAddon }, { WebLinksAddon }, { SearchAddon }] = await Promise.all([cssLoaded,
    import("./vendor/xterm/xterm.mjs"), import("./vendor/xterm/addon-fit.mjs"),
    import("./vendor/xterm/addon-web-links.mjs"), import("./vendor/xterm/addon-search.mjs")]);
  return { Terminal, FitAddon, WebLinksAddon, SearchAddon };
}

/** The colours of B5 Code's current theme, for xterm. */
function themeNow() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  const background = v("--canvas") || "#ffffff";
  const dark = isDark(background);
  const ansi = dark ? DARK : LIGHT;
  const theme = { background, foreground: v("--text"), cursor: v("--accent"), cursorAccent: background,
    selectionBackground: dark ? "rgba(124, 123, 240, 0.35)" : "rgba(75, 73, 214, 0.22)" };
  NAMES.forEach((n, i) => {
    theme[n] = ansi[i];
    theme["bright" + n[0].toUpperCase() + n.slice(1)] = ansi[i + 8];
  });
  return theme;
}

function isDark(color) {
  const m = color.match(/^#([0-9a-f]{6})$/i);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 < 128;
}

export function createTerminalPane({ call, h, icon, win = () => false }) {
  // The fit addon measures the terminal's parent, padding included, so the
  // padding goes on a wrapper around it.
  const host = h("div", { class: "term-host" });
  const wrap = h("div", { class: "term-wrap" }, host);
  const findInput = h("input", { class: "term-find-input", placeholder: "Find", "aria-label": "Find in terminal", spellcheck: "false", autocomplete: "off" });
  const find = h("div", { class: "term-find", hidden: true }, findInput,
    h("button", { class: "icon", type: "button", title: "Previous (⇧Enter)", "aria-label": "Previous match", onclick: () => findStep(-1) }, icon("up", 14)),
    h("button", { class: "icon", type: "button", title: "Next (Enter)", "aria-label": "Next match", onclick: () => findStep(1) }, icon("down", 14)),
    h("button", { class: "icon", type: "button", title: "Close (Esc)", "aria-label": "Close find", onclick: () => closeFind() }, icon("x", 14)));
  const ended = h("div", { class: "term-ended", hidden: true });
  const el = h("div", { class: "term" }, find, wrap, ended);

  let term = null, fit = null, search = null;
  let key = null; // the thread (or project) whose shell is shown
  let seq = 0, loading = false, queue = [], running = false, visible = false;
  let sending = false, outgoing = [], early = ""; // outgoing: [{ to, data }]; early: typed while the shell was connecting
  let size = { cols: 0, rows: 0 }, resizeTimer = null;
  let onChange = () => {};

  async function ensure() {
    if (term) return;
    const { Terminal, FitAddon, WebLinksAddon, SearchAddon } = await loadLib();
    if (term) return;
    term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', fontSize: 12, lineHeight: 1.25,
      cursorBlink: true, scrollback: 5000, allowProposedApi: true, macOptionClickForcesSelection: true,
      theme: themeNow(),
    });
    fit = new FitAddon();
    search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon((e, uri) => window.open(uri, "_blank", "noopener")));
    term.open(host);
    term.onData((d) => {
      // An ended shell: Enter starts a new one.
      if (loading) { early += d; return; }
      if (!running) { if (d === "\r") restart(); return; }
      send(d);
    });
    term.onBinary((d) => running && send(d));
    // ⌘K clears and ⌘F finds, as in Terminal.app. Other ⌘ keys stay B5 Code's.
    // Windows, as in Windows Terminal: Ctrl+C copies what's selected (else it's the shell's), Ctrl+V
    // pastes (the browser's paste, not a ^V), Ctrl+Shift+K clears and Ctrl+Shift+F finds.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && win() && e.ctrlKey && !e.altKey && !e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === "c" && (e.shiftKey || term.hasSelection())) { e.preventDefault(); navigator.clipboard?.writeText(term.getSelection()).catch(() => {}); term.clearSelection(); return false; }
        if (k === "v") return false;
        if (e.shiftKey && k === "k") { e.preventDefault(); term.clear(); return false; }
        if (e.shiftKey && k === "f") { e.preventDefault(); openFind(); return false; }
        return true;
      }
      if (e.type !== "keydown" || !e.metaKey) return true;
      const k = e.key.toLowerCase();
      if (k === "k") { e.preventDefault(); term.clear(); return false; }
      if (k === "f") { e.preventDefault(); openFind(); return false; }
      return true;
    });
    new ResizeObserver(() => requestAnimationFrame(refit)).observe(host);
  }

  function refit() {
    if (!term || !visible || !host.clientWidth || !host.clientHeight) return;
    try { fit.fit(); } catch { return; }
    if (term.cols === size.cols && term.rows === size.rows) return;
    size = { cols: term.cols, rows: term.rows };
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (key && running) call("POST", `/api/terminals/${key}/resize`, size).catch(() => {}); }, 60);
  }

  // Keys go one request at a time, so they arrive in the order typed, and
  // each to the shell it was typed into, even after switching threads.
  function send(data) {
    const last = outgoing[outgoing.length - 1];
    if (last && last.to === key) last.data += data; else outgoing.push({ to: key, data });
    if (sending) return;
    sending = true;
    (async () => {
      while (outgoing.length) {
        const { to, data: d } = outgoing.shift();
        try { await call("POST", `/api/terminals/${to}/input`, { data: d }); } catch { /* the shell went away */ }
      }
      sending = false;
    })();
  }

  /** Show the shell for `id` from its snapshot, starting it if it has none. */
  async function load(id, action = "") {
    loading = true;
    queue = [];
    early = "";
    term.reset();
    refit();
    let snap;
    try {
      snap = await call(action === "peek" ? "GET" : "POST", `/api/terminals/${id}${action === "restart" ? "/restart" : ""}`, action === "peek" ? undefined : { cols: term.cols, rows: term.rows });
    } catch (e) {
      if (key !== id) return;
      loading = false;
      running = false;
      term.write(`\x1b[33m${e.message}\x1b[0m\r\n`);
      return update();
    }
    if (key !== id) return; // switched away meanwhile
    term.write(snap.data || "");
    seq = snap.seq || 0;
    running = !!snap.running;
    loading = false;
    for (const m of queue) take(m);
    queue = [];
    update();
    // A shell started in the background has the default size until told.
    if (running) { size = { cols: 0, rows: 0 }; refit(); }
    if (running && early) send(early);
    early = "";
  }

  function take(m) {
    if (m.exit !== undefined) {
      running = false;
      term.write(`\r\n\x1b[2m[Shell ended${m.exit ? ` with code ${m.exit}` : ""}. Press Enter to start a new one.]\x1b[0m\r\n`);
      return update();
    }
    if (m.seq <= seq) return; // already in the snapshot
    if (m.seq > seq + 1) return load(key, "peek"); // missed some (a reconnect): catch up
    seq = m.seq;
    term.write(m.data);
  }

  function update() {
    ended.hidden = running || loading || !key;
    ended.replaceChildren(h("span", {}, "Shell ended."), h("button", { class: "btn", type: "button", onclick: () => restart() }, "Start a new shell"));
    onChange();
  }

  async function restart() {
    if (!key) return;
    await load(key, "restart");
    term.focus();
  }

  function openFind() {
    find.hidden = false;
    findInput.focus();
    findInput.select();
  }
  function closeFind() {
    find.hidden = true;
    search?.clearDecorations();
    term?.focus();
  }
  function findStep(dir) {
    if (!findInput.value) return;
    const opts = { decorations: { matchOverviewRuler: "#a1a1aa", activeMatchColorOverviewRuler: "#4b49d6", matchBackground: "#fde68a80", activeMatchBackground: "#f59e0b" } };
    if (dir < 0) search.findPrevious(findInput.value, opts); else search.findNext(findInput.value, opts);
  }
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); }
  });
  findInput.addEventListener("input", () => findInput.value ? search.findNext(findInput.value, { incremental: true }) : search.clearDecorations());

  return {
    el,
    get running() { return running; },
    get key() { return key; },
    set onChange(fn) { onChange = fn; },

    /** The tab is showing `id`'s shell. Cheap to call on every render. */
    async show(id) {
      const wasVisible = visible;
      visible = true;
      await ensure();
      if (id !== key) {
        key = id;
        if (!id) { term.reset(); running = false; return update(); }
        term.focus(); // keys typed while it connects are kept and sent after
        await load(id);
      } else if (!wasVisible) {
        refit();
        term.focus();
      }
    },
    hide() { visible = false; },

    /** A message from the event stream: { terminal, seq, data } or { terminal, exit }. */
    message(m) {
      if (!term || m.terminal !== key) return;
      if (loading) queue.push(m); else take(m);
    },
    /** After the event stream reconnects, chunks may have been missed. */
    resync() { if (term && key && visible) load(key, "peek"); },

    restart,
    stop() { if (key && running) call("POST", `/api/terminals/${key}/stop`).catch(() => {}); term?.focus(); },
    clear() { term?.clear(); term?.focus(); },
    find: openFind,
    retheme() { if (term) term.options.theme = themeNow(); },
  };
}
