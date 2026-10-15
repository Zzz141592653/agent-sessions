const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const vscode = require("vscode");
const MarkdownIt = require("markdown-it");

const { normalizeRecord, openRound, noteLiveFile, closeRound, hashText } = require("./comments");
const { panelIsOpen, releaseClosedPanel } = require("./panel-life");
const { hasOmpProcess } = require("./sources");

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
const MAX_BYTES = 2_000_000;

let view;
let inputWebview = null;

function noteInputFocus(webview, focused) {
  if (focused) inputWebview = webview;
  else if (inputWebview === webview) inputWebview = null;
  void vscode.commands.executeCommand("setContext", "agentSessionsInputFocused", Boolean(inputWebview));
}

function selectAllInInput() {
  void inputWebview?.postMessage({ type: "selectAll" });
}

function openReviewedFile(context, location, session) {
  const file = location.file;
  const stat = fs.statSync(file);
  if (stat.size > MAX_BYTES || !isTextFile(file)) {
    return vscode.window.showTextDocument(vscode.Uri.file(file), {
      viewColumn: vscode.ViewColumn.Active,
      preview: false,
    });
  }
  if (view && !panelIsOpen(view.panel)) {
    view.watcher?.dispose();
    view = undefined;
  }
  if (!view) view = new FileView(context);
  return view.show(location, session);
}

