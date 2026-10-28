import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown as md } from "../web/markdown.js";

test("nothing in a reply becomes live markup", () => {
  const out = md('<img src=x onerror="alert(1)"> and <script>x</script>');
  assert.ok(!out.includes("<img"));
  assert.ok(!out.includes("<script"));
  assert.ok(out.includes("&lt;script&gt;"));
});

test("links keep only safe schemes", () => {
  assert.ok(md("[ok](https://nodejs.org)").includes('href="https://nodejs.org"'));
  assert.ok(!md("[bad](javascript:alert(1))").includes("href"));
  assert.ok(!md('[q](https://x.com/"onmouseover="a)').includes('"onmouseover'));
});

test("headings, bold, italic and inline code", () => {
  assert.equal(md("## Title"), "<h3>Title</h3>");
  assert.equal(md("**bold** and *it* and `x < y`"), "<p><strong>bold</strong> and <em>it</em> and <code>x &lt; y</code></p>");
});

test("bold inside inline code stays literal", () => {
  assert.equal(md("`**not bold**`"), "<p><code>**not bold**</code></p>");
});

test("fenced code keeps its text exactly, escaped, and coloured by language", () => {
  const out = md("```js\nif (a < b) { x(); }\n```");
  assert.equal(out.replace(/<\/?span[^>]*>/g, ""), '<pre class="code" data-lang="js"><code>if (a &lt; b) { x(); }</code></pre>');
  assert.match(out, /<span class="hl-k">if<\/span>/);
  assert.equal(md("```\n<b>\n```"), '<pre class="code"><code>&lt;b&gt;</code></pre>', "no language: escaped only");
});

test("lists, including nested ones", () => {
  assert.equal(md("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
  assert.equal(md("1. one\n2. two"), "<ol><li>one</li><li>two</li></ol>");
  assert.equal(md("- a\n  - a1\n- b"), "<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul>");
});

test("tables", () => {
  const out = md("| A | B |\n|---|---|\n| 1 | **2** |");
  assert.ok(out.includes("<th>A</th>"));
  assert.ok(out.includes("<td><strong>2</strong></td>"));
});

test("paragraphs keep their line breaks; blank lines split them", () => {
  assert.equal(md("one\ntwo\n\nthree"), "<p>one<br>two</p>\n<p>three</p>");
});

test("quotes and rules", () => {
  assert.equal(md("> said"), "<blockquote><p>said</p></blockquote>");
  assert.equal(md("---"), "<hr>");
});

test("a link to a file on this Mac becomes a preview link, safely", () => {
  assert.equal(md("[plan](~/Desktop/plan.html)"), '<p><a href="#" class="file-link" data-path="~/Desktop/plan.html">plan</a></p>');
  assert.ok(!md('[x](/Users/a/"onclick="b.html)').includes('"onclick'));
});

test("a list that starts indented keeps every item", () => {
  const html = md("  - a\n- b\n- c");
  for (const x of ["a", "b", "c"]) assert.match(html, new RegExp(`<li>${x}`));
});
