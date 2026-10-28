// A thread's branch name, from the kind, the issue and a few words, and
// the folder its worktree goes in: the same rules for the server, which
// makes them, and the page, which previews them as you type. Pure, tested in test/branches.test.js.

export const KINDS = ["feat", "fix", "docs"];
const WHAT_MAX = 40;

/** feat/12-gpa-goals: a kind, the issue number if there is one, a few words. */
export function branchName({ kind, issue, what }) {
  if (!KINDS.includes(kind)) throw new Error(`Pick one of: ${KINDS.join(", ")}.`);
  const words = String(what || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, WHAT_MAX).replace(/-+$/, "");
  const num = String(issue ?? "").replace(/^#/, "").trim();
  if (num && !/^\d{1,7}$/.test(num)) throw new Error("The issue is a number, like 12.");
  if (!words) throw new Error("Say in a few words what the branch is for.");
  return `${kind}/${num ? num + "-" : ""}${words}`;
}

/** Next to the repo: ~/Desktop/Flaevo + feat/12-x → ~/Desktop/flaevo-feat-12-x (C:\Users\me\Flaevo → C:\Users\me\flaevo-feat-12-x). */
export function worktreeDir(repoDir, branch) {
  const dir = repoDir.replace(/[\\/]+$/, "");
  const cut = Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\"));
  return `${dir.slice(0, cut + 1)}${dir.slice(cut + 1).toLowerCase()}-${branch.replace(/\//g, "-")}`;
}