class FileView {
  constructor(context) {
    this.context = context;
    this.panel = vscode.window.createWebviewPanel("agentSessionsFile", "File", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    const webview = this.panel.webview;
    webview.onDidReceiveMessage((message) => this.onMessage(message));
    webview.html = htmlFor(context, webview);
    this.panel.onDidDispose(() => {
      const watcher = this.watcher;
      releaseClosedPanel(
        () => {
          watcher?.dispose();
          if (view === this) view = undefined;
        },
        () => noteInputFocus(webview, false)
      );
    });
    this.record = normalizeRecord(null);
    this.viewing = "";
    this.ready = false;
    this.queue = null;
  }

  async show(location, session) {
    this.file = location.file;
    this.focusLine = location.line || 0;
    this.session = session || null;
    this.viewing = "";
    this.record = readRecord(this.context, this.file);
    const source = fs.readFileSync(this.file, "utf8");
    openRound(this.record, source);
    ensureSnapshot(this.context, this.file, this.record, source);
    if (session) {
      this.record.session = {
        key: session.key,
        source: session.source,
        sourceLabel: session.sourceLabel,
        title: session.title,
        cwd: session.cwd,
        filePath: session.filePath,
      };
    }
    await writeRecord(this.context, this.file, this.record);
    this.panel.title = path.basename(this.file);
    this.panel.reveal(vscode.ViewColumn.Active);
    this.watch();
    this.queue = { jump: true };
    if (this.ready) await this.post(true);
  }

  watch() {
    this.watcher?.dispose();
    const folder = vscode.Uri.file(path.dirname(this.file));
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, path.basename(this.file)));
    this.watcher.onDidChange(() => this.onFileChanged());
  }

  async onMessage(message) {
    if (message.type === "inputFocus") {
      if (panelIsOpen(this.panel)) noteInputFocus(this.panel.webview, message.focused === true);
      return;
    }
    if (message.type === "ready") {
      this.ready = true;
      await this.post(true);
      return;
    }
    if (!this.file) return;
    if (message.type === "add") {
      if (this.viewing) return;
      const source = fs.readFileSync(this.file, "utf8");
      const located = locateQuote(source, message.quote, { startLine: message.startLine, endLine: message.endLine });
      const body = String(message.body || "").trim();
      if (!body) return;
      if (!this.record.current.comments.length) {
        this.record.current.baseHash = hashText(source);
        this.record.current.snapshot = "";
      }
      this.record.current.comments.push({
        id: crypto.randomUUID(),
        quote: message.quote,
        excerpt: located?.excerpt || message.quote,
        prefix: located?.prefix || "",
        suffix: located?.suffix || "",
        startLine: Number.isInteger(message.startLine) ? message.startLine : null,
        endLine: Number.isInteger(message.endLine) ? message.endLine : null,
        from: Number.isInteger(message.from) ? message.from : null,
        to: Number.isInteger(message.to) ? message.to : null,
        anchor: typeof message.anchor === "string" ? message.anchor : "",
        body,
        stale: false,
      });
      ensureSnapshot(this.context, this.file, this.record, source);
      await writeRecord(this.context, this.file, this.record);
      await this.post(false);
      return;
    }
    if (message.type === "delete") {
      if (this.viewing) return;
      this.record.current.comments = this.record.current.comments.filter((item) => item.id !== message.id);
      await writeRecord(this.context, this.file, this.record);
      await this.post(false);
      return;
    }
    if (message.type === "showVersion") {
      const id = String(message.id || "");
      this.viewing = this.record.versions.some((item) => item.id === id) ? id : "";
      await this.post(false);
      return;
    }
    if (message.type === "diff") {
      const snapshotPath = this.diffSnapshot();
      if (snapshotPath && fs.existsSync(snapshotPath)) {
        await vscode.commands.executeCommand(
          "vscode.diff",
          vscode.Uri.file(snapshotPath),
          vscode.Uri.file(this.file),
          `${path.basename(this.file)}: earlier review ↔ current`
        );
      }
      return;
    }
    if (message.type === "send") await this.send();
  }

  onFileChanged() {
    if (!this.file) return;
    let source = "";
    try {
      source = fs.readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    if (noteLiveFile(this.record, source)) writeRecord(this.context, this.file, this.record);
    void this.post(false);
  }

  diffSnapshot() {
    if (this.viewing) {
      const version = this.record.versions.find((item) => item.id === this.viewing);
      return version?.snapshot || "";
    }
    const versions = this.record.versions;
    return versions.length ? versions[versions.length - 1].snapshot : "";
  }

  async send() {
    const session = this.record.session;
    const comments = this.record.current.comments;
    if (this.viewing || !session || !comments.length) return;
    const source = fs.readFileSync(this.file, "utf8");
    const tty = liveTty(session);
    if (!tty) {
      void vscode.window.showWarningMessage("That window is not open. Open it in the terminal before sending comments.");
      return;
    }
    ensureSnapshot(this.context, this.file, this.record, source);
    const prompt = comments
      .map((item) => {
        const excerpt = item.excerpt || item.quote || "";
        return `Selection:\n> ${excerpt.replace(/\n/g, "\n> ")}\n\nComment: ${item.body}`;
      })
      .join("\n\n");
    try {
      await pasteIntoTerminal(tty, prompt);
      closeRound(this.record, source);
      this.viewing = "";
      this.notice = "Pasted into the open window. Switch back to see the comments and what follows.";
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
    await writeRecord(this.context, this.file, this.record);
    await this.post(false);
  }

  async post(jump) {
    if (!this.file || !this.ready) return;
    const live = fs.readFileSync(this.file, "utf8");
    let source = live;
    let comments = this.record.current.comments;
    let versionId = "";
    let missingText = false;
    if (this.viewing) {
      const version = this.record.versions.find((item) => item.id === this.viewing);
      if (!version) this.viewing = "";
      else {
        versionId = version.id;
        comments = version.comments;
        if (version.snapshot && fs.existsSync(version.snapshot)) source = fs.readFileSync(version.snapshot, "utf8");
        else missingText = true;
      }
    }
    const session = this.record.session;
    const label = session ? `${session.sourceLabel} · ${session.title}` : "No session attached";
    const tty = session ? liveTty(session) : "";
    let notice = this.notice;
    this.notice = "";
    if (versionId) notice = "Earlier review. These comments stay with that version.";
    else if (!notice) {
      if (!session) notice = "Open this file from a session before sending comments back to that turn.";
      else if (!tty) notice = `The ${label} window is not open. Open it before sending comments there.`;
      else notice = `Comments go to the open ${label} window`;
    }
    const html = missingText
      ? `<p class="empty">The file text for this review was not kept.</p>`
      : (isMarkdown(this.file) ? renderMarkdown(source) : renderText(source));
    const snapshotPath = this.diffSnapshot();
    if (!panelIsOpen(this.panel)) return;
    await this.panel.webview.postMessage({
      type: "state",
      fileName: path.basename(this.file),
      html,
      comments,
      versions: this.record.versions.map((version) => ({
        id: version.id,
        closedAt: version.closedAt,
        count: version.comments.length,
      })),
      versionId,
      sessionLabel: label,
      canSend: Boolean(!versionId && tty && this.record.current.comments.length),
      canDiff: Boolean(snapshotPath && fs.existsSync(snapshotPath)),
      notice,
      focusLine: jump ? this.focusLine : 0,
    });
  }
}

function liveTty(session) {
  if (!session || session.source !== "omp") return "";
  const dir = path.join(os.homedir(), ".omp", "agent", "terminal-sessions");
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return "";
  }
  for (const name of names) {
    if (!name.startsWith("ttys")) continue;
    let text = "";
    try {
      text = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    if (!text.includes(session.filePath)) continue;
    try {
      const commands = execFileSync("ps", ["-t", name, "-o", "command="], { encoding: "utf8" });
      if (hasOmpProcess(commands)) return `/dev/${name}`;
    } catch {
      // This tty has no live process.
    }
  }
  return "";
}

function pasteIntoTerminal(tty, prompt) {
  const host = terminalHost(tty);
  const promptPath = path.join(os.tmpdir(), `agent-sessions-prompt-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(promptPath, prompt);
  const script = host === "iTerm2" ? itermPasteScript : terminalPasteScript;
  const appName = host === "iTerm2" ? "iTerm" : "Terminal";
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-e", script, tty, promptPath]);
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Could not paste into the terminal. Allow Cursor to control ${appName}.`));
    }, 8000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      fs.rmSync(promptPath, { force: true });
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || "Failed to paste into the terminal"));
    });
  });
}

