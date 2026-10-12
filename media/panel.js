const vscode = acquireVsCodeApi();
const PATH_SEGMENT = "(?:[A-Za-z0-9_]|\\.[A-Za-z0-9_])[A-Za-z0-9._+-]*";
const RELATIVE_PATH = `(?<![\\w./])(?:\\.\\./|\\./)?(?:${PATH_SEGMENT}/)+${PATH_SEGMENT}\\.[A-Za-z0-9]{1,12}(?::\\d+){0,2}`;
const ABSOLUTE_PATH = `(?<![\\w.])/(?:${PATH_SEGMENT}/)+${PATH_SEGMENT}`;
const state = {
  sessions: [],
  source: "all",
  scope: "workspace",
  activity: "all",
  query: "",
  find: "",
  hit: 0,
  selected: "",
  transcript: null,
  canReply: false,
  replying: false,
  diffMode: "split",
  diffData: null,
  showHidden: false,
};

const listEl = document.querySelector("#list");
const attentionEl = document.querySelector("#attention");
const threadEl = document.querySelector("#thread");
const titleEl = document.querySelector("#title");
const metaEl = document.querySelector("#meta");
const searchEl = document.querySelector("#search");
const findEl = document.querySelector("#find");
const findCountEl = document.querySelector("#find-count");
const jumpEl = document.querySelector("#jump");
const filesEl = document.querySelector("#files");
const diffView = document.querySelector("#diffview");
const replyForm = document.querySelector("#reply");
const replyText = document.querySelector("#reply-text");
const replyNotice = document.querySelector("#reply-notice");
const replySend = document.querySelector("#reply-send");

document.querySelector("#refresh").addEventListener("click", () => {
  vscode.postMessage({ type: "refresh" });
});

bindInputSelectAll();

searchEl.addEventListener("input", () => {
  state.query = searchEl.value.trim().toLowerCase();
  renderList();
});

findEl.addEventListener("input", () => {
  state.find = findEl.value;
  state.hit = 0;
  if (state.transcript) renderThread("find");
});

findEl.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  moveHit(event.shiftKey ? -1 : 1);
});

document.querySelector("#find-prev").addEventListener("click", () => moveHit(-1));
document.querySelector("#find-next").addEventListener("click", () => moveHit(1));

jumpEl.addEventListener("click", () => {
  threadEl.scrollTop = threadEl.scrollHeight;
  updateJump();
});

threadEl.addEventListener("scroll", () => updateJump());

for (const button of document.querySelectorAll("[data-source]")) {
  button.addEventListener("click", () => {
    state.source = button.dataset.source;
    setActive("[data-source]", button);
    renderList();
  });
}

for (const button of document.querySelectorAll("[data-scope]")) {
  button.addEventListener("click", () => {
    state.scope = button.dataset.scope;
    setActive("[data-scope]", button);
    renderList();
  });
}

for (const button of document.querySelectorAll("[data-activity]")) {
  button.addEventListener("click", () => setActivity(button.dataset.activity));
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message) return;
  if (message.type === "selectAll") {
    selectFocusedField();
    return;
  }
  if (message.type === "sessions") {
    state.sessions = message.sessions;
    renderList();
    return;
  }
  if (message.type === "transcript") {
    const switched = message.key !== state.selected;
    if (switched && !message.live) {
      replyText.value = "";
      state.diffData = null;
      renderDiff();
    }
    state.selected = message.key;
    state.transcript = message.transcript;
    if (message.following != null) state.following = message.following === true;
    if (message.canReply != null) state.canReply = message.canReply === true;
    if (message.replyHint) replyNotice.textContent = message.replyHint;
    renderList();
    renderThread(message.live ? "live" : "open");
    updateReply();
    return;
  }
  if (message.type === "transcriptPatch") {
    applyTranscriptPatch(message);
    return;
  }
  if (message.type === "replyResult") {
    state.replying = false;
    replyNotice.textContent = message.notice || "";
    if (message.ok) replyText.value = "";
    updateReply();
    return;
  }
  if (message.type === "replyState") {
    state.canReply = message.canReply === true;
    if (!state.replying && message.replyHint) replyNotice.textContent = message.replyHint;
    updateReply();
    return;
  }
  if (message.type === "fileDiff") {
    state.diffData = message;
    renderDiff();
    return;
  }
  if (message.type === "closed") {
    state.selected = "";
    state.transcript = null;
    state.diffData = null;
    state.canReply = false;
    titleEl.textContent = "Select a session";
    metaEl.textContent = "";
    threadEl.replaceChildren(el("div", "empty", "Select a session from the list."));
    renderDiff();
    renderList();
    updateReply();
    return;
  }
  if (message.type === "follow") {
    state.following = message.following === true;
    applyMeta();
  }
});

