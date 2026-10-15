const vscode = acquireVsCodeApi();
const PATH_SEGMENT = "(?:[A-Za-z0-9_]|\\.[A-Za-z0-9_])[A-Za-z0-9._+-]*";
const RELATIVE_PATH = `(?<![\\w./])(?:\\.\\./|\\./)?(?:${PATH_SEGMENT}/)+${PATH_SEGMENT}\\.[A-Za-z0-9]{1,12}(?::\\d+){0,2}`;
const ABSOLUTE_PATH = `(?<![\\w.~])~?/(?:${PATH_SEGMENT}/)+${PATH_SEGMENT}(?::\\d+){0,2}`;
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
  mascot: {
    ompSrc: "",
    ompIdleSrc: "",
    claudeSrc: "",
    claudeIdleSrc: "",
    hasCustom: false,
    mode: "auto",
    minimized: false,
    x: null,
    bottom: null,
    initialized: false,
    knownSessions: new Map(),
    displayedToday: { omp: 0, claude: 0 },
    toastStacks: { omp: null, claude: null },
    cards: {},
  },
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
const mascotDock = document.querySelector("#mascot-dock");
const mascotMenu = document.querySelector("#mascot-menu");
const diagramEl = document.querySelector("#diagram");
const diagramStage = document.querySelector("#diagram-stage");
const diagramZoomReset = document.querySelector("#diagram-zoom-reset");
const diagramView = { scale: 1, x: 0, y: 0, canvas: null, drag: null };
document.querySelector("#diagram-close")?.addEventListener("click", closeDiagram);
document.querySelector("#diagram-zoom-in")?.addEventListener("click", () => zoomDiagramBy(1.25));
document.querySelector("#diagram-zoom-out")?.addEventListener("click", () => zoomDiagramBy(1 / 1.25));
diagramZoomReset?.addEventListener("click", resetDiagramZoom);
bindDiagramStage();

document.querySelector("#refresh").addEventListener("click", () => {
  vscode.postMessage({ type: "refresh" });
});

bindInputSelectAll();
bindMascotWidget();

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
  if (message.type === "mascotState") {
    applyMascotState(message);
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
    if (message.transcript?.stats) syncSessionStats(message.key, message.transcript.stats);
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
    return `${session.title} ${session.preview} ${session.project} ${session.model || ""}`.toLowerCase().includes(query);
  });
  const shown = matched.filter((session) => !session.hidden || session.activity === "fresh" || session.activity === "running");
  const hidden = matched.filter((session) => session.hidden && session.activity !== "fresh" && session.activity !== "running");
  const visible = shown.filter((session) => state.activity === "all" || session.activity === state.activity);
  visible.sort((a, b) => b.mtime - a.mtime);
  hidden.sort((a, b) => b.mtime - a.mtime);
  renderAttention(shown);
  renderMascots();
  listEl.replaceChildren();
  if (!visible.length) listEl.append(el("div", "empty", emptyLabel()));
  else appendSessions(visible);
  if (!hidden.length) return;
  const toggle = el("button", "hidden-toggle", state.showHidden ? `Hide ${hidden.length} hidden` : `${hidden.length} hidden`);
  toggle.type = "button";
  toggle.addEventListener("click", () => {
    state.showHidden = !state.showHidden;
    renderList();
  });
  listEl.append(toggle);
  if (state.showHidden) appendSessions(hidden);
}

function appendSessions(rows) {
  for (const session of rows) listEl.append(sessionRow(session));
}

function sessionRow(session) {
  const row = el("div", `session${session.key === state.selected ? " selected" : ""}`);
  const main = el("button", "session-main");
  main.type = "button";
  const titleRow = el("span", "title-row");
  const sourceTag = el("span", `source-tag ${session.source}`, session.source === "claude" ? "Claude" : session.sourceLabel);
  sourceTag.title = session.sourceLabel;
  titleRow.append(sourceTag, el("span", "title", session.title));
  if (session.activity === "running") titleRow.append(el("span", "badge running", "Running"));
  else if (session.activity === "fresh") titleRow.append(el("span", "badge fresh", "New reply"));
  main.append(titleRow);
  main.append(el("span", "meta", `${session.project ? `${session.project} · ` : ""}${when(session.mtime)}`));
  const statsText = formatSessionRowStats(session);
  if (statsText) {
    const statsEl = el("span", "stats", statsText);
    statsEl.title = formatSessionStatsTooltip(session);
    main.append(statsEl);
  }
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
  if (!session) {
    metaEl.textContent = "";
    metaEl.title = "";
    return;
  }
  const stats = transcript?.stats || session;
  const parts = [session.sourceLabel];
  if (session.project) parts.push(session.project);
  const model = shortModel(stats?.model || session.model);
  if (model) parts.push(model);
  const ctx = formatContextUsage(stats?.contextTokens ?? session.contextTokens, stats?.contextWindow ?? session.contextWindow, true);
  if (ctx) parts.push(ctx);
  const tok = formatCompactTokens(stats?.totalTokens ?? session.totalTokens);
  if (tok) parts.push(`${tok} tok`);
  const cost = formatUSD(stats?.cost ?? session.cost);
  if (cost) parts.push(cost);
  if (state.following) parts.push("live");
  metaEl.textContent = parts.join(" · ");
  metaEl.title = formatSessionStatsTooltip({ ...session, ...stats });
}

function syncSessionStats(key, stats) {
  if (!stats) return false;
  const session = state.sessions.find((item) => item.key === key);
  if (!session) return false;
  const changed =
    session.model !== stats.model ||
    session.contextTokens !== stats.contextTokens ||
    session.totalTokens !== stats.totalTokens ||
    session.cost !== stats.cost ||
    session.todayCost !== stats.todayCost ||
    session.monthCost !== stats.monthCost ||
    session.turnCount !== stats.turnCount;
  Object.assign(session, stats);
  return changed;
}