function terminalHost(tty) {
  const name = path.basename(String(tty || ""));
  let pid = "";
  try {
    pid = execFileSync("ps", ["-t", name, "-o", "pid="], { encoding: "utf8" }).trim().split("\n")[0].trim();
  } catch {
    return "Terminal";
  }
  const seen = new Set();
  while (pid && pid !== "0" && pid !== "1" && !seen.has(pid)) {
    seen.add(pid);
    let row = "";
    try {
      row = execFileSync("ps", ["-p", pid, "-o", "ppid=,command="], { encoding: "utf8" });
    } catch {
      break;
    }
    if (/iTerm/i.test(row)) return "iTerm2";
    if (/Terminal\.app/i.test(row)) return "Terminal";
    const parent = row.trim().split(/\s+/)[0];
    if (!parent || parent === pid) break;
    pid = parent;
  }
  return "Terminal";
}

const itermPasteScript = `
on run argv
  set ttyName to item 1 of argv
  set promptText to read POSIX file (item 2 of argv) as «class utf8»
  tell application "iTerm2"
    set found to false
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          set tabTty to tty of s as text
          if tabTty is ttyName or tabTty is ("/dev/" & ttyName) or ("/dev/" & tabTty) is ttyName then
            select w
            select t
            select s
            set found to true
            exit repeat
          end if
        end repeat
        if found then exit repeat
      end repeat
      if found then exit repeat
    end repeat
    if found is false then error "Could not find the iTerm tab for this session"
    activate
  end tell
  set oldClip to the clipboard
  set the clipboard to promptText
  delay 0.35
  tell application "System Events"
    tell process "iTerm2"
      set frontmost to true
      keystroke "v" using command down
      delay 0.25
      key code 36
    end tell
  end tell
  try
    set the clipboard to oldClip
  end try
end run
`;

const terminalPasteScript = `
on run argv
  set ttyName to item 1 of argv
  set promptText to read POSIX file (item 2 of argv) as «class utf8»
  tell application "Terminal"
    set found to false
    repeat with w in windows
      set n to count of tabs of w
      repeat with i from 1 to n
        set tabTty to tty of tab i of w as text
        if tabTty is ttyName or tabTty is ("/dev/" & ttyName) or ("/dev/" & tabTty) is ttyName then
          set index of w to 1
          set selected tab of w to tab i of w
          set found to true
          exit repeat
        end if
      end repeat
      if found then exit repeat
    end repeat
    if found is false then error "Could not find the Terminal tab for this session"
    activate
  end tell
  set oldClip to the clipboard
  set the clipboard to promptText
  delay 0.35
  tell application "System Events"
    tell process "Terminal"
      set frontmost to true
      keystroke "v" using command down
      delay 0.25
      key code 36
    end tell
  end tell
  try
    set the clipboard to oldClip
  end try
end run
`;

