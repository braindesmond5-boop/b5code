// The buttons under a finished turn: what to do next with the work, from where
// the folder stands in git (server: gitState), and a yes when Claude's reply
// ended by offering to do something. Pure, tested in test/next-steps.test.js.

// "Say the word and I'll commit it", "Want me to open the PR?", "Shall I…"
const OFFER = /\b(say the word|want me to|shall i|should i|would you like me to|do you want me to|let me know if you(?:'d| would)? (?:like|want) me to|i can [^.?!\n]{0,60}\b(?:next|now|if you(?:'d)? like)\b)/i;

/** Whether a reply ends by offering to do something: its last paragraph has the offer. */
export function endsWithOffer(text) {
  const last = String(text || "").trim().split(/\n\s*\n/).pop() || "";
  return OFFER.test(last.slice(-400));
}

const HOOK = "A pre-push hook may run checks; fix what it finds.";
export const PROMPTS = {
  yes: "Yes, go ahead.",
  commit: "Commit the work in this folder: stage the files that belong to it by path (leave unrelated or personal files out), with a clear message that says what changed and why.",
  commitPush: `Commit the work in this folder: stage the files that belong to it by path (leave unrelated or personal files out), with a clear message that says what changed and why. Then push it (\`git push\`, or \`git push -u origin HEAD\` if the branch has no upstream yet). ${HOOK}`,
  push: `Push this branch's commits (\`git push\`, or \`git push -u origin HEAD\` if it has no upstream yet). ${HOOK}`,
  main: (main) => `The PR is merged. Switch back to ${main} and pull, so it has the merged work.`,
};

/**
 * The next steps, most likely first: [{ id, label, title, text? }]. A step with
 * `text` is sent to Claude as your message; "merge" is done by B5 Code with gh,
 * "recipe" saves the thread's task (a Work space's), and "build" and "post" open
 * a chat on the other side (code, Work) with its message ready.
 */
export function nextSteps(g, { offer = false, recipe = false, build = false, post = false } = {}) {
  const out = [];
  if (offer) out.push({ id: "yes", label: "Yes, go ahead", title: "Tell Claude to do what it offered", text: PROMPTS.yes });
  // A Work space's task that went well: kept to run again, or handed to a code project.
  if (recipe) out.push({ id: "recipe", label: "Save as recipe", title: "Keep this task to run again with new material" });
  if (build) out.push({ id: "build", label: "Build this in…", title: "Open a code chat with these findings as its brief" });
  // Code that shipped: told about, from the Work space.
  if (post) out.push({ id: "post", label: "Write the post", title: "Open a Work chat that drafts a release post about what shipped" });
  if (!g?.git) return out;
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  if (g.dirty) {
    out.push({ id: "commit", label: "Commit", title: `${n(g.dirty, "file isn't", "files aren't")} committed. Claude commits them with a message.`, text: PROMPTS.commit });
    if (g.remote) out.push({ id: "commit-push", label: "Commit & push", title: "Claude commits them and pushes the branch.", text: PROMPTS.commitPush });
  } else if (g.ahead && g.remote) {
    out.push({ id: "push", label: "Push", title: `${n(g.ahead, "commit isn't", "commits aren't")} on GitHub yet.`, text: PROMPTS.push });
  }
  const side = g.github && g.branch !== "HEAD" && g.branch !== g.main; // PRs are GitHub's
  const open = g.pr && (g.pr.state === "open" || g.pr.state === "draft");
  if (side && !g.pr && g.prPrompt) out.push({ id: "open-pr", label: "Open PR", title: `Claude pushes ${g.branch} and opens its pull request.`, text: g.prPrompt });
  if (open && g.pr.canMerge) out.push({ id: "merge", label: `Merge PR #${g.pr.number}`, title: `Squash-merge ${g.branch} into ${g.main}` });
  if (side && g.pr?.state === "merged" && !g.dirty && !g.ahead) out.push({ id: "main", label: `Back to ${g.main}`, title: `Claude switches to ${g.main} and pulls the merged work.`, text: PROMPTS.main(g.main) });
  return out;
}
