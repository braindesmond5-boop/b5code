// Turns Claude Code's stream-json lines into the small set of events the page
// draws. Pure: one raw event in, a list of B5 Code events out, so every shape
// Claude Code sends can be tested without running it.
//
// Live-only events (`delta`, `status`) are drawn but not saved; everything
// else is saved to the thread's log and replayed when the thread is reopened.

import { toolSummary, toolChange } from "./tools.js";
import { reviewTools } from "../web/review.js";

export const LIVE_ONLY = new Set(["delta", "status", "message_start", "phase", "usage", "grow", "tokens", "replay", "task_progress", "checks_running"]);

/** @returns {object[]} B5 Code events */
export function normalize(raw) {
  if (!raw || typeof raw !== "object") return [];
  // A subagent's own chatter has a parent tool; its result reaches us through
  // that tool's result, so drawing it too would repeat it.
  if (raw.parent_tool_use_id) return [];

  switch (raw.type) {
    case "system":
      if (raw.subtype === "init") {
        return [{
          kind: "init", sessionId: raw.session_id, model: raw.model || "", cwd: raw.cwd || "",
          connectors: (raw.mcp_servers || []).map((m) => ({ name: String(m.name || ""), status: String(m.status || "") })),
          review: reviewTools(raw.tools), // the connector tools that change something: a Work space asks before each
        }];
      }
      // "requesting" = the request is out and the model hasn't answered yet;
      // other statuses (compacting, …) are shown as they come.
      if (raw.subtype === "status") {
        if (raw.status === "requesting") return [{ kind: "phase", phase: "waiting" }];
        return raw.status ? [{ kind: "phase", phase: "status", label: String(raw.status) }] : [];
      }
      return taskEvent(raw);

    case "rate_limit_event": {
      const u = usageSummary(raw.rate_limit_info);
      return u ? [{ kind: "usage", ...u }] : [];
    }

    case "stream_event": {
      const e = raw.event || {};
      // Token counts, as the CLI shows them: the context each request carries,
      // the streamed size of what's being written (an estimate until the
      // message ends), and the exact output count when it does.
      if (e.type === "message_start") {
        const u = e.message?.usage || {};
        const context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        return [{ kind: "message_start", ...(context ? { context } : {}) }];
      }
      if (e.type === "message_delta" && Number.isFinite(e.usage?.output_tokens)) return [{ kind: "tokens", output: e.usage.output_tokens }];
      if (e.type === "content_block_delta" && e.delta?.type === "thinking_delta") return [{ kind: "grow", n: (e.delta.thinking || "").length }];
      if (e.type === "content_block_delta" && e.delta?.type === "input_json_delta") return [{ kind: "grow", n: (e.delta.partial_json || "").length }];
      if (e.type === "content_block_start") {
        const b = e.content_block || {};
        if (b.type === "thinking" || b.type === "redacted_thinking") return [{ kind: "phase", phase: "thinking" }];
        if (b.type === "tool_use" || b.type === "server_tool_use") return [{ kind: "phase", phase: "tool", tool: b.name || "" }];
        if (b.type === "text") return [{ kind: "phase", phase: "writing" }];
        return [];
      }
      if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
        return [{ kind: "delta", text: e.delta.text || "" }];
      }
      return [];
    }

    case "assistant": {
      const out = [];
      for (const b of raw.message?.content || []) {
        if (b.type === "text" && b.text) out.push({ kind: "text", text: b.text });
        if (b.type === "tool_use") {
          const change = toolChange(b.name, b.input);
          const todo = toolTodo(b.name, b.input);
          out.push({ kind: "tool", id: b.id, name: b.name, summary: toolSummary(b.name, b.input), detail: change ? "" : toolDetail(b.input), ...(change ? { change } : {}), ...(todo || {}) });
        }
      }
      return out;
    }

    case "user": {
      // --replay-user-messages: Claude Code has taken in a message we sent,
      // which is how a message sent mid-turn is known to have reached it.
      if (raw.isReplay) return [{ kind: "replay", ...(raw.uuid ? { uuid: raw.uuid } : {}) }];
      const out = [];
      const content = raw.message?.content;
      if (!Array.isArray(content)) return out;
      for (const b of content) {
        if (b.type === "tool_result") {
          out.push({ kind: "tool_result", id: b.tool_use_id, ok: !b.is_error, preview: resultPreview(b.content) });
        }
      }
      return out;
    }

    case "control_request":
      if (raw.request?.subtype === "can_use_tool") {
        const r = raw.request;
        const change = toolChange(r.tool_name, r.input);
        return [{
          kind: "permission",
          requestId: raw.request_id,
          tool: r.tool_name,
          summary: toolSummary(r.tool_name, r.input),
          ...(change ? { change } : { detail: toolDetail(r.input) }),
          input: r.input,
          canAllowEdits: (r.permission_suggestions || []).some((s) => s.type === "setMode" && s.mode === "acceptEdits"),
        }];
      }
      return [];

    case "control_response": {
      const r = raw.response?.response;
      const commands = r?.commands;
      if (Array.isArray(commands)) {
        return [{
          kind: "commands",
          list: commands.map((c) => ({ name: c.name, description: c.description || "", hint: c.argumentHint || "" })),
          models: (Array.isArray(r.models) ? r.models : []).map((m) => ({
            value: m.value, model: m.resolvedModel || "", name: m.displayName || m.value, description: m.description || "",
          })),
        }];
      }
      return [];
    }

    case "result":
      return [{
        kind: "done",
        ok: raw.subtype === "success" && !raw.is_error,
        // A refused request (a usage limit, say) can end as "success" flagged is_error: its text is the error.
        error: raw.subtype === "success" && !raw.is_error ? "" : (raw.result || raw.subtype || "Stopped"),
        durationMs: raw.duration_ms || 0,
        sessionId: raw.session_id,
        ...(Number.isFinite(raw.usage?.output_tokens) ? { output: raw.usage.output_tokens } : {}),
        ...(contextWindow(raw.modelUsage) ? { contextWindow: contextWindow(raw.modelUsage) } : {}),
      }];

    default:
      return [];
  }
}

