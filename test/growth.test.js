const test = require("node:test");
const assert = require("node:assert/strict");
const { hasConversationEntries } = require("../sources");

test("a process exit record is not a new reply", () => {
  const entries = [
    {
      type: "custom",
      customType: "session_exit",
      data: { reason: "sigterm" },
    },
  ];
  assert.equal(hasConversationEntries("omp", entries), false);
});

test("an assistant message is a conversation update", () => {
  const entries = [
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
  ];
  assert.equal(hasConversationEntries("omp", entries), true);
});

test("a title update is not a conversation update", () => {
  assert.equal(hasConversationEntries("omp", [{ type: "title", title: "renamed" }]), false);
  assert.equal(hasConversationEntries("claude", [{ type: "ai-title", aiTitle: "renamed" }]), false);
});

test("tool activity still counts as conversation", () => {
  assert.equal(
    hasConversationEntries("omp", [{ type: "custom", customType: "tool_execution_start", data: { toolCallId: "1" } }]),
    true,
  );
  assert.equal(hasConversationEntries("claude", [{ type: "user", message: { content: [{ type: "tool_result" }] } }]), true);
});
