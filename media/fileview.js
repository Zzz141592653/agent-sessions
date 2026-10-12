const vscode = acquireVsCodeApi();
const fileEl = document.getElementById("file");
const sessionEl = document.getElementById("session");
const sendEl = document.getElementById("send");
const diffEl = document.getElementById("diff");
const noticeEl = document.getElementById("notice");
const docEl = document.getElementById("doc");
const commentsEl = document.getElementById("comments");
const popover = document.getElementById("popover");
const menu = document.getElementById("menu");
const bodyEl = document.getElementById("body");

let pending = null;

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
  hideMenu();
  hidePopover();
  docEl.innerHTML = state.html;
  const placed = highlight(docEl, state.comments);
  renderDiagrams(docEl);
  renderComments(state.comments, placed);
  if (state.focusLine > 0) {
    const block = docEl.querySelector(`[data-start="${state.focusLine - 1}"]`);
    if (block) block.scrollIntoView({ block: "center" });
  }
});

sendEl.addEventListener("click", () => vscode.postMessage({ type: "send" }));
diffEl.addEventListener("click", () => vscode.postMessage({ type: "diff" }));
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
document.getElementById("diagram-close").addEventListener("click", closeDiagram);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!diagramEl.hidden) {
    closeDiagram();
    return;
  }
  hideMenu();
  hidePopover();
});
document.addEventListener("mousedown", (event) => {
  if (!menu.hidden && !menu.contains(event.target)) hideMenu();
  if (!popover.hidden && !popover.contains(event.target)) hidePopover();
});
docEl.addEventListener("scroll", () => {
  if (!menu.hidden) hideMenu();
});

docEl.addEventListener("contextmenu", (event) => {
  const captured = captureSelection();
  if (!captured) return;
  event.preventDefault();
  hidePopover(true);
  pending = captured;
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
  const range = selection.getRangeAt(0);
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
  bodyEl.value = "";
  place(popover, rect);
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

function save() {
  if (!pending) return;
  const body = bodyEl.value.trim();
  if (!body) return;
  const { rect, ...comment } = pending;
  vscode.postMessage({ type: "add", ...comment, body });
  pending = null;
  hidePopover();
}

function hidePopover(keepPending) {
  popover.hidden = true;
  clearSelectionMark();
  if (!keepPending && menu.hidden) pending = null;
}

function markSelection(range) {
  clearSelectionMark();
  if (!window.CSS || !CSS.highlights || typeof Highlight !== "function") return;
  CSS.highlights.set("pending-comment", new Highlight(range));
}

function clearSelectionMark() {
  if (window.CSS && CSS.highlights) CSS.highlights.delete("pending-comment");
}

function renderComments(comments, placed) {
  commentsEl.replaceChildren();
  if (!comments.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "划选正文后右键，选择评论。";
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
    del.textContent = "删除";
    del.addEventListener("click", () => vscode.postMessage({ type: "delete", id: comment.id }));
    card.append(quote, body, del);
    if (!comment.stale && !placed.has(comment.id)) {
      const note = document.createElement("p");
      note.className = "empty";
      note.textContent = Number.isInteger(comment.from)
        ? "原文已经变了，对不上当时圈的位置。"
        : "这条没有记下位置。重新圈一次才会标在正文上。";
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
  return Boolean(el && docEl.contains(node) && !el.closest("button, .ln, .mermaid, script, style, code.language-mermaid"));
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

function renderDiagrams(root) {
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
      zoom.textContent = "全屏";
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

function openDiagram(svg) {
  if (!svg) return;
  const copy = svg.cloneNode(true);
  copy.removeAttribute("width");
  copy.removeAttribute("height");
  copy.style.width = "100%";
  copy.style.height = "100%";
  copy.style.maxWidth = "100%";
  copy.style.maxHeight = "100%";
  diagramStage.replaceChildren(copy);
  diagramEl.hidden = false;
}

function closeDiagram() {
  diagramEl.hidden = true;
  diagramStage.replaceChildren();
}

function blockOf(node) {
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return el ? el.closest(".block") : null;
}

vscode.postMessage({ type: "ready" });