/**
 * Work Claude has going besides its turn (a command run in the background, an
 * agent): when it starts, what it's on now, and how it ended. Claude Code
 * sends a task's end twice (task_updated, then task_notification); the page
 * takes the status from either.
 */
function taskEvent(raw) {
  const id = raw.task_id ? String(raw.task_id) : "";
  if (!id) return [];
  if (raw.subtype === "task_started") {
    // Claude Code reports every command as a task; one that runs while Claude waits is just a step.
    if (!raw.is_backgrounded && raw.task_type === "local_bash") return [];
    return [{ kind: "task_start", id, toolId: String(raw.tool_use_id || ""), text: String(raw.description || "").slice(0, 200), type: TASK_TYPES[raw.task_type] || "task", background: !!raw.is_backgrounded }];
  }
  if (raw.subtype === "task_progress") {
    const u = raw.usage || {};
    return [{ kind: "task_progress", id, now: String(raw.description || "").slice(0, 200), ...(Number.isFinite(u.tool_uses) ? { tools: u.tool_uses } : {}), ...(Number.isFinite(u.total_tokens) ? { tokens: u.total_tokens } : {}) }];
  }
  const status = raw.subtype === "task_updated" ? raw.patch?.status : raw.subtype === "task_notification" ? raw.status : "";
  if (!status) return [];
  // A command's summary says how it ended ("… failed (exit code 1)"); an agent's is about where its report went.
  const summary = raw.subtype === "task_notification" && !/agent/i.test(raw.summary || "") ? String(raw.summary || "").slice(0, 300) : "";
  return [{ kind: "task_status", id, status: String(status), ...(summary ? { summary } : {}) }];
}
const TASK_TYPES = { local_bash: "command", local_agent: "agent", remote_agent: "agent", monitor_ws: "monitor", monitor_mcp: "monitor" };

