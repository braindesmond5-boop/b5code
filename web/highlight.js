// Syntax colours for code: one pass over the text, marking comments,
// strings, numbers, keywords, literals, function names, types, and (in
// markup) tags and attributes. Small on purpose; no library. Output is
// escaped HTML with <span class="hl-…"> only. Pure, tested in
// test/highlight.test.js.

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const words = (s) => new Set(s.split(" "));

const C_KEYWORDS = words("break case catch class const continue debugger default delete do else enum export extends finally for from function if import in instanceof interface let new of return static super switch this throw try typeof var void while with yield async await as type implements private public protected readonly declare namespace keyof satisfies abstract override get set " +
  "func fn mut pub struct impl trait use mod match loop where package go defer select chan map range final int string bool float double char long short byte unsigned signed sizeof typedef goto fun val when object data sealed guard protocol extension init deinit throws inout lazy weak some any self Self crate dyn move ref unsafe extern");
const C_LITERALS = words("true false null undefined nil NaN Infinity None True False");
const PY_KEYWORDS = words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self cls print");
const SH_KEYWORDS = words("if then else elif fi for while until do done case esac in function return local export readonly declare unset shift exit set source cd echo printf test eval exec trap wait sudo");
const SQL_KEYWORDS = words("select from where insert into values update set delete create table alter drop index view join left right inner outer full cross on group by order having limit offset as and or not is in exists distinct union all primary key foreign references default returning with begin commit rollback grant revoke policy function returns language security definer invoker enable disable row level using check unique constraint cascade if replace trigger before after for each execute procedure declare case when then else end coalesce count sum avg min max between like ilike asc desc");

// A language's comments, strings and words. Several names lead to each.
const FAMILIES = {
  c: { line: ["//"], block: [["/*", "*/"]], quotes: ['"', "'", "`"], keywords: C_KEYWORDS, literals: C_LITERALS, types: true },
  py: { line: ["#"], quotes: ['"""', "'''", '"', "'"], keywords: PY_KEYWORDS, literals: C_LITERALS, types: true, decorators: true },
  sh: { line: ["#"], quotes: ['"', "'"], keywords: SH_KEYWORDS, literals: words("true false"), vars: true },
  sql: { line: ["--"], block: [["/*", "*/"]], quotes: ["'", '"'], keywords: SQL_KEYWORDS, literals: words("null true false"), nocase: true },
  css: { block: [["/*", "*/"]], quotes: ['"', "'"], keywords: words("important"), literals: new Set(), css: true },
  yaml: { line: ["#"], quotes: ['"', "'"], keywords: new Set(), literals: words("true false null yes no on off"), keys: true },
  json: { quotes: ['"'], keywords: new Set(), literals: words("true false null"), keys: true },
};
const LANGS = {
  js: "c", javascript: "c", jsx: "c", mjs: "c", cjs: "c", ts: "c", typescript: "c", tsx: "c", java: "c", kotlin: "c", kt: "c", swift: "c",
  go: "c", golang: "c", rust: "c", rs: "c", c: "c", h: "c", cpp: "c", "c++": "c", cc: "c", hpp: "c", cs: "c", csharp: "c", dart: "c", php: "c", scala: "c", groovy: "c", gradle: "c",
  py: "py", python: "py", rb: "py", ruby: "py",
  sh: "sh", bash: "sh", zsh: "sh", shell: "sh", console: "sh", shellscript: "sh", dockerfile: "sh", makefile: "sh", env: "sh", toml: "sh", ini: "sh",
  sql: "sql", psql: "sql", postgres: "sql", plpgsql: "sql",
  css: "css", scss: "css", less: "css",
  yaml: "yaml", yml: "yaml",
  json: "json", jsonc: "c", json5: "c",
  html: "html", htm: "html", xml: "html", svg: "html", vue: "html", svelte: "html", astro: "html", plist: "html",
  diff: "diff", patch: "diff",
};

/** The language for a code block's tag or a file's name ("app.tsx" → c). */
export function languageOf(nameOrTag) {
  const s = String(nameOrTag || "").toLowerCase().trim();
  const base = s.split(/[\\/]/).pop();
  if (base === "dockerfile" || base === "makefile") return "sh";
  const ext = base.includes(".") ? base.split(".").pop() : base;
  return LANGS[ext] || LANGS[s] || null;
}

/** Code as escaped HTML with colour spans. An unknown language is just escaped. */
export function highlight(code, lang) {
  const text = String(code ?? "");
  const family = languageOf(lang);
  if (family === "html") return markup(text);
  if (family === "diff") return text.split("\n").map((l) => (/^\+/.test(l) ? span("i", l) : /^-/.test(l) ? span("d", l) : /^@@/.test(l) ? span("c", l) : esc(l))).join("\n");
  const f = FAMILIES[family];
  return f ? scan(text, f) : esc(text);
}

const span = (cls, s) => `<span class="hl-${cls}">${esc(s)}</span>`;

