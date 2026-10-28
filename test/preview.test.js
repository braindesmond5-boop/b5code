import { test } from "node:test";
import assert from "node:assert/strict";
import { previewPath, PREVIEW_TYPES } from "../server/preview.js";

const HOME = "/Users/ama";

test("files in the home folder are allowed, with ~ and encoded names", () => {
  assert.equal(previewPath("Users/ama/Desktop/plan.html", HOME, false), "/Users/ama/Desktop/plan.html");
  assert.equal(previewPath("~/Desktop/shots/home%20light.png", HOME, false), "/Users/ama/Desktop/shots/home light.png");
});

test("nothing outside the home folder, however it is spelled", () => {
  assert.equal(previewPath("etc/passwd", HOME, false), null);
  assert.equal(previewPath("Users/ama/../bob/secret.txt", HOME, false), null);
  assert.equal(previewPath("~/../bob/x", HOME, false), null);
  assert.equal(previewPath("Users/amanda/x", HOME, false), null);
  assert.equal(previewPath("%E0%A4%A", HOME, false), null);
});

test("plan pages, screenshots, PDFs and videos have types", () => {
  for (const ext of [".html", ".png", ".jpg", ".pdf", ".mp4", ".svg"]) assert.ok(PREVIEW_TYPES[ext], ext);
});

test("a page can't open hidden or secret files, even in its own folder", async () => {
  const { isPrivate, previewScope } = await import("../server/preview.js");
  for (const p of [".env.local", ".git/config", "sub/.ssh/id_rsa", "id_ed25519", "certs/server.key", "keys/app.pem", "credentials.json", "my-secret-notes.txt", "gcp-service-account.json", "data/app.sqlite"]) {
    assert.equal(isPrivate(p), true, p);
  }
  for (const p of ["plan.html", "img/home.png", "js/app.js", "styles.css", "data/answers.json", "fonts/inter.woff2"]) {
    assert.equal(isPrivate(p), false, p);
  }
  assert.equal(previewScope("/Users/me/proj/.env.local", "/Users/me", false), "/Users/me/proj/.env.local", "opened on purpose, it's shown alone");
  assert.equal(previewScope("/Users/me/.claude/plans/plan.html", "/Users/me", false), "/Users/me/.claude/plans", "a page inside a hidden folder still gets its folder");
});
