const vscode = acquireVsCodeApi();
const fileEl = document.getElementById("file");
const sessionEl = document.getElementById("session");
const sendEl = document.getElementById("send");
const diffEl = document.getElementById("diff");
const noticeEl = document.getElementById("notice");
const docEl = document.getElementById("doc");
const commentsEl = document.getElementById("comments");
const versionRow = document.getElementById("version-row");
const versionEl = document.getElementById("version");
const popover = document.getElementById("popover");
const pendingQuote = document.getElementById("pending-quote");
const menu = document.getElementById("menu");
const bodyEl = document.getElementById("body");

let pending = null;
let reviewVersionId = "";
let renderedFile = "";
let renderedHtml = "";

bindInputSelectAll();

window.addEventListener("message", (event) => {
  const state = event.data;
  if (!state) return;
  if (state.type === "selectAll") {
    selectFocusedField();
    return;
  }
  if (state.type !== "state") return;
  fileEl.textContent = state.fileName;
  sessionEl.textContent = state.sessionLabel;
  noticeEl.textContent = state.notice;
  sendEl.disabled = !state.canSend;
  diffEl.disabled = !state.canDiff;
  reviewVersionId = state.versionId || "";
  const previousScroll = docEl.scrollTop;
  const sameFile = state.fileName === renderedFile;
  const sameHtml = sameFile && state.html === renderedHtml;
  const keepDraft = !popover.hidden && pending;
  const draft = keepDraft ? bodyEl.value : "";
  const kept = keepDraft ? pending : null;
  if (!keepDraft) {
    hideMenu();
    hidePopover();
  }
  if (sameHtml) {
    clearHighlights(docEl);
  } else {
    renderedFile = state.fileName || "";
    renderedHtml = state.html || "";
    docEl.innerHTML = state.html;
  }
  const placed = highlight(docEl, state.comments);
  if (!sameHtml) renderDiagrams(docEl);
  renderComments(state.comments, placed);
  renderVersions(state);
  if (kept) {
    pending = kept;
    pending.range = null;
    pendingQuote.textContent = pending.quote || "";
    popover.hidden = false;
    place(popover, pending.rect);
    bodyEl.value = draft;
    applyPendingMark();
  }
  if (state.focusLine > 0) {
    const block = docEl.querySelector(`[data-start="${state.focusLine - 1}"]`);
    if (block) block.scrollIntoView({ block: "center" });
  } else if (sameFile) {
    docEl.scrollTop = previousScroll;
  } else {
    docEl.scrollTop = 0;
  }
});

sendEl.addEventListener("click", () => vscode.postMessage({ type: "send" }));
diffEl.addEventListener("click", () => vscode.postMessage({ type: "diff" }));
versionEl.addEventListener("change", () => vscode.postMessage({ type: "showVersion", id: versionEl.value }));
document.getElementById("cancel").addEventListener("click", hidePopover);
document.getElementById("save").addEventListener("click", save);
document.getElementById("menu-comment").addEventListener("click", () => {
  if (!pending) return;
  const rect = pending.rect;
  hideMenu();
  openPopover(rect);
});
bodyEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) save();
  if (event.key === "Escape") hidePopover();
});
const diagramEl = document.getElementById("diagram");
const diagramStage = document.getElementById("diagram-stage");
const diagramZoomReset = document.getElementById("diagram-zoom-reset");
const diagramView = { scale: 1, x: 0, y: 0, canvas: null, drag: null };
document.getElementById("diagram-close")?.addEventListener("click", closeDiagram);
document.getElementById("diagram-zoom-in")?.addEventListener("click", () => zoomDiagramBy(1.25));
document.getElementById("diagram-zoom-out")?.addEventListener("click", () => zoomDiagramBy(1 / 1.25));
diagramZoomReset?.addEventListener("click", resetDiagramZoom);
bindDiagramStage();
document.addEventListener("keydown", (event) => {
  if (!diagramEl.hidden) {
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
    return;
  }
  if (event.key !== "Escape") return;
  hideMenu();
  hidePopover();
});
document.addEventListener("mousedown", (event) => {
  if (!menu.hidden && !menu.contains(event.target)) dismissMenu();
  if (!popover.hidden && !popover.contains(event.target)) hidePopover();
});
docEl.addEventListener("scroll", () => {
  if (!menu.hidden) dismissMenu();
});

