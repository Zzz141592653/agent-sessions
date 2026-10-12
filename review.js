const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const vscode = require("vscode");
const MarkdownIt = require("markdown-it");

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
  if (!view) view = new FileView(context);
  return view.show(location, session);
}

class FileView {
  constructor(context) {
    this.context = context;
    this.panel = vscode.window.createWebviewPanel("agentSessionsFile", "文件", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.webview.onDidReceiveMessage((message) => this.onMessage(message));
    this.panel.webview.html = htmlFor(context, this.panel.webview);
    this.panel.onDidDispose(() => {
      noteInputFocus(this.panel.webview, false);
      this.watcher?.dispose();
      if (view === this) view = undefined;
    });
    this.record = { comments: [] };
    this.ready = false;
    this.queue = null;
  }

  async show(location, session) {
    this.file = location.file;
    this.focusLine = location.line || 0;
    this.session = session || null;
    this.record = await readRecord(this.context, this.file);
    if (session) {
      this.record.session = {
        key: session.key,
        source: session.source,
        sourceLabel: session.sourceLabel,
        title: session.title,
        cwd: session.cwd,
        filePath: session.filePath,
      };
      await writeRecord(this.context, this.file, this.record);
    }
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
    this.watcher.onDidChange(() => this.post(false));
  }

  async onMessage(message) {
    if (message.type === "inputFocus") {
      noteInputFocus(this.panel.webview, message.focused === true);
      return;
    }
    if (message.type === "ready") {
      this.ready = true;
      await this.post(true);
      return;
    }
    if (!this.file) return;
    if (message.type === "add") {
      const source = fs.readFileSync(this.file, "utf8");
      const located = locateQuote(source, message.quote, { startLine: message.startLine, endLine: message.endLine });
      const body = String(message.body || "").trim();
      if (!body) return;
      this.record.comments.push({
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
      await writeRecord(this.context, this.file, this.record);
      await this.post(false);
      return;
    }
    if (message.type === "delete") {
      this.record.comments = this.record.comments.filter((item) => item.id !== message.id);
      await writeRecord(this.context, this.file, this.record);
      await this.post(false);
      return;
    }
    if (message.type === "diff") {
      if (this.record.snapshot) {
        await vscode.commands.executeCommand(
          "vscode.diff",
          vscode.Uri.file(this.record.snapshot),
          vscode.Uri.file(this.file),
          `${path.basename(this.file)}：改前 ↔ 当前`
        );
      }
      return;
    }
    if (message.type === "send") await this.send();
  }

  async send() {
    const session = this.record.session;
    const open = this.record.comments.filter((item) => !item.stale);
    if (!session || !open.length) return;
    const prompt = open
      .map((item) => `这段：\n> ${item.excerpt.replace(/\n/g, "\n> ")}\n\n意见：${item.body}`)
      .join("\n\n");
    const tty = liveTty(session);
    if (!tty) {
      void vscode.window.showWarningMessage("这一轮的窗口没开着。先在终端里打开它，意见才会出现在那个窗口里。");
      return;
    }
    this.record.snapshot = snapshot(this.context, this.file);
    await writeRecord(this.context, this.file, this.record);
    try {
      await pasteIntoTerminal(tty, prompt);
      this.notice = "已贴进当前窗口。回到那个窗口就能看到意见和后续输出。";
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
    await this.post(false);
  }

  async post(jump) {
    if (!this.file || !this.ready) return;
    const source = fs.readFileSync(this.file, "utf8");
    for (const comment of this.record.comments) {
      comment.stale = !quoteStillThere(source, comment.excerpt || comment.quote, this.file);
    }
    const session = this.record.session;
    const label = session ? `${session.sourceLabel} · ${session.title}` : "没有绑定会话";
    const tty = session ? liveTty(session) : "";
    const fresh = this.record.comments.some((item) => !item.stale);
    let notice = this.notice;
    if (!notice) {
      if (!session) notice = "从会话里点开文件后，才能发回那一轮。";
      else if (!tty) notice = `${label} 的窗口没开着。先打开它，发送才会出现在那个窗口里。`;
      else if (this.record.comments.length && !fresh) notice = "这些意见对不上当前正文，所以先不能发。";
      else notice = `意见发回当前打开的 ${label}`;
    }
    await this.panel.webview.postMessage({
      type: "state",
      fileName: path.basename(this.file),
      html: isMarkdown(this.file) ? renderMarkdown(source) : renderText(source),
      comments: this.record.comments,
      sessionLabel: label,
      canSend: Boolean(tty && fresh),
      canDiff: Boolean(this.record.snapshot),
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
      if (/(^|\s)omp(\s|$)/.test(commands)) return `/dev/${name}`;
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
      reject(new Error(`没能贴进终端。请允许 Cursor 控制 ${appName}。`));
    }, 8000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      fs.rmSync(promptPath, { force: true });
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || "贴进终端失败"));
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
    if found is false then error "找不到这个会话所在的 iTerm 标签"
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
    if found is false then error "找不到这个会话所在的终端标签"
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

function snapshot(context, file) {
  const dir = path.join(context.globalStorageUri.fsPath, "snapshots");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${encodeKey(file)}.md`);
  fs.copyFileSync(file, dest);
  return dest;
}

function recordPath(context, file) {
  return path.join(context.globalStorageUri.fsPath, "comments", `${encodeKey(file)}.json`);
}

function readRecord(context, file) {
  try {
    return JSON.parse(fs.readFileSync(recordPath(context, file), "utf8"));
  } catch {
    return { comments: [] };
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

function renderText(source) {
  return source.split("\n").map((line, index) => {
    const body = line.length ? escapeHtml(line) : " ";
    return `<section class="block" data-start="${index}" data-end="${index + 1}"><span class="ln">${index + 1}</span><span class="src">${body}</span></section>`;
  }).join("");
}

function renderMarkdown(source) {
  const tokens = md.parse(source, {});
  const parts = [];
  let buf = [];
  let map = null;
  const flush = () => {
    if (!buf.length) return;
    const html = md.renderer.render(buf, md.options, {});
    if (map) parts.push(`<section class="block" data-start="${map[0]}" data-end="${map[1]}">${html}</section>`);
    else if (html.trim()) parts.push(`<section class="block">${html}</section>`);
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

function quoteStillThere(source, quote, file) {
  const text = String(quote || "");
  if (!text) return false;
  if (source.includes(text)) return true;
  const visible = isMarkdown(file) ? markdownPlain(source) : source;
  if (visible.includes(text)) return true;
  const folded = text.replace(/\s+/g, "");
  return Boolean(folded) && visible.replace(/\s+/g, "").includes(folded);
}

function markdownPlain(source) {
  const html = md.render(source);
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/(p|li|h[1-6]|div|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
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
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};" />
<style>${css}</style>
</head>
<body>
<header>
  <div id="file"></div>
  <div id="session"></div>
  <button id="send" type="button">发给这轮</button>
  <button id="diff" type="button">查看修改</button>
</header>
<p id="notice"></p>
<main>
  <article id="doc"></article>
  <aside>
    <h2>意见</h2>
    <div id="comments"></div>
  </aside>
</main>
${mermaid}
<div id="menu" hidden>
  <button id="menu-comment" type="button">评论</button>
</div>
<div id="popover" hidden>
  <textarea id="body" rows="3" placeholder="写下对这段的意见"></textarea>
  <div class="popover-actions">
    <button id="cancel" type="button">取消</button>
    <button id="save" type="button">添加</button>
  </div>
</div>
<div id="diagram" hidden>
  <button id="diagram-close" type="button">关闭</button>
  <div id="diagram-stage"></div>
</div>
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

module.exports = { openReviewedFile, liveTty, pasteIntoTerminal, noteInputFocus, selectAllInInput };
