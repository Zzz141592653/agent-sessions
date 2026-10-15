const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { hasConversationEntries, hasOmpProcess, loadTranscript } = require("../sources");

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

test("hasOmpProcess matches omp and custom omp-* binaries but not unrelated child commands", () => {
  assert.equal(hasOmpProcess("-zsh\nomp\n"), true);
  assert.equal(hasOmpProcess("-zsh\nomp-gemini-test --model vertex-proxy/gemini-4-argon\n"), true);
  assert.equal(hasOmpProcess("/opt/homebrew/bin/omp-gemini-test --resume 123\n"), true);
  assert.equal(hasOmpProcess("-zsh\nnode /Users/me/.omp/plugins/start.mjs\n"), false);
});

test("loadTranscript extracts model, context tokens, total tokens, and cost for omp and claude", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sessions-test-"));
  try {
    const now = new Date();
    const todayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0).toISOString();
    const yesterdayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0).toISOString();
    const ompFile = path.join(dir, "omp.jsonl");
    fs.writeFileSync(
      ompFile,
      [
        JSON.stringify({ type: "model_change", model: "vertex-proxy/gemini-4-argon" }),
        JSON.stringify({
          type: "message",
          timestamp: yesterdayNoon,
          message: {
            role: "assistant",
            provider: "vertex-proxy",
            model: "gemini-4-argon",
            content: [{ type: "text", text: "yesterday" }],
            usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100, cost: { total: 0.12 } },
            contextSnapshot: { promptTokens: 1000 },
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: todayNoon,
          message: {
            role: "assistant",
            provider: "vertex-proxy",
            model: "gemini-4-argon",
            content: [{ type: "text", text: "first" }],
            usage: { input: 1000, output: 200, cacheRead: 4000, cacheWrite: 0, totalTokens: 5200, cost: { total: 0.05 } },
            contextSnapshot: { promptTokens: 5000 },
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: todayNoon,
          message: {
            role: "assistant",
            content: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
            stopReason: "error",
          },
        }),
      ].join("\n") + "\n",
    );
    const ompTranscript = loadTranscript(ompFile, "omp");
    assert.equal(ompTranscript.stats.model, "vertex-proxy/gemini-4-argon");
    assert.equal(ompTranscript.stats.contextTokens, 5000);
    assert.equal(ompTranscript.stats.totalTokens, 6300);
    assert.equal(ompTranscript.stats.cost, 0.17);
    assert.equal(ompTranscript.stats.todayCost, 0.05);
    const claudeFile = path.join(dir, "claude.jsonl");
    fs.writeFileSync(
      claudeFile,
      [
        JSON.stringify({
          type: "assistant",
          requestedModel: "glm-5.3",
          message: {
            id: "msg_1",
            model: "accounts/fireworks/models/glm-5p3",
            content: [{ type: "thinking", thinking: "t" }],
            usage: { input_tokens: 300, cache_read_input_tokens: 1700, cache_creation_input_tokens: 0, output_tokens: 100 },
          },
        }),
        JSON.stringify({
          type: "assistant",
          requestedModel: "glm-5.3",
          message: {
            id: "msg_1",
            model: "accounts/fireworks/models/glm-5p3",
            content: [{ type: "text", text: "hi" }],
            usage: { input_tokens: 300, cache_read_input_tokens: 1700, cache_creation_input_tokens: 0, output_tokens: 100 },
          },
        }),
        JSON.stringify({
          type: "cost-state",
          totalCostUSD: 0.42,
          modelUsage: {
            "glm-5.3": { inputTokens: 300, outputTokens: 100, cacheReadInputTokens: 1700, cacheCreationInputTokens: 0 },
          },
        }),
      ].join("\n") + "\n",
    );
    const claudeTranscript = loadTranscript(claudeFile, "claude");
    assert.equal(claudeTranscript.stats.model, "glm-5.3");
    assert.equal(claudeTranscript.stats.contextTokens, 2000);
    assert.equal(claudeTranscript.stats.totalTokens, 2100);
    assert.equal(claudeTranscript.stats.cost, 0.42);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
