// Claude's questions (its AskUserQuestion tool): one to four questions, each with a few options
// and room for your own answer. Claude Code asks B5 Code for permission to use the tool; the
// answer is that permission with `answers` added to the tool's input, keyed by each question's
// text (several picks joined with ", "). Shared by the page, which draws the card, and the
// server, which checks what it's sent. Pure, tested in test/questions.test.js.

export const ASK_TOOL = "AskUserQuestion";

/** The questions in the tool's input, cleaned, or null if it isn't a question. */
export function questionsOf(tool, input) {
  if (tool !== ASK_TOOL || !Array.isArray(input?.questions)) return null;
  const qs = input.questions.filter((q) => q && typeof q.question === "string" && q.question.trim()).slice(0, 4).map((q) => ({
    question: q.question,
    header: typeof q.header === "string" ? q.header : "",
    multiSelect: q.multiSelect === true,
    options: (Array.isArray(q.options) ? q.options : []).filter((o) => o && typeof o.label === "string" && o.label.trim())
      .map((o) => ({ label: o.label, description: typeof o.description === "string" ? o.description : "" })),
  }));
  return qs.length ? qs : null;
}

/**
 * The answers from what was picked: `picks[i]` is { chosen: [labels], other: "your own words" }.
 * null until every question has an answer.
 */
export function answersFrom(questions, picks) {
  const out = {};
  for (const [i, q] of questions.entries()) {
    const p = picks[i] || {};
    const parts = [...(p.chosen || []).filter((l) => q.options.some((o) => o.label === l)), ...(String(p.other || "").trim() ? [String(p.other).trim()] : [])];
    if (!parts.length) return null;
    out[q.question] = (q.multiSelect ? parts : parts.slice(-1)).join(", ");
  }
  return out;
}

/** Answers sent to the server, kept only if they answer exactly these questions, in short text. */
export function cleanAnswers(questions, answers) {
  if (!questions || !answers || typeof answers !== "object") return null;
  const out = {};
  for (const q of questions) {
    const a = answers[q.question];
    if (typeof a !== "string" || !a.trim() || a.length > 4000) return null;
    out[q.question] = a.trim();
  }
  return Object.keys(answers).length === questions.length ? out : null;
}
