function isDisposedError(error) {
  return Boolean(error && /disposed/i.test(String(error.message || error)));
}

function panelIsOpen(panel) {
  if (!panel) return false;
  try {
    void panel.webview;
    return true;
  } catch (error) {
    if (isDisposedError(error)) return false;
    throw error;
  }
}

function releaseClosedPanel(release, cleanup) {
  try {
    cleanup();
  } catch (error) {
    if (!isDisposedError(error)) throw error;
  } finally {
    release();
  }
}

module.exports = { panelIsOpen, releaseClosedPanel };
