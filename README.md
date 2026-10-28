# B5 Code

Claude Code in a window, for every project on your Mac or Windows PC. Threads per project, permission questions and Claude's questions answered in the page, skills from a `/` menu, and the project's uncommitted changes and a terminal beside the chat.

It runs the `claude` command you already have, in the project's folder, so each thread gets that folder's CLAUDE.md, skills and memory, on your own subscription.

B5 Code is open source under the MIT license, but it isn't taking contributions: issues and pull requests won't be looked at. You're welcome to fork it.

## Install on Windows

Open **PowerShell** and paste:

```powershell
irm braindesmond5-boop.github.io/b5 | iex
```

(That short address runs [`windows/install.ps1`](windows/install.ps1); the long way is `irm https://raw.githubusercontent.com/braindesmond5-boop/b5code/main/windows/install.ps1 | iex`.)

It checks for Git, Node.js 20+ and Claude Code and offers to install whichever is missing, downloads B5 Code into `%LOCALAPPDATA%\Programs\B5 Code`, builds its app on your PC, and puts **B5 Code** in the Start menu and on the Desktop. B5 Code then updates itself from this repo's `main` while nothing is running (Settings › Update by itself); `b5 update` does it now. Running the line again repairs an install.

On Windows the app is a native window (WebView2, `windows/B5Code.cs`): Windows notifications, the folder picker, and the light or dark title bar. The Terminal is PowerShell. What Windows doesn't have: the overnight queue (its tasks need macOS's sandbox) and dictation. `b5`, `b5 stop`, `b5 restart` and `b5 update` work in any terminal.

## Open it on a Mac

- Click **B5 Code** in the Dock (`~/Applications/B5 Code.app`). It is a native Mac window: it starts the server if needed and shows B5 Code, with a menu bar, copy and paste, zoom (⌘+ / ⌘-) and Mac notifications when a thread finishes or Claude asks you something while you're in another app.
- Closing the window leaves the server running, so a job carries on. `b5 stop` stops it; `b5 restart` restarts it; `b5` alone opens B5 Code in Safari instead.
- After changing anything in `mac/`, rebuild the app with `mac/build.sh` (needs only the Command Line Tools).

The server listens on `127.0.0.1:4317` only, and every request needs the token printed into B5 Code's own page.

The Preview pane (plan pages, screenshots, PDFs, videos) is served from `127.0.0.1:4318` with its own secret: to the browser it is another site, so a previewed page keeps its own saved data but can't reach B5 Code's page or API. Only files in your home folder can be previewed (symlinks are followed first), and a page gets a link locked to its own folder: it can load its own images and scripts, but nothing else.

## How it is built

One dependency: `node-pty` (pinned, with prebuilt Mac and Windows binaries), for the Terminal pane; run `npm install` once after cloning. Everything else is Node's built-ins on the server and plain modules in the page. xterm.js, which draws the terminal, is vendored in `web/vendor/xterm`.

| Part | Job |
|---|---|
| `server/session.js` | One `claude -p` process per thread, speaking stream-json; answers permission questions; resumes by session id |
| `server/events.js` | Claude Code's events to B5 Code's (pure, tested) |
| `server/tools.js` | One plain line per tool call (pure, tested) |
| `server/store.js` | Projects, threads and each thread's saved events in `data/` (pure rules, tested) |
| `server/index.js` | The page, the API, and one event stream to the page |
| `web/feed.js` | A thread's events folded into what the page shows (pure, tested) |
| `web/markdown.js` | Replies to safe HTML (pure, tested) |
| `web/highlight.js` | Syntax colours for code, by language (pure, tested) |
| `web/diff.js` | An edit's removed and added lines, for the green and red view (pure, tested) |
| `server/terminal.js` | One real shell per thread in a pseudo-terminal; scrollback, restart (rules tested with a fake shell) |
| `web/terminal.js` | The Terminal pane: xterm.js, keys up in order, numbered output down the event stream |
| `server/branches.js` | One branch per thread: its worktree, its PR's checks, squash-merge, removing the worktree (rules tested; git side tested on a scratch repo) |
| `web/branch-name.js` | The branch naming rule, shared by the server and the page |
| `server/preview.js` | Which files the Preview pane may show: only your home folder, and a page only its own folder (pure, tested) |
| `server/tls.js` | HTTPS for phone access: B5 Code's own certificate authority and a certificate for the Mac's network addresses |
| `server/artifacts.js` | The pages Claude writes, kept as versions for the cards and Preview (tested) |
| `server/files.js` | The Files tab: a folder's entries, a file to read, finding files by name; nothing outside the work folder (tested) |
| `web/files-pane.js` | The Files tab in the page: the tree, the filter, a file with line numbers and colours |
| `server/github.js`, `web/github-pane.js` | The GitHub view: your account, open PRs, reviews waiting on you, assigned issues and recent repos, read through the Mac's own `gh` sign-in, plus the project's own repo: its open PRs with their checks and recent runs (shaping and pane tested) |
| `server/git.js` | Reading git's status and line counts for the Changes pane, any file name (pure, tested) |
| `server/transcripts.js` | Conversations started with `claude` in a terminal: listing a project's, and bringing one in to carry on (tested) |
| `server/accounts.js` | More than one Claude account: each extra one's own config folder, linked to `~/.claude` for everything but the sign-in; which account a thread works on (tested) |
| `server/tailscale.js` | Reaching B5 Code from anywhere: finding Tailscale, reading its status, the `tailscale serve` commands (pure, tested) |
| `server/push.js` | Notifications on a paired phone: Web Push encryption (RFC 8291) and VAPID (RFC 8292) with Node's own crypto (tested, including RFC 8291's worked example) |
| `web/sw.js`, `web/manifest.webmanifest` | B5 Code as an installable app on the phone: notifications with Allow / Don't allow, and an offline page |
| `server/queue.js` | The overnight queue's rules: what a task may do unasked, its brief, which task is next, what a turn's end means (pure, tested) |
| `web/studio-chat.js` | Studio's Claude tab: a video's thread (one per video, `studioVideo`), cut down for the editor, replies rendered here as safe HTML (tested) |
| `server/studio.js` | Studio: finding B5 Studio (its own project), whether its editor is running, starting it; the page shows the editor in the main area (folder rule tested) |
| `server/awake.js` | Keeps the Mac awake (`caffeinate -i`) while any thread works (tested) |
| `web/app.js` | The page |
| `mac/main.swift` | The native window (WKWebView), menu bar and notifications |
| `server/platform.js` | What differs on Windows: the home folder, how paths compare, starting `claude`, the Terminal's shell, Explorer and editors (tested on a Mac with Windows paths) |
| `windows/B5Code.cs` | The Windows app (WebView2), built on the PC by `windows/build.mjs` with .NET Framework's C# compiler |
| `windows/install.ps1`, `bin/b5.mjs` | The one-line installer, and `b5` on Windows: start, stop, update, setup |
| `web/questions.js` | Claude's questions (AskUserQuestion) as a card: options, your own answer, sent back as the tool's answers (tested) |

`npm test` runs the tests; GitHub Actions runs them on a Mac and on Windows, where it also builds the app and starts B5 Code for real (`.github/windows-smoke.mjs`). `data/` (your projects and threads) is never committed.

`B5_CLAUDE_ARGS` adds flags to every `claude` B5 Code starts, for example `B5_CLAUDE_ARGS="--model opus"`.
