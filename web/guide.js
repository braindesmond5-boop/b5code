// The Guide: how to use all of B5 Code well, as short tips by topic, with
// a search. Opened from the sidebar or ⌘/. Each tip is Markdown (bold, code).
// Pure, tested in test/guide.test.js; keep it true to what the app does.

export const GUIDE = [
  {
    id: "start",
    title: "Start here",
    intro: "Six habits that make B5 Code fast.",
    tips: [
      "**Pick the model before your first message.** The chip under the message box says what a new chat really runs. Switching later re-sends the whole conversation to the new model, which costs tokens.",
      "**Keep talking while Claude works.** Type and send: Claude reads it at its next step, without stopping. **Esc** stops it.",
      "**Let the buttons do the routine.** Under a finished turn: **Commit**, **Push**, **Open PR**, **Merge**, or **Yes, go ahead** when Claude offered something.",
      "**⌘K for everything.** Type a few letters to jump to any chat, open a file, switch model, run a recipe or automation, or take this chat's next step (`cmp` finds Commit & push).",
      "**Ask on the side.** The chat icon in the top bar (or `/btw your question`) opens a side chat about the thread while it carries on.",
      "**Hand over the boring work.** A Work space turns tasks you repeat into recipes and automations that run by themselves.",
    ],
  },
  {
    id: "chats",
    title: "Projects and chats",
    intro: "A project is a folder on your Mac; each chat runs Claude Code in it.",
    tips: [
      "**Add project** (bottom of the sidebar) adds any folder. Each chat there gets that folder's `CLAUDE.md`, skills and memory.",
      "**⌘N** starts a new chat in the project you're in. **⌘\\** hides the sidebar.",
      "A chat started in the terminal with `claude` carries on here: on a project's new chat screen, **Continue a conversation from the terminal…**",
      "Click the folder chip under the message box before your first message to work on **a new branch** in its own worktree. The chat then gets a PR box: Open PR, checks, Merge.",
      "**The sidebar has four spaces**: **Chat** (conversations, like claude.ai), **Code** (your projects and their threads), **Work** (the Work space's tasks) and **Studio** (your videos). **New** makes whatever the space is for (⌘N), and Search (⌘K) finds anything.",
      "**Inbox** (a chip in Code; **Waiting for you** in Chat and Work) collects every chat that finished or has a question. Finishing while you watch counts as seen.",
      "**Chat** is for quick conversations: no project, no files, nothing for Claude to change. It can search the web (Settings › Chat), and reads what you write in Settings › Chat › About you.",
    ],
  },
  {
    id: "talking",
    title: "Talking to Claude",
    intro: "Everything the message box can do.",
    tips: [
      "**Enter** sends, **Shift+Enter** is a new line. Prefer **⌘Enter**? Settings › Send with.",
      "Type **/** for skills and commands; arrow keys move, **Tab** or **Enter** picks.",
      "**Attach** with **+**, paste a screenshot (**⌘V**), or drop files on the message box.",
      "The **microphone** dictates your message.",
      "A message sent while Claude works shows **Sent while working**, then **Claude has it** once it's read it.",
      "Claude's task list shows above the message box for work of three or more steps, ticked off as it goes.",
    ],
  },
  {
    id: "watching",
    title: "Watching the work",
    intro: "What Claude is doing, without reading every step.",
    tips: [
      "The working line says what it's on now, for how long, and how many tokens it has written.",
      "Steps fold into one line per run; open one to see the command, the file it read, or the edit in red and green.",
      "**Background** (above the message box) lists commands and agents running on their own, with a clock and their current step.",
      "Each turn ends with a **receipt**: how long it worked, the files it changed, tests passed or failed, commits and whether they were pushed. Click it for every command it ran.",
      "Permission questions appear in the chat, and on your phone if you've paired one.",
    ],
  },
  {
    id: "pane",
    title: "The side pane",
    intro: "Open it with the panel button at the top right. Four tabs.",
    tips: [
      "**Changes**: everything this chat did, committed or not, with each file's code and line numbers. **Uncommitted** shows only what isn't committed. Click a file to fold it.",
      "**Files**: the project's folder. Type to find a file, click one to read it with line numbers.",
      "**Preview**: pages Claude makes open here by themselves, with their versions. Pick a **phone or tablet** to see a page at its size. Pictures fit the pane: click for actual size. `localhost` links in replies open here.",
      "**Terminal**: a real shell in the chat's folder. Inside it, **⌘K** clears and **⌘F** finds.",
      "Pictures Claude reads or takes show under their step; click one to open it full size.",
    ],
  },
  {
    id: "shipping",
    title: "Shipping code",
    intro: "From changes to merged, with as little typing as possible.",
    tips: [
      "**Commit** / **Commit & push**: Claude stages your files by path and writes the message. You see exactly what it was asked.",
      "**Open PR** appears on a GitHub branch with no PR yet; **Merge PR #N** once it can be merged (B5 Code merges it itself, after you confirm); **Back to main** afterwards.",
      "**Free checks after each change**: turn them on when B5 Code offers, or in the project's settings. After Claude edits files, B5 Code runs your tests, typecheck and lint itself (no tokens). A red one opens its output; **Fix this** sends Claude only what failed.",
      "**GitHub** (a chip in the Code space): your open PRs, reviews waiting on you, assigned issues and recent repos.",
      "**Studio** (a space in the sidebar, listing your videos): B5 Studio's video editor, for your own footage and animations Claude makes, on one timeline. Opening a video hides the sidebar to make room. Its **Claude** tab (⌘L) is that video's own thread: Claude knows the playhead and the clip you've selected, edits the video as you watch (⌘Z undoes it), and / lists your skills.",
      "**Queue** (a chip in the Code space), the overnight queue: line up tasks to run one after another while you sleep, each on its own branch.",
      "Once a PR is merged (or work is pushed to main), **Write the post** opens a Work chat that drafts a release post about what shipped.",
    ],
  },
  {
    id: "work",
    title: "B5 Work",
    intro: "Everyday work, not code: documents, research, spreadsheets, files.",
    tips: [
      "**Start a Work space** (in the sidebar's Work space) makes `~/Documents/B5 Work`. Its chats save what they make there, in clear folders.",
      "Start from a card: **Revision notes**, **Research**, **Spreadsheet**, **Document**, **Posts**, **Tidy a folder**. The first `[blank]` is selected, so just type.",
      "Ask for a **Word, PDF, Excel or PowerPoint** file by name and that's what you get; otherwise Markdown. Open them from **Files**.",
      "It **remembers you**: tell it how you cite, name files or write posts, and it keeps that in the space's `CLAUDE.md` for every later task.",
      "Before moving or deleting more than a few files, it lists what it will do and waits for your yes.",
      "After a task that went well, **Save as recipe**. Put `[brackets]` round what changes each time; it waits on the space's new chat screen.",
      "**Nothing goes out without you.** Posting with Typefully, editing a Google Doc, sharing a Drive file, replying on YouTube: a **Before it goes out** card shows what would be sent, and waits for **Send it**.",
      "**Build this in…** under a finished task opens a chat in one of your code projects with the findings as its brief, ready for you to send.",
    ],
  },
  {
    id: "automations",
    title: "Automations",
    intro: "Work that starts itself. In your Work space, under Automations › New, or the clock on a recipe.",
    tips: [
      "**On a schedule**: every day, weekdays, weekends or Sundays at a time. A Mac asleep then runs it when it wakes, that day.",
      "**When files land in a folder**: drop lecture PDFs, receipts or downloads in, and Claude is sent the task with the new files. Downloads still coming in wait; what's there already is left alone.",
      "Each run is a new chat named after it and the day; your phone hears when it's done.",
      "**Run now** tries it straight away; the switch turns it off without deleting it; the cog edits it.",
      "A run never starts while the last one is still working, and what it writes into its own folder doesn't set it off again.",
      "Good first ones: a **morning brief** every weekday at 07:30, and **revision notes** from a `Uni/Inbox` folder.",
    ],
  },
  {
    id: "accounts",
    title: "Accounts and limits",
    intro: "More than one Claude subscription, used well.",
    tips: [
      "Add another account in **Settings › Accounts**. The cards in the sidebar show each one's five-hour and weekly use.",
      "When an account reaches its limit, the chat **moves to another** and carries on.",
      "**Carry on after a usage limit** (Settings) sends a stopped chat on its way again when the limit resets.",
      "Tokens: the same chat on the same model is cheapest. A break over an hour, a model switch or an account switch makes Claude re-read the conversation.",
    ],
  },
  {
    id: "phone",
    title: "Your phone",
    intro: "B5 Code on your phone, at home or away.",
    tips: [
      "**Settings › Phone access › Pair a phone** shows a QR code; scan it on the phone.",
      "With **Tailscale** on both, it works away from home too, with no certificate warning.",
      "Add it to the home screen to get **notifications**: a chat finished, or Claude asks something, with **Allow** and **Don't allow** right in the notification.",
      "**Share to B5 Code** from any app (Android's Share menu, once it's on your home screen): a photo of a whiteboard, a PDF, a voice note or a link opens a new Work chat with it attached. Say what to do with it.",
      "**B5 Code not in the Share menu?** Install it from Chrome at your Tailscale address (`https://…ts.net`), so it's a real app: long-press its icon and you'll see **App info**. If it was installed before sharing existed, **App info › Uninstall** it (removing the icon isn't enough), then install it again from Chrome.",
    ],
  },
  {
    id: "running",
    title: "Keeping it running",
    intro: "B5 Code looks after itself.",
    tips: [
      "**Update by itself** (Settings): when its code changes, it restarts as soon as nothing is running. **Restart now** in the bar carries working chats on afterwards.",
      "**Keep the Mac awake** (Settings) stops sleep while a chat works.",
      "Closing the window leaves the server running, so a job carries on. In a terminal: `b5 restart`, `b5 stop`, or `b5` to open it in Safari.",
      "**Settings** also has text size, the background, playful working words and notifications.",
    ],
  },
];