threadEl.addEventListener("click", (event) => {
  const link = event.target.closest("a.link");
  if (!link || !threadEl.contains(link)) return;
  event.preventDefault();
  if (link.dataset.href) vscode.postMessage({ type: "openLink", href: link.dataset.href });
});

filesEl.addEventListener("click", (event) => {
  const link = event.target.closest("a.link");
  if (!link || !filesEl.contains(link)) return;
  event.preventDefault();
  if (link.dataset.href) vscode.postMessage({ type: "openLink", href: link.dataset.href });
});

document.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  const link = linkFromEvent(event);
  if (link) link.href = "#";
}, true);

document.addEventListener("contextmenu", (event) => {
  const link = linkFromEvent(event);
  if (!link) return;
  link.href = link.dataset.copyHref || link.dataset.href || "#";
}, true);

document.addEventListener("copy", (event) => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount || !event.clipboardData) return;
  const range = selection.getRangeAt(0);
  const fragment = range.cloneContents();
  const anchors = fragment.querySelectorAll ? [...fragment.querySelectorAll("a.link")] : [];
  const link = anchors.length ? null : linkNode(range.startContainer);
  if (!anchors.length && !link) return;
  event.preventDefault();
  event.clipboardData.setData("text/plain", selection.toString());
  if (anchors.length) {
    for (const anchor of anchors) anchor.setAttribute("href", anchor.dataset.copyHref || anchor.dataset.href || "#");
    const holder = document.createElement("div");
    holder.append(fragment);
    event.clipboardData.setData("text/html", holder.innerHTML);
    return;
  }
  const url = link.dataset.copyHref || link.dataset.href;
  event.clipboardData.setData("text/html", `<a href="${escapeAttr(url)}">${escapeHtml(selection.toString())}</a>`);
  event.clipboardData.setData("text/uri-list", url);
});

replyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendReply();
});

replyText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    sendReply();
  }
});

replyText.addEventListener("input", updateReply);

vscode.postMessage({ type: "ready" });

function bindInputSelectAll() {
  let blurTimer = 0;
  document.addEventListener("focusin", (event) => {
    if (!isTextField(event.target)) return;
    clearTimeout(blurTimer);
    vscode.postMessage({ type: "inputFocus", focused: true });
  });
  document.addEventListener("focusout", (event) => {
    if (!isTextField(event.target)) return;
    blurTimer = setTimeout(() => {
      if (!isTextField(document.activeElement)) vscode.postMessage({ type: "inputFocus", focused: false });
    }, 0);
  });
  window.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "a") return;
    if (!isTextField(event.target)) return;
    event.preventDefault();
    event.target.select();
  }, true);
}

function isTextField(node) {
  if (!node || node.disabled || node.readOnly) return false;
  if (node.tagName === "TEXTAREA") return true;
  return node.tagName === "INPUT" && /^(text|search|email|url|password|tel|number)$/.test(node.type || "text");
}

function selectFocusedField() {
  if (isTextField(document.activeElement)) document.activeElement.select();
}

function sendReply() {
  const text = replyText.value.trim();
  if (!text || !state.canReply || state.replying) return;
  state.replying = true;
  updateReply();
  replyNotice.textContent = "Sending to the open OMP window…";
  vscode.postMessage({ type: "reply", text });
}

function updateReply() {
  replySend.disabled = !state.canReply || state.replying || !replyText.value.trim();
}

function setActive(selector, button) {
  for (const item of document.querySelectorAll(selector)) item.classList.toggle("active", item === button);
}

function renderList() {
  const query = state.query;
  const matched = state.sessions.filter((session) => {
    if (state.source !== "all" && session.source !== state.source) return false;
    if (state.scope === "workspace" && !session.inWorkspace) return false;
    if (!query) return true;
    return `${session.title} ${session.preview} ${session.project}`.toLowerCase().includes(query);
  });
  const shown = matched.filter((session) => !session.hidden || session.activity === "fresh" || session.activity === "running");
  const hidden = matched.filter((session) => session.hidden && session.activity !== "fresh" && session.activity !== "running");
  const visible = shown.filter((session) => state.activity === "all" || session.activity === state.activity);
  visible.sort((a, b) => activityRank(a) - activityRank(b) || b.mtime - a.mtime);
  hidden.sort((a, b) => b.mtime - a.mtime);
  renderAttention(shown);
  listEl.replaceChildren();
  if (!visible.length) listEl.append(el("div", "empty", emptyLabel()));
  else appendSessionGroups(visible);
  if (!hidden.length) return;
  const toggle = el("button", "hidden-toggle", state.showHidden ? `Hide ${hidden.length} hidden` : `${hidden.length} hidden`);
  toggle.type = "button";
  toggle.addEventListener("click", () => {
    state.showHidden = !state.showHidden;
    renderList();
  });
  listEl.append(toggle);
  if (state.showHidden) appendSessionGroups(hidden);
}

