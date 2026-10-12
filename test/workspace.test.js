const test = require("node:test");
const assert = require("node:assert/strict");
const { belongsToWorkspace } = require("../sources");

const workspace = "/Users/moumoumou/workspace/agent-sessions";

test("a session in this workspace belongs to it", () => {
  assert.equal(belongsToWorkspace(workspace, [workspace]), true);
  assert.equal(belongsToWorkspace(`${workspace}/pkg`, [workspace]), true);
});

test("a session in the parent directory does not belong to this workspace", () => {
  assert.equal(belongsToWorkspace("/Users/moumoumou/workspace", [workspace]), false);
  assert.equal(belongsToWorkspace("/Users/moumoumou/workspace/genshin-tool", [workspace]), false);
});
