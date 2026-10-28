import { test } from "node:test";
import assert from "node:assert/strict";
import { toolParts, needsReview, reviewTools, reviewFields } from "../web/review.js";

test("tools that change something out in the world wait for a yes; reading doesn't", () => {
  const tools = [
    "Bash", "Read", "WebSearch",
    "mcp__claude_ai_Typefully_-_Social_Media_Scheduler__create_draft", "mcp__claude_ai_Typefully_-_Social_Media_Scheduler__list_drafts",
    "mcp__claude_ai_Typefully_-_Social_Media_Scheduler__comments_add_comment_to_thread",
    "mcp__claude_ai_Google_Docs__update_doc", "mcp__claude_ai_Google_Docs__read_doc",
    "mcp__claude_ai_Google_Drive__share_file", "mcp__claude_ai_Google_Drive__trash_file", "mcp__claude_ai_Google_Drive__search_files", "mcp__claude_ai_Google_Drive__download_file_content",
    "mcp__claude_ai_vidIQ__vidiq_reply_to_comment", "mcp__claude_ai_vidIQ__vidiq_video_upload", "mcp__claude_ai_vidIQ__vidiq_keyword_research",
    "mcp__claude_ai_Supabase__apply_migration", "mcp__claude_ai_Supabase__list_tables",
  ];
  assert.deepEqual(reviewTools(tools), [
    "mcp__claude_ai_Google_Docs__update_doc", "mcp__claude_ai_Google_Drive__share_file", "mcp__claude_ai_Google_Drive__trash_file",
    "mcp__claude_ai_Supabase__apply_migration",
    "mcp__claude_ai_Typefully_-_Social_Media_Scheduler__comments_add_comment_to_thread", "mcp__claude_ai_Typefully_-_Social_Media_Scheduler__create_draft",
    "mcp__claude_ai_vidIQ__vidiq_reply_to_comment", "mcp__claude_ai_vidIQ__vidiq_video_upload",
  ]);
  assert.equal(needsReview("Write"), false, "your own files are the Work space's job, not a review");
  assert.deepEqual(toolParts("mcp__claude_ai_Typefully_-_Social_Media_Scheduler__create_draft"), { service: "Typefully", action: "create draft" });
  assert.deepEqual(toolParts("mcp__claude_ai_vidIQ__vidiq_reply_to_comment"), { service: "vidIQ", action: "reply to comment" });
});

test("a request reads as fields: where and who first, what's being sent last, no ids", () => {
  const f = reviewFields({ social_set_id: "123", platforms: { x: { enabled: true, posts: [{ text: "We shipped resumable uploads 🎉\nTry it on movierush.app" }, { text: "Thread 2/2" }] } }, publish_at: "next-free-slot" });
  assert.deepEqual(f.map((x) => x.label), ["X enabled", "Posts 2 text", "Publish at", "Posts 1 text"]);
  assert.equal(f.at(-1).long, true);
  assert.match(f.at(-1).text, /resumable uploads/);
  assert.deepEqual(reviewFields({ fileId: "abc", role: "writer", emailAddress: "chris@example.com" }).map((x) => `${x.label}: ${x.text}`), ["Role: writer", "Email address: chris@example.com"]);
  assert.deepEqual(reviewFields(null), []);
});

test("batch edits, saves, resolving, and acting in your browser wait for a yes too", () => {
  for (const t of ["mcp__claude_ai_Claude_Docs__batch", "mcp__claude_ai_vidIQ__vidiq_bookmarks_save", "mcp__claude_ai_Typefully_-_Social_Media_Scheduler__comments_resolve_thread",
    "mcp__claude-in-chrome__computer", "mcp__claude-in-chrome__form_input", "mcp__claude-in-chrome__javascript_tool"]) assert.ok(needsReview(t), t);
  for (const t of ["mcp__claude-in-chrome__read_page", "mcp__claude-in-chrome__navigate", "mcp__claude-in-chrome__tabs_context_mcp", "mcp__claude_ai_Claude_Docs__read"]) assert.ok(!needsReview(t), t);
});