function appendSessionGroups(rows) {
  const groups = new Map();
  for (const session of rows) {
    const items = groups.get(session.source) || [];
    items.push(session);
    groups.set(session.source, items);
  }
  for (const [source, items] of groups) {
    const group = el("section", "group");
    const heading = el("h2");
    heading.append(el("span", `dot ${source}`));
    heading.append(document.createTextNode(`${items[0].sourceLabel} · ${items.length}`));
    group.append(heading);
    for (const session of items) group.append(sessionRow(session));
    listEl.append(group);
  }
}

function sessionRow(session) {
  const row = el("div", `session${session.key === state.selected ? " selected" : ""}`);
  const main = el("button", "session-main");
  main.type = "button";
  const titleRow = el("span", "title-row");
  titleRow.append(el("span", "title", session.title));
  if (session.activity === "running") titleRow.append(el("span", "badge running", "Running"));
  else if (session.activity === "fresh") titleRow.append(el("span", "badge fresh", "New reply"));
  main.append(titleRow);
  main.append(el("span", "meta", `${session.project ? `${session.project} · ` : ""}${when(session.mtime)}`));
  main.addEventListener("click", () => openSessionRow(session));
  const actions = el("div", "session-actions");
  if (session.hidden) actions.append(sessionAction("Restore", () => vscode.postMessage({ type: "unhide", key: session.key })));
  else actions.append(sessionAction("Hide", () => vscode.postMessage({ type: "hide", key: session.key })));
  actions.append(sessionAction("Delete", () => vscode.postMessage({ type: "deleteSession", key: session.key })));
  row.append(main, actions);
  return row;
}