function ensureSnapshot(context, file, record, source) {
  const current = record.current;
  if (!current.comments.length) return false;
  if (current.baseHash && current.baseHash !== hashText(source)) return false;
  if (current.snapshot && fs.existsSync(current.snapshot)) return false;
  const dir = path.join(context.globalStorageUri.fsPath, "snapshots", encodeKey(file));
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${crypto.randomUUID()}.txt`);
  fs.writeFileSync(dest, source);
  current.snapshot = dest;
  if (!current.baseHash) current.baseHash = hashText(source);
  return true;
}

function recordPath(context, file) {
  return path.join(context.globalStorageUri.fsPath, "comments", `${encodeKey(file)}.json`);
}

function readRecord(context, file) {
  try {
    return normalizeRecord(JSON.parse(fs.readFileSync(recordPath(context, file), "utf8")));
  } catch {
    return normalizeRecord(null);
  }
}

function writeRecord(context, file, record) {
  const target = recordPath(context, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(record, null, 2));
  return Promise.resolve();
}

function encodeKey(file) {
  return Buffer.from(file).toString("base64url");
}

function isTextFile(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return !buf.subarray(0, n).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

function isMarkdown(file) {
  return /\.(md|markdown|mdx)$/i.test(file);
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

function renderText(source) {
  return source.split("\n").map((line, index) => {
    const body = line.length ? escapeHtml(line) : " ";
    return `<section class="block line" data-start="${index}" data-end="${index + 1}"><span class="ln">${index + 1}</span><span class="src">${body}</span></section>`;
  }).join("");
}

function renderMarkdown(source) {
  const tokens = md.parse(formatMathInline(source), {});
  const parts = [];
  let buf = [];
  let map = null;
  const flush = () => {
    if (!buf.length) return;
    const html = md.renderer.render(buf, md.options, {}).replace(/&lt;br\s*\/?&gt;/gi, "<br>");
    if (map) parts.push(`<section class="block md-block" data-start="${map[0]}" data-end="${map[1]}">${html}</section>`);
    else if (html.trim()) parts.push(`<section class="block md-block">${html}</section>`);
    buf = [];
    map = null;
  };
  for (const token of tokens) {
    const opens = token.level === 0 && token.map && buf.length > 0 && (token.type.endsWith("_open") || token.type === "fence" || token.type === "hr");
    if (opens) flush();
    if (!map && token.map) map = [token.map[0], token.map[1]];
    buf.push(token);
  }
  flush();
  return parts.join("\n");
}

function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function locateQuote(source, quote, hint) {
  const exact = [];
  let from = 0;
  while (quote && from <= source.length) {
    const at = source.indexOf(quote, from);
    if (at < 0) break;
    exact.push(at);
    from = at + quote.length;
  }
  let start = exact[0];
  if (hint && exact.length) {
    const range = lineRange(source, hint.startLine, hint.endLine);
    start = exact.find((index) => index >= range.start && index < range.end) ?? exact[0];
  }
  if (start === undefined) return null;
  const end = start + quote.length;
  return {
    excerpt: source.slice(start, end),
    prefix: source.slice(Math.max(0, start - 40), start),
    suffix: source.slice(end, end + 40),
  };
}

function lineRange(source, startLine, endLine) {
  const lines = source.split("\n");
  let start = 0;
  for (let i = 0; i < startLine && i < lines.length; i += 1) start += lines[i].length + 1;
  let end = start;
  for (let i = startLine; i < endLine && i < lines.length; i += 1) end += lines[i].length + 1;
  return { start, end: end > start ? end : source.length };
}

function htmlFor(context, webview) {
  const css = fs.readFileSync(path.join(context.extensionPath, "media", "fileview.css"), "utf8");
  const script = fs.readFileSync(path.join(context.extensionPath, "media", "fileview.js"), "utf8");
  const nonce = crypto.randomUUID();
  const mermaidFile = path.join(context.extensionPath, "media", "mermaid.min.js");
  const mermaidSrc = fs.existsSync(mermaidFile)
    ? String(webview.asWebviewUri(vscode.Uri.file(mermaidFile))).replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    : "";
  const mermaid = mermaidSrc ? `<script nonce="${nonce}" src="${mermaidSrc}"></script>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};" />
<style>${css}</style>
</head>
<body>
<header>
  <div id="file"></div>
  <div id="session"></div>
  <button id="send" type="button">Send to this turn</button>
  <button id="diff" type="button">View changes</button>
</header>
<p id="notice"></p>
<main>
  <article id="doc"></article>
  <aside>
    <h2>Comments</h2>
    <label id="version-row" hidden>
      <span class="version-label">Review</span>
      <select id="version"></select>
    </label>
    <div id="comments"></div>
  </aside>
</main>
${mermaid}
<div id="menu" hidden>
  <button id="menu-comment" type="button">Comment</button>
</div>
<div id="popover" hidden>
  <blockquote id="pending-quote"></blockquote>
  <textarea id="body" rows="3" placeholder="Write a comment on this selection"></textarea>
  <div class="popover-actions">
    <button id="cancel" type="button">Cancel</button>
    <button id="save" type="button">Add</button>
  </div>
</div>
<div id="diagram" hidden>
  <div class="diagram-bar">
    <span class="diagram-hint">Scroll to zoom · Drag to pan · Double-click to reset</span>
    <div class="diagram-actions">
      <button id="diagram-zoom-out" type="button" title="Zoom out (-)">−</button>
      <button id="diagram-zoom-reset" type="button" title="Reset zoom (0)">100%</button>
      <button id="diagram-zoom-in" type="button" title="Zoom in (+)">+</button>
      <button id="diagram-close" type="button" title="Close (Esc)">Close</button>
    </div>
  </div>
  <div id="diagram-stage"></div>
</div>
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

module.exports = { openReviewedFile, liveTty, hasOmpProcess, pasteIntoTerminal, noteInputFocus, selectAllInInput };