docEl.addEventListener("contextmenu", (event) => {
  if (reviewVersionId) return;
  const captured = captureSelection();
  if (!captured) return;
  event.preventDefault();
  hidePopover(true);
  pending = captured;
  applyPendingMark();
  place(menu, captured.rect);
});

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

function captureSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const text = selection.toString().trim();
  if (text.length < 2) return null;
  const range = selection.getRangeAt(0).cloneRange();
  if (!docEl.contains(range.commonAncestorContainer)) return null;
  const startPoint = textPoint(range.startContainer, range.startOffset);
  const endPoint = textPoint(range.endContainer, range.endOffset);
  if (!startPoint || !endPoint) return null;
  const startBlock = blockOf(startPoint.node);
  const endBlock = blockOf(endPoint.node);
  if (!startBlock || !endBlock) return null;
  const blocks = blocksBetween(startBlock, endBlock);
  const from = offsetIn(blocks, startPoint.node, startPoint.offset);
  const to = offsetIn(blocks, endPoint.node, endPoint.offset);
  if (from == null || to == null || to <= from) return null;
  const startLine = Number(startBlock.dataset.start);
  const endLine = Number(endBlock.dataset.end);
  return {
    quote: text,
    anchor: sliceText(blocks, from, to),
    startLine: Number.isInteger(startLine) ? startLine : null,
    endLine: Number.isInteger(endLine) ? endLine : null,
    from,
    to,
    rect: range.getBoundingClientRect(),
    range,
  };
}

function textPoint(container, offset) {
  if (container.nodeType === Node.TEXT_NODE) {
    return anchorable(container) ? { node: container, offset } : null;
  }
  const next = container.childNodes[offset];
  const prev = container.childNodes[offset - 1];
  const after = next ? firstAnchorText(next) : null;
  if (after) return { node: after, offset: 0 };
  const before = prev ? lastAnchorText(prev) : lastAnchorText(container);
  return before ? { node: before, offset: before.nodeValue.length } : null;
}

function openPopover(rect) {
  pendingQuote.textContent = pending?.quote || "";
  bodyEl.value = "";
  place(popover, rect);
  applyPendingMark();
  bodyEl.focus();
}

function place(node, rect) {
  node.hidden = false;
  const width = node.offsetWidth || 80;
  const height = node.offsetHeight || 32;
  const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
  const top = Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - height - 8));
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
}

function hideMenu() {
  menu.hidden = true;
}

function dismissMenu() {
  hideMenu();
  if (popover.hidden) hidePopover();
}

function save() {
  if (!pending) return;
  const body = bodyEl.value.trim();
  if (!body) return;
  const { rect, range, ...comment } = pending;
  vscode.postMessage({ type: "add", ...comment, body });
  pending = null;
  hidePopover();
}

function hidePopover(keepPending) {
  const previousScroll = docEl.scrollTop;
  popover.hidden = true;
  docEl.scrollTop = previousScroll;
  if (keepPending) return;
  pending = null;
  pendingQuote.textContent = "";
  clearSelectionMark();
}

function applyPendingMark() {
  if (!pending) return;
  if (pending.range && pending.range.startContainer && pending.range.startContainer.isConnected) {
    markSelection(pending.range);
    return;
  }
  const blocks = blocksFor(docEl, pending);
  if (pending.anchor && sliceText(blocks, pending.from, pending.to) !== pending.anchor) return;
  markRanges(rangesForOffsets(blocks, pending.from, pending.to));
}