function shortModel(model) {
  if (!model || model === "<synthetic>") return "";
  return String(model).trim().split("/").pop();
}

function formatCompactTokens(count) {
  const n = Number(count) || 0;
  if (n <= 0) return "";
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${(k >= 100 ? k.toFixed(0) : k.toFixed(1)).replace(/\.0$/, "")}k`;
  }
  const m = n / 1_000_000;
  return `${(m >= 100 ? m.toFixed(0) : m.toFixed(1)).replace(/\.0$/, "")}M`;
}

function formatContextUsage(contextTokens, contextWindow, detailed) {
  const ctx = formatCompactTokens(contextTokens);
  if (!ctx) return "";
  const win = Number(contextWindow) || 0;
  if (win > 0) {
    if (detailed) {
      const pct = Math.min(999, Math.round((Number(contextTokens) / win) * 100));
      return `ctx ${ctx}/${formatCompactTokens(win)} (${pct}%)`;
    }
  }
  return `ctx ${ctx}`;
}

function formatUSD(cost) {
  const n = Number(cost) || 0;
  if (n <= 0) return "";
  if (n < 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function formatSessionRowStats(session) {
  const parts = [];
  const model = shortModel(session.model);
  if (model) parts.push(model);
  const ctx = formatContextUsage(session.contextTokens, session.contextWindow, false);
  if (ctx) parts.push(ctx);
  const tok = formatCompactTokens(session.totalTokens);
  if (tok) parts.push(`${tok} tok`);
  const cost = formatUSD(session.cost);
  if (cost) parts.push(cost);
  return parts.join(" · ");
}

function formatSessionStatsTooltip(session) {
  const lines = [];
  if (session.model) lines.push(`Model: ${session.model}`);
  if (session.contextTokens > 0) {
    const win = session.contextWindow > 0
      ? ` / ${session.contextWindow.toLocaleString()} (${Math.round((session.contextTokens / session.contextWindow) * 100)}%)`
      : "";
    lines.push(`Context: ${session.contextTokens.toLocaleString()}${win} tokens`);
  }
  if (session.totalTokens > 0) lines.push(`Total tokens: ${session.totalTokens.toLocaleString()}`);
  if (session.cost > 0) lines.push(`Estimated cost: $${session.cost.toFixed(4)}`);
  return lines.join("\n");
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
  renderDiagrams(column);
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
    stats: message.stats || state.transcript.stats,
    turns,
  };
  if (message.following != null) state.following = message.following === true;
  if (message.stats && syncSessionStats(message.key, message.stats)) renderList();
  applyMeta();
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
  renderDiagrams(column);
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
  while (walker.nextNode()) {
    const p = walker.currentNode.parentElement;
    if (p && !p.closest("svg, .table-chart, button")) nodes.push(walker.currentNode);
  }
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
  const candidates = [sessionCwd(), ...state.sessions.map((item) => item.cwd || item.filePath || "")];
  for (const candidate of candidates) {
    const match = /^\/(?:Users|home)\/[^/]+/.exec(candidate);
    if (match) return match[0];
  }
  return "";
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
      const firstNl = chunk.indexOf("\n");
      const lang = (firstNl >= 0 ? chunk.slice(0, firstNl) : "").trim().split(/\s+/)[0].toLowerCase();
      const body = (firstNl >= 0 ? chunk.slice(firstNl + 1) : chunk).replace(/\n$/, "");
      if (lang === "mermaid" || lang === "svg") {
        const pre = el("pre");
        const code = el("code", `language-${lang}`, body);
        pre.append(code);
        parent.append(pre);
      } else {
        parent.append(richPre(body));
      }
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
    if (isHrLine(lines[index])) {
      parent.append(el("hr"));
      index += 1;
      continue;
    }
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(lines[index]);
    if (heading) {
      const level = heading[1].length;
      const node = el(level <= 2 ? "h2" : level === 3 ? "h3" : "h4");
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
    if (parseListMarker(lines[index])) {
      index = renderMdList(parent, lines, index, false);
      continue;
    }
    const paragraph = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !isHrLine(lines[index]) &&
      !/^\s*(#{1,6})\s+/.test(lines[index]) &&
      !parseListMarker(lines[index]) &&
      !isTableStart(lines, index) &&
      !isQuoteLine(lines[index])
    ) {
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

function isHrLine(line) {
  return /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

function parseListMarker(line) {
  if (isHrLine(line)) return null;
  const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line);
  if (bullet) return { indent: bullet[1].length, type: "ul", num: null, text: bullet[3] };
  const ordered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
  if (ordered) return { indent: ordered[1].length, type: "ol", num: Number(ordered[2]), text: ordered[3] };
  return null;
}

function isSpecialBlockLine(lines, idx) {
  const line = lines[idx];
  return isHrLine(line) || /^\s*(#{1,6})\s+/.test(line) || isTableStart(lines, idx);
}

function renderMdList(parent, lines, startIndex, isSub) {
  const first = parseListMarker(lines[startIndex]);
  if (!first) return startIndex + 1;
  const baseIndent = first.indent;
  const listType = first.type;
  const list = el(listType, isSub ? "md-list sub-list" : "md-list");
  if (listType === "ol" && first.num > 1) list.start = first.num;
  let index = startIndex;
  while (index < lines.length) {
    let look = index;
    while (look < lines.length && !lines[look].trim()) look += 1;
    if (look >= lines.length) break;
    const m = parseListMarker(lines[look]);
    if (!m || m.type !== listType || Math.abs(m.indent - baseIndent) > 1) break;
    index = look + 1;
    const item = el("li");
    if (listType === "ol" && Number.isFinite(m.num)) item.value = m.num;
    appendInline(item, m.text);
    let lastText = m.text.trim();
    let afterBlock = false;
    while (index < lines.length) {
      let nextIdx = index;
      while (nextIdx < lines.length && !lines[nextIdx].trim()) nextIdx += 1;
      if (nextIdx >= lines.length) break;
      const cm = parseListMarker(lines[nextIdx]);
      if (cm) {
        if (cm.indent > baseIndent + 1) {
          index = renderMdList(item, lines, nextIdx, true);
          afterBlock = true;
          continue;
        }
        break;
      }
      const qm = /^(\s*)>\s?(.*)$/.exec(lines[nextIdx]);
      if (qm) {
        if (qm[1].length > baseIndent + 1) {
          const quote = el("blockquote");
          const qLines = [];
          while (nextIdx < lines.length) {
            const ql = /^(\s*)>\s?(.*)$/.exec(lines[nextIdx]);
            if (!ql || ql[1].length <= baseIndent + 1) break;
            qLines.push(ql[2]);
            nextIdx += 1;
          }
          renderProse(quote, qLines.join("\n"));
          item.append(quote);
          afterBlock = true;
          index = nextIdx;
          continue;
        }
        break;
      }
      const indent = (lines[nextIdx].match(/^\s*/) || [""])[0].length;
      if (indent > baseIndent + 1 && !isSpecialBlockLine(lines, nextIdx)) {
        const cont = lines[nextIdx].trim();
        if (afterBlock) {
          const p = el("div");
          appendInline(p, cont);
          item.append(p);
          afterBlock = false;
        } else {
          if (/[:：]$/.test(lastText)) item.append(document.createElement("br"));
          else item.append(document.createTextNode(" "));
          appendInline(item, cont);
        }
        lastText = cont;
        index = nextIdx + 1;
        continue;
      }
      break;
    }
    list.append(item);
  }
  parent.append(list);
  return index;
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
  while (index < lines.length && lines[index].includes("|") && rows < 250) {
    if (/^\s*\|?\s*:?-{3,}/.test(lines[index])) {
      index += 1;
      continue;
    }
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

function formatMathInline(raw) {
  return String(raw)
    .replace(/\$\\(?:rightarrow|to)\$/g, "→")
    .replace(/\$\\leftarrow\$/g, "←")
    .replace(/\$\\leftrightarrow\$/g, "↔")
    .replace(/\$\\Rightarrow\$/g, "⇒")
    .replace(/\$\\Leftarrow\$/g, "⇐")
    .replace(/\$\\Leftrightarrow\$/g, "⇔")
    .replace(/\$\\(?:le|leq)\$/g, "≤")
    .replace(/\$\\(?:ge|geq)\$/g, "≥")
    .replace(/\$\\(?:ne|neq)\$/g, "≠")
    .replace(/\$\\approx\$/g, "≈")
    .replace(/\$\\times\$/g, "×")
    .replace(/\$\\pm\$/g, "±");
}

function appendInline(parent, rawText) {
  const text = formatMathInline(rawText);
  const pattern = new RegExp("(<br\\s*\\/?>|&lt;br\\s*\\/?&gt;|`[^`\\n]+`|\\[[^\\[\\]\\n]+\\]\\([^)\\s]+\\)|\\*\\*(?:(?!\\*\\*)[^\\n])+\\*\\*|(?<![\\w*])\\*[^*\\s\\n](?:(?!<br\\s*\\/?>)[^*\\n])*\\*(?![\\w*])|https?:\\/\\/[^\\s<>]+|file:\\/\\/[^\\s<>]+|" + ABSOLUTE_PATH + "|" + RELATIVE_PATH + ")", "gi");
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
    const token = match[0];
    if (/^(?:<br\s*\/?>|&lt;br\s*\/?&gt;)$/i.test(token)) {
      parent.append(document.createElement("br"));
    } else if (token.startsWith("`")) {
      const code = el("code");
      linkifyPlain(code, token.slice(1, -1));
      parent.append(code);
    } else if (token.startsWith("**")) {
      const strong = el("strong");
      appendInline(strong, token.slice(2, -2));
      parent.append(strong);
    } else if (token.startsWith("*")) {
      const em = el("em");
      appendInline(em, token.slice(1, -1));
      parent.append(em);
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
    if (!home) return href;
    const location = splitLocation(href.slice(2));
    const absolute = joinPath(home, location.file);
    if (!absolute.startsWith("/")) return href;
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

function applyMascotState(message) {
  const prefs = message.prefs || {};
  state.mascot.ompSrc = message.ompSrc || state.mascot.ompSrc;
  state.mascot.ompIdleSrc = message.ompIdleSrc || state.mascot.ompIdleSrc || state.mascot.ompSrc;
  state.mascot.claudeSrc = message.claudeSrc || state.mascot.claudeSrc;
  state.mascot.claudeIdleSrc = message.claudeIdleSrc || state.mascot.claudeIdleSrc || state.mascot.claudeSrc;
  state.mascot.hasCustom = message.hasCustom === true;
  if (typeof prefs.mode === "string") state.mascot.mode = prefs.mode;
  if (typeof prefs.minimized === "boolean") state.mascot.minimized = prefs.minimized;
  if (Number.isFinite(prefs.x)) state.mascot.x = prefs.x;
  if (Number.isFinite(prefs.bottom)) {
    state.mascot.bottom = prefs.bottom;
  } else if (Number.isFinite(prefs.y)) {
    state.mascot.bottom = Math.max(8, window.innerHeight - prefs.y - 140);
  }
  renderMascots();
}

function computeSpendSummary() {
  const pool = state.scope === "workspace"
    ? state.sessions.filter((item) => item.inWorkspace)
    : state.sessions;
  const summary = {
    omp: { today: 0, month: 0, count: 0, running: 0, fresh: 0 },
    claude: { today: 0, month: 0, count: 0, running: 0, fresh: 0 },
  };
  for (const session of pool) {
    const bucket = summary[session.source];
    if (!bucket) continue;
    bucket.today += Number(session.todayCost) || 0;
    bucket.month += Number(session.monthCost) || 0;
    bucket.count += 1;
    if (session.activity === "running") bucket.running += 1;
    else if (session.activity === "fresh") bucket.fresh += 1;
  }
  noteSessionTurnToasts(state.sessions);
  return summary;
}

function ensureToastStack(source) {
  if (!state.mascot.toastStacks[source]) {
    state.mascot.toastStacks[source] = el("div", "mascot-toast-stack");
  }
  return state.mascot.toastStacks[source];
}

function formatCallDelta(amount) {
  const n = Number(amount) || 0;
  if (n <= 0) return "";
  if (n < 0.001) return `+$${n.toFixed(4)}`;
  if (n < 0.1) return `+$${n.toFixed(3)}`;
  return `+$${n.toFixed(2)}`;
}

function spawnSpendToast(source, amount, delayMs = 0) {
  const text = formatCallDelta(amount);
  if (!text) return;
  setTimeout(() => {
    const stack = ensureToastStack(source);
    while (stack.children.length >= 5) {
      stack.firstElementChild.remove();
    }
    const toast = el("div", "spend-toast", `↑ ${text}`);
    stack.append(toast);
    const amtEl = mascotDock?.querySelector(`.mascot-card.${source} .amt`);
    if (amtEl) {
      amtEl.classList.add("pulse");
      setTimeout(() => amtEl.classList.remove("pulse"), 700);
    }
    setTimeout(() => {
      toast.classList.add("fading");
    }, 5000);
    setTimeout(() => {
      toast.remove();
    }, 6500);
  }, delayMs);
}

function noteSessionTurnToasts(allSessions) {
  if (!allSessions || !allSessions.length) return;
  const known = state.mascot.knownSessions;
  if (!state.mascot.initialized) {
    for (const session of allSessions) {
      known.set(session.key, {
        turnCount: Number(session.turnCount) || 0,
        todayCost: Number(session.todayCost) || 0,
      });
    }
    state.mascot.initialized = true;
    return;
  }
  const queued = { omp: [], claude: [] };
  for (const session of allSessions) {
    const source = session.source;
    if (source !== "omp" && source !== "claude") continue;
    const turnCount = Number(session.turnCount) || 0;
    const todayCost = Number(session.todayCost) || 0;
    const prev = known.get(session.key);
    if (!prev) {
      const recent = Array.isArray(session.recentTurnCosts) ? session.recentTurnCosts : [];
      if (recent.length) queued[source].push(...recent);
      else if (todayCost >= 0.0002) queued[source].push(todayCost);
    } else {
      const addedTurns = turnCount - prev.turnCount;
      const recent = Array.isArray(session.recentTurnCosts) ? session.recentTurnCosts : [];
      if (addedTurns > 0 && recent.length > 0) {
        const slice = recent.slice(-Math.min(addedTurns, recent.length));
        queued[source].push(...slice);
      } else if (todayCost - prev.todayCost >= 0.0002) {
        queued[source].push(todayCost - prev.todayCost);
      }
    }
    known.set(session.key, { turnCount, todayCost });
  }
  for (const source of ["omp", "claude"]) {
    queued[source].forEach((amt, idx) => {
      spawnSpendToast(source, amt, idx * 220);
    });
  }
}
function visibleMascotSources() {
  const mode = state.mascot.mode || "auto";
  if (mode === "omp") return ["omp"];
  if (mode === "claude") return ["claude"];
  if (mode === "both") return ["omp", "claude"];
  const selected = state.sessions.find((item) => item.key === state.selected);
  if (selected && (selected.source === "omp" || selected.source === "claude")) return [selected.source];
  if (state.source === "omp" || state.source === "claude") return [state.source];
  return [state.sessions[0]?.source === "claude" ? "claude" : "omp"];
}

function formatSpendAmount(amount) {
  const n = Number(amount) || 0;
  if (n <= 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function ensureMascotCard(source) {
  let refs = state.mascot.cards[source];
  if (refs) return refs;
  const label = source === "omp" ? "OMP" : "Claude";
  const card = el("div", `mascot-card ${source}`);
  const toastStack = ensureToastStack(source);
  const bubble = el("div", "mascot-bubble");
  const mainLine = el("div", "mascot-bubble-main");
  const amtSpan = el("span", `amt ${source}`, "$0.00");
  mainLine.append(document.createTextNode(`${label} Today `), amtSpan);
  const subLine = el("div", "mascot-bubble-sub", "Month $0.00");
  const statusEl = el("div", "mascot-status", "Idle");
  bubble.append(toastStack, mainLine, subLine, statusEl);
  const img = document.createElement("img");
  img.className = "mascot-avatar";
  img.alt = `${label} mascot`;
  img.draggable = false;
  card.append(bubble, img);
  refs = { card, bubble, amtSpan, subLine, statusEl, img, currentSrc: "" };
  state.mascot.cards[source] = refs;
  return refs;
}

function renderMascots() {
  if (!mascotDock) return;
  const hasAnySrc = Boolean(state.mascot.ompSrc || state.mascot.claudeSrc);
  if (!hasAnySrc) {
    mascotDock.hidden = true;
    return;
  }
  mascotDock.hidden = false;
  const spend = computeSpendSummary();
  const scopeLabel = state.scope === "workspace" ? "this workspace" : "all workspaces";
  if (state.mascot.minimized) {
    const totalToday = spend.omp.today + spend.claude.today;
    const pill = el("button", "mascot-pill");
    pill.type = "button";
    pill.title = `Click to expand · Right-click to customize (${scopeLabel})`;
    pill.append(
      document.createTextNode("Today "),
      el("span", "amt omp", formatSpendAmount(totalToday)),
    );
    pill.addEventListener("click", () => {
      if (mascotDock.dataset.dragged === "1") return;
      state.mascot.minimized = false;
      saveMascotPrefs({ minimized: false });
      renderMascots();
    });
    mascotDock.replaceChildren(pill);
    applyMascotPosition();
    return;
  }
  let gear = mascotDock.querySelector(":scope > .mascot-gear");
  let row = mascotDock.querySelector(":scope > .mascot-row");
  if (!gear || !row) {
    gear = el("button", "mascot-gear", "⚙");
    gear.type = "button";
    gear.title = "Customize mascot (or right-click)";
    gear.addEventListener("click", (event) => {
      event.stopPropagation();
      const rect = gear.getBoundingClientRect();
      openMascotMenu(rect.left, rect.top);
    });
    row = el("div", "mascot-row");
    mascotDock.replaceChildren(gear, row);
  }
  const sources = visibleMascotSources();
  const selected = state.sessions.find((item) => item.key === state.selected);
  const desiredCards = [];
  for (const source of sources) {
    const info = spend[source] || { today: 0, month: 0, count: 0, running: 0, fresh: 0 };
    const isBusy = info.running > 0 || Boolean(selected && selected.source === source && selected.activity === "running");
    const thinkingSrc = source === "omp" ? state.mascot.ompSrc : state.mascot.claudeSrc;
    const idleSrc = source === "omp" ? (state.mascot.ompIdleSrc || thinkingSrc) : (state.mascot.claudeIdleSrc || thinkingSrc);
    const src = isBusy ? thinkingSrc : idleSrc;
    if (!src) continue;
    const label = source === "omp" ? "OMP" : "Claude";
    const refs = ensureMascotCard(source);
    const moodText = isBusy
      ? (info.running > 1 ? `Thinking (${info.running} running)` : "Thinking…")
      : "Idle";
    refs.card.title = `${label} · ${moodText} (${scopeLabel})\nToday: $${info.today.toFixed(4)}\nThis month: $${info.month.toFixed(4)}\nDrag to move · Right-click to customize`;
    animateSpendValue(source, refs.amtSpan, info.today);
    refs.subLine.textContent = `Month ${formatSpendAmount(info.month)}`;
    const statusParts = [];
    if (info.running > 1) statusParts.push(`Thinking · ${info.running} running`);
    else if (isBusy) statusParts.push("Thinking…");
    if (info.fresh > 0) statusParts.push(`${info.fresh} new ${info.fresh === 1 ? "reply" : "replies"}`);
    if (statusParts.length) {
      refs.statusEl.className = `mascot-status ${isBusy ? "running" : "fresh"}`;
      refs.statusEl.textContent = statusParts.join(" · ");
    } else {
      refs.statusEl.className = "mascot-status";
      refs.statusEl.textContent = "Idle";
    }
    if (refs.currentSrc !== src) {
      refs.currentSrc = src;
      refs.img.src = src;
    }
    desiredCards.push(refs.card);
  }
  const currentChildren = [...row.children];
  if (
    currentChildren.length !== desiredCards.length ||
    currentChildren.some((node, idx) => node !== desiredCards[idx])
  ) {
    row.replaceChildren(...desiredCards);
  }
  applyMascotPosition();
}

function animateSpendValue(source, element, targetValue) {
  const target = Number(targetValue) || 0;
  const prev = state.mascot.displayedToday[source];
  state.mascot.displayedToday[source] = target;
  if (!(prev > 0) || Math.abs(target - prev) < 0.0005 || target < prev) {
    element.textContent = formatSpendAmount(target);
    return;
  }
  const start = performance.now();
  const duration = 650;
  element.classList.add("pulse");
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const current = prev + (target - prev) * eased;
    element.textContent = formatSpendAmount(current);
    if (t < 1 && element.isConnected) {
      requestAnimationFrame(step);
    } else if (element.isConnected) {
      element.textContent = formatSpendAmount(target);
      setTimeout(() => element.classList.remove("pulse"), 250);
    }
  };
  requestAnimationFrame(step);
}

let diagramSeq = 0;

function attachZoomButton(host, getSvg) {
  const zoom = el("button", "mermaid-zoom", "Full screen");
  zoom.type = "button";
  zoom.addEventListener("click", () => openDiagram(typeof getSvg === "function" ? getSvg() : getSvg));
  const showZoom = (event) => {
    const top = event.clientY - host.getBoundingClientRect().top;
    zoom.classList.toggle("is-visible", top <= 44 || zoom.contains(event.target));
  };
  host.addEventListener("mousemove", showZoom);
  host.addEventListener("mouseleave", () => zoom.classList.remove("is-visible"));
  host.append(zoom);
}

function renderSvgBlocks(root) {
  const blocks = [...root.querySelectorAll("pre > code.language-svg")];
  for (const code of blocks) {
    const pre = code.parentElement;
    if (!pre || pre.dataset.svgRendered === "1") continue;
    pre.dataset.svgRendered = "1";
    const raw = (code.textContent || "").trim();
    if (!raw.startsWith("<svg")) continue;
    const safe = raw.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\son\w+\s*=/gi, " data-noop=");
    const host = el("div", "mermaid");
    host.innerHTML = safe;
    const svg = host.querySelector("svg");
    if (!svg) continue;
    svg.removeAttribute("height");
    svg.style.width = "100%";
    svg.style.height = "auto";
    svg.style.maxWidth = "none";
    attachZoomButton(host, svg);
    pre.replaceWith(host);
  }
}

function renderDiagrams(root) {
  if (!root) return;
  renderSvgBlocks(root);
  renderTableCharts(root);
  if (!window.mermaid) return;
  const blocks = [...root.querySelectorAll("pre > code.language-mermaid")];
  if (!blocks.length) return;
  if (!renderDiagrams.ready) {
    const color = getComputedStyle(document.body).backgroundColor;
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    const lum = match ? (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255 : 1;
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: "antiscript",
      htmlLabels: true,
      fontFamily: getComputedStyle(document.body).fontFamily || "sans-serif",
      theme: lum < 0.5 ? "dark" : "default",
    });
    renderDiagrams.ready = true;
  }
  blocks.forEach((code) => {
    const pre = code.parentElement;
    if (!pre || pre.dataset.mermaidRendered === "1") return;
    pre.dataset.mermaidRendered = "1";
    const source = code.textContent || "";
    const id = `chat_mmd_${++diagramSeq}`;
    window.mermaid.render(id, source).then((result) => {
      if (!pre.isConnected) return;
      const host = el("div", "mermaid");
      host.innerHTML = result.svg;
      const svg = host.querySelector("svg");
      if (svg) {
        svg.removeAttribute("height");
        svg.style.width = "100%";
        svg.style.height = "auto";
        svg.style.maxWidth = "none";
      }
      const zoom = el("button", "mermaid-zoom", "Full screen");
      zoom.type = "button";
      zoom.addEventListener("click", () => openDiagram(svg));
      const showZoom = (event) => {
        const top = event.clientY - host.getBoundingClientRect().top;
        zoom.classList.toggle("is-visible", top <= 44 || zoom.contains(event.target));
      };
      host.addEventListener("mousemove", showZoom);
      host.addEventListener("mouseleave", () => zoom.classList.remove("is-visible"));
      host.append(zoom);
      pre.replaceWith(host);
    }).catch(() => {
      if (!pre.isConnected) return;
      pre.classList.add("mermaid-error");
    });
  });
}