function sessionAction(label, onClick) {
  const button = el("button", "session-action", label);
  button.type = "button";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function openSessionRow(session) {
  if (state.selected !== session.key) {
    state.find = "";
    state.hit = 0;
    findEl.value = "";
    findCountEl.textContent = "";
  }
  state.selected = session.key;
  titleEl.textContent = session.title;
  metaEl.textContent = "Loading…";
  threadEl.replaceChildren(el("div", "empty", "Loading…"));
  updateJump();
  renderList();
  vscode.postMessage({ type: "open", key: session.key });
}

function activityRank(session) {
  if (session.activity === "running") return 0;
  if (session.activity === "fresh") return 1;
  return 2;
}

function setActivity(activity) {
  state.activity = activity;
  const button = document.querySelector(`[data-activity="${activity}"]`);
  if (button) setActive("[data-activity]", button);
  renderList();
}

function emptyLabel() {
  if (state.activity === "fresh") return "No new replies.";
  if (state.activity === "running") return "Nothing running.";
  return "No sessions in this scope.";
}

function renderAttention(shown) {
  const running = shown.filter((session) => session.activity === "running").length;
  const fresh = shown.filter((session) => session.activity === "fresh").length;
  if (!running && !fresh) {
    attentionEl.hidden = true;
    attentionEl.replaceChildren();
    return;
  }
  attentionEl.hidden = false;
  attentionEl.replaceChildren();
  if (running) attentionEl.append(activityBadge("running", `${running} running`));
  if (fresh) attentionEl.append(activityBadge("fresh", `${fresh} new`));
}

function activityBadge(activity, label) {
  const button = el("button", `badge ${activity}${state.activity === activity ? " active" : ""}`, label);
  button.type = "button";
  button.title = activity === "fresh" ? "Show sessions with a new reply" : "Show sessions that are still running";
  button.addEventListener("click", () => setActivity(state.activity === activity ? "all" : activity));
  return button;
}

function applyMeta() {
  const transcript = state.transcript;
  const session = state.sessions.find((item) => item.key === state.selected);
  titleEl.textContent = transcript?.title || session?.title || "Session";
  metaEl.textContent = session
    ? `${session.sourceLabel}${session.project ? ` · ${session.project}` : ""}${state.following ? " · live" : ""}`
    : "";
}

function renderThread(mode) {
  const transcript = state.transcript;
  renderFiles();
  if (!transcript) return;
  const live = mode === "live";
  const nearBottom = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 120;
  const previousScroll = threadEl.scrollTop;
  const openTools = live
    ? [...threadEl.querySelectorAll("details.tool")].map((node) => node.open)
    : [];
  const openThinking = live
    ? [...threadEl.querySelectorAll("details.thinking")].map((node) => node.open)
    : [];
  applyMeta();
  const column = el("div", "column");
  threadEl.replaceChildren(column);
  if (transcript.omitted > 0) column.append(el("div", "note", `${transcript.omitted} earlier messages omitted`));
  if (!transcript.turns.length) {
    column.append(el("div", "empty", "This session has no messages to show."));
    findCountEl.textContent = state.find.trim() ? "No matches" : "";
    updateJump();
    return;
  }
  for (const turn of transcript.turns) column.append(renderTurn(turn));
  [...threadEl.querySelectorAll("details.thinking")].forEach((node, index) => {
    if (openThinking[index]) node.open = true;
  });
  [...threadEl.querySelectorAll("details.tool")].forEach((node, index) => {
    if (openTools[index]) node.open = true;
  });
  const marks = highlightHits(column, state.find.trim());
  const pinToEnd = () => {
    threadEl.scrollTop = threadEl.scrollHeight;
    updateJump();
  };
  if (mode === "find" && marks.length) {
    focusHit(marks, state.hit, true);
    return;
  }
  if (mode === "open") {
    pinToEnd();
    requestAnimationFrame(pinToEnd);
    return;
  }
  if (marks.length) focusHit(marks, state.hit, false);
  if (!nearBottom) {
    threadEl.scrollTop = previousScroll;
    updateJump();
    return;
  }
  pinToEnd();
  requestAnimationFrame(pinToEnd);
}

function renderTurn(turn, previous) {
  if (turn.role === "user") {
    const bubble = el("div", "user");
    appendRichText(bubble, turn.text);
    return bubble;
  }
  const block = el("div", "md");
  if (turn.thinking) {
    const details = document.createElement("details");
    details.className = "thinking";
    details.append(el("summary", "", "Thinking"));
    const thought = el("div", "md");
    renderMarkdown(thought, turn.thinking);
    details.append(thought);
    block.append(details);
  }
  if (turn.text) renderMarkdown(block, turn.text);
  for (const tool of turn.tools || []) block.append(renderTool(tool));
  if (!previous) return block;
  const thinking = block.querySelector("details.thinking");
  if (thinking && previous.querySelector("details.thinking")?.open) thinking.open = true;
  const opened = [...previous.querySelectorAll(":scope > details.tool")];
  [...block.querySelectorAll(":scope > details.tool")].forEach((node, index) => {
    if (opened[index]?.open) node.open = true;
  });
  return block;
}

function applyTranscriptPatch(message) {
  if (message.key !== state.selected || !state.transcript) return;
  const turns = state.transcript.turns.slice(message.dropped || 0);
  for (const update of message.updates || []) {
    if (update.index >= 0 && update.index < turns.length) turns[update.index] = update.turn;
  }
  for (const turn of message.appended || []) turns.push(turn);
  state.transcript = {
    title: message.title || state.transcript.title,
    omitted: message.omitted,
    files: message.files || state.transcript.files,
    turns,
  };
  if (message.following != null) state.following = message.following === true;
  applyMeta();
  if (message.files) renderFiles();
  if (state.find.trim()) {
    renderThread("live");
    return;
  }
  patchThread(message);
}

function patchThread(message) {
  const column = threadEl.querySelector(":scope > .column");
  if (!column) {
    renderThread("live");
    return;
  }
  const nearBottom = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 120;
  const previousScroll = threadEl.scrollTop;
  const note = column.querySelector(":scope > .note");
  if (state.transcript.omitted > 0) {
    const text = `${state.transcript.omitted} earlier messages omitted`;
    if (note) note.textContent = text;
    else column.prepend(el("div", "note", text));
  } else if (note) {
    note.remove();
  }
  const nodes = [...column.children].filter((node) => node.classList.contains("user") || node.classList.contains("md"));
  const dropped = message.dropped || 0;
  if (dropped > nodes.length) {
    renderThread("live");
    return;
  }
  for (let index = 0; index < dropped; index += 1) nodes[index].remove();
  const kept = nodes.slice(dropped);
  for (const update of message.updates || []) {
    const previous = kept[update.index];
    if (!previous) {
      renderThread("live");
      return;
    }
    previous.replaceWith(renderTurn(update.turn, previous));
  }
  for (const turn of message.appended || []) column.append(renderTurn(turn));
  const empty = column.querySelector(":scope > .empty");
  if (state.transcript.turns.length) empty?.remove();
  else if (!empty) column.append(el("div", "empty", "This session has no messages to show."));
  if (nearBottom) {
    const pinToEnd = () => {
      threadEl.scrollTop = threadEl.scrollHeight;
      updateJump();
    };
    pinToEnd();
    requestAnimationFrame(pinToEnd);
    return;
  }
  threadEl.scrollTop = previousScroll;
  updateJump();
}

function highlightHits(root, query) {
  findCountEl.textContent = "";
  if (!query) return [];
  const marks = [];
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const needle = query.toLowerCase();
  for (const node of nodes) {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    if (!lower.includes(needle)) continue;
    const fragment = document.createDocumentFragment();
    let index = 0;
    let found = lower.indexOf(needle);
    while (found >= 0) {
      if (found > index) fragment.append(document.createTextNode(text.slice(index, found)));
      const mark = document.createElement("mark");
      mark.className = "hit";
      mark.textContent = text.slice(found, found + query.length);
      fragment.append(mark);
      marks.push(mark);
      index = found + query.length;
      found = lower.indexOf(needle, index);
    }
    if (index < text.length) fragment.append(document.createTextNode(text.slice(index)));
    node.parentNode.replaceChild(fragment, node);
  }
  marks.forEach((mark) => {
    let parent = mark.parentElement;
    while (parent && parent !== root) {
      if (parent.tagName === "DETAILS") parent.open = true;
      parent = parent.parentElement;
    }
  });
  if (!marks.length) findCountEl.textContent = "No matches";
  return marks;
}

function focusHit(marks, index, reveal) {
  if (!marks.length) return;
  state.hit = (index + marks.length) % marks.length;
  marks.forEach((mark, markIndex) => mark.classList.toggle("current", markIndex === state.hit));
  findCountEl.textContent = `${state.hit + 1}/${marks.length}`;
  if (!reveal) return;
  marks[state.hit].scrollIntoView({ block: "center" });
  updateJump();
}

function moveHit(delta) {
  const marks = [...threadEl.querySelectorAll("mark.hit")];
  if (!marks.length) return;
  focusHit(marks, state.hit + delta, true);
}

function renderFiles() {
  const files = state.transcript?.files || [];
  filesEl.replaceChildren();
  const list = document.createElement("ul");
  for (const file of files) {
    const raw = typeof file === "string" ? file : file.path;
    const href = fileHref(raw);
    if (!href) continue;
    const item = document.createElement("li");
    item.className = "file-row";
    appendAnchor(item, displayPath(raw, href), href);
    const additions = file.additions || 0;
    const deletions = file.deletions || 0;
    if (additions || deletions) {
      item.append(el("span", "add", `+${additions}`));
      item.append(el("span", "del", `-${deletions}`));
    }
    const button = el("button", "diff-btn", "Diff");
    button.type = "button";
    button.addEventListener("click", () => vscode.postMessage({ type: "fileDiff", path: raw }));
    item.append(button);
    list.append(item);
  }
  if (!list.childElementCount) {
    filesEl.hidden = true;
    return;
  }
  filesEl.hidden = false;
  filesEl.append(el("h3", "", "Files changed this turn"));
  filesEl.append(list);
}

function renderDiff() {
  const data = state.diffData;
  diffView.replaceChildren();
  if (!data) {
    diffView.hidden = true;
    return;
  }
  diffView.hidden = false;
  const head = el("div", "diff-head");
  const href = fileHref(data.path);
  head.append(el("span", "diff-title", displayPath(data.path, href || data.path)));
  head.append(el("span", "add", `+${data.additions || 0}`));
  head.append(el("span", "del", `-${data.deletions || 0}`));
  const split = el("button", state.diffMode === "split" ? "mode active" : "mode", "Split");
  const inline = el("button", state.diffMode === "inline" ? "mode active" : "mode", "Inline");
  split.type = "button";
  inline.type = "button";
  split.addEventListener("click", () => {
    state.diffMode = "split";
    renderDiff();
  });
  inline.addEventListener("click", () => {
    state.diffMode = "inline";
    renderDiff();
  });
  const close = el("button", "mode", "Close");
  close.type = "button";
  close.addEventListener("click", () => {
    state.diffData = null;
    renderDiff();
  });
  head.append(split, inline, close);
  diffView.append(head);
  if (!data.hunks || !data.hunks.length) {
    diffView.append(el("p", "diff-empty", "This change has no original text to compare."));
    return;
  }
  for (const hunk of data.hunks) diffView.append(renderHunk(hunk));
}

function renderHunk(hunk) {
  const block = el("section", "hunk");
  block.append(el("h4", "", hunk.title || "Change"));
  if (state.diffMode === "inline") block.append(renderInlineDiff(hunk.lines || []));
  else block.append(renderSplitDiff(hunk.lines || []));
  if (hunk.truncated) block.append(el("p", "diff-empty", "More lines follow. Only the first part is shown."));
  return block;
}

function renderInlineDiff(lines) {
  const body = el("div", "diff-inline");
  for (const line of lines) {
    const row = el("pre", `diff-line ${line.type}`);
    row.textContent = `${line.type === "add" ? "+" : line.type === "del" ? "-" : " "} ${line.text}`;
    body.append(row);
  }
  return body;
}

function renderSplitDiff(lines) {
  const body = el("div", "diff-split");
  for (const row of pairDiffLines(lines)) {
    body.append(diffCell(row.left, row.leftKind));
    body.append(diffCell(row.right, row.rightKind));
  }
  return body;
}

function diffCell(text, kind) {
  const cell = el("pre", `diff-cell ${kind || "empty"}`);
  cell.textContent = text == null ? "" : text;
  return cell;
}

function pairDiffLines(lines) {
  const rows = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.type === "ctx") {
      rows.push({ left: line.text, right: line.text, leftKind: "ctx", rightKind: "ctx" });
      index += 1;
      continue;
    }
    const removed = [];
    const added = [];
    while (index < lines.length && lines[index].type === "del") removed.push(lines[index++].text);
    while (index < lines.length && lines[index].type === "add") added.push(lines[index++].text);
    const count = Math.max(removed.length, added.length);
    for (let row = 0; row < count; row += 1) {
      rows.push({
        left: removed[row] ?? null,
        right: added[row] ?? null,
        leftKind: removed[row] == null ? "empty" : "del",
        rightKind: added[row] == null ? "empty" : "add",
      });
    }
  }
  return rows;
}