function scan(src, f) {
  let out = "", i = 0;
  const at = (s) => src.startsWith(s, i);
  while (i < src.length) {
    const ch = src[i];
    // Comments
    const block = f.block?.find(([open]) => at(open));
    if (block) {
      const end = src.indexOf(block[1], i + block[0].length);
      const stop = end < 0 ? src.length : end + block[1].length;
      out += span("c", src.slice(i, stop)); i = stop; continue;
    }
    if (f.line?.some((m) => at(m)) && !(f.vars && ch === "#" && i > 0 && /[\w$]/.test(src[i - 1]))) {
      const end = src.indexOf("\n", i);
      const stop = end < 0 ? src.length : end;
      out += span("c", src.slice(i, stop)); i = stop; continue;
    }
    // Strings
    const q = f.quotes.find((m) => at(m));
    if (q) {
      let j = i + q.length;
      const multi = q.length === 3 || q === "`";
      while (j < src.length && !src.startsWith(q, j)) {
        if (src[j] === "\\") j++;
        else if (src[j] === "\n" && !multi) break;
        j++;
      }
      const stop = Math.min(src.length, src.startsWith(q, j) ? j + q.length : j);
      const str = src.slice(i, stop);
      // A JSON or YAML key ("name": …) reads as a key, not a value.
      const isKey = f.keys && /^\s*:/.test(src.slice(stop, stop + 4));
      out += span(isKey ? "a" : "s", str); i = stop; continue;
    }
    // Shell variables: $HOME, ${NAME}, $1
    if (f.vars && ch === "$") {
      const m = /^\$(\{[^}\n]*\}|[A-Za-z_]\w*|[0-9@*#?$!-])/.exec(src.slice(i));
      if (m) { out += span("a", m[0]); i += m[0].length; continue; }
    }
    // Decorators: @dataclass
    if (f.decorators && ch === "@" && /[A-Za-z_]/.test(src[i + 1] || "")) {
      const m = /^@[\w.]+/.exec(src.slice(i));
      out += span("f", m[0]); i += m[0].length; continue;
    }
    // CSS: @rules, #hex colours, property names
    if (f.css) {
      const m = /^(@[\w-]+)|^(#[0-9a-fA-F]{3,8})\b|^([\w-]+)(?=\s*:[^:{};]*[;}\n])/.exec(src.slice(i));
      if (m && (m[1] || m[2] || (m[3] && /[{;\s]$|^$/.test(src.slice(Math.max(0, i - 1), i))))) {
        out += span(m[1] ? "k" : m[2] ? "n" : "a", m[0]); i += m[0].length; continue;
      }
    }
    // Numbers (not inside a word)
    if (/[0-9]/.test(ch) && !/[\w$]/.test(src[i - 1] || "")) {
      const m = /^(0x[0-9a-f_]+|0b[01_]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?)([a-z%]*)/i.exec(src.slice(i));
      out += span("n", m[0]); i += m[0].length; continue;
    }
    // Words
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
      const w = m[0], key = f.nocase ? w.toLowerCase() : w;
      const after = src.slice(i + w.length).match(/^\s*(.)/)?.[1];
      const before = src[i - 1];
      let cls = null;
      if (f.literals.has(key)) cls = "l";
      else if (f.keywords.has(key) && before !== ".") cls = "k";
      else if (f.keys && after === ":" && !f.vars) cls = "a";
      else if (f.types && /^[A-Z][a-z0-9]/.test(w)) cls = "t"; // Map, PlanCard: a type, even when called
      else if (after === "(") cls = "f";
      out += cls ? span(cls, w) : esc(w); i += w.length; continue;
    }
    out += esc(ch); i++;
  }
  return out;
}

// HTML, XML, SVG: comments, tags, attribute names and values.
function markup(src) {
  let out = "", i = 0;
  while (i < src.length) {
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      const stop = end < 0 ? src.length : end + 3;
      out += span("c", src.slice(i, stop)); i = stop; continue;
    }
    const tag = /^<\/?[A-Za-z][\w:.-]*/.exec(src.slice(i));
    if (tag) {
      out += span("k", tag[0]); i += tag[0].length;
      // Inside the tag: attributes until > (strings may hold >).
      while (i < src.length && src[i] !== ">") {
        const attr = /^[\w:@.#-]+/.exec(src.slice(i));
        const str = /^("[^"]*"|'[^']*')/.exec(src.slice(i));
        if (str) { out += span("s", str[0]); i += str[0].length; }
        else if (attr) { out += span("a", attr[0]); i += attr[0].length; }
        else { out += esc(src[i]); i++; }
      }
      if (src[i] === ">") { out += span("k", ">"); i++; }
      continue;
    }
    const next = src.indexOf("<", i + 1);
    const stop = next < 0 ? src.length : next;
    out += esc(src.slice(i, stop)); i = stop;
  }
  return out;
}