function markSelection(range) {
  markRanges(range ? [range] : []);
}

function markRanges(ranges) {
  clearSelectionMark();
  if (!ranges.length || !window.CSS || !CSS.highlights || typeof Highlight !== "function") return;
  CSS.highlights.set("pending-comment", new Highlight(...ranges));
}

function rangesForOffsets(blocks, from, to) {
  const ranges = [];
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) return ranges;
  let count = 0;
  eachAnchorText(blocks, (node) => {
    const next = count + node.nodeValue.length;
    if (next > from && count < to) {
      const range = document.createRange();
      range.setStart(node, Math.max(0, from - count));
      range.setEnd(node, Math.min(node.nodeValue.length, to - count));
      if (range.startOffset < range.endOffset) ranges.push(range);
    }
    count = next;
    return count >= to ? false : undefined;
  });
  return ranges;
}

function renderVersions(state) {
  const versions = state.versions || [];
  versionRow.hidden = versions.length === 0;
  versionEl.replaceChildren();
  const current = document.createElement("option");
  current.value = "";
  current.textContent = "This review";
  versionEl.append(current);
  for (const version of [...versions].reverse()) {
    const option = document.createElement("option");
    option.value = version.id;
    const when = version.closedAt ? new Date(version.closedAt) : null;
    const stamp = when && !Number.isNaN(when.getTime())
      ? when.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : "Earlier";
    const count = version.count === 1 ? "1 comment" : `${version.count} comments`;
    option.textContent = `${stamp} · ${count}`;
    versionEl.append(option);
  }
  versionEl.value = state.versionId || "";
}

function clearSelectionMark() {
  if (window.CSS && CSS.highlights) CSS.highlights.delete("pending-comment");
}

function renderComments(comments, placed) {
  commentsEl.replaceChildren();
  if (!comments.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Select text, then right-click and choose Comment.";
    commentsEl.append(empty);
    return;
  }
  for (const comment of comments) {
    const card = document.createElement("article");
    card.className = comment.stale ? "card stale" : "card";
    const quote = document.createElement("blockquote");
    quote.textContent = comment.excerpt || comment.quote;
    const body = document.createElement("p");
    body.textContent = comment.body;
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Delete";
    del.addEventListener("click", () => vscode.postMessage({ type: "delete", id: comment.id }));
    card.append(quote, body);
    if (!reviewVersionId) card.append(del);
    if (!comment.stale && !placed.has(comment.id)) {
      const note = document.createElement("p");
      note.className = "empty";
      note.textContent = Number.isInteger(comment.from)
        ? "The text changed, so this no longer matches the original selection."
        : "This comment has no saved position. Select the text again to highlight it.";
      card.append(note);
    }
    commentsEl.append(card);
  }
}

function highlight(root, comments) {
  const placed = new Set();
  for (const comment of comments) {
    if (comment.stale) continue;
    if (Number.isInteger(comment.from) && Number.isInteger(comment.to) && comment.anchor) {
      const blocks = blocksFor(root, comment);
      if (sliceText(blocks, comment.from, comment.to) !== comment.anchor) continue;
      paintRange(blocks, comment.from, comment.to);
      placed.add(comment.id);
      continue;
    }
    if (paintLegacy(root, comment)) placed.add(comment.id);
  }
  return placed;
}

function clearHighlights(root) {
  for (const mark of root.querySelectorAll("mark.comment-hit")) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}

function blocksFor(root, comment) {
  const all = [...root.querySelectorAll(".block")];
  if (!all.length) return [root];
  if (!Number.isInteger(comment.startLine)) return all;
  const start = comment.startLine;
  const end = Number.isInteger(comment.endLine) ? comment.endLine : start + 1;
  const ranged = all.filter((block) => {
    if (block.dataset.start == null) return false;
    const blockStart = Number(block.dataset.start);
    const blockEnd = Number(block.dataset.end || blockStart + 1);
    return blockStart < end && blockEnd > start;
  });
  return ranged.length ? ranged : all;
}

