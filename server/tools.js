// One short line per tool call, in plain words: "Read courses.js" rather than
// a JSON blob. Pure, and the only place that knows how each tool is worded.

const base = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || String(p || "");
const clip = (s, n = 70) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

export function toolSummary(name, input = {}) {
  const i = input || {};
  switch (name) {
    case "Read": return `Read ${base(i.file_path)}`;
    case "Write": return `Wrote ${base(i.file_path)}`;
    case "Edit": return `Edited ${base(i.file_path)}`;
    case "NotebookEdit": return `Edited ${base(i.notebook_path)}`;
    case "Bash": return i.description ? clip(i.description) : `Ran ${clip(i.command, 60)}`;
    case "Grep": return `Searched for "${clip(i.pattern, 40)}"`;
    case "Glob": return `Listed ${clip(i.pattern, 50)}`;
    case "WebSearch": return `Searched the web: ${clip(i.query, 50)}`;
    case "WebFetch": {
      let host = "";
      try { host = new URL(i.url).host; } catch { host = clip(i.url, 40); }
      return `Read ${host}`;
    }
    case "Skill": return `Used the ${i.skill || "a"} skill`;
    case "Task":
    case "Agent": return `Asked a helper: ${clip(i.description || i.prompt, 50)}`;
    case "TodoWrite": return "Updated the to-do list";
    case "TaskCreate": return `Added a task: ${clip(i.subject, 50)}`;
    case "TaskUpdate": return i.status === "completed" ? `Finished task #${i.taskId}` : i.status === "in_progress" ? `Started task #${i.taskId}` : `Updated task #${i.taskId}`;
    case "TaskList": return "Read the task list";
    case "ToolSearch": return "Looked up a tool";
    case "AskUserQuestion": {
      const qs = Array.isArray(i.questions) ? i.questions : [];
      return qs.length > 1 ? `Asked you ${qs.length} questions` : qs.length ? `Asked you: ${clip(qs[0]?.question, 70)}` : "Asked you a question";
    }
    default:
      if (typeof name === "string" && name.startsWith("mcp__")) {
        const parts = name.split("__");
        return `${parts.slice(2).join(" ").replace(/[-_]/g, " ")} (${parts[1].replace(/^claude_ai_/, "").replace(/_/g, " ")})`;
      }
      return String(name || "Tool");
  }
}

const CHANGE_MAX = 20000; // per side: enough for any edit worth reading in a pane

/**
 * What a file tool changes, for the green and red view: the file and each
 * replaced text (a new file is all new). Null for tools that change no file.
 */
export function toolChange(name, input = {}) {
  const i = input || {};
  const cut = (s) => String(s ?? "").slice(0, CHANGE_MAX);
  if (name === "Edit" && i.file_path) return { file: i.file_path, edits: [{ old: cut(i.old_string), new: cut(i.new_string) }] };
  if (name === "MultiEdit" && i.file_path && Array.isArray(i.edits)) return { file: i.file_path, edits: i.edits.slice(0, 50).map((e) => ({ old: cut(e.old_string), new: cut(e.new_string) })) };
  if (name === "Write" && i.file_path) return { file: i.file_path, edits: [{ old: "", new: cut(i.content) }], created: true };
  return null;
}