let chartSeq = 0;

function shortCategoryLabel(raw) {
  const base = String(raw || "").replace(/\s*[（(].*$/, "").trim() || String(raw || "").trim();
  return base.length > 18 ? `${base.slice(0, 16)}…` : base;
}

function parseMetricCell(cellEl) {
  if (!cellEl || cellEl.querySelector("br")) return null;
  const raw = (cellEl.textContent || "").trim();
  const stripped = raw.replace(/\s*[（(][^）)]*[）)]\s*$/g, "").trim();
  const match = /^([+-]?\d[\d,]*(?:\.\d+)?)\s*([%a-zA-Z\u4e00-\u9fa5/]{0,6})$/.exec(stripped);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = match[2] ? (match[1].length + match[2].length === stripped.length ? match[2] : ` ${match[2]}`) : "";
  return { value, unit, display: stripped };
}

function extractTableSeries(table) {
  const allRows = [...table.querySelectorAll("tr")];
  if (allRows.length < 4 || allRows.length > 25) return null;
  const headers = [...allRows[0].querySelectorAll("th, td")].map((c) => (c.textContent || "").trim());
  const bodyRows = allRows.slice(1).filter((tr) => tr.querySelector("td"));
  if (headers.length < 2 || bodyRows.length < 3) return null;
  const labels = bodyRows.map((tr) => shortCategoryLabel(tr.querySelector("td")?.textContent || ""));
  const series = [];
  for (let col = 1; col < headers.length; col += 1) {
    const points = [];
    let ok = true;
    for (let r = 0; r < bodyRows.length; r += 1) {
      const cells = bodyRows[r].querySelectorAll("td");
      const parsed = parseMetricCell(cells[col]);
      if (!parsed) {
        ok = false;
        break;
      }
      points.push({ label: labels[r], ...parsed });
    }
    if (!ok) continue;
    const vals = points.map((p) => p.value);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    if (!(max > min)) continue;
    const title = headers[col].replace(/\s*[（(].*$/, "").trim() || headers[col];
    series.push({ title, unit: points[0].unit, points, max });
  }
  return series.length ? series : null;
}

function renderTableCharts(root) {
  const tables = [...root.querySelectorAll("table")];
  for (const table of tables) {
    if (table.dataset.chartRendered === "1") continue;
    table.dataset.chartRendered = "1";
    const seriesList = extractTableSeries(table);
    if (!seriesList) continue;
    const box = el("div", "table-chart");
    const head = el("div", "table-chart-head");
    const caption = el("div", "table-chart-caption");
    head.append(caption);
    const stage = el("div", "table-chart-stage");
    const selectSeries = (idx) => {
      const s = seriesList[idx] || seriesList[0];
      let peak = s.points[0];
      for (const p of s.points) if (p.value > peak.value) peak = p;
      caption.textContent = `${s.title} peaked at ${peak.display} in ${peak.label}`;
      stage.innerHTML = buildTableChartSvg(s, ++chartSeq);
    };
    if (seriesList.length > 1) {
      const tabs = el("div", "table-chart-tabs");
      seriesList.forEach((s, idx) => {
        const btn = el("button", `table-chart-tab${idx === 0 ? " active" : ""}`, s.title);
        btn.type = "button";
        btn.addEventListener("click", () => {
          [...tabs.children].forEach((c, i) => c.classList.toggle("active", i === idx));
          selectSeries(idx);
        });
        tabs.append(btn);
      });
      head.append(tabs);
    }
    selectSeries(0);
    attachZoomButton(box, () => stage.querySelector("svg"));
    box.append(head, stage);
    table.after(box);
  }
}

function formatAxisTick(val, unit) {
  if (val === 0) return `0${unit.trim()}`;
  const num = val >= 100 ? Math.round(val).toLocaleString("en-US") : Number(val.toPrecision(3));
  return `${num}${unit}`;
}

function buildTableChartSvg(series, seq) {
  const W = 580;
  const H = 195;
  const padL = 56;
  const padR = 54;
  const padT = 26;
  const padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const topVal = (series.max || 1) * 1.1;
  const pts = series.points.map((p, i) => {
    const x = padL + (series.points.length === 1 ? plotW / 2 : (i / (series.points.length - 1)) * plotW);
    const y = padT + plotH - (p.value / topVal) * plotH;
    return { x, y, ...p };
  });
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const cx = ((p0.x + p1.x) / 2).toFixed(1);
    d += ` C ${cx} ${p0.y.toFixed(1)}, ${cx} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  const areaD = `${d} L ${pts[pts.length - 1].x.toFixed(1)} ${(padT + plotH).toFixed(1)} L ${pts[0].x.toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;
  let peakIdx = 0;
  for (let i = 1; i < pts.length; i += 1) if (pts[i].value > pts[peakIdx].value) peakIdx = i;
  const grids = [];
  for (let g = 0; g <= 4; g += 1) {
    const ratio = g / 4;
    const y = (padT + plotH - ratio * plotH).toFixed(1);
    const label = formatAxisTick(topVal * ratio, series.unit);
    grids.push(`<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="currentColor" stroke-opacity="0.12" stroke-width="1"/>`);
    grids.push(`<text x="${padL - 8}" y="${(Number(y) + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="currentColor" fill-opacity="0.55">${label}</text>`);
  }
  const xLabels = pts.map((p) => `<text x="${p.x.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10.5" fill="currentColor" fill-opacity="0.65">${p.label}</text>`).join("");
  const dots = pts.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#0d9488"/>`).join("");
  const peak = pts[peakIdx];
  const peakCallout = `<line x1="${peak.x.toFixed(1)}" y1="${(peak.y - 4).toFixed(1)}" x2="${peak.x.toFixed(1)}" y2="${(peak.y - 12).toFixed(1)}" stroke="currentColor" stroke-opacity="0.45" stroke-width="1"/><text x="${peak.x.toFixed(1)}" y="${(peak.y - 15).toFixed(1)}" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">peak ${peak.display}</text>`;
  const last = pts[pts.length - 1];
  const endLabel = peakIdx === pts.length - 1 ? "" : `<text x="${(last.x + 7).toFixed(1)}" y="${(last.y + 3.5).toFixed(1)}" text-anchor="start" font-size="10.5" font-weight="700" fill="#0d9488">${last.display}</text>`;
  const gradId = `tcGrad_${seq}`;
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#0d9488" stop-opacity="0.24"/><stop offset="100%" stop-color="#0d9488" stop-opacity="0.01"/></linearGradient></defs>${grids.join("")}<path d="${areaD}" fill="url(#${gradId})"/><path d="${d}" fill="none" stroke="#0d9488" stroke-width="2" stroke-linecap="round"/>${dots}${peakCallout}${endLabel}${xLabels}</svg>`;
}

function applyDiagramTransform() {
  if (diagramView.canvas) {
    diagramView.canvas.style.transform = `translate(${diagramView.x}px, ${diagramView.y}px) scale(${diagramView.scale})`;
  }
  if (diagramZoomReset) {
    diagramZoomReset.textContent = `${Math.round(diagramView.scale * 100)}%`;
  }
}

function resetDiagramZoom() {
  diagramView.scale = 1;
  diagramView.x = 0;
  diagramView.y = 0;
  applyDiagramTransform();
}

function zoomDiagramAt(nextScale, clientX, clientY) {
  if (!diagramStage) return;
  const clamped = Math.min(8, Math.max(0.25, nextScale));
  const prev = diagramView.scale;
  if (Math.abs(clamped - prev) < 0.001) return;
  const rect = diagramStage.getBoundingClientRect();
  const cx = Number.isFinite(clientX) ? clientX - (rect.left + rect.width / 2) : 0;
  const cy = Number.isFinite(clientY) ? clientY - (rect.top + rect.height / 2) : 0;
  diagramView.x = cx - ((cx - diagramView.x) / prev) * clamped;
  diagramView.y = cy - ((cy - diagramView.y) / prev) * clamped;
  diagramView.scale = clamped;
  applyDiagramTransform();
}

function zoomDiagramBy(factor) {
  zoomDiagramAt(diagramView.scale * factor);
}

function bindDiagramStage() {
  if (!diagramStage || !diagramEl) return;
  diagramStage.addEventListener("wheel", (event) => {
    if (diagramEl.hidden) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0025));
    zoomDiagramAt(diagramView.scale * factor, event.clientX, event.clientY);
  }, { passive: false });
  diagramStage.addEventListener("dblclick", (event) => {
    event.preventDefault();
    if (Math.abs(diagramView.scale - 1) > 0.05 || Math.hypot(diagramView.x, diagramView.y) > 4) {
      resetDiagramZoom();
    } else {
      zoomDiagramAt(2, event.clientX, event.clientY);
    }
  });
  diagramStage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    diagramView.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: diagramView.x,
      originY: diagramView.y,
    };
    diagramStage.classList.add("dragging");
    diagramStage.setPointerCapture(event.pointerId);
  });
  diagramStage.addEventListener("pointermove", (event) => {
    const drag = diagramView.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    diagramView.x = drag.originX + (event.clientX - drag.startX);
    diagramView.y = drag.originY + (event.clientY - drag.startY);
    applyDiagramTransform();
  });
  const endDrag = (event) => {
    if (!diagramView.drag || event.pointerId !== diagramView.drag.pointerId) return;
    diagramView.drag = null;
    diagramStage.classList.remove("dragging");
  };
  diagramStage.addEventListener("pointerup", endDrag);
  diagramStage.addEventListener("pointercancel", endDrag);
  document.addEventListener("keydown", (event) => {
    if (diagramEl.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeDiagram();
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomDiagramBy(1.25);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomDiagramBy(1 / 1.25);
    } else if (event.key === "0") {
      event.preventDefault();
      resetDiagramZoom();
    }
  });
}