function blocksBetween(startBlock, endBlock) {
  const all = [...docEl.querySelectorAll(".block")];
  const start = all.indexOf(startBlock);
  const end = all.indexOf(endBlock);
  if (start < 0 || end < 0) return [startBlock];
  return all.slice(Math.min(start, end), Math.max(start, end) + 1);
}

function paintLegacy(root, comment) {
  const quote = String(comment.excerpt || comment.quote || "");
  const prefix = String(comment.prefix || "");
  if (prefix) {
    const spans = foldedMatches(root, prefix + quote);
    const quoteLen = quote.replace(/\s+/g, "").length;
    if (spans.length === 1 && quoteLen > 0) {
      wrapChars(spans[0].slice(-quoteLen));
      return true;
    }
  }
  const matches = foldedMatches(root, quote);
  if (matches.length !== 1) return false;
  wrapChars(matches[0]);
  return true;
}

function anchorable(node) {
  const el = node.parentElement;
  return Boolean(el && docEl.contains(node) && !el.closest("button, .ln, .mermaid, .table-chart, script, style, code.language-mermaid, code.language-svg"));
}

function firstAnchorText(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (anchorable(node)) return node;
    node = walker.nextNode();
  }
  return null;
}

function lastAnchorText(root) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (anchorable(node)) nodes.push(node);
    node = walker.nextNode();
  }
  return nodes.length ? nodes[nodes.length - 1] : null;
}

function eachAnchorText(blocks, visit) {
  for (const block of blocks) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (anchorable(node) && visit(node) === false) return;
      node = walker.nextNode();
    }
  }
}

function offsetIn(blocks, target, targetOffset) {
  let count = 0;
  let found = null;
  eachAnchorText(blocks, (node) => {
    if (node === target) {
      found = count + targetOffset;
      return false;
    }
    count += node.nodeValue.length;
    return undefined;
  });
  return found;
}

function sliceText(blocks, from, to) {
  let count = 0;
  let out = "";
  eachAnchorText(blocks, (node) => {
    const next = count + node.nodeValue.length;
    if (next > from && count < to) out += node.nodeValue.slice(Math.max(0, from - count), Math.min(node.nodeValue.length, to - count));
    count = next;
    return count >= to ? false : undefined;
  });
  return out;
}

function paintRange(blocks, from, to) {
  const jobs = [];
  let count = 0;
  eachAnchorText(blocks, (node) => {
    const next = count + node.nodeValue.length;
    if (next > from && count < to) {
      jobs.push({ node, start: Math.max(0, from - count), end: Math.min(node.nodeValue.length, to - count) });
    }
    count = next;
    return count >= to ? false : undefined;
  });
  for (const job of jobs) {
    if (job.start >= job.end) continue;
    const range = document.createRange();
    range.setStart(job.node, job.start);
    range.setEnd(job.node, job.end);
    const mark = document.createElement("mark");
    mark.className = "comment-hit";
    try {
      range.surroundContents(mark);
    } catch {
      // The range crosses an element, so this slice stays unmarked.
    }
  }
}

function foldedMatches(root, quote) {
  const needle = String(quote || "").replace(/\s+/g, "");
  const found = [];
  if (!needle) return found;
  const chars = visibleChars(root);
  const hay = chars.map((item) => item.ch).join("");
  let from = 0;
  while (from <= hay.length) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    found.push(chars.slice(at, at + needle.length));
    from = at + needle.length;
  }
  return found;
}

function visibleChars(root) {
  const chars = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (!anchorable(node)) {
      node = walker.nextNode();
      continue;
    }
    const text = node.nodeValue || "";
    for (let index = 0; index < text.length; index += 1) {
      if (/\s/.test(text[index])) continue;
      chars.push({ node, offset: index, ch: text[index] });
    }
    node = walker.nextNode();
  }
  return chars;
}

