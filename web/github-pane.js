// The GitHub view: your GitHub account. Your open pull
// requests, the ones waiting for your review, issues assigned to you, and
// your recent repos, each a link that opens on github.com. The data comes
// from the Mac's `gh` sign-in (server/github.js); this only draws it.

import { ago } from "./ago.js";

const SECTIONS = [
  { key: "reviews", title: "Waiting for your review", empty: "Nothing is waiting on you." },
  { key: "prs", title: "Your pull requests", empty: "No open pull requests." },
  { key: "issues", title: "Assigned to you", empty: "No open issues assigned to you." },
  { key: "repos", title: "Recent repos", empty: "No repos yet." },
];

export function createGithubPane({ call, h, icon, toast }) {
  const body = h("div", { class: "gh" });
  const el = body;

  let data = null; // the last answer: { me, prs, ... } or { error }. Kept while the next one loads.
  let loading = false;
  let loadedAt = 0;
  let project = ""; // whose repo "This repo" shows
  const folded = new Set(); // section keys folded shut

  // Only an address the server vouched for becomes a link; without one the row is plain text.
  const link = (cls, href, ...kids) => href ? h("a", { class: cls, href, target: "_blank", rel: "noopener" }, ...kids) : h("div", { class: cls }, ...kids);
  const failed = (rows) => rows && !Array.isArray(rows) && rows.error;
  const note = (text, cls = "") => h("div", { class: "files-note " + cls }, text);

  function row(key, x) {
    if (key === "repos") {
      return link("gh-row", x.url,
        h("span", { class: "gh-main" },
          h("span", { class: "gh-title" }, x.name),
          x.private ? h("span", { class: "gh-tag" }, "private") : null,
          x.fork ? h("span", { class: "gh-tag" }, "fork") : null),
        x.description ? h("span", { class: "gh-sub" }, x.description) : null,
        h("span", { class: "gh-meta" }, [x.language, x.stars ? `★ ${x.stars}` : null, x.pushedAt ? `pushed ${ago(x.pushedAt)}` : null].filter(Boolean).join(" · ")));
    }
    return link("gh-row", x.url,
      h("span", { class: "gh-main" },
        h("span", { class: "gh-title" }, x.title),
        x.draft ? h("span", { class: "gh-tag" }, "draft") : null,
        ...x.labels.map((l) => h("span", { class: "gh-tag" }, l))),
      h("span", { class: "gh-meta" }, [`${x.repo} #${x.number}`, key === "reviews" && x.author ? `by ${x.author}` : null, x.updatedAt ? ago(x.updatedAt) : null].filter(Boolean).join(" · ")));
  }

  function section({ key, title, empty }) {
    return fold(key, title, data[key], (rows) => h("div", { class: "gh-rows" }, ...rows.map((x) => row(key, x))), empty);
  }

  /** A foldable part: its rows, or why they couldn't load, or that there are none. */
  function fold(key, title, rows, draw, empty) {
    const shut = folded.has(key);
    return h("section", { class: "gh-section" },
      h("button", { class: "gh-head", type: "button", "aria-expanded": String(!shut),
        onclick: () => { shut ? folded.delete(key) : folded.add(key); draw(); } },
      h("span", { class: "chev" + (shut ? "" : " open") }, icon("chevron", 11)),
      h("span", { class: "gh-head-title" }, title),
      Array.isArray(rows) && rows.length ? h("span", { class: "count" }, String(rows.length)) : null),
      shut ? null
        : failed(rows) ? note(rows.error, "err")
          : !Array.isArray(rows) ? note("Couldn't load this part. Refresh to try again.", "err")
            : !rows.length ? note(empty)
              : draw(rows));
  }

  const CI = { passing: "checks passing", failing: "checks failing", pending: "checks running", running: "running" };
  const ci = (state) => (CI[state] ? h("span", { class: "gh-ci " + state, title: CI[state] }, CI[state]) : null);

  /** The project's own repo: its open pull requests with their checks, and its latest runs. */
  function here() {
    const r = data.here;
    if (!r || r.none) return null; // no project picked, or its folder isn't on GitHub
    if (r.error) return h("section", { class: "gh-section" }, h("div", { class: "gh-head-static" }, h("span", { class: "gh-head-title" }, "This repo")), note(r.error, "err"));
    return h("div", {},
      link("gh-repo", r.url, h("span", { class: "gh-repo-label" }, "This repo"), h("span", { class: "gh-repo-name" }, r.name), icon("external", 13)),
      fold("here-prs", "Open pull requests", r.prs, (rows) => h("div", { class: "gh-rows" }, ...rows.map((x) => link("gh-row", x.url,
        h("span", { class: "gh-main" }, h("span", { class: "gh-title" }, x.title), x.draft ? h("span", { class: "gh-tag" }, "draft") : null, ci(x.checks),
          x.review === "changes_requested" ? h("span", { class: "gh-tag" }, "changes requested") : x.review === "approved" ? h("span", { class: "gh-tag" }, "approved") : null),
        h("span", { class: "gh-meta" }, [`#${x.number}`, x.branch, x.author ? `by ${x.author}` : null, x.updatedAt ? ago(x.updatedAt) : null].filter(Boolean).join(" · ")))), ), "No open pull requests."),
      fold("here-runs", "Recent runs", r.runs, (rows) => h("div", { class: "gh-rows" }, ...rows.map((x) => link("gh-row", x.url,
        h("span", { class: "gh-main" }, h("span", { class: "gh-title" }, x.title || x.workflow), ci(x.state)),
        h("span", { class: "gh-meta" }, [x.workflow, x.branch, x.createdAt ? ago(x.createdAt) : null].filter(Boolean).join(" · "))))), "No workflow runs."));
  }

  function draw() {
    if (!data) return body.replaceChildren(h("div", { class: "files-note" }, loading ? "Asking GitHub…" : "Opening…"));
    if (data.error) {
      return body.replaceChildren(h("div", { class: "pane-empty" }, icon("github", 22), h("p", { style: "margin:10px 0 0" }, data.error)));
    }
    const me = data.me;
    body.replaceChildren(
      link("gh-me", me.url,
        me.avatar ? h("img", { class: "gh-avatar", src: me.avatar + (me.avatar.includes("?") ? "&" : "?") + "s=80", alt: "", width: 36, height: 36, referrerpolicy: "no-referrer" }) : icon("github", 28),
        h("span", { class: "gh-who" }, h("span", { class: "gh-name" }, me.name || me.login), h("span", { class: "gh-login" }, "@" + me.login)),
        icon("external", 13)),
      loading ? note("Updating…") : null,
      here(),
      ...SECTIONS.map(section));
  }

  async function load(fresh = false) {
    if (loading) return;
    loading = true;
    draw();
    try { data = await call("GET", `/api/github?project=${encodeURIComponent(project)}${fresh ? "&fresh=1" : ""}`); loadedAt = Date.now(); }
    catch (e) { if (!data?.me) data = { error: e.message }; toast(e.message); } // an old answer is better than none
    loading = false;
    draw();
  }

  return {
    el,
    /** The view was shown for this project: load on first view, and again if it's gone stale (a minute) or the project changed. */
    show(id = "") {
      const changed = id !== project;
      project = id;
      if (!data || changed || Date.now() - loadedAt > 60000) load();
    },
    refresh: () => load(true),
  };
}