function fileHref(raw) {
  if (raw.startsWith("~/")) {
    const home = homeDir();
    if (!home) return "";
    return joinPath(home, raw.slice(2));
  }
  if (raw.startsWith("/")) return raw;
  const cwd = sessionCwd();
  if (!cwd) return "";
  const absolute = joinPath(cwd, raw);
  return absolute.startsWith("/") ? absolute : "";
}

function homeDir() {
  const match = /^\/(?:Users|home)\/[^/]+/.exec(sessionCwd());
  return match ? match[0] : "";
}

function displayPath(raw, href) {
  const cwd = sessionCwd();
  if (cwd && href.startsWith(`${cwd}/`)) return href.slice(cwd.length + 1);
  const home = homeDir();
  if (home && href.startsWith(`${home}/`)) return `~/${href.slice(home.length + 1)}`;
  if (!raw.startsWith("/")) return raw;
  return href;
}

function updateJump() {
  const gap = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight;
  jumpEl.hidden = !(state.transcript && gap > 160);
}

function renderTool(tool) {
  const source = tool.sourceLabel === "OMP" ? "omp" : tool.sourceLabel === "Claude Code" ? "claude" : "cursor";
  const details = document.createElement("details");
  details.className = `tool${tool.isError ? " error" : ""}`;
  const summary = el("summary");
  summary.append(el("span", `who ${source}`, tool.sourceLabel));
  summary.append(el("span", "", tool.name));
  const hint = oneLine(tool.command || tool.input);
  if (hint) summary.append(el("span", "cmd", hint));
  details.append(summary);
  if (tool.output) details.append(richPre(tool.output));
  else if (!tool.command && tool.input) details.append(richPre(tool.input));
  return details;
}