function wrapChars(chars) {
  let index = 0;
  while (index < chars.length) {
    const node = chars[index].node;
    const start = chars[index].offset;
    let end = start + 1;
    let next = index + 1;
    while (next < chars.length && chars[next].node === node) {
      end = chars[next].offset + 1;
      next += 1;
    }
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const mark = document.createElement("mark");
    mark.className = "comment-hit";
    try {
      range.surroundContents(mark);
    } catch {
      // A match that crosses an element stays unmarked for this slice.
    }
    index = next;
  }
}

let diagramToken = 0;

function attachZoomButton(host, getSvg) {
  const zoom = document.createElement("button");
  zoom.type = "button";
  zoom.className = "mermaid-zoom";
  zoom.textContent = "Full screen";
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
    const host = document.createElement("div");
    host.className = "mermaid";
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
  renderSvgBlocks(root);
  renderTableCharts(root);
  const token = ++diagramToken;
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
  blocks.forEach((code, index) => {
    const pre = code.parentElement;
    const source = code.textContent || "";
    window.mermaid.render(`mmd${token}x${index}`, source).then((result) => {
      if (token !== diagramToken || !pre.isConnected) return;
      const host = document.createElement("div");
      host.className = "mermaid";
      host.innerHTML = result.svg;
      const svg = host.querySelector("svg");
      if (svg) {
        svg.removeAttribute("height");
        svg.style.width = "100%";
        svg.style.height = "auto";
        svg.style.maxWidth = "none";
      }
      const zoom = document.createElement("button");
      zoom.type = "button";
      zoom.className = "mermaid-zoom";
      zoom.textContent = "Full screen";
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
      if (token !== diagramToken || !pre.isConnected) return;
      pre.classList.add("mermaid-error");
    });
  });
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
  if (!diagramStage) return;
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
}

function openDiagram(svg) {
  if (!svg) return;
  const copy = svg.cloneNode(true);
  copy.removeAttribute("width");
  copy.removeAttribute("height");
  copy.style.width = "100%";
  copy.style.height = "100%";
  copy.style.maxWidth = "100%";
  copy.style.maxHeight = "100%";
  const canvas = document.createElement("div");
  canvas.className = "diagram-canvas";
  canvas.appendChild(copy);
  diagramView.canvas = canvas;
  diagramStage.replaceChildren(canvas);
  resetDiagramZoom();
  diagramEl.hidden = false;
}

function closeDiagram() {
  diagramEl.hidden = true;
  diagramView.canvas = null;
  diagramView.drag = null;
  diagramStage.classList.remove("dragging");
  diagramStage.replaceChildren();
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
    const box = document.createElement("div");
    box.className = "table-chart";
    const head = document.createElement("div");
    head.className = "table-chart-head";
    const caption = document.createElement("div");
    caption.className = "table-chart-caption";
    head.appendChild(caption);
    const stage = document.createElement("div");
    stage.className = "table-chart-stage";
    const selectSeries = (idx) => {
      const s = seriesList[idx] || seriesList[0];
      let peak = s.points[0];
      for (const p of s.points) if (p.value > peak.value) peak = p;
      caption.textContent = `${s.title} peaked at ${peak.display} in ${peak.label}`;
      stage.innerHTML = buildTableChartSvg(s, ++chartSeq);
    };
    if (seriesList.length > 1) {
      const tabs = document.createElement("div");
      tabs.className = "table-chart-tabs";
      seriesList.forEach((s, idx) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `table-chart-tab${idx === 0 ? " active" : ""}`;
        btn.textContent = s.title;
        btn.addEventListener("click", () => {
          [...tabs.children].forEach((c, i) => c.classList.toggle("active", i === idx));
          selectSeries(idx);
        });
        tabs.appendChild(btn);
      });
      head.appendChild(tabs);
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

function blockOf(node) {
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return el ? el.closest(".block") : null;
}

vscode.postMessage({ type: "ready" });
