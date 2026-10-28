import { test } from "node:test";
import assert from "node:assert/strict";
import { safeName, isUpload, buildContent, IMAGE_INLINE_MAX } from "../server/attachments.js";

const read = () => Buffer.from("PNGDATA");

test("text alone stays plain text", () => {
  assert.equal(buildContent("Hello", [], read), "Hello");
});

test("an image goes in as an image block, before the text", () => {
  const c = buildContent("What's wrong here?", [{ path: "/u/a.png", name: "a.png", type: "image/png", size: 100 }], read);
  assert.equal(c[0].type, "image");
  assert.equal(c[0].source.media_type, "image/png");
  assert.equal(c[0].source.data, Buffer.from("PNGDATA").toString("base64"));
  assert.deepEqual(c[1], { type: "text", text: "What's wrong here?" });
});

test("an image alone still says something", () => {
  const c = buildContent("", [{ path: "/u/a.png", name: "a.png", type: "image/png", size: 10 }], read);
  assert.equal(c[1].text, "See the attached image.");
});

test("other files, and images too big to send, go in as paths", () => {
  const c = buildContent("Summarise", [
    { path: "/u/notes.pdf", name: "notes.pdf", type: "application/pdf", size: 10 },
    { path: "/u/huge.png", name: "huge.png", type: "image/png", size: IMAGE_INLINE_MAX + 1 },
  ], read);
  assert.equal(typeof c, "string");
  assert.match(c, /notes\.pdf: \/u\/notes\.pdf/);
  assert.match(c, /huge\.png: \/u\/huge\.png/);
});

test("saved names can't climb out of the uploads folder", () => {
  assert.equal(safeName("../../etc/passwd"), "passwd");
  assert.equal(safeName("Screen Shot 2026.png"), "Screen Shot 2026.png");
  assert.equal(safeName("...hidden"), "hidden");
  assert.ok(isUpload("/d/uploads/x.png", "/d/uploads"));
  assert.ok(!isUpload("/d/uploads/../state.json", "/d/uploads"));
  assert.ok(!isUpload("/etc/passwd", "/d/uploads"));
});
