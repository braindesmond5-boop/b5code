// The GitHub view: who you are on GitHub, your open pull requests, the ones
// waiting for your review, issues assigned to you, and your recent repos.
// Everything comes from the `gh` command you're already signed in with, so
// B5 Code never holds a GitHub token. The shaping is pure and tested; the gh
// calls below it are thin.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { IS_WIN, findProgram, programFiles } from "./platform.js";

const PR_FIELDS = "number,title,url,repository,updatedAt,isDraft,author";
const ISSUE_FIELDS = "number,title,url,repository,updatedAt,labels";
const REPO_FIELDS = "nameWithOwner,description,url,pushedAt,isPrivate,isFork,primaryLanguage,stargazerCount";

const REPO_PR_FIELDS = "number,title,url,updatedAt,isDraft,author,headRefName,reviewDecision,statusCheckRollup";
const RUN_FIELDS = "databaseId,displayTitle,workflowName,status,conclusion,url,headBranch,createdAt";

/** A link worth following: https, on github.com. Whatever the API sends, nothing else becomes an href. */
export function safeUrl(u, host = (h) => h === "github.com" || h.endsWith(".github.com")) {
  try {
    const x = new URL(String(u));
    return x.protocol === "https:" && host(x.hostname) ? x.href : "";
  } catch { return ""; }
}
const safeAvatar = (u) => safeUrl(u, (h) => h.endsWith(".githubusercontent.com") || h === "github.com");

/** A pull request or issue from `gh search`, cut down to what the view shows. */
export function item(x) {
  return {
    number: x.number,
    title: String(x.title || ""),
    url: safeUrl(x.url),
    repo: x.repository?.nameWithOwner || x.repository?.name || "",
    updatedAt: x.updatedAt || null,
    draft: !!x.isDraft,
    author: x.author?.login || null,
    labels: (x.labels || []).map((l) => l.name).filter(Boolean).slice(0, 3),
  };
}

/** A repo from `gh repo list`. */
export function repo(x) {
  return {
    name: x.nameWithOwner,
    description: x.description || "",
    url: safeUrl(x.url),
    pushedAt: x.pushedAt || null,
    private: !!x.isPrivate,
    fork: !!x.isFork,
    language: x.primaryLanguage?.name || null,
    stars: x.stargazerCount || 0,
  };
}

/** `gh api user`, cut down. */
export function profile(x) {
  return { login: x.login, name: x.name || "", avatar: safeAvatar(x.avatar_url), url: safeUrl(x.html_url) || `https://github.com/${encodeURIComponent(x.login)}` };
}