function openDiagram(svg) {
  if (!svg || !diagramEl || !diagramStage) return;
  const copy = svg.cloneNode(true);
  copy.removeAttribute("width");
  copy.removeAttribute("height");
  copy.style.width = "100%";
  copy.style.height = "100%";
  copy.style.maxWidth = "100%";
  copy.style.maxHeight = "100%";
  const canvas = el("div", "diagram-canvas");
  canvas.append(copy);
  diagramView.canvas = canvas;
  diagramStage.replaceChildren(canvas);
  resetDiagramZoom();
  diagramEl.hidden = false;
}

function closeDiagram() {
  if (!diagramEl || !diagramStage) return;
  diagramEl.hidden = true;
  diagramView.canvas = null;
  diagramView.drag = null;
  diagramStage.classList.remove("dragging");
  diagramStage.replaceChildren();
}

function applyMascotPosition() {
  if (!mascotDock || mascotDock.hidden) return;
  if (!Number.isFinite(state.mascot.x) || !Number.isFinite(state.mascot.bottom)) {
    mascotDock.style.left = "";
    mascotDock.style.top = "";
    mascotDock.style.right = "22px";
    mascotDock.style.bottom = "92px";
    return;
  }
  const width = mascotDock.offsetWidth || 160;
  const height = mascotDock.offsetHeight || 140;
  const maxX = Math.max(8, window.innerWidth - width - 8);
  const maxBottom = Math.max(8, window.innerHeight - height - 8);
  const clampedX = Math.min(Math.max(8, state.mascot.x), maxX);
  const clampedBottom = Math.min(Math.max(8, state.mascot.bottom), maxBottom);
  mascotDock.style.right = "auto";
  mascotDock.style.top = "auto";
  mascotDock.style.left = `${clampedX}px`;
  mascotDock.style.bottom = `${clampedBottom}px`;
}