/** The largest context window among the models a turn used (a turn can use a small model for side tasks). */
function contextWindow(modelUsage) {
  const sizes = Object.values(modelUsage || {}).map((m) => m?.contextWindow).filter(Number.isFinite);
  return sizes.length ? Math.max(...sizes) : 0;
}

/**
 * The account's usage from a rate_limit_event: how much of the five-hour and
 * the weekly allowance is used (0 to 1), and when each resets (ms).
 */
export function usageSummary(info) {
  if (!info || typeof info !== "object") return null;
  const w = info.unifiedWindows || {};
  const win = (x) => (x && Number.isFinite(x.utilization) ? { used: x.utilization, resetsAt: (x.resetsAt || 0) * 1000, status: x.status || "" } : null);
  const fiveHour = win(w.five_hour);
  const week = win(w.seven_day);
  const resetsAt = Number.isFinite(info.resetsAt) ? info.resetsAt * 1000 : 0;
  if (!fiveHour && !week) {
    if (!Number.isFinite(info.utilization) && info.status !== "rejected") return null;
    return { fiveHour: null, week: null, single: win(info), status: info.status || "", resetsAt };
  }
  return { fiveHour, week, status: info.status || "", resetsAt };
}

/**
 * When a turn that hit the plan's limit can carry on: the latest reset among
 * the windows that refused it. 0 when the limit isn't what stopped it.
 */
export function limitResetAt(usage, error = "") {
  const refused = usage?.status === "rejected";
  if (!refused && !LIMIT_TEXT.test(String(error || ""))) return 0;
  const times = [];
  if (refused) {
    if (usage.resetsAt) times.push(usage.resetsAt);
    for (const w of [usage.fiveHour, usage.week, usage.single]) if (w?.status === "rejected" && w.resetsAt) times.push(w.resetsAt);
  }
  return times.length ? Math.max(...times) : -1; // -1: the limit, but no time given
}
const LIMIT_TEXT = /hit your (usage )?limit|usage limit reached|limit reached.*resets|out of (extra )?usage/i;

/**
 * The to-do list a tool call changes, for the list shown above the composer.
 * Claude Code has two kinds: TodoWrite sends the whole list each time;
 * TaskCreate adds one task (its number comes back in the result) and
 * TaskUpdate changes one by number.
 */
export function toolTodo(name, input) {
  const i = input || {};
  if (name === "TodoWrite" && Array.isArray(i.todos)) {
    return { todos: i.todos.slice(0, 50).map((t) => ({ text: String(t.content || t.activeForm || "").slice(0, 200), status: String(t.status || "pending") })) };
  }
  if (name === "TaskCreate") return { task: { text: String(i.subject || i.description || "").slice(0, 200) } };
  if (name === "TaskUpdate" && i.taskId != null) {
    return { taskUpdate: { id: String(i.taskId), ...(i.status ? { status: String(i.status) } : {}), ...(i.subject ? { text: String(i.subject).slice(0, 200) } : {}) } };
  }
  return null;
}

const DETAIL_MAX = 4000;

/** The tool's input, shown when its line is opened. */
export function toolDetail(input) {
  if (!input || typeof input !== "object") return "";
  if (typeof input.command === "string") return input.command.slice(0, DETAIL_MAX);
  const s = JSON.stringify(input, null, 2);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) + "\n…" : s;
}

const PREVIEW_HEAD = 1000, PREVIEW_TAIL = 800;

/**
 * A tool's result, its start and end when it's long; the page shows it under
 * the line. The end is kept because that's where a test run prints its
 * summary and a command its error, which the turn's receipt reads.
 */
export function resultPreview(content) {
  let s = "";
  if (typeof content === "string") s = content;
  else if (Array.isArray(content)) s = content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  return s.length > PREVIEW_HEAD + PREVIEW_TAIL ? s.slice(0, PREVIEW_HEAD) + "\n…\n" + s.slice(-PREVIEW_TAIL) : s;
}
