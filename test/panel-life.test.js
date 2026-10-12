const test = require("node:test");
const assert = require("node:assert/strict");
const { panelIsOpen, releaseClosedPanel } = require("../panel-life");

function disposedPanel() {
  return {
    get webview() {
      throw new Error("Webview is disposed");
    },
  };
}

test("a closed panel is not reusable", () => {
  assert.equal(panelIsOpen(undefined), false);
  assert.equal(panelIsOpen(disposedPanel()), false);
  assert.equal(panelIsOpen({ webview: {} }), true);
});

test("closing a panel drops it when the disposed webview throws", () => {
  let panel = { id: 1 };
  const closed = disposedPanel();
  releaseClosedPanel(
    () => {
      panel = undefined;
    },
    () => {
      void closed.webview;
    }
  );
  assert.equal(panel, undefined);
});

test("a different cleanup error still drops the closed panel", () => {
  let panel = { webview: {} };
  assert.throws(
    () =>
      releaseClosedPanel(
        () => {
          panel = undefined;
        },
        () => {
          throw new Error("disk full");
        }
      ),
    /disk full/
  );
  assert.equal(panel, undefined);
});
