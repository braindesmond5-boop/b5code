// The Files tab: the work folder's files as a tree (folders load as you
// open them), a filter that finds any file by name, and a file opened to
// read with line numbers and code colours. Files Claude changed carry a
// dot. From an open file: mention it in your message, copy its path, or
// open it in your editor or Finder (on the Mac).

import { highlight } from "./highlight.js";

const HIGHLIGHT_MAX = 200 * 1024; // past this a file is shown plain: colouring it would stall the page
const MEDIA = /\.(png|jpe?g|gif|webp|pdf|mp4|mov|webm|mp3|wav)$/i;
const PAGE = /\.(html?|svg)$/i;

export function createFilesPane({ call, h, icon, toast, onMention, onPreview, onMac }) {
  const filter = h("input", { class: "files-filter", type: "search", placeholder: "Find a file…", "aria-label": "Find a file by name", autocomplete: "off", spellcheck: "false" });
  const body = h("div", { class: "files-body" });
  const el = h("div", { class: "files" }, h("div", { class: "files-top" }, filter), body);

  let where = null; // { project, thread, dir }: whose files these are
  let lists = new Map(); // folder path -> entries, once loaded
  let open = new Set(); // folders unfolded
  let changed = new Map(); // file path -> git status letter
  let file = null; // the file being read: { path, text | binary | error }
  let found = null, pick = 0; // filter results, and which one Enter opens
  let onChange = () => {};

  const q = (extra = "") => `project=${encodeURIComponent(where.project)}&thread=${encodeURIComponent(where.thread || "")}${extra}`;

  async function loadFolder(dir) {
    try {
      const r = await call("GET", `/api/files?${q(`&dir=${encodeURIComponent(dir)}`)}`);
      lists.set(dir, r.entries);
    } catch (e) {
      lists.set(dir, { error: e.message });
    }
    draw();
  }

  async function openFile(path) {
    if (MEDIA.test(path)) return onPreview(path); // pictures, PDFs and videos show in Preview
    file = { path, loading: true };
    draw();
    try { file = { path, ...(await call("GET", `/api/files/read?${q(`&path=${encodeURIComponent(path)}`)}`)) }; }
    catch (e) { file = { path, error: e.message }; }
    draw();
    body.scrollTop = 0;
  }

  function toggle(dir) {
    if (open.has(dir)) open.delete(dir);
    else { open.add(dir); if (!lists.has(dir)) loadFolder(dir); }
    draw();
  }

  // A folder holding a changed file shows a dot too.
  const folderChanged = (dir) => [...changed.keys()].some((f) => f.startsWith(dir + "/"));

  function tree(dir, depth) {
    const entries = lists.get(dir);
    if (!entries) return [h("div", { class: "files-note", style: `padding-left:${12 + depth * 14}px` }, "Loading…")];
    if (entries.error) return [h("div", { class: "files-note err", style: `padding-left:${12 + depth * 14}px` }, entries.error)];
    if (!entries.length && depth === 0) return [h("div", { class: "files-note" }, "This folder is empty.")];
    return entries.flatMap((e) => {
      const st = e.dir ? (folderChanged(e.path) ? "•" : "") : changed.get(e.path) || "";
      const row = h("button", {
        class: "file-row" + (e.ignored ? " ignored" : "") + (file?.path === e.path ? " on" : ""), type: "button", title: e.path,
        style: `padding-left:${8 + depth * 14}px`, onclick: () => (e.dir ? toggle(e.path) : openFile(e.path)),
      },
      h("span", { class: "chev" + (open.has(e.path) ? " open" : "") }, e.dir ? icon("chevron", 11) : null),
      icon(e.dir ? "folder" : "file", 13),
      h("span", { class: "file-name" }, e.name),
      st ? h("span", { class: "file-st st-" + (st === "•" ? "dot" : st.replace("??", "U")), title: st === "•" ? "Has changes" : "Changed" }, st === "•" ? "" : st === "??" ? "U" : st) : null);
      return e.dir && open.has(e.path) ? [row, ...tree(e.path, depth + 1)] : [row];
    });
  }

  function viewer() {
    const f = file;
    const name = f.path.split("/").pop();
    const head = h("div", { class: "file-head" },
      h("button", { class: "icon", type: "button", title: "Back to the files", "aria-label": "Back to the files", onclick: () => { file = null; draw(); filter.focus(); } }, icon("up", 14)),
      h("span", { class: "file-path", title: f.path }, f.path.split("/").slice(0, -1).map((p) => h("span", { class: "dim" }, p + "/")), name),
      h("span", { class: "file-actions" },
        h("button", { class: "btn small", type: "button", title: "Put @" + f.path + " into your message", onclick: () => onMention(f.path) }, "Mention"),
        PAGE.test(f.path) ? h("button", { class: "btn small", type: "button", onclick: () => onPreview(f.path) }, "Preview") : null,
        h("button", { class: "icon", type: "button", title: "Copy the path", "aria-label": "Copy the path", onclick: () => copy(f.path) }, icon("paperclip", 14)),
        onMac ? h("button", { class: "icon", type: "button", title: "Open in your editor", "aria-label": "Open in your editor", onclick: () => reveal(f.path, "editor") }, icon("external", 14)) : null,
        onMac ? h("button", { class: "icon", type: "button", title: "Show in Finder", "aria-label": "Show in Finder", onclick: () => reveal(f.path, "finder") }, icon("folder", 14)) : null));
    let content;
    if (f.loading) content = h("div", { class: "files-note" }, "Opening…");
    else if (f.error) content = h("div", { class: "files-note err" }, f.error);
    else if (f.binary) content = h("div", { class: "files-note" }, "This file isn't text, so it can't be shown here.");
    else {
      const text = f.text.endsWith("\n") ? f.text.slice(0, -1) : f.text;
      const lines = text.split("\n").length;
      // Line numbers beside one coloured block, so a comment or string over several lines stays whole.
      content = h("div", { class: "code-view" },
        h("pre", { class: "gutter", "aria-hidden": "true" }, Array.from({ length: lines }, (_, i) => i + 1).join("\n")),
        h("pre", { class: "src" }, h("code", { html: text.length > HIGHLIGHT_MAX ? highlight(text, "") : highlight(text, f.path) })));
      if (f.truncated) content = h("div", {}, content, h("div", { class: "files-note" }, `Only the first 512 KB of this ${Math.round(f.size / 1024)} KB file is shown.`));
    }
    return [head, content];
  }

  function results() {
    if (!found.length) return [h("div", { class: "files-note" }, `No file matches “${filter.value}”.`)];
    return found.map((p, i) => h("button", { class: "file-row result" + (i === pick ? " on" : ""), type: "button", title: p, onclick: () => { clearFilter(); openFile(p); } },
      icon("file", 13), h("span", { class: "file-name" }, p.split("/").pop()), h("span", { class: "file-dir" }, p.split("/").slice(0, -1).join("/")),
      changed.get(p) ? h("span", { class: "file-st st-" + changed.get(p).replace("??", "U") }, changed.get(p) === "??" ? "U" : changed.get(p)) : null));
  }

  function draw() {
    if (!where) return body.replaceChildren(h("div", { class: "files-note" }, "Pick a project to see its files."));
    body.replaceChildren(...(file ? viewer() : found ? results() : tree("", 0)));
    onChange();
  }

  function clearFilter() { filter.value = ""; found = null; pick = 0; }

  let findTimer = null, findAsked = 0;
  filter.addEventListener("input", () => {
    clearTimeout(findTimer);
    if (!filter.value.trim()) { found = null; return draw(); }
    findTimer = setTimeout(async () => {
      const asked = ++findAsked;
      try {
        const r = await call("GET", `/api/files/find?${q(`&q=${encodeURIComponent(filter.value)}`)}`);
        if (asked !== findAsked) return; // a newer search is on its way
        found = r.files; pick = 0; file = null;
      } catch (e) { toast(e.message); }
      draw();
    }, 120);
  });
  filter.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); clearFilter(); draw(); return; }
    if (!found?.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); pick = Math.min(found.length - 1, pick + 1); draw(); }
    if (e.key === "ArrowUp") { e.preventDefault(); pick = Math.max(0, pick - 1); draw(); }
    if (e.key === "Enter") { e.preventDefault(); const p = found[pick]; clearFilter(); openFile(p); }
  });

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast("Path copied"); } catch { toast(text); }
  }
  async function reveal(path, how) {
    try { const r = await call("POST", `/api/files/open?${q()}`, { path, how }); if (how === "editor") toast(`Opened in ${r.app}`); }
    catch (e) { toast(e.message); }
  }

  return {
    el,
    set onChange(fn) { onChange = fn; },
    /** Show the files of this project (and thread, for a branch thread's worktree). */
    show(project, thread, dir, changes) {
      const key = `${project}:${thread || ""}:${dir || ""}`;
      const marks = (changes || []).map((c) => c.file + ":" + c.status).join("|");
      if (!project) { if (where) { where = null; draw(); } return; }
      if (where?.key !== key) {
        where = { key, project, thread, dir, marks };
        changed = new Map((changes || []).map((c) => [c.file, c.status]));
        lists = new Map(); open = new Set(); file = null; clearFilter();
        loadFolder("");
      } else if (where.marks !== marks) {
        // Only redrawn when the changed files differ: this runs on every render of the pane.
        where.marks = marks;
        changed = new Map((changes || []).map((c) => [c.file, c.status]));
        draw();
      }
    },
    /** Folders shown again from disk (after a turn, or the refresh button). */
    refresh() {
      if (!where) return;
      for (const dir of ["", ...open]) loadFolder(dir);
      if (file && !file.loading) openFile(file.path);
    },
    focusFilter() { filter.focus(); },
  };
}