function saveMascotPrefs(patch) {
  vscode.postMessage({
    type: "saveMascotPrefs",
    prefs: {
      mode: state.mascot.mode,
      minimized: state.mascot.minimized,
      x: state.mascot.x,
      bottom: state.mascot.bottom,
      ...patch,
    },
  });
}

function openMascotMenu(clientX, clientY) {
  if (!mascotMenu) return;
  mascotMenu.replaceChildren();
  const modes = [
    { id: "auto", label: "Show: Auto (follow session)" },
    { id: "both", label: "Show: Both (OMP & Claude)" },
    { id: "claude", label: "Show: Claude-tan only" },
    { id: "omp", label: "Show: OMP-tan only" },
  ];
  for (const item of modes) {
    const btn = el("button", `mascot-menu-item${state.mascot.mode === item.id ? " active" : ""}`, item.label);
    btn.type = "button";
    btn.addEventListener("click", () => {
      state.mascot.mode = item.id;
      state.mascot.minimized = false;
      saveMascotPrefs({ mode: item.id, minimized: false });
      closeMascotMenu();
      renderMascots();
    });
    mascotMenu.append(btn);
  }
  mascotMenu.append(el("div", "mascot-menu-sep"));
  const pickClaude = el("button", "mascot-menu-item", "Custom Claude image…");
  pickClaude.type = "button";
  pickClaude.addEventListener("click", () => {
    closeMascotMenu();
    vscode.postMessage({ type: "pickMascotImage", target: "claude" });
  });
  const pickOmp = el("button", "mascot-menu-item", "Custom OMP image…");
  pickOmp.type = "button";
  pickOmp.addEventListener("click", () => {
    closeMascotMenu();
    vscode.postMessage({ type: "pickMascotImage", target: "omp" });
  });
  mascotMenu.append(pickClaude, pickOmp);
  if (state.mascot.hasCustom) {
    const resetBtn = el("button", "mascot-menu-item", "Reset default images");
    resetBtn.type = "button";
    resetBtn.addEventListener("click", () => {
      closeMascotMenu();
      vscode.postMessage({ type: "resetMascotImages" });
    });
    mascotMenu.append(resetBtn);
  }
  mascotMenu.append(el("div", "mascot-menu-sep"));
  const minLabel = state.mascot.minimized ? "Expand mascot" : "Minimize to pill";
  const minBtn = el("button", "mascot-menu-item", minLabel);
  minBtn.type = "button";
  minBtn.addEventListener("click", () => {
    state.mascot.minimized = !state.mascot.minimized;
    saveMascotPrefs({ minimized: state.mascot.minimized });
    closeMascotMenu();
    renderMascots();
  });
  mascotMenu.append(minBtn);
  mascotMenu.hidden = false;
  const width = mascotMenu.offsetWidth || 190;
  const height = mascotMenu.offsetHeight || 180;
  const left = Math.min(Math.max(8, clientX - width + 24), Math.max(8, window.innerWidth - width - 8));
  const top = Math.min(Math.max(8, clientY - height - 6), Math.max(8, window.innerHeight - height - 8));
  mascotMenu.style.left = `${left}px`;
  mascotMenu.style.top = `${top}px`;
}