function renderMarkdown(parent, text) {
  const chunks = String(text).split(/```/);
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (index % 2 === 1) {
      const body = chunk.replace(/^[^\n]*\n/, "");
      parent.append(richPre(body.replace(/\n$/, "")));
      continue;
    }
    renderProse(parent, chunk);
  }
}

function renderProse(parent, text) {
  const lines = text.replace(/\n+$/, "").split("\n");
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(lines[index]);
    if (heading) {
      const node = el(heading[1].length > 1 ? "h4" : "h3");
      appendInline(node, heading[2]);
      parent.append(node);
      index += 1;
      continue;
    }
    if (isTableStart(lines, index)) {
      index = renderTable(parent, lines, index);
      continue;
    }
    if (isQuoteLine(lines[index])) {
      const quote = el("blockquote");
      const body = [];
      while (index < lines.length && isQuoteLine(lines[index])) {
        body.push(lines[index].replace(/^\s{0,3}>\s?/, ""));
        index += 1;
      }
      renderProse(quote, body.join("\n"));
      parent.append(quote);
      continue;
    }
    if (/^[-*]\s+/.test(lines[index])) {
      const list = el("ul", "md-list");
      while (index < lines.length && /^[-*]\s+/.test(lines[index])) {
        const item = el("li");
        appendInline(item, lines[index].replace(/^[-*]\s+/, ""));
        list.append(item);
        index += 1;
      }
      parent.append(list);
      continue;
    }
    if (/^\d+\.\s+/.test(lines[index])) {
      const list = el("ol", "md-list");
      while (index < lines.length && /^\d+\.\s+/.test(lines[index])) {
        const item = el("li");
        appendInline(item, lines[index].replace(/^\d+\.\s+/, ""));
        list.append(item);
        index += 1;
      }
      parent.append(list);
      continue;
    }
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !/^(#{1,3})\s+/.test(lines[index]) && !/^[-*]\s+/.test(lines[index]) && !/^\d+\.\s+/.test(lines[index]) && !isTableStart(lines, index) && !isQuoteLine(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    const node = el("p");
    paragraph.forEach((line, lineIndex) => {
      if (lineIndex > 0) node.append(document.createElement("br"));
      appendInline(node, line);
    });
    parent.append(node);
  }
}

function isQuoteLine(line) {
  return /^\s{0,3}>\s?/.test(line);
}

function isTableStart(lines, index) {
  return lines[index].includes("|") && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1]);
}

function renderTable(parent, lines, index) {
  const table = el("table");
  const head = el("tr");
  for (const cell of splitRow(lines[index])) {
    const th = el("th");
    appendInline(th, cell);
    head.append(th);
  }
  table.append(head);
  index += 2;
  let rows = 0;
  while (index < lines.length && lines[index].includes("|") && rows < 30) {
    const tr = el("tr");
    for (const cell of splitRow(lines[index])) {
      const td = el("td");
      appendInline(td, cell);
      tr.append(td);
    }
    table.append(tr);
    index += 1;
    rows += 1;
  }
  parent.append(table);
  return index;
}

function splitRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function appendRichText(parent, text) {
  const lines = String(text).split("\n");
  lines.forEach((line, index) => {
    if (index > 0) parent.append(document.createElement("br"));
    appendInline(parent, line);
  });
}

function richPre(text) {
  const pre = el("pre");
  const lines = String(text).split("\n");
  lines.forEach((line, index) => {
    if (index > 0) pre.append(document.createElement("br"));
    linkifyPlain(pre, line);
  });
  return pre;
}

function appendInline(parent, text) {
  const pattern = new RegExp("(`[^`\\n]+`|\\[[^\\[\\]\\n]+\\]\\([^)\\s]+\\)|\\*\\*[^*\\n]+\\*\\*|https?:\\/\\/[^\\s<>]+|file:\\/\\/[^\\s<>]+|" + ABSOLUTE_PATH + "|" + RELATIVE_PATH + ")", "g");
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith("`")) {
      const code = el("code");
      linkifyPlain(code, token.slice(1, -1));
      parent.append(code);
    } else if (token.startsWith("**")) {
      const strong = el("strong");
      linkifyPlain(strong, token.slice(2, -2));
      parent.append(strong);
    } else if (token.startsWith("[")) {
      const parsed = /^\[([^\[\]\n]+)\]\(([^)\s]+)\)$/.exec(token);
      const href = parsed && normalizeTarget(parsed[2]);
      if (href) appendAnchor(parent, parsed[1], href);
      else parent.append(document.createTextNode(token));
    } else {
      appendBare(parent, token);
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
}