export const SHORTCUTS = [
  ["⌘N", "New chat"],
  ["⌘K", "Everything: chats, actions, files, models, recipes"],
  ["⌘\\", "Hide or show the sidebar"],
  ["⌘,", "Settings"],
  ["⌘/", "This guide"],
  ["Enter", "Send (Shift+Enter: new line)"],
  ["Esc", "Stop Claude"],
  ["/", "Skills and commands"],
  ["/btw", "Side chat about this thread"],
  ["⌘V", "Paste a screenshot"],
];

/** The sections with the tips that match every word of `q` (all of them for an empty search). */
export function searchGuide(q, guide = GUIDE) {
  const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return guide;
  const hit = (text) => words.every((w) => text.toLowerCase().includes(w));
  return guide.map((s) => (hit(s.title) ? s : { ...s, tips: s.tips.filter(hit) })).filter((s) => s.tips.length);
}

/**
 * The guide as it reads on Windows: Ctrl for ⌘, "PC" for "Mac", File Explorer for Finder, and no
 * overnight queue (it needs macOS's sandbox). Terminal tips name Windows's keys.
 */
export function forWindows(guide = GUIDE, shortcuts = SHORTCUTS) {
  const say = (t) => t
    .replace("Inside it, **⌘K** clears and **⌘F** finds.", "Inside it, **Ctrl+Shift+K** clears, **Ctrl+Shift+F** finds, and **Ctrl+C** copies what's selected.")
    .replace("`b5` to open it in Safari", "`b5` to open its window")
    .replace(/⌘/g, "Ctrl+").replace(/\b(?:a|the|this|your) Mac\b/g, (m) => m.replace("Mac", "PC")).replace(/\bFinder\b/g, "File Explorer");
  return {
    guide: guide.map((s) => ({ ...s, intro: s.intro && say(s.intro), tips: s.tips.filter((t) => !t.startsWith("**Queue**")).map(say) })),
    shortcuts: shortcuts.map(([k, what]) => [say(k), what]),
  };
}