function closeMascotMenu() {
  if (mascotMenu) mascotMenu.hidden = true;
}

function bindMascotWidget() {
  if (!mascotDock) return;
  let drag = null;
  mascotDock.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openMascotMenu(event.clientX, event.clientY);
  });
  mascotDock.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest(".mascot-gear")) return;
    closeMascotMenu();
    const rect = mascotDock.getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: rect.left,
      originBottom: window.innerHeight - rect.bottom,
      moved: false,
    };
    mascotDock.dataset.dragged = "0";
    mascotDock.setPointerCapture(event.pointerId);
  });
  mascotDock.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    mascotDock.dataset.dragged = "1";
    mascotDock.classList.add("dragging");
    state.mascot.x = Math.round(drag.originLeft + dx);
    state.mascot.bottom = Math.round(drag.originBottom - dy);
    applyMascotPosition();
  });
  const finishDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const moved = drag.moved;
    drag = null;
    mascotDock.classList.remove("dragging");
    if (moved) {
      saveMascotPrefs({ x: state.mascot.x, bottom: state.mascot.bottom });
      setTimeout(() => {
        mascotDock.dataset.dragged = "0";
      }, 0);
    }
  };
  mascotDock.addEventListener("pointerup", finishDrag);
  mascotDock.addEventListener("pointercancel", finishDrag);
  window.addEventListener("resize", () => applyMascotPosition());
  document.addEventListener("mousedown", (event) => {
    if (mascotMenu && !mascotMenu.hidden && !mascotMenu.contains(event.target) && !event.target.closest(".mascot-gear")) {
      closeMascotMenu();
    }
  });
}