/** A PR's checks as one word, from `statusCheckRollup`: "failing", "pending", "passing", or "" when it has none. */
export function checks(rollup) {
  const list = Array.isArray(rollup) ? rollup : [];
  if (!list.length) return "";
  const bad = (c) => ["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "ERROR"].includes(c.conclusion || c.state);
  const waiting = (c) => (c.status ? c.status !== "COMPLETED" : ["PENDING", "EXPECTED"].includes(c.state));
  return list.some(bad) ? "failing" : list.some(waiting) ? "pending" : "passing";
}

/** An open pull request of the project's own repo, with where its checks stand. */
export function repoPr(x) {
  return { ...item({ ...x, repository: null }), branch: x.headRefName || "", checks: checks(x.statusCheckRollup), review: String(x.reviewDecision || "").toLowerCase() };
}

/** A workflow run: "passing", "failing", "running", or "other" (cancelled, skipped…). */
export function run(x) {
  const state = x.status && x.status !== "completed" ? "running" : x.conclusion === "success" ? "passing" : x.conclusion === "failure" ? "failing" : "other";
  return { id: x.databaseId, title: String(x.displayTitle || ""), workflow: x.workflowName || "", url: safeUrl(x.url), branch: x.headBranch || "", createdAt: x.createdAt || null, state };
}

/** Why gh couldn't answer, in words for the view. */
export function explain(message) {
  const m = String(message || "");
  if (/^gh: command not found$/i.test(m.trim())) return { code: "missing", error: "The GitHub command line (gh) isn't installed. Install it with `brew install gh`, then sign in with `gh auth login`." };
  if (/auth login|not logged in|authentication|HTTP 401|bad credentials/i.test(m)) return { code: "signed-out", error: "You're not signed in to GitHub. Run `gh auth login` in a terminal, then refresh." };
  if (/rate limit/i.test(m)) return { code: "rate-limit", error: "GitHub's rate limit was reached. Try again in a few minutes." };
  if (/could not resolve|network|ETIMEDOUT|timed out|ENOTFOUND/i.test(m)) return { code: "offline", error: "Couldn't reach GitHub. Check the connection and refresh." };
  return { code: "error", error: m.split("\n").slice(-2).join(" ").trim() || "GitHub didn't answer." };
}

// ── gh ───────────────────────────────────────────────────────────────────────

// Homebrew's, the installer's, Apple's, and the ones put in the home folder. B5 Code started at login or
// from the Mac app has a bare PATH that holds none of them.
// On Windows, the installer's (Program Files) and winget's.
export const ghPlaces = (home, win = IS_WIN, env = process.env) => (win
  ? [programFiles("GitHub CLI\\gh.exe", env), ...(env.LOCALAPPDATA ? [path.win32.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "gh.exe")] : [])]
  : ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh", ...(home ? [path.posix.join(home, ".local/bin/gh"), path.posix.join(home, "bin/gh")] : [])]);

/** The gh command, or null if it isn't installed. */
export function findGh(env = process.env, exists = fs.existsSync, win = IS_WIN) {
  return findProgram("gh", ghPlaces(env.HOME, win, env), { env, win, exists });
}

function gh(args, { cwd, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const bin = findGh();
    if (!bin) return reject(new Error("gh: command not found"));
    // gh runs git for some answers: its own folder goes on the PATH too.
    const env = { ...process.env, PATH: [path.dirname(bin), process.env.PATH || "/usr/bin:/bin"].join(path.delimiter), GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
    execFile(bin, args, { cwd, timeout, maxBuffer: 8 << 20, env, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolve(stdout);
    });
  });
}

const json = async (args, opts) => JSON.parse((await gh(args, opts)) || "null");

// A part that failed carries why, so the view can say so; the others still show.
const part = (fn, shape) => fn().then((rows) => rows.map(shape), (e) => ({ error: explain(e.message).error }));

/** The project's own repo: its open PRs with their checks, and its latest workflow runs. */
export async function repoOverview(dir) {
  let info;
  try { info = await json(["repo", "view", "--json", "nameWithOwner,url"], { cwd: dir }); }
  catch (e) {
    const why = explain(e.message);
    // A folder with no GitHub remote isn't an error: there's just nothing to show.
    return why.code === "error" ? { none: true } : why;
  }
  const [prs, runs] = await Promise.all([
    part(() => json(["pr", "list", "--state", "open", "--limit", "15", "--json", REPO_PR_FIELDS], { cwd: dir }), repoPr),
    part(() => json(["run", "list", "--limit", "6", "--json", RUN_FIELDS], { cwd: dir }), run),
  ]);
  return { name: info.nameWithOwner, url: safeUrl(info.url), prs, runs };
}

/** Everything the view shows, fetched at once. One part failing leaves the rest. */
export async function overview(dir = "") {
  const [me, prs, reviews, issues, repos, here] = await Promise.all([
    json(["api", "user"]).then(profile, (e) => ({ failed: explain(e.message) })),
    part(() => json(["search", "prs", "--author", "@me", "--state", "open", "--sort", "updated", "--limit", "20", "--json", PR_FIELDS]), item),
    part(() => json(["search", "prs", "--review-requested", "@me", "--state", "open", "--sort", "updated", "--limit", "20", "--json", PR_FIELDS]), item),
    part(() => json(["search", "issues", "--assignee", "@me", "--state", "open", "--sort", "updated", "--limit", "20", "--json", ISSUE_FIELDS]), item),
    part(() => json(["repo", "list", "--limit", "30", "--json", REPO_FIELDS]), repo),
    dir ? repoOverview(dir) : null,
  ]);
  if (me.failed) return me.failed;
  return { me, prs, reviews, issues, repos: Array.isArray(repos) ? repos.sort((a, b) => String(b.pushedAt).localeCompare(String(a.pushedAt))) : repos, here };
}

// The same answer is reused for half a minute, and one asking at a time: a view reopened, or a phone and
// a Mac both looking, don't each start five gh processes.
const CACHE_MS = 30000;
const cache = new Map(); // folder -> { at, value } | { pending }

export function cachedOverview(dir = "", { fresh = false, now = Date.now(), load = overview } = {}) {
  const c = cache.get(dir);
  if (c?.pending) return c.pending;
  if (c && !fresh && now - c.at < CACHE_MS) return Promise.resolve(c.value);
  const pending = load(dir).then((value) => { cache.set(dir, { at: now, value }); return value; }, (e) => { cache.delete(dir); throw e; });
  cache.set(dir, { ...c, pending });
  return pending;
}
