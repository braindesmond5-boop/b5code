import { test } from "node:test";
import assert from "node:assert/strict";
import { highlight, languageOf } from "../web/highlight.js";

// The marked pieces, as "class:text", for readable assertions.
const marks = (html) => [...html.matchAll(/<span class="hl-(\w)">([^<]*)<\/span>/g)].map((m) => `${m[1]}:${m[2].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")}`);
const plain = (html) => html.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

test("JavaScript: keywords, strings, numbers, comments, calls, types", () => {
  const code = 'const n = 42; // the answer\nif (n > 1) return fetchPlan("a\\"b", new Map());';
  const m = marks(highlight(code, "js"));
  for (const x of ["k:const", "n:42", "c:// the answer", "k:if", "k:return", "f:fetchPlan", 's:"a\\"b"', "k:new", "t:Map"]) assert.ok(m.includes(x), x);
  assert.equal(plain(highlight(code, "js")), code, "the text itself is unchanged");
});

test("Python, shell, SQL and JSON", () => {
  assert.ok(marks(highlight('@dataclass\ndef go(x=None):\n    """doc"""\n    return True', "python")).join("|").includes("f:@dataclass|k:def|f:go|l:None|s:\"\"\"doc\"\"\"|k:return|l:True"));
  const sh = marks(highlight('echo "$HOME" # where\nexport PATH=${PATH}:/x', "bash"));
  for (const x of ['s:"$HOME"', "c:# where", "k:export", "a:${PATH}"]) assert.ok(sh.includes(x), x);
  const sql = marks(highlight("SELECT id FROM goals WHERE done = false -- open ones", "sql"));
  for (const x of ["k:SELECT", "k:FROM", "k:WHERE", "l:false", "c:-- open ones"]) assert.ok(sql.includes(x), x);
  const json = marks(highlight('{"name": "B5", "on": true, "n": 3}', "json"));
  for (const x of ['a:"name"', 's:"B5"', "l:true", "n:3"]) assert.ok(json.includes(x), x);
});

test("HTML and CSS", () => {
  const h = marks(highlight('<a href="/x" class=\'y\'>hi</a><!-- note -->', "html"));
  for (const x of ["k:<a", "a:href", 's:"/x"', "k:</a", "c:<!-- note -->"]) assert.ok(h.includes(x), x);
  const c = marks(highlight(".hero { color: #4b49d6; margin: 0 8px; } @media (x) {}", "css"));
  for (const x of ["a:color", "n:#4b49d6", "n:8px", "k:@media"]) assert.ok(c.includes(x), x);
});

test("unknown languages are only escaped, and nothing unescaped gets through", () => {
  assert.equal(highlight("<b>&</b>", "klingon"), "&lt;b&gt;&amp;&lt;/b&gt;");
  for (const lang of ["js", "python", "bash", "sql", "html", "css", "json"]) {
    assert.doesNotMatch(highlight('<img src=x onerror="alert(1)">', lang).replace(/<\/?span[^>]*>/g, ""), /<img/, lang);
  }
});

test("languages from code-block tags and file names", () => {
  assert.equal(languageOf("tsx"), "c");
  assert.equal(languageOf("src/app/page.tsx"), "c");
  assert.equal(languageOf("Dockerfile"), "sh");
  assert.equal(languageOf("migration.sql"), "sql");
  assert.equal(languageOf("notes"), null);
});