function linkifyPlain(parent, text) {
  const pattern = new RegExp("(https?:\\/\\/[^\\s<>]+|file:\\/\\/[^\\s<>]+|" + ABSOLUTE_PATH + "|" + RELATIVE_PATH + ")", "g");
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
    appendBare(parent, match[0]);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
}

function appendBare(parent, token) {
  const [href, trail] = splitBare(token);
  const target = normalizeTarget(href);
  if (target) appendAnchor(parent, href, target);
  else parent.append(document.createTextNode(href));
  if (trail) parent.append(document.createTextNode(trail));
}

function appendAnchor(parent, label, href) {
  const link = document.createElement("a");
  link.className = "link";
  link.href = "#";
  link.dataset.href = href;
  link.dataset.copyHref = publicHref(href);
  link.title = href;
  link.textContent = label;
  parent.append(link);
}

function linkFromEvent(event) {
  const node = event.target;
  const el = node && node.nodeType === Node.ELEMENT_NODE ? node : node && node.parentElement;
  return el ? el.closest("a.link") : null;
}

function linkNode(node) {
  const el = node && node.nodeType === Node.ELEMENT_NODE ? node : node && node.parentElement;
  return el ? el.closest("a.link") : null;
}

function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function publicHref(target) {
  if (/^https?:\/\//i.test(target) || /^file:\/\//i.test(target)) return target;
  if (target.startsWith("/")) {
    const file = splitLocation(target).file;
    return `file://${file.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
  }
  return target;
}

function splitBare(token) {
  let href = token;
  let trail = "";
  while (href && /[),.;!?，。、）】》>]/.test(href.slice(-1))) {
    trail = href.slice(-1) + trail;
    href = href.slice(0, -1);
  }
  if (href.endsWith(":") && !/:\d+$/.test(href.slice(0, -1))) {
    trail = `:${trail}`;
    href = href.slice(0, -1);
  }
  return [href, trail];
}

function normalizeTarget(raw) {
  const href = String(raw || "").trim();
  if (/^https?:\/\/\S+$/i.test(href)) return href;
  if (/^file:\/\/\S+$/i.test(href)) return href;
  if (href.startsWith("~/")) {
    const home = homeDir();
    if (!home) return "";
    const location = splitLocation(href.slice(2));
    const absolute = joinPath(home, location.file);
    if (!absolute.startsWith("/")) return "";
    if (!location.line) return absolute;
    return location.column > 1 || /:\d+:\d+$/.test(href) ? `${absolute}:${location.line}:${location.column}` : `${absolute}:${location.line}`;
  }
  if (isLocalPath(href)) return href;
  return resolveRelative(href);
}

function sessionCwd() {
  const session = state.sessions.find((item) => item.key === state.selected);
  return session?.cwd && session.cwd.startsWith("/") ? session.cwd : "";
}

function resolveRelative(value) {
  if (!isRelativePath(value)) return "";
  const cwd = sessionCwd();
  if (!cwd) return "";
  const location = splitLocation(value);
  const absolute = joinPath(cwd, location.file);
  if (!absolute.startsWith("/")) return "";
  if (!location.line) return absolute;
  return location.column > 1 || /:\d+:\d+$/.test(value) ? `${absolute}:${location.line}:${location.column}` : `${absolute}:${location.line}`;
}

function isRelativePath(value) {
  const pathOnly = value.replace(/:\d+(?::\d+)?$/, "");
  if (!pathOnly || pathOnly.startsWith("/") || pathOnly.includes("\0")) return false;
  return new RegExp("^(?:\\.\\./|\\./)?(?:" + PATH_SEGMENT + "/)+" + PATH_SEGMENT + "\\.[A-Za-z0-9]{1,12}$").test(pathOnly);
}

function splitLocation(value) {
  const match = /:(\d+)(?::(\d+))?$/.exec(value);
  if (!match || match.index === 0) return { file: value, line: 0, column: 0 };
  return { file: value.slice(0, match.index), line: Number(match[1]), column: Number(match[2] || 1) };
}

function joinPath(cwd, rel) {
  const parts = [];
  for (const part of `${cwd.replace(/\/+$/, "")}/${rel}`.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function isLocalPath(value) {
  const pathOnly = value.replace(/:\d+(?::\d+)?$/, "");
  if (!pathOnly.startsWith("/") || pathOnly.includes("..")) return false;
  if (/^\/(Users|Volumes|private|tmp|home|opt)\//.test(pathOnly)) return true;
  return /\/[^/]+\.[A-Za-z0-9]{1,12}$/.test(pathOnly);
}

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function when(mtime) {
  const delta = Date.now() - mtime;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return "just now";
  if (delta < hour) return `${Math.floor(delta / minute)}m ago`;
  if (delta < day) return `${Math.floor(delta / hour)}h ago`;
  if (delta < 7 * day) return `${Math.floor(delta / day)}d ago`;
  return new Date(mtime).toLocaleDateString();
}
